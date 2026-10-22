import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ACCOUNTS,
  COOKIE_NAME,
  HttpError,
  claimInvitedSession,
  getActor,
  issueSyntheticInvite,
  resetInvitedAuthStateForTests,
  revokeActorSessions,
  signSyntheticJwt,
  verifySignedJwtClaims,
} from '../src/lib/auth';
import { authorSyntheticPilotCase, evaluateApprovalGates } from '../src/server/admin-workflows';
import { DEMO_ACTORS, getDb, withActor } from '../src/server/db';
import { ServiceError, adminAction, getCase, getWorkspace } from '../src/server/service';

process.env.VERIFY_DB_DIR = 'memory';
process.env.VERIFY_DEMO_PASSWORD = 'synthetic-test-password-123456';

const [investigator, reviewerA, reviewerB, adjudicator] = DEMO_ACTORS;

test('invited-authentication adapter enforces investigator issuance, synthetic-only emails, MFA (aal2), HS256 JWTs, and immediate revocation', () => {
  resetInvitedAuthStateForTests();
  const secret = 'synthetic-jwt-hmac-secret-2026-verify';
  const invitedReviewerId = '00000000-0000-4000-8000-000000000091';

  // Non-investigators cannot issue invitations
  assert.throws(
    () =>
      issueSyntheticInvite(reviewerA, {
        userId: invitedReviewerId,
        email: 'invited-a@example.invalid',
        displayName: 'Invited Reviewer',
        role: 'REVIEWER',
      }),
    (err: unknown) => err instanceof HttpError && err.status === 403,
  );

  // Real email domains are forbidden during the build phase
  assert.throws(
    () =>
      issueSyntheticInvite(ACCOUNTS.investigator, {
        userId: invitedReviewerId,
        email: 'clinician@hospital.org',
        displayName: 'Real Domain Attempt',
        role: 'REVIEWER',
      }),
    (err: unknown) =>
      err instanceof HttpError && err.status === 400 && /synthetic/.test(err.message),
  );

  const { inviteToken, record } = issueSyntheticInvite(ACCOUNTS.investigator, {
    userId: invitedReviewerId,
    email: 'invited-reviewer@example.invalid',
    displayName: 'Synthetic Invited Reviewer',
    role: 'REVIEWER',
    mfaRequired: true,
  });
  assert.notEqual(record.inviteTokenHash, inviteToken);

  // Wrong token is rejected
  assert.throws(
    () => claimInvitedSession(invitedReviewerId, '0'.repeat(64), { aal: 'aal2' }),
    (err: unknown) => err instanceof HttpError && err.status === 401,
  );

  // Claiming without MFA (aal1) is rejected when mfaRequired is true
  assert.throws(
    () => claimInvitedSession(invitedReviewerId, inviteToken, { aal: 'aal1' }),
    (err: unknown) => err instanceof HttpError && err.status === 403 && /aal2/.test(err.message),
  );

  // Claiming with aal2 succeeds once and fails on replay
  const claimed = claimInvitedSession(invitedReviewerId, inviteToken, { aal: 'aal2' });
  assert.equal(claimed.actor.id, invitedReviewerId);
  assert.equal(claimed.claims.aal, 'aal2');
  assert.throws(
    () => claimInvitedSession(invitedReviewerId, inviteToken, { aal: 'aal2' }),
    (err: unknown) =>
      err instanceof HttpError && err.status === 401 && /already been claimed/.test(err.message),
  );

  // Cookie session resolves the invited actor
  const req = new Request('http://127.0.0.1:3001/api/workspace', {
    headers: { cookie: `${COOKIE_NAME}=${claimed.sessionToken}` },
  });
  assert.deepEqual(getActor(req), claimed.actor);

  // Signed HS256 JWT verification
  const jwt = signSyntheticJwt(claimed.claims, secret);
  const verified = verifySignedJwtClaims(jwt, secret);
  assert.deepEqual(verified.actor, claimed.actor);

  // Tampered JWT signature is rejected
  const tampered = jwt.slice(0, -4) + 'AAAA';
  assert.throws(
    () => verifySignedJwtClaims(tampered, secret),
    (err: unknown) => err instanceof HttpError && err.status === 401,
  );

  // Investigator JWT with aal1 is rejected when MFA is required
  const invAal1Jwt = signSyntheticJwt(
    {
      sub: ACCOUNTS.investigator.id,
      aal: 'aal1',
      exp: Math.floor(Date.now() / 1000) + 3600,
      role: 'authenticated',
    },
    secret,
  );
  assert.throws(
    () => verifySignedJwtClaims(invAal1Jwt, secret),
    (err: unknown) => err instanceof HttpError && err.status === 403 && /aal2/.test(err.message),
  );

  // Revoking actor sessions immediately invalidates both cookie session and signed JWT
  const removed = revokeActorSessions(invitedReviewerId, ACCOUNTS.investigator);
  assert.equal(removed, 1);
  assert.equal(getActor(req), null);
  assert.throws(
    () => verifySignedJwtClaims(jwt, secret),
    (err: unknown) => err instanceof HttpError && err.status === 401 && /revoked/.test(err.message),
  );
});

test('approval-gate inspector and synthetic case authoring workflow enforce roles, blinding, and formal-activation block', async () => {
  await getDb();

  // Non-investigators cannot inspect approval gates or author cases
  for (const nonInv of [reviewerA, reviewerB, adjudicator]) {
    await assert.rejects(
      () => evaluateApprovalGates(nonInv),
      (err: unknown) => err instanceof ServiceError && err.status === 403,
    );
  }

  // Investigator can inspect all 11 approval gates; formal activation remains false
  const report = await evaluateApprovalGates(investigator);
  assert.equal(report.formalActivationAllowed, false);
  assert.equal(report.moduleBApproved, false);
  assert.equal(report.gates.length, 11);
  assert.ok(report.gates.some((g) => g.gate === 'sample_adequacy' && g.status === 'BLOCKED'));
  assert.ok(report.gates.some((g) => g.gate === 'security' && g.status === 'BLOCKED'));
  assert.equal(report.schemaVersion, '4.0.5-trial-packet-concurrency-guards');

  // Formal activation via adminAction remains disabled even after configuring a proposal
  await adminAction(investigator, {
    action: 'configure',
    configuration: { tierVersion: 'v1.2' },
  });
  const updatedReport = await evaluateApprovalGates(investigator);
  assert.equal(updatedReport.tier1Proposal, 'v1.2');
  assert.equal(updatedReport.formalActivationAllowed, false);
  await assert.rejects(
    () =>
      adminAction(investigator, { action: 'activate-formal', attestation: 'Attempt activation' }),
    (err: unknown) => err instanceof ServiceError && err.status === 403,
  );

  // Authoring rejects real NCT identifiers and mismatched TWO_STEP/trialPacket
  const validPacket = {
    title: 'Synthetic authored pulmonary case',
    area: 'respiratory',
    descriptorUi: 'SYN-D0999',
    descriptorName: 'Fictional Airway Syndrome',
    treeNumbers: ['SYN.C08.999'],
    scopeNote: 'Fictional engineering descriptor for authoring workflow verification.',
    parents: ['Fictional Respiratory Tract Diseases'],
    children: ['Fictional Bronchial Disorder'],
    synonyms: ['Synthetic Airway Condition'],
    includedConcepts: ['Fictional acute airway narrowing'],
    excludedConcepts: ['Fictional pleural effusion'],
    hierarchyExcerpt: ['SYN.C08 Respiratory -> SYN.C08.999 Fictional Airway Syndrome'],
    rubricPrompt: 'Classify this fictional descriptor under the synthetic pilot rubric.',
  };

  await assert.rejects(
    () =>
      authorSyntheticPilotCase(investigator, {
        id: 'SYN-011',
        kind: 'TWO_STEP',
        packet: validPacket,
      }),
    (err: unknown) => err instanceof ServiceError && err.status === 400,
  );

  await assert.rejects(
    () =>
      authorSyntheticPilotCase(investigator, {
        id: 'SYN-011',
        kind: 'TWO_STEP',
        packet: validPacket,
        trialPacket: {
          nctId: 'NCT' + '12345678',
          title: 'Invalid real NCT attempt',
          conditions: ['Fictional condition'],
          interventions: ['Fictional intervention'],
          primaryOutcomes: ['Fictional outcome'],
          eligibilitySummary: 'Fictional adults',
          briefSummary: 'Fictional summary',
        },
      }),
    (err: unknown) => err instanceof ServiceError && err.status === 400,
  );

  // Database RPC directly rejects blinded keys even if called without the TypeScript schema
  await assert.rejects(
    withActor(investigator, (tx) =>
      tx.query('select public.rpc_verify_author_case($1::jsonb)', [
        JSON.stringify({
          id: 'SYN-011',
          kind: 'DESCRIPTOR',
          packet: { ...validPacket, tier1_prediction: 'INCLUDE' },
        }),
      ]),
    ),
    /not allowed in a blinded reviewer packet/,
  );

  // Authoring a valid synthetic case succeeds and assigns it to both pilot reviewers
  const invWorkspace = await authorSyntheticPilotCase(investigator, {
    id: 'SYN-011',
    kind: 'TWO_STEP',
    packet: validPacket,
    trialPacket: {
      nctId: 'SYN-NCT-0911',
      title: 'Fictional Step-2 Trial for SYN-011',
      conditions: ['Fictional Airway Syndrome'],
      interventions: ['Fictional Nebulizer Agent'],
      primaryOutcomes: ['Fictional Symptom Score at Day 14'],
      eligibilitySummary: 'Fictional adults aged 18 to 65 years.',
      briefSummary: 'Fictional randomized study for synthetic Step-2 authoring verification.',
    },
  });
  assert.equal(invWorkspace.campaign.caseCount, 11);

  // Reviewers can see SYN-011 in their workspace queue, and Step-2 trialPacket is hidden before Step 1
  const reviewerQueue = await getWorkspace(reviewerA);
  assert.ok(reviewerQueue.queue.some((q) => q.caseId === 'SYN-011'));
  const reviewerView = await getCase(reviewerA, 'SYN-011');
  assert.equal(reviewerView.caseId, 'SYN-011');
  assert.equal(reviewerView.unitType, 'TRIAL_AREA');
  assert.equal(reviewerView.step1Required, true);
  assert.equal(reviewerView.trialPacket, undefined);
});
