import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const scratch = mkdtempSync(join(tmpdir(), 'verify-handoff-'));
const suites = [
  ['v2', 'pglite_rls', 'rls_tests.mjs'],
  ['v3', 'pglite_rls_v3', 'rls_tests_v3.mjs'],
  ['v4', 'pglite_rls_v4', 'rls_tests_v4.mjs'],
  ['v5', 'pglite_rls_v5', 'rls_tests_v5.mjs'],
  ['v5_1', 'pglite_rls_v5', 'rls_tests_v5_1.mjs'],
];
const migrationFiles = {
  m2: 'migrations/0002_v3_review_design.sql',
  m3: 'migrations/0003_v4_record_categories_module_b.sql',
  // This repository's own additive migrations (never run with the v3/v4 suites:
  // 0010 refuses investigator pilot adjudications by design).
  app: [
    'migrations/0004_synthetic_verify_workflow.sql',
    'migrations/0005_review_integrity_fixes.sql',
    'migrations/0006_reference_integrity.sql',
    'migrations/0007_frozen_contract_guards.sql',
    'migrations/0008_trial_packet_and_concurrency_guards.sql',
    'migrations/0009_canonical_packet_and_lock_state_guards.sql',
    'migrations/0010_investigator_judgment_boundary.sql',
  ],
  // Byte-identical copies of the supplied v5 migrations 0004 and 0005.
  m11: 'migrations/0011_v5_trial_label_verification.sql',
  m12: 'migrations/0012_v5_training_examples.sql',
  // This repository's own additive migrations after the v5 package.
  tail: [
    'migrations/0013_v5_independent_finality_guards.sql',
    'migrations/0014_legacy_pilot_and_packet_guards.sql',
    'migrations/0015_v5_review_fixes.sql',
    'migrations/0016_mapping_confirmation.sql',
    'migrations/0017_v5_rubric_binding.sql',
    'migrations/0018_mapping_confirmation_review_fixes.sql',
    'migrations/0019_v5_rubric_binding_reconciliation.sql',
    'migrations/0020_mapping_confirmation_completeness_and_serialization.sql',
    'migrations/0021_account_locks.sql',
    'migrations/0022_service_role_admin_grants.sql',
    'migrations/0023_service_role_truncate_revoke.sql',
  ],
  // Byte-identical copy of the supplied v7 migration NNNN_v7_mapping_units.sql.
  m24: 'migrations/0024_v7_mapping_units.sql',
  // This repository's fixes to 0024 (review findings).
  m25: 'migrations/0025_v7_review_fixes.sql',
  // Second round of fixes to 0024 (lifecycle and study-decision gates).
  m26: 'migrations/0026_v7_lifecycle_and_gates.sql',
  // Service-role least privilege (PR #7 review) and the v8.1 gate specifications.
  m27: 'migrations/0027_service_role_least_privilege.sql',
  m28: 'migrations/0028_v7_gate_specifications_v8_1.sql',
  m29: 'migrations/0029_v7_versioned_gate_approvals.sql',
  m30: 'migrations/0030_v7_current_unit_freeze_gates.sql',
  // Engineering messages v8.3 and v8.4: three gates hold the freeze; G-PAIN-01 version 3.
  m32: 'migrations/0032_v7_freeze_gates_v8_4.sql',
  m33: 'migrations/0033_v8_design_foundation.sql',
  m34: 'migrations/0034_v8_synthetic_identifiers.sql',
  m35: 'migrations/0035_v81_subtype_probability.sql',
  m36: 'migrations/0036_v81_judgment_history.sql',
  m37: 'migrations/0037_v81_reviewer_profile.sql',
  // Test-only: lets the supplied suite (which predates 0026) reach every supplied behaviour.
  gateShim: 'supabase_test_shim/mu7x_gates_specified_test_only.sql',
};

function copy(source, destination) {
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(source, destination);
}
function concat(destination, files) {
  writeFileSync(destination, files.map((file) => readFileSync(join(root, file), 'utf8')).join(''));
}

/**
 * Run one preserved suite and require every step to pass, except the step IDs in
 * `allowedFailures`, which the supplied test reports document as expected
 * differences (schema-version lists that see later migrations). Those steps may
 * pass or fail; every other step must pass and the total count must match.
 */
function run(label, directory, script, inputs, expectedCount, allowedFailures = []) {
  const resultPath = join(scratch, `${label}-results.json`);
  const stepsPath = join(scratch, `${label}-steps.sql`);
  execFileSync(process.execPath, [script, ...inputs, resultPath, stepsPath], {
    cwd: directory,
    stdio: 'pipe',
  });
  const output = JSON.parse(readFileSync(resultPath, 'utf8'));
  const failures = output.results.filter((row) => row.pass !== true);
  const unexpected = failures.filter((row) => !allowedFailures.includes(row.id));
  if (
    output.summary.n !== expectedCount ||
    output.results.length !== expectedCount ||
    output.summary.fail !== failures.length ||
    output.summary.pass !== expectedCount - failures.length ||
    unexpected.length
  ) {
    throw new Error(
      `${label}: expected ${expectedCount} steps with no failure outside [${allowedFailures.join(', ')}]; failed step IDs: ${failures.map((row) => row.id).join(', ') || 'incomplete count'}`,
    );
  }
  const note = failures.length
    ? ` (documented expected difference: ${failures.map((row) => row.id).join(', ')})`
    : '';
  console.log(`${label}: ${output.summary.pass}/${output.summary.n} supplied steps passed${note}`);
}

try {
  for (const file of [
    'schema.sql',
    migrationFiles.m2,
    migrationFiles.m3,
    migrationFiles.m11,
    migrationFiles.m12,
    migrationFiles.m24,
    'supabase_test_shim/auth_shim.sql',
    'tests/handoff/fixtures/v7/SYNTHETIC_PILOT_UNITS_v7.json',
    'tests/handoff/fixtures/v7/VOCABULARY_CONTRACT_v7.json',
  ]) {
    copy(join(root, file), join(scratch, file));
  }
  for (const [version, directory, script] of suites)
    copy(
      join(root, 'tests/handoff', `${version}.mjs`),
      join(scratch, 'tests_prebuild', directory, script),
    );
  const v4dir = join(scratch, 'tests_prebuild/pglite_rls_v4');
  const v5dir = join(scratch, 'tests_prebuild/pglite_rls_v5');
  copy(join(root, 'tests/handoff/audit-probe.mjs'), join(v4dir, 'probe.mjs'));
  symlinkSync(join(root, 'node_modules'), join(scratch, 'node_modules'), 'dir');
  const base = ['../../supabase_test_shim/auth_shim.sql', '../../schema.sql'];
  const m2 = `../../${migrationFiles.m2}`;
  const m3 = `../../${migrationFiles.m3}`;
  const m11 = `../../${migrationFiles.m11}`;
  const m12 = `../../${migrationFiles.m12}`;
  run('v2', join(scratch, 'tests_prebuild/pglite_rls'), 'rls_tests.mjs', base, 164);
  run('v3', join(scratch, 'tests_prebuild/pglite_rls_v3'), 'rls_tests_v3.mjs', [...base, m2], 262);
  concat(join(v4dir, 'combined.sql'), [migrationFiles.m2, migrationFiles.m3]);
  copy(join(root, 'tests/handoff/v3.mjs'), join(v4dir, 'regression.mjs'));
  run('v3-on-v4', v4dir, 'regression.mjs', [...base, 'combined.sql'], 262);
  run('v4', v4dir, 'rls_tests_v4.mjs', [...base, m2, m3], 356);
  execFileSync(process.execPath, ['probe.mjs'], { cwd: v4dir, stdio: 'pipe' });
  const probe = JSON.parse(readFileSync(join(v4dir, 'audit-probe.json'), 'utf8'));
  if (
    probe.v3_schema_0002.n !== 2 ||
    probe.v3_schema_0002.with_decision !== 2 ||
    probe.v4_schema_0002_0003.n !== 2 ||
    probe.v4_schema_0002_0003.with_decision !== 0
  ) {
    throw new Error('Audit probe did not reproduce the historical exposure and migration fix');
  }
  console.log('Audit probe: v3 exposed 2/2 synthetic decisions; v4 exposed 0/2.');

  // v5 (supplied 0004 = repo 0011) and v5.1 (supplied 0005 = repo 0012) on the
  // supplied lineage, with the unchanged v3 and v4 suites as regressions.
  concat(join(v5dir, 'combined_0002_0003_0011_0012.sql'), [
    migrationFiles.m2,
    migrationFiles.m3,
    migrationFiles.m11,
    migrationFiles.m12,
  ]);
  concat(join(v5dir, 'combined_0003_0011_0012.sql'), [
    migrationFiles.m3,
    migrationFiles.m11,
    migrationFiles.m12,
  ]);
  copy(join(root, 'tests/handoff/v3.mjs'), join(v5dir, 'regression_v3.mjs'));
  copy(join(root, 'tests/handoff/v4.mjs'), join(v5dir, 'regression_v4.mjs'));
  run('v3-on-v5', v5dir, 'regression_v3.mjs', [...base, 'combined_0002_0003_0011_0012.sql'], 262);
  run('v4-on-v5', v5dir, 'regression_v4.mjs', [...base, m2, 'combined_0003_0011_0012.sql'], 356, [
    'V4-SCHEMA-01',
  ]);
  run('v5', v5dir, 'rls_tests_v5.mjs', [...base, m2, m3, m11], 457);
  run('v5_1', v5dir, 'rls_tests_v5_1.mjs', [...base, m2, m3, m11, m12], 534);
  // Historical v5.1 snapshot through 0012 (NOT the current guarded schema).
  // Supplied revision/investigator-pilot tests retain their original semantics.
  // Current 0013 boundaries run in tests/tlv5-guards and tlv5-postgres instead.
  // Lineage: schema, 0002, 0003, repo 0004 to
  // 0010, 0011, 0012). Only the schema-version list differs.
  concat(join(v5dir, 'combined_app_0003_to_0010.sql'), [migrationFiles.m3, ...migrationFiles.app]);
  run(
    'v5_1-on-app-through-0012',
    v5dir,
    'rls_tests_v5_1.mjs',
    [...base, m2, 'combined_app_0003_to_0010.sql', m11, m12],
    534,
    ['V5-SCHEMA-01'],
  );
  // v7 (supplied NNNN = repo 0024) on THIS repository's own chain: schema, 0002, 0003, repo
  // 0004 to 0010, 0011, 0012, repo 0013 to 0023, 0024. The supplied suite takes seven base files,
  // so the chain is concatenated into that shape. The suite's reference stack (which needs the
  // supplied 0006 this repository never adopted) is run outside the repository from the package.
  // Expected difference on this chain: MU7-SCHEMA-01 lists the schema versions and sees this
  // repository's own markers (4.0.1-synthetic ... 6.0.5-service-role-truncate-revoke) between
  // 4.0.0 and 7.0.0. Every behaviour step, including the additive checks and the FINDING-V6-01
  // helper comparison (MU7-ADD-08), passes on this chain.
  const v7dir = join(scratch, 'tests_prebuild/pglite_rls_v7');
  mkdirSync(v7dir, { recursive: true });
  copy(join(root, 'tests/handoff/v7.mjs'), join(v7dir, 'rls_tests_v7.mjs'));
  concat(join(v7dir, 'chain_app_0004_to_0011.sql'), [...migrationFiles.app, migrationFiles.m11]);
  concat(join(v7dir, 'chain_app_0013_to_0023.sql'), migrationFiles.tail);
  run(
    'v7-on-app-chain',
    v7dir,
    'rls_tests_v7.mjs',
    [
      ...base,
      m2,
      m3,
      'chain_app_0004_to_0011.sql',
      m12,
      'chain_app_0013_to_0023.sql',
      `../../${migrationFiles.m24}`,
      `../../tests/handoff/fixtures/v7/SYNTHETIC_PILOT_UNITS_v7.json`,
      `../../tests/handoff/fixtures/v7/VOCABULARY_CONTRACT_v7.json`,
    ],
    362,
    ['MU7-SCHEMA-01'],
  );
  // The same suite with this repository's fix migration 0025 appended to 0024, to show the fixes
  // keep every supplied behaviour. Expected differences: MU7-SCHEMA-01 (version list) and
  // MU7-ADD-01 (0025 replaces private.is_adjudicator from 0002 with a lock-aware body, as 0021 did
  // for the other identity helpers; the additive check compares every earlier function's text).
  concat(join(v7dir, 'nnnn_0024_0025.sql'), [migrationFiles.m24, migrationFiles.m25]);
  run(
    'v7-on-app-chain-with-0025',
    v7dir,
    'rls_tests_v7.mjs',
    [
      ...base,
      m2,
      m3,
      'chain_app_0004_to_0011.sql',
      m12,
      'chain_app_0013_to_0023.sql',
      'nnnn_0024_0025.sql',
      `../../tests/handoff/fixtures/v7/SYNTHETIC_PILOT_UNITS_v7.json`,
      `../../tests/handoff/fixtures/v7/VOCABULARY_CONTRACT_v7.json`,
    ],
    362,
    ['MU7-SCHEMA-01', 'MU7-ADD-01'],
  );
  // The same suite with 0025 and 0026 appended. 0026 keeps the FORMAL freeze and the formal opening
  // disabled while the study-decision gates are pending, which the supplied suite (written before
  // 0026) cannot know; the test-only shim records a SYNTHETIC specification that blocks nothing and
  // names the suite's own synthetic evidence string, so every supplied behaviour is still checked.
  // The gates themselves are tested in tests/mu7-lifecycle.test.ts. Expected differences are those
  // of the 0025 run; no supplied behaviour step may change.
  concat(join(v7dir, 'nnnn_0024_0025_0026.sql'), [
    migrationFiles.m24,
    migrationFiles.m25,
    migrationFiles.m26,
    migrationFiles.gateShim,
  ]);
  run(
    'v7-on-app-chain-with-0025-0026',
    v7dir,
    'rls_tests_v7.mjs',
    [
      ...base,
      m2,
      m3,
      'chain_app_0004_to_0011.sql',
      m12,
      'chain_app_0013_to_0023.sql',
      'nnnn_0024_0025_0026.sql',
      `../../tests/handoff/fixtures/v7/SYNTHETIC_PILOT_UNITS_v7.json`,
      `../../tests/handoff/fixtures/v7/VOCABULARY_CONTRACT_v7.json`,
    ],
    362,
    ['MU7-SCHEMA-01', 'MU7-ADD-01'],
  );
  // The final chain: 0024 to 0034 (0031 adds no v7 object) with the test-only gate shim (the shim
  // records a synthetic version of every requirement, after the migrations' own, that blocks nothing).
  concat(join(v7dir, 'nnnn_0024_to_0037.sql'), [
    migrationFiles.m24,
    migrationFiles.m25,
    migrationFiles.m26,
    migrationFiles.m27,
    migrationFiles.m28,
    migrationFiles.m29,
    migrationFiles.m30,
    migrationFiles.m32,
    migrationFiles.m33,
    migrationFiles.m34,
    migrationFiles.m35,
    migrationFiles.m36,
    migrationFiles.m37,
    migrationFiles.gateShim,
  ]);
  run(
    'v7-on-app-chain-through-0037',
    v7dir,
    'rls_tests_v7.mjs',
    [
      ...base,
      m2,
      m3,
      'chain_app_0004_to_0011.sql',
      m12,
      'chain_app_0013_to_0023.sql',
      'nnnn_0024_to_0037.sql',
      `../../tests/handoff/fixtures/v7/SYNTHETIC_PILOT_UNITS_v7.json`,
      `../../tests/handoff/fixtures/v7/VOCABULARY_CONTRACT_v7.json`,
    ],
    362,
    ['MU7-SCHEMA-01', 'MU7-ADD-01'],
  );
  console.log(
    'SYNTHETIC ENGINEERING ONLY. PGlite is not a live PostgreSQL or Supabase deployment test.',
  );
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
