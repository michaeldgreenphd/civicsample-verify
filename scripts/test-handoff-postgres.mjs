import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { Client } from 'pg';
import {
  adaptPreservedSuite,
  inspectSuiteResult,
  withDisposableHandoffDatabases,
} from './test-handoff-postgres-helpers.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const report = {
  synthetic_only: true,
  scope:
    'Historical supplied suites on native PostgreSQL 16 with local auth shim; not Supabase JWT/PostgREST verification',
  generated_at: new Date().toISOString(),
  git_commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  command: 'node scripts/test-handoff-postgres.mjs',
  status: 'UNTESTED',
  stage: 'configuration',
  suites: [],
};
const args = process.argv.slice(2);
const reportPath = args.length === 2 && args[0] === '--report' ? resolve(args[1]) : undefined;
if (args.length && !reportPath)
  throw new Error('Usage: node scripts/test-handoff-postgres.mjs [--report path]');
let scratch;

async function suppliedTables(connectionString) {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    return (
      await client.query(
        "select schemaname, tablename from pg_tables where schemaname not in ('pg_catalog', 'information_schema') order by schemaname, tablename",
      )
    ).rows;
  } finally {
    await client.end();
  }
}

try {
  const baseUrl = process.env.VERIFY_PG_TEST_URL;
  if (!baseUrl) {
    report.status = 'BLOCKED';
    report.reason = 'VERIFY_PG_TEST_URL is absent; no native PostgreSQL suite was executed';
    console.log(`BLOCKED: ${report.reason}.`);
    if (process.env.VERIFY_PG_REQUIRE === '1') process.exitCode = 1;
  } else {
    // Reject Supabase/ambiguous connections before making any source connection.
    const { disposableUrl } = await import('./test-handoff-postgres-helpers.mjs');
    disposableUrl(baseUrl, 'verify_handoff_0_0000000000000000');
    report.stage = 'supplied-database-read-only-baseline';
    const before = await suppliedTables(baseUrl);
    scratch = await mkdtemp(join(tmpdir(), 'verify-native-handoff-'));
    const shim = join(root, 'supabase_test_shim/auth_shim.sql');
    const schema = join(root, 'schema.sql');
    const m2 = join(root, 'migrations/0002_v3_review_design.sql');
    const m3 = join(root, 'migrations/0003_v4_record_categories_module_b.sql');
    // Byte-identical copies of the supplied v5 migrations 0004 and 0005.
    const m11 = join(root, 'migrations/0011_v5_trial_label_verification.sql');
    const m12 = join(root, 'migrations/0012_v5_training_examples.sql');
    // This application's own additive migrations; never run with the v3/v4
    // suites, because 0010 refuses investigator pilot adjudications by design.
    const app = [
      'migrations/0004_synthetic_verify_workflow.sql',
      'migrations/0005_review_integrity_fixes.sql',
      'migrations/0006_reference_integrity.sql',
      'migrations/0007_frozen_contract_guards.sql',
      'migrations/0008_trial_packet_and_concurrency_guards.sql',
      'migrations/0009_canonical_packet_and_lock_state_guards.sql',
      'migrations/0010_investigator_judgment_boundary.sql',
    ].map((file) => join(root, file));
    const concat = async (name, files) => {
      const target = join(scratch, name);
      let text = '';
      for (const file of files) text += await readFile(file, 'utf8');
      await writeFile(target, text, { mode: 0o600 });
      return target;
    };
    const combined = await concat('combined.sql', [m2, m3]);
    const combinedV5 = await concat('combined_0002_0003_0011_0012.sql', [m2, m3, m11, m12]);
    const combinedV5From3 = await concat('combined_0003_0011_0012.sql', [m3, m11, m12]);
    const combinedApp = await concat('combined_app_0003_to_0010.sql', [m3, ...app]);
    // v7 (supplied NNNN = repo 0024) on this repository's own chain, in the seven-base-file shape
    // the supplied suite takes: schema, 0002, 0003, repo 0004-0010 + 0011, 0012, repo 0013-0023.
    const tail = [
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
    ].map((file) => join(root, file));
    const m24 = join(root, 'migrations/0024_v7_mapping_units.sql');
    const m25 = join(root, 'migrations/0025_v7_review_fixes.sql');
    const m26 = join(root, 'migrations/0026_v7_lifecycle_and_gates.sql');
    // Test-only: lets the supplied suite (which predates 0026) reach every supplied behaviour.
    const gateShim = join(root, 'supabase_test_shim/mu7x_gates_specified_test_only.sql');
    const m24to25 = await concat('nnnn_0024_0025.sql', [m24, m25]);
    const m24to26 = await concat('nnnn_0024_0025_0026.sql', [m24, m25, m26, gateShim]);
    const m27 = join(root, 'migrations/0027_service_role_least_privilege.sql');
    const m28 = join(root, 'migrations/0028_v7_gate_specifications_v8_1.sql');
    const m29 = join(root, 'migrations/0029_v7_versioned_gate_approvals.sql');
    const m30 = join(root, 'migrations/0030_v7_current_unit_freeze_gates.sql');
    const m32 = join(root, 'migrations/0032_v7_freeze_gates_v8_4.sql');
    const m33 = join(root, 'migrations/0033_v8_design_foundation.sql');
    const m34 = join(root, 'migrations/0034_v8_synthetic_identifiers.sql');
    const m35 = join(root, 'migrations/0035_v81_subtype_probability.sql');
    const m36 = join(root, 'migrations/0036_v81_judgment_history.sql');
    const m37 = join(root, 'migrations/0037_v81_reviewer_profile.sql');
    const m38 = join(root, 'migrations/0038_v81_reviewer_guide_r4.sql');
    const m39 = join(root, 'migrations/0039_v81_prepared_sample_intake.sql');
    const m24to28 = await concat('nnnn_0024_to_0039.sql', [
      m24,
      m25,
      m26,
      m27,
      m28,
      m29,
      m30,
      m32,
      m33,
      m34,
      m35,
      m36,
      m37,
      m38,
      m39,
      gateShim,
    ]);
    const chainApp0004to0011 = await concat('chain_app_0004_to_0011.sql', [...app, m11]);
    const chainApp0013to0023 = await concat('chain_app_0013_to_0023.sql', tail);
    const v7Fixtures = [
      join(root, 'tests/handoff/fixtures/v7/SYNTHETIC_PILOT_UNITS_v7.json'),
      join(root, 'tests/handoff/fixtures/v7/VOCABULARY_CONTRACT_v7.json'),
    ];
    report.schema_sha256 = {};
    for (const [label, file] of [
      ['base', schema],
      ['0002', m2],
      ['0003', m3],
      ['0011', m11],
      ['0012', m12],
      ['0024', m24],
      ['0025', m25],
      ['0026', m26],
      ['0027', m27],
      ['0028', m28],
      ['0029', m29],
      ['0030', m30],
      ['0032', m32],
      ['0033', m33],
      ['0034', m34],
      ['0035', m35],
      ['0036', m36],
      ['0037', m37],
      ['0038', m38],
      ['0039', m39],
    ]) {
      report.schema_sha256[label] = createHash('sha256')
        .update(await readFile(file))
        .digest('hex');
    }
    const audits = {};
    try {
      // [name, preserved source, inputs, expected steps, databases the suite
      // opens, step IDs documented as expected differences]
      for (const [name, sourceName, inputs, expected, databases, allowed] of [
        ['v2', 'v2', [shim, schema], 164, 1, []],
        ['v3', 'v3', [shim, schema, m2], 262, 1, []],
        ['v3-on-v4', 'v3', [shim, schema, combined], 262, 1, []],
        ['v4', 'v4', [shim, schema, m2, m3], 356, 1, []],
        ['v3-on-v5', 'v3', [shim, schema, combinedV5], 262, 1, []],
        ['v4-on-v5', 'v4', [shim, schema, m2, combinedV5From3], 356, 1, ['V4-SCHEMA-01']],
        ['v5', 'v5', [shim, schema, m2, m3, m11], 457, 3, []],
        ['v5_1', 'v5_1', [shim, schema, m2, m3, m11, m12], 534, 3, []],
        [
          'v5_1-on-app-through-0012',
          'v5_1',
          [shim, schema, m2, combinedApp, m11, m12],
          534,
          3,
          ['V5-SCHEMA-01'],
        ],
        // The supplied v7 suite opens four databases (the catalogue base, db1, db2, db3).
        // MU7-SCHEMA-01 lists the schema versions and sees this repository's own markers.
        [
          'v7-on-app-chain',
          'v7',
          [shim, schema, m2, m3, chainApp0004to0011, m12, chainApp0013to0023, m24, ...v7Fixtures],
          362,
          4,
          ['MU7-SCHEMA-01'],
        ],
        // With this repository's fixes appended. MU7-ADD-01: 0025 replaces private.is_adjudicator
        // with a lock-aware body. The 0026 run adds the test-only gate specification (never hosted).
        [
          'v7-on-app-chain-with-0025',
          'v7',
          [
            shim,
            schema,
            m2,
            m3,
            chainApp0004to0011,
            m12,
            chainApp0013to0023,
            m24to25,
            ...v7Fixtures,
          ],
          362,
          4,
          ['MU7-SCHEMA-01', 'MU7-ADD-01'],
        ],
        [
          'v7-on-app-chain-with-0025-0026',
          'v7',
          [
            shim,
            schema,
            m2,
            m3,
            chainApp0004to0011,
            m12,
            chainApp0013to0023,
            m24to26,
            ...v7Fixtures,
          ],
          362,
          4,
          ['MU7-SCHEMA-01', 'MU7-ADD-01'],
        ],
        [
          'v7-on-app-chain-through-0039',
          'v7',
          [
            shim,
            schema,
            m2,
            m3,
            chainApp0004to0011,
            m12,
            chainApp0013to0023,
            m24to28,
            ...v7Fixtures,
          ],
          362,
          4,
          ['MU7-SCHEMA-01', 'MU7-ADD-01'],
        ],
      ]) {
        report.stage = name;
        const source = await readFile(join(root, `tests/handoff/${sourceName}.mjs`), 'utf8');
        const scriptPath = join(scratch, `${name}.mjs`);
        const outputPath = join(scratch, `${name}.json`);
        const auditPath = join(scratch, `${name}-audit.json`);
        await writeFile(
          scriptPath,
          adaptPreservedSuite(
            source,
            pathToFileURL(join(root, 'scripts/test-handoff-postgres-adapter.mjs')).href,
          ),
          { mode: 0o600 },
        );
        await withDisposableHandoffDatabases(baseUrl, databases, async (targets) => {
          await promisify(execFile)(
            process.execPath,
            [scriptPath, ...inputs, outputPath, join(scratch, `${name}.sql`)],
            {
              cwd: root,
              env: {
                ...process.env,
                VERIFY_HANDOFF_DISPOSABLE_URLS: JSON.stringify(targets),
                VERIFY_HANDOFF_AUDIT_OUTPUT: name === 'v3' || name === 'v3-on-v4' ? auditPath : '',
              },
              timeout: 300000,
              maxBuffer: 8 * 1024 * 1024,
            },
          );
        });
        const output = JSON.parse(await readFile(outputPath, 'utf8'));
        const result = inspectSuiteResult(output, expected, allowed);
        report.engine = output.summary.engine;
        report.suites.push({
          name,
          source_sha256: createHash('sha256').update(source).digest('hex'),
          driver_only_adaptation: true,
          ...result,
        });
        console.log(
          `${name}: ${result.pass}/${result.count} native PostgreSQL steps passed; ${result.fail} failed (${result.unexpectedFail} outside the documented differences).`,
        );
        if (result.fail) console.log(`${name} failed step IDs: ${result.failedStepIds.join(', ')}`);
        if (name === 'v3' || name === 'v3-on-v4')
          audits[name] = JSON.parse(await readFile(auditPath, 'utf8'));
      }
      assert.deepEqual(audits.v3, { n: 2, with_decision: 2 });
      assert.deepEqual(audits['v3-on-v4'], { n: 2, with_decision: 0 });
      report.stage = 'audit-probe';
      report.audit_probe = { v3: audits.v3, v4: audits['v3-on-v4'] };
      console.log('Native audit probe: v3 exposed 2/2 synthetic decisions; v4 exposed 0/2.');
      report.status = report.suites.every((suite) => suite.unexpectedFail === 0) ? 'PASS' : 'FAIL';
      if (report.status === 'FAIL') process.exitCode = 1;
    } finally {
      assert.deepEqual(
        await suppliedTables(baseUrl),
        before,
        'Supplied database table catalog changed',
      );
      report.supplied_database_table_catalog_unchanged = true;
      if (report.status === 'PASS') report.stage = 'complete';
    }
  }
} catch (error) {
  report.status = 'FAIL';
  // Never print a connection string, database payload or SQL error detail.
  report.reason = 'Native handoff verification failed; no passing status is inferred';
  if (/^[0-9A-Z]{5}$/.test(error.code ?? '')) report.database_error_code = error.code;
  console.error(report.reason);
  process.exitCode = 1;
} finally {
  if (scratch) await rm(scratch, { recursive: true, force: true });
  if (reportPath) {
    await mkdir(dirname(reportPath), { recursive: true });
    await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  }
}
