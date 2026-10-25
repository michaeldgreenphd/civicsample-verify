// SYNTHETIC ENGINEERING ONLY. Review design v7 through the application's own service layer on the
// in-memory local database: design record, the 12 synthetic pilot units, read-only worked
// examples, both reviewer queues, independent answers with the planted refusals and a revision,
// tie-break adjudication of the routed units, the pilot lock and the bundle 7.0 export. Also the
// role and blinding boundaries and the account lock. FORMAL stays disabled throughout.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { MU7_EXPORT_COLUMNS } from '../src/lib/mu7-export';
import {
  MU7_PILOT_EXPECTED_ROUTING,
  MU7_PILOT_IMPORTS,
  MU7_PILOT_PLANTED,
} from '../src/lib/mu7-synthetic';
import type {
  Mu7AdjudicatorWorkspace,
  Mu7InvestigatorWorkspace,
  Mu7ReviewerWorkspace,
} from '../src/lib/mu7-types';
import { DEMO_ACTORS } from '../src/server/db';
import {
  acknowledgeMu7Training,
  exportMu7Bundle,
  getMu7AdjudicatorUnit,
  getMu7ReviewerUnit,
  getMu7Workspace,
  mu7AdminAction,
  recordMu7Adjudication,
  submitMu7,
} from '../src/server/mu7';
import { ServiceError } from '../src/server/service';

process.env.VERIFY_DB_DIR = 'memory';
process.env.VERIFY_APP_GIT_SHA = 'b'.repeat(40);
const [investigator, reviewerA, reviewerB, adjudicator] = DEMO_ACTORS;
const ATT = 'Synthetic attestation for the local v7 walkthrough only.';
const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
// Field-shaped tokens no reviewer or adjudicator DTO may carry (design rows, weights, exports).
const hiddenFromReviewers =
  /stratum|selection_probability|frame_stratum_size|prn_key|sampling_seed|design_row|assignment_set|walkthrough|planted|expected_routing|reviewer_pseudo_id/i;

async function refusal(promise: Promise<unknown>): Promise<{ status: number; message: string }> {
  try {
    await promise;
  } catch (e) {
    if (e instanceof ServiceError) return { status: e.status, message: e.message };
    throw e;
  }
  return { status: 200, message: '' };
}
const ws = <T>(actor: (typeof DEMO_ACTORS)[number]) => getMu7Workspace(actor) as Promise<T>;

test('v7 synthetic pilot through the application service, end to end', async () => {
  // ---- investigator setup ------------------------------------------------------------------
  let inv = await ws<Mu7InvestigatorWorkspace>(investigator);
  assert.equal(inv.design, null);
  assert.equal(inv.formalOperationsEnabled, false);
  assert.equal(inv.gates.length, 10);
  assert.ok(
    inv.gates.every((g) => !g.satisfied),
    'nothing is approved',
  );
  assert.deepEqual(
    inv.gates.filter((g) => g.requirementStatus === 'SPECIFIED').map((g) => g.gateId),
    ['G-MH-V53', 'G-PAIN-01'],
    'only the two gates migration 0028 specifies are ready for an approval',
  );
  assert.equal((await refusal(mu7AdminAction(reviewerA, { action: 'import-pilot' }))).status, 403);
  assert.match(
    (await refusal(mu7AdminAction(investigator, { action: 'import-pilot' }))).message,
    /^MU7-G10:/,
  );
  inv = await mu7AdminAction(investigator, { action: 'record-design', attestation: ATT });
  assert.equal(inv.design?.designVersion, 'SYN-7-SYNTHETIC-PILOT');
  // The empty pilot cannot be locked (migration 0026, MU7X-G02).
  assert.match(
    (await refusal(mu7AdminAction(investigator, { action: 'lock-pilot', attestation: ATT })))
      .message,
    /^MU7X-G02:/,
  );
  inv = await mu7AdminAction(investigator, { action: 'import-pilot' });
  assert.equal(inv.counts.pilotUnits, 12);
  assert.equal(
    (await refusal(mu7AdminAction(investigator, { action: 'import-pilot' }))).status,
    409,
  );
  inv = await mu7AdminAction(investigator, { action: 'import-training' });
  assert.equal(inv.counts.trainingUnits, 3);
  assert.equal(inv.training.length, 3);
  const trainingAdj = await ws<Mu7AdjudicatorWorkspace>(adjudicator);
  assert.equal(trainingAdj.training.length, 3);
  assert.equal(trainingAdj.queue.length, 0, 'examples do not expose actual answers before routing');
  assert.doesNotMatch(JSON.stringify(trainingAdj), hiddenFromReviewers);
  inv = await mu7AdminAction(investigator, { action: 'assign-pilot' });
  assert.equal(inv.counts.pilotQueue, 24);
  assert.equal(inv.pilotReviewers.length, 2);

  // ---- reviewers -----------------------------------------------------------------------------
  const queueA = await ws<Mu7ReviewerWorkspace>(reviewerA);
  const queueB = await ws<Mu7ReviewerWorkspace>(reviewerB);
  assert.equal(queueA.queue.length, 12);
  assert.equal(queueA.training.length, 3, 'the worked examples are readable');
  assert.ok(queueA.queue.slice(0, 8).every((q) => q.unitRole === 'PRIMARY' && q.available));
  assert.ok(queueA.queue.slice(8).every((q) => q.unitRole === 'SUBGROUP' && !q.available));
  assert.doesNotMatch(JSON.stringify(queueA), hiddenFromReviewers);
  // Training: read-only worked examples and an optional acknowledgment.
  const ack = await acknowledgeMu7Training(reviewerA);
  assert.match(ack.acknowledgedAt, /^\d{4}-\d{2}-\d{2}T/);
  // A subgroup unit opens only after every primary unit is answered (MU7-G56).
  const firstSg = queueA.queue.find((q) => q.unitRole === 'SUBGROUP')!;
  assert.match(
    (await refusal(getMu7ReviewerUnit(reviewerA, firstSg.assignmentId))).message,
    /^MU7-G56:/,
  );
  // Another reviewer's assignment is not found, never shown.
  assert.equal(
    (await refusal(getMu7ReviewerUnit(reviewerB, queueA.queue[0].assignmentId))).status,
    404,
  );
  assert.equal(
    (await refusal(submitMu7(reviewerB, queueA.queue[0].assignmentId, { answer: 'AGREE' }))).status,
    404,
  );
  assert.equal(
    (await refusal(getMu7ReviewerUnit(adjudicator, queueA.queue[0].assignmentId))).status,
    403,
  );

  const answerAll = async (
    actor: (typeof DEMO_ACTORS)[number],
    slot: 1 | 2,
    q: Mu7ReviewerWorkspace,
  ) => {
    for (const item of q.queue) {
      const unit = await getMu7ReviewerUnit(actor, item.assignmentId);
      assert.doesNotMatch(JSON.stringify(unit), hiddenFromReviewers);
      assert.equal(unit.ownAnswers.length, 0);
      const planted = MU7_PILOT_PLANTED[unit.packet.unit.unit_id].find(
        (p) => p.reviewer_slot === slot,
      )!;
      if (planted.answer === 'DISAGREE') {
        // The planted refusals: a DISAGREE without a note, and a reason code that does not fit.
        assert.match(
          (
            await refusal(
              submitMu7(actor, item.assignmentId, {
                answer: 'DISAGREE',
                reasonCode: planted.reason_code,
              }),
            )
          ).message,
          /^MU7-G36:/,
        );
        assert.match(
          (
            await refusal(
              submitMu7(actor, item.assignmentId, {
                answer: 'DISAGREE',
                reasonCode: 'NOT_A_REAL_CODE',
                note: 'synthetic',
              }),
            )
          ).message,
          /^MU7-G35:/,
        );
      }
      const saved = await submitMu7(actor, item.assignmentId, {
        answer: planted.answer,
        reasonCode: planted.reason_code,
        note: planted.note,
        uncertain: planted.uncertain,
        secondsOnUnit: 30,
      });
      assert.equal(saved.ownAnswers.length, 1);
      assert.equal(saved.ownAnswers[0].answer, planted.answer);
    }
  };
  await answerAll(reviewerA, 1, queueA);
  await answerAll(reviewerB, 2, queueB);
  // Save and reload: the answer is re-read from the database; a revision keeps the first answer.
  const firstA = queueA.queue[0];
  const reloaded = await getMu7ReviewerUnit(reviewerA, firstA.assignmentId);
  assert.equal(reloaded.ownAnswers.length, 1);
  const revised = await submitMu7(reviewerA, firstA.assignmentId, {
    answer: reloaded.ownAnswers[0].answer,
    uncertain: true,
    note: 'Synthetic note: revised to flag uncertainty.',
  });
  assert.deepEqual(
    revised.ownAnswers.map((a) => a.revisionNumber),
    [1, 2],
  );
  assert.ok((await ws<Mu7ReviewerWorkspace>(reviewerA)).queue.every((q) => q.answered));

  // ---- routing and adjudication --------------------------------------------------------------
  inv = await ws<Mu7InvestigatorWorkspace>(investigator);
  assert.deepEqual(inv.completion, [
    { reviewerSlot: 1, assigned: 12, answered: 12 },
    { reviewerSlot: 2, assigned: 12, answered: 12 },
  ]);
  assert.ok(
    inv.pilotRouting.every((r) => r.matches === true),
    'routing equals the walkthrough expectation',
  );
  const routed = Object.entries(MU7_PILOT_EXPECTED_ROUTING)
    .filter(([, r]) => r === 'ROUTED')
    .map(([u]) => u)
    .sort();
  assert.equal(routed.length, 5);
  const adjWs = await ws<Mu7AdjudicatorWorkspace>(adjudicator);
  assert.deepEqual(
    adjWs.queue.map((q) => q.unitId),
    routed,
    'the adjudicator sees only the routed units',
  );
  // The pilot cannot lock while routed units wait for the tie-break (0024 MU7-G48).
  assert.match(
    (await refusal(mu7AdminAction(investigator, { action: 'lock-pilot', attestation: ATT })))
      .message,
    /^MU7-G48:/,
  );
  assert.equal((await refusal(getMu7AdjudicatorUnit(reviewerA, routed[0]))).status, 403);
  // A concordant unit is not adjudicated.
  const concordant = Object.entries(MU7_PILOT_EXPECTED_ROUTING).find(
    ([, r]) => r === 'CONCORDANT_AGREE',
  )![0];
  assert.equal((await refusal(getMu7AdjudicatorUnit(adjudicator, concordant))).status, 404);
  for (const unitId of routed) {
    const u = await getMu7AdjudicatorUnit(adjudicator, unitId);
    assert.ok(
      u.answers[0].answer && u.answers[1].answer && u.answers[0].answer !== u.answers[1].answer,
    );
    const agreeSlot = u.answers.find((a) => a.answer === 'AGREE');
    const done = agreeSlot
      ? await recordMu7Adjudication(adjudicator, {
          unitId,
          decision: 'AGREE',
          status: 'DISCORDANT_RESOLVED',
          basis: agreeSlot.reviewerSlot === 1 ? 'REVIEWER_1' : 'REVIEWER_2',
          rationale: 'Synthetic: the registry text supports the assignment.',
        })
      : await recordMu7Adjudication(adjudicator, {
          unitId,
          status: 'UNRESOLVED_ESCALATED',
          basis: 'NONE',
          rationale: 'Synthetic: cannot be resolved from the registry.',
        });
    assert.ok(done.adjudication);
  }
  // No answer after the tie-break (0025 MU7X-G01).
  const routedItemA = (await ws<Mu7ReviewerWorkspace>(reviewerA)).queue.find(
    (q) => q.unitId === routed[0],
  )!;
  assert.match(
    (await refusal(submitMu7(reviewerA, routedItemA.assignmentId, { answer: 'CANNOT_TELL' })))
      .message,
    /^MU7X-G01:/,
  );

  // ---- account lock (local equivalent of the privileged identity tool) -----------------------
  assert.equal(
    (
      await refusal(
        mu7AdminAction(reviewerA, {
          action: 'lock-account',
          account: 'adjudicator',
          reason: 'synthetic test',
        }),
      )
    ).status,
    403,
  );
  await mu7AdminAction(investigator, {
    action: 'lock-account',
    account: 'adjudicator',
    reason: 'Synthetic lock test.',
  });
  assert.equal(
    (await refusal(getMu7Workspace(adjudicator))).status,
    403,
    'a locked account is refused at once',
  );
  await mu7AdminAction(investigator, { action: 'unlock-account', account: 'adjudicator' });
  assert.equal(
    (await ws<Mu7AdjudicatorWorkspace>(adjudicator)).queue.every((q) => q.adjudicated),
    true,
  );

  // ---- lock, export, registration ------------------------------------------------------------
  assert.match(
    (await refusal(exportMu7Bundle(investigator, 'PILOT'))).message,
    /Lock the PILOT reference/,
  );
  inv = await mu7AdminAction(investigator, { action: 'lock-pilot', attestation: ATT });
  assert.deepEqual(inv.pilotLock?.nUnitsLocked, 12);
  assert.match(
    (await refusal(submitMu7(reviewerB, queueB.queue[0].assignmentId, { answer: 'AGREE' })))
      .message,
    /^MU7-G34:/,
  );
  assert.equal((await refusal(exportMu7Bundle(reviewerA, 'PILOT'))).status, 403);
  assert.match(
    (await refusal(exportMu7Bundle(investigator, 'FORMAL'))).message,
    /Lock the FORMAL reference/,
  );
  const bundle = await exportMu7Bundle(investigator, 'PILOT');
  assert.equal(bundle.manifest.mode, 'PILOT');
  assert.match(String(bundle.manifest.status), /^SYNTHETIC PILOT: excluded from every statistic/);
  assert.equal(bundle.manifestSha256, sha256(bundle.manifestText));
  const files = bundle.manifest.files as Record<string, string>;
  for (const f of bundle.files) {
    assert.equal(files[f.name], sha256(f.content), `${f.name} hash`);
    assert.equal(
      f.content.split('\n')[0],
      MU7_EXPORT_COLUMNS[f.role as keyof typeof MU7_EXPORT_COLUMNS].join(','),
      `${f.name} columns`,
    );
    assert.doesNotMatch(f.content, /walkthrough|planted|expected_routing/);
  }
  assert.deepEqual(Object.fromEntries(bundle.files.map((f) => [f.role, f.rows])), {
    units: 12,
    unit_design: 12,
    independent_judgments: 24,
    final_reference: 12,
  });
  const finalRef = bundle.files.find((f) => f.role === 'final_reference')!.content;
  assert.ok(!finalRef.includes('PENDING_ADJUDICATION'));
  assert.equal(MU7_PILOT_IMPORTS.length, 12);
  inv = await mu7AdminAction(investigator, {
    action: 'register-pilot-export',
    notes: 'Synthetic local walkthrough.',
  });
  assert.equal(inv.exports.length, 1);
  assert.equal(inv.exports[0].manifestSha256, bundle.manifestSha256);
  // ---- gate approval controls (the investigator's own act) -----------------------------------
  const PAIN_ATT = 'Synthetic local approval of G-PAIN-01 for the regression only.';
  assert.equal(
    (
      await refusal(
        mu7AdminAction(reviewerA, {
          action: 'approve-gate',
          gateId: 'G-PAIN-01',
          attestation: PAIN_ATT,
        }),
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await refusal(
        mu7AdminAction(adjudicator, {
          action: 'approve-gate',
          gateId: 'G-PAIN-01',
          attestation: PAIN_ATT,
        }),
      )
    ).status,
    403,
  );
  assert.match(
    (
      await refusal(
        mu7AdminAction(investigator, {
          action: 'approve-gate',
          gateId: 'G-OVERLAP-01',
          attestation: PAIN_ATT,
        }),
      )
    ).message,
    /pending specification/,
  );
  inv = await mu7AdminAction(investigator, {
    action: 'approve-gate',
    gateId: 'G-PAIN-01',
    attestation: PAIN_ATT,
  });
  const pain = inv.gates.find((g) => g.gateId === 'G-PAIN-01')!;
  assert.equal(pain.satisfied, true);
  // Migration 0032 (version 3): the record of addendum 8, item 40 and addendum 11, item 60 with rubric 7.1.
  assert.equal(
    pain.decisionReference,
    'investigator decisions 2026-10-23, addendum 8, item 40, and addendum 11, item 60, with rubric 7.1 (SHA-256 9ab8d6a9aa146b648358c7f3993068a8963146861a5d0b04ae5d6e1bda60cf46)',
  );
  assert.equal(inv.formalOperationsEnabled, false);
  assert.doesNotMatch(inv.formalDisabledReason, /G-PAIN-01/);
  // Since 0032, G-EST-01, G-OQ-03 and G-OQ-04 hold the freeze as well as the opening.
  assert.match(
    inv.formalDisabledReason,
    /The FORMAL freeze waits for G-EST-01, G-MH-V53, G-OQ-03, G-OQ-04, G-OVERLAP-01, G-PROV-01, G-TEXT-01;/,
  );
  for (const gateId of ['G-EST-01', 'G-OQ-03', 'G-OQ-04'])
    assert.match(
      (
        await refusal(
          mu7AdminAction(investigator, {
            action: 'approve-gate',
            gateId,
            attestation: PAIN_ATT,
          }),
        )
      ).message,
      /pending specification/,
      `${gateId} cannot be approved before it is specified`,
    );
  assert.equal(
    (
      await refusal(
        mu7AdminAction(investigator, {
          action: 'approve-gate',
          gateId: 'G-PAIN-01',
          attestation: PAIN_ATT,
        }),
      )
    ).status,
    409,
    'an approval is recorded once',
  );
  // Nothing FORMAL happened.
  assert.equal(inv.counts.formalUnits, 0);
  assert.ok(!inv.phaseEvents.some((e) => e.eventType.startsWith('FORMAL')));
});
