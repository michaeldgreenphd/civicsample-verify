/** Deterministic private copy only: never redraws, selects a sample, contacts a service or approves a gate. */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { privateDirectory, readPrivatePackage } from './mu81-disposable-import';
import {
  MU81_REVIEWER_PROFILE_ID,
  MU81_REVIEWER_GUIDE_SHA256,
  mu81ProfileDisplayText,
} from '../src/lib/mu81-reviewer-profile';
import { reviewerGuideText } from '../src/server/mu81-reviewer-profile';

const sha = (x: string | Buffer) => createHash('sha256').update(x).digest('hex');
const json = (v: unknown) => JSON.stringify(v, null, 2) + '\n';
const canonical = (v: unknown): string =>
  JSON.stringify(
    v && typeof v === 'object'
      ? Array.isArray(v)
        ? v.map((x) => JSON.parse(canonical(x)))
        : Object.fromEntries(
            Object.entries(v)
              .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
              .map(([k, x]) => [k, JSON.parse(canonical(x))]),
          )
      : v,
  );
const check = (ok: unknown) => {
  if (!ok) throw new Error('Profile preparation refused.');
};
type Unit = {
  unit_id: string;
  family: string;
  assignment_code: string;
  packet: { unit: { display_text: string }; [key: string]: unknown };
  [key: string]: unknown;
};
type Input = {
  design_version: string;
  units: Unit[];
  packet_sha256_canonical_json?: Record<string, string>;
  [key: string]: unknown;
};

export function prepareProfileFiles(
  source: Map<string, Buffer>,
  alternative: 'ALLOW' | 'ONE_PER_TRIAL',
) {
  check(!source.has('REVIEWER_PROFILE_PREPARATION_PRIVATE.json'));
  const inputName = `MU7_IMPORT_UNITS_v8_1_${alternative}_PROPOSED_PRIVATE.json`;
  const raw = source.get(inputName);
  check(raw);
  const input: Input = JSON.parse(raw!.toString('utf8'));
  check(input.design_version === 'review-design-v8.1.0' && input.units.length === 100);
  const invariants = JSON.parse(source.get('INVARIANTS_v8_1_PRIVATE.json')!.toString('utf8'));
  check(invariants.alternatives[alternative].corrected_sha256 === sha(raw!));
  const before = structuredClone(input);
  const changes: { unit_id: string; before_sha256: string; after_sha256: string; field: string }[] =
    [];
  const packetHashes: Record<string, string> = {};
  for (const u of input.units) {
    check(
      sha(canonical(u.packet)) ===
        invariants.alternatives[alternative].invariants_before.packet_sha256_canonical_json[
          u.unit_id
        ],
    );
    const text = u.family === 'SG' ? mu81ProfileDisplayText(u.assignment_code) : undefined;
    const old = sha(canonical(u.packet));
    if (text) {
      check(text !== u.packet.unit.display_text);
      u.packet.unit.display_text = text;
      changes.push({
        unit_id: u.unit_id,
        before_sha256: old,
        after_sha256: sha(canonical(u.packet)),
        field: 'packet.unit.display_text',
      });
    }
    packetHashes[u.unit_id] = sha(canonical(u.packet));
  }
  check(changes.length === 2 && new Set(input.units.map((u) => u.unit_id)).size === 100);
  // Reversing just the two permitted text edits must reproduce the complete original payload.
  const reversed = structuredClone(input);
  for (let i = 0; i < 100; i++)
    reversed.units[i].packet.unit.display_text = before.units[i].packet.unit.display_text;
  check(canonical(reversed) === canonical(before));
  if (input.packet_sha256_canonical_json) input.packet_sha256_canonical_json = packetHashes;
  const revised = json(input);
  const nextInvariant = structuredClone(invariants);
  nextInvariant.alternatives = {
    [alternative]: {
      ...invariants.alternatives[alternative],
      corrected_sha256: sha(revised),
      note: 'Expected inventory for the profile-specific copy: two subgroup display statements changed; every other packet and all sampling records are unchanged.',
      invariants_before: {
        ...invariants.alternatives[alternative].invariants_before,
        packet_sha256_canonical_json: packetHashes,
      },
    },
  };
  const out = new Map(source);
  out.set('SOURCE_IMPORT_BEFORE_PROFILE_PRIVATE.json', Buffer.from(raw!));
  const other = alternative === 'ONE_PER_TRIAL' ? 'ALLOW' : 'ONE_PER_TRIAL';
  for (const name of out.keys())
    if (
      name.startsWith('MU7_IMPORT_UNITS_') ||
      name === 'INVARIANTS_v8_1_PRIVATE.json' ||
      name.includes(other) ||
      name.startsWith('CANDIDATE_MANIFEST_')
    )
      out.delete(name);
  const manifestName = `CANDIDATE_MANIFEST_${alternative}_PRIVATE.json`;
  if (source.has(manifestName)) {
    const manifest = JSON.parse(source.get(manifestName)!.toString('utf8'));
    check(manifest.import_sha256 === sha(raw!));
    out.set(
      `CANDIDATE_MANIFEST_${alternative}_PROFILE_R3_PRIVATE.json`,
      Buffer.from(
        json({
          ...manifest,
          import_sha256: sha(revised),
          reviewer_profile: MU81_REVIEWER_PROFILE_ID,
          reviewer_guide_sha256: MU81_REVIEWER_GUIDE_SHA256,
        }),
      ),
    );
  }
  out.set(
    `MU7_IMPORT_UNITS_v8_1_${alternative}_PROFILE_R3_PROPOSED_PRIVATE.json`,
    Buffer.from(revised),
  );
  out.set('INVARIANTS_v8_1_PROFILE_R3_PRIVATE.json', Buffer.from(json(nextInvariant)));
  out.set(
    'REVIEWER_PROFILE_PREPARATION_PRIVATE.json',
    Buffer.from(
      json({
        profile_id: MU81_REVIEWER_PROFILE_ID,
        rubric_sha256: MU81_REVIEWER_GUIDE_SHA256,
        status: 'PROPOSED; not selected, approved, imported remotely or frozen',
        alternative,
        source_import_sha256: sha(raw!),
        prepared_import_sha256: sha(revised),
        changed_packet_count: 2,
        unchanged_packet_count: 98,
        changes,
        preserved: [
          'unit list',
          'assignment set',
          'design rows',
          'queue',
          'probability file',
          'allocation rule',
          'seed',
          'frames',
        ],
      }),
    ),
  );
  out.set('REVIEWER_GUIDE_v81_r3.md', Buffer.from(reviewerGuideText()));
  out.set(
    'README_PREPARATION_PRIVATE.md',
    Buffer.from(
      `# Private review preparation — revision 3\n\nThis is a new proposed package, not a frozen or remotely imported sample. The source package is unchanged.\n\nThe investigator instructed that all ten areas use their MeSH parent headings without the additional narrowed definitions for the three added areas. Separate cancer, Depression and smoking-cessation policies remain. The guide version is ${MU81_REVIEWER_PROFILE_ID}.\n\nThe 100 selected mappings, 200 planned review positions, nominal probabilities, separate probability artifact and sampling records are unchanged. Only two neoplasm subgroup display statements changed. The other 98 packets are unchanged. Historical development and training exclusions remain; technical preparation adds no new clinical exposure exclusion.\n\nThe investigator reports being the only person exposed beyond planned practice and training. This is a reported fact, not an independent access audit or a completed rule-book overlap recount.\n\nRemaining release work includes scientific gate records, estimator approval, unresolved semantic-overlap checks, a reviewed deployment plan, and explicit authorization for real-data import and formal opening. None is approved by this preparation.\n`,
    ),
  );
  return out;
}
export function prepareProfilePackage(
  source: string,
  output: string,
  alternative: 'ALLOW' | 'ONE_PER_TRIAL',
) {
  const files = readPrivatePackage(source);
  check(isAbsolute(output) && !existsSync(output));
  privateDirectory(dirname(output));
  const prepared = prepareProfileFiles(files, alternative);
  mkdirSync(output, { mode: 0o700 });
  for (const [name, bytes] of prepared)
    writeFileSync(join(output, name), bytes, { mode: 0o600, flag: 'wx' });
  const manifest =
    [...prepared]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, bytes]) => `${sha(bytes)}  ${name}`)
      .join('\n') + '\n';
  writeFileSync(join(output, 'SHA256SUMS_PRIVATE.txt'), manifest, { mode: 0o600, flag: 'wx' });
  return {
    status: 'PASS',
    units: 100,
    changed_packets: 2,
    unchanged_packets: 98,
    redraws: 0,
    gate_approvals: 0,
    remote_requests: 0,
  };
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === resolve('scripts/prepare-reviewer-profile.ts')
) {
  try {
    const [source, output, alternative, ...extra] = process.argv.slice(2);
    check(!extra.length && ['ALLOW', 'ONE_PER_TRIAL'].includes(alternative));
    console.log(
      JSON.stringify(
        prepareProfilePackage(source, output, alternative as 'ALLOW' | 'ONE_PER_TRIAL'),
      ),
    );
  } catch {
    console.error('Private profile preparation FAILED; private details suppressed.');
    process.exitCode = 1;
  }
}
