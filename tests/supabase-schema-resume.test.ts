// Bootstrap resume (PR #7 re-review): the schema runner plans against the lineage already present,
// skips applied files, refuses partial or out-of-order lineages, and recovers from an interrupted
// run. Exercised through an in-memory adapter and through a PGlite database holding the full
// lineage (the reviewer's reproduction scenario: a rerun on an initialized database).
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { applySchemaWith, planSchemaApplication } from '../scripts/supabase-admin.mjs';
import {
  HOSTED_SCHEMA_FILES,
  REPEATABLE_SCHEMA_FILES,
  SCHEMA_FILE_MARKERS,
  SupabaseIdentityError,
} from '../scripts/supabase-identity-tools.mjs';

const markersOf = (path: string) => (SCHEMA_FILE_MARKERS as Record<string, string[]>)[path] ?? [];
const nonRepeatable = HOSTED_SCHEMA_FILES.filter(
  (p: string) => !REPEATABLE_SCHEMA_FILES.includes(p),
);

/** A fake database: tracks markers written by each applied file; can fail on one file once. */
function fakeDatabase(initialVersions: string[] = [], failOn?: string) {
  const versions = [...initialVersions];
  const executed: string[] = [];
  let failed = false;
  const adapter = {
    async query(sql: string) {
      if (sql.startsWith('select to_regclass'))
        return { rows: [{ t: versions.length ? 'public.app_schema_version' : null }] };
      if (sql.startsWith('select version from public.app_schema_version'))
        return { rows: versions.map((version) => ({ version })) };
      const path =
        nonRepeatable.find((p: string) => sql === readFileSync(p, 'utf8')) ??
        REPEATABLE_SCHEMA_FILES.find((p: string) => sql === readFileSync(p, 'utf8'));
      if (!path) throw new Error('unexpected statement');
      if (path === failOn && !failed) {
        failed = true;
        throw new Error('synthetic connection loss');
      }
      executed.push(path);
      versions.push(...markersOf(path));
      return { rows: [] };
    },
  };
  return { adapter, versions, executed };
}
const read = (path: string) => readFileSync(path, 'utf8');

test('every non-repeatable hosted file has a version marker and the fresh plan applies all of them in order', () => {
  for (const path of nonRepeatable) assert.ok(markersOf(path).length, `${path} lacks a marker`);
  const steps = planSchemaApplication([]);
  assert.deepEqual(
    steps.map((s: { path: string }) => s.path),
    HOSTED_SCHEMA_FILES,
  );
  assert.ok(
    steps.every(
      (s: { action: string; path: string }) =>
        s.action === (REPEATABLE_SCHEMA_FILES.includes(s.path) ? 'RUN_REPEATABLE' : 'APPLY'),
    ),
  );
});

test('an interrupted bootstrap resumes: applied files are skipped, the failed file and the rest are applied', async () => {
  const failOn = 'migrations/0008_trial_packet_and_concurrency_guards.sql';
  const first = fakeDatabase([], failOn);
  await assert.rejects(
    applySchemaWith(first.adapter, read, { actions: [] }),
    /synthetic connection loss/,
  );
  assert.ok(first.versions.includes('1.0.0') && first.versions.includes('4.0.4-frozen-contract'));
  assert.ok(!first.versions.includes('4.0.5-trial-packet-concurrency-guards'));
  // Second run on the same database state.
  const second = fakeDatabase(first.versions);
  const result = await applySchemaWith(second.adapter, read, { actions: [] });
  const applied = result.actions
    .filter((a: { action: string }) => a.action === 'APPLIED')
    .map((a: { path: string }) => a.path);
  assert.equal(applied[0], failOn);
  assert.ok(!applied.includes('schema.sql'));
  assert.ok(
    result.actions.some(
      (a: { action: string; path: string }) =>
        a.action === 'ALREADY_APPLIED' && a.path === 'schema.sql',
    ),
  );
  assert.ok(result.actions.some((a: { action: string }) => a.action === 'RAN_REPEATABLE'));
  assert.deepEqual(new Set(second.versions), new Set(Object.values(SCHEMA_FILE_MARKERS).flat()));
  // Third run on the complete database: nothing but the repeatable preflight runs.
  const third = fakeDatabase(second.versions);
  const again = await applySchemaWith(third.adapter, read, { actions: [] });
  assert.deepEqual(third.executed, [...REPEATABLE_SCHEMA_FILES]);
  assert.ok(again.actions.every((a: { action: string }) => a.action !== 'APPLIED'));
});

test('partial, out-of-order and unknown lineages are refused before any write', async () => {
  const code = (fn: () => unknown) => {
    try {
      fn();
      return null;
    } catch (e) {
      return e instanceof SupabaseIdentityError ? e.code : 'OTHER';
    }
  };
  assert.equal(
    code(() => planSchemaApplication(['1.0.0', '4.0.0'])),
    'SCHEMA_ORDER',
  );
  assert.equal(
    code(() => planSchemaApplication(['1.0.0', 'not-a-known-marker'])),
    'SCHEMA_UNKNOWN',
  );
  const partial = fakeDatabase(['1.0.0', '3.0.0']);
  const result = await applySchemaWith(partial.adapter, read, { actions: [] });
  assert.ok(
    result.actions.find(
      (a: { path: string; action: string }) =>
        a.path === 'migrations/0003_v4_record_categories_module_b.sql',
    )?.action === 'APPLIED',
  );
});

test('a rerun against a fully migrated PGlite database writes nothing and reports the lineage', async () => {
  const db = new PGlite({ extensions: { pgcrypto } });
  try {
    await db.exec(read('supabase_test_shim/auth_shim.sql'));
    for (const path of HOSTED_SCHEMA_FILES) await db.exec(read(path));
    const before = (
      await db.query<{ n: number }>('select count(*)::int as n from public.app_schema_version')
    ).rows[0].n;
    // PGlite executes multi-statement files through exec; single selects through query.
    const adapter = {
      query: async (sql: string) =>
        /^\s*select/i.test(sql) ? db.query(sql) : (await db.exec(sql), { rows: [] }),
    };
    const result = await applySchemaWith(adapter, read, { actions: [] });
    assert.ok(
      result.actions.every(
        (a: { action: string }) => a.action === 'ALREADY_APPLIED' || a.action === 'RAN_REPEATABLE',
      ),
    );
    const after = (
      await db.query<{ n: number }>('select count(*)::int as n from public.app_schema_version')
    ).rows[0].n;
    assert.equal(after, before);
    assert.equal(result.schemaVersions.at(-1), '8.1.2-reviewer-profile');
  } finally {
    await db.close();
  }
});
