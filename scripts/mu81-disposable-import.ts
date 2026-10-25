/** Offline engineering harness only: fresh in-memory databases, never the app database. */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import { newDatabase, one, P } from '../tests/mu7-fixture';

const digest = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
const hex = z.string().regex(/^[a-f0-9]{64}$/);
const alternatives = ['ALLOW', 'ONE_PER_TRIAL'] as const;
const unitSchema = z
  .object({
    unit_id: z.string(),
    mode: z.literal('FORMAL'),
    record_category: z.literal('MAPPING_UNIT_FORMAL'),
    unit_role: z.enum(['PRIMARY', 'SUBGROUP']),
    packet: z.record(z.string(), z.unknown()),
  })
  .passthrough();
const inputSchema = z.object({
  design_version: z.literal('review-design-v8.1.0'),
  alternative: z.enum(alternatives),
  assignment_set_id: z.string(),
  manifest_hashes: z.object({
    unit_list_sha256: hex,
    assignment_set_sha256: hex,
    design_rows_sha256: hex,
    queue_sha256: hex,
  }),
  units: z.array(unitSchema).length(100),
  queue: z
    .array(z.object({ reviewer_slot: z.string(), queue_position: z.string(), unit_id: z.string() }))
    .length(200),
});
const invariantSchema = z.object({
  alternatives: z.record(
    z.string(),
    z.object({
      corrected_sha256: hex,
      invariants_before: z.object({ packet_sha256_canonical_json: z.record(z.string(), hex) }),
      binding: z.object({ binding_sha256: hex }).nullable(),
    }),
  ),
});
function requireCheck(ok: unknown) {
  if (!ok) throw new Error('verification refused');
}
function privateDirectory(input: string) {
  requireCheck(isAbsolute(input));
  const actual = realpathSync(input);
  // Check both lexical and resolved ancestors: refuse symlinks into or out of a repository.
  for (const start of [resolve(input), actual]) {
    for (let p = start; ; p = dirname(p)) {
      requireCheck(!existsSync(join(p, '.git')));
      if (dirname(p) === p) break;
    }
  }
  return actual;
}
/** Read each checksummed file once. No embedded source path is followed. */
export function readPrivatePackage(directory: string): Map<string, Buffer> {
  const root = privateDirectory(directory);
  const manifest = join(root, 'SHA256SUMS_PRIVATE.txt');
  requireCheck(dirname(realpathSync(manifest)) === root);
  const files = new Map<string, Buffer>();
  for (const line of readFileSync(manifest, 'utf8').trim().split(/\r?\n/)) {
    const m = /^([a-f0-9]{64}) [ *]([A-Za-z0-9_.-]+)$/.exec(line);
    requireCheck(m && !['.', '..'].includes(m[2]) && !files.has(m[2]));
    const [, expected, name] = m!;
    const path = join(root, name);
    requireCheck(dirname(realpathSync(path)) === root);
    const bytes = readFileSync(path);
    requireCheck(digest(bytes) === expected);
    files.set(name, bytes);
  }
  return files;
}
// Python's sorted, compact UTF-8 JSON encoding used by the handoff packet inventory.
function canonical(value: unknown): string {
  const sorted = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(sorted)
      : v && typeof v === 'object'
        ? Object.fromEntries(
            Object.entries(v)
              .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
              .map(([k, x]) => [k, sorted(x)]),
          )
        : v;
  return JSON.stringify(sorted(value));
}
export async function checkAlternative(
  files: Map<string, Buffer>,
  alternative: (typeof alternatives)[number],
) {
  const raw = files.get(`MU7_IMPORT_UNITS_v8_1_${alternative}_PROPOSED_PRIVATE.json`);
  requireCheck(raw);
  const input = inputSchema.parse(JSON.parse(raw!.toString('utf8')));
  const invariants = invariantSchema.parse(
    JSON.parse(files.get('INVARIANTS_v8_1_PRIVATE.json')!.toString('utf8')),
  );
  const before = invariants.alternatives[alternative];
  requireCheck(
    before && digest(raw!) === before.corrected_sha256 && input.alternative === alternative,
  );
  requireCheck(input.units.filter((u) => u.unit_role === 'PRIMARY').length === 96);
  requireCheck(input.units.filter((u) => u.unit_role === 'SUBGROUP').length === 4);
  const ids = new Set(input.units.map((u) => u.unit_id));
  requireCheck(
    ids.size === 100 &&
      Object.keys(before.invariants_before.packet_sha256_canonical_json).length === 100,
  );
  for (const u of input.units)
    requireCheck(
      digest(canonical(u.packet)) ===
        before.invariants_before.packet_sha256_canonical_json[u.unit_id],
    );
  for (const slot of ['1', '2']) {
    const queue = input.queue
      .filter((q) => q.reviewer_slot === slot)
      .sort((a, b) => Number(a.queue_position) - Number(b.queue_position));
    requireCheck(queue.length === 100 && new Set(queue.map((q) => q.unit_id)).size === 100);
    queue.forEach((q, i) => requireCheck(q.queue_position === String(i + 1) && ids.has(q.unit_id)));
  }
  const sortedQueue = [...input.queue].sort(
    (a, b) =>
      Number(a.reviewer_slot) - Number(b.reviewer_slot) ||
      Number(a.queue_position) - Number(b.queue_position),
  );
  requireCheck(
    digest(
      sortedQueue.map((q) => `${q.reviewer_slot}|${q.queue_position}|${q.unit_id}`).join('\n'),
    ) === input.manifest_hashes.queue_sha256,
  );
  const db = await newDatabase();
  try {
    await db.query('insert into auth.users(id,email) values($1,$2)', [P.inv.sub, P.inv.email]);
    await db.query(
      "insert into public.users(email,display_name,role) values($1,'Offline test investigator','INVESTIGATOR')",
      [P.inv.email],
    );
    await one(db, 'inv', 'select public.rpc_claim_account()');
    await one(db, 'inv', 'select public.rpc_mu7_record_design($1::jsonb)', [
      JSON.stringify({
        design_version: input.design_version,
        assignment_set_id: input.assignment_set_id,
        overlap_setting: alternative,
        n_primary_planned: 96,
        n_subgroup_planned: 4,
        attestation: 'Disposable offline compatibility check; no sample selection or approval.',
      }),
    ]);
    for (const u of input.units)
      await one(db, 'inv', 'select public.rpc_mu7_import_unit($1::jsonb)', [JSON.stringify(u)]);
    const hashes = (
      await db.query<{ units: string; assignments: string; designs: string }>(`select
      (select private.sha256_hex(string_agg(unit_id,E'\\n' order by unit_id collate "C")) from public.mu7_units) as units,
      (select private.sha256_hex(string_agg(row_sha256,E'\\n' order by unit_id collate "C")) from public.mu7_frozen_assignments) as assignments,
      (select private.sha256_hex(string_agg(design_row_sha256,E'\\n' order by unit_id collate "C")) from public.mu7_unit_design) as designs`)
    ).rows[0];
    requireCheck(
      hashes.units === input.manifest_hashes.unit_list_sha256 &&
        hashes.assignments === input.manifest_hashes.assignment_set_sha256 &&
        hashes.designs === input.manifest_hashes.design_rows_sha256,
    );
    const packetCheck = await db.query<{ ok: boolean }>(
      `select bool_and(packet_sha256=private.sha256_hex(packet::text)) as ok from public.mu7_units`,
    );
    requireCheck(packetCheck.rows[0].ok);
    if (alternative === 'ONE_PER_TRIAL') {
      const payload = files.get('PROBABILITY_BINDING_PAYLOAD_v8_1_ONE_PER_TRIAL_PRIVATE.json');
      requireCheck(payload && before.binding);
      const p = JSON.parse(payload!.toString('utf8'));
      requireCheck(
        Buffer.from(p.source_csv).equals(
          files.get('UNIT_PROBABILITIES_v8_ONE_PER_TRIAL_PROPOSED_PRIVATE.csv')!,
        ),
      );
      const bound = await one(db, 'inv', 'select public.rpc_mu81_bind_probabilities($1::jsonb)', [
        JSON.stringify(p),
      ]);
      requireCheck(bound === before.binding!.binding_sha256);
    }
    const remaining = await db.query<{ n: number }>(`select (
      (select count(*) from public.mu7_freeze)+(select count(*) from public.mu7_queue)+
      (select count(*) from public.mu7_judgments)+(select count(*) from public.mu7_gate_approvals)+
      (select count(*) from public.mu7_phase_events)+(select count(*) from public.mu7_adjudications)+
      (select count(*) from public.mu7_snapshot)+(select count(*) from public.mu7_reference_locks)+
      (select count(*) from public.mu7_exports))::integer as n`);
    requireCheck(remaining.rows[0].n === 0);
    return {
      alternative,
      status: 'PASS',
      units: 100,
      queue_positions_checked_only: 200,
      original_packets_preserved: 100,
      manifest_matches: true,
      database_packet_hashes_valid: true,
      probability_binding_rows: alternative === 'ONE_PER_TRIAL' ? 100 : 0,
      approvals_freezes_assignments_judgments_exports: 0,
    };
  } finally {
    await db.close();
  }
}
export async function main(args: string[]) {
  try {
    requireCheck(args.length === 2 && args[0] === '--private-dir');
    const files = readPrivatePackage(args[1]);
    const results = [];
    for (const alternative of alternatives)
      results.push(await checkAlternative(files, alternative));
    process.stdout.write(
      JSON.stringify({
        status: 'PASS',
        environment: 'disposable_in_memory_pglite',
        real_jwt_verified: false,
        remote_requests: 0,
        sample_selected: false,
        results,
      }) + '\n',
    );
    return 0;
  } catch {
    // SQL/Zod/JSON errors may contain private IDs, packets, hashes or file paths. Never print them.
    process.stderr.write(
      'Offline import check FAILED. No remote request was made; private diagnostics suppressed.\n',
    );
    return 1;
  }
}
if (process.argv[1] && resolve(process.argv[1]) === resolve('scripts/mu81-disposable-import.ts')) {
  void main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
