import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import type { Client } from 'pg';
import {
  adaptPreservedSuite,
  disposableUrl,
  inspectSuiteResult,
  withDisposableHandoffDatabase,
} from '../scripts/test-handoff-postgres-helpers.mjs';

const testUrl = 'postgres://synthetic:synthetic@127.0.0.1:5432/untouched_source';
const name = 'verify_handoff_123_0123456789abcdef';

test('native handoff isolates its target and refuses ambiguous or Supabase connections', () => {
  assert.equal(new URL(disposableUrl(testUrl, name)).pathname, `/${name}`);
  assert.throws(() => disposableUrl(testUrl, 'untouched_source'));
  assert.throws(() => disposableUrl(testUrl + '?database=other', name));
  assert.throws(() => disposableUrl(testUrl + '?host=other', name));
  assert.throws(() => disposableUrl('https://example.invalid', name));
  assert.throws(() => disposableUrl('postgres://example.supabase.co/db', name));
  assert.throws(() => disposableUrl('postgres://region.pooler.supabase.com/db', name));
});

test('native handoff only drops a database it successfully created, including on failed suite runs', async () => {
  for (const scenario of ['success', 'suite-failure', 'create-failure', 'wrong-version']) {
    const statements: string[] = [];
    let ended = false;
    let operated = false;
    const client = {
      async connect() {},
      async query(sql: string) {
        statements.push(sql);
        if (sql.includes('server_version_num'))
          return { rows: [{ version: scenario === 'wrong-version' ? 170000 : 160006 }] };
        if (sql.startsWith('create database') && scenario === 'create-failure')
          throw new Error('Synthetic creation refusal');
        return { rows: [] };
      },
      async end() {
        ended = true;
      },
    };
    const run = withDisposableHandoffDatabase(
      testUrl,
      async (target: string) => {
        operated = true;
        assert.notEqual(target, testUrl);
        assert.match(new URL(target).pathname, /^\/verify_handoff_\d+_[0-9a-f]{16}$/);
        if (scenario === 'suite-failure') throw new Error('Synthetic suite failure');
        return 'complete';
      },
      () => client as unknown as Client,
    );
    if (scenario === 'success') assert.equal(await run, 'complete');
    else await assert.rejects(run);
    assert.equal(ended, true);
    const created = scenario === 'success' || scenario === 'suite-failure';
    assert.equal(operated, created);
    assert.equal(statements.filter((s) => s.startsWith('drop database')).length, created ? 1 : 0);
    assert.equal(
      statements.some((s) => /create table|insert into|update |delete from|drop schema/i.test(s)),
      false,
    );
  }
});

test('native driver adaptation preserves all supplied SQL and assertions byte for byte', () => {
  const first = "import { PGlite } from '@electric-sql/pglite';";
  const second = "import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';";
  const adapter = 'file:///synthetic/native-adapter.mjs';
  for (const suite of ['v2', 'v3', 'v4', 'v5', 'v5_1']) {
    const original = readFileSync(`tests/handoff/${suite}.mjs`, 'utf8');
    const adapted = adaptPreservedSuite(original, adapter);
    const restored = adapted
      .replace(`import { PGlite, pgcrypto } from ${JSON.stringify(adapter)};`, first)
      .replace(first + '\n\n', first + '\n' + second + '\n');
    assert.equal(restored, original);
  }
  assert.throws(() => adaptPreservedSuite(first, adapter));
  assert.throws(() => adaptPreservedSuite([first, first, second].join('\n'), adapter));
});

test('native result checks refuse successful exit codes with failed or missing assertions', () => {
  const complete = {
    summary: { n: 2, pass: 2, fail: 0 },
    results: [
      { id: 'SYN-A', pass: true },
      { id: 'SYN-B', pass: true },
    ],
  };
  assert.equal(inspectSuiteResult(complete, 2).fail, 0);
  assert.throws(() => inspectSuiteResult(complete, 3));
  assert.throws(() => inspectSuiteResult({ ...complete, results: complete.results.slice(1) }, 2));
  assert.throws(() => inspectSuiteResult({ ...complete, summary: { n: 2, pass: 1, fail: 1 } }, 2));
  const failed = {
    summary: { n: 2, pass: 1, fail: 1 },
    results: [
      { id: 'SYN-A', pass: true },
      { id: 'SYN-B', pass: false },
    ],
  };
  assert.deepEqual(inspectSuiteResult(failed, 2).failedStepIds, ['SYN-B']);
});

test('native handoff reports unavailable service as BLOCKED and fails when CI requires it', () => {
  const env = { ...process.env, VERIFY_PG_TEST_URL: '', VERIFY_PG_REQUIRE: '' };
  const output = execFileSync(process.execPath, ['scripts/test-handoff-postgres.mjs'], {
    env,
    encoding: 'utf8',
  });
  assert.match(output, /BLOCKED:.*no native PostgreSQL suite was executed/);
  assert.doesNotMatch(output, /steps passed/);
  assert.throws(() =>
    execFileSync(process.execPath, ['scripts/test-handoff-postgres.mjs'], {
      env: { ...env, VERIFY_PG_REQUIRE: '1' },
      stdio: 'pipe',
    }),
  );
});
