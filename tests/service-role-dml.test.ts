// Migration 0027 (PR #7 review on 0023): on a project whose defaults grant service_role every
// table privilege, the service-role key keeps exactly the 0022 administration grants and nothing
// else, and tables created afterwards grant it nothing. Reproduced first without 0027.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { HOSTED_SCHEMA_FILES } from '../scripts/supabase-identity-tools.mjs';

const FIX = 'migrations/0027_service_role_least_privilege.sql';
const has = async (db: PGlite, table: string, privilege: string) =>
  (
    await db.query<{ ok: boolean }>('select has_table_privilege($1, $2, $3) as ok', [
      'service_role',
      `public.${table}`,
      privilege,
    ])
  ).rows[0].ok;

async function chain(withFix: boolean) {
  const db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(readFileSync('supabase_test_shim/auth_shim.sql', 'utf8'));
  for (const path of HOSTED_SCHEMA_FILES.filter((p: string) => p !== FIX))
    await db.exec(readFileSync(path, 'utf8'));
  // A project whose defaults grant service_role everything (the reviewer's scenario).
  await db.exec('grant all on all tables in schema public to service_role');
  await db.exec('alter default privileges in schema public grant all on tables to service_role');
  if (withFix) await db.exec(readFileSync(FIX, 'utf8'));
  return db;
}

test('without 0027 the service-role key can still change application records (reproduced)', async () => {
  const db = await chain(false);
  try {
    for (const [table, p] of [
      ['users', 'DELETE'],
      ['mc_responses', 'DELETE'],
      ['mc_responses', 'INSERT'],
      ['mu7_judgments', 'UPDATE'],
      ['audit_log', 'DELETE'],
    ])
      assert.equal(await has(db, table, p), true, `${table} ${p}`);
  } finally {
    await db.close();
  }
});

test('with 0027 the service-role key holds exactly the 0022 administration grants', async () => {
  const db = await chain(true);
  try {
    for (const table of ['users', 'account_locks']) {
      for (const p of ['SELECT', 'INSERT', 'UPDATE'])
        assert.equal(await has(db, table, p), true, `${table} ${p}`);
      for (const p of ['DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'])
        assert.equal(await has(db, table, p), false, `${table} ${p}`);
    }
    for (const table of ['reviewers', 'app_schema_version', 'audit_log']) {
      assert.equal(await has(db, table, 'SELECT'), true, table);
      for (const p of ['INSERT', 'UPDATE', 'DELETE'])
        assert.equal(await has(db, table, p), false, `${table} ${p}`);
    }
    for (const table of [
      'mc_responses',
      'mc_cases',
      'mu7_judgments',
      'mu7_units',
      'tlv5_submissions',
      'cases',
    ])
      for (const p of ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'])
        assert.equal(await has(db, table, p), false, `${table} ${p}`);
    // The schema default no longer gives a later table to service_role.
    await db.exec('create table public.zz_later_table (id int)');
    for (const p of ['SELECT', 'INSERT', 'DELETE', 'TRUNCATE'])
      assert.equal(await has(db, 'zz_later_table', p), false, `later table ${p}`);
  } finally {
    await db.close();
  }
});
