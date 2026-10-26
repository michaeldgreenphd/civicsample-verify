// Supabase identity tooling: offline validation, plan generation, apply guards and the admin
// client against a mocked gateway. No request leaves the process; no secret reaches output.
import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  adminClient,
  APPROVED_STAGING_PROJECT_REFS,
  assertApplyAuthorized,
  buildBootstrapPlan,
  EXPECTED_SCHEMA_VERSION,
  generatePassword,
  HOSTED_SCHEMA_FILES,
  internalEmail,
  planSha256,
  SCHEMA_FILE_MARKERS,
  SupabaseIdentityError,
  validateAdminConfig,
  validateDatabaseDestination,
} from '../scripts/supabase-identity-tools.mjs';
import { parse, privateOutputPath } from '../scripts/supabase-admin.mjs';

const root = resolve('.');
const APPROVED = APPROVED_STAGING_PROJECT_REFS[0];
const serviceKey = `h.${Buffer.from(JSON.stringify({ role: 'service_role' })).toString('base64url')}.s`;
const anonKey = `h.${Buffer.from(JSON.stringify({ role: 'anon' })).toString('base64url')}.s`;
function config(overrides: Record<string, unknown> = {}) {
  return {
    project: {
      environment: 'staging',
      stagingProjectRef: APPROVED,
      productionProjectRef: null,
      projectUrl: `https://${APPROVED}.supabase.co`,
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

test('practice project is independently allowlisted and cannot use the completed pilot database', () => {
  const ref = 'wjntsoeifbelasidssmv';
  const practice = config({
    project: {
      ...config().project,
      stagingProjectRef: ref,
      projectUrl: `https://${ref}.supabase.co`,
    },
    databaseUrl: `postgresql://postgres.${ref}:synthetic@aws-0-us-east-1.pooler.supabase.com:5432/postgres`,
  });
  assert.equal(
    code(() => validateAdminConfig(practice)),
    null,
  );
  assert.equal(
    code(() =>
      validateAdminConfig({
        ...practice,
        databaseUrl: `postgresql://postgres.${APPROVED}:synthetic@aws-0-us-east-1.pooler.supabase.com:5432/postgres`,
      }),
    ),
    'DATABASE_DESTINATION',
  );
  assert.equal(
    code(() => validateAdminConfig(practice, [APPROVED])),
    'PROJECT_NOT_APPROVED',
  );
});

test('formal preparation target is explicit and cannot use either practice database', () => {
  const ref = 'jsuthraousvtgjpgixdz';
  const formal = config({
    project: {
      ...config().project,
      stagingProjectRef: ref,
      projectUrl: `https://${ref}.supabase.co`,
    },
    databaseUrl: `postgresql://postgres.${ref}:synthetic@aws-0-us-east-1.pooler.supabase.com:5432/postgres`,
  });
  assert.equal(
    code(() => validateAdminConfig(formal)),
    null,
  );
  for (const other of ['xmuiduugdrqvhssmeacz', 'wjntsoeifbelasidssmv']) {
    assert.equal(
      code(() =>
        validateAdminConfig({
          ...formal,
          databaseUrl: `postgresql://postgres.${other}:synthetic@aws-0-us-east-1.pooler.supabase.com:5432/postgres`,
        }),
      ),
      'DATABASE_DESTINATION',
    );
  }
  assert.equal(
    code(() => validateAdminConfig(formal, [APPROVED])),
    'PROJECT_NOT_APPROVED',
  );
  const plan = buildBootstrapPlan(formal, root);
  assert.equal(plan.generatedFor.projectRef, ref);
  assert.equal(plan.mutationsPerformed, false);
  assert.notEqual(planSha256(plan), planSha256(buildBootstrapPlan(config(), root)));
});

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
        config({ databaseUrl: `postgresql://postgres:p@db.${APPROVED}.supabase.co:5432/postgres` }),
      ),
    ),
    null,
  );
  assert.equal(
    code(() =>
      validateAdminConfig(
        config({
          databaseUrl: `postgresql://postgres.${APPROVED}:p@aws-0-eu-west-1.pooler.supabase.com:6543/postgres`,
        }),
      ),
    ),
    null,
  );
  // Look-alike hosts, wrong users, ports or databases are refused.
  for (const url of [
    `postgresql://postgres:p@${APPROVED}.unrelated.invalid:5432/postgres`,
    `postgresql://postgres:p@db.${APPROVED}.supabase.co.evil.invalid:5432/postgres`,
    `postgresql://u:p@db.${APPROVED}.supabase.co:5432/postgres`,
    `postgresql://postgres:p@db.${APPROVED}.supabase.co:6543/postgres`,
    `postgresql://postgres:p@db.${APPROVED}.supabase.co:5432/other`,
    `postgresql://postgres.other:p@aws-0-eu-west-1.pooler.supabase.com:6543/postgres`,
    `postgresql://postgres:p@db.${APPROVED}.supabase.co:5432/postgres?sslmode=disable`,
  ])
    assert.equal(
      code(() => validateDatabaseDestination(url, APPROVED)),
      'DATABASE_DESTINATION',
      url,
    );
  assert.equal(
    code(() =>
      validateAdminConfig(
        config({ databaseUrl: 'postgresql://postgres:p@db.elsewhere.supabase.co/postgres' }),
      ),
    ),
    'DATABASE_DESTINATION',
  );
  assert.equal(
    code(() => validateAdminConfig({ ...config(), extra: 1 })),
    'ADMIN_CONFIG_KEYS',
  );
  assert.equal(
    code(() => validateAdminConfig({ ...config(), databaseCaCertPath: '/abs/private/ca.crt' })),
    null,
  );
  assert.equal(
    code(() => validateAdminConfig({ ...config(), databaseCaCertPath: 'relative/ca.crt' })),
    'DATABASE_CA_CERT',
  );
  // Synthetic pilot reviewer accounts carry the immutable pilot flag; only reviewers may.
  const pilot = {
    username: 'syn-pilot-reviewer-1',
    displayName: 'Synthetic pilot reviewer 1',
    role: 'REVIEWER',
    isPilotTestAccount: true,
  };
  assert.equal(
    code(() => validateAdminConfig(config({ accounts: [...config().accounts, pilot] }))),
    null,
  );
  assert.equal(
    code(() =>
      validateAdminConfig(
        config({
          accounts: [...config().accounts, { ...pilot, username: 'syn-x', role: 'ADJUDICATOR' }],
        }),
      ),
    ),
    'ROSTER_PILOT_FLAG',
  );
  const pilotPlan = buildBootstrapPlan(config({ accounts: [...config().accounts, pilot] }), root);
  assert.equal(pilotPlan.accounts.at(-1).isPilotTestAccount, true);
  const { isPilotTestAccount: _omit, ...plain } = pilot;
  assert.notEqual(
    planSha256(pilotPlan),
    planSha256(buildBootstrapPlan(config({ accounts: [...config().accounts, plain] }), root)),
    'the flag is bound into the plan',
  );
  assert.equal(
    internalEmail('syn-reviewer-1', APPROVED),
    `syn-reviewer-1@${APPROVED}.accounts.invalid`,
  );
});

test('bootstrap plan: exact target, hashed SQL lineage without the auth shim, no secrets', () => {
  const plan = buildBootstrapPlan(config(), root);
  assert.equal(plan.generatedFor.projectRef, APPROVED);
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
  assert.equal(plan.accounts[0].internalEmail, `syn-investigator@${APPROVED}.accounts.invalid`);
  assert.match(planSha256(plan), /^[0-9a-f]{64}$/);
  // Every provisioned identity field is bound: a changed display name changes the reviewed hash
  // without disclosing the name in the plan.
  assert.match(plan.accounts[0].displayNameSha256, /^[0-9a-f]{64}$/);
  assert.ok(!text.includes('Synthetic investigator'));
  const renamed = config();
  renamed.accounts[0].displayName = 'Another name';
  assert.notEqual(planSha256(buildBootstrapPlan(renamed, root)), planSha256(plan));
  const compatibilityName = config();
  compatibilityName.accounts[0].displayName = 'Synthetic investigator\u00a0';
  const spaceName = config();
  spaceName.accounts[0].displayName = 'Synthetic investigator ';
  assert.notEqual(
    planSha256(buildBootstrapPlan(compatibilityName, root)),
    planSha256(buildBootstrapPlan(spaceName, root)),
    'the exact applied name is bound even when Unicode compatibility normalization matches',
  );
  assert.equal(plan.schema.expectedFinalVersion, '8.1.4-prepared-sample-intake');
  assert.equal(plan.database, null);
  const withDb = config({
    databaseUrl: `postgresql://postgres:p@db.${APPROVED}.supabase.co:5432/postgres`,
  });
  const planDb = buildBootstrapPlan(withDb, root);
  assert.deepEqual(planDb.database, {
    host: `db.${APPROVED}.supabase.co`,
    port: 5432,
    database: 'postgres',
    user: 'postgres',
    mode: 'direct',
  });
  assert.ok(!JSON.stringify(planDb).includes(':p@'), 'no password in the plan');
  const movedDb = config({
    databaseUrl: `postgresql://postgres.${APPROVED}:p@aws-0-eu-west-1.pooler.supabase.com:5432/postgres`,
  });
  assert.notEqual(
    planSha256(buildBootstrapPlan(movedDb, root)),
    planSha256(planDb),
    'a changed destination changes the reviewed hash',
  );
  assert.ok(HOSTED_SCHEMA_FILES.includes('migrations/0023_service_role_truncate_revoke.sql'));
  assert.ok(HOSTED_SCHEMA_FILES.includes('migrations/0024_v7_mapping_units.sql'));
  assert.ok(HOSTED_SCHEMA_FILES.includes('migrations/0025_v7_review_fixes.sql'));
  assert.ok(HOSTED_SCHEMA_FILES.includes('migrations/0026_v7_lifecycle_and_gates.sql'));
  assert.ok(HOSTED_SCHEMA_FILES.includes('migrations/0027_service_role_least_privilege.sql'));
  assert.ok(HOSTED_SCHEMA_FILES.includes('migrations/0028_v7_gate_specifications_v8_1.sql'));
  assert.ok(HOSTED_SCHEMA_FILES.includes('migrations/0029_v7_versioned_gate_approvals.sql'));
  assert.ok(HOSTED_SCHEMA_FILES.includes('migrations/0030_v7_current_unit_freeze_gates.sql'));
  assert.ok(HOSTED_SCHEMA_FILES.includes('migrations/0032_v7_freeze_gates_v8_4.sql'));
  assert.deepEqual(SCHEMA_FILE_MARKERS['migrations/0018_mapping_confirmation_review_fixes.sql'], [
    '6.0.1-mapping-confirmation-review-fixes',
  ]);
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
  // The test-only gate specification (supplied-suite regression in disposable databases) is never
  // in the lineage, and a lineage file carrying its marker is refused.
  assert.ok(!HOSTED_SCHEMA_FILES.some((f: string) => f.includes('supabase_test_shim')));
  const shim = readFileSync('supabase_test_shim/mu7x_gates_specified_test_only.sql', 'utf8');
  assert.equal(
    code(() =>
      buildBootstrapPlan(config(), root, (p) =>
        p === 'migrations/0026_v7_lifecycle_and_gates.sql' ? shim : 'select 1',
      ),
    ),
    'TEST_SHIM_REFUSED',
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
  assert.equal(guard({}, APPROVED, hash), 'APPLY_NOT_ENABLED');
  assert.equal(guard({ VERIFY_SUPABASE_ADMIN_APPLY: '1' }, 'other', hash), 'CONFIRM_PROJECT');
  assert.equal(guard({ VERIFY_SUPABASE_ADMIN_APPLY: '1' }, APPROVED, 'f'.repeat(64)), 'PLAN_HASH');
  assert.equal(guard({ VERIFY_SUPABASE_ADMIN_APPLY: '1' }, APPROVED, hash), null);
  // The apply guard re-validates the configuration against the approved list itself.
  const foreign = config({
    project: {
      environment: 'staging',
      stagingProjectRef: 'other-project-ref',
      productionProjectRef: null,
      projectUrl: 'https://other-project-ref.supabase.co',
    },
  });
  assert.equal(
    code(() =>
      assertApplyAuthorized({
        env: { VERIFY_SUPABASE_ADMIN_APPLY: '1' },
        confirmProject: 'other-project-ref',
        planHash: hash,
        config: foreign,
        repositoryRoot: root,
      }),
    ),
    'PROJECT_NOT_APPROVED',
  );
});

test('CLI parsing refuses --dry-run together with --apply, and output paths resolve symlinked parents', () => {
  assert.equal(
    code(() => parse(['accounts', '--dry-run', '--apply'])),
    'CONFLICTING_FLAGS',
  );
  assert.equal(
    code(() => parse(['accounts', '--dry-run'])),
    null,
  );
  const dir = mkdtempSync(join(tmpdir(), 'verify-credentials-'));
  try {
    // A directory that is a symlink into the repository must be refused by its real path.
    symlinkSync(root, join(dir, 'private'));
    assert.equal(
      code(() => privateOutputPath(join(dir, 'private', 'credentials.json'), root)),
      'CREDENTIALS_OUT',
    );
    mkdirSync(join(dir, 'ok'));
    assert.equal(
      code(() => privateOutputPath(join(dir, 'ok', 'credentials.json'), root)),
      null,
    );
    writeFileSync(join(dir, 'ok', 'credentials.json'), '{}');
    assert.equal(
      code(() => privateOutputPath(join(dir, 'ok', 'credentials.json'), root)),
      'CREDENTIALS_OUT',
      'never overwritten',
    );
    assert.equal(
      code(() => privateOutputPath('relative/credentials.json', root)),
      'CREDENTIALS_OUT',
    );
    assert.equal(
      code(() => privateOutputPath(join(dir, 'missing', 'credentials.json'), root)),
      'CREDENTIALS_OUT',
      'parent must exist',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('admin client: confirmed accounts with generated passwords, linked app rows, lock and reset', async () => {
  const c = config();
  const calls: { method: string; path: string; body: unknown; auth: string | null }[] = [];
  const openLocks: string[] = [];
  let linkedRows: unknown[] = [];
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
    else if (url.pathname === '/rest/v1/users' && options?.method === 'PATCH')
      body = [
        {
          user_id: '00000000-0000-4000-8000-000000000201',
          is_active: (JSON.parse(String(options.body)) as { is_active: boolean }).is_active,
        },
      ];
    else if (url.pathname === '/rest/v1/users' && options?.method === 'GET') body = linkedRows;
    else if (url.pathname === '/rest/v1/account_locks' && options?.method === 'POST') {
      openLocks.push('lock');
      body = [{ lock_id: '00000000-0000-4000-8000-000000000301' }];
    } else if (url.pathname === '/rest/v1/account_locks' && options?.method === 'PATCH') {
      openLocks.length = 0;
      body = [{ lock_id: '00000000-0000-4000-8000-000000000301' }];
    } else if (url.pathname === '/rest/v1/account_locks' && options?.method === 'GET')
      body = openLocks.map(() => ({ lock_id: '00000000-0000-4000-8000-000000000301' }));
    else if (url.pathname === '/rest/v1/users')
      body = [
        {
          user_id: '00000000-0000-4000-8000-000000000201',
          is_active: true,
          ...JSON.parse(String(options?.body))[0],
        },
      ];
    else if (url.pathname === '/rest/v1/app_schema_version') body = [{ version: 'x' }];
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  const client = adminClient(c, fetchMock as typeof fetch);
  assert.equal(
    await client.findAuthUserByEmail(`syn-reviewer-1@${APPROVED}.accounts.invalid`),
    null,
  );
  const password = generatePassword();
  assert.ok(password.length >= 32);
  const created = await client.createAuthUser(
    `syn-reviewer-1@${APPROVED}.accounts.invalid`,
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
    `syn-reviewer-1@${APPROVED}.accounts.invalid`,
    'Synthetic reviewer 1',
    'REVIEWER',
  );
  assert.equal(linked.userId, '00000000-0000-4000-8000-000000000201');
  const row = calls.find((x) => x.method === 'POST' && x.path.startsWith('/rest/v1/users'))!
    .body as {
    auth_uid: string;
    is_pilot_test_account: boolean;
  }[];
  assert.equal(row[0].auth_uid, created.id);
  assert.equal(row[0].is_pilot_test_account, false);
  await client.setPassword(created.id, 'another-generated-password-value');
  assert.equal(await client.findAppUserByAuthUid(created.id), null);
  await assert.rejects(client.setLocked(created.id, true), /No application row/);
  linkedRows = [
    {
      user_id: '00000000-0000-4000-8000-000000000201',
      email: 'x',
      role: 'REVIEWER',
      is_active: true,
    },
  ];
  const locked = await client.setLocked(created.id, true);
  assert.deepEqual(
    { locked: locked.locked, active: locked.isActive },
    { locked: true, active: true },
  );
  const puts = calls.filter((x) => x.method === 'PUT');
  assert.deepEqual(
    puts.map((x) => x.body),
    [{ password: 'another-generated-password-value' }, { ban_duration: '876000h' }],
  );
  // A lock records an account_locks row (reversible) and never PATCHes users.is_active.
  const lockPost = calls.find(
    (x) => x.method === 'POST' && x.path.startsWith('/rest/v1/account_locks'),
  )!;
  assert.equal(
    (lockPost.body as { user_id: string }[])[0].user_id,
    '00000000-0000-4000-8000-000000000201',
  );
  assert.ok(!calls.some((x) => x.method === 'PATCH' && x.path.startsWith('/rest/v1/users')));
  const unlocked = await client.setLocked(created.id, false);
  assert.equal(unlocked.locked, false);
  assert.deepEqual(calls.filter((x) => x.method === 'PUT').at(-1)!.body, { ban_duration: 'none' });
  assert.ok(
    calls.some(
      (x) =>
        x.method === 'PATCH' &&
        x.path.startsWith('/rest/v1/account_locks') &&
        x.path.includes('released_at=is.null'),
    ),
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
        APPROVED,
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
    const conflicting = spawnSync(
      process.execPath,
      ['scripts/supabase-admin.mjs', 'accounts', '--config', file, '--dry-run', '--apply'],
      { encoding: 'utf8' },
    );
    assert.equal(conflicting.status, 1);
    assert.match(conflicting.stderr, /CONFLICTING_FLAGS/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the operator documentation names the same bootstrap target as the plan', () => {
  const doc = readFileSync('docs/SUPABASE_IDENTITY.md', 'utf8');
  const last = (HOSTED_SCHEMA_FILES as string[])
    .filter((f) => /^migrations\/\d{4}_/.test(f))
    .at(-1)!;
  const number = last.slice('migrations/'.length, 'migrations/'.length + 4);
  assert.ok(
    doc.includes(`migrations 0002 to ${number}`),
    `docs must list migrations through ${number}`,
  );
  assert.ok(
    doc.includes(`\`${EXPECTED_SCHEMA_VERSION}\``),
    `docs must name ${EXPECTED_SCHEMA_VERSION}`,
  );
});
