import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { runStagingPreflight, validateProbeConfig } from '../scripts/supabase-staging-probes.mjs';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
function configuration() {
  return {
    project: {
      environment: 'staging',
      stagingProjectRef: 'synthetic-staging',
      productionProjectRef: 'synthetic-production',
      projectUrl: 'https://synthetic-staging.supabase.co',
    },
    publicAnonKey: 'sb_publishable_synthetic_public_key_only',
    accounts: ['INVESTIGATOR', 'INVESTIGATOR', 'REVIEWER', 'REVIEWER', 'ADJUDICATOR'].map(
      (role, index) => ({
        role,
        authUserId: id(index + 1),
        appUserId: id(index + 11),
        accessToken: `synthetic-existing-session-${index}`,
      }),
    ),
    fixtures: {
      predictionCaseId: 'HO4-TESTFX-STAGING1',
      reviewerAReviewId: id(21),
      reviewerBReviewId: id(22),
      auditId: '1',
      developmentCaseId: 'DEV4-TESTFX-STAGING1',
      calibrationCaseId: 'CAL4-TESTFX-STAGING1',
      pilotCaseId: 'SYN-STAGING1',
      mappingCaseId: 'MC-SYN-STAGING1',
    },
  };
}
type Config = ReturnType<typeof configuration>;
type Override = (path: string, account: number, body: unknown) => Response | undefined;
function mockGateway(config: Config, override?: Override) {
  const requests: { url: string; options: RequestInit }[] = [];
  const fetchMock = async (input: string | URL | Request, options?: RequestInit) => {
    const url = new URL(String(input));
    assert.equal(url.origin, config.project.projectUrl);
    assert.equal(options?.method, 'GET');
    assert.equal(options?.redirect, 'error');
    assert.equal(options?.cache, 'no-store');
    assert.equal(options?.body, undefined);
    const headers = new Headers(options?.headers);
    assert.equal(headers.get('apikey'), config.publicAnonKey);
    const account = config.accounts.findIndex(
      (entry) => headers.get('Authorization') === `Bearer ${entry.accessToken}`,
    );
    assert.notEqual(account, -1);
    requests.push({ url: url.href, options: options! });
    let body: unknown = [];
    if (url.pathname === '/auth/v1/user') body = { id: config.accounts[account].authUserId };
    else if (url.pathname === '/rest/v1/rpc/rpc_whoami')
      body = [
        {
          user_id: config.accounts[account].appUserId,
          role: config.accounts[account].role,
          is_pilot_test_account: false,
          reviewer_pseudo_id: account === 2 || account === 3 ? `SYN-REVIEWER-${account}` : null,
          investigator_session_ok: account < 2,
        },
      ];
    else if (url.pathname === '/rest/v1/reviews') {
      const wanted = url.searchParams.get('review_id');
      if (
        (account === 2 && wanted === `eq.${id(21)}`) ||
        (account === 3 && wanted === `eq.${id(22)}`)
      )
        body = [
          {
            review_id: account === 2 ? id(21) : id(22),
            case_id: 'HO4-TESTFX-STAGING1',
            reviewer_pseudo_id: `SYN-REVIEWER-${account}`,
          },
        ];
    } else if (account < 2) {
      const byTable: Record<string, unknown> = {
        frozen_predictions_v4: [{ case_id: config.fixtures.predictionCaseId }],
        audit_log: [{ audit_id: 1, entity_id: config.fixtures.pilotCaseId }],
        development_registry_v4: [{ dev_case_id: config.fixtures.developmentCaseId }],
        calibration_cases_v4: [{ cal_case_id: config.fixtures.calibrationCaseId }],
        cases: [{ case_id: config.fixtures.pilotCaseId, mode: 'PILOT' }],
        mc_cases: [{ case_id: config.fixtures.mappingCaseId, record_category: 'SYNTHETIC_PILOT' }],
      };
      body = byTable[url.pathname.split('/').at(-1)!];
      assert.notEqual(body, undefined);
    }
    return override?.(url.pathname, account, body) ?? Response.json(body);
  };
  return { requests, fetchMock };
}

test('preflight verifies five real-session endpoints and positive-control-backed limited reads without mutation or sensitive output', async () => {
  const config = configuration();
  const gateway = mockGateway(config);
  const report = await runStagingPreflight(config, gateway.fetchMock);
  assert.equal(report.status, 'PREFLIGHT_PASS');
  assert.equal(report.fullSupabaseAcceptance, 'UNTESTED');
  assert.equal(report.mutationsPerformed, false);
  assert.equal(report.accountsCreated, 0);
  assert.equal(report.invitationsSent, 0);
  assert.equal(report.checks.length, 8);
  assert.ok(report.checks.every((check: { status: string }) => check.status === 'PASS'));
  assert.equal(
    gateway.requests.filter((request) => new URL(request.url).pathname === '/auth/v1/user').length,
    5,
  );
  assert.ok(
    gateway.requests.every(
      (request) => !/[?&]select=(?:\*|.*rationale|.*tier[01]_)/.test(request.url),
    ),
  );
  const output = JSON.stringify(report);
  for (const account of config.accounts)
    for (const secret of [account.authUserId, account.appUserId, account.accessToken])
      assert.equal(output.includes(secret), false);
  for (const secret of [
    config.project.projectUrl,
    config.publicAnonKey,
    ...Object.values(config.fixtures),
  ])
    assert.equal(output.includes(`"${secret}"`), false);
});

test('missing fixture identifiers and empty positive controls remain UNTESTED, never evidence of RLS denial', async () => {
  const config = configuration();
  const gateway = mockGateway(config);
  const missing = await runStagingPreflight({ ...config, fixtures: {} }, gateway.fetchMock);
  assert.equal(missing.status, 'BLOCKED');
  assert.equal(gateway.requests.length, 10);
  assert.equal(missing.checks[0].status, 'PASS');
  assert.ok(
    missing.checks.slice(1).every((check: { status: string }) => check.status === 'UNTESTED'),
  );
  const empty = mockGateway(config, (path) =>
    path.startsWith('/rest/v1/') && !path.includes('/rpc/') ? Response.json([]) : undefined,
  );
  const absent = await runStagingPreflight(config, empty.fetchMock);
  assert.equal(absent.status, 'BLOCKED');
  assert.ok(
    absent.checks.slice(1).every((check: { status: string }) => check.status === 'UNTESTED'),
  );
});

test('cross-review, prediction, audit, excluded-record and mapping leaks fail with sanitized output', async () => {
  for (const path of [
    'reviews',
    'frozen_predictions_v4',
    'audit_log',
    'development_registry_v4',
    'calibration_cases_v4',
    'cases',
    'mc_cases',
    'mc_responses',
  ]) {
    const config = configuration();
    // Mapping tables are probed against the adjudicator (account 4), the others against reviewer A.
    const leaking = path.startsWith('mc_') ? 4 : 2;
    const gateway = mockGateway(config, (endpoint, account, body) =>
      endpoint === `/rest/v1/${path}` &&
      account === leaking &&
      Array.isArray(body) &&
      body.length === 0
        ? Response.json([{ privatePayload: 'synthetic-secret-must-not-print' }])
        : undefined,
    );
    const report = await runStagingPreflight(config, gateway.fetchMock);
    assert.equal(report.status, 'FAIL', path);
    assert.equal(JSON.stringify(report).includes('synthetic-secret-must-not-print'), false);
  }
});

test('an expired token is failure, while explicit permission denial is acceptable only after positive controls', async () => {
  const config = configuration();
  for (const status of [401, 403, 404, 500]) {
    const gateway = mockGateway(config, (path, account) =>
      path === '/rest/v1/frozen_predictions_v4' && account >= 2
        ? new Response('private upstream error', { status })
        : undefined,
    );
    const report = await runStagingPreflight(config, gateway.fetchMock);
    assert.equal(report.status, status === 403 ? 'PREFLIGHT_PASS' : 'FAIL');
    assert.equal(JSON.stringify(report).includes('private upstream error'), false);
  }
});

test('remote identity, role, nonpilot status and investigator MFA-derived authorization must match', async () => {
  const config = configuration();
  for (const patch of [
    { user_id: id(99) },
    { role: 'REVIEWER' },
    { is_pilot_test_account: true },
    { investigator_session_ok: false },
  ]) {
    const gateway = mockGateway(config, (path, account, body) =>
      path.endsWith('/rpc_whoami') && account === 0
        ? Response.json([{ ...(body as object[])[0], ...patch }])
        : undefined,
    );
    const report = await runStagingPreflight(config, gateway.fetchMock);
    assert.equal(report.status, 'FAIL');
    assert.equal(gateway.requests.length, 2);
  }
  const wrongAuth = mockGateway(config, (path) =>
    path === '/auth/v1/user' ? Response.json({ id: id(99) }) : undefined,
  );
  assert.equal((await runStagingPreflight(config, wrongAuth.fetchMock)).status, 'FAIL');
  assert.equal(wrongAuth.requests.length, 1);
});

test('configuration rejects privileged keys, duplicated identities, paths and unreviewed fixture names before networking', async () => {
  const config = configuration();
  const serviceJwt = `synthetic.${Buffer.from(JSON.stringify({ role: 'service_role' })).toString('base64url')}.synthetic`;
  const invalid = [
    { ...config, publicAnonKey: serviceJwt },
    { ...config, publicAnonKey: 'sb_secret_synthetic_sensitive' },
    { ...config, serviceRoleKey: 'synthetic-sensitive' },
    { ...config, accounts: [config.accounts[0], config.accounts[0], ...config.accounts.slice(2)] },
    { ...config, fixtures: { ...config.fixtures, predictionCaseId: 'unexpected-private-case' } },
    ...[
      'http://synthetic-staging.supabase.co',
      `${config.project.projectUrl}/`,
      `${config.project.projectUrl}.attacker.invalid`,
      `${config.project.projectUrl}:443`,
      `${config.project.projectUrl}?x=1`,
    ].map((projectUrl) => ({ ...config, project: { ...config.project, projectUrl } })),
  ];
  for (const input of invalid) {
    assert.throws(() => validateProbeConfig(input));
    let called = false;
    const report = await runStagingPreflight(input, async () => {
      called = true;
      throw new Error('must not call');
    });
    assert.equal(called, false);
    assert.equal(report.status, 'BLOCKED');
    assert.equal(report.reason, 'INVALID_PRIVATE_STAGING_CONFIG');
  }
});

test('redirects, off-origin responses and network exceptions do not forward authorization or leak content', async () => {
  const config = configuration();
  for (const type of ['redirect', 'followed', 'off-origin', 'throw']) {
    let calls = 0;
    const report = await runStagingPreflight(config, async (_url, options) => {
      calls++;
      assert.equal(options?.redirect, 'error');
      if (type === 'throw')
        throw new Error(
          `private endpoint ${config.project.projectUrl} token ${config.accounts[0].accessToken}`,
        );
      if (type === 'redirect')
        return new Response(null, {
          status: 302,
          headers: { Location: 'https://attacker.invalid' },
        });
      const response = Response.json({ id: config.accounts[0].authUserId });
      Object.defineProperty(response, type === 'followed' ? 'redirected' : 'url', {
        value: type === 'followed' ? true : 'https://attacker.invalid/auth/v1/user',
      });
      return response;
    });
    assert.equal(calls, 1);
    assert.equal(report.status, 'FAIL');
    assert.equal(JSON.stringify(report).includes(config.accounts[0].accessToken), false);
    assert.equal(JSON.stringify(report).includes(config.project.projectUrl), false);
  }
});

test('CLI reports missing staging as BLOCKED and fails closed when required, without making requests', () => {
  for (const requireStaging of ['0', '1']) {
    const result = spawnSync(process.execPath, ['scripts/test-supabase-staging.mjs'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        VERIFY_SUPABASE_STAGING_CONFIG: '',
        VERIFY_SUPABASE_REQUIRE: requireStaging,
      },
    });
    assert.equal(result.status, requireStaging === '1' ? 1 : 0);
    const report = JSON.parse(result.stdout);
    assert.equal(report.status, 'BLOCKED');
    assert.equal(report.fullSupabaseAcceptance, 'UNTESTED');
    assert.equal(result.stderr, '');
  }
  const result = spawnSync(
    process.execPath,
    ['scripts/test-supabase-staging.mjs', '--config', '/synthetic-private-missing.json'],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 1);
  assert.equal(result.stdout.includes('/synthetic-private-missing.json'), false);
  assert.equal(JSON.parse(result.stdout).reason, 'PRIVATE_STAGING_CONFIG_REFUSED');
});
