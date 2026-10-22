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
  withDisposableHandoffDatabase,
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
    const combined = join(scratch, 'combined.sql');
    await writeFile(combined, (await readFile(m2, 'utf8')) + (await readFile(m3, 'utf8')), {
      mode: 0o600,
    });
    report.schema_sha256 = {};
    for (const [label, file] of [
      ['base', schema],
      ['0002', m2],
      ['0003', m3],
    ]) {
      report.schema_sha256[label] = createHash('sha256')
        .update(await readFile(file))
        .digest('hex');
    }
    const audits = {};
    try {
      for (const [name, sourceName, inputs, expected] of [
        ['v2', 'v2', [shim, schema], 164],
        ['v3', 'v3', [shim, schema, m2], 262],
        ['v3-on-v4', 'v3', [shim, schema, combined], 262],
        ['v4', 'v4', [shim, schema, m2, m3], 356],
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
        await withDisposableHandoffDatabase(baseUrl, async (target) => {
          await promisify(execFile)(
            process.execPath,
            [scriptPath, ...inputs, outputPath, join(scratch, `${name}.sql`)],
            {
              cwd: root,
              env: {
                ...process.env,
                VERIFY_HANDOFF_DISPOSABLE_URL: target,
                VERIFY_HANDOFF_AUDIT_OUTPUT: name === 'v3' || name === 'v3-on-v4' ? auditPath : '',
              },
              timeout: 120000,
              maxBuffer: 4 * 1024 * 1024,
            },
          );
        });
        const output = JSON.parse(await readFile(outputPath, 'utf8'));
        const result = inspectSuiteResult(output, expected);
        report.engine = output.summary.engine;
        report.suites.push({
          name,
          source_sha256: createHash('sha256').update(source).digest('hex'),
          driver_only_adaptation: true,
          ...result,
        });
        console.log(
          `${name}: ${result.pass}/${result.count} native PostgreSQL steps passed; ${result.fail} failed.`,
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
      report.status = report.suites.every((suite) => suite.fail === 0) ? 'PASS' : 'FAIL';
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
