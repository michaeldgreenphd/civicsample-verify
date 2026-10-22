// Design v5 service layer (trial-level verification of the analysis labels). Every write goes
// through an rpc_tlv5_* function under the signed-in actor's session; every read goes through the
// tables and views, so row-level security decides what each role receives. The DTOs returned here
// are explicit allow-lists; raw rows never leave this module.
import { readFileSync } from 'node:fs';
import { ACCOUNTS } from '../lib/auth';
import {
  AREA_KEYS,
  REVIEWER_ITEMS,
  ROW_KEYS,
  TLV5_RUBRIC_VERSION,
  rubricSha256,
} from '../lib/tlv5-codes';
import {
  buildTlv5Bundle,
  caseListSha256,
  labelRowsSha256,
  manifestExportId,
  manifestText,
  type Row,
} from '../lib/tlv5-export';
import { TLV5_PILOT_CASES } from '../lib/tlv5-pilot-cases';
import type {
  Tlv5AdjudicationInput,
  Tlv5AdjudicatorCaseDetail,
  Tlv5AdjudicatorWorkspace,
  Tlv5AdminAction,
  Tlv5Bundle,
  Tlv5CompletionRow,
  Tlv5InvestigatorWorkspace,
  Tlv5ItemInput,
  Tlv5Mode,
  Tlv5PilotCase,
  Tlv5QueueItem,
  Tlv5ReviewerCase,
  Tlv5ReviewerWorkspace,
  Tlv5State,
  Tlv5Submission,
  Tlv5SubmissionInput,
  Tlv5TrialPacket,
  Tlv5Workspace,
} from '../lib/tlv5-types';
import type { Actor } from '../lib/types';
import { DEMO_ACTORS, provisionStagingAccounts, withActor } from './db';
import { ServiceError } from './service';

type Tx = Parameters<Parameters<typeof withActor>[1]>[0];
const TS = (column: string) =>
  `to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
export const PILOT_LABEL_SET = 'LBL5-SYN-PILOT';
export const PILOT_DESIGN_VERSION = 'SYN-5';

// Fixed public messages only: the database messages are safe, but a client never receives SQL text.
const PUBLIC_ERRORS: [RegExp, number, string][] = [
  [
    /An active ADJUDICATOR|investigator role|ADJUDICATOR role is needed|not your v5 assignment|permission denied|Authenticated role mismatch/,
    403,
    'This action is not available to your role.',
  ],
  [
    /pilot reference is locked|training reference is locked|formal phase is not open|closed when the formal phase opened|calibration closed|calibration is closed|Final v5 submission|amendment|Two independent|two independent|both reviewers|reference is locked/,
    409,
    'Submissions are closed for this case.',
  ],
  [
    /answers all 7 area items|subgroup items|duplicate or unknown items|check constraint|violates|OTHER_SPECIFIED|is shown only when/,
    400,
    'The submission is incomplete or breaks the item rules. Answer every area and condition-row item, and each subgroup item exactly when its row answer is Yes.',
  ],
  [
    /concordant items enter the reference by rule/,
    409,
    'The reviewers agree on this item; under the disagreements-only scope it enters the reference by rule.',
  ],
  [/needs a disagreement reason code/, 400, 'A discordant item needs a disagreement reason code.'],
  [
    /differs from the rubric bound to|does not match the frozen rubric; review activity is blocked/,
    409,
    'The rubric text changed since this review began; review activity is blocked until the investigator reconciles the rubric.',
  ],
  [
    /basis (REVIEWER_1|REVIEWER_2|BOTH_REVIEWERS|NEITHER) does not match the reviewer answers|basis NONE applies only/,
    400,
    'The basis does not match the reviewer answers for this item.',
  ],
  [/has no reviewer answer to adjudicate/, 409, 'No reviewer answered this item.'],
  [
    /single-reviewed item is|status .* does not fit|reviewers disagree on this item|reviewers agree on this item/,
    400,
    'The adjudication status does not fit the reviewers’ answers for this item.',
  ],
  [
    /conflict: the adjudicator reviewed/,
    403,
    'Conflict: an adjudicator cannot adjudicate a case they reviewed.',
  ],
  [
    /only the ADJUDICATOR role adjudicates FORMAL|never enters a FORMAL judgment/,
    403,
    'Only the adjudicator records a formal adjudication.',
  ],
  [
    /FORMAL adjudication opens only after|take the independent-judgment snapshot/,
    409,
    'Formal adjudication opens only after the close and the snapshot.',
  ],
  [
    /items that the adjudication scope requires have no adjudication/,
    409,
    'Every item that the adjudication scope requires must be adjudicated before the reference is locked.',
  ],
  [
    /locked only after the close and the snapshot/,
    409,
    'The formal reference is locked only after the close and the snapshot.',
  ],
  [
    /registered only after that reference is locked/,
    409,
    'Lock the reference before registering an export.',
  ],
  [
    /v5 pilot incomplete|lock the pilot reference|must reference a registered v5 PILOT export|already signed off/,
    409,
    'The pilot sign-off requires a complete, adjudicated, locked and exported pilot, and happens once.',
  ],
  [/sign off the v5 pilot|only after the v5 pilot sign-off/, 409, 'Sign off the v5 pilot first.'],
  [
    /withdraw them before activating|duplicate key|already/,
    409,
    'This step was already recorded or conflicts with an existing record.',
  ],
  [/activate design v5|activate design v5 first/, 409, 'Activate design v5 first.'],
  [
    /sample is frozen|labels are frozen|freeze has already happened|design rows cannot be added/,
    409,
    'The v5 sample is frozen; nothing can be added.',
  ],
  [
    /FORMAL assignments open only after|FORMAL assignments need the formal phase open|training examples close|rubric calibration closes/,
    409,
    'Assignments are not open for this mode at this stage.',
  ],
  [
    /mode contamination blocked|already holds slot|reviewer rows require a REVIEWER user|pilot test accounts/,
    409,
    'Reviewer mode scope, role or slot conflict.',
  ],
  [
    /snapshot is taken after the formal phase closes|a FORMAL adjudication exists/,
    409,
    'The snapshot is taken after the close and before any formal adjudication.',
  ],
  [
    /no FORMAL v5 cases to freeze|FORMAL cases have no design row|required area or row labels are missing|frozen_items|not a SHA-256/,
    409,
    'The freeze needs every formal case with a design row and its 17 labels, and valid SHA-256 values.',
  ],
  [
    /not on the reviewer-visible allow list|could carry blinded content|registry address|nct_id/,
    400,
    'The packet carries a field the reviewer must never see.',
  ],
  [
    /is a FORMAL case; it cannot also be|is already a training example|is a training example or a calibration case|carry no design row/,
    409,
    'A trial cannot belong to two record categories.',
  ],
  [
    /formal review is not in progress|formal review was already|only a closed|legal transition|not in progress|before opening the formal phase|formal phase (is|was|has)|is not open|already open|already closed|cannot be reopened|no FORMAL assignment|assignments? .* (lack|without)|unlock|phase/,
    409,
    'This phase transition is not allowed now.',
  ],
];

/** The build commit an export attests to: the deployment-provided VERIFY_APP_GIT_SHA, else the
 *  commit baked into the artifact when the build started (next.config.ts, clean tree only). The
 *  running server never resolves HEAD itself: a checkout can change without the artifact changing. */
export function appGitSha(
  configured: string | undefined = process.env.VERIFY_APP_GIT_SHA,
  baked: string | undefined = process.env.VERIFY_BUILD_GIT_SHA,
): string {
  for (const candidate of [configured, baked])
    if (candidate && /^[0-9a-f]{40}$/.test(candidate) && !/^0{40}$/.test(candidate))
      return candidate;
  return 'unverified-local-build';
}

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
function caseId(id: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{2,80}$/.test(id))
    throw new ServiceError(404, 'Resource not available.');
  return id;
}
const accountOf = (userId: string) =>
  Object.entries(ACCOUNTS).find(([, actor]) => actor.id === userId)?.[0] ?? null;

// ---------------------------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------------------------
async function readState(tx: Tx, actor: Actor): Promise<Tlv5State> {
  const helpers = await tx.query<{
    phase: Tlv5State['phase'];
    snapshot_taken: boolean;
    pilot_locked: boolean;
    training_locked: boolean;
    formal_locked: boolean;
    frozen: boolean;
    scope: string;
  }>(
    `select private.tlv5_phase() as phase, private.tlv5_snapshot_taken() as snapshot_taken,
            private.tlv5_locked('PILOT') as pilot_locked, private.tlv5_locked('TRAINING') as training_locked,
            private.tlv5_locked('FORMAL') as formal_locked, private.tlv5_frozen() as frozen,
            private.tlv5_scope() as scope`,
  );
  const h = helpers.rows[0];
  const state: Tlv5State = {
    schemaVersions: [],
    activation: null,
    pilotSignedOff: false,
    pilotSignOff: null,
    phase: h.phase,
    phaseEvents: [],
    frozen: null,
    snapshot: null,
    snapshotTaken: h.snapshot_taken,
    locks: {},
    adjudicationScope: h.scope === 'ALL_ITEMS' ? 'ALL_ITEMS' : 'DISAGREEMENTS_ONLY',
    submissionsOpen: {
      PILOT: !h.pilot_locked,
      TRAINING: !h.training_locked && h.phase === 'NOT_OPENED',
      // Rubric calibration closes at the freeze (migration 0011); the screen must say so too.
      CALIBRATION: !h.frozen,
      FORMAL: h.phase === 'OPEN',
    },
  };
  const versions = await tx.query<{ version: string }>(
    'select version from public.app_schema_version order by applied_at, version',
  );
  state.schemaVersions = versions.rows.map((r) => r.version);
  const locks = await tx.query<{ mode: string; locked_at: string; n: number }>(
    `select mode, ${TS('locked_at')} as locked_at, n_items_locked as n from public.tlv5_reference_locks`,
  );
  for (const row of locks.rows)
    state.locks[row.mode as 'PILOT' | 'TRAINING' | 'FORMAL'] = {
      lockedAt: row.locked_at,
      items: row.n,
    };
  if (actor.role === 'INVESTIGATOR' || actor.role === 'ADJUDICATOR') {
    const events = await tx.query<{
      event_type: string;
      occurred_at: string;
      checklist_version: string | null;
      app_git_sha: string | null;
    }>(
      `select event_type, ${TS('occurred_at')} as occurred_at, checklist_version, app_git_sha from public.tlv5_phase_events order by event_seq`,
    );
    state.phaseEvents = events.rows.map((e) => ({
      eventType: e.event_type,
      occurredAt: e.occurred_at,
    }));
    const signOff = events.rows.find((e) => e.event_type === 'PILOT_SIGNED_OFF');
    state.pilotSignedOff = !!signOff;
    state.pilotSignOff = signOff
      ? {
          checklistVersion: signOff.checklist_version ?? '',
          appGitSha: signOff.app_git_sha ?? '',
          occurredAt: signOff.occurred_at,
        }
      : null;
  }
  if (actor.role === 'INVESTIGATOR') {
    const activation = await tx.query<{
      design_version: string;
      adjudication_scope: string;
      activated_at: string;
    }>(
      `select design_version, adjudication_scope, ${TS('activated_at')} as activated_at from public.tlv5_activation`,
    );
    state.activation = activation.rows[0]
      ? {
          designVersion: activation.rows[0].design_version,
          adjudicationScope: activation.rows[0].adjudication_scope,
          activatedAt: activation.rows[0].activated_at,
        }
      : null;
    const freeze = await tx.query<{
      design_version: string;
      n_cases: number;
      n_label_rows: number;
      case_list_sha256: string;
      label_rows_sha256: string;
      frozen_at: string;
    }>(
      `select design_version, n_cases, n_label_rows, case_list_sha256, label_rows_sha256, ${TS('frozen_at')} as frozen_at from public.tlv5_freeze`,
    );
    const f = freeze.rows[0];
    state.frozen = f
      ? {
          designVersion: f.design_version,
          nCases: f.n_cases,
          nLabelRows: f.n_label_rows,
          caseListSha256: f.case_list_sha256,
          labelRowsSha256: f.label_rows_sha256,
          frozenAt: f.frozen_at,
        }
      : null;
    const snapshot = await tx.query<{ n_rows: number; content_sha256: string; taken_at: string }>(
      `select n_rows, content_sha256, ${TS('taken_at')} as taken_at from public.tlv5_snapshot`,
    );
    state.snapshot = snapshot.rows[0]
      ? {
          rows: snapshot.rows[0].n_rows,
          sha256: snapshot.rows[0].content_sha256,
          takenAt: snapshot.rows[0].taken_at,
        }
      : null;
  }
  return state;
}

// ---------------------------------------------------------------------------------------------
// Reviewer
// ---------------------------------------------------------------------------------------------
async function reviewerIdentity(tx: Tx) {
  const who = await tx.query<{
    reviewer_pseudo_id: string | null;
    mode_scope: 'PILOT' | 'FORMAL' | null;
  }>('select reviewer_pseudo_id, mode_scope from public.rpc_whoami()');
  const row = who.rows[0];
  return row?.reviewer_pseudo_id
    ? { pseudoId: row.reviewer_pseudo_id, modeScope: row.mode_scope! }
    : null;
}
async function queueRows(
  tx: Tx,
  view: 'v_tlv5_my_queue' | 'v_tlv5_my_training_queue',
): Promise<Tlv5QueueItem[]> {
  const rows = await tx.query<{
    assignment_id: string;
    case_id: string;
    mode: Tlv5Mode;
    queue_position: number;
    n_submissions: string | number;
    title: string;
  }>(
    `select q.assignment_id, q.case_id, c.mode, q.queue_position, q.n_submissions, c.packet ->> 'case_title' as title
     from public.${view} q join public.tlv5_cases c on c.case_id = q.case_id order by q.queue_position`,
  );
  return rows.rows.map((r) => ({
    assignmentId: r.assignment_id,
    caseId: r.case_id,
    mode: r.mode,
    title: r.title,
    queuePosition: r.queue_position,
    submissions: Number(r.n_submissions),
  }));
}
export async function getTlv5Workspace(actor: Actor): Promise<Tlv5Workspace> {
  if (actor.role === 'INVESTIGATOR') return getInvestigatorWorkspace(actor);
  if (actor.role === 'ADJUDICATOR') return getAdjudicatorWorkspace(actor);
  return run(actor, async (tx): Promise<Tlv5ReviewerWorkspace> => ({
    kind: 'reviewer',
    user: actor,
    reviewer: await reviewerIdentity(tx),
    queue: await queueRows(tx, 'v_tlv5_my_queue'),
    training: await queueRows(tx, 'v_tlv5_my_training_queue'),
    state: await readState(tx, actor),
    rubricVersion: TLV5_RUBRIC_VERSION,
  }));
}

function packetOf(row: { packet: Tlv5TrialPacket }): Tlv5TrialPacket {
  const p = row.packet;
  return {
    schema_version: p.schema_version,
    case_title: p.case_title,
    trial: p.trial,
    notices: p.notices ?? [],
  };
}
async function readSubmissions(tx: Tx, assignmentId: string): Promise<Tlv5Submission[]> {
  const subs = await tx.query<{
    submission_id: string;
    revision_number: number;
    submitted_at: string;
    overall_comment: string | null;
    packet_issue_flag: boolean;
    packet_issue_note: string | null;
    seconds_on_case: number | null;
  }>(
    `select submission_id, revision_number, ${TS('submitted_at')} as submitted_at, overall_comment, packet_issue_flag, packet_issue_note, seconds_on_case
     from public.tlv5_submissions where assignment_id = $1 order by revision_number`,
    [assignmentId],
  );
  const result: Tlv5Submission[] = [];
  for (const s of subs.rows) {
    const items = await tx.query<{
      item_code: string;
      answer: string;
      uncertain: boolean;
      note: string | null;
      detail_code: string | null;
    }>(
      'select item_code, answer, uncertain, note, detail_code from public.tlv5_submission_items where submission_id = $1',
      [s.submission_id],
    );
    result.push({
      revision: s.revision_number,
      submittedAt: s.submitted_at,
      items: items.rows
        .sort((a, b) => REVIEWER_ITEMS.indexOf(a.item_code) - REVIEWER_ITEMS.indexOf(b.item_code))
        .map((i) => ({
          itemCode: i.item_code,
          answer: i.answer,
          uncertain: i.uncertain,
          ...(i.note ? { note: i.note } : {}),
          ...(i.detail_code ? { detailCode: i.detail_code } : {}),
        })),
      ...(s.overall_comment ? { overallComment: s.overall_comment } : {}),
      packetIssueFlag: s.packet_issue_flag,
      ...(s.packet_issue_note ? { packetIssueNote: s.packet_issue_note } : {}),
      ...(s.seconds_on_case !== null ? { secondsOnCase: s.seconds_on_case } : {}),
    });
  }
  return result;
}
/** Bind the runtime rubric to the mode on first use, or verify it; a mismatch aborts the activity. */
async function bindRubric(tx: Tx, mode: Tlv5Mode): Promise<void> {
  await tx.query('select public.rpc_tlv5_bind_rubric($1, $2, $3)', [
    mode,
    TLV5_RUBRIC_VERSION,
    rubricSha256(),
  ]);
}
async function rubricBinding(tx: Tx, mode: Tlv5Mode) {
  const row = await tx.query<{ rubric_version: string; rubric_sha256: string }>(
    'select rubric_version, rubric_sha256 from public.tlv5_rubric_bindings where mode = $1',
    [mode],
  );
  return row.rows[0] ?? null;
}
async function myAssignment(tx: Tx, id: string) {
  const row = await tx.query<{ assignment_id: string; mode: Tlv5Mode; packet: Tlv5TrialPacket }>(
    `select a.assignment_id, c.mode, c.packet from public.tlv5_assignments a join public.tlv5_cases c on c.case_id = a.case_id
     where a.case_id = $1 and a.reviewer_pseudo_id = private.my_reviewer_pseudo_id()`,
    [id],
  );
  if (!row.rows[0]) throw new ServiceError(404, 'Resource not available.');
  return row.rows[0];
}
export async function getTlv5ReviewerCase(actor: Actor, id: string): Promise<Tlv5ReviewerCase> {
  requireRole(actor, 'REVIEWER');
  caseId(id);
  return run(actor, async (tx) => {
    const a = await myAssignment(tx, id);
    const state = await readState(tx, actor);
    const submissions = await readSubmissions(tx, a.assignment_id);
    const bound = await rubricBinding(tx, a.mode);
    const rubricMismatch =
      bound !== null &&
      (bound.rubric_sha256 !== rubricSha256() || bound.rubric_version !== TLV5_RUBRIC_VERSION);
    const detail: Tlv5ReviewerCase = {
      caseId: id,
      mode: a.mode,
      assignmentId: a.assignment_id,
      packet: packetOf(a),
      submissions,
      submissionsOpen: state.submissionsOpen[a.mode] && submissions.length === 0 && !rubricMismatch,
      rubricMismatch,
    };
    if (a.mode === 'TRAINING')
      detail.workedAnswer = submissions.length ? workedAnswer(id, !!state.locks.TRAINING) : null;
    return detail;
  });
}
/** Worked answers come from the PRIVATE worked-examples file outside the repository, if configured. */
function workedAnswer(id: string, trainingLocked: boolean): Tlv5ReviewerCase['workedAnswer'] {
  const file = process.env.VERIFY_TLV5_WORKED_EXAMPLES_PATH;
  if (!file) return null;
  try {
    // Dynamic path from the environment: never a repository file, never bundled by the build tracer.
    const text = readFileSync(file, 'utf8');
    const example = (
      JSON.parse(text).examples as {
        case_id: string;
        submissions: {
          reviewer_slot: number;
          rpc_tlv5_submit: { items: Record<string, unknown>[] };
        }[];
        training_reference_after_lock: {
          item_code: string;
          reference_answer: string | null;
          reference_detail: string | null;
          adjudication_status: string;
        }[];
      }[]
    ).find((e) => e.case_id === id);
    if (!example) return null;
    const hideOutcome = process.env.VERIFY_TLV5_HIDE_TRAINING_OUTCOME === '1';
    const items: Tlv5ItemInput[] = example.submissions.flatMap((s) =>
      s.rpc_tlv5_submit.items.map((i) => ({
        itemCode: `${i.item_code}`,
        answer: `slot ${s.reviewer_slot}: ${i.answer}`,
        uncertain: Boolean(i.uncertain),
        ...(i.note ? { note: String(i.note) } : {}),
        ...(i.detail_code ? { detailCode: String(i.detail_code) } : {}),
      })),
    );
    const reference =
      trainingLocked && !hideOutcome
        ? example.training_reference_after_lock
            .map(
              (r) =>
                `${r.item_code}: ${r.reference_answer ?? 'unresolved'}${r.reference_detail ? ' / ' + r.reference_detail : ''} (${r.adjudication_status})`,
            )
            .join('\n')
        : '';
    return {
      items,
      note: reference
        ? `Training reference after the lock:\n${reference}`
        : 'Both worked forms are shown; the adjudicated outcome appears after the training lock.',
    };
  } catch {
    return null;
  }
}
export async function submitTlv5(
  actor: Actor,
  id: string,
  input: Tlv5SubmissionInput,
): Promise<Tlv5ReviewerCase> {
  requireRole(actor, 'REVIEWER');
  caseId(id);
  await run(actor, async (tx) => {
    const a = await myAssignment(tx, id);
    await bindRubric(tx, a.mode);
    const payload = {
      items: input.items.map((i) => ({
        item_code: i.itemCode,
        answer: i.answer,
        uncertain: i.uncertain,
        note: i.note?.trim() || null,
        detail_code: i.detailCode || null,
      })),
      overall_comment: input.overallComment?.trim() || null,
      packet_issue_flag: input.packetIssueFlag,
      packet_issue_note: input.packetIssueFlag ? input.packetIssueNote?.trim() || null : null,
      seconds_on_case: input.secondsOnCase ?? null,
    };
    await tx.query('select public.rpc_tlv5_submit($1, $2::jsonb)', [
      a.assignment_id,
      JSON.stringify(payload),
    ]);
  });
  return getTlv5ReviewerCase(actor, id);
}

// ---------------------------------------------------------------------------------------------
// Adjudicator
// ---------------------------------------------------------------------------------------------
async function getAdjudicatorWorkspace(actor: Actor): Promise<Tlv5AdjudicatorWorkspace> {
  return run(actor, async (tx) => {
    const rows = await tx.query<{
      case_id: string;
      mode: Tlv5Mode;
      title: string;
      needing: string | number;
      adjudicated: string | number;
      answered: string | number;
    }>(
      `select q.case_id, q.mode, c.packet ->> 'case_title' as title,
              count(*) filter (where q.needs_adjudication and not q.adjudicated) as needing,
              count(*) filter (where q.adjudicated) as adjudicated, count(*) as answered
       from public.v_tlv5_adjudication_queue q join public.tlv5_cases c on c.case_id = q.case_id
       group by q.case_id, q.mode, c.packet ->> 'case_title' order by q.mode, q.case_id`,
    );
    return {
      kind: 'adjudicator',
      user: actor,
      cases: rows.rows.map((r) => ({
        caseId: r.case_id,
        mode: r.mode,
        title: r.title,
        itemsNeedingAdjudication: Number(r.needing),
        itemsAdjudicated: Number(r.adjudicated),
        itemsWithAnswers: Number(r.answered),
      })),
      state: await readState(tx, actor),
      rubricVersion: TLV5_RUBRIC_VERSION,
    };
  });
}
function adjudicationOpen(mode: Tlv5Mode, state: Tlv5State): boolean {
  if (mode === 'PILOT') return !state.locks.PILOT;
  if (mode === 'TRAINING') return !state.locks.TRAINING && state.phase === 'NOT_OPENED';
  if (mode === 'FORMAL')
    return state.phase === 'CLOSED' && state.snapshotTaken && !state.locks.FORMAL;
  return false;
}
export async function getTlv5AdjudicatorCase(
  actor: Actor,
  id: string,
): Promise<Tlv5AdjudicatorCaseDetail> {
  requireRole(actor, 'ADJUDICATOR', 'INVESTIGATOR');
  caseId(id);
  return run(actor, async (tx) => {
    const c = await tx.query<{ mode: Tlv5Mode; packet: Tlv5TrialPacket }>(
      'select mode, packet from public.tlv5_cases where case_id = $1',
      [id],
    );
    if (!c.rows[0]) throw new ServiceError(404, 'Resource not available.');
    const queue = await tx.query<{
      item_code: string;
      reviewer_1_answer: string | null;
      reviewer_1_detail: string | null;
      reviewer_2_answer: string | null;
      reviewer_2_detail: string | null;
      needs_adjudication: boolean;
      adjudicated: boolean;
    }>('select * from public.v_tlv5_adjudication_queue where case_id = $1', [id]);
    if (!queue.rows.length) throw new ServiceError(404, 'Resource not available.');
    const notes = await tx.query<{
      reviewer_slot: number;
      item_code: string;
      uncertain: boolean;
      note: string | null;
    }>(
      `select a.reviewer_slot, i.item_code, i.uncertain, i.note
       from public.tlv5_assignments a
       join public.tlv5_submissions s on s.assignment_id = a.assignment_id
         and s.revision_number = (select max(s2.revision_number) from public.tlv5_submissions s2 where s2.assignment_id = a.assignment_id)
       join public.tlv5_submission_items i on i.submission_id = s.submission_id
       where a.case_id = $1`,
      [id],
    );
    const noteOf = (slot: number, item: string) =>
      notes.rows.find((n) => n.reviewer_slot === slot && n.item_code === item);
    const adjudications = await tx.query<{
      adjudication_id: string;
      item_code: string;
      decision: string | null;
      detail_code: string | null;
      status: string;
      basis: string;
      rationale: string;
      disagreement_reason_code: string | null;
      adjudicator_role: string | null;
      adjudication_blinded: boolean | null;
      post_unblinding: boolean;
      decided_at: string;
    }>(
      `select adjudication_id, item_code, decision, detail_code, status, basis, rationale, disagreement_reason_code, adjudicator_role,
              adjudication_blinded, post_unblinding, ${TS('decided_at')} as decided_at
       from public.tlv5_adjudications where case_id = $1 order by decided_at`,
      [id],
    );
    const state = await readState(tx, actor);
    return {
      caseId: id,
      mode: c.rows[0].mode,
      packet: packetOf(c.rows[0]),
      items: queue.rows
        .sort((a, b) => REVIEWER_ITEMS.indexOf(a.item_code) - REVIEWER_ITEMS.indexOf(b.item_code))
        .map((q) => ({
          itemCode: q.item_code,
          reviewer1Answer: q.reviewer_1_answer,
          reviewer1Detail: q.reviewer_1_detail,
          reviewer1Uncertain: noteOf(1, q.item_code)?.uncertain ?? null,
          reviewer1Note: noteOf(1, q.item_code)?.note ?? null,
          reviewer2Answer: q.reviewer_2_answer,
          reviewer2Detail: q.reviewer_2_detail,
          reviewer2Uncertain: noteOf(2, q.item_code)?.uncertain ?? null,
          reviewer2Note: noteOf(2, q.item_code)?.note ?? null,
          needsAdjudication: q.needs_adjudication,
          adjudicated: q.adjudicated,
        })),
      adjudications: adjudications.rows.map((j) => ({
        adjudicationId: j.adjudication_id,
        itemCode: j.item_code,
        decision: j.decision,
        detailCode: j.detail_code,
        status: j.status,
        basis: j.basis,
        rationale: j.rationale,
        disagreementReasonCode: j.disagreement_reason_code,
        adjudicatorRole: j.adjudicator_role,
        blinded: j.adjudication_blinded,
        postUnblinding: j.post_unblinding,
        decidedAt: j.decided_at,
      })),
      adjudicationOpen: adjudicationOpen(c.rows[0].mode, state),
      adjudicationScope: state.adjudicationScope,
    };
  });
}
export async function recordTlv5Adjudication(
  actor: Actor,
  input: Tlv5AdjudicationInput,
): Promise<Tlv5AdjudicatorCaseDetail> {
  // Migration 0011 lets an investigator adjudicate PILOT and TRAINING items; this application keeps
  // the stricter standing instruction (an investigator never writes a judgment) and exposes
  // adjudication to the ADJUDICATOR role only. See docs/OPEN_QUESTIONS.md.
  requireRole(actor, 'ADJUDICATOR');
  caseId(input.caseId);
  await run(actor, async (tx) => {
    const mode = await tx.query<{ mode: Tlv5Mode }>(
      'select mode from public.tlv5_cases where case_id = $1',
      [input.caseId],
    );
    // A case the adjudicator cannot read yet (before the close and snapshot) is refused by the
    // RPC itself with the phase message; binding happens once the case is readable.
    if (mode.rows[0]) await bindRubric(tx, mode.rows[0].mode);
    await tx.query('select public.rpc_tlv5_record_adjudication($1::jsonb)', [
      JSON.stringify({
        case_id: input.caseId,
        item_code: input.itemCode,
        decision: input.decision,
        detail_code: input.detailCode || null,
        status: input.status,
        basis: input.basis,
        rationale: input.rationale.trim(),
        disagreement_reason_code: input.disagreementReasonCode || null,
      }),
    ]);
  });
  return getTlv5AdjudicatorCase(actor, input.caseId);
}

// ---------------------------------------------------------------------------------------------
// Investigator
// ---------------------------------------------------------------------------------------------
async function completion(tx: Tx, mode: Tlv5Mode): Promise<Tlv5CompletionRow[]> {
  const rows = await tx.query<{
    reviewer_pseudo_id: string;
    reviewer_slot: number;
    n_assigned: string | number;
    n_submitted: string | number;
    n_with_revisions: string | number;
  }>('select * from public.rpc_tlv5_completion_summary($1)', [mode]);
  return rows.rows.map((r) => ({
    reviewerPseudoId: r.reviewer_pseudo_id,
    reviewerSlot: r.reviewer_slot,
    assigned: Number(r.n_assigned),
    submitted: Number(r.n_submitted),
    withRevisions: Number(r.n_with_revisions),
  }));
}
async function getInvestigatorWorkspace(actor: Actor): Promise<Tlv5InvestigatorWorkspace> {
  return run(actor, async (tx) => {
    const state = await readState(tx, actor);
    const counts: Record<Tlv5Mode, number> = { PILOT: 0, CALIBRATION: 0, TRAINING: 0, FORMAL: 0 };
    for (const r of (
      await tx.query<{ mode: Tlv5Mode; n: string | number }>(
        'select mode, count(*) as n from public.tlv5_cases group by mode',
      )
    ).rows)
      counts[r.mode] = Number(r.n);
    const completionByMode = { PILOT: [], CALIBRATION: [], TRAINING: [], FORMAL: [] } as Record<
      Tlv5Mode,
      Tlv5CompletionRow[]
    >;
    for (const mode of ['PILOT', 'CALIBRATION', 'TRAINING', 'FORMAL'] as const)
      completionByMode[mode] = await completion(tx, mode);
    const reviewers = await tx.query<{
      reviewer_pseudo_id: string;
      mode_scope: 'PILOT' | 'FORMAL';
      user_id: string;
      withdrawn_at: string | null;
    }>(
      'select reviewer_pseudo_id, mode_scope, user_id, withdrawn_at from public.reviewers order by enrolled_at',
    );
    const candidates = await tx.query<{ user_id: string; display_name: string }>(
      `select u.user_id, u.display_name from public.users u where u.role = 'REVIEWER' and not u.is_pilot_test_account and u.is_active
         and not exists (select 1 from public.reviewers r where r.user_id = u.user_id and r.withdrawn_at is null) order by u.created_at`,
    );
    const exports = await tx.query<{
      export_id: string;
      mode: string;
      created_at: string;
      manifest_sha256: string;
      app_git_sha: string;
    }>(
      `select export_id, mode, ${TS('created_at')} as created_at, manifest_sha256, app_git_sha from public.tlv5_exports order by created_at`,
    );
    const verification: Tlv5InvestigatorWorkspace['verification'] = {
      frozenLabels: null,
      snapshot: null,
    };
    if (state.frozen) {
      const v = await tx.query<{ matches: boolean; frozen_rows: number; current_rows: number }>(
        'select matches, frozen_rows, current_rows from public.rpc_tlv5_verify_frozen_labels()',
      );
      if (v.rows[0])
        verification.frozenLabels = {
          matches: v.rows[0].matches,
          frozenRows: v.rows[0].frozen_rows,
          currentRows: v.rows[0].current_rows,
        };
    }
    if (state.snapshot) {
      const v = await tx.query<{ matches: boolean; snapshot_rows: number; current_rows: number }>(
        'select matches, snapshot_rows, current_rows from public.rpc_tlv5_verify_snapshot()',
      );
      if (v.rows[0])
        verification.snapshot = {
          matches: v.rows[0].matches,
          snapshotRows: v.rows[0].snapshot_rows,
          currentRows: v.rows[0].current_rows,
        };
    }
    return {
      kind: 'investigator',
      user: actor,
      state,
      counts,
      completion: completionByMode,
      reviewers: reviewers.rows.map((r) => ({
        pseudoId: r.reviewer_pseudo_id,
        modeScope: r.mode_scope,
        account: accountOf(r.user_id),
        withdrawn: !!r.withdrawn_at,
      })),
      formalCandidates: candidates.rows.map((c) => ({
        account: accountOf(c.user_id) ?? c.user_id,
        userId: c.user_id,
        displayName: c.display_name,
      })),
      exports: exports.rows.map((e) => ({
        exportId: e.export_id,
        mode: e.mode,
        createdAt: e.created_at,
        manifestSha256: e.manifest_sha256,
        appGitSha: e.app_git_sha,
      })),
      verification,
      rubricVersion: TLV5_RUBRIC_VERSION,
      rubricSha256: rubricSha256(),
      appGitSha: appGitSha(),
    };
  });
}

export function pilotPacket(c: Tlv5PilotCase): Tlv5TrialPacket {
  return {
    schema_version: '5.1',
    case_title: c.briefTitle,
    trial: {
      nct_id: c.nctId,
      brief_title: c.briefTitle,
      official_title: c.officialTitle,
      conditions_registered: c.conditionsRegistered,
      condition_mesh_headings: c.conditionMeshHeadings,
      brief_summary: c.briefSummary,
      interventions: c.interventions.map((i) => ({
        intervention_type: i.interventionType,
        name: i.name,
        description: i.description,
      })),
      eligibility_age_range: { minimum_age: c.minimumAge, maximum_age: c.maximumAge },
    },
    notices: [
      'SYNTHETIC CASE for application testing only; a fictional trial; excluded from all statistics.',
    ],
  };
}
export function pilotDesign(c: Tlv5PilotCase) {
  return {
    nct_id: c.nctId,
    frame: 'SYN_FRAME',
    stratum: 'SYN_P01',
    variance_stratum: 'SYN_P01',
    frame_stratum_size: 20,
    n_sampled_in_stratum: 10,
    selection_probability: 0.5,
    sampling_seed: 20261022,
    prn: null,
    design_version: PILOT_DESIGN_VERSION,
    in_mixed_sex_cohort: true,
    figure2_rows: c.figure2Rows.join('|'),
    dev_linked: false,
    tier1_eligible: true,
  };
}
export function pilotLabels(c: Tlv5PilotCase): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = AREA_KEYS.map((a) => ({
    label_set_id: PILOT_LABEL_SET,
    case_id: c.caseId,
    item_code: `AREA_${a}`,
    label_primary: c.tier0Areas.includes(a) ? 'YES' : 'NO',
    label_secondary: c.curatedV12Areas.includes(a) ? 'YES' : 'NO',
    label_informational: null,
    dev_linked_area: false,
  }));
  for (const r of ROW_KEYS)
    rows.push({
      label_set_id: PILOT_LABEL_SET,
      case_id: c.caseId,
      item_code: `FIG2_ROW_${r}`,
      label_primary: c.figure2Rows.includes(r) ? 'YES' : 'NO',
    });
  if (c.ruleD)
    rows.push({
      label_set_id: PILOT_LABEL_SET,
      case_id: c.caseId,
      item_code: 'RULE_D',
      label_primary: c.ruleD,
    });
  if (c.ruleK)
    rows.push({
      label_set_id: PILOT_LABEL_SET,
      case_id: c.caseId,
      item_code: 'RULE_K',
      label_primary: c.ruleK,
    });
  return rows;
}

/** Lower-level investigator operations, shared by the admin actions and the staging dry-run script. */
export async function importTlv5Case(
  actor: Actor,
  payload: {
    case_id: string;
    mode: Tlv5Mode;
    packet: Tlv5TrialPacket;
    design?: Record<string, unknown>;
  },
) {
  requireRole(actor, 'INVESTIGATOR');
  await run(actor, (tx) =>
    tx.query('select public.rpc_tlv5_import_case($1::jsonb)', [JSON.stringify(payload)]),
  );
}
export async function importTlv5Labels(
  actor: Actor,
  rows: Record<string, unknown>[],
): Promise<number> {
  requireRole(actor, 'INVESTIGATOR');
  return run(actor, async (tx) =>
    Number(
      (
        await tx.query<{ n: number }>(
          'select public.rpc_tlv5_import_frozen_labels($1::jsonb) as n',
          [JSON.stringify(rows)],
        )
      ).rows[0].n,
    ),
  );
}
export async function assignTlv5(
  actor: Actor,
  mode: Tlv5Mode,
  pseudoId: string,
  slot: 1 | 2,
  caseIds: string[],
  seed: number,
): Promise<number> {
  requireRole(actor, 'INVESTIGATOR');
  return run(actor, async (tx) =>
    Number(
      (
        await tx.query<{ n: number }>(
          'select public.rpc_tlv5_assign($1, $2, $3, $4::text[], $5) as n',
          [mode, pseudoId, slot, caseIds, seed],
        )
      ).rows[0].n,
    ),
  );
}
export async function enrollTlv5Formal(
  actor: Actor,
  userId: string,
  qualifications?: string,
): Promise<string> {
  requireRole(actor, 'INVESTIGATOR');
  return run(
    actor,
    async (tx) =>
      (
        await tx.query<{ pid: string }>('select public.rpc_tlv5_enroll_reviewer($1, $2) as pid', [
          userId,
          qualifications ?? null,
        ])
      ).rows[0].pid,
  );
}
export async function enrollPilotReviewer(actor: Actor, userId: string): Promise<string> {
  requireRole(actor, 'INVESTIGATOR');
  return run(
    actor,
    async (tx) =>
      (
        await tx.query<{ pid: string }>(
          "select public.rpc_enroll_reviewer($1, 'PILOT', 'synthetic pilot test account') as pid",
          [userId],
        )
      ).rows[0].pid,
  );
}
export async function freezeTlv5(
  actor: Actor,
  input: { labelFileSha256: string; frozenItems: Record<string, string>; attestation: string },
) {
  requireRole(actor, 'INVESTIGATOR');
  await run(actor, (tx) =>
    tx.query('select public.rpc_tlv5_freeze($1::jsonb)', [
      JSON.stringify({
        label_file_sha256: input.labelFileSha256.toLowerCase(),
        frozen_items: input.frozenItems,
        attestation: input.attestation,
      }),
    ]),
  );
}
async function reviewerPseudoIds(tx: Tx, scope: 'PILOT' | 'FORMAL'): Promise<string[]> {
  const rows = await tx.query<{ reviewer_pseudo_id: string }>(
    'select reviewer_pseudo_id from public.reviewers where mode_scope = $1 and withdrawn_at is null order by enrolled_at',
    [scope],
  );
  return rows.rows.map((r) => r.reviewer_pseudo_id);
}

export async function tlv5AdminAction(
  actor: Actor,
  input: Tlv5AdminAction,
): Promise<Tlv5InvestigatorWorkspace> {
  requireRole(actor, 'INVESTIGATOR');
  // Scientific approval is not represented by the draft rubric or a free-text attestation.
  // Formal orchestration stays disabled in the web app until an approved mechanism exists.
  if (
    ['activate', 'enroll-formal', 'freeze'].includes(input.action) ||
    (input.action === 'phase' && input.eventType === 'FORMAL_OPENED') ||
    (input.action === 'assign' && input.mode === 'FORMAL')
  )
    throw new ServiceError(
      409,
      'Formal activation is disabled pending scientific approval and a frozen approved rubric.',
    );
  switch (input.action) {
    case 'import-pilot': {
      await run(actor, async (tx) => {
        const existing = await tx.query<{ n: string | number }>(
          "select count(*) as n from public.tlv5_cases where mode = 'PILOT'",
        );
        if (Number(existing.rows[0].n))
          throw new ServiceError(409, 'The synthetic pilot cases are already imported.');
        for (const c of TLV5_PILOT_CASES)
          await tx.query('select public.rpc_tlv5_import_case($1::jsonb)', [
            JSON.stringify({
              case_id: c.caseId,
              mode: 'PILOT',
              packet: pilotPacket(c),
              design: pilotDesign(c),
            }),
          ]);
        await tx.query('select public.rpc_tlv5_import_frozen_labels($1::jsonb)', [
          JSON.stringify(TLV5_PILOT_CASES.flatMap(pilotLabels)),
        ]);
      });
      break;
    }
    case 'assign': {
      await run(actor, async (tx) => {
        let pseudos: string[];
        if (input.mode === 'PILOT') {
          // The two investigator-operated pilot test accounts, enrolled on first use (v2 path, unchanged).
          pseudos = await reviewerPseudoIds(tx, 'PILOT');
          for (const pilotActor of [DEMO_ACTORS[1], DEMO_ACTORS[2]]) {
            const has = await tx.query<{ n: string | number }>(
              'select count(*) as n from public.reviewers where user_id = $1 and withdrawn_at is null',
              [pilotActor.id],
            );
            if (!Number(has.rows[0].n))
              await tx.query(
                "select public.rpc_enroll_reviewer($1, 'PILOT', 'synthetic pilot test account')",
                [pilotActor.id],
              );
          }
          pseudos = await reviewerPseudoIds(tx, 'PILOT');
        } else pseudos = await reviewerPseudoIds(tx, 'FORMAL');
        if (pseudos.length < 2)
          throw new ServiceError(
            409,
            'Two enrolled reviewers of the right scope are required before assignment.',
          );
        const ids = (
          await tx.query<{ case_id: string }>(
            'select case_id from public.tlv5_cases where mode = $1 order by case_id',
            [input.mode],
          )
        ).rows.map((r) => r.case_id);
        if (!ids.length) throw new ServiceError(409, 'No cases of this mode to assign.');
        const assigned = (
          await tx.query<{ case_id: string; reviewer_pseudo_id: string }>(
            'select case_id, reviewer_pseudo_id from public.tlv5_assignments where mode = $1',
            [input.mode],
          )
        ).rows;
        for (const [index, pseudo] of pseudos.slice(0, 2).entries()) {
          const remaining = ids.filter(
            (id) => !assigned.some((a) => a.case_id === id && a.reviewer_pseudo_id === pseudo),
          );
          if (remaining.length)
            await tx.query('select public.rpc_tlv5_assign($1, $2, $3, $4::text[], $5)', [
              input.mode,
              pseudo,
              index + 1,
              remaining,
              input.seed,
            ]);
        }
      });
      break;
    }
    case 'lock':
      await run(actor, (tx) =>
        tx.query('select public.rpc_tlv5_lock_reference($1, $2)', [input.mode, input.attestation]),
      );
      break;
    case 'register-export': {
      const bundle = await exportTlv5Bundle(actor, input.mode);
      await run(actor, async (tx) => {
        await bindRubric(tx, input.mode);
        await tx.query('select public.rpc_tlv5_register_export($1::jsonb)', [
          JSON.stringify({
            mode: input.mode,
            bundle_format_version: '5.0',
            row_counts: Object.fromEntries(bundle.files.map((f) => [f.role, f.rows])),
            file_sha256: Object.fromEntries(bundle.files.map((f) => [f.name, f.sha256])),
            manifest_sha256: bundle.manifestSha256,
            app_git_sha: appGitSha(),
            notes:
              `manifest export_id ${bundle.manifest.export_id}; ${input.notes?.trim() ?? ''}`.trim(),
          }),
        ]);
      });
      break;
    }
    case 'sign-off':
      await run(actor, async (tx) => {
        const latest = await tx.query<{ export_id: string }>(
          "select export_id from public.tlv5_exports where mode = 'PILOT' order by created_at desc limit 1",
        );
        if (!latest.rows[0])
          throw new ServiceError(409, 'Register the pilot export before the sign-off.');
        await tx.query("select public.rpc_tlv5_phase('PILOT_SIGNED_OFF', $1::jsonb)", [
          JSON.stringify({
            checklist_version: input.checklistVersion,
            checklist_sha256: input.checklistSha256.toLowerCase(),
            app_git_sha: appGitSha(),
            pilot_export_id: latest.rows[0].export_id,
            attestation: input.attestation,
          }),
        ]);
      });
      break;
    case 'activate':
      await run(actor, (tx) =>
        tx.query('select public.rpc_tlv5_activate($1, $2, $3)', [
          input.designVersion,
          input.adjudicationScope,
          input.attestation,
        ]),
      );
      break;
    case 'enroll-formal':
      await enrollTlv5Formal(actor, input.userId, input.qualifications);
      break;
    case 'freeze':
      await freezeTlv5(actor, {
        labelFileSha256: input.labelFileSha256,
        frozenItems: { rubric: rubricSha256(), label_file: input.labelFileSha256.toLowerCase() },
        attestation: input.attestation,
      });
      break;
    case 'phase':
      await run(actor, (tx) =>
        tx.query('select public.rpc_tlv5_phase($1, $2::jsonb)', [
          input.eventType,
          JSON.stringify({ attestation: input.attestation }),
        ]),
      );
      break;
    case 'snapshot':
      await run(actor, (tx) => tx.query('select public.rpc_tlv5_snapshot()'));
      break;
    case 'provision-staging-accounts':
      // Synthetic FORMAL-scope test identities for training examples and formal dry runs only.
      await provisionStagingAccounts();
      break;
  }
  return getInvestigatorWorkspace(actor);
}

// ---------------------------------------------------------------------------------------------
// Export bundle (format 5.0)
// ---------------------------------------------------------------------------------------------
export async function exportTlv5Bundle(
  actor: Actor,
  mode: 'PILOT' | 'FORMAL',
): Promise<Tlv5Bundle> {
  requireRole(actor, 'INVESTIGATOR');
  return run(actor, async (tx) => {
    const state = await readState(tx, actor);
    const lock = state.locks[mode];
    if (!lock) throw new ServiceError(409, 'Lock the reference before exporting.');
    const lockRow = await tx.query<{ lock_id: string }>(
      'select lock_id from public.tlv5_reference_locks where mode = $1',
      [mode],
    );
    const lockId = lockRow.rows[0].lock_id;
    const judgments = (
      await tx.query<Row>(
        `select record_category, case_id, mode, nct_id, item_family, item_code, reviewer_slot, reviewer_pseudo_id, answer_initial,
                answer_effective_preclose, detail_initial, detail_effective, n_revisions_preclose::integer as n_revisions_preclose,
                uncertain, packet_issue_flag, ${TS('first_submitted_at')} as first_submitted_at, ${TS('last_submitted_at')} as last_submitted_at
         from public.v_tlv5_independent_judgments where mode = $1`,
        [mode],
      )
    ).rows;
    const reference = (
      await tx.query<Row>(
        `select record_category, case_id, mode, item_family, item_code, adjudication_id, reference_answer, reference_detail, adjudication_status,
                adjudication_basis, n_reviewers_submitted::integer as n_reviewers_submitted, n_reviewer_answers::integer as n_reviewer_answers,
                disagreement_reason_code, adjudicator_pseudo_id, adjudicator_role, adjudication_blinded, post_unblinding_revision_exists,
                ${TS('adjudicated_at')} as adjudicated_at, reference_lock_id::text as reference_lock_id
         from public.v_tlv5_adjudicated_reference where mode = $1`,
        [mode],
      )
    ).rows;
    const labels = (
      await tx.query<Row>(
        `select label_set_id, record_category, case_id, mode, nct_id, item_family, item_code, label_primary, label_secondary, label_informational,
                dev_linked_area, ${TS('label_frozen_at')} as label_frozen_at, frame, stratum, variance_stratum, frame_stratum_size::integer as frame_stratum_size,
                n_sampled_in_stratum::integer as n_sampled_in_stratum, selection_probability::text as selection_probability, sampling_weight::text as sampling_weight,
                dev_linked, tier1_eligible, design_version
         from public.v_tlv5_frozen_labels where mode = $1`,
        [mode],
      )
    ).rows;
    const designVersion = String(
      labels[0]?.design_version ?? state.activation?.designVersion ?? PILOT_DESIGN_VERSION,
    );
    const labelSetId = String(labels[0]?.label_set_id ?? PILOT_LABEL_SET);
    const events = await tx.query<{ event_type: string; occurred_at: string }>(
      `select event_type, ${TS('occurred_at')} as occurred_at from public.tlv5_phase_events order by event_seq`,
    );
    const opened =
      events.rows.filter((e) => e.event_type === 'FORMAL_OPENED').at(-1)?.occurred_at ?? null;
    const closedEvent =
      events.rows.filter((e) => e.event_type.startsWith('FORMAL_CLOSED')).at(-1) ?? null;
    const scope = state.activation?.adjudicationScope ?? 'DISAGREEMENTS_ONLY';
    const buildSha = appGitSha();
    if (!/^[0-9a-f]{40}$/.test(buildSha) || /^0{40}$/.test(buildSha))
      throw new ServiceError(409, 'Export requires a verified application build commit.');
    let exportedRubricHash = rubricSha256();
    // The export reports the rubric bound to the mode's first review activity and refuses to
    // attest a runtime rubric that differs from it (migration 0017).
    const bound = await rubricBinding(tx, mode);
    if (
      bound &&
      (bound.rubric_sha256 !== exportedRubricHash || bound.rubric_version !== TLV5_RUBRIC_VERSION)
    )
      throw new ServiceError(
        409,
        'The rubric text changed since this review began; the export is blocked until the investigator reconciles the rubric.',
      );
    if (mode === 'FORMAL') {
      const frozen = await tx.query<{ frozen_items: Record<string, string> }>(
        'select frozen_items from public.tlv5_freeze',
      );
      const frozenHash = frozen.rows[0]?.frozen_items?.rubric;
      if (!frozenHash || frozenHash !== exportedRubricHash)
        throw new ServiceError(
          409,
          'The runtime rubric does not match the frozen rubric; export is blocked.',
        );
      exportedRubricHash = frozenHash;
    }
    const manifest = {
      export_id: manifestExportId(mode, lockId),
      mode,
      created_at: lock.lockedAt,
      app_git_sha: buildSha,
      design_version: designVersion,
      adjudication_scope: scope,
      label_set_id: labelSetId,
      frozen_at: mode === 'FORMAL' && state.frozen ? state.frozen.frozenAt : lock.lockedAt,
      frozen_case_list_sha256:
        mode === 'FORMAL' && state.frozen
          ? state.frozen.caseListSha256
          : caseListSha256(labels.map((r) => String(r.case_id))),
      frozen_label_rows_sha256:
        mode === 'FORMAL' && state.frozen ? state.frozen.labelRowsSha256 : labelRowsSha256(labels),
      formal_phase_opened_at: mode === 'FORMAL' ? opened : null,
      formal_phase_closed_at: mode === 'FORMAL' ? (closedEvent?.occurred_at ?? null) : null,
      formal_phase_status:
        mode === 'FORMAL'
          ? closedEvent?.event_type === 'FORMAL_CLOSED_COMPLETE'
            ? 'CLOSED_COMPLETE'
            : 'CLOSED_INCOMPLETE'
          : 'PILOT',
      snapshot_taken_at: mode === 'FORMAL' ? (state.snapshot?.takenAt ?? null) : null,
      snapshot_sha256: mode === 'FORMAL' ? (state.snapshot?.sha256 ?? null) : null,
      snapshot_rows: mode === 'FORMAL' ? (state.snapshot?.rows ?? null) : null,
      reference_lock_id: lockId,
      reference_locked_at: lock.lockedAt,
      rubric_version: TLV5_RUBRIC_VERSION,
      rubric_sha256: exportedRubricHash,
      // A pilot bundle is a real export of synthetic pilot cases (analysed with --allow-pilot only);
      // the fixture flag marks a FORMAL-shaped bundle whose every case is a TESTFX test case.
      is_synthetic_fixture:
        mode === 'FORMAL' && labels.every((r) => /^TLV5-TESTFX-/.test(String(r.case_id))),
    };
    return buildTlv5Bundle(manifest, judgments, reference, labels);
  });
}
export { manifestText };
