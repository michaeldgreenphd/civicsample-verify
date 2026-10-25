import assert from 'node:assert/strict';
import test from 'node:test';
import { formalPreparation } from '../src/lib/formal-preparation';
import type { Mu7InvestigatorWorkspace } from '../src/lib/mu7-types';

function workspace(): Mu7InvestigatorWorkspace {
  return {
    kind: 'investigator',
    training: [],
    design: null,
    counts: { pilotUnits: 0, formalUnits: 0, trainingUnits: 0, pilotQueue: 0 },
    pilotReviewers: [],
    completion: [],
    pilotRouting: [],
    pilotLock: null,
    exports: [],
    phaseEvents: [],
    gates: [],
    formalOperationsEnabled: false,
    formalDisabledReason: 'Synthetic status test.',
    localTools: true,
    appGitSha: 'a'.repeat(40),
  };
}

test('a practice design, completed pilot and 100 counted packets never imply formal readiness', () => {
  const w = workspace();
  w.design = {
    designVersion: 'SYN-8-1-STATUS',
    assignmentSetId: 'SYN-STATUS',
    overlapSetting: 'ONE_PER_TRIAL',
    nPrimaryPlanned: 96,
    nSubgroupPlanned: 4,
    recordedAt: '2026-10-25T00:00:00Z',
  };
  w.counts.formalUnits = 100;
  w.pilotLock = { nUnitsLocked: 12, lockedAt: '2026-10-25T00:00:00Z' };
  w.exports = [
    {
      mode: 'PILOT',
      exportId: 'SYN-EXPORT',
      manifestSha256: 'b'.repeat(64),
      appGitSha: 'a'.repeat(40),
      createdAt: '2026-10-25T00:00:00Z',
    },
  ];
  const r = formalPreparation(w);
  assert.equal(r.checks.find((c) => c.id === 'design')?.status, 'Practice only');
  assert.equal(r.checks.find((c) => c.id === 'packets')?.state, 'not_checked');
  assert.equal(r.checks.find((c) => c.id === 'pilot')?.state, 'recorded');
  assert.equal(r.checks.find((c) => c.id === 'decisions')?.state, 'not_checked');
  assert.equal(r.checks.find((c) => c.id === 'hosted')?.state, 'not_checked');
  assert.equal(r.formal_operations_enabled, false);
});

test('approved database requirements do not authorize a release or certify hosted checks', () => {
  const w = workspace();
  w.gates = [
    {
      gateId: 'G-SYNTHETIC',
      requirementVersion: 1,
      blocks: ['FREEZE'],
      requirementStatus: 'SPECIFIED',
      question: 'Synthetic requirement',
      decisionReference: 'Synthetic decision',
      approvedAt: '2026-10-25T00:00:00Z',
      satisfied: true,
    },
  ];
  const r = formalPreparation(w);
  assert.equal(r.checks.find((c) => c.id === 'decisions')?.state, 'recorded');
  assert.equal(r.checks.find((c) => c.id === 'opening')?.state, 'pending');
  assert.equal(r.formal_operations_enabled, false);
  w.gates[0].satisfied = false;
  assert.equal(formalPreparation(w).checks.find((c) => c.id === 'decisions')?.state, 'pending');
});

test('the downloadable status is allowlisted and does not export identities, study inputs or answers', () => {
  const w = workspace();
  const marker = 'SYNTHETIC_PRIVATE_CONTENT_SENTINEL';
  w.design = {
    designVersion: 'review-design-v8.1.0',
    assignmentSetId: marker,
    overlapSetting: 'ONE_PER_TRIAL',
    nPrimaryPlanned: 96,
    nSubgroupPlanned: 4,
    recordedAt: '2026-10-25T00:00:00Z',
  };
  w.pilotReviewers = [marker];
  w.formalDisabledReason = marker;
  w.gates = [
    {
      gateId: 'G-SYNTHETIC',
      requirementVersion: 1,
      blocks: ['FREEZE'],
      requirementStatus: 'PENDING_SPECIFICATION',
      question: marker,
      decisionReference: marker,
      approvedAt: null,
      satisfied: false,
    },
  ];
  w.appGitSha = marker;
  Object.assign(w, { response_note: marker, password: marker });
  const r = formalPreparation(w);
  assert.equal(r.source_build, null);
  assert.ok(!JSON.stringify(r).includes(marker));
  assert.equal(r.decisions[0].approval_recorded, false);
});
