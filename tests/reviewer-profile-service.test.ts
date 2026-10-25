import assert from 'node:assert/strict';
import test from 'node:test';
import { signedOffPilot, as, type Who } from './mu7-fixture';
import { mu7SqlData } from '../src/server/mu7';
import {
  getMu7Workspace,
  getMu7ReviewerUnit,
  mu7AdminAction,
  submitMu7,
  mu7PublicError,
  type Mu7Context,
} from '../src/server/mu7-core';
import { MU81_REVIEWER_PROFILE_ID, MU81_PROFILE_KEEP_TEXT } from '../src/lib/mu81-reviewer-profile';

test('revised-guide local practice uses the actual service and never rewrites a recorded campaign', async () => {
  const f = await signedOffPilot({ stopAfter: 'accounts' });
  const ctx = (who: Who, local = false): Mu7Context => ({
    role: who === 'inv' ? 'INVESTIGATOR' : 'REVIEWER',
    syntheticDatabase: true,
    appGitSha: 'a'.repeat(40),
    withData: (op) => as(f.db, who, () => op(mu7SqlData({ query: (q, p) => f.db.query(q, p) }))),
    ...(local
      ? { localTools: { lockAccount: async () => {}, unlockAccount: async () => {} } }
      : {}),
  });
  try {
    const input = {
      action: 'record-profile-design' as const,
      attestation: 'Synthetic practice with the revised guide only.',
    };
    await assert.rejects(mu7AdminAction(ctx('pt1', true), input), /role/);
    await assert.rejects(mu7AdminAction(ctx('inv'), input), /new local synthetic/);
    const initial = await getMu7Workspace(ctx('inv', true));
    assert.equal(initial.kind, 'investigator');
    if (initial.kind !== 'investigator') throw new Error('unexpected workspace');
    assert.equal(initial.canCreateProfilePilot, true);
    const created = await mu7AdminAction(ctx('inv', true), input);
    assert.equal(created.reviewerProfile?.profileId, MU81_REVIEWER_PROFILE_ID);
    assert.equal(created.canCreateProfilePilot, false);
    assert.match(
      created.reviewerProfile!.guideText,
      /Use the displayed MeSH parent heading for all ten areas/,
    );
    assert.ok(!JSON.stringify(created.reviewerProfile).includes(input.attestation));
    assert.equal(created.formalOperationsEnabled, false);
    assert.ok(created.gates.every((g) => !g.satisfied));
    await mu7AdminAction(ctx('inv', true), { action: 'import-pilot' });
    await mu7AdminAction(ctx('inv', true), { action: 'import-training' });
    await mu7AdminAction(ctx('inv', true), { action: 'assign-pilot' });
    const reviewer = await getMu7Workspace(ctx('pt1'));
    if (reviewer.kind !== 'reviewer') throw new Error('unexpected workspace');
    assert.equal(reviewer.queue.length, 12);
    assert.equal(reviewer.training.length, 3);
    const entry = reviewer.queue.find((q) => q.unitId.includes('RULE_K_KEPT'))!;
    await assert.rejects(getMu7ReviewerUnit(ctx('pt1'), entry.assignmentId), /MU7-G56/);
    const first = reviewer.queue.find((q) => q.unitRole === 'PRIMARY')!;
    await assert.rejects(
      submitMu7(ctx('pt1'), first.assignmentId, { answer: 'CANNOT_TELL' }),
      /MU81-P08/,
    );
    assert.equal(mu7PublicError('MU81-P08: Cannot tell requires a note')?.status, 400);
    for (const q of reviewer.queue.filter((q) => q.unitRole === 'PRIMARY'))
      await submitMu7(ctx('pt1'), q.assignmentId, { answer: 'AGREE' });
    const unit = await getMu7ReviewerUnit(ctx('pt1'), entry.assignmentId);
    assert.equal(unit.packet.unit.display_text, MU81_PROFILE_KEEP_TEXT);
    assert.ok(!unit.reasonCodes.some((r) => r.code === 'BENIGN_NEOPLASM'));
    await assert.rejects(mu7AdminAction(ctx('inv', true), input));
  } finally {
    await f.db.close();
  }
});
