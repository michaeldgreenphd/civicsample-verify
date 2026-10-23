// Migration 0022: on a hardened Supabase project service_role has no table grants (BYPASSRLS does
// not bypass grants). The local shim defines service_role the same way, so the gap and the fix are
// reproduced here against the full lineage, and the admin tool's privilege preflight is checked.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import {
  adminClient,
  APPROVED_STAGING_PROJECT_REFS,
  HOSTED_SCHEMA_FILES,
  SupabaseIdentityError,
} from '../scripts/supabase-identity-tools.mjs';

const APPROVED = APPROVED_STAGING_PROJECT_REFS[0];
const serviceKey = `h.${Buffer.from(JSON.stringify({ role: 'service_role' })).toString('base64url')}.s`;
async function asRole<T>(db: PGlite, role: string, fn: () => Promise<T>) {
  await db.exec('begin');
  await db.exec(`set local role ${role}`);
  try {
    return await fn();
  } finally {
    await db.exec('rollback');
  }
}

test('service_role can link accounts and write locks only after 0022; anon and authenticated never can', async () => {
  const db = new PGlite({ extensions: { pgcrypto } });
  try {
    await db.exec(readFileSync('supabase_test_shim/auth_shim.sql', 'utf8'));
    const before0022 = HOSTED_SCHEMA_FILES.filter((p: string) => !p.includes('0022'));
    for (const path of before0022) await db.exec(readFileSync(path, 'utf8'));
    // Reproduction of the live finding: BYPASSRLS without grants.
    await assert.rejects(
      asRole(db, 'service_role', () => db.query('select user_id from public.users limit 1')),
      /permission denied/,
    );
    await db.exec(readFileSync('migrations/0022_service_role_admin_grants.sql', 'utf8'));
    // The Auth user itself is created by the Auth Admin API (not by service_role SQL); the owner stands in here.
    await db.query(
      "insert into auth.users (id, email) values ('00000000-0000-4000-8000-0000000000c1', 'syn-grant@x.accounts.invalid')",
    );
    await asRole(db, 'service_role', async () => {
      const row = await db.query<{ user_id: string }>(
        "insert into public.users (auth_uid, email, display_name, role, is_pilot_test_account) values ('00000000-0000-4000-8000-0000000000c1', 'syn-grant@x.accounts.invalid', 'Synthetic grant', 'REVIEWER', false) returning user_id",
      );
      const lock = await db.query<{ lock_id: string }>(
        'insert into public.account_locks (user_id, locked_by) values ($1, $2) returning lock_id',
        [row.rows[0].user_id, 'test'],
      );
      await db.query(
        "update public.account_locks set released_at = now(), released_by = 'test' where lock_id = $1",
        [lock.rows[0].lock_id],
      );
      assert.equal(
        (await db.query('select version from public.app_schema_version')).rows.length > 20,
        true,
      );
    });
    // No delete path for the admin role either (each refusal in its own transaction).
    await assert.rejects(
      asRole(db, 'service_role', () => db.query('delete from public.users')),
      /permission denied/,
    );
    await assert.rejects(
      asRole(db, 'service_role', () => db.query('delete from public.account_locks')),
      /permission denied|append-only|immutable/i,
    );
    for (const role of ['anon', 'authenticated']) {
      await assert.rejects(
        asRole(db, role, () =>
          db.query(
            "insert into public.users (email, display_name, role) values ('x@y.invalid', 'x', 'REVIEWER')",
          ),
        ),
        /permission denied/,
        `${role} insert users`,
      );
      await assert.rejects(
        asRole(db, role, () =>
          db.query(
            "insert into public.account_locks (user_id, locked_by) values ('00000000-0000-4000-8000-0000000000c1', 'x')",
          ),
        ),
        /permission denied/,
        `${role} insert account_locks`,
      );
    }
  } finally {
    await db.close();
  }
});

test('the admin tool refuses to provision when service_role lacks the admin grants', async () => {
  const config = {
    project: {
      environment: 'staging',
      stagingProjectRef: APPROVED,
      productionProjectRef: null,
      projectUrl: `https://${APPROVED}.supabase.co`,
    },
    serviceRoleKey: serviceKey,
    databaseUrl: null,
    accounts: [],
  };
  const denied = adminClient(
    config,
    (async (input: string | URL) =>
      new Response(
        JSON.stringify({ code: '42501', message: 'permission denied for table users' }),
        { status: String(input).includes('/rest/v1/') ? 403 : 200 },
      )) as unknown as typeof fetch,
  );
  await assert.rejects(
    denied.assertAdminPrivileges(),
    (e: unknown) =>
      e instanceof SupabaseIdentityError &&
      e.code === 'ADMIN_PRIVILEGES_MISSING' &&
      /migration 0022/.test(e.message),
  );
  const granted = adminClient(
    config,
    (async () => new Response('[]', { status: 200 })) as unknown as typeof fetch,
  );
  await granted.assertAdminPrivileges();
});
