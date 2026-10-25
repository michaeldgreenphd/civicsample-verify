// Mapping-confirmation service over PostgREST with the signed-in user's token (Supabase mode).
// Same DTO contract as src/server/mapconf.ts; every read goes through the mc_ tables and views
// under the caller's row-level security and every write through an rpc_mc_* function, so the
// database enforces role separation exactly as on the local path. No service-role key exists here.
import { isDeepStrictEqual } from 'node:util';
import { PostgrestClient, toExportTimestamp } from '../lib/postgrest';
import { buildMcBundle, type Row } from '../lib/mapconf-export';
import {
  MC_CONDITIONS,
  MC_CONDITION_SET_ID,
  MC_CONDITION_SET_STATUS,
  MC_RUBRIC_VERSION,
  mcRubricSha256,
  type McAdjudicationInput,
  type McAdjudicationStatus,
  type McAdjudicatorCase,
  type McAdjudicatorWorkspace,
  type McAdminAction,
  type McAnswer,
  type McBundle,
  type McCampaignState,
  type McCaseInput,
  type McCaseView,
  type McInvestigatorWorkspace,
  type McReviewerCase,
  type McReviewerWorkspace,
  type McSubmissionInput,
  type McTrainingExample,
  type McWorkspace,
} from '../lib/mapconf-types';
import {
  MC_SYNTHETIC_PILOT_CASES,
  MC_SYNTHETIC_TRAINING_CASES,
  MC_SYNTHETIC_TRAINING_WALKTHROUGHS,
} from '../lib/mapconf-synthetic';
import { caseView, mapconfPublicError, type CaseRow } from './mapconf';
import { ServiceError } from './service';
import type { SessionActor } from './session';
import { supabaseRuntime } from './session';
import { appGitSha } from './tlv5';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CASE_ID = /^MC-(SYN|TRN|EVAL)-[A-Z0-9][A-Z0-9-]{1,40}$/;
const notFound = () => new ServiceError(404, 'Resource not available.');
const CASE_COLUMNS =
  'case_id,record_category,trial_ref,condition_code,condition_label,condition_set_id,assignment,assignment_sha256,evidence,evidence_sha256,evidence_version';

function client(actor: SessionActor): PostgrestClient {
  if (!actor.accessToken) throw new ServiceError(401, 'Sign in to continue.');
  return new PostgrestClient(supabaseRuntime().config, actor.accessToken, mapconfPublicError);
}
function requireRole(actor: SessionActor, ...roles: SessionActor['role'][]) {
  if (!roles.includes(actor.role))
    throw new ServiceError(403, 'This action is not available to your role.');
}
const ts = (v: string | null | undefined) => toExportTimestamp(v) ?? '';

interface CampaignRow {
  condition_set_id: string;
  condition_set_status: 'PROPOSED' | 'APPROVED';
  rubric_version: string;
  rubric_sha256: string;
  phase: McCampaignState['phase'];
  created_at: string;
}
async function readCampaign(c: PostgrestClient): Promise<McCampaignState | null> {
  const rows = await c.select<CampaignRow>(
    'mc_campaign',
    'select=condition_set_id,condition_set_status,rubric_version,rubric_sha256,phase,created_at',
  );
  const row = rows[0];
  if (!row) return null;
  return {
    reviewMode: 'MAPPING_CONFIRMATION',
    assignmentVisibility: 'EXISTING_ASSIGNMENT_VISIBLE',
    conditionSetId: row.condition_set_id,
    conditionSetStatus: row.condition_set_status,
    rubricVersion: row.rubric_version,
    rubricSha256: row.rubric_sha256,
    phase: row.phase,
    createdAt: ts(row.created_at),
  };
}
async function readTraining(c: PostgrestClient): Promise<McTrainingExample[]> {
  const rows = await c.select<CaseRow>(
    'mc_cases',
    `select=${CASE_COLUMNS}&record_category=eq.TRAINING_EXAMPLE&order=case_id`,
  );
  return MC_SYNTHETIC_TRAINING_WALKTHROUGHS.map((walkthrough) => {
    const row = rows.find((r) => r.case_id === walkthrough.caseId);
    return { caseId: walkthrough.caseId, case: row ? caseView(row) : null, walkthrough };
  });
}

export async function getMcWorkspace(actor: SessionActor): Promise<McWorkspace> {
  if (actor.role === 'INVESTIGATOR') return getMcInvestigatorWorkspace(actor);
  if (actor.role === 'ADJUDICATOR') return getMcAdjudicatorWorkspace(actor);
  const c = client(actor);
  const queue = await c.select<{
    assignment_id: string;
    case_id: string;
    queue_position: number;
    record_category: McCaseView['recordCategory'];
    condition_code: string;
    condition_label: string;
    brief_title: string;
    submitted: boolean;
  }>('v_mc_my_queue', 'select=*&order=queue_position');
  const ws: McReviewerWorkspace = {
    kind: 'reviewer',
    campaign: await readCampaign(c),
    queue: queue.map((r) => ({
      assignmentId: r.assignment_id,
      caseId: r.case_id,
      queuePosition: Number(r.queue_position),
      recordCategory: r.record_category,
      conditionCode: r.condition_code,
      conditionLabel: r.condition_label,
      briefTitle: r.brief_title,
      submitted: r.submitted,
    })),
    training: await readTraining(c),
  };
  return ws;
}
async function getMcAdjudicatorWorkspace(actor: SessionActor): Promise<McAdjudicatorWorkspace> {
  requireRole(actor, 'ADJUDICATOR');
  const c = client(actor);
  const queue = await c.select<{
    case_id: string;
    record_category: McCaseView['recordCategory'];
    condition_code: string;
    condition_label: string;
    brief_title: string;
    reviewer_1_answer: McAnswer | null;
    reviewer_2_answer: McAnswer | null;
    needs_adjudication: boolean;
    adjudicated: boolean;
  }>('v_mc_adjudication_queue', 'select=*&order=case_id');
  return {
    kind: 'adjudicator',
    campaign: await readCampaign(c),
    queue: queue.map((r) => ({
      caseId: r.case_id,
      recordCategory: r.record_category,
      conditionCode: r.condition_code,
      conditionLabel: r.condition_label,
      briefTitle: r.brief_title,
      reviewer1Answer: r.reviewer_1_answer,
      reviewer2Answer: r.reviewer_2_answer,
      needsAdjudication: r.needs_adjudication,
      adjudicated: r.adjudicated,
    })),
    training: await readTraining(c),
  };
}
async function getMcInvestigatorWorkspace(actor: SessionActor): Promise<McInvestigatorWorkspace> {
  requireRole(actor, 'INVESTIGATOR');
  const c = client(actor);
  const categories = await c.select<{ record_category: string }>(
    'mc_cases',
    'select=record_category',
  );
  const count = (category: string) =>
    categories.filter((r) => r.record_category === category).length;
  const completion = await c.rpc<
    { reviewer_pseudo_id: string; reviewer_slot: number; n_assigned: number; n_submitted: number }[]
  >('rpc_mc_completion_summary', {});
  const reviewers = await c.select<{ reviewer_pseudo_id: string; mode_scope: 'PILOT' | 'FORMAL' }>(
    'reviewers',
    'select=reviewer_pseudo_id,mode_scope&withdrawn_at=is.null&order=reviewer_pseudo_id',
  );
  const events = await c.select<{
    event_type: McInvestigatorWorkspace['events'][number]['eventType'];
    occurred_at: string;
  }>('mc_campaign_events', 'select=event_type,occurred_at&order=event_seq');
  const exports = await c.select<{
    export_id: string;
    created_at: string;
    manifest_sha256: string;
  }>('mc_exports', 'select=export_id,created_at,manifest_sha256&order=created_at');
  const adjudications = await c.select<{ adjudication_id: string }>(
    'mc_adjudications',
    'select=adjudication_id',
  );
  return {
    kind: 'investigator',
    campaign: await readCampaign(c),
    conditions: MC_CONDITIONS.map((x) => ({ ...x })),
    counts: {
      syntheticPilot: count('SYNTHETIC_PILOT'),
      trainingExample: count('TRAINING_EXAMPLE'),
      evaluation: count('EVALUATION'),
    },
    completion: (Array.isArray(completion) ? completion : []).map((r) => ({
      reviewerPseudoId: r.reviewer_pseudo_id,
      reviewerSlot: Number(r.reviewer_slot),
      assigned: Number(r.n_assigned),
      submitted: Number(r.n_submitted),
    })),
    reviewers: reviewers.map((r) => ({ pseudoId: r.reviewer_pseudo_id, modeScope: r.mode_scope })),
    events: events.map((e) => ({ eventType: e.event_type, occurredAt: ts(e.occurred_at) })),
    exports: exports.map((e) => ({
      exportId: e.export_id,
      createdAt: ts(e.created_at),
      manifestSha256: e.manifest_sha256,
    })),
    adjudicationsRecorded: adjudications.length,
    evaluationImportAllowed: false,
    appGitSha: appGitSha(),
  };
}

export async function getMcReviewerCase(
  actor: SessionActor,
  assignmentId: string,
): Promise<McReviewerCase> {
  requireRole(actor, 'REVIEWER');
  if (!UUID.test(assignmentId)) throw notFound();
  const c = client(actor);
  const a = (
    await c.select<{ assignment_id: string; case_id: string }>(
      'mc_assignments',
      `select=assignment_id,case_id&assignment_id=eq.${assignmentId}`,
    )
  )[0];
  if (!a) throw notFound();
  const row = (
    await c.select<CaseRow>(
      'mc_cases',
      `select=${CASE_COLUMNS}&case_id=eq.${encodeURIComponent(a.case_id)}`,
    )
  )[0];
  const campaign = await readCampaign(c);
  if (!row || !campaign) throw notFound();
  const own = (
    await c.select<{
      answer: McAnswer;
      annotation: string | null;
      rubric_addition_proposed: boolean;
      submitted_at: string;
    }>(
      'mc_responses',
      `select=answer,annotation,rubric_addition_proposed,submitted_at&assignment_id=eq.${assignmentId}`,
    )
  )[0];
  return {
    assignmentId,
    case: caseView(row),
    campaign,
    submissionsOpen: campaign.phase === 'OPEN' && !own,
    ownResponse: own
      ? {
          answer: own.answer,
          annotation: own.annotation,
          rubricAdditionProposed: own.rubric_addition_proposed,
          submittedAt: ts(own.submitted_at),
        }
      : null,
  };
}
export async function submitMc(
  actor: SessionActor,
  assignmentId: string,
  input: McSubmissionInput,
): Promise<McReviewerCase> {
  requireRole(actor, 'REVIEWER');
  if (!UUID.test(assignmentId)) throw notFound();
  await client(actor).rpc('rpc_mc_submit', {
    p_assignment_id: assignmentId,
    p: {
      answer: input.answer,
      annotation: input.annotation ?? null,
      displayed_assignment_sha256: input.displayedAssignmentSha256,
      displayed_evidence_sha256: input.displayedEvidenceSha256,
      displayed_evidence_version: input.displayedEvidenceVersion,
      rubric_version: input.rubricVersion,
      rubric_sha256: input.rubricSha256,
      app_git_sha: appGitSha(),
      seconds_on_case: input.secondsOnCase ?? null,
    },
  });
  return getMcReviewerCase(actor, assignmentId);
}

export async function getMcAdjudicatorCase(
  actor: SessionActor,
  caseId: string,
): Promise<McAdjudicatorCase> {
  requireRole(actor, 'ADJUDICATOR');
  if (!CASE_ID.test(caseId)) throw notFound();
  const c = client(actor);
  const q = encodeURIComponent(caseId);
  const inQueue = await c.select<{ case_id: string }>(
    'v_mc_adjudication_queue',
    `select=case_id&case_id=eq.${q}`,
  );
  const row = (await c.select<CaseRow>('mc_cases', `select=${CASE_COLUMNS}&case_id=eq.${q}`))[0];
  const campaign = await readCampaign(c);
  if (!inQueue.length || !row || !campaign) throw notFound();
  const assignments = await c.select<{ assignment_id: string; reviewer_slot: number }>(
    'mc_assignments',
    `select=assignment_id,reviewer_slot&case_id=eq.${q}`,
  );
  const responses = await c.select<{
    assignment_id: string;
    answer: McAnswer;
    annotation: string | null;
    rubric_addition_proposed: boolean;
  }>(
    'mc_responses',
    `select=assignment_id,answer,annotation,rubric_addition_proposed&case_id=eq.${q}`,
  );
  const j = (
    await c.select<{
      adjudication_id: string;
      decision: 'YES' | 'NO' | null;
      status: McAdjudicationStatus;
      basis: McAdjudicatorCase['adjudication'] extends infer A
        ? A extends { basis: infer B }
          ? B
          : never
        : never;
      rationale: string;
      decided_at: string;
    }>(
      'mc_adjudications',
      `select=adjudication_id,decision,status,basis,rationale,decided_at&case_id=eq.${q}`,
    )
  )[0];
  return {
    case: caseView(row),
    campaign,
    responses: responses
      .map((r) => ({
        reviewerSlot: Number(
          assignments.find((a) => a.assignment_id === r.assignment_id)?.reviewer_slot ?? 0,
        ) as 1 | 2,
        answer: r.answer,
        annotation: r.annotation,
        rubricAdditionProposed: r.rubric_addition_proposed,
      }))
      .sort((x, y) => x.reviewerSlot - y.reviewerSlot),
    adjudication: j
      ? {
          adjudicationId: j.adjudication_id,
          caseId,
          decision: j.decision,
          status: j.status,
          basis: j.basis,
          rationale: j.rationale,
          decidedAt: ts(j.decided_at),
        }
      : null,
  };
}
export async function recordMcAdjudication(
  actor: SessionActor,
  input: McAdjudicationInput,
): Promise<McAdjudicatorCase> {
  requireRole(actor, 'ADJUDICATOR');
  await client(actor).rpc('rpc_mc_adjudicate', {
    p: {
      case_id: input.caseId,
      decision: input.decision ?? null,
      status: input.status,
      basis: input.basis,
      rationale: input.rationale,
    },
  });
  return getMcAdjudicatorCase(actor, input.caseId);
}

const casePayload = (x: McCaseInput) => ({
  case_id: x.caseId,
  record_category: x.recordCategory,
  trial_ref: x.trialRef,
  condition_code: x.conditionCode,
  condition_label: x.conditionLabel,
  condition_set_id: MC_CONDITION_SET_ID,
  assignment: x.assignment,
  evidence: x.evidence,
});
export async function importMcCase(actor: SessionActor, x: McCaseInput): Promise<string> {
  requireRole(actor, 'INVESTIGATOR');
  return client(actor).rpc<string>('rpc_mc_import_case', { p: casePayload(x) });
}

export async function mcAdminAction(
  actor: SessionActor,
  input: McAdminAction,
): Promise<McInvestigatorWorkspace> {
  requireRole(actor, 'INVESTIGATOR');
  const c = client(actor);
  switch (input.action) {
    case 'create-campaign':
      await c.rpc('rpc_mc_create_campaign', {
        p: {
          condition_set_id: MC_CONDITION_SET_ID,
          condition_set_status: MC_CONDITION_SET_STATUS,
          rubric_version: MC_RUBRIC_VERSION,
          rubric_sha256: mcRubricSha256(),
        },
      });
      break;
    case 'import-synthetic': {
      const fixtures = [...MC_SYNTHETIC_PILOT_CASES, ...MC_SYNTHETIC_TRAINING_CASES].map(
        casePayload,
      );
      const existing = await c.select<
        ReturnType<typeof casePayload> & { evidence_version: number }
      >(
        'mc_cases',
        `select=${Object.keys(fixtures[0]).join(',')},evidence_version&order=case_id&limit=${fixtures.length + 1}`,
      );
      // Each RPC commits independently. Verify the entire saved prefix before resuming; never
      // overwrite an existing packet or mistake a different campaign for this synthetic fixture.
      for (const saved of existing) {
        const expected = fixtures.find((fixture) => fixture.case_id === saved.case_id);
        if (!expected || !isDeepStrictEqual(saved, { ...expected, evidence_version: 1 }))
          throw new ServiceError(
            409,
            'The saved mappings differ from this synthetic pilot. Review the existing campaign before importing.',
          );
      }
      const existingIds = new Set(existing.map((row) => row.case_id));
      for (const payload of fixtures)
        if (!existingIds.has(payload.case_id)) await c.rpc('rpc_mc_import_case', { p: payload });
      break;
    }
    case 'import-evaluation':
      throw new ServiceError(
        409,
        'Evaluation import is disabled pending the approved condition set, sampling frame, frozen rubric and analysis specification.',
      );
    case 'assign': {
      // Retain any existing slot bindings when resuming an interrupted series of RPCs. New slots
      // take the earliest active pilot accounts (with a stable user-id tie-breaker).
      const candidates = await c.select<{ user_id: string }>(
        'users',
        'select=user_id&role=eq.REVIEWER&is_pilot_test_account=is.true&is_active=is.true&order=created_at,user_id',
      );
      const candidateIds = [...new Set(candidates.map((candidate) => candidate.user_id))];
      if (candidateIds.length < 2)
        throw new ServiceError(
          409,
          'Two active pilot test accounts are required before assignment.',
        );
      const enrolled = await c.select<{ reviewer_pseudo_id: string; user_id: string }>(
        'reviewers',
        'select=reviewer_pseudo_id,user_id&mode_scope=eq.PILOT&withdrawn_at=is.null',
      );
      const ids = (
        await c.select<{ case_id: string }>(
          'mc_cases',
          'select=case_id&record_category=eq.SYNTHETIC_PILOT&order=case_id',
        )
      ).map((r) => r.case_id);
      if (!ids.length) throw new ServiceError(409, 'No synthetic mappings to assign.');
      const assigned = await c.select<{
        case_id: string;
        reviewer_pseudo_id: string;
        reviewer_slot: number;
        randomization_seed: number;
      }>('mc_assignments', 'select=case_id,reviewer_pseudo_id,reviewer_slot,randomization_seed');
      const slotUsers: (string | undefined)[] = [undefined, undefined];
      for (const row of assigned) {
        const reviewer = enrolled.find((r) => r.reviewer_pseudo_id === row.reviewer_pseudo_id);
        const slot = row.reviewer_slot - 1;
        if (
          !reviewer ||
          !candidateIds.includes(reviewer.user_id) ||
          !ids.includes(row.case_id) ||
          (slot !== 0 && slot !== 1) ||
          Number(row.randomization_seed) !== input.seed ||
          (slotUsers[slot] !== undefined && slotUsers[slot] !== reviewer.user_id) ||
          slotUsers[1 - slot] === reviewer.user_id
        )
          throw new ServiceError(
            409,
            'Existing assignments do not match the active pilot reviewers and seed. Review the campaign before resuming.',
          );
        slotUsers[slot] = reviewer.user_id;
      }
      for (let slot = 0; slot < 2; slot++)
        slotUsers[slot] ??= candidateIds.find((userId) => !slotUsers.includes(userId));
      for (const userId of slotUsers)
        if (!enrolled.some((r) => r.user_id === userId))
          await c.rpc('rpc_enroll_reviewer', {
            p_user_id: userId,
            p_mode_scope: 'PILOT',
            p_qualifications: 'synthetic pilot test account',
          });
      const eligible = (
        await c.select<{ reviewer_pseudo_id: string; user_id: string }>(
          'reviewers',
          'select=reviewer_pseudo_id,user_id&mode_scope=eq.PILOT&withdrawn_at=is.null',
        )
      ).filter((r) => candidateIds.includes(r.user_id));
      const pilots = slotUsers.map((userId) => eligible.find((r) => r.user_id === userId));
      if (!pilots[0] || !pilots[1] || pilots[0].reviewer_pseudo_id === pilots[1].reviewer_pseudo_id)
        throw new ServiceError(409, 'Two enrolled pilot reviewers are required before assignment.');
      for (const [index, pilot] of pilots.entries()) {
        if (!pilot) throw new ServiceError(409, 'A pilot reviewer is no longer available.');
        const remaining = ids.filter(
          (id) =>
            !assigned.some(
              (a) => a.case_id === id && a.reviewer_pseudo_id === pilot.reviewer_pseudo_id,
            ),
        );
        if (remaining.length)
          await c.rpc('rpc_mc_assign', {
            p_reviewer_pseudo_id: pilot.reviewer_pseudo_id,
            p_slot: index + 1,
            p_case_ids: remaining,
            p_seed: input.seed,
          });
      }
      break;
    }
    case 'phase':
      await c.rpc('rpc_mc_phase', {
        p_event_type: input.eventType,
        p_attestation: input.attestation,
        p_app_git_sha: appGitSha(),
      });
      break;
    case 'register-export': {
      const bundle = await exportMcBundle(actor);
      await c.rpc('rpc_mc_register_export', {
        p: {
          format_version: 'mapping-confirmation-1.0',
          row_counts: Object.fromEntries(bundle.files.map((f) => [f.role, f.rows])),
          file_sha256: Object.fromEntries(bundle.files.map((f) => [f.name, f.sha256])),
          manifest_sha256: bundle.manifestSha256,
          app_git_sha: appGitSha(),
          notes:
            `manifest export_id ${bundle.manifest.export_id}; ${input.notes?.trim() ?? ''}`.trim(),
        },
      });
      break;
    }
  }
  return getMcInvestigatorWorkspace(actor);
}

export async function exportMcBundle(actor: SessionActor): Promise<McBundle> {
  requireRole(actor, 'INVESTIGATOR');
  const c = client(actor);
  const campaign = await readCampaign(c);
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
  const rows = await c.select<Row>('v_mc_export', 'select=*');
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
  const normalise = (row: Row): Row => ({
    ...row,
    adjudicated_at: toExportTimestamp(row.adjudicated_at as string | null),
    submitted_at: toExportTimestamp(row.submitted_at as string | null),
    evidence_version: row.evidence_version === null ? null : Number(row.evidence_version),
    displayed_evidence_version:
      row.displayed_evidence_version === null || row.displayed_evidence_version === undefined
        ? null
        : Number(row.displayed_evidence_version),
    reviewer_slot: row.reviewer_slot === null ? null : Number(row.reviewer_slot),
  });
  const pick = (row: Row, keys: string[]): Row =>
    Object.fromEntries(keys.map((k) => [k, row[k] ?? null]));
  const normalised = rows.map(normalise);
  const cases = [
    ...new Map(normalised.map((r) => [String(r.case_id), pick(r, caseKeys)])).values(),
  ];
  const responses = normalised.filter((r) => r.answer !== null).map((r) => pick(r, responseKeys));
  const events = await c.select<{ event_type: string; occurred_at: string }>(
    'mc_campaign_events',
    'select=event_type,occurred_at&order=event_seq',
  );
  const at = (type: string) =>
    toExportTimestamp(events.find((e) => e.event_type === type)?.occurred_at ?? null);
  const lockedAt = at('LOCKED');
  if (!lockedAt) throw new ServiceError(409, 'Lock the campaign before exporting.');
  const adjudications = await c.select<{ adjudication_id: string }>(
    'mc_adjudications',
    'select=adjudication_id',
  );
  return buildMcBundle(
    {
      created_at: lockedAt,
      app_git_sha: buildSha,
      is_synthetic_fixture: cases.every((x) => /^MC-SYN-/.test(String(x.case_id))),
      condition_set_id: campaign.conditionSetId,
      condition_set_status: campaign.conditionSetStatus,
      rubric_version: campaign.rubricVersion,
      rubric_sha256: campaign.rubricSha256,
      closed_at: at('CLOSED'),
      adjudication_authorized_at: at('ADJUDICATION_AUTHORIZED'),
      locked_at: lockedAt,
      n_adjudications: adjudications.length,
    },
    cases,
    responses,
  );
}
