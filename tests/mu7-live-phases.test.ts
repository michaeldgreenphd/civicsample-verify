// The live pilot phases (tests/mu7-live-phases.ts) on a local copy of the full chain: reruns after a
// partial or a complete run write only what is missing and never add a revision or a second
// tie-break; a mismatched record on file stops the phase; and after the pilot lock a rerun changes
// nothing. The independent review of PR #11 (3d414f9) reproduced both failures on the earlier
// phase code. Synthetic data only.
import assert from 'node:assert/strict';
import test from 'node:test';
import type { Mu7ReviewerWorkspace } from '../src/lib/mu7-types';
import { MU7_PILOT_PLANTED } from '../src/lib/mu7-synthetic';
import * as core from '../src/server/mu7-core';
import { mu7SqlData } from '../src/server/mu7';
import {
  adjudicationDuplicateRefused,
  adjudicatorPhase,
  intendedAdjudication,
  reviewerPersistence,
  reviewerPhase,
} from './mu7-live-phases';
import { ATT, as, one, signedOffPilot, type FixtureDb, type Who } from './mu7-fixture';

function ctx(db: FixtureDb, who: Who, role: core.Mu7Context['role']): core.Mu7Context {
  return {
    role,
    withData: async (op) => {
      try {
        return await as(db, who, () =>
          op(mu7SqlData({ query: (sql, params) => db.query(sql, params) })),
        );
      } catch (e) {
        throw core.mu7PublicError((e as Error).message) ?? e;
      }
    },
    appGitSha: 'f'.repeat(40),
    syntheticDatabase: true,
  };
}
async function pilot() {
  const { db } = await signedOffPilot({ stopAfter: 'design' });
  const inv = ctx(db, 'inv', 'INVESTIGATOR');
  await core.mu7AdminAction(inv, { action: 'import-pilot' });
  await core.mu7AdminAction(inv, { action: 'import-training' });
  await core.mu7AdminAction(inv, { action: 'assign-pilot' });
  return {
    db,
    inv,
    r1: { ctx: ctx(db, 'pt1', 'REVIEWER'), slot: 1 as const },
    r2: { ctx: ctx(db, 'pt2', 'REVIEWER'), slot: 2 as const },
    adj: ctx(db, 'adj', 'ADJUDICATOR'),
  };
}
const judgments = async (db: FixtureDb) =>
  (await one(db, 'owner', 'select count(*)::int from public.mu7_judgments')) as number;
const revisions = async (db: FixtureDb) =>
  (await one(
    db,
    'owner',
    'select count(*)::int from public.mu7_judgments where revision_number > 1',
  )) as number;
const adjudications = async (db: FixtureDb) =>
  (await one(db, 'owner', 'select count(*)::int from public.mu7_adjudications')) as number;

test('reviewer phase: a rerun after reviewer 1 finished the primary units, and after the complete phase, adds no revision', async () => {
  const p = await pilot();
  try {
    // An earlier, interrupted run answered reviewer 1's eight primary units: subgroup units are open.
    const ws = (await core.getMu7Workspace(p.r1.ctx)) as Mu7ReviewerWorkspace;
    for (const item of ws.queue.filter((q) => q.unitRole === 'PRIMARY')) {
      const unit = await core.getMu7ReviewerUnit(p.r1.ctx, item.assignmentId);
      const a = MU7_PILOT_PLANTED[unit.packet.unit.unit_id].find((x) => x.reviewer_slot === 1)!;
      await core.submitMu7(p.r1.ctx, item.assignmentId, {
        answer: a.answer,
        reasonCode: a.reason_code,
        note: a.note,
        uncertain: a.uncertain,
      });
    }
    assert.equal(await judgments(p.db), 8);
    const resumed = await reviewerPhase([p.r1, p.r2]);
    assert.deepEqual(resumed, { submitted: 16, skipped: 8 });
    assert.equal(await judgments(p.db), 24);
    const again = await reviewerPhase([p.r1, p.r2]);
    assert.deepEqual(again, { submitted: 0, skipped: 24 });
    assert.equal(await judgments(p.db), 24);
    assert.equal(await revisions(p.db), 0);
    await reviewerPersistence(p.r1);
    await reviewerPersistence(p.r2);
  } finally {
    await p.db.close();
  }
});

test('adjudicator phase: a rerun after a partial and after the complete phase records only missing tie-breaks; the duplicate refusal is separate', async () => {
  const p = await pilot();
  try {
    await reviewerPhase([p.r1, p.r2]);
    // An earlier run recorded the first tie-break and stopped (for example, a lost response).
    const ws = (await core.getMu7Workspace(p.adj)) as { queue: { unitId: string }[] };
    const first = await core.getMu7AdjudicatorUnit(p.adj, ws.queue[0].unitId);
    await core.recordMu7Adjudication(p.adj, intendedAdjudication(first));
    assert.deepEqual(await adjudicatorPhase(p.adj), { recorded: 4, skipped: 1 });
    assert.equal(await adjudications(p.db), 5);
    assert.deepEqual(await adjudicatorPhase(p.adj), { recorded: 0, skipped: 5 });
    assert.equal(await adjudications(p.db), 5);
    await adjudicationDuplicateRefused(p.adj, ws.queue[0].unitId);
    assert.equal(await adjudications(p.db), 5);
    // After the pilot lock a rerun of both phases reads, validates and writes nothing.
    await core.mu7AdminAction(p.inv, { action: 'lock-pilot', attestation: ATT });
    const before = { j: await judgments(p.db), a: await adjudications(p.db) };
    assert.deepEqual(await reviewerPhase([p.r1, p.r2]), { submitted: 0, skipped: 24 });
    assert.deepEqual(await adjudicatorPhase(p.adj), { recorded: 0, skipped: 5 });
    assert.deepEqual({ j: await judgments(p.db), a: await adjudications(p.db) }, before);
  } finally {
    await p.db.close();
  }
});

test('adjudicator phase: a tie-break on record that differs from the intended one stops the phase, and nothing is overwritten', async () => {
  const p = await pilot();
  try {
    await reviewerPhase([p.r1, p.r2]);
    const ws = (await core.getMu7Workspace(p.adj)) as { queue: { unitId: string }[] };
    await core.recordMu7Adjudication(p.adj, {
      unitId: ws.queue[0].unitId,
      status: 'UNRESOLVED_ESCALATED',
      basis: 'NONE',
      rationale: 'A different synthetic tie-break.',
    });
    await assert.rejects(adjudicatorPhase(p.adj), /is not the intended synthetic one/);
    assert.equal(await adjudications(p.db), 1);
  } finally {
    await p.db.close();
  }
});
