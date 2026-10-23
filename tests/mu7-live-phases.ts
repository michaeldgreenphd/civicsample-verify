// The reviewer and adjudicator phases of the synthetic v7 pilot, shared by the live staging test
// (tests/staging-live-v7.test.ts, over PostgREST under each account's token) and the local rerun
// tests (tests/mu7-live-phases.test.ts). Both phases are resumable: whatever is already on record is
// read back and must equal the intended synthetic record, and only what is missing is written, so a
// rerun after a partial or complete run adds no revision and no second tie-break.
import assert from 'node:assert/strict';
import { MU7_PILOT_EXPECTED_ROUTING, MU7_PILOT_PLANTED } from '../src/lib/mu7-synthetic';
import type {
  Mu7AdjudicationInput,
  Mu7AdjudicatorUnit,
  Mu7AdjudicatorWorkspace,
  Mu7ReviewerWorkspace,
} from '../src/lib/mu7-types';
import * as core from '../src/server/mu7-core';
import { ServiceError } from '../src/server/service';

export async function outcome(p: Promise<unknown>) {
  try {
    await p;
    return { status: 200, message: '' };
  } catch (e) {
    if (e instanceof ServiceError) return { status: e.status, message: e.message };
    throw e;
  }
}
const planted = (unitId: string, slot: 1 | 2) =>
  MU7_PILOT_PLANTED[unitId].find((x) => x.reviewer_slot === slot)!;

export interface ReviewerSession {
  ctx: core.Mu7Context;
  slot: 1 | 2;
}
export async function reviewerPhase(sessions: ReviewerSession[]) {
  const stats = { submitted: 0, skipped: 0 };
  const queues: Mu7ReviewerWorkspace[] = [];
  for (const s of sessions) {
    const ws = (await core.getMu7Workspace(s.ctx)) as Mu7ReviewerWorkspace;
    assert.equal(ws.queue.length, 12, `slot ${s.slot}: 12 assigned units`);
    // Subgroup units stay closed only while a primary unit is unanswered; a resumed run may find
    // them open already, and a complete run finds every unit answered.
    const primaryDone = ws.queue.filter((q) => q.unitRole === 'PRIMARY').every((q) => q.answered);
    if (!primaryDone)
      assert.ok(
        ws.queue.filter((q) => q.unitRole === 'SUBGROUP').every((q) => !q.available),
        `slot ${s.slot}: subgroup units are closed while primary units are open`,
      );
    queues.push(ws);
  }
  if (sessions.length === 2)
    assert.equal(
      (await outcome(core.getMu7ReviewerUnit(sessions[1].ctx, queues[0].queue[0].assignmentId)))
        .status,
      404,
      'a reviewer never reaches the other reviewer’s assignment',
    );
  for (const [i, s] of sessions.entries()) {
    for (const item of queues[i].queue) {
      const unit = await core.getMu7ReviewerUnit(s.ctx, item.assignmentId);
      const p = planted(unit.packet.unit.unit_id, s.slot);
      const last = unit.ownAnswers.at(-1);
      if (last) {
        assert.equal(last.answer, p.answer, `${unit.packet.unit.unit_id}: answer on record`);
        assert.equal(
          last.reasonCode,
          p.reason_code,
          `${unit.packet.unit.unit_id}: reason on record`,
        );
        stats.skipped++;
        continue;
      }
      if (p.answer === 'DISAGREE')
        assert.match(
          (
            await outcome(
              core.submitMu7(s.ctx, item.assignmentId, {
                answer: 'DISAGREE',
                reasonCode: p.reason_code,
              }),
            )
          ).message,
          /^MU7-G36:/,
          'the planted refusal: a DISAGREE without a note',
        );
      await core.submitMu7(s.ctx, item.assignmentId, {
        answer: p.answer,
        reasonCode: p.reason_code,
        note: p.note,
        uncertain: p.uncertain,
      });
      stats.submitted++;
    }
  }
  return stats;
}

/** A new session reads every answer back; the latest answer of each unit is the planted one. */
export async function reviewerPersistence(s: ReviewerSession) {
  const ws = (await core.getMu7Workspace(s.ctx)) as Mu7ReviewerWorkspace;
  assert.ok(ws.queue.every((q) => q.answered));
  for (const item of ws.queue) {
    const unit = await core.getMu7ReviewerUnit(s.ctx, item.assignmentId);
    assert.equal(unit.ownAnswers.at(-1)?.answer, planted(unit.packet.unit.unit_id, s.slot).answer);
  }
}

/** The synthetic tie-break of a routed unit: adopt the reviewer who agreed, else escalate. */
export function intendedAdjudication(u: Mu7AdjudicatorUnit): Mu7AdjudicationInput {
  const agree = u.answers.filter((a) => a.answer === 'AGREE');
  if (agree.length === 1)
    return {
      unitId: u.unitId,
      decision: 'AGREE',
      status: 'DISCORDANT_RESOLVED',
      basis: agree[0].reviewerSlot === 1 ? 'REVIEWER_1' : 'REVIEWER_2',
      rationale: 'Synthetic pilot: the registry text supports the assignment.',
    };
  return {
    unitId: u.unitId,
    status: 'UNRESOLVED_ESCALATED',
    basis: 'NONE',
    rationale: 'Synthetic pilot: escalated, the registry text does not settle it.',
  };
}
function assertMatches(u: Mu7AdjudicatorUnit, intended: Mu7AdjudicationInput) {
  const a = u.adjudication!;
  assert.deepEqual(
    { decision: a.decision, status: a.status, basis: a.basis, rationale: a.rationale },
    {
      decision: intended.decision ?? null,
      status: intended.status,
      basis: intended.basis,
      rationale: intended.rationale,
    },
    `${u.unitId}: the tie-break on record is not the intended synthetic one`,
  );
}

export async function adjudicatorPhase(ctx: core.Mu7Context) {
  const stats = { recorded: 0, skipped: 0 };
  const ws = (await core.getMu7Workspace(ctx)) as Mu7AdjudicatorWorkspace;
  const routed = Object.entries(MU7_PILOT_EXPECTED_ROUTING)
    .filter(([, r]) => r === 'ROUTED')
    .map(([u]) => u)
    .sort();
  assert.deepEqual(
    ws.queue.map((q) => q.unitId),
    routed,
    'the adjudicator sees exactly the routed units',
  );
  const concordant = Object.entries(MU7_PILOT_EXPECTED_ROUTING).find(
    ([, r]) => r === 'CONCORDANT_AGREE',
  )![0];
  assert.equal((await outcome(core.getMu7AdjudicatorUnit(ctx, concordant))).status, 404);
  for (const unitId of routed) {
    const u = await core.getMu7AdjudicatorUnit(ctx, unitId);
    const intended = intendedAdjudication(u);
    if (u.adjudication) {
      assertMatches(u, intended);
      stats.skipped++;
      continue;
    }
    const done = await core.recordMu7Adjudication(ctx, intended);
    assertMatches(done, intended);
    stats.recorded++;
  }
  return stats;
}

/** Separate from the phase: a second tie-break of an adjudicated unit is refused. */
export async function adjudicationDuplicateRefused(ctx: core.Mu7Context, unitId: string) {
  const u = await core.getMu7AdjudicatorUnit(ctx, unitId);
  assert.ok(u.adjudication, 'the unit is adjudicated');
  const r = await outcome(
    core.recordMu7Adjudication(ctx, {
      ...intendedAdjudication(u),
      rationale: 'A second tie-break must be refused.',
    }),
  );
  assert.equal(r.status, 409);
}
