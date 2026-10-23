// Opt-in: the supplied v7 mutation harness (tests/handoff/v7-mutation.mjs) on THIS repository's
// own migration chain. It removes each MU7 guard block and drops each named constraint in turn
// and expects that guard's own tests to fail (84 mutations; each runs the whole suite, so this
// takes several minutes). Results go to a NEW folder; nothing is overwritten.
//   node scripts/test-handoff-v7-mutation.mjs [out_dir] [--parallel N]
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const pi = argv.indexOf('--parallel');
const parallel = pi >= 0 ? argv[pi + 1] : '4';
const positional = argv.filter((_, i) => i !== pi && i !== pi + 1);
const outDir = resolve(positional[0] ?? `test-results/v7-mutation-${new Date().toISOString().replace(/[:.]/g, '')}`);
const scratch = mkdtempSync(join(tmpdir(), 'verify-v7-mutation-'));
const chain = {
  appThrough0011: [
    'migrations/0004_synthetic_verify_workflow.sql',
    'migrations/0005_review_integrity_fixes.sql',
    'migrations/0006_reference_integrity.sql',
    'migrations/0007_frozen_contract_guards.sql',
    'migrations/0008_trial_packet_and_concurrency_guards.sql',
    'migrations/0009_canonical_packet_and_lock_state_guards.sql',
    'migrations/0010_investigator_judgment_boundary.sql',
    'migrations/0011_v5_trial_label_verification.sql',
  ],
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
};
const concat = (destination, files) =>
  writeFileSync(destination, files.map((f) => readFileSync(join(root, f), 'utf8')).join(''));
try {
  // The harness spawns the suite from its own folder, so both scripts sit together and every
  // input is an absolute path.
  copyFileSync(join(root, 'tests/handoff/v7.mjs'), join(scratch, 'rls_tests_v7.mjs'));
  copyFileSync(join(root, 'tests/handoff/v7-mutation.mjs'), join(scratch, 'mutation_harness_v7.mjs'));
  mkdirSync(join(scratch, 'node_modules'), { recursive: true });
  rmSync(join(scratch, 'node_modules'), { recursive: true, force: true });
  execFileSync('ln', ['-s', join(root, 'node_modules'), join(scratch, 'node_modules')]);
  concat(join(scratch, 'chain_app_0004_to_0011.sql'), chain.appThrough0011);
  concat(join(scratch, 'chain_app_0013_to_0023.sql'), chain.tail);
  const abs = (p) => join(root, p);
  const args = [
    outDir,
    abs('supabase_test_shim/auth_shim.sql'),
    abs('schema.sql'),
    abs('migrations/0002_v3_review_design.sql'),
    abs('migrations/0003_v4_record_categories_module_b.sql'),
    join(scratch, 'chain_app_0004_to_0011.sql'),
    abs('migrations/0012_v5_training_examples.sql'),
    join(scratch, 'chain_app_0013_to_0023.sql'),
    abs('migrations/0024_v7_mapping_units.sql'),
    abs('tests/handoff/fixtures/v7/SYNTHETIC_PILOT_UNITS_v7.json'),
    abs('tests/handoff/fixtures/v7/VOCABULARY_CONTRACT_v7.json'),
    '--parallel',
    parallel,
  ];
  execFileSync(process.execPath, ['mutation_harness_v7.mjs', ...args], { cwd: scratch, stdio: 'inherit' });
  const summary = JSON.parse(readFileSync(join(outDir, 'mutation_results_v7.json'), 'utf8')).summary;
  console.log(`v7 mutation harness on the app chain: ${JSON.stringify(summary)} (results in ${outDir})`);
  if (summary.killed !== summary.total || summary.survived || summary.untested)
    throw new Error('a guard or constraint survived its mutation or is untested');
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
