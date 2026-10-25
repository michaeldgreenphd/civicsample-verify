import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { readPrivatePackage, checkAlternative } from '../scripts/mu81-disposable-import';
import { importObj, FORMAL_UNITS, syntheticNct } from './mu7-fixture';

const sha = (v: string) => createHash('sha256').update(v).digest('hex');
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
function syntheticFiles(alternative: 'ALLOW' | 'ONE_PER_TRIAL') {
  const units = Array.from({ length: 100 }, (_, i) => {
    const source = i < 96 ? FORMAL_UNITS[0] : FORMAL_UNITS.find((u) => u.fam === 'SG')!;
    const u = importObj({
      ...source,
      uid: `MU7-${source.fam}-${source.cat}-${String(i + 1).padStart(3, '0')}`,
      nct: syntheticNct(i + 1),
    });
    u.design.design_version = 'review-design-v8.1.0';
    u.design.overlap_setting = alternative;
    return u;
  }).sort((a, b) => (a.unit_id < b.unit_id ? -1 : 1));
  const queue = ['1', '2'].flatMap((reviewer_slot) =>
    units.map((u, i) => ({ reviewer_slot, queue_position: String(i + 1), unit_id: u.unit_id })),
  );
  const unitHashes = units.map((u) =>
    sha(
      [
        u.unit_id,
        u.design.nct_id,
        u.design.frame_id,
        u.design.stratum,
        u.design.frame_stratum_size,
        u.design.n_sampled_in_stratum,
        u.design.allocation_option,
        alternative,
        u.design.sampling_seed,
        u.design.prn_key,
      ].join('|'),
    ),
  );
  const raw = JSON.stringify({
    design_version: 'review-design-v8.1.0',
    alternative,
    assignment_set_id: units[0].assignment.assignment_set_id,
    units,
    queue,
    manifest_hashes: {
      unit_list_sha256: sha(units.map((u) => u.unit_id).join('\n')),
      assignment_set_sha256: sha(units.map((u) => u.assignment.row_sha256).join('\n')),
      design_rows_sha256: sha(unitHashes.join('\n')),
      queue_sha256: sha(
        queue.map((q) => `${q.reviewer_slot}|${q.queue_position}|${q.unit_id}`).join('\n'),
      ),
    },
  });
  const files = new Map<string, Buffer>();
  files.set(`MU7_IMPORT_UNITS_v8_1_${alternative}_PROPOSED_PRIVATE.json`, Buffer.from(raw));
  const probabilityRows = units.map((u) => ({
    unit_id: u.unit_id,
    pi_i: '0.01',
    mc_standard_error: '0.001',
  }));
  const body = probabilityRows
    .map((r) => `${r.unit_id},${r.pi_i},${r.mc_standard_error}\n`)
    .join('');
  const source_csv =
    'unit_id,stratum,N_h,n_h,nominal_probability_n_h_over_N_h,pi_mc_ONE_PER_TRIAL,mc_se,pattern_group_units,weight_ONE_PER_TRIAL,ratio_mc_to_nominal\n' +
    units
      .map(
        (u) =>
          [
            u.unit_id,
            u.design.stratum,
            u.design.frame_stratum_size,
            u.design.n_sampled_in_stratum,
            u.design.selection_probability,
            '0.01',
            '0.001',
            '1',
            '100',
            0.01 / u.design.selection_probability,
          ].join(',') + '\n',
      )
      .join('');
  const binding = {
    binding_version: 'mu81-probability-1',
    method: 'MONTE_CARLO_ONE_PER_TRIAL',
    replicates: 20000,
    seed: 1,
    source_csv,
    file_sha256: sha(source_csv),
    rows_sha256: sha(body),
    rows: probabilityRows,
  };
  const binding_sha256 = sha(
    [
      'mu81-probability-1',
      'review-design-v8.1.0',
      binding.method,
      binding.replicates,
      binding.seed,
      binding.file_sha256,
      binding.rows_sha256,
    ].join('|'),
  );
  files.set(
    'PROBABILITY_BINDING_PAYLOAD_v8_1_ONE_PER_TRIAL_PRIVATE.json',
    Buffer.from(JSON.stringify(binding)),
  );
  files.set('UNIT_PROBABILITIES_v8_ONE_PER_TRIAL_PROPOSED_PRIVATE.csv', Buffer.from(source_csv));
  files.set(
    'INVARIANTS_v8_1_PRIVATE.json',
    Buffer.from(
      JSON.stringify({
        alternatives: {
          [alternative]: {
            corrected_sha256: sha(raw),
            invariants_before: {
              packet_sha256_canonical_json: Object.fromEntries(
                units.map((u) => [u.unit_id, sha(canon(u.packet))]),
              ),
            },
            binding: alternative === 'ONE_PER_TRIAL' ? { binding_sha256 } : null,
          },
        },
      }),
    ),
  );
  return files;
}
for (const alternative of ['ALLOW', 'ONE_PER_TRIAL'] as const) {
  test(`offline import executes real SQL without approvals or answers: ${alternative}`, async () => {
    const result = await checkAlternative(syntheticFiles(alternative), alternative);
    assert.equal(result.status, 'PASS');
    assert.equal(result.original_packets_preserved, 100);
    assert.equal(result.approvals_freezes_assignments_judgments_exports, 0);
  });
}
test('offline input rejects changed bytes, traversal, duplicate entries and repository paths', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mu81-input-'));
  const write = (text: string) => writeFileSync(join(dir, 'SHA256SUMS_PRIVATE.txt'), text);
  try {
    writeFileSync(join(dir, 'sample.json'), '{}');
    write(`${sha('{}')}  sample.json\n`);
    assert.equal(readPrivatePackage(dir).get('sample.json')!.toString(), '{}');
    writeFileSync(join(dir, 'sample.json'), '{"changed":true}');
    assert.throws(() => readPrivatePackage(dir));
    write(`${sha('{}')}  ../sample.json\n`);
    assert.throws(() => readPrivatePackage(dir));
    writeFileSync(join(dir, 'sample.json'), '{}');
    write(`${sha('{}')}  sample.json\n${sha('{}')}  sample.json\n`);
    assert.throws(() => readPrivatePackage(dir));
    write(`${sha('{}')}  sample.json\n`);
    mkdirSync(join(dir, '.git'));
    assert.throws(() => readPrivatePackage(dir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test('offline input refuses file symlinks outside the checksum directory', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mu81-links-'));
  try {
    mkdirSync(join(dir, 'private'));
    writeFileSync(join(dir, 'outside.json'), '{}');
    symlinkSync(join(dir, 'outside.json'), join(dir, 'private', 'sample.json'));
    writeFileSync(join(dir, 'private', 'SHA256SUMS_PRIVATE.txt'), `${sha('{}')}  sample.json\n`);
    assert.throws(() => readPrivatePackage(join(dir, 'private')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test('CLI never echoes private error content or paths', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mu81-redaction-'));
  try {
    const marker = 'PRIVATE_ERROR_SENTINEL';
    writeFileSync(join(dir, 'SHA256SUMS_PRIVATE.txt'), marker);
    const run = spawnSync(
      process.execPath,
      ['--import', 'tsx', 'scripts/mu81-disposable-import.ts', '--private-dir', dir],
      { encoding: 'utf8' },
    );
    assert.equal(run.status, 1);
    assert.equal(run.stdout, '');
    assert.match(run.stderr, /Offline import check FAILED/);
    assert.ok(!run.stderr.includes(marker) && !run.stderr.includes(dir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('database refuses a changed nominal probability; the checker does not relax MU7-G20', async () => {
  const files = syntheticFiles('ALLOW');
  const name = 'MU7_IMPORT_UNITS_v8_1_ALLOW_PROPOSED_PRIVATE.json';
  const input = JSON.parse(files.get(name)!.toString());
  input.units[0].design.selection_probability = 0.123;
  const raw = JSON.stringify(input);
  files.set(name, Buffer.from(raw));
  const inv = JSON.parse(files.get('INVARIANTS_v8_1_PRIVATE.json')!.toString());
  inv.alternatives.ALLOW.corrected_sha256 = sha(raw);
  files.set('INVARIANTS_v8_1_PRIVATE.json', Buffer.from(JSON.stringify(inv)));
  await assert.rejects(checkAlternative(files, 'ALLOW'), /MU7-G20/);
});

test('CLI suppresses private packet content in a database rejection', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mu81-sql-redaction-'));
  try {
    const files = syntheticFiles('ALLOW');
    const name = 'MU7_IMPORT_UNITS_v8_1_ALLOW_PROPOSED_PRIVATE.json';
    const input = JSON.parse(files.get(name)!.toString());
    input.units[0].packet.trial.PRIVATE_SQL_SENTINEL = 'PRIVATE_REGISTRY_TEXT_SENTINEL';
    const raw = JSON.stringify(input);
    files.set(name, Buffer.from(raw));
    const inv = JSON.parse(files.get('INVARIANTS_v8_1_PRIVATE.json')!.toString());
    inv.alternatives.ALLOW.corrected_sha256 = sha(raw);
    inv.alternatives.ALLOW.invariants_before.packet_sha256_canonical_json[input.units[0].unit_id] =
      sha(canon(input.units[0].packet));
    files.set('INVARIANTS_v8_1_PRIVATE.json', Buffer.from(JSON.stringify(inv)));
    for (const [file, bytes] of files) writeFileSync(join(dir, file), bytes);
    writeFileSync(
      join(dir, 'SHA256SUMS_PRIVATE.txt'),
      [...files].map(([file, bytes]) => `${sha(bytes.toString())}  ${file}\n`).join(''),
    );
    const run = spawnSync(
      process.execPath,
      ['--import', 'tsx', 'scripts/mu81-disposable-import.ts', '--private-dir', dir],
      { encoding: 'utf8' },
    );
    assert.equal(run.status, 1);
    assert.equal(run.stdout, '');
    assert.equal(
      run.stderr,
      'Offline import check FAILED. No remote request was made; private diagnostics suppressed.\n',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
