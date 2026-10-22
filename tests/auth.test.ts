import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertLocalRequest,
  login,
  getActor,
  logout,
  sessionCookie,
  HttpError,
  ACCOUNTS,
  COOKIE_NAME,
  issueSyntheticInvite,
  claimInvitedSession,
  resetInvitedAuthStateForTests,
  signSyntheticJwt,
  verifySignedJwtClaims,
} from '../src/lib/auth';
import { judgmentSchema, adjudicationSchema } from '../src/lib/validation';

test('local auth rejects public hosts and cross-origin mutations', () => {
  assert.throws(
    () =>
      assertLocalRequest(
        new Request('http://example.test/api/session', { headers: { host: 'example.test' } }),
      ),
    HttpError,
  );
  assert.throws(
    () =>
      assertLocalRequest(
        new Request('http://localhost:3000/api/session', {
          headers: { host: 'localhost:3000', origin: 'http://evil.test' },
        }),
        true,
      ),
    HttpError,
  );
  assert.throws(
    () =>
      assertLocalRequest(
        new Request('http://localhost:3000/api/session', { headers: { host: 'localhost:3000' } }),
        true,
      ),
    HttpError,
  );
  assert.doesNotThrow(() =>
    assertLocalRequest(
      new Request('http://localhost:3000/api/session', {
        headers: { host: 'localhost:3000', origin: 'http://localhost:3000' },
      }),
      true,
    ),
  );
});
test('opaque sessions authenticate known synthetic accounts and revoke on logout', () => {
  process.env.VERIFY_DEMO_PASSWORD = 'test-only-long-local-passphrase';
  assert.throws(() => login('reviewer-a', 'wrong'), HttpError);
  assert.throws(() => login('toString', process.env.VERIFY_DEMO_PASSWORD!), HttpError);
  const token = login('reviewer-a', process.env.VERIFY_DEMO_PASSWORD);
  const request = new Request('http://localhost/api/session', {
    headers: { cookie: sessionCookie(token) },
  });
  assert.equal(getActor(request)?.role, 'REVIEWER');
  assert.equal(
    getActor(
      new Request('http://localhost/api/session', { headers: { cookie: 'verify_session=forged' } }),
    ),
    null,
  );
  assert.match(sessionCookie(token), /HttpOnly; SameSite=Strict/);
  logout(request);
  assert.equal(getActor(request), null);
});
test('final answers require rationale; hidden fields and absent context are rejected', () => {
  const input = {
    decision: 'INCLUDE',
    rationale: 'Synthetic rationale',
    uncertain: false,
    context: '',
    packetProblem: false,
  };
  assert.equal(judgmentSchema.safeParse(input).success, true);
  assert.equal(judgmentSchema.safeParse({ ...input, rationale: '   ' }).success, false);
  assert.equal(judgmentSchema.safeParse({ ...input, tier0: 'INCLUDE' }).success, false);
  assert.equal(
    judgmentSchema.safeParse({ ...input, decision: 'CONTEXT_DEPENDENT' }).success,
    false,
  );
  assert.equal(judgmentSchema.safeParse({ ...input, decision: null }).success, false);
  assert.equal(
    judgmentSchema.safeParse({ ...input, decision: 'CONTEXT_DEPENDENT', context: 'x' }).success,
    false,
  );
  assert.equal(
    judgmentSchema.safeParse({
      ...input,
      decision: 'CONTEXT_DEPENDENT',
      context: JSON.stringify({
        clinicalContext: 'Fictional trial',
        inclusionConditions: 'Primary condition',
        exclusionConditions: 'Outcome only',
      }),
    }).success,
    true,
  );
});
test('unresolved adjudication remains distinct from an insufficient-information answer', () => {
  const input = {
    decision: null,
    rationale: 'Cannot resolve from fictional packet.',
    uncertain: true,
    context: '',
    packetProblem: true,
    status: 'UNRESOLVED_ESCALATED',
    basis: 'Packet',
    reasonCode: 'PACKET_INSUFFICIENT',
  };
  assert.equal(adjudicationSchema.safeParse(input).success, true);
  assert.equal(
    adjudicationSchema.safeParse({ ...input, decision: 'INSUFFICIENT_INFORMATION' }).success,
    false,
  );
  assert.equal(
    adjudicationSchema.safeParse({
      ...input,
      decision: 'INSUFFICIENT_INFORMATION',
      status: 'RESOLVED',
    }).success,
    true,
  );
});

test('individual local role passwords prevent role switching and disable the shared fallback', (t) => {
  const names = [
    'VERIFY_INVESTIGATOR_PASSWORD',
    'VERIFY_REVIEWER_A_PASSWORD',
    'VERIFY_REVIEWER_B_PASSWORD',
    'VERIFY_ADJUDICATOR_PASSWORD',
    'VERIFY_DEMO_PASSWORD',
  ];
  const before = names.map((name) => process.env[name]);
  t.after(() =>
    names.forEach((name, i) => {
      if (before[i] === undefined) delete process.env[name];
      else process.env[name] = before[i];
    }),
  );
  resetInvitedAuthStateForTests();
  process.env.VERIFY_DEMO_PASSWORD = 'synthetic-legacy-shared-password';
  process.env.VERIFY_INVESTIGATOR_PASSWORD = 'synthetic-investigator-password';
  process.env.VERIFY_REVIEWER_A_PASSWORD = 'synthetic-reviewer-a-password';
  process.env.VERIFY_REVIEWER_B_PASSWORD = 'synthetic-reviewer-b-password';
  process.env.VERIFY_ADJUDICATOR_PASSWORD = 'synthetic-adjudicator-password';
  for (const [account, password] of [
    ['investigator', process.env.VERIFY_INVESTIGATOR_PASSWORD],
    ['reviewer-a', process.env.VERIFY_REVIEWER_A_PASSWORD],
    ['reviewer-b', process.env.VERIFY_REVIEWER_B_PASSWORD],
    ['adjudicator', process.env.VERIFY_ADJUDICATOR_PASSWORD],
  ]) {
    const request = new Request('http://localhost/api/session', {
      headers: { cookie: sessionCookie(login(account, password)) },
    });
    assert.equal(getActor(request)?.id, ACCOUNTS[account].id);
    logout(request);
    assert.throws(
      () => login(account, process.env.VERIFY_DEMO_PASSWORD!),
      (err: unknown) => err instanceof HttpError && err.status === 401,
    );
  }
  assert.throws(() => login('investigator', process.env.VERIFY_REVIEWER_B_PASSWORD!), HttpError);
  assert.throws(() => login('reviewer-a', process.env.VERIFY_REVIEWER_B_PASSWORD!), HttpError);
  delete process.env.VERIFY_REVIEWER_A_PASSWORD;
  assert.throws(
    () => login('reviewer-a', process.env.VERIFY_DEMO_PASSWORD!),
    (err: unknown) => err instanceof HttpError && err.status === 503,
  );
});

test('replacing an invitation rejects both its old cookie and JWT before and after the new claim', () => {
  resetInvitedAuthStateForTests();
  const input = {
    userId: '00000000-0000-4000-8000-000000000077',
    email: 'replacement@example.invalid',
    displayName: 'Synthetic replacement regression',
    role: 'REVIEWER' as const,
  };
  const original = issueSyntheticInvite(ACCOUNTS.investigator, input);
  const claimed = claimInvitedSession(input.userId, original.inviteToken, { aal: 'aal2' });
  const request = new Request('http://localhost/api/session', {
    headers: { cookie: `${COOKIE_NAME}=${claimed.sessionToken}` },
  });
  const secret = 'synthetic-replacement-signing-secret';
  const jwt = signSyntheticJwt(claimed.claims, secret);
  assert.equal(getActor(request)?.id, input.userId);
  const replacement = issueSyntheticInvite(ACCOUNTS.investigator, input);
  assert.equal(getActor(request), null);
  assert.throws(() => verifySignedJwtClaims(jwt, secret), HttpError);
  const current = claimInvitedSession(input.userId, replacement.inviteToken, { aal: 'aal2' });
  assert.equal(getActor(request), null);
  assert.throws(() => verifySignedJwtClaims(jwt, secret), HttpError);
  const currentRequest = new Request('http://localhost/api/session', {
    headers: { cookie: `${COOKIE_NAME}=${current.sessionToken}` },
  });
  assert.equal(getActor(currentRequest)?.id, input.userId);
  assert.equal(
    verifySignedJwtClaims(signSyntheticJwt(current.claims, secret), secret).actor.id,
    input.userId,
  );
  resetInvitedAuthStateForTests();
});
