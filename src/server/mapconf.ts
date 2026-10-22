// Mapping-confirmation service layer (docs/MAPPING_CONFIRMATION.md). Every write goes through an
// rpc_mc_* function under the signed-in actor's session; every read goes through the mc_ tables
// and views, so row-level security decides what each role receives. The DTOs here are explicit
// allow-lists: the assignment under review and the source evidence reach the reviewer; model
// reasoning, unrelated predictions and other reviewers' answers never do.
import {
  MC_ASSIGNMENT_VISIBILITY,
  MC_CONDITIONS,
  MC_CONDITION_SET_ID,
  MC_CONDITION_SET_STATUS,
  MC_REVIEW_MODE,
  MC_RUBRIC_VERSION,
  mcRubricSha256,
  type McAdjudicationInput,
  type McAdjudicationStatus,
  type McAdjudicatorCase,
  type McAdjudicatorWorkspace,
  type McAdminAction,
  type McAnswer,
  type McAssignmentUnderReview,
  type McBundle,
  type McCampaignState,
  type McCaseInput,
  type McCaseView,
  type McEvidence,
  type McInvestigatorWorkspace,
  type McReviewerCase,
  type McReviewerWorkspace,
  type McSubmissionInput,
  type McTrainingExample,
  type McWorkspace,
} from '../lib/mapconf-types';
import { buildMcBundle, mcManifestText, type Row } from '../lib/mapconf-export';
import {
  MC_SYNTHETIC_PILOT_CASES,
  MC_SYNTHETIC_TRAINING_CASES,
  MC_SYNTHETIC_TRAINING_WALKTHROUGHS,
} from '../lib/mapconf-synthetic';
import type { Actor } from '../lib/types';
import { DEMO_ACTORS, withActor } from './db';
import { ServiceError } from './service';
import { appGitSha } from './tlv5';

type Tx = Parameters<Parameters<typeof withActor>[1]>[0];
const TS = (column: string) =>
  `to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CASE_ID = /^MC-(SYN|TRN|EVAL)-[A-Z0-9][A-Z0-9-]{1,40}$/;

// Fixed public messages only; SQL text never reaches a client.
const PUBLIC_ERRORS: [RegExp, number, string][] = [
  [
    /not your mapping assignment|only the investigator changes|ADJUDICATOR role is needed|An active ADJUDICATOR|investigator role|permission denied|Authenticated role mismatch/,
    403,
    'This action is not available to your role.',
  ],
  [
    /conflict: the adjudicator reviewed/,
    403,
    'Conflict: an adjudicator cannot adjudicate a mapping they reviewed.',
  ],
  [
    /final mapping response is locked|campaign is closed; mapping responses are final/,
    409,
    'Submissions are closed for this mapping.',
  ],
  [
    /does not reference the assignment and evidence currently on record|does not reference the campaign rubric/,
    409,
    'The mapping changed since it was displayed. Reload it and review again.',
  ],
  [/Two independent final submissions/, 409, 'Both reviewers must submit before adjudication.'],
  [
    /reviewers agree on mapping|concordant mappings are not adjudicated/,
    409,
    'The reviewers agree on this mapping; it is not adjudicated.',
  ],
  [
    /both reviewers proposed a rubric addition/,
    400,
    'Both reviewers proposed a rubric addition; use the rubric-addition or escalation status.',
  ],
  [
    /mapping adjudication opens only after|disagreeing mappings have no adjudication|disagreeing or insufficient-information mappings have no adjudication|is not open|close the campaign before|authorize adjudication before|only while the campaign is open|registered only after the lock/,
    409,
    'This phase transition or action is not allowed now.',
  ],
  [/create the mapping-confirmation campaign/, 409, 'Create the campaign first.'],
  [
    /evaluation import is disabled pending|only synthetic trial references/,
    409,
    'Evaluation import is disabled pending the approved condition set, sampling frame, frozen rubric and analysis specification.',
  ],
  [
    /have no final response; an incomplete campaign cannot be locked|lack two final responses; an incomplete campaign cannot be locked/,
    409,
    'Every mapping needs a final response from both reviewer slots before the campaign can be locked.',
  ],
  [
    /lack a second reviewer assignment; the campaign cannot be closed/,
    409,
    'Every mapping needs both reviewer slots assigned before the campaign can be closed.',
  ],
  [/require READ COMMITTED isolation/, 409, 'This phase transition or action is not allowed now.'],
  [
    /RUBRIC_ADDITION_REVIEWED applies only when|basis (REVIEWER_1|REVIEWER_2|NEITHER) does not match the reviewer answers for mapping/,
    400,
    'The adjudication status, decision and basis do not fit the reviewer answers for this mapping.',
  ],
  [
    /names condition set .* but the campaign is|is not an accepted registry source name|is not an accepted provenance value|is not a reviewer-visible registry field|schema_version must be|names a field that is not a registry description/,
    400,
    'The mapping import does not match the campaign condition set or the evidence contract.',
  ],
  [
    /mode contamination blocked|already holds slot|withdrawn or inactive/,
    409,
    'Reviewer scope, role or slot conflict.',
  ],
  [
    /not on the reviewer-visible allow list|could carry a prediction|no registry link|never generate or substitute|needs brief_title|present flag|provenance|source needs/,
    400,
    'The evidence carries a field the reviewer must never see, or lacks required provenance.',
  ],
  [
    /duplicate key|already/,
    409,
    'This step was already recorded or conflicts with an existing record.',
  ],
  [
    /check constraint|violates|invalid input/,
    400,
    'The input breaks the mapping-confirmation rules.',
  ],
];

async function run<T>(actor: Actor, operation: (tx: Tx) => Promise<T>): Promise<T> {
  try {
    return await withActor(actor, operation);
  } catch (error) {
    if (error instanceof ServiceError) throw error;
    const message = error instanceof Error ? error.message : '';
    for (const [pattern, status, text] of PUBLIC_ERRORS)
      if (pattern.test(message)) throw new ServiceError(status, text);
    throw new ServiceError(500, 'The local review database could not complete this request.');
  }
}
function requireRole(actor: Actor, ...roles: Actor['role'][]) {
  if (!roles.includes(actor.role))
    throw new ServiceError(403, 'This action is not available to your role.');
}
const notFound = () => new ServiceError(404, 'Resource not available.');

interface CampaignRow {
  condition_set_id: string;
  condition_set_status: 'PROPOSED' | 'APPROVED';
  rubric_version: string;
  rubric_sha256: string;
  phase: McCampaignState['phase'];
  created_at: string;
}
async function readCampaign(tx: Tx): Promise<McCampaignState | null> {
  const row = (
    await tx.query<CampaignRow>(
      `select condition_set_id, condition_set_status, rubric_version, rubric_sha256, phase, ${TS('created_at')} as created_at from public.mc_campaign`,
    )
  ).rows[0];
  if (!row) return null;
  return {
    reviewMode: MC_REVIEW_MODE,
    assignmentVisibility: MC_ASSIGNMENT_VISIBILITY,
    conditionSetId: row.condition_set_id,
    conditionSetStatus: row.condition_set_status,
    rubricVersion: row.rubric_version,
    rubricSha256: row.rubric_sha256,
    phase: row.phase,
    createdAt: row.created_at,
  };
}
interface CaseRow {
  case_id: string;
  record_category: McCaseView['recordCategory'];
  trial_ref: string;
  condition_code: string;
  condition_label: string;
  condition_set_id: string;
  assignment: McAssignmentUnderReview;
  assignment_sha256: string;
  evidence: McEvidence;
  evidence_sha256: string;
  evidence_version: number;
}
const CASE_SELECT =
  'select case_id, record_category, trial_ref, condition_code, condition_label, condition_set_id, assignment, assignment_sha256, evidence, evidence_sha256, evidence_version from public.mc_cases';
/** Allow-listed projection: only the keys the migration admits, re-selected by name. */
function caseView(row: CaseRow): McCaseView {
  const e = row.evidence;
  const evidence: McEvidence = {
    schema_version: e.schema_version,
    brief_title: e.brief_title,
    brief_summary: e.brief_summary.present
      ? { present: true, text: e.brief_summary.text }
      : { present: false },
    source: { system: e.source.system, version: e.source.version, fields: [...e.source.fields] },
  };
  if (e.detailed_description)
    evidence.detailed_description = e.detailed_description.present
      ? {
          present: true,
          text: e.detailed_description.text,
          source_field: e.detailed_description.source_field,
        }
      : { present: false, source_field: e.detailed_description.source_field };
  return {
    caseId: row.case_id,
    recordCategory: row.record_category,
    trialRef: row.trial_ref,
    conditionCode: row.condition_code,
    conditionLabel: row.condition_label,
    conditionSetId: row.condition_set_id,
    assignment: {
      assigned: row.assignment.assigned,
      assignment_source: row.assignment.assignment_source,
      assignment_version: row.assignment.assignment_version,
    },
    assignmentSha256: row.assignment_sha256,
    evidence,
    evidenceSha256: row.evidence_sha256,
    evidenceVersion: Number(row.evidence_version),
  };
}
async function readTraining(tx: Tx): Promise<McTrainingExample[]> {
  const rows = (
    await tx.query<CaseRow>(
      `${CASE_SELECT} where record_category = 'TRAINING_EXAMPLE' order by case_id`,
    )
  ).rows;
  return MC_SYNTHETIC_TRAINING_WALKTHROUGHS.map((walkthrough) => {
    const row = rows.find((r) => r.case_id === walkthrough.caseId);
    return { caseId: walkthrough.caseId, case: row ? caseView(row) : null, walkthrough };
  });
}

// ---------------------------------------------------------------------------------------------
// Workspaces
// ---------------------------------------------------------------------------------------------
export async function getMcWorkspace(actor: Actor): Promise<McWorkspace> {
  if (actor.role === 'INVESTIGATOR') return getMcInvestigatorWorkspace(actor);
  if (actor.role === 'ADJUDICATOR') return getMcAdjudicatorWorkspace(actor);
  return run(actor, async (tx): Promise<McReviewerWorkspace> => {
    const queue = (
      await tx.query<{
        assignment_id: string;
        case_id: string;
        queue_position: number;
        record_category: McCaseView['recordCategory'];
        condition_code: string;
        condition_label: string;
        brief_title: string;
        submitted: boolean;
      }>('select * from public.v_mc_my_queue order by queue_position')
    ).rows.map((r) => ({
      assignmentId: r.assignment_id,
      caseId: r.case_id,
      queuePosition: Number(r.queue_position),
      recordCategory: r.record_category,
      conditionCode: r.condition_code,
      conditionLabel: r.condition_label,
      briefTitle: r.brief_title,
      submitted: r.submitted,
    }));
    return {
      kind: 'reviewer',
      campaign: await readCampaign(tx),
      queue,
      training: await readTraining(tx),
    };
  });
}
async function getMcAdjudicatorWorkspace(actor: Actor): Promise<McAdjudicatorWorkspace> {
  requireRole(actor, 'ADJUDICATOR');
  return run(actor, async (tx) => {
    const queue = (
      await tx.query<{
        case_id: string;
        record_category: McCaseView['recordCategory'];
        condition_code: string;
        condition_label: string;
        brief_title: string;
        reviewer_1_answer: McAnswer | null;
        reviewer_2_answer: McAnswer | null;
        needs_adjudication: boolean;
        adjudicated: boolean;
      }>('select * from public.v_mc_adjudication_queue order by case_id')
    ).rows.map((r) => ({
      caseId: r.case_id,
      recordCategory: r.record_category,
      conditionCode: r.condition_code,
      conditionLabel: r.condition_label,
      briefTitle: r.brief_title,
      reviewer1Answer: r.reviewer_1_answer,
      reviewer2Answer: r.reviewer_2_answer,
      needsAdjudication: r.needs_adjudication,
      adjudicated: r.adjudicated,
    }));
    return {
      kind: 'adjudicator',
      campaign: await readCampaign(tx),
      queue,
      training: await readTraining(tx),
    };
  });
}
async function getMcInvestigatorWorkspace(actor: Actor): Promise<McInvestigatorWorkspace> {
  requireRole(actor, 'INVESTIGATOR');
  return run(actor, async (tx) => {
    const counts = (
      await tx.query<{ record_category: string; n: number | string }>(
        'select record_category, count(*) as n from public.mc_cases group by record_category',
      )
    ).rows;
    const count = (category: string) =>
      Number(counts.find((c) => c.record_category === category)?.n ?? 0);
    const completion = (
      await tx.query<{
        reviewer_pseudo_id: string;
        reviewer_slot: number;
        n_assigned: number | string;
        n_submitted: number | string;
      }>('select * from public.rpc_mc_completion_summary()')
    ).rows.map((r) => ({
      reviewerPseudoId: r.reviewer_pseudo_id,
      reviewerSlot: Number(r.reviewer_slot),
      assigned: Number(r.n_assigned),
      submitted: Number(r.n_submitted),
    }));
    const reviewers = (
      await tx.query<{ reviewer_pseudo_id: string; mode_scope: 'PILOT' | 'FORMAL' }>(
        'select reviewer_pseudo_id, mode_scope from public.reviewers where withdrawn_at is null order by reviewer_pseudo_id',
      )
    ).rows.map((r) => ({ pseudoId: r.reviewer_pseudo_id, modeScope: r.mode_scope }));
    const events = (
      await tx.query<{
        event_type: McInvestigatorWorkspace['events'][number]['eventType'];
        occurred_at: string;
      }>(
        `select event_type, ${TS('occurred_at')} as occurred_at from public.mc_campaign_events order by event_seq`,
      )
    ).rows.map((r) => ({ eventType: r.event_type, occurredAt: r.occurred_at }));
    const exports = (
      await tx.query<{ export_id: string; created_at: string; manifest_sha256: string }>(
        `select export_id, ${TS('created_at')} as created_at, manifest_sha256 from public.mc_exports order by created_at`,
      )
    ).rows.map((r) => ({
      exportId: r.export_id,
      createdAt: r.created_at,
      manifestSha256: r.manifest_sha256,
    }));
    const adjudications = await tx.query<{ n: number | string }>(
      'select count(*) as n from public.mc_adjudications',
    );
    return {
      kind: 'investigator',
      campaign: await readCampaign(tx),
      conditions: MC_CONDITIONS.map((c) => ({ ...c })),
      counts: {
        syntheticPilot: count('SYNTHETIC_PILOT'),
        trainingExample: count('TRAINING_EXAMPLE'),
        evaluation: count('EVALUATION'),
      },
      completion,
      reviewers,
      events,
      exports,
      adjudicationsRecorded: Number(adjudications.rows[0].n),
      evaluationImportAllowed: false,
      appGitSha: appGitSha(),
    };
  });
}

// ---------------------------------------------------------------------------------------------
// Reviewer
// ---------------------------------------------------------------------------------------------
export async function getMcReviewerCase(
  actor: Actor,
  assignmentId: string,
): Promise<McReviewerCase> {
  requireRole(actor, 'REVIEWER');
  if (!UUID.test(assignmentId)) throw notFound();
  return run(actor, async (tx) => {
    const a = (
      await tx.query<{ assignment_id: string; case_id: string }>(
        'select assignment_id, case_id from public.mc_assignments where assignment_id = $1 and reviewer_pseudo_id = private.my_reviewer_pseudo_id()',
        [assignmentId],
      )
    ).rows[0];
    if (!a) throw notFound();
    const c = (await tx.query<CaseRow>(`${CASE_SELECT} where case_id = $1`, [a.case_id])).rows[0];
    const campaign = await readCampaign(tx);
    if (!c || !campaign) throw notFound();
    const own = (
      await tx.query<{
        answer: McAnswer;
        annotation: string | null;
        rubric_addition_proposed: boolean;
        submitted_at: string;
      }>(
        `select answer, annotation, rubric_addition_proposed, ${TS('submitted_at')} as submitted_at from public.mc_responses where assignment_id = $1`,
        [assignmentId],
      )
    ).rows[0];
    return {
      assignmentId,
      case: caseView(c),
      campaign,
      submissionsOpen: campaign.phase === 'OPEN' && !own,
      ownResponse: own
        ? {
            answer: own.answer,
            annotation: own.annotation,
            rubricAdditionProposed: own.rubric_addition_proposed,
            submittedAt: own.submitted_at,
          }
        : null,
    };
  });
}
export async function submitMc(
  actor: Actor,
  assignmentId: string,
  input: McSubmissionInput,
): Promise<McReviewerCase> {
  requireRole(actor, 'REVIEWER');
  if (!UUID.test(assignmentId)) throw notFound();
  await run(actor, (tx) =>
    tx.query('select public.rpc_mc_submit($1, $2::jsonb)', [
      assignmentId,
      JSON.stringify({
        answer: input.answer,
        annotation: input.annotation ?? null,
        displayed_assignment_sha256: input.displayedAssignmentSha256,
        displayed_evidence_sha256: input.displayedEvidenceSha256,
        displayed_evidence_version: input.displayedEvidenceVersion,
        rubric_version: input.rubricVersion,
        rubric_sha256: input.rubricSha256,
        app_git_sha: appGitSha(),
        seconds_on_case: input.secondsOnCase ?? null,
      }),
    ]),
  );
  return getMcReviewerCase(actor, assignmentId);
}

// ---------------------------------------------------------------------------------------------
// Adjudicator
// ---------------------------------------------------------------------------------------------
export async function getMcAdjudicatorCase(
  actor: Actor,
  caseId: string,
): Promise<McAdjudicatorCase> {
  requireRole(actor, 'ADJUDICATOR');
  if (!CASE_ID.test(caseId)) throw notFound();
  return run(actor, async (tx) => {
    // The view and the table policies refuse incomplete cases and the wrong phase.
    const inQueue = await tx.query(
      'select 1 from public.v_mc_adjudication_queue where case_id = $1',
      [caseId],
    );
    const c = (await tx.query<CaseRow>(`${CASE_SELECT} where case_id = $1`, [caseId])).rows[0];
    const campaign = await readCampaign(tx);
    if (!inQueue.rows.length || !c || !campaign) throw notFound();
    const responses = (
      await tx.query<{
        reviewer_slot: number;
        answer: McAnswer;
        annotation: string | null;
        rubric_addition_proposed: boolean;
      }>(
        'select a.reviewer_slot, r.answer, r.annotation, r.rubric_addition_proposed from public.mc_assignments a join public.mc_responses r on r.assignment_id = a.assignment_id where a.case_id = $1 order by a.reviewer_slot',
        [caseId],
      )
    ).rows.map((r) => ({
      reviewerSlot: Number(r.reviewer_slot) as 1 | 2,
      answer: r.answer,
      annotation: r.annotation,
      rubricAdditionProposed: r.rubric_addition_proposed,
    }));
    const j = (
      await tx.query<{
        adjudication_id: string;
        decision: 'YES' | 'NO' | null;
        status: McAdjudicationStatus;
        basis: 'REVIEWER_1' | 'REVIEWER_2' | 'NEITHER' | 'NONE';
        rationale: string;
        decided_at: string;
      }>(
        `select adjudication_id, decision, status, basis, rationale, ${TS('decided_at')} as decided_at from public.mc_adjudications where case_id = $1`,
        [caseId],
      )
    ).rows[0];
    return {
      case: caseView(c),
      campaign,
      responses,
      adjudication: j
        ? {
            adjudicationId: j.adjudication_id,
            caseId,
            decision: j.decision,
            status: j.status,
            basis: j.basis,
            rationale: j.rationale,
            decidedAt: j.decided_at,
          }
        : null,
    };
  });
}
export async function recordMcAdjudication(
  actor: Actor,
  input: McAdjudicationInput,
): Promise<McAdjudicatorCase> {
  requireRole(actor, 'ADJUDICATOR');
  await run(actor, (tx) =>
    tx.query('select public.rpc_mc_adjudicate($1::jsonb)', [
      JSON.stringify({
        case_id: input.caseId,
        decision: input.decision ?? null,
        status: input.status,
        basis: input.basis,
        rationale: input.rationale,
      }),
    ]),
  );
  return getMcAdjudicatorCase(actor, input.caseId);
}

// ---------------------------------------------------------------------------------------------
// Investigator
// ---------------------------------------------------------------------------------------------
export async function importMcCase(actor: Actor, c: McCaseInput): Promise<string> {
  requireRole(actor, 'INVESTIGATOR');
  return run(actor, async (tx) => importCase(tx, c));
}
async function importCase(tx: Tx, c: McCaseInput): Promise<string> {
  return (
    await tx.query<{ id: string }>('select public.rpc_mc_import_case($1::jsonb) as id', [
      JSON.stringify({
        case_id: c.caseId,
        record_category: c.recordCategory,
        trial_ref: c.trialRef,
        condition_code: c.conditionCode,
        condition_label: c.conditionLabel,
        condition_set_id: MC_CONDITION_SET_ID,
        assignment: c.assignment,
        evidence: c.evidence,
      }),
    ])
  ).rows[0].id;
}
export async function mcAdminAction(
  actor: Actor,
  input: McAdminAction,
): Promise<McInvestigatorWorkspace> {
  requireRole(actor, 'INVESTIGATOR');
  switch (input.action) {
    case 'create-campaign':
      await run(actor, (tx) =>
        tx.query('select public.rpc_mc_create_campaign($1::jsonb)', [
          JSON.stringify({
            condition_set_id: MC_CONDITION_SET_ID,
            condition_set_status: MC_CONDITION_SET_STATUS,
            rubric_version: MC_RUBRIC_VERSION,
            rubric_sha256: mcRubricSha256(),
          }),
        ]),
      );
      break;
    case 'import-synthetic':
      await run(actor, async (tx) => {
        const existing = await tx.query<{ n: number | string }>(
          "select count(*) as n from public.mc_cases where record_category <> 'EVALUATION'",
        );
        if (Number(existing.rows[0].n))
          throw new ServiceError(409, 'The synthetic mappings are already imported.');
        for (const c of [...MC_SYNTHETIC_PILOT_CASES, ...MC_SYNTHETIC_TRAINING_CASES])
          await importCase(tx, c);
      });
      break;
    case 'import-evaluation':
      // The 100 evaluation mappings need the approved condition set, sampling frame and control
      // coverage, the frozen rubric and an analysis specification; none exists, and the public
      // application never carries real registry records.
      throw new ServiceError(
        409,
        'Evaluation import is disabled pending the approved condition set, sampling frame, frozen rubric and analysis specification.',
      );
    case 'assign':
      await run(actor, async (tx) => {
        // The two investigator-operated pilot test accounts, enrolled on first use (v2 path).
        for (const pilotActor of [DEMO_ACTORS[1], DEMO_ACTORS[2]]) {
          const has = await tx.query<{ n: number | string }>(
            'select count(*) as n from public.reviewers where user_id = $1 and withdrawn_at is null',
            [pilotActor.id],
          );
          if (!Number(has.rows[0].n))
            await tx.query(
              "select public.rpc_enroll_reviewer($1, 'PILOT', 'synthetic pilot test account')",
              [pilotActor.id],
            );
        }
        // Slot 1 is the first pilot test account, slot 2 the second: deterministic, never by pseudo id.
        const enrolled = (
          await tx.query<{ reviewer_pseudo_id: string; user_id: string }>(
            "select reviewer_pseudo_id, user_id from public.reviewers where mode_scope = 'PILOT' and withdrawn_at is null",
          )
        ).rows;
        const pseudos = [DEMO_ACTORS[1], DEMO_ACTORS[2]]
          .map((a) => enrolled.find((r) => r.user_id === a.id)?.reviewer_pseudo_id)
          .filter((p): p is string => !!p);
        if (pseudos.length < 2)
          throw new ServiceError(
            409,
            'Two enrolled pilot reviewers are required before assignment.',
          );
        const ids = (
          await tx.query<{ case_id: string }>(
            "select case_id from public.mc_cases where record_category = 'SYNTHETIC_PILOT' order by case_id",
          )
        ).rows.map((r) => r.case_id);
        if (!ids.length) throw new ServiceError(409, 'No synthetic mappings to assign.');
        const assigned = (
          await tx.query<{ case_id: string; reviewer_pseudo_id: string }>(
            'select case_id, reviewer_pseudo_id from public.mc_assignments',
          )
        ).rows;
        for (const [index, pseudo] of pseudos.slice(0, 2).entries()) {
          const remaining = ids.filter(
            (id) => !assigned.some((a) => a.case_id === id && a.reviewer_pseudo_id === pseudo),
          );
          if (remaining.length)
            await tx.query('select public.rpc_mc_assign($1, $2, $3::text[], $4)', [
              pseudo,
              index + 1,
              remaining,
              input.seed,
            ]);
        }
      });
      break;
    case 'phase':
      await run(actor, (tx) =>
        tx.query('select public.rpc_mc_phase($1, $2, $3)', [
          input.eventType,
          input.attestation,
          appGitSha(),
        ]),
      );
      break;
    case 'register-export': {
      const bundle = await exportMcBundle(actor);
      await run(actor, (tx) =>
        tx.query('select public.rpc_mc_register_export($1::jsonb)', [
          JSON.stringify({
            format_version: 'mapping-confirmation-1.0',
            row_counts: Object.fromEntries(bundle.files.map((f) => [f.role, f.rows])),
            file_sha256: Object.fromEntries(bundle.files.map((f) => [f.name, f.sha256])),
            manifest_sha256: bundle.manifestSha256,
            app_git_sha: appGitSha(),
            notes:
              `manifest export_id ${bundle.manifest.export_id}; ${input.notes?.trim() ?? ''}`.trim(),
          }),
        ]),
      );
      break;
    }
  }
  return getMcInvestigatorWorkspace(actor);
}

// ---------------------------------------------------------------------------------------------
// Export (format mapping-confirmation-1.0)
// ---------------------------------------------------------------------------------------------
export async function exportMcBundle(actor: Actor): Promise<McBundle> {
  requireRole(actor, 'INVESTIGATOR');
  return run(actor, async (tx) => {
    const campaign = await readCampaign(tx);
    if (!campaign || campaign.phase !== 'LOCKED')
      throw new ServiceError(409, 'Lock the campaign before exporting.');
    const buildSha = appGitSha();
    if (!/^[0-9a-f]{40}$/.test(buildSha) || /^0{40}$/.test(buildSha))
      throw new ServiceError(409, 'Export requires a verified application build commit.');
    if (campaign.rubricVersion !== MC_RUBRIC_VERSION || campaign.rubricSha256 !== mcRubricSha256())
      throw new ServiceError(
        409,
        'The runtime rubric does not match the campaign rubric; export is blocked.',
      );
    const rows = (
      await tx.query<Row>(
        `select record_category, case_id, trial_ref, condition_code, condition_label, condition_set_id, assignment_assigned, assignment_source, assignment_version,
                assignment_sha256, evidence_sha256, evidence_version::integer as evidence_version, brief_summary_present, detailed_description_included,
                reviewer_slot::integer as reviewer_slot, reviewer_pseudo_id, answer, annotation, rubric_addition_proposed, review_mode, assignment_visibility,
                displayed_assignment_sha256, displayed_evidence_sha256, displayed_evidence_version::integer as displayed_evidence_version, rubric_version, rubric_sha256, response_app_git_sha, ${TS('submitted_at')} as submitted_at,
                adjudication_id::text as adjudication_id, adjudicated_decision, adjudication_status, adjudication_basis, adjudicator_role, ${TS('adjudicated_at')} as adjudicated_at
         from public.v_mc_export`,
      )
    ).rows;
    const caseKeys = [
      'record_category',
      'case_id',
      'trial_ref',
      'condition_code',
      'condition_label',
      'condition_set_id',
      'assignment_assigned',
      'assignment_source',
      'assignment_version',
      'assignment_sha256',
      'evidence_sha256',
      'evidence_version',
      'brief_summary_present',
      'detailed_description_included',
      'adjudication_id',
      'adjudicated_decision',
      'adjudication_status',
      'adjudication_basis',
      'adjudicator_role',
      'adjudicated_at',
    ];
    const responseKeys = [
      'record_category',
      'case_id',
      'reviewer_slot',
      'reviewer_pseudo_id',
      'answer',
      'annotation',
      'rubric_addition_proposed',
      'review_mode',
      'assignment_visibility',
      'displayed_assignment_sha256',
      'displayed_evidence_sha256',
      'displayed_evidence_version',
      'rubric_version',
      'rubric_sha256',
      'response_app_git_sha',
      'submitted_at',
    ];
    const pick = (row: Row, keys: string[]): Row =>
      Object.fromEntries(keys.map((k) => [k, row[k] ?? null]));
    const cases = [...new Map(rows.map((r) => [String(r.case_id), pick(r, caseKeys)])).values()];
    const responses = rows.filter((r) => r.answer !== null).map((r) => pick(r, responseKeys));
    const events = (
      await tx.query<{ event_type: string; occurred_at: string }>(
        `select event_type, ${TS('occurred_at')} as occurred_at from public.mc_campaign_events order by event_seq`,
      )
    ).rows;
    const at = (type: string) => events.find((e) => e.event_type === type)?.occurred_at ?? null;
    const lockedAt = at('LOCKED');
    if (!lockedAt) throw new ServiceError(409, 'Lock the campaign before exporting.');
    const n = await tx.query<{ n: number | string }>(
      'select count(*) as n from public.mc_adjudications',
    );
    return buildMcBundle(
      {
        created_at: lockedAt,
        app_git_sha: buildSha,
        is_synthetic_fixture: cases.every((c) => /^MC-SYN-/.test(String(c.case_id))),
        condition_set_id: campaign.conditionSetId,
        condition_set_status: campaign.conditionSetStatus,
        rubric_version: campaign.rubricVersion,
        rubric_sha256: campaign.rubricSha256,
        closed_at: at('CLOSED'),
        adjudication_authorized_at: at('ADJUDICATION_AUTHORIZED'),
        locked_at: lockedAt,
        n_adjudications: Number(n.rows[0].n),
      },
      cases,
      responses,
    );
  });
}
export { mcManifestText };
