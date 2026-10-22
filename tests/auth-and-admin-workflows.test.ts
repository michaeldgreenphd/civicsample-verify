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
import {
  ServiceError,
  adminAction,
  getCase,
  getWorkspace,
  submitReview,
  submitStep1,
} from '../src/server/service';

process.env.VERIFY_DB_DIR = 'memory';
process.env.VERIFY_DEMO_PASSWORD = 'synthetic-test-password-123456';

const [investigator, reviewerA, reviewerB, adjudicator] = DEMO_ACTORS;

test('synthetic invite/JWT test scaffolding requires explicit aal2 (no default-to-aal2) and permanently rejects revoked tokens across reinvite', () => {
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

  // Omitting options does NOT default to aal2: it defaults to aal1 and is rejected when mfaRequired is true
  assert.throws(
    () => claimInvitedSession(invitedReviewerId, inviteToken),
    (err: unknown) => err instanceof HttpError && err.status === 403 && /aal2/.test(err.message),
  );

  // Claiming explicitly with aal1 is also rejected when mfaRequired is true
  assert.throws(
    () => claimInvitedSession(invitedReviewerId, inviteToken, { aal: 'aal1' }),
    (err: unknown) => err instanceof HttpError && err.status === 403 && /aal2/.test(err.message),
  );

  // Claiming with explicit simulated aal2 succeeds once and fails on replay
  const claimed = claimInvitedSession(invitedReviewerId, inviteToken, { aal: 'aal2' });
  assert.equal(claimed.actor.id, invitedReviewerId);
  assert.equal(claimed.claims.aal, 'aal2');
  assert.ok(claimed.claims.sessionId);
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
  const oldJwt = signSyntheticJwt(claimed.claims, secret);
  const verified = verifySignedJwtClaims(oldJwt, secret);
  assert.deepEqual(verified.actor, claimed.actor);

  // Tampered JWT signature is rejected
  const tampered = oldJwt.slice(0, -4) + 'AAAA';
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
    () => verifySignedJwtClaims(oldJwt, secret),
    (err: unknown) => err instanceof HttpError && err.status === 401 && /revoked/.test(err.message),
  );

  // Regression: revoke -> reinvite -> old JWT must remain invalid both before and after claiming the new invite
  const reinvite = issueSyntheticInvite(ACCOUNTS.investigator, {
    userId: invitedReviewerId,
    email: 'invited-reviewer@example.invalid',
    displayName: 'Synthetic Invited Reviewer Reinvited',
    role: 'REVIEWER',
    mfaRequired: true,
  });
  assert.equal(getActor(req), null);
  assert.throws(
    () => verifySignedJwtClaims(oldJwt, secret),
    (err: unknown) => err instanceof HttpError && err.status === 401 && /revoked/.test(err.message),
  );

  const reclaimed = claimInvitedSession(invitedReviewerId, reinvite.inviteToken, { aal: 'aal2' });
  assert.notEqual(reclaimed.claims.sessionId, claimed.claims.sessionId);

  // Even after the new invitation is claimed, the previously revoked JWT remains permanently invalid
  assert.throws(
    () => verifySignedJwtClaims(oldJwt, secret),
    (err: unknown) => err instanceof HttpError && err.status === 401 && /revoked/.test(err.message),
  );

  // A token without sessionId for that subject is also rejected
  const sessionlessJwt = signSyntheticJwt(
    {
      sub: invitedReviewerId,
      aal: 'aal2',
      exp: Math.floor(Date.now() / 1000) + 3600,
      role: 'authenticated',
    },
    secret,
  );
  assert.throws(
    () => verifySignedJwtClaims(sessionlessJwt, secret),
    (err: unknown) => err instanceof HttpError && err.status === 401 && /revoked/.test(err.message),
  );

  // Only the newly issued JWT bound to the new sessionId is accepted
  const newJwt = signSyntheticJwt(reclaimed.claims, secret);
  const verifiedNew = verifySignedJwtClaims(newJwt, secret);
  assert.equal(verifiedNew.actor.id, invitedReviewerId);
  assert.equal(verifiedNew.claims.sessionId, reclaimed.claims.sessionId);

  // Pre-enrolled demo account: old JWT issued before revocation remains invalid even after reinvite + claim
  const demoOldJwt = signSyntheticJwt(
    {
      sub: ACCOUNTS['reviewer-a'].id,
      aal: 'aal2',
      exp: Math.floor(Date.now() / 1000) + 3600,
      role: 'authenticated',
    },
    secret,
  );
  assert.equal(verifySignedJwtClaims(demoOldJwt, secret).actor.id, ACCOUNTS['reviewer-a'].id);
  revokeActorSessions(ACCOUNTS['reviewer-a'].id, ACCOUNTS.investigator);
  assert.throws(
    () => verifySignedJwtClaims(demoOldJwt, secret),
    (err: unknown) => err instanceof HttpError && err.status === 401 && /revoked/.test(err.message),
  );
  const demoReinvite = issueSyntheticInvite(ACCOUNTS.investigator, {
    userId: ACCOUNTS['reviewer-a'].id,
    email: 'pilot-2-reinvited@example.invalid',
    displayName: 'Synthetic reviewer A',
    role: 'REVIEWER',
    mfaRequired: true,
  });
  assert.throws(
    () => verifySignedJwtClaims(demoOldJwt, secret),
    (err: unknown) => err instanceof HttpError && err.status === 401 && /revoked/.test(err.message),
  );
  const demoReclaimed = claimInvitedSession(ACCOUNTS['reviewer-a'].id, demoReinvite.inviteToken, {
    aal: 'aal2',
  });
  assert.throws(
    () => verifySignedJwtClaims(demoOldJwt, secret),
    (err: unknown) => err instanceof HttpError && err.status === 401 && /revoked/.test(err.message),
  );
  const demoNewJwt = signSyntheticJwt(demoReclaimed.claims, secret);
  assert.equal(verifySignedJwtClaims(demoNewJwt, secret).actor.id, ACCOUNTS['reviewer-a'].id);
  resetInvitedAuthStateForTests();
});

test('approval-gate inspector and canonical synthetic case authoring workflow enforce roles, blinding, and formal-activation block', async () => {
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
  assert.equal(report.schemaVersion, '5.1.4-v5-rubric-binding');

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

  // Canonical EvidencePacket & TrialPacket structure matching src/lib/types.ts
  const validPacket = {
    title: 'Fictional condition K',
    area: 'Respiratory',
    descriptorName: 'Fictional Airway Syndrome',
    descriptorId: 'TESTFX-D0011',
    scopeNote: 'Fictional engineering descriptor for canonical authoring workflow verification.',
    entryTerms: ['Synthetic Airway Condition', 'Fictional Bronchial Syndrome'],
    treeNumbers: [
      {
        number: 'TESTFX.011',
        label: 'Synthetic branch — no real MeSH classification',
      },
    ],
    areaDefinition:
      'For this pilot only, consider whether the fictional condition belongs in the respiratory construct.',
    source: 'Hand-authored fictional engineering fixture',
    sourceVersion: 'synthetic-v1',
  };

  const validTrialPacket = {
    registryId: 'SYN-NCT-0011',
    title: 'Fictional Step-2 Trial for SYN-011',
    summary: 'Fictional randomized study for canonical Step-2 authoring verification.',
    conditions: ['Fictional Airway Syndrome'],
    interventions: ['Fictional Nebulizer Agent'],
    primaryOutcomes: ['Fictional Symptom Score at Day 14'],
    studyType: 'Synthetic interventional example',
    primaryPurpose: 'Synthetic treatment example',
    phase: 'Not applicable to fictional study',
    ageRange: 'Fictional adult population',
    source: 'Hand-authored fictional engineering fixture',
    sourceVersion: 'synthetic-v1',
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
          ...validTrialPacket,
          registryId: 'NCT' + '12345678',
        },
      }),
    (err: unknown) => err instanceof ServiceError && err.status === 400,
  );

  // Database RPC directly rejects blinded keys and non-canonical packet structures
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

  // Direct-RPC negative tests: missing fields, SQL NULL semantics, only descriptorId, and nested structures
  const directRpcNegativePayloads: Array<{ label: string; payload: unknown; expected: RegExp }> = [
    {
      label: 'packet containing only descriptorId',
      payload: {
        id: 'SYN-011',
        kind: 'DESCRIPTOR',
        packet: { descriptorId: 'TESTFX-D0011' },
      },
      expected: /canonical EvidencePacket structure \(invalid or missing "title"\)/,
    },
    {
      label: 'packet missing descriptorId and other canonical fields',
      payload: {
        id: 'SYN-011',
        kind: 'DESCRIPTOR',
        packet: { title: 'Missing canonical fields', area: 'Respiratory' },
      },
      expected: /canonical EvidencePacket structure \(invalid or missing "descriptorName"\)/,
    },
    {
      label: 'packet with JSON null required string field',
      payload: {
        id: 'SYN-011',
        kind: 'DESCRIPTOR',
        packet: { ...validPacket, scopeNote: null },
      },
      expected: /canonical EvidencePacket structure \(invalid or missing "scopeNote"\)/,
    },
    {
      label: 'packet with whitespace-only required string field',
      payload: {
        id: 'SYN-011',
        kind: 'DESCRIPTOR',
        packet: { ...validPacket, areaDefinition: '   ' },
      },
      expected: /canonical EvidencePacket structure \(invalid or missing "areaDefinition"\)/,
    },
    {
      label: 'packet with unexpected extra key',
      payload: {
        id: 'SYN-011',
        kind: 'DESCRIPTOR',
        packet: { ...validPacket, customField: 'not allowed' },
      },
      expected: /canonical EvidencePacket structure \(unexpected keys\)/,
    },
    {
      label: 'packet with missing entryTerms (SQL NULL)',
      payload: {
        id: 'SYN-011',
        kind: 'DESCRIPTOR',
        packet: (() => {
          const { entryTerms: _omit, ...rest } = validPacket;
          void _omit;
          return rest;
        })(),
      },
      expected: /canonical EvidencePacket structure \(invalid entryTerms\)/,
    },
    {
      label: 'packet with empty entryTerms array',
      payload: {
        id: 'SYN-011',
        kind: 'DESCRIPTOR',
        packet: { ...validPacket, entryTerms: [] },
      },
      expected: /canonical EvidencePacket structure \(invalid entryTerms\)/,
    },
    {
      label: 'packet with non-string or blank entryTerms element',
      payload: {
        id: 'SYN-011',
        kind: 'DESCRIPTOR',
        packet: { ...validPacket, entryTerms: ['Valid', null] },
      },
      expected: /canonical EvidencePacket structure \(invalid entryTerms\)/,
    },
    {
      label: 'packet with primitive string treeNumbers instead of nested {number,label} objects',
      payload: {
        id: 'SYN-011',
        kind: 'DESCRIPTOR',
        packet: { ...validPacket, treeNumbers: ['TESTFX.011'] },
      },
      expected: /canonical EvidencePacket structure \(invalid treeNumbers\)/,
    },
    {
      label: 'packet with treeNumbers element missing label',
      payload: {
        id: 'SYN-011',
        kind: 'DESCRIPTOR',
        packet: { ...validPacket, treeNumbers: [{ number: 'TESTFX.011' }] },
      },
      expected: /canonical EvidencePacket structure \(invalid treeNumbers\)/,
    },
    {
      label: 'packet with treeNumbers element containing unexpected key',
      payload: {
        id: 'SYN-011',
        kind: 'DESCRIPTOR',
        packet: {
          ...validPacket,
          treeNumbers: [{ number: 'TESTFX.011', label: 'Synthetic branch', extra: 'bad' }],
        },
      },
      expected: /canonical EvidencePacket structure \(invalid treeNumbers\)/,
    },
    {
      label: 'DESCRIPTOR case with non-null string trialPacket',
      payload: {
        id: 'SYN-011',
        kind: 'DESCRIPTOR',
        packet: validPacket,
        trialPacket: 'unexpected-string',
      },
      expected: /TWO_STEP cases require a trialPacket and DESCRIPTOR cases cannot have one/,
    },
    {
      label: 'TWO_STEP case with trialPacket containing only registryId',
      payload: {
        id: 'SYN-011',
        kind: 'TWO_STEP',
        packet: validPacket,
        trialPacket: { registryId: 'SYN-NCT-0011' },
      },
      expected: /canonical TrialPacket structure \(invalid or missing "title"\)/,
    },
    {
      label: 'TWO_STEP case with JSON null trialPacket field',
      payload: {
        id: 'SYN-011',
        kind: 'TWO_STEP',
        packet: validPacket,
        trialPacket: { ...validTrialPacket, studyType: null },
      },
      expected: /canonical TrialPacket structure \(invalid or missing "studyType"\)/,
    },
    {
      label: 'TWO_STEP case with empty conditions array in trialPacket',
      payload: {
        id: 'SYN-011',
        kind: 'TWO_STEP',
        packet: validPacket,
        trialPacket: { ...validTrialPacket, conditions: [] },
      },
      expected: /canonical TrialPacket structure \(invalid "conditions"\)/,
    },
    {
      label: 'TWO_STEP case with non-string element in trialPacket interventions',
      payload: {
        id: 'SYN-011',
        kind: 'TWO_STEP',
        packet: validPacket,
        trialPacket: { ...validTrialPacket, interventions: [null] },
      },
      expected: /canonical TrialPacket structure \(invalid "interventions"\)/,
    },
  ];

  for (const tc of directRpcNegativePayloads) {
    await assert.rejects(
      withActor(investigator, (tx) =>
        tx.query('select public.rpc_verify_author_case($1::jsonb)', [JSON.stringify(tc.payload)]),
      ),
      tc.expected,
      `Direct RPC must reject: ${tc.label}`,
    );
  }

  // Authoring a valid canonical synthetic case succeeds and assigns it to both pilot reviewers
  const invWorkspace = await authorSyntheticPilotCase(investigator, {
    id: 'SYN-011',
    kind: 'TWO_STEP',
    packet: validPacket,
    trialPacket: validTrialPacket,
  });
  assert.equal(invWorkspace.campaign.caseCount, 11);

  // Reviewers see SYN-011 with canonical EvidencePacket fields, and Step-2 trialPacket is hidden before Step 1
  const reviewerQueue = await getWorkspace(reviewerA);
  assert.ok(reviewerQueue.queue.some((q) => q.caseId === 'SYN-011'));
  const beforeStep1 = await getCase(reviewerA, 'SYN-011');
  assert.equal(beforeStep1.caseId, 'SYN-011');
  assert.equal(beforeStep1.unitType, 'TRIAL_AREA');
  assert.equal(beforeStep1.step1Required, true);
  assert.equal(beforeStep1.trialPacket, undefined);
  assert.deepEqual(beforeStep1.packet, {
    descriptorName: validPacket.descriptorName,
    descriptorId: validPacket.descriptorId,
    scopeNote: validPacket.scopeNote,
    entryTerms: validPacket.entryTerms,
    treeNumbers: validPacket.treeNumbers,
    areaDefinition: validPacket.areaDefinition,
    source: validPacket.source,
    sourceVersion: validPacket.sourceVersion,
  });

  // Locking Step 1 discloses the canonical TrialPacket
  const afterStep1 = await submitStep1(reviewerA, 'SYN-011', {
    decision: 'INCLUDE',
    rationale: 'Fictional Step 1 descriptor judgment.',
    uncertain: false,
    context: '',
    packetProblem: false,
  });
  assert.equal(afterStep1.step1Locked, true);
  assert.deepEqual(afterStep1.trialPacket, validTrialPacket);

  // Completing Step 2 locks the final trial-level submission
  const afterStep2 = await submitReview(reviewerA, 'SYN-011', {
    decision: 'INCLUDE',
    rationale: 'Fictional Step 2 trial judgment.',
    uncertain: false,
    context: '',
    packetProblem: false,
    descriptorRole: 'DISEASE_STUDIED',
  });
  assert.equal(afterStep2.submission?.decision, 'INCLUDE');
  assert.equal(afterStep2.submission?.descriptorRole, 'DISEASE_STUDIED');
});
