// Reversible account locks (migration 0021), exercised against the real full-lineage schema in
// PGlite: the admin client's lock/unlock requests are translated by a PostgREST-shaped fake into
// SQL executed as the database owner (the service role's standing), while reviewer and
// investigator sessions check what a locked and an unlocked account can reach.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import {
  adminClient,
  APPROVED_STAGING_PROJECT_REFS,
  HOSTED_SCHEMA_FILES,
} from '../scripts/supabase-identity-tools.mjs';
import { GUARD_IDS, guardActor, guardSubmit, seedGuardDatabase } from './tlv5-guard-fixture';

const APPROVED = APPROVED_STAGING_PROJECT_REFS[0];
const serviceKey = `h.${Buffer.from(JSON.stringify({ role: 'service_role' })).toString('base64url')}.s`;
const AUTH_UID = GUARD_IDS.a; // the guard fixture links auth.users.id = users.user_id = auth_uid

/** Translate the few PostgREST calls the client makes into owner SQL on the PGlite database. */
function restGateway(db: PGlite, faults: { failBans?: number } = {}) {
  const bans: Record<string, string> = {};
  return async (input: string | URL, options?: RequestInit) => {
    try {
      return await handle(input, options);
    } catch (e) {
      // PostgREST answers a constraint violation with an error status, not a dropped request.
      return new Response(JSON.stringify({ message: (e as Error).message }), { status: 409 });
    }
  };
  async function handle(input: string | URL, options?: RequestInit) {
    const url = new URL(String(input));
    const method = options?.method ?? 'GET';
    const body = options?.body ? JSON.parse(String(options.body)) : undefined;
    const eq = (k: string) => url.searchParams.get(k)?.replace(/^eq\./, '');
    let rows: unknown = [];
    if (url.pathname.startsWith('/auth/v1/admin/users/') && method === 'PUT') {
      if (faults.failBans && faults.failBans-- > 0)
        return new Response(JSON.stringify({ message: 'synthetic interruption' }), { status: 503 });
      bans[url.pathname.split('/').at(-1)!] = body.ban_duration;
      rows = { id: url.pathname.split('/').at(-1) };
    } else if (url.pathname === '/rest/v1/users' && method === 'GET') {
      rows = (
        await db.query(
          'select user_id, email, role, is_active from public.users where auth_uid = $1',
          [eq('auth_uid')],
        )
      ).rows;
    } else if (url.pathname === '/rest/v1/account_locks' && method === 'POST') {
      rows = (
        await db.query(
          'insert into public.account_locks (user_id, locked_by) values ($1, $2) returning lock_id',
          [body[0].user_id, body[0].locked_by],
        )
      ).rows;
    } else if (url.pathname === '/rest/v1/account_locks' && method === 'PATCH') {
      rows = (
        await db.query(
          'update public.account_locks set released_at = $2, released_by = $3 where user_id = $1 and released_at is null returning lock_id',
          [eq('user_id'), body.released_at, body.released_by],
        )
      ).rows;
    } else if (url.pathname === '/rest/v1/account_locks' && method === 'GET') {
      rows = (
        await db.query(
          'select lock_id from public.account_locks where user_id = $1 and released_at is null',
          [eq('user_id')],
        )
      ).rows;
    } else throw new Error(`unexpected request ${method} ${url.pathname}`);
    return new Response(JSON.stringify(rows), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
async function reviewerCanAct(db: PGlite) {
  return guardActor(db, 'a', async () => {
    const who = (await db.query('select * from public.rpc_whoami()')).rows;
    const pseudo = (
      await db.query<{ p: string | null }>('select private.my_reviewer_pseudo_id() as p')
    ).rows[0].p;
    const cases = (await db.query('select * from public.tlv5_cases')).rows.length;
    return { who: who.length, pseudo, cases };
  });
}

test('lock blocks a reviewer immediately without deactivating the row; unlock restores access; deactivation stays permanent', async () => {
  const db = new PGlite({ extensions: { pgcrypto } });
  try {
    await seedGuardDatabase(db);
    for (const path of HOSTED_SCHEMA_FILES.filter((p: string) =>
      /0014|0015|0016|0017|0018|0019|0020|0021/.test(p),
    ))
      await db.exec(readFileSync(path, 'utf8'));
    const client = adminClient(
      {
        project: {
          environment: 'staging',
          stagingProjectRef: APPROVED,
          productionProjectRef: null,
          projectUrl: `https://${APPROVED}.supabase.co`,
        },
        serviceRoleKey: serviceKey,
        databaseUrl: null,
        accounts: [],
      },
      restGateway(db) as unknown as typeof fetch,
    );
    assert.deepEqual(await reviewerCanAct(db), {
      who: 1,
      pseudo: (await reviewerCanAct(db)).pseudo,
      cases: 1,
    });
    // Lock: the reviewer's existing session resolves to no user and reads nothing.
    const locked = await client.setLocked(AUTH_UID, true);
    assert.deepEqual(
      { locked: locked.locked, active: locked.isActive },
      { locked: true, active: true },
    );
    assert.deepEqual(await reviewerCanAct(db), { who: 0, pseudo: null, cases: 0 });
    // The locked reviewer no longer sees their assignment (RLS) and cannot submit.
    await assert.rejects(
      guardSubmit(db, 'a', 'YES'),
      /assignment_id|not your v5 assignment|permission denied/,
    );
    // The investigator sees the lock; application roles cannot write locks.
    await guardActor(db, 'investigator', async () => {
      const rows = await db.query<{ released_at: string | null }>(
        'select released_at from public.account_locks',
      );
      assert.deepEqual(rows.rows, [{ released_at: null }]);
    });
    // Each refused write in its own transaction (a refused statement aborts the transaction).
    await assert.rejects(
      guardActor(db, 'investigator', () =>
        db.query("update public.account_locks set released_at = now(), released_by = 'x'"),
      ),
      /permission denied/,
    );
    await assert.rejects(
      guardActor(db, 'investigator', () => db.query('delete from public.account_locks')),
      /permission denied/,
    );
    const active = (
      await db.query<{ a: boolean }>('select is_active as a from public.users where user_id = $1', [
        GUARD_IDS.a,
      ])
    ).rows[0].a;
    assert.equal(active, true, 'the row was not deactivated');
    // Unlock: access returns; the lock history is kept and audited.
    const unlocked = await client.setLocked(AUTH_UID, false);
    assert.equal(unlocked.locked, false);
    const after = await reviewerCanAct(db);
    assert.equal(after.who, 1);
    assert.equal(after.cases, 1);
    await guardSubmit(db, 'a', 'YES');
    const audit = (
      await db.query<{ action: string }>(
        "select action from public.audit_log where entity_table = 'account_locks' order by audit_id",
      )
    ).rows.map((r) => r.action);
    assert.deepEqual(audit, ['ACCOUNT_LOCKED', 'ACCOUNT_LOCK_RELEASED']);
    await assert.rejects(
      db.query("update public.account_locks set released_at = now(), released_by = 'again'"),
      /only an unreleased lock may be released, once/,
    );
    // Deactivation remains permanent: the preserved trigger refuses reactivation.
    await db.query(
      'update public.users set is_active = false, deactivated_at = now() where user_id = $1',
      [GUARD_IDS.b],
    );
    await assert.rejects(
      db.query('update public.users set is_active = true where user_id = $1', [GUARD_IDS.b]),
      /only first account linking, display_name and deactivation may change/,
    );
  } finally {
    await db.close();
  }
});

test('PR #7 review: a lock interrupted after its row is written is completed by a retry', async () => {
  const db = new PGlite({ extensions: { pgcrypto } });
  try {
    await seedGuardDatabase(db);
    for (const path of HOSTED_SCHEMA_FILES.filter((p: string) =>
      /0014|0015|0016|0017|0018|0019|0020|0021/.test(p),
    ))
      await db.exec(readFileSync(path, 'utf8'));
    const faults = { failBans: 1 };
    const calls: { method: string; path: string; body?: unknown }[] = [];
    const gateway = restGateway(db, faults);
    const client = adminClient(
      {
        project: {
          environment: 'staging',
          stagingProjectRef: APPROVED,
          productionProjectRef: null,
          projectUrl: `https://${APPROVED}.supabase.co`,
        },
        serviceRoleKey: serviceKey,
        databaseUrl: null,
        accounts: [],
      },
      (async (input: string | URL, options?: RequestInit) => {
        const u = new URL(String(input));
        calls.push({
          method: options?.method ?? 'GET',
          path: u.pathname,
          body: options?.body && JSON.parse(String(options.body)),
        });
        return gateway(input, options);
      }) as unknown as typeof fetch,
    );
    // The Auth ban fails after the lock row is written: the account is locked in the
    // application but sign-in is not yet banned.
    await assert.rejects(client.setLocked(AUTH_UID, true));
    assert.deepEqual(await reviewerCanAct(db), { who: 0, pseudo: null, cases: 0 });
    // The retry completes the ban instead of failing on the existing lock row.
    const retried = await client.setLocked(AUTH_UID, true);
    assert.equal(retried.locked, true);
    const bans = calls.filter((c) => c.method === 'PUT').map((c) => c.body);
    assert.deepEqual(bans.at(-1), { ban_duration: '876000h' });
    const rows = await db.query(
      'select lock_id from public.account_locks where released_at is null',
    );
    assert.equal(rows.rows.length, 1, 'one active lock row, not two');
    // Unlock after the recovered lock works as usual.
    assert.equal((await client.setLocked(AUTH_UID, false)).locked, false);
    assert.equal((await reviewerCanAct(db)).who, 1);
  } finally {
    await db.close();
  }
});
