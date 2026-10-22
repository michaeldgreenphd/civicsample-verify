// SYNTHETIC ENGINEERING ONLY. Mapping-confirmation lifecycle on an in-memory database: campaign,
// synthetic import, assignment, visible assignment with isolated reviewers, finality, phases,
// independent adjudication, lock and the typed export. No real trial, label or person appears.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MC_FORBIDDEN_COLUMNS,
  MC_RESPONSE_COLUMNS,
  MC_CASE_COLUMNS,
} from '../src/lib/mapconf-export';
import {
  MC_SYNTHETIC_PILOT_CASES,
  MC_SYNTHETIC_TRAINING_CASES,
} from '../src/lib/mapconf-synthetic';
import { MC_RUBRIC_VERSION, mcRubricSha256, type McReviewerCase } from '../src/lib/mapconf-types';
import { mcAdjudicationSchema, mcSubmissionSchema } from '../src/lib/mapconf-validation';
import { DEMO_ACTORS, getDb, withActor } from '../src/server/db';
import {
  exportMcBundle,
  getMcAdjudicatorCase,
  getMcReviewerCase,
  getMcWorkspace,
  importMcCase,
  mcAdminAction,
  recordMcAdjudication,
  submitMc,
} from '../src/server/mapconf';
import { ServiceError } from '../src/server/service';

process.env.VERIFY_DB_DIR = 'memory';
process.env.VERIFY_APP_GIT_SHA = 'a'.repeat(40);
const [investigator, reviewerA, reviewerB, adjudicator] = DEMO_ACTORS;
const ATT = 'Synthetic attestation for testing only, at least twenty characters.';
// Field-shaped tokens that must never reach a reviewer or adjudicator DTO.
const hidden =
  /label_primary|selection_probability|sampling_weight|stratum|tier1|dev_linked|model|prompt|reasoning|clinicaltrials\.gov|request\.jwt|service_role|NCT\d{8}/i;
async function status(promise: Promise<unknown>): Promise<number> {
  try {
    await promise;
    return 200;
  } catch (e) {
    if (e instanceof ServiceError) return e.status;
    throw e;
  }
}
function submission(
  c: McReviewerCase,
  answer: 'YES' | 'NO' | 'INSUFFICIENT_INFORMATION',
  annotation?: string,
) {
  return mcSubmissionSchema.parse({
    answer,
    annotation,
    displayedAssignmentSha256: c.case.assignmentSha256,
    displayedEvidenceSha256: c.case.evidenceSha256,
    displayedEvidenceVersion: c.case.evidenceVersion,
    rubricVersion: c.campaign.rubricVersion,
    rubricSha256: c.campaign.rubricSha256,
    secondsOnCase: 12,
  });
}
after(async () => {
  await (await getDb()).close();
});

test('mapping confirmation: visible assignment, isolation, finality, adjudication timing, lock and export', async () => {
  // Nothing before the campaign; evaluation import is disabled regardless.
  assert.equal(await status(mcAdminAction(investigator, { action: 'import-synthetic' })), 409);
  assert.equal(await status(mcAdminAction(investigator, { action: 'import-evaluation' })), 409);
  assert.equal(await status(mcAdminAction(reviewerA, { action: 'create-campaign' })), 403);
  let inv = await mcAdminAction(investigator, { action: 'create-campaign' });
  assert.equal(inv.campaign?.phase, 'OPEN');
  assert.equal(inv.campaign?.reviewMode, 'MAPPING_CONFIRMATION');
  assert.equal(inv.campaign?.assignmentVisibility, 'EXISTING_ASSIGNMENT_VISIBLE');
  assert.equal(inv.campaign?.conditionSetStatus, 'PROPOSED');
  assert.equal(inv.campaign?.rubricSha256, mcRubricSha256());
  assert.equal(inv.conditions.length, 10);
  assert.equal(inv.evaluationImportAllowed, false);
  // The database itself refuses an EVALUATION record and a real registry reference, whatever the API does.
  assert.equal(
    await status(
      importMcCase(investigator, {
        ...MC_SYNTHETIC_PILOT_CASES[0],
        caseId: 'MC-EVAL-0001',
        recordCategory: 'EVALUATION',
        trialRef: 'SYN-NCT-7777',
      }),
    ),
    409,
  );
  assert.equal(
    await status(
      importMcCase(investigator, {
        ...MC_SYNTHETIC_PILOT_CASES[0],
        caseId: 'MC-SYN-REAL',
        trialRef: 'NCT' + '00000001',
      }),
    ),
    409,
  );
  inv = await mcAdminAction(investigator, { action: 'import-synthetic' });
  assert.equal(inv.counts.syntheticPilot, MC_SYNTHETIC_PILOT_CASES.length);
  assert.equal(inv.counts.trainingExample, MC_SYNTHETIC_TRAINING_CASES.length);
  assert.equal(await status(mcAdminAction(investigator, { action: 'import-synthetic' })), 409);
  // Reviewers see nothing until assigned, except the synthetic training walkthroughs.
  let wsA = await getMcWorkspace(reviewerA);
  assert.equal(wsA.kind, 'reviewer');
  if (wsA.kind !== 'reviewer') throw new Error('reviewer');
  assert.equal(wsA.queue.length, 0);
  inv = await mcAdminAction(investigator, { action: 'assign', seed: 7 });
  assert.deepEqual(
    inv.completion.map((r) => [r.reviewerSlot, r.assigned, r.submitted]),
    [
      [1, 12, 0],
      [2, 12, 0],
    ],
  );
  wsA = await getMcWorkspace(reviewerA);
  if (wsA.kind !== 'reviewer') throw new Error('reviewer');
  assert.equal(wsA.queue.length, 12);
  assert.equal(wsA.training.length, 3);
  assert.ok(wsA.training.every((t) => t.case?.recordCategory === 'TRAINING_EXAMPLE'));
  const wsB = await getMcWorkspace(reviewerB);
  if (wsB.kind !== 'reviewer') throw new Error('reviewer');
  // Each reviewer's queue is their own; the assignment ids differ per reviewer.
  assert.ok(wsA.queue.every((q) => !wsB.queue.some((r) => r.assignmentId === q.assignmentId)));
  // Queue order differs by seeded shuffle but covers the same cases.
  assert.deepEqual(
    [...wsA.queue.map((q) => q.caseId)].sort(),
    [...wsB.queue.map((q) => q.caseId)].sort(),
  );
  const aOf = (id: string) => wsA.queue.find((q) => q.caseId === id)!.assignmentId;
  const bOf = (id: string) => wsB.queue.find((q) => q.caseId === id)!.assignmentId;
  // The reviewer DTO carries the assignment under review and the source evidence, nothing hidden.
  const a1 = await getMcReviewerCase(reviewerA, aOf('MC-SYN-001'));
  assert.equal(a1.case.assignment.assigned, true);
  assert.equal(a1.case.conditionCode, 'OBE');
  assert.equal(a1.case.evidence.brief_summary.present, true);
  assert.ok(!hidden.test(JSON.stringify(a1)));
  assert.equal(a1.submissionsOpen, true);
  const a3 = await getMcReviewerCase(reviewerA, aOf('MC-SYN-003'));
  assert.equal(a3.case.evidence.brief_summary.present, false, 'missing summary stays missing');
  const a5 = await getMcReviewerCase(reviewerA, aOf('MC-SYN-005'));
  assert.equal(a5.case.evidence.detailed_description?.source_field, 'detailed_description');
  // A reviewer cannot open the other reviewer's assignment; the investigator cannot open any.
  assert.equal(await status(getMcReviewerCase(reviewerA, bOf('MC-SYN-001'))), 404);
  assert.equal(await status(getMcReviewerCase(investigator, aOf('MC-SYN-001'))), 403);
  assert.equal(await status(getMcReviewerCase(adjudicator, aOf('MC-SYN-001'))), 403);
  // Validation: NO needs an annotation; stale hashes are refused by the database.
  assert.throws(() => submission(a1, 'NO'));
  assert.equal(
    await status(
      submitMc(reviewerA, aOf('MC-SYN-001'), {
        ...submission(a1, 'YES'),
        displayedEvidenceSha256: '0'.repeat(64),
      }),
    ),
    409,
  );
  // Submissions: all YES except the planted disagreement and the insufficient-information case.
  for (const q of wsA.queue) {
    const c = await getMcReviewerCase(reviewerA, q.assignmentId);
    const answer = q.caseId === 'MC-SYN-012' ? 'INSUFFICIENT_INFORMATION' : 'YES';
    const result = await submitMc(
      reviewerA,
      q.assignmentId,
      submission(c, answer, answer === 'YES' ? undefined : 'Synthetic: the source has no summary.'),
    );
    assert.equal(result.ownResponse?.answer, answer);
    assert.equal(result.ownResponse?.rubricAdditionProposed, answer === 'INSUFFICIENT_INFORMATION');
    assert.equal(result.submissionsOpen, false);
  }
  // Finality: a second submission is refused; the investigator cannot submit at all.
  assert.equal(
    await status(submitMc(reviewerA, aOf('MC-SYN-001'), submission(a1, 'NO', 'x'))),
    409,
  );
  assert.equal(await status(submitMc(investigator, aOf('MC-SYN-001'), submission(a1, 'YES'))), 403);
  // Reviewer B never sees A's answers: the DTO for B's own assignment has no response yet.
  const b11 = await getMcReviewerCase(reviewerB, bOf('MC-SYN-011'));
  assert.equal(b11.ownResponse, null);
  assert.ok(!JSON.stringify(b11).includes('Synthetic: the source'));
  // The adjudicator sees nothing while the campaign is open, even for a complete case.
  for (const q of wsB.queue) {
    const c = await getMcReviewerCase(reviewerB, q.assignmentId);
    const answer =
      q.caseId === 'MC-SYN-011'
        ? 'NO'
        : q.caseId === 'MC-SYN-012'
          ? 'INSUFFICIENT_INFORMATION'
          : 'YES';
    await submitMc(
      reviewerB,
      q.assignmentId,
      submission(
        c,
        answer,
        answer === 'YES' ? undefined : 'Synthetic: healthy volunteers, no current infection.',
      ),
    );
  }
  let adj = await getMcWorkspace(adjudicator);
  if (adj.kind !== 'adjudicator') throw new Error('adjudicator');
  assert.equal(adj.queue.length, 0);
  assert.equal(await status(getMcAdjudicatorCase(adjudicator, 'MC-SYN-011')), 404);
  assert.equal(
    await status(
      recordMcAdjudication(
        adjudicator,
        mcAdjudicationSchema.parse({
          caseId: 'MC-SYN-011',
          decision: 'NO',
          status: 'DISCORDANT_RESOLVED',
          basis: 'REVIEWER_2',
          rationale: 'Synthetic.',
        }),
      ),
    ),
    409,
  );
  // Completion counts only; the investigator reads no answers while open (view is empty by RLS).
  inv = (await getMcWorkspace(investigator)) as typeof inv;
  assert.deepEqual(
    inv.completion.map((r) => r.submitted),
    [12, 12],
  );
  await withActor(investigator, async (tx) => {
    assert.equal((await tx.query('select * from public.mc_responses')).rows.length, 0);
  });
  // Phases: lock and adjudication need the close and the authorization, in order.
  assert.equal(
    await status(
      mcAdminAction(investigator, { action: 'phase', eventType: 'LOCKED', attestation: ATT }),
    ),
    409,
  );
  assert.equal(
    await status(
      mcAdminAction(investigator, {
        action: 'phase',
        eventType: 'ADJUDICATION_AUTHORIZED',
        attestation: ATT,
      }),
    ),
    409,
  );
  inv = await mcAdminAction(investigator, {
    action: 'phase',
    eventType: 'CLOSED',
    attestation: ATT,
  });
  assert.equal(inv.campaign?.phase, 'CLOSED');
  assert.equal(await status(submitMc(reviewerB, bOf('MC-SYN-001'), submission(b11, 'YES'))), 409);
  adj = await getMcWorkspace(adjudicator);
  if (adj.kind !== 'adjudicator') throw new Error('adjudicator');
  assert.equal(adj.queue.length, 0, 'closed but not authorized: still nothing');
  inv = await mcAdminAction(investigator, {
    action: 'phase',
    eventType: 'ADJUDICATION_AUTHORIZED',
    attestation: ATT,
  });
  assert.equal(inv.campaign?.phase, 'ADJUDICATION');
  adj = await getMcWorkspace(adjudicator);
  if (adj.kind !== 'adjudicator') throw new Error('adjudicator');
  assert.equal(adj.queue.length, 12);
  assert.deepEqual(
    adj.queue.filter((q) => q.needsAdjudication).map((q) => q.caseId),
    ['MC-SYN-011', 'MC-SYN-012'],
  );
  const detail = await getMcAdjudicatorCase(adjudicator, 'MC-SYN-011');
  assert.deepEqual(
    detail.responses.map((r) => [r.reviewerSlot, r.answer]),
    [
      [1, 'YES'],
      [2, 'NO'],
    ],
  );
  assert.ok(!hidden.test(JSON.stringify(detail)));
  // Investigator write denial and concordant refusal.
  const adjudication = mcAdjudicationSchema.parse({
    caseId: 'MC-SYN-011',
    decision: 'NO',
    status: 'DISCORDANT_RESOLVED',
    basis: 'REVIEWER_2',
    rationale: 'Synthetic: healthy volunteers are not a COVID-19 population.',
  });
  assert.equal(await status(recordMcAdjudication(investigator, adjudication)), 403);
  assert.equal(
    await status(recordMcAdjudication(adjudicator, { ...adjudication, caseId: 'MC-SYN-001' })),
    409,
  );
  assert.equal(
    await status(recordMcAdjudication(adjudicator, { ...adjudication, basis: 'REVIEWER_1' })),
    400,
    'reviewer 1 answered YES',
  );
  assert.equal(
    await status(recordMcAdjudication(adjudicator, { ...adjudication, basis: 'NEITHER' })),
    400,
    'reviewer 2 answered NO',
  );
  assert.equal(
    await status(
      mcAdminAction(investigator, { action: 'phase', eventType: 'LOCKED', attestation: ATT }),
    ),
    409,
    'open disagreement blocks the lock',
  );
  const decided = await recordMcAdjudication(adjudicator, adjudication);
  assert.equal(decided.adjudication?.decision, 'NO');
  assert.equal(
    await status(recordMcAdjudication(adjudicator, adjudication)),
    409,
    'one adjudication per mapping',
  );
  assert.equal(await status(exportMcBundle(investigator)), 409, 'no export before the lock');
  // MC-SYN-012 is concordant INSUFFICIENT_INFORMATION: the lock stays refused until the proposed
  // rubric addition is reviewed, and the review records no YES/NO judgment (migration 0018).
  assert.equal(
    await status(
      mcAdminAction(investigator, { action: 'phase', eventType: 'LOCKED', attestation: ATT }),
    ),
    409,
    'unreviewed rubric addition blocks the lock',
  );
  assert.equal(
    await status(
      recordMcAdjudication(
        adjudicator,
        mcAdjudicationSchema.parse({
          caseId: 'MC-SYN-012',
          decision: 'YES',
          status: 'DISCORDANT_RESOLVED',
          basis: 'REVIEWER_1',
          rationale: 'Synthetic: wrong status.',
        }),
      ),
    ),
    400,
  );
  assert.throws(() =>
    mcAdjudicationSchema.parse({
      caseId: 'MC-SYN-012',
      decision: 'YES',
      status: 'RUBRIC_ADDITION_REVIEWED',
      basis: 'NONE',
      rationale: 'Synthetic.',
    }),
  );
  const reviewed = await recordMcAdjudication(
    adjudicator,
    mcAdjudicationSchema.parse({
      caseId: 'MC-SYN-012',
      status: 'RUBRIC_ADDITION_REVIEWED',
      basis: 'NONE',
      rationale: 'Synthetic: both reviewers proposed the rubric addition.',
    }),
  );
  assert.equal(reviewed.adjudication?.decision, null);
  assert.equal(reviewed.adjudication?.status, 'RUBRIC_ADDITION_REVIEWED');
  inv = await mcAdminAction(investigator, {
    action: 'phase',
    eventType: 'LOCKED',
    attestation: ATT,
  });
  assert.equal(inv.campaign?.phase, 'LOCKED');
  assert.equal(
    await status(recordMcAdjudication(adjudicator, { ...adjudication, caseId: 'MC-SYN-002' })),
    409,
    'no adjudication after the lock',
  );
  // Export: typed contract, training excluded, no weights, provenance on every row.
  const bundle = await exportMcBundle(investigator);
  assert.equal(bundle.manifest.export_format_version, 'mapping-confirmation-1.0');
  assert.equal(bundle.manifest.review_mode, 'MAPPING_CONFIRMATION');
  assert.equal(bundle.manifest.assignment_visibility, 'EXISTING_ASSIGNMENT_VISIBLE');
  assert.equal(bundle.manifest.is_synthetic_fixture, true);
  assert.equal(bundle.manifest.training_examples_excluded, true);
  assert.equal(bundle.manifest.n_mappings, 12);
  assert.equal(bundle.manifest.n_responses, 24);
  assert.equal(bundle.manifest.n_adjudications, 2);
  assert.equal(bundle.manifest.rubric_version, MC_RUBRIC_VERSION);
  assert.equal(bundle.manifest.app_git_sha, 'a'.repeat(40));
  const responses = bundle.files.find((f) => f.role === 'responses')!;
  const cases = bundle.files.find((f) => f.role === 'cases')!;
  assert.equal(responses.content.split('\n')[0], MC_RESPONSE_COLUMNS.join(','));
  assert.equal(cases.content.split('\n')[0], MC_CASE_COLUMNS.join(','));
  for (const f of bundle.files) {
    assert.ok(!f.content.includes('MC-TRN-'), 'training examples never export');
    for (const column of MC_FORBIDDEN_COLUMNS)
      assert.ok(!f.content.split('\n')[0].includes(column));
  }
  const lines = responses.content.trim().split('\n').slice(1);
  assert.equal(lines.length, 24);
  assert.ok(lines.every((l) => l.includes('MAPPING_CONFIRMATION,EXISTING_ASSIGNMENT_VISIBLE')));
  assert.ok(cases.content.includes('MC-SYN-011') && cases.content.includes('DISCORDANT_RESOLVED'));
  assert.ok(cases.content.split('\n')[0].includes('assignment_assigned'));
  assert.ok(
    cases.content.includes('MC-SYN-012') && cases.content.includes('RUBRIC_ADDITION_REVIEWED'),
  );
  assert.ok(responses.content.split('\n')[0].includes('displayed_evidence_version'));
  assert.ok(
    lines.every((l) => l.includes(',1,MAPPING_CONFIRMATION_RUBRIC')),
    'evidence version 1 precedes the rubric version on every response row',
  );
  inv = await mcAdminAction(investigator, { action: 'register-export' });
  assert.equal(inv.exports.length, 1);
  assert.equal(inv.exports[0].manifestSha256, bundle.manifestSha256);
  // (The build-commit and rubric-drift refusals are exercised at the database boundary in
  // tests/mapconf-guards.test.ts; appGitSha falls back to the repository head here.)
  // Audit: responses are logged as identifiers and a hash only.
  await withActor(investigator, async (tx) => {
    const rows = await tx.query<{ details: Record<string, unknown> }>(
      "select details from public.audit_log where entity_table = 'mc_responses'",
    );
    assert.equal(rows.rows.length, 24);
    for (const r of rows.rows) {
      assert.deepEqual(Object.keys(r.details).sort(), [
        'assignment_id',
        'case_id',
        'content_sha256',
        'reviewer_pseudo_id',
      ]);
    }
  });
});
