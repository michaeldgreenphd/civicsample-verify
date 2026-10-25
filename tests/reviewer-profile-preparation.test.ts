import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { prepareProfileFiles } from '../scripts/prepare-reviewer-profile';
import { verifyProfilePreparation } from '../scripts/mu81-disposable-import';
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const canon = (v: unknown): string =>
  JSON.stringify(
    v && typeof v === 'object'
      ? Array.isArray(v)
        ? v.map((x) => JSON.parse(canon(x)))
        : Object.fromEntries(
            Object.entries(v)
              .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
              .map(([k, x]) => [k, JSON.parse(canon(x))]),
          )
      : v,
  );
function source() {
  const units = Array.from({ length: 100 }, (_, i) => ({
    unit_id: `SYN-UNIT-${i}`,
    family: i < 98 ? 'AREA' : 'SG',
    assignment_code:
      i < 98
        ? 'IN_AREA'
        : i === 98
          ? 'K_KEEP_MALIGNANT_COMPATIBLE'
          : 'K_REMOVE_VERIFIED_NONMALIGNANT',
    packet: {
      unit: {
        display_text: i < 98 ? 'in this area' : 'Legacy assertion',
        mapping_label: 'Synthetic classification',
      },
      trial: { brief_title: 'Fictional trial' },
    },
    design: { selection_probability: '0.01' },
    assignment: { unchanged: true },
  }));
  const packets = Object.fromEntries(units.map((u) => [u.unit_id, hash(canon(u.packet))]));
  const input = {
    design_version: 'review-design-v8.1.0',
    units,
    packet_sha256_canonical_json: packets,
    queue: [{ reviewer_slot: '1', queue_position: '1', unit_id: units[0].unit_id }],
    manifest_hashes: { unit_list_sha256: 'a'.repeat(64) },
  };
  const raw = JSON.stringify(input);
  return new Map([
    ['MU7_IMPORT_UNITS_v8_1_ONE_PER_TRIAL_PROPOSED_PRIVATE.json', Buffer.from(raw)],
    [
      'INVARIANTS_v8_1_PRIVATE.json',
      Buffer.from(
        JSON.stringify({
          alternatives: {
            ONE_PER_TRIAL: {
              corrected_sha256: hash(raw),
              invariants_before: { packet_sha256_canonical_json: packets },
            },
          },
        }),
      ),
    ],
    [
      'UNIT_PROBABILITIES_v8_ONE_PER_TRIAL_PROPOSED_PRIVATE.csv',
      Buffer.from('unchanged synthetic source bytes\n'),
    ],
  ]);
}
test('profile preparation changes exactly two packet statements and keeps all other source data', () => {
  const files = source();
  files.set(
    'CANDIDATE_MANIFEST_ONE_PER_TRIAL_PRIVATE.json',
    Buffer.from(
      JSON.stringify({
        import_sha256: hash(
          files.get('MU7_IMPORT_UNITS_v8_1_ONE_PER_TRIAL_PROPOSED_PRIVATE.json')!.toString(),
        ),
        unit_list_sha256: 'a'.repeat(64),
      }),
    ),
  );
  const before = new Map([...files].map(([k, v]) => [k, Buffer.from(v)]));
  const next = prepareProfileFiles(files, 'ONE_PER_TRIAL');
  assert.ok(verifyProfilePreparation(next, 'ONE_PER_TRIAL'));
  assert.deepEqual(files, before);
  const original = JSON.parse(
    files.get('MU7_IMPORT_UNITS_v8_1_ONE_PER_TRIAL_PROPOSED_PRIVATE.json')!.toString(),
  );
  const prepared = JSON.parse(
    next.get('MU7_IMPORT_UNITS_v8_1_ONE_PER_TRIAL_PROFILE_R4_PROPOSED_PRIVATE.json')!.toString(),
  );
  assert.deepEqual(prepared.units.slice(0, 98), original.units.slice(0, 98));
  for (let i = 98; i < 100; i++) {
    assert.notEqual(
      prepared.units[i].packet.unit.display_text,
      original.units[i].packet.unit.display_text,
    );
    prepared.units[i].packet.unit.display_text = original.units[i].packet.unit.display_text;
  }
  prepared.packet_sha256_canonical_json = original.packet_sha256_canonical_json;
  assert.deepEqual(prepared, original);
  assert.deepEqual(
    next.get('UNIT_PROBABILITIES_v8_ONE_PER_TRIAL_PROPOSED_PRIVATE.csv'),
    files.get('UNIT_PROBABILITIES_v8_ONE_PER_TRIAL_PROPOSED_PRIVATE.csv'),
  );
  assert.equal(next.has('MU7_IMPORT_UNITS_v8_1_ONE_PER_TRIAL_PROPOSED_PRIVATE.json'), false);
  const manifest = JSON.parse(
    next.get('CANDIDATE_MANIFEST_ONE_PER_TRIAL_PROFILE_R4_PRIVATE.json')!.toString(),
  );
  assert.equal(
    manifest.import_sha256,
    hash(
      next.get('MU7_IMPORT_UNITS_v8_1_ONE_PER_TRIAL_PROFILE_R4_PROPOSED_PRIVATE.json')!.toString(),
    ),
  );
  assert.equal(manifest.unit_list_sha256, 'a'.repeat(64));
  assert.equal(next.has('CANDIDATE_MANIFEST_ONE_PER_TRIAL_PRIVATE.json'), false);
});
test('independent preparation verifier refuses a third edited packet even when revised inventories are rehashed', () => {
  const files = prepareProfileFiles(source(), 'ONE_PER_TRIAL');
  const name = 'MU7_IMPORT_UNITS_v8_1_ONE_PER_TRIAL_PROFILE_R4_PROPOSED_PRIVATE.json';
  const changed = JSON.parse(files.get(name)!.toString());
  changed.units[0].packet.trial.brief_title = 'Changed fictional evidence';
  const bytes = Buffer.from(JSON.stringify(changed));
  files.set(name, bytes);
  assert.throws(() => verifyProfilePreparation(files, 'ONE_PER_TRIAL'));
  const ledger = JSON.parse(files.get('REVIEWER_PROFILE_PREPARATION_PRIVATE.json')!.toString());
  ledger.prepared_import_sha256 = hash(bytes.toString());
  files.set('REVIEWER_PROFILE_PREPARATION_PRIVATE.json', Buffer.from(JSON.stringify(ledger)));
  assert.throws(() => verifyProfilePreparation(files, 'ONE_PER_TRIAL'));
});
test('profile preparation refuses a damaged source or already prepared package', () => {
  const files = source();
  files.set('MU7_IMPORT_UNITS_v8_1_ONE_PER_TRIAL_PROPOSED_PRIVATE.json', Buffer.from('{}'));
  assert.throws(() => prepareProfileFiles(files, 'ONE_PER_TRIAL'));
  const again = source();
  again.set('REVIEWER_PROFILE_PREPARATION_PRIVATE.json', Buffer.from('{}'));
  assert.throws(() => prepareProfileFiles(again, 'ONE_PER_TRIAL'));
});
