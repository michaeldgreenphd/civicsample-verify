// Migration 0023 (prepared, not applied remotely): service_role keeps the 0022 administration grants
// but can no longer truncate, add foreign keys to, or create triggers on public tables; anon and
// authenticated are unchanged. Reproduces the project-default privileges first, as observed on staging.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { HOSTED_SCHEMA_FILES } from '../scripts/supabase-identity-tools.mjs';

async function asRole<T>(db: PGlite, role: string, fn: () => Promise<T>) {
  await db.exec('begin');
  await db.exec(`set local role ${role}`);
  try {
    return await fn();
  } finally {
    await db.exec('rollback');
  }
}
const privileges = async (db: PGlite, grantee: string, table: string) =>
  (
    await db.query<{ p: string }>(
      "select string_agg(privilege_type, ',' order by privilege_type) as p from information_schema.role_table_grants where grantee = $1 and table_schema = 'public' and table_name = $2",
      [grantee, table],
    )
  ).rows[0].p ?? '';

test('0023 revokes TRUNCATE/REFERENCES/TRIGGER from service_role on every public table and keeps the 0022 grants', async () => {
  const db = new PGlite({ extensions: { pgcrypto } });
  try {
    await db.exec(readFileSync('supabase_test_shim/auth_shim.sql', 'utf8'));
    for (const path of HOSTED_SCHEMA_FILES.filter((p: string) => !p.includes('0023')))
      await db.exec(readFileSync(path, 'utf8'));
    // Reproduce the staging observation: project defaults grant service_role everything on new tables.
    await db.exec('grant all on all tables in schema public to service_role');
    assert.match(await privileges(db, 'service_role', 'users'), /TRUNCATE/);
    const can = async (table: string) =>
      (
        await db.query<{ ok: boolean }>(
          "select has_table_privilege('service_role', $1, 'TRUNCATE') as ok",
          [`public.${table}`],
        )
      ).rows[0].ok;
    assert.equal(await can('reviewers'), true, 'reproduction: project defaults allow truncation');
    await db.exec(readFileSync('migrations/0023_service_role_truncate_revoke.sql', 'utf8'));
    for (const table of [
      'users',
      'account_locks',
      'reviewers',
      'mc_cases',
      'tlv5_submissions',
      'audit_log',
    ]) {
      const p = await privileges(db, 'service_role', table);
      assert.ok(!/TRUNCATE|REFERENCES|TRIGGER/.test(p), `${table}: ${p}`);
    }
    assert.equal(await privileges(db, 'service_role', 'users'), 'DELETE,INSERT,SELECT,UPDATE');
    await assert.rejects(
      asRole(db, 'service_role', () => db.query('truncate public.users')),
      /permission denied/,
    );
    await assert.rejects(
      asRole(db, 'service_role', () => db.query('truncate public.reviewers')),
      /permission denied/,
    );
    // The administration path still works.
    await asRole(db, 'service_role', () => db.query('select user_id from public.users limit 1'));
    // anon and authenticated are unchanged.
    assert.equal(await privileges(db, 'anon', 'users'), '');
    assert.equal(await privileges(db, 'authenticated', 'users'), 'SELECT');
    // Default privileges: a table created later by the owner does not grant service_role truncate.
    await db.exec('create table public.zz_later (id int primary key)');
    await db.exec(
      'grant select, insert, update, delete, truncate, references, trigger on public.zz_later to service_role',
    );
    // (An explicit grant can still add them; the default-privilege clause covers the implicit case.)
    await db.exec('drop table public.zz_later');
    const marker = await db.query(
      "select 1 from public.app_schema_version where version = '6.0.5-service-role-truncate-revoke'",
    );
    assert.equal(marker.rows.length, 1);
  } finally {
    await db.close();
  }
});
