/** Prepares a private, verified input for an atomic intake. Never contacts a service. */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import {
  checkAlternative,
  privateDirectory,
  readPrivatePackage,
  verifyProfilePreparation,
} from './mu81-disposable-import';
import { MU81_REVIEWER_PROFILES } from '../src/lib/mu81-reviewer-profile';
import { formalIntakeSchema, type FormalIntake } from '../src/lib/formal-intake';
import { newDatabase, one, P } from '../tests/mu7-fixture';

const sha = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
export async function buildFormalIntake(
  files: Map<string, Buffer>,
  alternative: 'ALLOW' | 'ONE_PER_TRIAL',
  commit: string,
) {
  const profile = verifyProfilePreparation(files, alternative);
  if (!profile) throw new Error('A verified guide binding is required.');
  const revision = MU81_REVIEWER_PROFILES[profile.profile_id].revision;
  const bytes = files.get(
    `MU7_IMPORT_UNITS_v8_1_${alternative}_PROFILE_R${revision}_PROPOSED_PRIVATE.json`,
  )!;
  const source = JSON.parse(bytes.toString('utf8'));
  let expected: FormalIntake['expected'] | undefined;
  await checkAlternative(files, alternative, async (db) => {
    const packetHash = await one(
      db,
      'owner',
      `select private.sha256_hex(string_agg(unit_id||'|'||packet_sha256,E'\\n' order by unit_id collate "C")) from public.mu7_units`,
    );
    const binding =
      alternative === 'ONE_PER_TRIAL'
        ? await one(db, 'owner', 'select binding_sha256 from public.mu7_probability_binding_v81')
        : null;
    expected = {
      ...source.manifest_hashes,
      packet_inventory_sha256: packetHash,
      probability_binding_sha256: binding,
    };
  });
  const plan = formalIntakeSchema.parse({
    format: 'civicsample-formal-intake-1.0',
    prepared_by_build: commit,
    source_import_sha256: sha(bytes),
    design: {
      design_version: source.design_version,
      assignment_set_id: source.assignment_set_id,
      overlap_setting: alternative,
      n_primary_planned: 96,
      n_subgroup_planned: 4,
    },
    reviewer_profile: { profile_id: profile.profile_id, rubric_sha256: profile.rubric_sha256 },
    units: source.units,
    queue: source.queue.map(
      (q: { reviewer_slot: string; queue_position: string; unit_id: string }) => ({
        reviewer_slot: q.reviewer_slot,
        queue_position: q.queue_position,
        unit_id: q.unit_id,
      }),
    ),
    expected,
    probability_binding:
      alternative === 'ONE_PER_TRIAL'
        ? JSON.parse(
            files
              .get('PROBABILITY_BINDING_PAYLOAD_v8_1_ONE_PER_TRIAL_PRIVATE.json')!
              .toString('utf8'),
          )
        : null,
  });
  // Execute the exact new intake RPC in a second disposable database, not the application DB.
  const db = await newDatabase();
  try {
    await db.query('insert into auth.users(id,email) values($1,$2)', [P.inv.sub, P.inv.email]);
    await db.query(
      "insert into public.users(email,display_name,role) values($1,'Offline test investigator','INVESTIGATOR')",
      [P.inv.email],
    );
    await one(db, 'inv', 'select public.rpc_claim_account()');
    await one(db, 'inv', 'select public.rpc_mu81_stage_sample($1::jsonb,$2)', [
      JSON.stringify(plan),
      'Disposable intake rehearsal only; no authorization of operational data import.',
    ]);
    const n = await one(
      db,
      'owner',
      `select ((select count(*) from public.mu7_gate_approvals) +
      (select count(*) from public.mu7_queue) + (select count(*) from public.mu7_freeze) +
      (select count(*) from public.mu7_phase_events) + (select count(*) from public.mu7_judgments))::int`,
    );
    if (n !== 0) throw new Error('Intake must not open or approve review.');
  } finally {
    await db.close();
  }
  return plan;
}
export async function prepareFormalIntake(
  source: string,
  output: string,
  alternative: 'ALLOW' | 'ONE_PER_TRIAL',
) {
  if (execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim())
    throw new Error('Clean reviewed build required.');
  if (!isAbsolute(output)) throw new Error('Private absolute destination required.');
  privateDirectory(dirname(output));
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const plan = await buildFormalIntake(readPrivatePackage(source), alternative, commit);
  mkdirSync(output, { mode: 0o700 });
  const text = JSON.stringify(plan, null, 2) + '\n';
  writeFileSync(join(output, 'formal-intake.json'), text, { flag: 'wx', mode: 0o600 });
  writeFileSync(
    join(output, 'intake.env'),
    `VERIFY_FORMAL_INTAKE_FILE=${join(output, 'formal-intake.json')}\nVERIFY_FORMAL_INTAKE_SHA256=${sha(text)}\n`,
    { flag: 'wx', mode: 0o600 },
  );
  writeFileSync(join(output, 'SHA256SUMS.txt'), `${sha(text)}  formal-intake.json\n`, {
    flag: 'wx',
    mode: 0o600,
  });
  return {
    status: 'PASS',
    mappings: 100,
    planned_queue_positions: 200,
    remote_requests: 0,
    approvals: 0,
    freezes: 0,
    reviewer_assignments: 0,
  };
}
if (process.argv[1] && resolve(process.argv[1]) === resolve('scripts/prepare-formal-intake.ts')) {
  const [source, output, alternative, ...extra] = process.argv.slice(2);
  Promise.resolve()
    .then(() => {
      if (extra.length || !source || !output || !['ALLOW', 'ONE_PER_TRIAL'].includes(alternative))
        throw new Error();
      return prepareFormalIntake(source, output, alternative as 'ALLOW' | 'ONE_PER_TRIAL');
    })
    .then((r) => console.log(JSON.stringify(r)))
    .catch(() => {
      console.error(
        'Private intake preparation refused. No remote request was made; private diagnostics suppressed.',
      );
      process.exitCode = 1;
    });
}
