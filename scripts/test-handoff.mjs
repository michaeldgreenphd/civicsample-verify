import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const scratch = mkdtempSync(join(tmpdir(), 'verify-handoff-'));
const suites = [
  ['v2', 'pglite_rls', 'rls_tests.mjs'],
  ['v3', 'pglite_rls_v3', 'rls_tests_v3.mjs'],
  ['v4', 'pglite_rls_v4', 'rls_tests_v4.mjs'],
];

function copy(source, destination) {
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(source, destination);
}

function run(label, directory, script, inputs, expectedCount) {
  const resultPath = join(scratch, `${label}-results.json`);
  const stepsPath = join(scratch, `${label}-steps.sql`);
  execFileSync(process.execPath, [script, ...inputs, resultPath, stepsPath], { cwd: directory, stdio: 'pipe' });
  const output = JSON.parse(readFileSync(resultPath, 'utf8'));
  const failures = output.results.filter(row => !row.pass);
  if (output.summary.n !== expectedCount || output.summary.fail !== 0 || output.summary.pass !== expectedCount || failures.length) {
    throw new Error(`${label}: expected ${expectedCount} passing steps; failed step IDs: ${failures.map(row => row.id).join(', ') || 'incomplete count'}`);
  }
  console.log(`${label}: ${output.summary.pass}/${output.summary.n} supplied steps passed`);
}

try {
  for (const file of ['schema.sql', 'migrations/0002_v3_review_design.sql', 'migrations/0003_v4_record_categories_module_b.sql', 'supabase_test_shim/auth_shim.sql']) {
    copy(join(root, file), join(scratch, file));
  }
  for (const [version, directory, script] of suites) copy(join(root, 'tests/handoff', `${version}.mjs`), join(scratch, 'tests_prebuild', directory, script));
  const v4dir = join(scratch, 'tests_prebuild/pglite_rls_v4');
  copy(join(root, 'tests/handoff/audit-probe.mjs'), join(v4dir, 'probe.mjs'));
  symlinkSync(join(root, 'node_modules'), join(scratch, 'node_modules'), 'dir');
  const base = ['../../supabase_test_shim/auth_shim.sql', '../../schema.sql'];
  const m2 = '../../migrations/0002_v3_review_design.sql';
  const m3 = '../../migrations/0003_v4_record_categories_module_b.sql';
  run('v2', join(scratch, 'tests_prebuild/pglite_rls'), 'rls_tests.mjs', base, 164);
  run('v3', join(scratch, 'tests_prebuild/pglite_rls_v3'), 'rls_tests_v3.mjs', [...base, m2], 262);
  writeFileSync(join(v4dir, 'combined.sql'), readFileSync(join(root, 'migrations/0002_v3_review_design.sql'), 'utf8') + readFileSync(join(root, 'migrations/0003_v4_record_categories_module_b.sql'), 'utf8'));
  copy(join(root, 'tests/handoff/v3.mjs'), join(v4dir, 'regression.mjs'));
  run('v3-on-v4', v4dir, 'regression.mjs', [...base, 'combined.sql'], 262);
  run('v4', v4dir, 'rls_tests_v4.mjs', [...base, m2, m3], 356);
  execFileSync(process.execPath, ['probe.mjs'], { cwd: v4dir, stdio: 'pipe' });
  const probe = JSON.parse(readFileSync(join(v4dir, 'audit-probe.json'), 'utf8'));
  if (probe.v3_schema_0002.n !== 2 || probe.v3_schema_0002.with_decision !== 2 || probe.v4_schema_0002_0003.n !== 2 || probe.v4_schema_0002_0003.with_decision !== 0) {
    throw new Error('Audit probe did not reproduce the historical exposure and migration fix');
  }
  console.log('Audit probe: v3 exposed 2/2 synthetic decisions; v4 exposed 0/2.');
  console.log('SYNTHETIC ENGINEERING ONLY. PGlite is not a live PostgreSQL or Supabase deployment test.');
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
