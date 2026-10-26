// Supabase deployment mode, exercised locally against a fake Auth (GoTrue) and PostgREST gateway:
// username sign-in with HttpOnly cookie sessions, token verification and refresh, logout, TOTP
// enrolment and verification, the publishable-key-only rule, and the mapping-confirmation routes
// under the caller's token. No request leaves the process; nothing here is a real Supabase test.
import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import { validateWebConfig } from '../scripts/supabase-web.mjs';
import { APPROVED_STAGING_PROJECT_REFS } from '../scripts/supabase-identity-tools.mjs';
import { assertPublishableKey, supabaseWebConfig } from '../src/lib/supabase-config';
import { toExportTimestamp } from '../src/lib/postgrest';
import {
  ACCESS_COOKIE,
  LEGACY_REFRESH_COOKIE,
  REFRESH_COOKIE,
  SupabaseAuth,
  internalEmail,
  readSessionCookies,
  sessionCookieHeaders,
  svgMarkupFromDataUri,
} from '../src/lib/supabase-auth';

const REF = 'abcdefghijklmnopqrst';
const URL_ = `https://${REF}.supabase.co`;
const PUB = 'sb_publishable_synthetic_key_000000';
const jwt = (claims: Record<string, unknown>) =>
  `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;

/** Minimal GoTrue + PostgREST fake with a few synthetic accounts and mapping rows. */
function gateway() {
  const failures = new Map<string, number>();
  const users: Record<
    string,
    {
      id: string;
      password: string;
      role: string;
      factors: { id: string; status: string; friendly_name: string }[];
      locked?: boolean;
    }
  > = {
    [internalEmail('syn-reviewer-1', REF)]: {
      id: '00000000-0000-4000-8000-000000000101',
      password: 'pw-reviewer-1-synthetic',
      role: 'REVIEWER',
      factors: [],
    },
    [internalEmail('syn-investigator-1', REF)]: {
      id: '00000000-0000-4000-8000-000000000102',
      password: 'pw-investigator-synthetic',
      role: 'INVESTIGATOR',
      factors: [],
    },
  };
  const tokens = new Map<
    string,
    { sub: string; aal: 'aal1' | 'aal2'; exp: number; sessionId: string }
  >();
  const refreshes = new Map<string, { sub: string; aal: 'aal1' | 'aal2'; sessionId: string }>();
  const log: {
    method: string;
    path: string;
    auth: string | null;
    apikey: string | null;
    body: unknown;
  }[] = [];
  let counter = 0;
  const issue = (sub: string, aal: 'aal1' | 'aal2', ttl = 3600, priorSessionId?: string) => {
    ++counter;
    const exp = Math.floor(Date.now() / 1000) + ttl;
    const sessionId = priorSessionId ?? `s-${counter}`;
    const access = jwt({
      sub,
      aal,
      exp,
      session_id: sessionId,
      nonce: counter,
      role: 'authenticated',
    });
    const refresh = `refresh-token-${counter}-synthetic-value`;
    tokens.set(access, { sub, aal, exp, sessionId });
    refreshes.set(refresh, { sub, aal, sessionId });
    return { access_token: access, refresh_token: refresh, expires_in: ttl, user: { id: sub } };
  };
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    const auth = headers.get('Authorization');
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    log.push({
      method: init?.method ?? 'GET',
      path: url.pathname + url.search,
      auth,
      apikey: headers.get('apikey'),
      body,
    });
    if (headers.get('apikey') !== PUB)
      return new Response(JSON.stringify({ message: 'bad apikey' }), { status: 401 });
    const bearer = auth?.replace(/^Bearer /, '');
    const session = bearer ? tokens.get(bearer) : undefined;
    const respond = (status: number, data: unknown) =>
      new Response(JSON.stringify(data), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });
    const failure = failures.get(url.pathname + url.search);
    if (failure) return respond(failure, { message: 'Synthetic service failure' });
    if (url.pathname === '/auth/v1/token' && url.searchParams.get('grant_type') === 'password') {
      const u = users[body.email];
      if (!u || u.password !== body.password)
        return respond(400, {
          error: 'invalid_grant',
          error_description: 'Invalid login credentials',
        });
      return respond(200, issue(u.id, 'aal1'));
    }
    if (
      url.pathname === '/auth/v1/token' &&
      url.searchParams.get('grant_type') === 'refresh_token'
    ) {
      const prior = refreshes.get(body.refresh_token);
      if (!prior) return respond(400, { error: 'invalid_grant' });
      refreshes.delete(body.refresh_token);
      return respond(200, issue(prior.sub, prior.aal, 3600, prior.sessionId));
    }
    if (url.pathname === '/auth/v1/user') {
      if (!session || session.exp < Date.now() / 1000)
        return respond(401, { message: 'invalid JWT' });
      const u = Object.values(users).find((x) => x.id === session.sub)!;
      return respond(200, {
        id: u.id,
        email: Object.keys(users).find((k) => users[k] === u),
        factors: u.factors,
      });
    }
    if (url.pathname === '/auth/v1/logout') {
      if (!session || session.exp < Date.now() / 1000) return respond(401, {});
      // Revocation assertions use refresh tokens. The fake also removes access tokens for its
      // route checks; real Supabase access JWTs may remain valid until their expiry.
      if (session) {
        const matches = (v: { sub: string; sessionId: string }) =>
          v.sub === session.sub &&
          (url.searchParams.get('scope') === 'global' || v.sessionId === session.sessionId);
        for (const [t, v] of tokens) if (matches(v)) tokens.delete(t);
        for (const [r, v] of refreshes) if (matches(v)) refreshes.delete(r);
      }
      return new Response(null, { status: 204 });
    }
    const unenroll = /^\/auth\/v1\/factors\/([^/]+)$/.exec(url.pathname);
    if (unenroll && init?.method === 'DELETE') {
      if (!session) return respond(401, {});
      const u = Object.values(users).find((x) => x.id === session.sub)!;
      u.factors = u.factors.filter((f) => f.id !== unenroll[1]);
      return respond(200, { id: unenroll[1] });
    }
    if (url.pathname === '/auth/v1/factors' && init?.method === 'POST') {
      if (!session) return respond(401, {});
      const u = Object.values(users).find((x) => x.id === session.sub)!;
      if (u.factors.some((f) => f.status === 'unverified'))
        return respond(422, { message: 'An unverified factor already exists' });
      const factor = {
        id: '00000000-0000-4000-8000-0000000000f1',
        status: 'unverified',
        friendly_name: body.friendly_name,
      };
      u.factors.push(factor);
      return respond(200, {
        id: factor.id,
        type: 'totp',
        totp: {
          // Same shape as the real Auth payload (SVGo): XML declaration, comment, then the element.
          qr_code:
            '<?xml version="1.0"?>\n<!-- Generated by SVGo -->\n<svg width="243" height="243" xmlns="http://www.w3.org/2000/svg"><rect x="0" y="0" width="243" height="243" style="fill:white" /></svg>\n',
          secret: 'SYNTHETICSECRET',
          uri: 'otpauth://totp/x',
        },
      });
    }
    const challenge = /^\/auth\/v1\/factors\/([^/]+)\/challenge$/.exec(url.pathname);
    if (challenge)
      return session
        ? respond(200, { id: '00000000-0000-4000-8000-0000000000c1', expires_at: 0 })
        : respond(401, {});
    const verify = /^\/auth\/v1\/factors\/([^/]+)\/verify$/.exec(url.pathname);
    if (verify) {
      if (!session) return respond(401, {});
      if (body.code !== '123456') return respond(422, { message: 'Invalid TOTP code' });
      const u = Object.values(users).find((x) => x.id === session.sub)!;
      for (const f of u.factors) if (f.id === verify[1]) f.status = 'verified';
      return respond(200, issue(u.id, 'aal2'));
    }
    if (url.pathname.startsWith('/rest/v1/')) {
      if (!session) return respond(401, { message: 'JWT expired' });
      const u = Object.values(users).find((x) => x.id === session.sub)!;
      if (url.pathname === '/rest/v1/rpc/rpc_whoami')
        return respond(
          200,
          u.locked
            ? []
            : [
                {
                  user_id: u.id.replace('0001', '0002'),
                  role: u.role,
                  is_pilot_test_account: false,
                },
              ],
        );
      if (url.pathname === '/rest/v1/users')
        return respond(200, [{ display_name: `Synthetic ${u.role.toLowerCase()}` }]);
      if (url.pathname === '/rest/v1/mc_campaign') return respond(200, []);
      if (url.pathname === '/rest/v1/v_mc_my_queue') return respond(200, []);
      if (url.pathname === '/rest/v1/mc_cases') return respond(200, []);
      if (url.pathname === '/rest/v1/rpc/rpc_mc_create_campaign') {
        if (u.role !== 'INVESTIGATOR' || session.aal !== 'aal2')
          return respond(403, {
            code: '42501',
            message:
              'investigator role (with multi-factor session when required) is needed for this action',
          });
        return respond(200, true);
      }
      // Any other relation or RPC the investigator console reads is empty in this fake.
      return respond(200, []);
    }
    return respond(404, {});
  }) as unknown as typeof fetch;
  return { fetchImpl, log, users, tokens, refreshes, failures, issue };
}

const env = {
  VERIFY_DATA_BACKEND: 'supabase',
  VERIFY_SUPABASE_URL: URL_,
  VERIFY_SUPABASE_PUBLISHABLE_KEY: PUB,
  VERIFY_SUPABASE_ACCOUNT_DOMAIN_REF: REF,
  VERIFY_SITE_ORIGIN: 'http://127.0.0.1:3300',
};

test('web configuration accepts only the publishable (or legacy anon) key and a project origin', () => {
  assert.equal(supabaseWebConfig(env).projectRef, REF);
  assert.throws(
    () => assertPublishableKey('sb_secret_abcdefghijklmnopqrstuvwxyz'),
    /secret key must never/,
  );
  assert.throws(
    () => assertPublishableKey(jwt({ role: 'service_role' })),
    /privileged key is refused/,
  );
  assert.equal(assertPublishableKey(jwt({ role: 'anon' })), jwt({ role: 'anon' }));
  assert.throws(
    () => supabaseWebConfig({ ...env, VERIFY_SUPABASE_URL: 'http://evil.invalid' }),
    /VERIFY_SUPABASE_URL/,
  );
  assert.throws(
    () => supabaseWebConfig({ ...env, VERIFY_SITE_ORIGIN: 'https://x.y/path' }),
    /VERIFY_SITE_ORIGIN/,
  );
});

test('hosted origins require HTTPS and the launcher independently limits its staging project', () => {
  const approved = APPROVED_STAGING_PROJECT_REFS[0];
  const config = {
    project: {
      environment: 'staging',
      stagingProjectRef: approved,
      projectUrl: `https://${approved}.supabase.co`,
    },
    publishableKey: PUB,
    accountDomainRef: approved,
    siteOrigin: 'https://synthetic.invalid',
  };
  assert.deepEqual(validateWebConfig(config), []);
  assert.ok(
    validateWebConfig({
      ...config,
      project: { ...config.project, stagingProjectRef: REF, projectUrl: URL_ },
    }).length > 0,
    'calling an arbitrary project staging is not approval to use it',
  );
  for (const siteOrigin of [
    'http://synthetic.invalid',
    'http://localhost.synthetic.invalid',
    'http://192.168.1.5:3300',
    'ftp://synthetic.invalid',
  ]) {
    assert.throws(() => supabaseWebConfig({ ...env, VERIFY_SITE_ORIGIN: siteOrigin }));
    assert.ok(validateWebConfig({ ...config, siteOrigin }).length > 0, siteOrigin);
  }
  for (const siteOrigin of [
    'http://localhost:3300',
    'http://127.0.0.1:3300',
    'http://[::1]:3300',
    'https://synthetic.invalid',
  ]) {
    assert.equal(
      supabaseWebConfig({ ...env, VERIFY_SITE_ORIGIN: siteOrigin }).siteOrigin,
      siteOrigin,
    );
    assert.deepEqual(validateWebConfig({ ...config, siteOrigin }), []);
  }
});

test('timestamps from PostgREST are normalised to the export contract', () => {
  assert.equal(
    toExportTimestamp('2026-10-22T19:52:03.123456+00:00'),
    '2026-10-22T19:52:03.123456Z',
  );
  assert.equal(toExportTimestamp('2026-10-22T19:52:03+00:00'), '2026-10-22T19:52:03.000000Z');
  assert.equal(toExportTimestamp(null), null);
});

test('sign-in maps the username to the internal address, verifies tokens with Auth, refreshes and signs out', async () => {
  const g = gateway();
  const auth = new SupabaseAuth(supabaseWebConfig(env), g.fetchImpl);
  await assert.rejects(
    auth.signIn('Syn-Reviewer-1', 'wrong'),
    /Account or password was not accepted/,
  );
  await assert.rejects(
    auth.signIn('not a username', 'pw-reviewer-1-synthetic'),
    /Account or password was not accepted/,
  );
  const session = await auth.signIn('syn-reviewer-1', 'pw-reviewer-1-synthetic');
  const signIn = g.log.find((l) => l.path.startsWith('/auth/v1/token?grant_type=password'))!;
  assert.equal((signIn.body as { email: string }).email, `syn-reviewer-1@${REF}.accounts.invalid`);
  assert.equal(signIn.apikey, PUB);
  const user = await auth.verify(session.accessToken);
  assert.equal(user.aal, 'aal1');
  assert.equal(user.verifiedFactors.length, 0);
  const calls = g.log.filter((l) => l.path === '/auth/v1/user').length;
  await auth.verify(session.accessToken);
  assert.equal(
    g.log.filter((l) => l.path === '/auth/v1/user').length,
    calls,
    'verification is cached briefly',
  );
  const refreshed = await auth.refresh(session.refreshToken);
  assert.notEqual(refreshed.accessToken, session.accessToken);
  await assert.rejects(
    auth.refresh(session.refreshToken),
    /Sign in to continue/,
    'a refresh token is single-use',
  );
  await auth.signOut(refreshed.accessToken);
  await assert.rejects(auth.verify(refreshed.accessToken), /Sign in to continue/);
  // Cookies: HttpOnly, path-scoped refresh token, Secure only on https origins.
  const cookies = sessionCookieHeaders(session, false);
  assert.match(
    cookies[0],
    new RegExp(`^${ACCESS_COOKIE}=.*HttpOnly; Path=/; SameSite=Lax; Max-Age=`),
  );
  assert.match(
    cookies[1],
    new RegExp(`^${REFRESH_COOKIE}=.*HttpOnly; Path=/api; SameSite=Strict; Max-Age=`),
  );
  assert.ok(!cookies[0].includes('Secure'));
  assert.ok(sessionCookieHeaders(session, true)[0].includes('; Secure'));
  const parsed = readSessionCookies(
    new Request('http://x/', {
      headers: { cookie: cookies.map((c) => c.split(';')[0]).join('; ') },
    }),
  );
  assert.equal(parsed.access, session.accessToken);
  assert.equal(parsed.refresh, session.refreshToken);
});

test('TOTP enrolment and verification raise the session to aal2 through Auth', async () => {
  const g = gateway();
  const auth = new SupabaseAuth(supabaseWebConfig(env), g.fetchImpl);
  const session = await auth.signIn('syn-investigator-1', 'pw-investigator-synthetic');
  const enrolment = await auth.enrollTotp(session.accessToken, 'Synthetic investigator');
  assert.equal(enrolment.secret, 'SYNTHETICSECRET');
  assert.match(
    enrolment.qrCode,
    /^data:image\/svg\+xml;charset=utf-8,%3C%3Fxml/,
    'QR payload percent-encoded for an image source',
  );
  assert.ok(enrolment.qrSvg, 'inline SVG markup is extracted from the SVGo payload');
  assert.match(enrolment.qrSvg ?? '', /^<svg[\s>]/, 'XML declaration and comment stripped');
  assert.match(enrolment.qrSvg ?? '', /<\/svg>$/);
  assert.doesNotMatch(enrolment.qrSvg ?? '', /<\?xml|<!--/);
  assert.match(
    enrolment.qrSvg ?? '',
    /^<svg viewBox="0 0 243 243" width="243"/,
    'viewBox derived from width/height so the QR scales to its container',
  );
  assert.equal(
    svgMarkupFromDataUri('<svg viewBox="0 0 1 1" width="9" height="9"></svg>'),
    '<svg viewBox="0 0 1 1" width="9" height="9"></svg>',
    'an existing viewBox is left alone',
  );
  assert.equal(
    svgMarkupFromDataUri('data:image/svg+xml;utf-8,%3Csvg%3E%3C/svg%3E'),
    '<svg></svg>',
    'data-URI form still accepted',
  );
  for (const bad of [
    'data:image/svg+xml;utf-8,<svg onload="x()"></svg>',
    'data:image/svg+xml;utf-8,<svg><script>1</script></svg>',
    'data:image/svg+xml;utf-8,<!DOCTYPE svg [<!ENTITY x "y">]><svg>&x;</svg>',
    'data:image/svg+xml;utf-8,<svg><a href="https://example.invalid">x</a></svg>',
    'data:image/png;base64,AAAA',
    'not markup at all',
  ]) {
    assert.equal(svgMarkupFromDataUri(bad), null, `rejected: ${bad.slice(0, 40)}`);
  }
  // An abandoned enrolment (unverified factor) is discarded automatically and a fresh QR issued.
  const again = await auth.enrollTotp(session.accessToken, 'Synthetic investigator');
  assert.equal(again.secret, 'SYNTHETICSECRET');
  assert.equal(
    (await auth.verify(session.accessToken)).unverifiedFactors.length,
    1,
    'only one pending factor remains',
  );
  await assert.rejects(
    auth.verifyTotp(session.accessToken, enrolment.factorId, '000000'),
    /code was not accepted/,
  );
  await assert.rejects(auth.verifyTotp(session.accessToken, enrolment.factorId, '12'), /six-digit/);
  const upgraded = await auth.verifyTotp(session.accessToken, enrolment.factorId, '123456');
  const verified = await auth.verify(upgraded.accessToken);
  assert.equal(verified.aal, 'aal2');
  assert.equal(verified.verifiedFactors.length, 1);
});

test('local sign-out preserves other sessions and simultaneous refresh calls share one exchange', async () => {
  const fake = gateway();
  const auth = new SupabaseAuth(supabaseWebConfig(env), fake.fetchImpl);
  const first = await auth.signIn('syn-reviewer-1', 'pw-reviewer-1-synthetic');
  const second = await auth.signIn('syn-reviewer-1', 'pw-reviewer-1-synthetic');
  await auth.signOut(first.accessToken, 'local');
  assert.equal(fake.refreshes.has(first.refreshToken), false);
  assert.equal(fake.refreshes.has(second.refreshToken), true);
  const refreshed = await Promise.all([
    auth.refresh(second.refreshToken),
    auth.refresh(second.refreshToken),
  ]);
  assert.deepEqual(refreshed[0], refreshed[1]);
  assert.equal(
    fake.log.filter((l) => l.path === '/auth/v1/token?grant_type=refresh_token').length,
    1,
  );
});

test('Auth outages are retryable and never expose upstream network details', async () => {
  const auth = new SupabaseAuth(supabaseWebConfig(env), (async () => {
    throw new Error('Synthetic internal network detail that must not reach a browser');
  }) as typeof fetch);
  for (const action of [
    () => auth.verify('synthetic-access-token'),
    () => auth.refresh('synthetic-refresh-token'),
    () => auth.signOut('synthetic-access-token'),
  ]) {
    await assert.rejects(action(), (error: unknown) => {
      const e = error as { status: number; message: string };
      assert.equal(e.status, 502);
      assert.doesNotMatch(e.message, /internal network detail/);
      return true;
    });
  }
});

// ---- route handler in Supabase mode --------------------------------------------------------------
const saved: Record<string, string | undefined> = {};
let g: ReturnType<typeof gateway>;
let realFetch: typeof fetch;
before(() => {
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  g = gateway();
  realFetch = globalThis.fetch;
  globalThis.fetch = g.fetchImpl;
});
after(() => {
  for (const [k, v] of Object.entries(saved))
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  globalThis.fetch = realFetch;
});
const origin = 'http://127.0.0.1:3300';
const req = (path: string, init: RequestInit & { cookie?: string } = {}) =>
  new Request(`${origin}${path}`, {
    ...init,
    headers: {
      host: '127.0.0.1:3300',
      origin,
      'content-type': 'application/json',
      ...(init.cookie ? { cookie: init.cookie } : {}),
      ...(init.headers as Record<string, string> | undefined),
    },
  });
const cookieJar = (response: Response) =>
  response.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .filter((c) => !c.endsWith('='))
    .join('; ');

test('prepared sample routes deny other roles, read-only investigators and missing MFA before loading a file', async () => {
  const { GET, POST } = await import('../src/app/api/[...path]/route');
  const user = g.users[internalEmail('syn-reviewer-1', REF)];
  const original = user.role;
  const path = '/api/mu7/admin/intake';
  const start = g.log.length;
  try {
    for (const role of ['REVIEWER', 'ADJUDICATOR', 'PRACTICE_OBSERVER', 'INVESTIGATOR']) {
      user.role = role;
      const token = g.issue(user.id, 'aal1');
      const cookie = `${ACCESS_COOKIE}=${token.access_token}`;
      assert.equal((await GET(req(path, { cookie }))).status, 403, role);
      assert.equal(
        (await POST(req(path, { cookie, method: 'POST', body: '{}' }))).status,
        403,
        role,
      );
    }
    const token = g.issue(user.id, 'aal2');
    assert.equal(
      (
        await POST(
          req(path, {
            cookie: `${ACCESS_COOKIE}=${token.access_token}`,
            method: 'POST',
            body: '{}',
            headers: { origin: 'https://invalid.example' },
          }),
        )
      ).status,
      403,
    );
    assert.equal((await GET(req(path))).status, 401);
    assert.equal(
      g.log.slice(start).some((x) => /rpc_mu81_(stage_sample|intake_status)/.test(x.path)),
      false,
    );
  } finally {
    user.role = original;
  }
});

test('routes in Supabase mode: sign-in sets cookies, session reports role and aal, investigator actions need aal2, local routes are not served', async () => {
  const { POST, GET, DELETE } = await import('../src/app/api/[...path]/route');
  const bad = await POST(
    req('/api/session', {
      method: 'POST',
      body: JSON.stringify({ username: 'syn-reviewer-1', password: 'nope' }),
    }),
  );
  assert.equal(bad.status, 401);
  const signIn = await POST(
    req('/api/session', {
      method: 'POST',
      body: JSON.stringify({
        username: 'syn-investigator-1',
        password: 'pw-investigator-synthetic',
      }),
    }),
  );
  const body = (await signIn.json()) as {
    user: { role: string; aal: string; accessToken?: string };
    environment: string;
  };
  assert.equal(body.environment, 'supabase-staging');
  assert.equal(body.user.role, 'INVESTIGATOR');
  assert.equal(body.user.aal, 'aal1');
  assert.equal('accessToken' in body.user, false, 'the token never reaches the browser body');
  const cookies = cookieJar(signIn);
  assert.ok(cookies.includes(ACCESS_COOKIE) && cookies.includes(REFRESH_COOKIE));
  // Investigator action before the second factor is refused; the local pilot routes are not served.
  const create = await POST(
    req('/api/mc/admin/action', {
      method: 'POST',
      cookie: cookies,
      body: JSON.stringify({ action: 'create-campaign' }),
    }),
  );
  assert.equal(create.status, 403);
  assert.match(((await create.json()) as { error: string }).error, /second factor/);
  assert.equal((await GET(req('/api/workspace', { cookie: cookies }))).status, 503);
  assert.equal((await GET(req('/api/tlv5/workspace', { cookie: cookies }))).status, 503);
  // Wrong origin on a mutation is refused.
  assert.equal(
    (
      await POST(
        req('/api/mfa/enroll', {
          method: 'POST',
          cookie: cookies,
          body: '{}',
          headers: { origin: 'http://evil.invalid' },
        }),
      )
    ).status,
    403,
  );
  // Enrol and verify the second factor; the session now carries aal2 and the action proceeds.
  const enrol = await POST(req('/api/mfa/enroll', { method: 'POST', cookie: cookies, body: '{}' }));
  assert.equal(enrol.status, 200);
  const { factorId } = (await enrol.json()) as { factorId: string };
  const verify = await POST(
    req('/api/mfa/verify', {
      method: 'POST',
      cookie: cookies,
      body: JSON.stringify({ factorId, code: '123456' }),
    }),
  );
  assert.equal(verify.status, 200);
  const aal2Cookies = cookieJar(verify);
  const session = await GET(req('/api/session', { cookie: aal2Cookies }));
  assert.equal(((await session.json()) as { user: { aal: string } }).user.aal, 'aal2');
  const created = await POST(
    req('/api/mc/admin/action', {
      method: 'POST',
      cookie: aal2Cookies,
      body: JSON.stringify({ action: 'create-campaign' }),
    }),
  );
  assert.equal(created.status, 200, JSON.stringify(await created.json()));
  // Signing in again later lands at aal1 with the factor enrolled; the investigator supplies only
  // the current code and the server finds their verified authenticator (no factor id to type).
  const again = await POST(
    req('/api/session', {
      method: 'POST',
      body: JSON.stringify({
        username: 'syn-investigator-1',
        password: 'pw-investigator-synthetic',
      }),
    }),
  );
  const againBody = (await again.json()) as { user: { aal: string; mfaEnrolled: boolean } };
  assert.equal(againBody.user.aal, 'aal1');
  assert.equal(againBody.user.mfaEnrolled, true);
  const againCookies = cookieJar(again);
  const reverify = await POST(
    req('/api/mfa/verify', {
      method: 'POST',
      cookie: againCookies,
      body: JSON.stringify({ code: '123456' }),
    }),
  );
  assert.equal(reverify.status, 200, JSON.stringify(await reverify.clone().json()));
  assert.equal(
    ((await reverify.json()) as { user: { aal: string } }).user.aal,
    'aal2',
    'code-only verification upgrades the enrolled session',
  );
  // Without any enrolled authenticator, a code-only request is refused with guidance.
  const reviewer = await POST(
    req('/api/session', {
      method: 'POST',
      body: JSON.stringify({ username: 'syn-reviewer-1', password: 'pw-reviewer-1-synthetic' }),
    }),
  );
  const noFactor = await POST(
    req('/api/mfa/verify', {
      method: 'POST',
      cookie: cookieJar(reviewer),
      body: JSON.stringify({ code: '123456' }),
    }),
  );
  assert.equal(noFactor.status, 409);
  // A reviewer is refused the adjudication route before its body is parsed (403, not 400).
  const notAdjudicator = await POST(
    req('/api/mc/adjudicate', { method: 'POST', cookie: cookieJar(reviewer), body: '{}' }),
  );
  assert.equal(notAdjudicator.status, 403);
  // Logout clears the cookies and invalidates the token at Auth.
  const out = await DELETE(req('/api/session', { method: 'DELETE', cookie: aal2Cookies }));
  assert.ok(out.headers.getSetCookie().every((c) => c.includes('Max-Age=0')));
  const after = await GET(req('/api/session', { cookie: aal2Cookies }));
  assert.equal(((await after.json()) as { user: unknown }).user, null);
});

test('refresh-only logout revokes every user refresh token before clearing cookies', async () => {
  const { POST, DELETE } = await import('../src/app/api/[...path]/route');
  const login = () =>
    POST(
      req('/api/session', {
        method: 'POST',
        body: JSON.stringify({ username: 'syn-reviewer-1', password: 'pw-reviewer-1-synthetic' }),
      }),
    );
  const first = readSessionCookies(req('/api/session', { cookie: cookieJar(await login()) }));
  const second = readSessionCookies(req('/api/session', { cookie: cookieJar(await login()) }));
  const out = await DELETE(
    req('/api/session', {
      method: 'DELETE',
      cookie: `${REFRESH_COOKIE}=${first.refresh}`,
    }),
  );
  assert.equal(out.status, 200);
  assert.equal(g.refreshes.has(first.refresh!), false);
  assert.equal(g.refreshes.has(second.refresh!), false, 'the other session is revoked too');
  assert.ok(out.headers.getSetCookie().every((c) => c.includes('Max-Age=0')));
});

test('logout reports an Auth outage and retains rotated cookies for a retry', async () => {
  const { POST, DELETE } = await import('../src/app/api/[...path]/route');
  const signedIn = await POST(
    req('/api/session', {
      method: 'POST',
      body: JSON.stringify({ username: 'syn-reviewer-1', password: 'pw-reviewer-1-synthetic' }),
    }),
  );
  const old = readSessionCookies(req('/api/session', { cookie: cookieJar(signedIn) }));
  g.failures.set('/auth/v1/logout?scope=global', 503);
  try {
    const out = await DELETE(
      req('/api/session', {
        method: 'DELETE',
        cookie: `${REFRESH_COOKIE}=${old.refresh}`,
      }),
    );
    assert.equal(out.status, 502);
    assert.equal(((await out.json()) as { ok?: boolean }).ok, undefined);
    const next = readSessionCookies(req('/api/session', { cookie: cookieJar(out) }));
    assert.ok(
      next.refresh && g.refreshes.has(next.refresh),
      'the rotated refresh survives the error',
    );
    g.failures.delete('/auth/v1/logout?scope=global');
    const retry = await DELETE(req('/api/session', { method: 'DELETE', cookie: cookieJar(out) }));
    assert.equal(retry.status, 200);
    assert.equal(g.refreshes.has(next.refresh), false);
  } finally {
    g.failures.delete('/auth/v1/logout?scope=global');
  }
});

test('protected API activity renews an expired session and preserves rotation on action errors', async () => {
  const { GET, POST } = await import('../src/app/api/[...path]/route');
  const raw = g.issue(g.users[internalEmail('syn-reviewer-1', REF)].id, 'aal1', -1);
  const cookies = sessionCookieHeaders(
    {
      accessToken: raw.access_token,
      refreshToken: raw.refresh_token,
      expiresAt: Math.floor(Date.now() / 1000) - 1,
    },
    false,
  );
  const cookieFor = (path: string) =>
    cookies
      .filter((c) => {
        const scope = /; Path=([^;]+)/.exec(c)?.[1] ?? '/';
        return path === scope || path.startsWith(scope.endsWith('/') ? scope : `${scope}/`);
      })
      .map((c) => c.split(';')[0])
      .join('; ');
  const refreshed = await GET(req('/api/mc/workspace', { cookie: cookieFor('/api/mc/workspace') }));
  assert.equal(refreshed.status, 200);
  assert.ok(
    cookieJar(refreshed).includes(REFRESH_COOKIE),
    'normal API requests can renew the session',
  );
  const raw2 = g.issue(g.users[internalEmail('syn-reviewer-1', REF)].id, 'aal1', -1);
  const refused = await POST(
    req('/api/mc/adjudicate', {
      method: 'POST',
      cookie: `${REFRESH_COOKIE}=${raw2.refresh_token}`,
      body: '{}',
    }),
  );
  assert.equal(refused.status, 403);
  const rotated = readSessionCookies(req('/api/session', { cookie: cookieJar(refused) }));
  assert.ok(
    rotated.refresh && g.refreshes.has(rotated.refresh),
    'authorization errors retain the refresh rotation',
  );
});

test('a transient refresh failure does not clear the session or masquerade as sign-out', async () => {
  const { GET } = await import('../src/app/api/[...path]/route');
  const raw = g.issue(g.users[internalEmail('syn-reviewer-1', REF)].id, 'aal1');
  const cookie = `${REFRESH_COOKIE}=${raw.refresh_token}`;
  g.failures.set('/auth/v1/token?grant_type=refresh_token', 503);
  try {
    const response = await GET(req('/api/session', { cookie }));
    assert.equal(response.status, 502);
    assert.deepEqual(response.headers.getSetCookie(), []);
    assert.ok(g.refreshes.has(raw.refresh_token));
  } finally {
    g.failures.delete('/auth/v1/token?grant_type=refresh_token');
  }
  assert.equal((await GET(req('/api/mc/workspace', { cookie }))).status, 200);
});

test('legacy refresh cookies migrate at startup and cannot shadow the new API cookie', async () => {
  const { GET } = await import('../src/app/api/[...path]/route');
  const raw = g.issue(g.users[internalEmail('syn-reviewer-1', REF)].id, 'aal1');
  const oldCookie = `${ACCESS_COOKIE}=${raw.access_token}; ${LEGACY_REFRESH_COOKIE}=${raw.refresh_token}`;
  const session = await GET(req('/api/session', { cookie: oldCookie }));
  assert.equal(session.status, 200);
  const headers = session.headers.getSetCookie();
  assert.ok(
    headers.some(
      (c) => c.startsWith(`${REFRESH_COOKIE}=${raw.refresh_token};`) && c.includes('Path=/api;'),
    ),
  );
  assert.ok(
    headers.some(
      (c) =>
        c.startsWith(`${LEGACY_REFRESH_COOKIE}=;`) &&
        c.includes('Path=/api/session;') &&
        c.includes('Max-Age=0'),
    ),
  );
  for (const pairs of [
    [`${REFRESH_COOKIE}=${raw.refresh_token}`, `${LEGACY_REFRESH_COOKIE}=stale-legacy-token`],
    [`${LEGACY_REFRESH_COOKIE}=stale-legacy-token`, `${REFRESH_COOKIE}=${raw.refresh_token}`],
  ])
    assert.equal(
      readSessionCookies(req('/api/session', { cookie: pairs.join('; ') })).refresh,
      raw.refresh_token,
    );
});

test('expired-access logout uses the legacy refresh and rejects a definitely revoked refresh', async () => {
  const { DELETE, GET } = await import('../src/app/api/[...path]/route');
  const raw = g.issue(g.users[internalEmail('syn-reviewer-1', REF)].id, 'aal1', -1);
  const out = await DELETE(
    req('/api/session', {
      method: 'DELETE',
      cookie: `${ACCESS_COOKIE}=${raw.access_token}; ${LEGACY_REFRESH_COOKIE}=${raw.refresh_token}`,
    }),
  );
  assert.equal(out.status, 200);
  assert.equal(g.refreshes.has(raw.refresh_token), false);
  const invalid = await GET(
    req('/api/session', { cookie: `${REFRESH_COOKIE}=definitely-revoked-token` }),
  );
  assert.equal(invalid.status, 200);
  assert.equal(((await invalid.json()) as { user: unknown }).user, null);
  assert.ok(invalid.headers.getSetCookie().every((c) => c.includes('Max-Age=0')));
});

test('a refreshed session survives identity-service and data-service failures', async () => {
  const { GET } = await import('../src/app/api/[...path]/route');
  for (const path of ['/auth/v1/user', '/rest/v1/rpc/rpc_whoami']) {
    const raw = g.issue(g.users[internalEmail('syn-reviewer-1', REF)].id, 'aal1');
    g.failures.set(path, 503);
    try {
      const failed = await GET(
        req('/api/mc/workspace', { cookie: `${REFRESH_COOKIE}=${raw.refresh_token}` }),
      );
      assert.ok(failed.status >= 500);
      const rotated = readSessionCookies(req('/api/session', { cookie: cookieJar(failed) }));
      assert.ok(rotated.refresh && g.refreshes.has(rotated.refresh));
      g.failures.delete(path);
      const retry = await GET(req('/api/mc/workspace', { cookie: cookieJar(failed) }));
      assert.equal(retry.status, 200);
    } finally {
      g.failures.delete(path);
    }
  }
});

test('logout clears already-invalid local credentials without claiming global revocation', async () => {
  const { DELETE } = await import('../src/app/api/[...path]/route');
  const expired = g.issue(g.users[internalEmail('syn-reviewer-1', REF)].id, 'aal1', -1);
  g.refreshes.delete(expired.refresh_token);
  for (const cookie of [
    `${ACCESS_COOKIE}=${expired.access_token}`,
    `${REFRESH_COOKIE}=${expired.refresh_token}`,
    `${ACCESS_COOKIE}=${expired.access_token}; ${REFRESH_COOKIE}=${expired.refresh_token}`,
  ]) {
    const out = await DELETE(req('/api/session', { method: 'DELETE', cookie }));
    assert.equal(out.status, 200, 'Sign out must let the browser leave its stale workspace');
    assert.deepEqual(await out.json(), { ok: true, revocation: 'credentials_unavailable' });
    assert.equal(out.headers.getSetCookie().length, 3);
    assert.ok(out.headers.getSetCookie().every((c) => c.includes('Max-Age=0')));
  }
});
