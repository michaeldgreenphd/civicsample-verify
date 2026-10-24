// Review design v7 (mapping units) service, written once against two operations: read a table or
// view under the caller's row-level security, and call an rpc_mu7_* function. The local PGlite
// path (src/server/mu7.ts) and the Supabase path (src/server/mu7-rest.ts) supply those operations,
// so both deployment modes share every DTO and rule. The application adds no rule of its own and
// never decides what a role may see (APP_MAPPING_v7.md); it projects allow-listed fields only.
// FORMAL operations are not offered: the freeze and the formal opening wait for specified and
// approved study decisions (migration 0026), and no button or route here records either.
import {
  mu7PacketView,
  mu7ReasonCodes,
  MU7_DISAGREEMENT_REASONS,
  MU7_REASON_MEANING,
  type Mu7AdjudicationInput,
  type Mu7AdjudicationStatus,
  type Mu7AdjudicatorUnit,
  type Mu7AdjudicatorWorkspace,
  type Mu7AdminAction,
  type Mu7Answer,
  type Mu7Bundle,
  type Mu7FinalStatus,
  type Mu7GateStatus,
  type Mu7InvestigatorWorkspace,
  type Mu7Mode,
  type Mu7ReviewerUnit,
  type Mu7ReviewerWorkspace,
  type Mu7Routing,
  type Mu7SlotAnswer,
  type Mu7SubmissionInput,
  type Mu7TrainingView,
  type Mu7WorkedExample,
  type Mu7Workspace,
} from '../lib/mu7-types';
import {
  buildMu7Bundle,
  mu7CellText,
  mu7RegistrationPayload,
  MU7_EXPORT_COLUMNS,
  MU7_EXPORT_VIEWS,
  type Mu7ExportRole,
  type Mu7Row,
} from '../lib/mu7-export';
import {
  MU7_PILOT_EXPECTED_ROUTING,
  MU7_PILOT_IMPORTS,
  MU7_SYNTHETIC_DESIGN,
  MU7_SYNTHETIC_TRAINING,
  mu7PilotQueues,
} from '../lib/mu7-synthetic';
import { MU7_ASSIGNMENT_ID, MU7_UNIT_ID } from '../lib/mu7-validation';
import { ServiceError } from './service';

export type Mu7Filter = Record<string, string | number | boolean | null>;
export interface Mu7Data {
  /** Read a table or view under the caller's row-level security. */
  select<T = Mu7Row>(
    relation: string,
    options?: { columns?: readonly string[]; eq?: Mu7Filter; order?: string[] },
  ): Promise<T[]>;
  /** Call an RPC with named arguments: 'value' returns its scalar, 'rows' its result set. */
  rpc<T = unknown>(fn: string, args: Record<string, unknown>, shape: 'value' | 'rows'): Promise<T>;
}
export interface Mu7Context {
  role: 'INVESTIGATOR' | 'REVIEWER' | 'ADJUDICATOR';
  /** Runs one service operation with the caller's data access (one transaction locally). */
  withData<T>(operation: (data: Mu7Data) => Promise<T>): Promise<T>;
  appGitSha: string;
  /** Every database this build serves holds synthetic records only. */
  syntheticDatabase: boolean;
  /** Local synthetic mode only: the privileged identity tool's lock and release, for testing. */
  localTools?: {
    lockAccount(account: string, reason: string): Promise<void>;
    unlockAccount(account: string): Promise<void>;
  };
}

// ---------------------------------------------------------------------------------------------
// Public errors. Every v7 refusal starts with its guard tag; that authored text is shown as is
// (APP_MAPPING_v7.md, "Error messages"). Anything else becomes a fixed message; SQL never leaks.
// ---------------------------------------------------------------------------------------------
const ROLE_TAGS = new Set(['MU7-G01', 'MU7-G37', 'MU7-G42', 'MU7-G58', 'MU7-G59']);
const NOT_YOURS_TAGS = new Set(['MU7-G54', 'MU7-G57']);
const INPUT_TAGS = new Set([
  'MU7-G07',
  'MU7-G13',
  'MU7-G14',
  'MU7-G15',
  'MU7-G16',
  'MU7-G17',
  'MU7-G18',
  'MU7-G19',
  'MU7-G20',
  'MU7-G35',
  'MU7-G36',
  'MU7-G40',
  'MU7-G47',
  'MU7-G60',
  'MU7-G61',
  'MU7-G62',
  'MU7-G63',
]);
export function mu7PublicError(message: string): ServiceError | null {
  const tagged = /\b((?:MU7X?|MU7C)-G\d{2}): ([^\n]{1,400})/.exec(message);
  if (tagged) {
    const [, tag, text] = tagged;
    if (NOT_YOURS_TAGS.has(tag)) return new ServiceError(404, 'Resource not available.');
    if (ROLE_TAGS.has(tag)) return new ServiceError(403, `${tag}: ${text}`);
    return new ServiceError(INPUT_TAGS.has(tag) ? 400 : 409, `${tag}: ${text}`);
  }
  const constraint = /violates check constraint "(mu7[a-z0-9_]*_ck)"/.exec(message);
  if (constraint) return new ServiceError(400, `The input breaks rule ${constraint[1]}.`);
  if (
    /investigator role|adjudicator role|permission denied|Authenticated role mismatch|42501/.test(
      message,
    )
  )
    return new ServiceError(403, 'This action is not available to your role.');
  if (/duplicate key/.test(message))
    return new ServiceError(
      409,
      'This step was already recorded or conflicts with an existing record.',
    );
  if (/check constraint|violates|invalid input/.test(message))
    return new ServiceError(400, 'The input breaks the rules of this record.');
  return null;
}

function requireRole(ctx: Mu7Context, ...roles: Mu7Context['role'][]) {
  if (!roles.includes(ctx.role))
    throw new ServiceError(403, 'This action is not available to your role.');
}
const notFound = () => new ServiceError(404, 'Resource not available.');
const iso = (v: unknown) => (v === null || v === undefined ? '' : mu7CellText(v));
const bool = (v: unknown) => v === true || v === 't' || v === 'true';
const asAnswer = (v: unknown) =>
  v === null || v === undefined || v === '' ? null : (v as Mu7Answer);
const reasonList = (family: string, code: string) =>
  mu7ReasonCodes(family, code).map((c) => ({ code: c, meaning: MU7_REASON_MEANING[c] ?? '' }));

// ---------------------------------------------------------------------------------------------
// Workspaces
// ---------------------------------------------------------------------------------------------
export async function getMu7Workspace(ctx: Mu7Context): Promise<Mu7Workspace> {
  if (ctx.role === 'INVESTIGATOR') return investigatorWorkspace(ctx);
  if (ctx.role === 'ADJUDICATOR') return adjudicatorWorkspace(ctx);
  return ctx.withData(async (d): Promise<Mu7ReviewerWorkspace> => {
    const design = await d.select('mu7_design', { columns: ['design_id'] });
    const queue = (
      await d.select<Mu7Row>('v_mu7_my_queue', {
        columns: [
          'assignment_id',
          'mode',
          'reviewer_slot',
          'queue_position',
          'unit_id',
          'unit_role',
          'answered',
          'available',
        ],
      })
    )
      .map((r) => ({
        assignmentId: String(r.assignment_id),
        mode: r.mode as Mu7Mode,
        reviewerSlot: Number(r.reviewer_slot) as 1 | 2,
        queuePosition: Number(r.queue_position),
        unitId: String(r.unit_id),
        unitRole: r.unit_role as 'PRIMARY' | 'SUBGROUP',
        answered: bool(r.answered),
        available: bool(r.available),
      }))
      .sort((a, b) =>
        a.mode === b.mode ? a.queuePosition - b.queuePosition : a.mode === 'PILOT' ? -1 : 1,
      );
    const ack = await d.select<{ acknowledged_at: unknown }>('mu7_training_acknowledgments', {
      columns: ['acknowledged_at'],
    });
    return {
      kind: 'reviewer',
      designRecorded: design.length > 0,
      enrolled: queue.length > 0,
      queue,
      training: await readTraining(d),
      trainingAcknowledgedAt: ack[0] ? iso(ack[0].acknowledged_at) : null,
    };
  });
}

export async function readTraining(d: Mu7Data): Promise<Mu7TrainingView[]> {
  const rows = await d.select<{ training_unit_id: string; packet: Record<string, unknown> }>(
    'mu7_training_units',
    { columns: ['training_unit_id', 'packet'], order: ['training_unit_id'] },
  );
  return rows.map((r) => {
    const w = (r.packet.worked_example ?? {}) as Record<string, unknown>;
    const ref = (w.reference ?? {}) as Record<string, unknown>;
    const workedExample: Mu7WorkedExample = {
      outcome_summary: String(w.outcome_summary ?? ''),
      teaching_point: String(w.teaching_point ?? ''),
      worked_answers: (Array.isArray(w.worked_answers) ? w.worked_answers : []).map(
        (a: Record<string, unknown>) => ({
          reviewer_slot: Number(a.reviewer_slot),
          answer: a.answer as Mu7Answer,
          reason_code: typeof a.reason_code === 'string' ? a.reason_code : null,
          note: typeof a.note === 'string' ? a.note : null,
          uncertain: a.uncertain === true,
        }),
      ),
      reference: {
        final_answer: asAnswer(ref.final_answer),
        status: String(ref.status ?? ''),
        basis: String(ref.basis ?? ''),
        rationale: typeof ref.rationale === 'string' ? ref.rationale : null,
      },
    };
    return { trainingUnitId: r.training_unit_id, packet: mu7PacketView(r.packet), workedExample };
  });
}

async function adjudicatorWorkspace(ctx: Mu7Context): Promise<Mu7AdjudicatorWorkspace> {
  requireRole(ctx, 'ADJUDICATOR');
  return ctx.withData(async (d) => {
    const design = await d.select('mu7_design', { columns: ['design_id'] });
    const queue = (
      await d.select<Mu7Row>('v_mu7_adjudication_queue', {
        columns: ['unit_id', 'mode', 'family', 'category', 'unit_role', 'packet', 'adjudicated'],
      })
    )
      .map((r) => {
        const p = mu7PacketView(r.packet as Record<string, unknown>);
        return {
          unitId: String(r.unit_id),
          mode: r.mode as Mu7Mode,
          family: r.family as Mu7AdjudicatorWorkspace['queue'][number]['family'],
          category: String(r.category),
          unitRole: r.unit_role as 'PRIMARY' | 'SUBGROUP',
          mappingLabel: p.unit.mapping_label,
          displayText: p.unit.display_text,
          adjudicated: bool(r.adjudicated),
        };
      })
      .sort((a, b) => (a.unitId < b.unitId ? -1 : a.unitId > b.unitId ? 1 : 0));
    return {
      kind: 'adjudicator',
      designRecorded: design.length > 0,
      queue,
      training: await readTraining(d),
    };
  });
}

/** Why the FORMAL freeze and opening are disabled, from the gate status itself. */
function formalDisabledReason(gates: Mu7GateStatus[]): string {
  const open = (op: string) =>
    gates.filter((g) => g.blocks.includes(op) && !g.satisfied).map((g) => g.gateId);
  const freeze = open('FREEZE');
  const opening = open('FORMAL_OPEN');
  if (!freeze.length && !opening.length)
    return 'Every study-decision gate is approved; the formal operations are still not offered in this build.';
  return `The FORMAL freeze waits for ${freeze.join(', ') || 'no gate'}; the formal opening waits for ${opening.join(', ')}. A gate counts once its requirement is specified by a reviewed migration and the investigator approves it citing that record. The formal operations are not offered in this build.`;
}
async function investigatorWorkspace(ctx: Mu7Context): Promise<Mu7InvestigatorWorkspace> {
  requireRole(ctx, 'INVESTIGATOR');
  return ctx.withData(async (d) => {
    const design = (
      await d.select<Mu7Row>('mu7_design', {
        columns: [
          'design_version',
          'assignment_set_id',
          'overlap_setting',
          'n_primary_planned',
          'n_subgroup_planned',
          'recorded_at',
        ],
      })
    )[0];
    const units = await d.select<{ unit_id: string; mode: Mu7Mode }>('mu7_units', {
      columns: ['unit_id', 'mode'],
    });
    const training = await d.select('mu7_training_units', { columns: ['training_unit_id'] });
    const queue = await d.select<{ reviewer_pseudo_id: string; mode: Mu7Mode }>('mu7_queue', {
      columns: ['reviewer_pseudo_id', 'mode'],
      eq: { mode: 'PILOT' },
    });
    const completion = (
      await d.rpc<Mu7Row[]>('rpc_mu7_completion_summary', { p_mode: 'PILOT' }, 'rows')
    ).map((r) => ({
      reviewerSlot: Number(r.reviewer_slot),
      assigned: Number(r.n_assigned),
      answered: Number(r.n_answered),
    }));
    const finals = await d.select<Mu7Row>('v_mu7_final_reference', {
      columns: ['unit_id', 'family', 'unit_role', 'routing', 'final_status', 'final_answer'],
      eq: { mode: 'PILOT' },
    });
    const lock = (
      await d.select<Mu7Row>('mu7_reference_locks', {
        columns: ['n_units_locked', 'locked_at'],
        eq: { mode: 'PILOT' },
      })
    )[0];
    const exports = await d.select<Mu7Row>('mu7_exports', {
      columns: ['export_id', 'mode', 'manifest_sha256', 'app_git_sha', 'created_at'],
      order: ['created_at'],
    });
    const events = await d.select<Mu7Row>('mu7_phase_events', {
      columns: ['event_type', 'occurred_at'],
      order: ['event_seq'],
    });
    const gates: Mu7GateStatus[] = (await d.rpc<Mu7Row[]>('rpc_mu7_gate_status', {}, 'rows')).map(
      (g) => ({
        gateId: String(g.gate_id),
        requirementVersion: Number(g.requirement_version),
        blocks: (g.blocks as string[]) ?? [],
        requirementStatus: g.requirement_status as Mu7GateStatus['requirementStatus'],
        question: String(g.question),
        decisionReference: (g.decision_reference as string | null) ?? null,
        approvedAt: g.approved_at ? iso(g.approved_at) : null,
        satisfied: bool(g.satisfied),
      }),
    );
    return {
      kind: 'investigator',
      training: await readTraining(d),
      design: design
        ? {
            designVersion: String(design.design_version),
            assignmentSetId: String(design.assignment_set_id),
            overlapSetting: String(design.overlap_setting),
            nPrimaryPlanned: Number(design.n_primary_planned),
            nSubgroupPlanned: Number(design.n_subgroup_planned),
            recordedAt: iso(design.recorded_at),
          }
        : null,
      counts: {
        pilotUnits: units.filter((u) => u.mode === 'PILOT').length,
        formalUnits: units.filter((u) => u.mode === 'FORMAL').length,
        trainingUnits: training.length,
        pilotQueue: queue.length,
      },
      pilotReviewers: [...new Set(queue.map((q) => q.reviewer_pseudo_id))].sort(),
      completion,
      pilotRouting: finals
        .map((f) => {
          const expected = MU7_PILOT_EXPECTED_ROUTING[String(f.unit_id)] ?? null;
          return {
            unitId: String(f.unit_id),
            family: f.family as Mu7InvestigatorWorkspace['pilotRouting'][number]['family'],
            unitRole: f.unit_role as 'PRIMARY' | 'SUBGROUP',
            routing: f.routing as Mu7Routing,
            finalStatus: f.final_status as Mu7FinalStatus,
            finalAnswer: asAnswer(f.final_answer),
            expectedRouting: expected,
            matches: f.routing === 'INCOMPLETE' || !expected ? null : f.routing === expected,
          };
        })
        .sort((a, b) => (a.unitId < b.unitId ? -1 : 1)),
      pilotLock: lock
        ? { nUnitsLocked: Number(lock.n_units_locked), lockedAt: iso(lock.locked_at) }
        : null,
      exports: exports.map((e) => ({
        exportId: String(e.export_id),
        mode: e.mode as Mu7Mode,
        manifestSha256: String(e.manifest_sha256),
        appGitSha: String(e.app_git_sha),
        createdAt: iso(e.created_at),
      })),
      phaseEvents: events.map((e) => ({
        eventType: String(e.event_type),
        occurredAt: iso(e.occurred_at),
      })),
      gates,
      formalOperationsEnabled: false,
      formalDisabledReason: formalDisabledReason(gates),
      localTools: !!ctx.localTools,
      appGitSha: ctx.appGitSha,
    };
  });
}

// ---------------------------------------------------------------------------------------------
// Reviewer
// ---------------------------------------------------------------------------------------------
export async function getMu7ReviewerUnit(
  ctx: Mu7Context,
  assignmentId: string,
): Promise<Mu7ReviewerUnit> {
  requireRole(ctx, 'REVIEWER');
  if (!MU7_ASSIGNMENT_ID.test(assignmentId)) throw notFound();
  return ctx.withData(async (d) => {
    const unit = await d.rpc<Record<string, unknown>>(
      'rpc_mu7_get_unit',
      { p_assignment_id: assignmentId },
      'value',
    );
    if (!unit || typeof unit !== 'object') throw notFound();
    const packet = mu7PacketView(unit.packet as Record<string, unknown>);
    const own = await d.select<Mu7Row>('mu7_judgments', {
      columns: ['revision_number', 'answer', 'reason_code', 'note', 'uncertain', 'submitted_at'],
      eq: { assignment_id: assignmentId },
      order: ['revision_number'],
    });
    return {
      assignmentId,
      mode: unit.mode as Mu7Mode,
      queuePosition: Number(unit.queue_position),
      unitRole: unit.unit_role as 'PRIMARY' | 'SUBGROUP',
      packet,
      reasonCodes: reasonList(packet.unit.family, packet.unit.assignment_code),
      ownAnswers: own.map((j) => ({
        revisionNumber: Number(j.revision_number),
        answer: j.answer as Mu7Answer,
        reasonCode: (j.reason_code as string | null) ?? null,
        note: (j.note as string | null) ?? null,
        uncertain: bool(j.uncertain),
        submittedAt: iso(j.submitted_at),
      })),
    };
  });
}
export async function submitMu7(
  ctx: Mu7Context,
  assignmentId: string,
  input: Mu7SubmissionInput,
): Promise<Mu7ReviewerUnit> {
  requireRole(ctx, 'REVIEWER');
  if (!MU7_ASSIGNMENT_ID.test(assignmentId)) throw notFound();
  const p: Record<string, unknown> = { answer: input.answer, uncertain: input.uncertain === true };
  if (input.reasonCode) p.reason_code = input.reasonCode;
  if (input.note?.trim()) p.note = input.note.trim();
  if (typeof input.secondsOnUnit === 'number') p.seconds_on_unit = input.secondsOnUnit;
  await ctx.withData((d) => d.rpc('rpc_mu7_submit', { p_assignment_id: assignmentId, p }, 'value'));
  return getMu7ReviewerUnit(ctx, assignmentId);
}
export async function acknowledgeMu7Training(ctx: Mu7Context): Promise<{ acknowledgedAt: string }> {
  requireRole(ctx, 'REVIEWER');
  const at = await ctx.withData((d) => d.rpc<string>('rpc_mu7_acknowledge_training', {}, 'value'));
  return { acknowledgedAt: iso(at) };
}

// ---------------------------------------------------------------------------------------------
// Adjudicator (tie-breaker only: routed units)
// ---------------------------------------------------------------------------------------------
export async function getMu7AdjudicatorUnit(
  ctx: Mu7Context,
  unitId: string,
): Promise<Mu7AdjudicatorUnit> {
  requireRole(ctx, 'ADJUDICATOR');
  if (!MU7_UNIT_ID.test(unitId)) throw notFound();
  return ctx.withData(async (d) => {
    const row = (
      await d.select<Mu7Row>('v_mu7_adjudication_queue', {
        columns: [
          'unit_id',
          'mode',
          'packet',
          'reviewer_1_answer',
          'reviewer_1_reason_code',
          'reviewer_1_note',
          'reviewer_1_uncertain',
          'reviewer_2_answer',
          'reviewer_2_reason_code',
          'reviewer_2_note',
          'reviewer_2_uncertain',
        ],
        eq: { unit_id: unitId },
      })
    )[0];
    if (!row) throw notFound();
    const packet = mu7PacketView(row.packet as Record<string, unknown>);
    const slot = (n: 1 | 2): Mu7SlotAnswer => ({
      reviewerSlot: n,
      answer: asAnswer(row[`reviewer_${n}_answer`]),
      reasonCode: (row[`reviewer_${n}_reason_code`] as string | null) ?? null,
      note: (row[`reviewer_${n}_note`] as string | null) ?? null,
      uncertain:
        row[`reviewer_${n}_uncertain`] === null ? null : bool(row[`reviewer_${n}_uncertain`]),
    });
    const adj = (
      await d.select<Mu7Row>('mu7_adjudications', {
        columns: [
          'decision',
          'reason_code',
          'status',
          'basis',
          'disagreement_reason_code',
          'rationale',
          'decided_at',
        ],
        eq: { unit_id: unitId },
      })
    )[0];
    const lock = await d.select('mu7_reference_locks', {
      columns: ['lock_id'],
      eq: { mode: String(row.mode) },
    });
    return {
      unitId,
      mode: row.mode as Mu7Mode,
      packet,
      answers: [slot(1), slot(2)],
      reasonCodes: reasonList(packet.unit.family, packet.unit.assignment_code),
      disagreementReasons: MU7_DISAGREEMENT_REASONS,
      adjudication: adj
        ? {
            decision: (adj.decision as 'AGREE' | 'DISAGREE' | null) ?? null,
            reasonCode: (adj.reason_code as string | null) ?? null,
            status: adj.status as Mu7AdjudicationStatus,
            basis: adj.basis as 'REVIEWER_1' | 'REVIEWER_2' | 'NEITHER' | 'NONE',
            disagreementReasonCode: (adj.disagreement_reason_code as string | null) ?? null,
            rationale: String(adj.rationale),
            decidedAt: iso(adj.decided_at),
          }
        : null,
      referenceLocked: lock.length > 0,
    };
  });
}
export async function recordMu7Adjudication(
  ctx: Mu7Context,
  input: Mu7AdjudicationInput,
): Promise<Mu7AdjudicatorUnit> {
  requireRole(ctx, 'ADJUDICATOR');
  const p = {
    unit_id: input.unitId,
    decision: input.decision ?? null,
    reason_code: input.reasonCode ?? null,
    status: input.status,
    basis: input.basis,
    disagreement_reason_code: input.disagreementReasonCode ?? null,
    rationale: input.rationale,
  };
  await ctx.withData((d) => d.rpc('rpc_mu7_record_adjudication', { p }, 'value'));
  return getMu7AdjudicatorUnit(ctx, input.unitId);
}

// ---------------------------------------------------------------------------------------------
// Investigator actions (synthetic pilot only; FORMAL operations are not offered)
// ---------------------------------------------------------------------------------------------
export async function mu7AdminAction(
  ctx: Mu7Context,
  input: Mu7AdminAction,
): Promise<Mu7InvestigatorWorkspace> {
  requireRole(ctx, 'INVESTIGATOR');
  switch (input.action) {
    case 'record-design':
      await ctx.withData((d) =>
        d.rpc(
          'rpc_mu7_record_design',
          { p: { ...MU7_SYNTHETIC_DESIGN, attestation: input.attestation } },
          'value',
        ),
      );
      break;
    case 'import-pilot':
      await ctx.withData(async (d) => {
        const have = new Set(
          (
            await d.select<{ unit_id: string }>('mu7_units', {
              columns: ['unit_id'],
              eq: { mode: 'PILOT' },
            })
          ).map((u) => u.unit_id),
        );
        const missing = MU7_PILOT_IMPORTS.filter((u) => !have.has(u.unit_id));
        if (!missing.length)
          throw new ServiceError(409, 'The synthetic pilot units are already imported.');
        for (const u of missing) await d.rpc('rpc_mu7_import_unit', { p: u }, 'value');
      });
      break;
    case 'import-training':
      await ctx.withData(async (d) => {
        const have = new Set(
          (
            await d.select<{ training_unit_id: string }>('mu7_training_units', {
              columns: ['training_unit_id'],
            })
          ).map((u) => u.training_unit_id),
        );
        const missing = MU7_SYNTHETIC_TRAINING.filter((u) => !have.has(u.training_unit_id));
        if (!missing.length)
          throw new ServiceError(409, 'The synthetic worked examples are already imported.');
        for (const u of missing) await d.rpc('rpc_mu7_import_training_unit', { p: u }, 'value');
      });
      break;
    case 'assign-pilot':
      await ctx.withData(async (d) => {
        const candidates = (
          await d.select<{ user_id: string }>('users', {
            columns: ['user_id'],
            eq: { role: 'REVIEWER', is_pilot_test_account: true, is_active: true },
            order: ['created_at', 'user_id'],
          })
        ).slice(0, 2);
        const enrolled = () =>
          d.select<{ reviewer_pseudo_id: string; user_id: string }>('reviewers', {
            columns: ['reviewer_pseudo_id', 'user_id'],
            eq: { mode_scope: 'PILOT', withdrawn_at: null },
          });
        const before = await enrolled();
        for (const u of candidates)
          if (!before.some((r) => r.user_id === u.user_id))
            await d.rpc(
              'rpc_enroll_reviewer',
              {
                p_user_id: u.user_id,
                p_mode_scope: 'PILOT',
                p_qualifications: 'synthetic pilot test account',
              },
              'value',
            );
        const now = await enrolled();
        const pseudo = candidates.map(
          (c) => now.find((r) => r.user_id === c.user_id)?.reviewer_pseudo_id,
        );
        if (pseudo.length < 2 || pseudo.some((p) => !p))
          throw new ServiceError(
            409,
            'Two enrolled pilot reviewers are required before assignment.',
          );
        const { slot1, slot2 } = mu7PilotQueues();
        await d.rpc(
          'rpc_mu7_assign_queue',
          {
            p_mode: 'PILOT',
            p: {
              slots: [
                { reviewer_slot: 1, reviewer_pseudo_id: pseudo[0], unit_ids: slot1 },
                { reviewer_slot: 2, reviewer_pseudo_id: pseudo[1], unit_ids: slot2 },
              ],
            },
          },
          'value',
        );
      });
      break;
    case 'approve-gate':
      await ctx.withData(async (d) => {
        // The approval names the decision record the reviewed requirement specifies; the
        // investigator confirms and attests, and never types the citation. The database refuses
        // a pending gate, another record and any caller who is not the investigator (0024, 0026).
        const gate = (await d.rpc<Mu7Row[]>('rpc_mu7_gate_status', {}, 'rows')).find(
          (g) => g.gate_id === input.gateId,
        );
        if (!gate) throw new ServiceError(404, 'Resource not available.');
        if (gate.requirement_status !== 'SPECIFIED' || !gate.decision_reference)
          throw new ServiceError(
            409,
            `${input.gateId} cannot be approved: its requirement is pending specification.`,
          );
        await d.rpc(
          'rpc_mu7_approve_gate',
          {
            p_gate_id: input.gateId,
            p_attestation: input.attestation,
            p_evidence_reference: gate.decision_reference,
          },
          'value',
        );
      });
      break;
    case 'lock-pilot':
      await ctx.withData((d) =>
        d.rpc(
          'rpc_mu7_lock_reference',
          { p_mode: 'PILOT', p_attestation: input.attestation },
          'value',
        ),
      );
      break;
    case 'register-pilot-export': {
      const bundle = await exportMu7Bundle(ctx, 'PILOT');
      await ctx.withData((d) =>
        d.rpc(
          'rpc_mu7_register_export',
          { p: mu7RegistrationPayload(bundle, ctx.appGitSha, input.notes) },
          'value',
        ),
      );
      break;
    }
    case 'lock-account':
    case 'unlock-account':
      if (!ctx.localTools)
        throw new ServiceError(
          409,
          'Account locks are recorded with the privileged identity tool (scripts/supabase-identity-tools.mjs lock), never from the application.',
        );
      if (input.action === 'lock-account')
        await ctx.localTools.lockAccount(input.account, input.reason);
      else await ctx.localTools.unlockAccount(input.account);
      break;
  }
  return investigatorWorkspace(ctx);
}

// ---------------------------------------------------------------------------------------------
// Export (bundle 7.0), after the reference lock of its mode
// ---------------------------------------------------------------------------------------------
export async function exportMu7Bundle(ctx: Mu7Context, mode: Mu7Mode): Promise<Mu7Bundle> {
  requireRole(ctx, 'INVESTIGATOR');
  if (!/^[0-9a-f]{40}$/.test(ctx.appGitSha) || /^0{40}$/.test(ctx.appGitSha))
    throw new ServiceError(409, 'Export requires a verified application build commit.');
  return ctx.withData((d) => readMu7Bundle(d, mode, ctx.appGitSha, ctx.syntheticDatabase));
}
/** Reads one mode's bundle through the investigator's export views (also used by the tests). */
export async function readMu7Bundle(
  d: Mu7Data,
  mode: Mu7Mode,
  appGitSha: string,
  syntheticDatabase: boolean,
): Promise<Mu7Bundle> {
  const lock = (
    await d.select<Mu7Row>('mu7_reference_locks', {
      columns: ['n_units_locked', 'locked_at'],
      eq: { mode },
    })
  )[0];
  if (!lock) throw new ServiceError(409, `Lock the ${mode} reference before exporting.`);
  const rows = {} as Record<Mu7ExportRole, Mu7Row[]>;
  for (const role of Object.keys(MU7_EXPORT_COLUMNS) as Mu7ExportRole[])
    rows[role] = await d.select<Mu7Row>(MU7_EXPORT_VIEWS[role], {
      columns: MU7_EXPORT_COLUMNS[role],
      eq: { mode },
    });
  const design =
    (
      await d.select<Mu7Row>('mu7_design', {
        columns: [
          'design_version',
          'assignment_set_id',
          'overlap_setting',
          'n_primary_planned',
          'n_subgroup_planned',
        ],
      })
    )[0] ?? null;
  const num = (r: Mu7Row | null, keys: string[]) => {
    if (!r) return null;
    for (const k of keys) if (r[k] !== null && r[k] !== undefined) r[k] = Number(r[k]);
    return r;
  };
  const freeze =
    mode === 'FORMAL'
      ? num(
          (
            await d.select<Mu7Row>('mu7_freeze', {
              columns: [
                'n_units',
                'n_primary',
                'n_subgroup',
                'unit_list_sha256',
                'assignment_set_sha256',
                'design_rows_sha256',
                'queue_sha256',
                'packets_sha256',
              ],
            })
          )[0] ?? null,
          ['n_units', 'n_primary', 'n_subgroup'],
        )
      : null;
  const snapshot =
    mode === 'FORMAL'
      ? num(
          (await d.select<Mu7Row>('mu7_snapshot', { columns: ['n_rows', 'content_sha256'] }))[0] ??
            null,
          ['n_rows'],
        )
      : null;
  return buildMu7Bundle({
    mode,
    appGitSha,
    design: num(design, ['n_primary_planned', 'n_subgroup_planned']),
    freeze,
    snapshot,
    lockedAt: iso(lock.locked_at),
    nUnitsLocked: Number(lock.n_units_locked),
    syntheticDatabase,
    rows,
  });
}
