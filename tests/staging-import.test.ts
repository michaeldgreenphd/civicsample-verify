import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  ImportValidationError,
  parseCsv,
  readVerifiedPrivateCsv,
  validateDevelopment,
  validateHeldout,
  validatePredictions,
  validateModuleB,
  type CsvRow,
  type VerifiedCsv,
} from '../src/lib/staging-import';

// Fully fictional test records; never copied from a study file.
const dev = {
  dev_case_id_v4: 'DEV4-TESTFX-001',
  record_category: 'DEVELOPMENT',
  frame_unit_id_v3: 'TESTFX-DEV-A',
  unit_type: 'DESCRIPTOR_AREA',
  primary_exclusion_reason: 'E01_SYNTHETIC_EXPOSURE',
  exclusion_reasons: 'E01_SYNTHETIC_EXPOSURE',
};
const sample = {
  case_id_v4: 'HO4-TESTFX-001',
  frame_unit_id_v3: 'TESTFX-HOLDOUT-A',
  unit_type: 'DESCRIPTOR_AREA',
  unit_id: 'TESTFX-D1::neurological',
  descriptor_ui: 'TESTFX-D1',
  descriptor_name: 'Fictional condition',
  area: 'neurological',
  nct_id: '',
  record_category: 'HELDOUT_FORMAL',
  provenance_audit_result: 'NO_DEVELOPMENT_FLAG',
  tuning_use_allowed: 'FALSE',
  selection_stratum_v4: 'TESTFX-STRATUM',
  variance_stratum_v4: 'TESTFX-VARIANCE',
  variance_stratum_N_v4: '3',
  N_h: '3',
  selection_probability_v4: '0.3333333333333333',
  sampling_weight_v4: '3',
  sampling_design_version: 'TESTFX-DESIGN',
  seed_v4: '17',
  tier0_original_binary: 'INCLUDE',
  tier1_v11_status_raw: 'EXCLUDE',
  tier1_v11_binary: 'EXCLUDE',
  comparison_cell_v11: 'OPOS_CNEG',
  two_step_descriptor_then_trial: 'FALSE',
  impact_tier_v4: 'STANDARD',
  policy_governed_neoplasm_GEN06: 'FALSE',
};
function csv(rows: readonly CsvRow[]): string {
  const headers = Object.keys(rows[0]);
  const quote = (value: string) =>
    /[",\r\n]/.test(value) ? '"' + value.replaceAll('"', '""') + '"' : value;
  return (
    [headers.join(','), ...rows.map((row) => headers.map((h) => quote(row[h])).join(','))].join(
      '\n',
    ) + '\n'
  );
}
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
function file(rows: readonly CsvRow[]): VerifiedCsv {
  const content = csv(rows);
  return { sha256: hash(content), ...parseCsv(content) };
}
const development = () => validateDevelopment(file([dev]), 1);
const heldout = (rows: readonly CsvRow[] = [sample]) =>
  validateHeldout(file(rows), {
    expectedRows: rows.length,
    weightColumn: 'sampling_weight_v4',
    development: development(),
  });
function prediction(row: CsvRow = sample, level = 'DESCRIPTOR_LEVEL'): CsvRow {
  return {
    prediction_set_id: 'TESTFX-PREDICTIONS',
    case_id: row.case_id_v4,
    determination_level: level,
    tier0_binary: row.tier0_original_binary,
    tier1_version: 'v1.1',
    tier1_status_raw: 'EXCLUDE',
    tier1_binary: 'EXCLUDE',
    stage_c_trial_status: '',
    prediction_frozen_at: 'PENDING_FREEZE',
    record_category: row.record_category,
    frame_unit_id: row.frame_unit_id_v3,
    unit_type: row.unit_type,
    unit_id: row.unit_id,
    nct_id: row.nct_id,
    descriptor_ui: row.descriptor_ui,
    area: row.area,
    selection_stratum: row.selection_stratum_v4,
    variance_stratum: row.variance_stratum_v4,
    variance_stratum_size: row.variance_stratum_N_v4,
    selection_probability: row.selection_probability_v4,
    sampling_weight: row.sampling_weight_v4,
    comparison_cell: row.comparison_cell_v11,
    impact_tier: row.impact_tier_v4,
    policy_governed_neoplasm_GEN06: row.policy_governed_neoplasm_GEN06,
    provenance_audit_result: row.provenance_audit_result,
  };
}
function refuses(fn: () => unknown, code: string) {
  assert.throws(
    fn,
    (error: unknown) => error instanceof ImportValidationError && error.code === code,
  );
}

test('hash verification precedes parsing and external-only file checks resolve symlinks', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'verify-private-preflight-'));
  try {
    const repo = join(directory, 'repo');
    await mkdir(repo);
    const malformed = join(directory, 'malformed.csv');
    await writeFile(malformed, '"unfinished');
    await assert.rejects(
      readVerifiedPrivateCsv({
        file: malformed,
        expectedSha256: 'a'.repeat(64),
        repositoryRoot: repo,
      }),
      { message: 'PRIVATE_FILE_HASH_MISMATCH' },
    );
    await assert.rejects(
      readVerifiedPrivateCsv({
        file: malformed,
        expectedSha256: hash('"unfinished'),
        repositoryRoot: repo,
      }),
      { message: 'CSV_MALFORMED' },
    );
    const inside = join(repo, 'private.csv');
    await writeFile(inside, csv([dev]));
    const link = join(directory, 'outside-link.csv');
    await symlink(inside, link);
    for (const filename of [inside, link])
      await assert.rejects(
        readVerifiedPrivateCsv({
          file: filename,
          expectedSha256: hash(csv([dev])),
          repositoryRoot: repo,
        }),
        { message: 'PRIVATE_FILE_MUST_BE_OUTSIDE_REPOSITORY' },
      );
    const outside = join(directory, 'private.csv');
    await writeFile(outside, csv([dev]));
    const outgoingLink = join(repo, 'link-to-private.csv');
    await symlink(outside, outgoingLink);
    await assert.rejects(
      readVerifiedPrivateCsv({
        file: outgoingLink,
        expectedSha256: hash(csv([dev])),
        repositoryRoot: repo,
      }),
      { message: 'PRIVATE_FILE_MUST_BE_OUTSIDE_REPOSITORY' },
    );
    const result = await readVerifiedPrivateCsv({
      file: outside,
      expectedSha256: hash(csv([dev])),
      repositoryRoot: repo,
    });
    assert.equal(validateDevelopment(result, 1)[0].frame_unit_id, dev.frame_unit_id_v3);
    assert.equal(await readFile(outside, 'utf8'), csv([dev]));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('strict CSV accepts quoted data and rejects duplicate headers, short rows and invalid quoting', () => {
  const parsed = parseCsv('label,description\r\n"Synthetic, case","Line 1\nLine ""2"""\r\n');
  assert.equal(parsed.rows[0].description, 'Line 1\nLine "2"');
  for (const bad of ['a,a\n1,2\n', 'a,b\n1\n', 'a,b\n"x"z,2\n', 'a,b\nx"z,2\n', 'a,b\n1,2\r']) {
    assert.throws(() => parseCsv(bad), ImportValidationError);
  }
});

test('development validation rejects wrong categories, duplicates and incomplete provenance', () => {
  assert.equal(development().length, 1);
  refuses(() => validateDevelopment(file([dev]), 2), 'ROW_COUNT_MISMATCH');
  refuses(() => validateDevelopment(file([dev, dev]), 2), 'DUPLICATE_IDENTIFIER');
  refuses(
    () => validateDevelopment(file([{ ...dev, record_category: 'HELDOUT_FORMAL' }]), 1),
    'DEVELOPMENT_CATEGORY_INVALID',
  );
  refuses(
    () => validateDevelopment(file([{ ...dev, exclusion_reasons: '' }]), 1),
    'REQUIRED_VALUE_MISSING',
  );
});

test('held-out preflight excludes development, pilot and calibration and preserves exact sampling text', () => {
  assert.equal(heldout()[0].selection_probability_v4, sample.selection_probability_v4);
  refuses(
    () => heldout([{ ...sample, frame_unit_id_v3: dev.frame_unit_id_v3 }]),
    'DEVELOPMENT_OVERLAP',
  );
  for (const case_id_v4 of ['DEV4-TESTFX-003', 'CAL4-TESTFX-003', 'SYN-003', 'HO4R-TESTFX-003']) {
    refuses(() => heldout([{ ...sample, case_id_v4 }]), 'HELDOUT_ID_INVALID');
  }
  refuses(() => heldout([{ ...sample, tuning_use_allowed: 'TRUE' }]), 'HELDOUT_PROVENANCE_INVALID');
  refuses(
    () => heldout([{ ...sample, provenance_audit_result: 'EXPOSED' }]),
    'HELDOUT_PROVENANCE_INVALID',
  );
  refuses(() => heldout([{ ...sample, sampling_weight_v4: '2' }]), 'WEIGHT_PROBABILITY_MISMATCH');
  refuses(() => heldout([{ ...sample, selection_probability_v4: 'NaN' }]), 'INVALID_DECIMAL');
  refuses(
    () => heldout([{ ...sample, selection_probability_v4: '0' }]),
    'INVALID_PROBABILITY_OR_WEIGHT',
  );
  refuses(() => heldout([{ ...sample, seed_v4: '' }]), 'REQUIRED_VALUE_MISSING');
  refuses(() => heldout([sample, sample]), 'DUPLICATE_IDENTIFIER');
  refuses(
    () =>
      validateHeldout(file([sample]), {
        expectedRows: 1,
        weightColumn: 'sampling_weight_v4',
        development: [],
      }),
    'DEVELOPMENT_REGISTRY_REQUIRED',
  );
});

test('prediction validation supports explicit version choices and enforces case levels, provenance and mapping', () => {
  for (const version of ['v1.1', 'v1.2'] as const) {
    assert.equal(
      validatePredictions(file([{ ...prediction(), tier1_version: version }]), {
        expectedRows: 1,
        tier1Version: version,
        sample: heldout(),
        sampleWeightColumn: 'sampling_weight_v4',
      }).length,
      1,
    );
  }
  const check = (rows: readonly CsvRow[]) =>
    validatePredictions(file(rows), {
      expectedRows: rows.length,
      tier1Version: 'v1.1',
      sample: heldout(),
      sampleWeightColumn: 'sampling_weight_v4',
    });
  refuses(() => check([{ ...prediction(), tier1_version: 'v1.2' }]), 'TIER_VERSION_MISMATCH');
  refuses(
    () => check([{ ...prediction(), frame_unit_id: 'TESTFX-OTHER' }]),
    'PREDICTION_SAMPLE_PROVENANCE_MISMATCH',
  );
  refuses(
    () => check([{ ...prediction(), selection_probability: '0.3333333333666666' }]),
    'PREDICTION_SAMPLE_PROVENANCE_MISMATCH',
  );
  const serialized = { ...prediction(), selection_probability: '0.33333333333333326' };
  assert.equal(check([serialized])[0].selection_probability, serialized.selection_probability);
  // Relative tolerance must not erase a substantial change in a tiny probability.
  const tinySample = heldout([
    { ...sample, selection_probability_v4: '1e-25', sampling_weight_v4: '1e25' },
  ]);
  refuses(
    () =>
      validatePredictions(
        file([
          { ...prediction(tinySample[0]), selection_probability: '2e-25', sampling_weight: '5e24' },
        ]),
        {
          expectedRows: 1,
          tier1Version: 'v1.1',
          sample: tinySample,
          sampleWeightColumn: 'sampling_weight_v4',
        },
      ),
    'PREDICTION_SAMPLE_PROVENANCE_MISMATCH',
  );
  refuses(
    () => check([{ ...prediction(), tier1_binary: 'INCLUDE' }]),
    'PREDICTION_MAPPING_MISMATCH',
  );
  refuses(() => check([prediction(), prediction()]), 'PREDICTION_CASE_LEVEL_MISMATCH');
  refuses(
    () => check([{ ...prediction(), prediction_frozen_at: '2020-01-01T00:00:00Z' }]),
    'PREDICTIONS_ALREADY_FROZEN',
  );
  const trial = {
    ...sample,
    unit_type: 'TRIAL_AREA',
    nct_id: 'SYN-NCT-0001',
    two_step_descriptor_then_trial: 'TRUE',
  };
  const trialSample = heldout([trial]);
  const rows = [
    prediction(trial, 'DESCRIPTOR_LEVEL_IN_TRIAL_CASE'),
    { ...prediction(trial, 'TRIAL_LEVEL'), stage_c_trial_status: 'EXCLUDE' },
  ];
  assert.equal(
    validatePredictions(file(rows), {
      expectedRows: 2,
      tier1Version: 'v1.1',
      sample: trialSample,
      sampleWeightColumn: 'sampling_weight_v4',
    }).length,
    2,
  );
  refuses(
    () =>
      validatePredictions(file(rows.slice(0, 1)), {
        expectedRows: 1,
        tier1Version: 'v1.1',
        sample: trialSample,
        sampleWeightColumn: 'sampling_weight_v4',
      }),
    'PREDICTION_POPULATION_MISMATCH',
  );
});

test('Module B stays separate, checks row/trial counts and retains absent provisional statuses', () => {
  const row = {
    module_b_unit_id: 'MB4-ROW-TESTFX-01',
    record_category: 'MODULE_B_FORMAL',
    unit_type: 'CONDITION_ROW_BENCHMARK',
    row_id: 'TESTFX-ROW',
    stratum: 'TESTFX-CENSUS',
    frame_N: '1',
    selection_probability: '1',
    sampling_weight: '1',
    pipeline_compatibility_status_PROVISIONAL_never_shown: '',
    nct_id: '',
    benchmark_id_shown: '',
  };
  const options = {
    expectedRows: 1,
    expectedConditionRows: 1,
    expectedTrialRows: 0,
    weightColumn: 'sampling_weight',
  };
  assert.equal(validateModuleB(file([row]), options).length, 1);
  refuses(
    () => validateModuleB(file([{ ...row, module_b_unit_id: 'HO4-TESTFX-001' }]), options),
    'MODULE_B_IDENTIFIER_MISMATCH',
  );
  refuses(
    () =>
      validateModuleB(file([row]), { ...options, expectedConditionRows: 0, expectedTrialRows: 1 }),
    'MODULE_B_COUNTS_MISMATCH',
  );
  const trialOptions = { ...options, expectedConditionRows: 0, expectedTrialRows: 1 };
  const trial = { ...row, unit_type: 'TRIAL_ELIGIBILITY', module_b_unit_id: 'MB4-T-TESTFX-01' };
  for (const nct_id of ['SYN-NCT-0001', 'SYN-NCT0001', 'SYN-NCT-12345678'])
    assert.equal(validateModuleB(file([{ ...trial, nct_id }]), trialOptions).length, 1);
  for (const nct_id of ['SYN-NCT-TESTFX-01', 'SYN-NCT-123', 'SYN-NCT-123456789'])
    refuses(
      () => validateModuleB(file([{ ...trial, nct_id }]), trialOptions),
      'MODULE_B_IDENTIFIER_MISMATCH',
    );
});

test('trial preflight accepts exactly the database synthetic identifier forms', () => {
  const trial = { ...sample, unit_type: 'TRIAL_AREA', two_step_descriptor_then_trial: 'TRUE' };
  for (const nct_id of ['SYN-NCT-0001', 'SYN-NCT0001', 'SYN-NCT-12345678'])
    assert.equal(heldout([{ ...trial, nct_id }]).length, 1);
  for (const nct_id of ['SYN-NCT-TESTFX-01', 'SYN-NCT-123', 'SYN-NCT-123456789'])
    refuses(() => heldout([{ ...trial, nct_id }]), 'TRIAL_IDENTIFIER_MISMATCH');
});

test('v1.1 predictions must match the sampled classification while both versions validate comparison cells', () => {
  const check = (row: CsvRow, version: 'v1.1' | 'v1.2', selected = heldout()) =>
    validatePredictions(file([{ ...row, tier1_version: version }]), {
      expectedRows: 1,
      tier1Version: version,
      sample: selected,
      sampleWeightColumn: 'sampling_weight_v4',
    });
  // A coherent alternate classifier result still contradicts the verified v1.1 sample.
  const changed = {
    ...prediction(),
    tier1_status_raw: 'INCLUDE',
    tier1_binary: 'INCLUDE',
    comparison_cell: 'OPOS_CPOS',
  };
  refuses(() => check(changed, 'v1.1'), 'PREDICTION_SAMPLE_PROVENANCE_MISMATCH');
  // The same change is permitted for v1.2; its classification is not copied from v1.1.
  assert.equal(check(changed, 'v1.2').length, 1);
  refuses(
    () => check({ ...changed, comparison_cell: 'OPOS_CNEG' }, 'v1.2'),
    'PREDICTION_COMPARISON_CELL_MISMATCH',
  );
  // A different raw status can map to the same binary and must still be detected.
  refuses(
    () => check({ ...prediction(), tier1_status_raw: 'NOT_IN_DECISION_FILE' }, 'v1.1'),
    'PREDICTION_SAMPLE_PROVENANCE_MISMATCH',
  );
  refuses(
    () => check({ ...prediction(), comparison_cell: 'OPOS_CPOS' }, 'v1.1'),
    'PREDICTION_SAMPLE_PROVENANCE_MISMATCH',
  );
  // Even matching sample/prediction metadata must describe the actual binary pair.
  refuses(
    () =>
      check(
        { ...prediction(), comparison_cell: 'OPOS_CPOS' },
        'v1.1',
        heldout([{ ...sample, comparison_cell_v11: 'OPOS_CPOS' }]),
      ),
    'PREDICTION_COMPARISON_CELL_MISMATCH',
  );
  for (const tier0_binary of ['INCLUDE', 'EXCLUDE'])
    for (const tier1_binary of ['INCLUDE', 'EXCLUDE']) {
      const selected = heldout([{ ...sample, tier0_original_binary: tier0_binary }]);
      const row = {
        ...prediction(selected[0]),
        tier0_binary,
        tier1_binary,
        tier1_status_raw: tier1_binary,
        comparison_cell: `O${tier0_binary === 'INCLUDE' ? 'POS' : 'NEG'}_C${tier1_binary === 'INCLUDE' ? 'POS' : 'NEG'}`,
      };
      assert.equal(check(row, 'v1.2', selected).length, 1);
      refuses(
        () => check({ ...row, comparison_cell: 'UNKNOWN' }, 'v1.2', selected),
        'PREDICTION_COMPARISON_CELL_MISMATCH',
      );
    }
});

test('CLI performs no writes, prints no private cells, and refuses production or an import action', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'verify-cli-private-'));
  try {
    const privateFile = join(directory, 'input.csv');
    const content = csv([dev]);
    await writeFile(privateFile, content);
    const script = resolve('scripts/staging-import.ts');
    const args = [
      '--import',
      'tsx',
      script,
      '--environment',
      'staging',
      '--kind',
      'development',
      '--file',
      privateFile,
      '--sha256',
      hash(content),
      '--expected-rows',
      '1',
    ];
    const output = execFileSync(process.execPath, args, { encoding: 'utf8' });
    const result = JSON.parse(output);
    assert.equal(result.status, 'PASS');
    assert.equal(result.databaseWrites, 0);
    assert.equal(result.databaseDryRun, 'NOT_RUN');
    assert.equal(output.includes(dev.dev_case_id_v4), false);
    assert.equal(output.includes(privateFile), false);
    assert.equal(output.includes(hash(content)), false);
    assert.equal(await readFile(privateFile, 'utf8'), content);
    for (const extra of [['--apply'], ['--environment', 'production']]) {
      const attempt = spawnSync(process.execPath, [...args, ...extra], { encoding: 'utf8' });
      assert.equal(attempt.status, 1);
      assert.equal(attempt.stderr.includes(dev.dev_case_id_v4), false);
      assert.equal(JSON.parse(attempt.stderr).databaseWrites, 0);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
