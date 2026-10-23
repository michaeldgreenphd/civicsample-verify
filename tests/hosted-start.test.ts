import assert from 'node:assert/strict';
import test from 'node:test';
import { checkHostedAuth, hostedSettings } from '../scripts/hosted-start.mjs';
import { proxy } from '../src/proxy';
import { NextRequest } from 'next/server';

const commit = 'a'.repeat(40);
const env = {
  VERIFY_DATA_BACKEND: 'supabase',
  VERIFY_SUPABASE_URL: 'https://abcdefghijklmnopqrst.supabase.co',
  VERIFY_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_synthetic_000000000',
  RENDER_EXTERNAL_URL: 'https://synthetic-practice.onrender.com',
  RENDER_GIT_COMMIT: commit,
  PORT: '10000',
};
test('public startup fails closed on local auth, insecure origin, privileged config and wrong build', () => {
  const settings = hostedSettings(env, commit);
  assert.equal(settings.env.VERIFY_SITE_ORIGIN, env.RENDER_EXTERNAL_URL);
  assert.equal(settings.env.VERIFY_APP_GIT_SHA, commit);
  for (const patch of [
    { VERIFY_DATA_BACKEND: 'local' },
    { VERIFY_DATA_BACKEND: '' },
    { VERIFY_SITE_ORIGIN: 'http://synthetic.invalid' },
    { VERIFY_SITE_ORIGIN: 'https://synthetic.invalid/path' },
    { VERIFY_SITE_ORIGIN: 'https://name:password@synthetic.invalid' },
    { VERIFY_SITE_ORIGIN: 'https://localhost' },
    { VERIFY_SUPABASE_PUBLISHABLE_KEY: 'sb_secret_synthetic_only' },
    {
      VERIFY_SUPABASE_PUBLISHABLE_KEY: `h.${Buffer.from('{"role":"service_role"}').toString('base64url')}.s`,
    },
    { SUPABASE_SERVICE_ROLE_KEY: 'synthetic' },
    { DATABASE_URL: 'synthetic' },
    { VERIFY_DEMO_PASSWORD: 'synthetic' },
    { VERIFY_APP_GIT_SHA: 'b'.repeat(40) },
    { RENDER_GIT_COMMIT: 'b'.repeat(40) },
    { PORT: '10000 --hostname localhost' },
  ])
    assert.throws(() => hostedSettings({ ...env, ...patch }, commit));
  for (const build of ['', 'unverified-local-build', '0'.repeat(40)])
    assert.throws(() => hostedSettings(env, build));
});

test('startup confirms closed registration, refuses unavailable or enabled settings, and does not follow redirects', async () => {
  let calls = 0;
  const fake = (async (_url: unknown, options: RequestInit) => {
    calls++;
    assert.equal(options.redirect, 'error');
    return Response.json({ disable_signup: true });
  }) as typeof fetch;
  await checkHostedAuth(env, fake);
  assert.equal(calls, 1);
  for (const response of [
    Response.json({ disable_signup: false }),
    Response.json({}),
    new Response('', { status: 503 }),
  ])
    await assert.rejects(checkHostedAuth(env, (async () => response) as typeof fetch));
});

test('CSP uses a fresh nonce, overwrites untrusted input, prevents document caching and blocks inline scripts', () => {
  const a = proxy(
    new NextRequest('https://synthetic.invalid', {
      headers: { 'x-nonce': 'attacker', 'content-security-policy': "script-src * 'unsafe-inline'" },
    }),
  );
  const b = proxy(new NextRequest('https://synthetic.invalid'));
  const policy = a.headers.get('content-security-policy')!;
  assert.notEqual(policy, b.headers.get('content-security-policy'));
  assert.match(policy, /script-src 'self' 'nonce-[A-Za-z0-9+/=]+' 'strict-dynamic'/);
  assert.doesNotMatch(
    policy.split(';').find((s) => s.trim().startsWith('script-src'))!,
    /unsafe-inline|attacker/,
  );
  assert.equal(a.headers.get('x-middleware-request-content-security-policy'), policy);
  assert.equal(a.headers.get('cache-control'), 'private, no-store');
});
