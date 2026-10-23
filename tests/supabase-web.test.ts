// Supabase deployment mode, exercised locally against a fake Auth (GoTrue) and PostgREST gateway:
// username sign-in with HttpOnly cookie sessions, token verification and refresh, logout, TOTP
// enrolment and verification, the publishable-key-only rule, and the mapping-confirmation routes
// under the caller's token. No request leaves the process; nothing here is a real Supabase test.
import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import { assertPublishableKey, supabaseWebConfig } from '../src/lib/supabase-config';
import { toExportTimestamp } from '../src/lib/postgrest';
import {
  ACCESS_COOKIE,
  REFRESH_COOKIE,
  SupabaseAuth,
  internalEmail,
  readSessionCookies,
  sessionCookieHeaders,
} from '../src/lib/supabase-auth';

const REF = 'abcdefghijklmnopqrst';
const URL_ = `https://${REF}.supabase.co`;
const PUB = 'sb_publishable_synthetic_key_000000';
const jwt = (claims: Record<string, unknown>) =>
  `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;

/** Minimal GoTrue + PostgREST fake with a few synthetic accounts and mapping rows. */
function gateway() {
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
  const tokens = new Map<string, { sub: string; aal: 'aal1' | 'aal2'; exp: number }>();
  const refreshes = new Map<string, string>();
  const log: {
    method: string;
    path: string;
    auth: string | null;
    apikey: string | null;
    body: unknown;
  }[] = [];
  let counter = 0;
  const issue = (sub: string, aal: 'aal1' | 'aal2', ttl = 3600) => {
    const exp = Math.floor(Date.now() / 1000) + ttl;
    const access = jwt({ sub, aal, exp, session_id: `s-${++counter}`, role: 'authenticated' });
    const refresh = `refresh-token-${counter}-synthetic-value`;
    tokens.set(access, { sub, aal, exp });
    refreshes.set(refresh, sub);
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
      const sub = refreshes.get(body.refresh_token);
      if (!sub) return respond(400, { error: 'invalid_grant' });
      refreshes.delete(body.refresh_token);
      return respond(200, issue(sub, 'aal1'));
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
      // scope=global: every session and refresh token of the user is revoked, as Supabase does.
      if (session) {
        for (const [t, v] of tokens) if (v.sub === session.sub) tokens.delete(t);
        for (const [r, sub] of refreshes) if (sub === session.sub) refreshes.delete(r);
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
          qr_code: 'data:image/svg+xml;utf-8,<svg/>',
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
  return { fetchImpl, log, users, tokens };
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
    new RegExp(`^${REFRESH_COOKIE}=.*HttpOnly; Path=/api/session; SameSite=Strict; Max-Age=`),
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
    /^data:image\/svg\+xml;charset=utf-8,%3Csvg/,
    'QR payload percent-encoded for an image source',
  );
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
  // Logout clears the cookies and invalidates the token at Auth.
  const out = await DELETE(req('/api/session', { method: 'DELETE', cookie: aal2Cookies }));
  assert.ok(out.headers.getSetCookie().every((c) => c.includes('Max-Age=0')));
  const after = await GET(req('/api/session', { cookie: aal2Cookies }));
  assert.equal(((await after.json()) as { user: unknown }).user, null);
});
