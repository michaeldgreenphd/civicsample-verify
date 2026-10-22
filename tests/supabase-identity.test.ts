// Supabase identity tooling: offline validation, plan generation, apply guards and the admin
// client against a mocked gateway. No request leaves the process; no secret reaches output.
import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  adminClient,
  assertApplyAuthorized,
  buildBootstrapPlan,
  EXPECTED_SCHEMA_VERSION,
  generatePassword,
  HOSTED_SCHEMA_FILES,
  internalEmail,
  planSha256,
  SupabaseIdentityError,
  validateAdminConfig,
} from '../scripts/supabase-identity-tools.mjs';

const root = resolve('.');
const serviceKey = `h.${Buffer.from(JSON.stringify({ role: 'service_role' })).toString('base64url')}.s`;
const anonKey = `h.${Buffer.from(JSON.stringify({ role: 'anon' })).toString('base64url')}.s`;
function config(overrides: Record<string, unknown> = {}) {
  return {
    project: {
      environment: 'staging',
      stagingProjectRef: 'synthetic-staging',
      productionProjectRef: null,
      projectUrl: 'https://synthetic-staging.supabase.co',
    },
    serviceRoleKey: serviceKey,
    databaseUrl: null,
    accounts: [
      { username: 'syn-investigator', displayName: 'Synthetic investigator', role: 'INVESTIGATOR' },
      { username: 'syn-reviewer-1', displayName: 'Synthetic reviewer 1', role: 'REVIEWER' },
      { username: 'syn-adjudicator', displayName: 'Synthetic adjudicator', role: 'ADJUDICATOR' },
    ],
    ...overrides,
  };
}
const code = (fn: () => unknown) => {
  try {
    fn();
    return null;
  } catch (e) {
    return e instanceof SupabaseIdentityError ? e.code : 'OTHER';
  }
};

test('admin configuration: staging only, service-role key required, usernames instead of e-mail', () => {
  assert.equal(
    code(() => validateAdminConfig(config())),
    null,
  );
  assert.equal(
    code(() => validateAdminConfig(config({ serviceRoleKey: anonKey }))),
    'SERVICE_ROLE_KEY_REQUIRED',
  );
  assert.equal(
    code(() => validateAdminConfig(config({ serviceRoleKey: 'sb_publishable_x'.padEnd(40, 'y') }))),
    'SERVICE_ROLE_KEY_REQUIRED',
  );
  assert.equal(
    code(() => validateAdminConfig(config({ serviceRoleKey: 'sb_secret_'.padEnd(40, 'y') }))),
    null,
  );
  assert.equal(
    code(() =>
      validateAdminConfig(config({ project: { ...config().project, environment: 'production' } })),
    ),
    'ADMIN_CONFIG_PROJECT',
  );
  assert.equal(
    code(() =>
      validateAdminConfig(
        config({ project: { ...config().project, projectUrl: 'https://other.supabase.co' } }),
      ),
    ),
    'ADMIN_CONFIG_PROJECT',
  );
  assert.equal(
    code(() =>
      validateAdminConfig(
        config({ accounts: [{ username: 'a@b.invalid', displayName: 'x', role: 'REVIEWER' }] }),
      ),
    ),
    'ROSTER_USERNAME',
  );
  assert.equal(
    code(() =>
      validateAdminConfig(
        config({
          accounts: [{ username: 'rev', displayName: 'x', role: 'REVIEWER', email: 'x@y.z' }],
        }),
      ),
    ),
    'ROSTER_FIELDS',
  );
  assert.equal(
    code(() =>
      validateAdminConfig(
        config({ accounts: [{ username: 'rev', displayName: 'x', role: 'REVIEWER' }] }),
      ),
    ),
    'ROSTER_INVESTIGATOR',
  );
  assert.equal(
    code(() =>
      validateAdminConfig(
        config({ databaseUrl: 'postgresql://u:p@db.synthetic-staging.supabase.co:5432/postgres' }),
      ),
    ),
    null,
  );
  assert.equal(
    code(() =>
      validateAdminConfig(
        config({ databaseUrl: 'postgresql://u:p@db.elsewhere.supabase.co/postgres' }),
      ),
    ),
    'DATABASE_URL',
  );
  assert.equal(
    code(() => validateAdminConfig({ ...config(), extra: 1 })),
    'ADMIN_CONFIG_KEYS',
  );
  assert.equal(
    internalEmail('syn-reviewer-1', 'synthetic-staging'),
    'syn-reviewer-1@synthetic-staging.accounts.invalid',
  );
});

test('bootstrap plan: exact target, hashed SQL lineage without the auth shim, no secrets', () => {
  const plan = buildBootstrapPlan(config(), root);
  assert.equal(plan.generatedFor.projectRef, 'synthetic-staging');
  assert.equal(plan.mutationsPerformed, false);
  assert.deepEqual(
    plan.schema.files.map((f: { path: string }) => f.path),
    HOSTED_SCHEMA_FILES,
  );
  assert.ok(
    plan.schema.files.every(
      (f: { sha256: string; bytes: number }) => /^[0-9a-f]{64}$/.test(f.sha256) && f.bytes > 0,
    ),
  );
  assert.ok(!HOSTED_SCHEMA_FILES.some((p) => p.includes('auth_shim')));
  assert.equal(plan.schema.expectedFinalVersion, EXPECTED_SCHEMA_VERSION);
  const text = JSON.stringify(plan);
  assert.ok(!text.includes(serviceKey));
  assert.ok(!text.includes('@') || text.includes('accounts.invalid'));
  assert.equal(plan.accounts.length, 3);
  assert.equal(
    plan.accounts[0].internalEmail,
    'syn-investigator@synthetic-staging.accounts.invalid',
  );
  assert.match(planSha256(plan), /^[0-9a-f]{64}$/);
  // A shim-like file in the lineage is refused.
  assert.equal(
    code(() =>
      buildBootstrapPlan(config(), root, (p) =>
        p === 'schema.sql'
          ? 'create schema auth; create function auth.uid() returns uuid'
          : 'select 1',
      ),
    ),
    'AUTH_SHIM_REFUSED',
  );
});

test('apply guards: environment opt-in, typed project reference and the reviewed plan hash', () => {
  const c = config();
  const hash = planSha256(buildBootstrapPlan(c, root));
  const guard = (
    env: Record<string, string>,
    confirmProject: string | undefined,
    planHash: string | undefined,
  ) =>
    code(() =>
      assertApplyAuthorized({ env, confirmProject, planHash, config: c, repositoryRoot: root }),
    );
  assert.equal(guard({}, 'synthetic-staging', hash), 'APPLY_NOT_ENABLED');
  assert.equal(guard({ VERIFY_SUPABASE_ADMIN_APPLY: '1' }, 'other', hash), 'CONFIRM_PROJECT');
  assert.equal(
    guard({ VERIFY_SUPABASE_ADMIN_APPLY: '1' }, 'synthetic-staging', 'f'.repeat(64)),
    'PLAN_HASH',
  );
  assert.equal(guard({ VERIFY_SUPABASE_ADMIN_APPLY: '1' }, 'synthetic-staging', hash), null);
});

test('admin client: confirmed accounts with generated passwords, linked app rows, lock and reset', async () => {
  const c = config();
  const calls: { method: string; path: string; body: unknown; auth: string | null }[] = [];
  const fetchMock = async (input: string | URL, options?: RequestInit) => {
    const url = new URL(String(input));
    assert.equal(url.origin, c.project.projectUrl);
    assert.equal(options?.redirect, 'error');
    const headers = new Headers(options?.headers);
    assert.equal(headers.get('apikey'), serviceKey);
    calls.push({
      method: options?.method ?? 'GET',
      path: url.pathname + url.search,
      body: options?.body ? JSON.parse(String(options.body)) : undefined,
      auth: headers.get('Authorization'),
    });
    let body: unknown = {};
    if (url.pathname === '/auth/v1/admin/users' && options?.method === 'GET') body = { users: [] };
    else if (url.pathname === '/auth/v1/admin/users' && options?.method === 'POST')
      body = { id: '00000000-0000-4000-8000-000000000101' };
    else if (url.pathname === '/rest/v1/users')
      body = [{ user_id: '00000000-0000-4000-8000-000000000201' }];
    else if (url.pathname === '/rest/v1/app_schema_version') body = [{ version: 'x' }];
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  const client = adminClient(c, fetchMock as typeof fetch);
  assert.equal(
    await client.findAuthUserByEmail('syn-reviewer-1@synthetic-staging.accounts.invalid'),
    null,
  );
  const password = generatePassword();
  assert.ok(password.length >= 32);
  const created = await client.createAuthUser(
    'syn-reviewer-1@synthetic-staging.accounts.invalid',
    password,
    'Synthetic reviewer 1',
    'REVIEWER',
  );
  assert.equal(created.id, '00000000-0000-4000-8000-000000000101');
  const create = calls.find((x) => x.method === 'POST' && x.path === '/auth/v1/admin/users')!;
  assert.equal((create.body as { email_confirm: boolean }).email_confirm, true);
  assert.equal((create.body as { password: string }).password, password);
  assert.equal(create.auth, `Bearer ${serviceKey}`);
  const linked = await client.upsertAppUser(
    created.id,
    'syn-reviewer-1@synthetic-staging.accounts.invalid',
    'Synthetic reviewer 1',
    'REVIEWER',
  );
  assert.equal(linked.userId, '00000000-0000-4000-8000-000000000201');
  const row = calls.find((x) => x.path.startsWith('/rest/v1/users'))!.body as {
    auth_uid: string;
    is_pilot_test_account: boolean;
  }[];
  assert.equal(row[0].auth_uid, created.id);
  assert.equal(row[0].is_pilot_test_account, false);
  await client.setPassword(created.id, 'another-generated-password-value');
  await client.setLocked(created.id, true);
  const puts = calls.filter((x) => x.method === 'PUT');
  assert.deepEqual(
    puts.map((x) => x.body),
    [{ password: 'another-generated-password-value' }, { ban_duration: '876000h' }],
  );
  // Refusals: a redirect, a non-2xx status and a foreign origin.
  const refusing = adminClient(
    c,
    (async () => new Response('{}', { status: 302 })) as unknown as typeof fetch,
  );
  await assert.rejects(refusing.schemaVersions(), /refusing|redirected/i);
  const denied = adminClient(
    c,
    (async () => new Response('{"message":"x"}', { status: 401 })) as unknown as typeof fetch,
  );
  await assert.rejects(denied.schemaVersions(), /refused/);
});

test('CLI: blocked without a private configuration; dry run prints the plan and never mutates', () => {
  const blocked = spawnSync(process.execPath, ['scripts/supabase-admin.mjs', 'plan'], {
    encoding: 'utf8',
    env: { ...process.env, VERIFY_SUPABASE_ADMIN_CONFIG: '' },
  });
  assert.equal(blocked.status, 2);
  assert.match(blocked.stdout, /PRIVATE_ADMIN_CONFIG_UNAVAILABLE/);
  const dir = mkdtempSync(join(tmpdir(), 'verify-supabase-admin-'));
  try {
    const file = join(dir, 'supabase-admin.json');
    writeFileSync(file, JSON.stringify(config()));
    chmodSync(file, 0o600);
    const dry = spawnSync(
      process.execPath,
      ['scripts/supabase-admin.mjs', 'accounts', '--config', file, '--dry-run'],
      { encoding: 'utf8' },
    );
    assert.equal(dry.status, 0, dry.stderr);
    const report = JSON.parse(dry.stdout);
    assert.equal(report.status, 'DRY_RUN');
    assert.equal(report.mutationsPerformed, false);
    assert.ok(!dry.stdout.includes(serviceKey));
    // --apply without the opt-in is refused before any request; the message carries no secret.
    const refused = spawnSync(
      process.execPath,
      [
        'scripts/supabase-admin.mjs',
        'accounts',
        '--config',
        file,
        '--apply',
        '--confirm-project',
        'synthetic-staging',
        '--plan-sha256',
        report.planSha256,
        '--credentials-out',
        join(dir, 'creds.json'),
      ],
      { encoding: 'utf8', env: { ...process.env, VERIFY_SUPABASE_ADMIN_APPLY: '' } },
    );
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /APPLY_NOT_ENABLED/);
    assert.ok(!refused.stderr.includes(serviceKey));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
