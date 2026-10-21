import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Actor, Adjudication, AdjudicationInput, AdminInput, Campaign, CaseDetail, Configuration, Decision, EvidencePacket, ExportData, Judgment, JudgmentInput, QueueItem, TrialPacket, Workspace } from '../lib/types';
import { DEMO_ACTORS, withActor } from './db';

export class ServiceError extends Error {
  constructor(public status: number, message: string) { super(message); this.name = 'ServiceError'; }
}
const decision = z.enum(['INCLUDE', 'EXCLUDE', 'CONTEXT_DEPENDENT', 'INSUFFICIENT_INFORMATION']);
const level = z.enum(['DESCRIPTOR_LEVEL', 'DESCRIPTOR_LEVEL_IN_TRIAL_CASE', 'TRIAL_LEVEL']);
const roles = z.enum(['DISEASE_STUDIED', 'COMORBIDITY', 'COMPLICATION', 'OUTCOME_ONLY', 'PREVENTION_TARGET', 'RISK_FACTOR', 'OTHER', 'UNRESOLVABLE']);
const reasons = z.enum(['CONSTRUCT_BOUNDARY', 'POLICY_RULE_INTERPRETATION', 'MESH_PLACEMENT_MISLEADING', 'TRIAL_CONTEXT', 'PACKET_INSUFFICIENT', 'MULTILABEL_OR_CROSS_AREA', 'OTHER']);
const common = { decision, rationale: z.string().trim().min(1).max(4000), uncertain: z.boolean(), context: z.string().max(4000), packetProblem: z.boolean(), level: level.optional(), amendmentId: z.uuid().optional(), descriptorRole: roles.optional(), packetProblemNote: z.string().max(4000).optional() };
const reviewSchema = z.strictObject(common);
const draftSchema = z.strictObject({ ...common, rationale: z.string().max(4000) });
const adjudicationSchema = z.strictObject({ ...common, decision: decision.nullable(), level, status: z.enum(['RESOLVED', 'UNRESOLVED_ESCALATED']), basis: z.string().trim().min(1).max(4000), reasonCode: reasons });
const adminSchema = z.strictObject({ action: z.enum(['close', 'authorize-adjudication', 'lock', 'configure', 'activate-formal', 'authorize-amendment']), attestation: z.string().trim().min(1).max(4000).optional(), caseId: z.string().regex(/^SYN-\d{3}$/).optional(), reviewerId: z.uuid().optional(), level: level.optional(), reason: z.string().trim().min(1).max(4000).optional(), configuration: z.strictObject({ tierVersion: z.enum(['PENDING', 'v1.1', 'v1.2']).optional(), tierState: z.enum(['PROPOSED', 'APPROVED', 'FROZEN']).optional(), rubricState: z.enum(['PROPOSED', 'APPROVED', 'FROZEN']).optional(), sampleState: z.enum(['PROPOSED', 'APPROVED', 'FROZEN']).optional(), adjudicationScope: z.enum(['ALL_CASE_LEVELS', 'DISAGREEMENTS_ONLY']).optional(), analysisPlanState: z.enum(['PROPOSED', 'APPROVED', 'FROZEN']).optional() }).optional() });

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new ServiceError(400, 'Check the required fields and allowed values. Rationale is required for every submission.');
  return result.data;
}
function caseId(id: string): string {
  if (!/^SYN-\d{3}$/.test(id)) throw new ServiceError(404, 'Resource not available.');
  return id;
}
function requireRole(actor: Actor, role: Actor['role']) {
  if (actor.role !== role) throw new ServiceError(403, 'This action is not available to your role.');
}

// Map a small allowlist of our own database errors. Never return SQL text,
// constraint details, parameters, claims or internal stack traces to a client.
const publicErrors: Record<string, string> = {
  'Structured context is required': 'Context-dependent decisions require clinical context, inclusion conditions and exclusion conditions.',
  'Review is closed': 'Review is closed. Submitted judgments remain locked.',
  'Final response locked': 'This response is final and locked.',
  'Final response locked; an authorized amendment is required': 'This response is final. An investigator must authorize an audited amendment.',
  'Initial response cannot be an amendment': 'This case does not have a submitted response to amend.',
  'Amendment does not authorize this response': 'This amendment does not authorize this response.',
  'Submit descriptor judgment before trial context': 'Submit and lock Step 1 before completing the trial review.',
  'Submit descriptor judgment first': 'Submit and lock Step 1 first.',
  'Invalid determination level': 'The selected level does not apply to this case.',
  'Two independent submissions required': 'Two independent final submissions are required.',
  'Adjudication authorization required': 'Adjudication is not yet authorized.',
  'Case not assigned': 'This case is not assigned to you.',
  'Case not found': 'Synthetic case not found.',
  'All assigned reviewers must submit before close': 'Both reviewers must submit every assigned case before review can close.',
  'Close and snapshot review before authorization': 'Close review and create the judgment snapshot before authorizing adjudication.',
  'Adjudicate every synthetic case level before locking': 'Every synthetic case level must be adjudicated before reference lock.',
  'Reference lock required before export': 'Lock the reference before exporting.',
  'Judgment snapshot integrity failure': 'Integrity verification failed. Export and adjudication are blocked.',
  'Amendments require open review; snapshot is immutable': 'Amendments are unavailable after review closes and the snapshot is created.',
  'No submitted response to amend': 'No submitted response exists for that case, reviewer and level.',
  'Configuration locked': 'Configuration is locked after review closes.',
  'Review is not open': 'Review is not open.',
  'Adjudication phase required': 'Authorize adjudication before reference lock.',
};
async function rpc<T>(actor: Actor, sql: string, params: unknown[] = []): Promise<T> {
  try {
    return await withActor(actor, async (tx) => {
      const result = await tx.query<{ value: T }>(sql, params);
      return result.rows[0]?.value;
    });
  } catch (error) {
    if (error instanceof ServiceError) throw error;
    const message = error instanceof Error ? error.message : '';
    if (message === 'Case not assigned' || message === 'Case not found') throw new ServiceError(404, 'Resource not available.');
    if (message in publicErrors) throw new ServiceError(409, publicErrors[message]);
    if (/permission denied|Authentication required|role required|assignment required|Authenticated role mismatch|Case packets restricted|Cannot adjudicate/.test(message)) throw new ServiceError(403, 'This action is not available to your role.');
    if (/duplicate key|check constraint|not-null constraint|invalid input/.test(message)) throw new ServiceError(409, 'The record is locked, already submitted, or missing a required value.');
    throw new ServiceError(500, 'The local review database could not complete this request.');
  }
}
interface RawResponse {
  id: string; case_id: string; reviewer_id: string; level: string; sequence: number;
  decision: Decision; rationale: string; uncertain: boolean; context_note: string;
  packet_problem: boolean; packet_problem_note: string | null; descriptor_role: string | null;
  amendment_id: string | null; submitted_at: string;
}
interface RawAdjudication { id: string; case_id: string; level: string; decision: Decision | null; status: 'RESOLVED' | 'UNRESOLVED_ESCALATED'; rationale: string; basis: string; reason_code: string; created_at: string; uncertain: boolean; context_note: string; packet_problem: boolean; packet_problem_note: string | null }
interface RawCase { id: string; kind: 'DESCRIPTOR' | 'TWO_STEP'; packet: EvidencePacket & { title: string; area: string }; trial_packet?: TrialPacket; trialPacket?: TrialPacket; phase: Campaign['state']; responses: RawResponse[]; drafts?: { level: string; amendment_id: string | null; payload: JudgmentInput }[]; amendments?: { id: string; level: string; reason: string }[]; adjudications?: RawAdjudication[]; evidenceHash?: string }
interface RawWorkspace { phase: Campaign['state']; cases: { id: string; kind: 'DESCRIPTOR' | 'TWO_STEP'; title: string; area: string; status: QueueItem['status'] | 'READY' }[]; tier1Proposal?: 'v1.1' | 'v1.2' | null; summary?: { totalCases: number; totalAssignments: number; submittedAssignments: number; totalLevels: number; adjudicatedLevels: number } }

function configuration(proposal?: 'v1.1' | 'v1.2' | null): Configuration {
  return { tierVersion: proposal || 'PENDING', tierState: 'PROPOSED', rubricState: 'PROPOSED', sampleState: 'PROPOSED', adjudicationScope: 'ALL_CASE_LEVELS', analysisPlanState: 'PROPOSED' };
}
function evidenceHash(c: RawCase): string {
  return c.evidenceHash || createHash('sha256').update(JSON.stringify(c.packet)).digest('hex');
}
function judgments(rows: RawResponse[]): Judgment[] {
  const versions = new Map<string, number>();
  return [...rows].sort((a, b) => a.sequence - b.sequence).map((r) => {
    const key = `${r.case_id}/${r.level}/${r.reviewer_id}`;
    const version = (versions.get(key) || 0) + 1; versions.set(key, version);
    return { id: r.id, decision: r.decision, rationale: r.rationale, uncertain: r.uncertain, context: r.context_note || '', packetProblem: r.packet_problem, submittedAt: new Date(r.submitted_at).toISOString(), reviewerSlot: r.reviewer_id === DEMO_ACTORS[1].id ? 'A' : 'B', version, level: r.level, ...(r.packet_problem_note ? { packetProblemNote: r.packet_problem_note } : {}), ...(r.descriptor_role ? { descriptorRole: r.descriptor_role } : {}), ...(r.amendment_id ? { amendmentId: r.amendment_id } : {}) };
  });
}
function adjudication(r: RawAdjudication): Adjudication {
  return { id: r.id, decision: r.decision, rationale: r.rationale, uncertain: r.uncertain, context: r.context_note, packetProblem: r.packet_problem, ...(r.packet_problem_note ? { packetProblemNote: r.packet_problem_note } : {}), submittedAt: new Date(r.created_at).toISOString(), level: r.level, status: r.status, basis: r.basis, reasonCode: r.reason_code, version: 1 };
}
export async function getWorkspace(actor: Actor): Promise<Workspace> {
  const raw = await rpc<RawWorkspace>(actor, 'select public.rpc_verify_workspace() as value');
  const queue: QueueItem[] = raw.cases.map((c) => ({ caseId: c.id, title: c.title, area: c.area, unitType: c.kind === 'TWO_STEP' ? 'TRIAL_AREA' : 'DESCRIPTOR_AREA', status: c.status === 'READY' ? 'NOT_STARTED' : c.status }));
  const completed = raw.summary?.submittedAssignments ?? queue.filter((c) => ['SUBMITTED', 'ADJUDICATED'].includes(c.status)).length;
  const total = raw.summary?.totalAssignments ?? queue.length;
  return { user: actor, campaign: { id: 'synthetic-pilot-v1', title: 'Synthetic classification pilot', state: raw.phase, mode: 'SYNTHETIC_PILOT', caseCount: raw.summary?.totalCases ?? queue.length, completed, total }, queue,
    gates: [
      { id: 'synthetic', label: 'Synthetic environment', state: 'PASS', detail: 'Fictional engineering fixtures only. Formal activation and import are disabled.' },
      { id: 'sample', label: 'Sample and design approval', state: 'BLOCKED', detail: 'The sample, exclusions, allocation and inference population await investigator approval.' },
      { id: 'coverage', label: 'Classification coverage', state: 'BLOCKED', detail: 'Coverage of classifier-negative / curated-positive cases and the resulting inference limits remain unresolved. No accuracy claim is authorized.' },
      { id: 'tier', label: 'Tier 1 version approval', state: 'BLOCKED', detail: 'A version proposal is not approval. The classification version must be explicitly approved and frozen before formal review.' },
      { id: 'rubric', label: 'Rubric approval', state: 'BLOCKED', detail: 'Fictional pilot text is not the approved clinical rubric. Final definitions and response instructions remain pending.' },
      { id: 'reviewers', label: 'Reviewer and adjudicator readiness', state: 'BLOCKED', detail: 'The accounts are fictional pilot roles. Real reviewer qualifications, independence and adjudicator authorization are not approved.' },
      { id: 'security', label: 'Production security checks', state: 'NOT_TESTED', detail: 'Live PostgreSQL, Supabase JWT/MFA, hosting and retention checks are not complete.' },
      { id: 'pilot', label: 'Synthetic pilot lifecycle', state: raw.phase === 'LOCKED' ? 'PASS' : 'NOT_TESTED', detail: raw.phase === 'LOCKED' ? 'This synthetic campaign reached reference lock. Formal acceptance still requires the full signed checklist.' : 'Complete independent review, authorized adjudication and reference lock; formal acceptance requires the signed checklist.' },
    ], configuration: configuration(raw.tier1Proposal), ...(raw.summary ? { progress: [{ label: 'Independent final submissions', completed: raw.summary.submittedAssignments, total: raw.summary.totalAssignments }, { label: 'Adjudicated case levels', completed: raw.summary.adjudicatedLevels, total: raw.summary.totalLevels }] } : {}),
    notice: 'Engineering pilot only. No clinical validation or performance estimates are available.' };
}
export async function getCase(actor: Actor, id: string): Promise<CaseDetail> {
  const raw = await rpc<RawCase>(actor, 'select public.rpc_verify_case($1) as value', [caseId(id)]);
  const reviews = judgments(raw.responses);
  const step1 = reviews.filter((r) => r.level === 'DESCRIPTOR_LEVEL_IN_TRIAL_CASE').at(-1);
  const submission = reviews.filter((r) => r.level === (raw.kind === 'TWO_STEP' ? 'TRIAL_LEVEL' : 'DESCRIPTOR_LEVEL')).at(-1);
  const activeLevel = raw.kind === 'TWO_STEP' && !step1 ? 'DESCRIPTOR_LEVEL_IN_TRIAL_CASE' : raw.kind === 'TWO_STEP' ? 'TRIAL_LEVEL' : 'DESCRIPTOR_LEVEL';
  const { descriptorName, descriptorId, scopeNote, entryTerms, treeNumbers, areaDefinition, source, sourceVersion } = raw.packet;
  const result: CaseDetail = { caseId: raw.id, title: raw.packet.title, area: raw.packet.area, unitType: raw.kind === 'TWO_STEP' ? 'TRIAL_AREA' : 'DESCRIPTOR_AREA', phase: raw.phase,
    packet: { descriptorName, descriptorId, scopeNote, entryTerms, treeNumbers, areaDefinition, source, sourceVersion }, step1Required: raw.kind === 'TWO_STEP', step1Locked: !!step1 || actor.role === 'ADJUDICATOR', evidenceHash: evidenceHash(raw) };
  if (raw.trialPacket) result.trialPacket = raw.trialPacket;
  if (actor.role === 'REVIEWER') {
    if (step1) result.step1 = step1;
    if (submission) result.submission = submission;
    result.availableAmendments = raw.amendments || [];
    result.drafts = (raw.drafts || []).map((d) => ({ ...d.payload, level: d.level, ...(d.amendment_id ? { amendmentId: d.amendment_id } : {}) }));
    const pendingAmendment = result.availableAmendments.find((a) => a.level === activeLevel);
    const draft = result.drafts.find((d) => d.level === activeLevel && d.amendmentId === pendingAmendment?.id);
    if (draft) result.draft = draft;
  } else {
    result.humanReviews = reviews;
    result.adjudications = (raw.adjudications || []).map(adjudication);
    result.adjudication = result.adjudications.at(-1);
  }
  return result;
}
const structuredContext = z.strictObject({ clinicalContext: z.string().trim().min(1), inclusionConditions: z.string().trim().min(1), exclusionConditions: z.string().trim().min(1) });
function validateContext(input: JudgmentInput | AdjudicationInput) {
  if (input.decision !== 'CONTEXT_DEPENDENT') return;
  let parsed: unknown;
  try { parsed = JSON.parse(input.context); } catch { /* Report the same safe error for malformed or incomplete JSON. */ }
  if (!structuredContext.safeParse(parsed).success) throw new ServiceError(400, 'Context-dependent decisions require clinical context, inclusion conditions and exclusion conditions.');
}
function validateProblems(input: JudgmentInput | AdjudicationInput) {
  if (input.packetProblem && !input.packetProblemNote?.trim()) throw new ServiceError(400, 'Describe the packet problem before submitting.');
}
async function reviewerWrite(actor: Actor, id: string, input: JudgmentInput, kind: 'DRAFT' | 'STEP1' | 'FINAL'): Promise<CaseDetail> {
  requireRole(actor, 'REVIEWER');
  const clean = parse(kind === 'DRAFT' ? draftSchema : reviewSchema, input);
  const current = await getCase(actor, id);
  const desiredLevel = kind === 'STEP1' ? 'DESCRIPTOR_LEVEL_IN_TRIAL_CASE' : clean.level || (current.unitType === 'TRIAL_AREA' ? (current.step1Locked ? 'TRIAL_LEVEL' : 'DESCRIPTOR_LEVEL_IN_TRIAL_CASE') : 'DESCRIPTOR_LEVEL');
  if (kind === 'STEP1' && !current.step1Required) throw new ServiceError(400, 'This case does not have a separate Step 1.');
  if (kind === 'FINAL' && current.step1Required && !current.step1Locked) throw new ServiceError(409, 'Submit and lock Step 1 first.');
  if (kind !== 'DRAFT') {
    validateProblems(clean);
    validateContext(clean);
    if (desiredLevel === 'TRIAL_LEVEL' && !clean.descriptorRole) throw new ServiceError(400, 'Select the descriptor role in this trial.');
    if (desiredLevel !== 'TRIAL_LEVEL' && clean.descriptorRole) throw new ServiceError(400, 'A trial role only applies at the trial level.');
  }
  await rpc(actor, kind === 'DRAFT' ? 'select public.rpc_verify_draft($1,$2,$3::jsonb) as value' : 'select public.rpc_verify_submit($1,$2,$3::jsonb) as value', [caseId(id), desiredLevel, JSON.stringify(clean)]);
  return getCase(actor, id);
}
export const saveDraft = (actor: Actor, id: string, input: JudgmentInput) => reviewerWrite(actor, id, input, 'DRAFT');
export const submitReview = (actor: Actor, id: string, input: JudgmentInput) => reviewerWrite(actor, id, input, 'FINAL');
export const submitStep1 = (actor: Actor, id: string, input: JudgmentInput) => reviewerWrite(actor, id, input, 'STEP1');
export async function adjudicate(actor: Actor, id: string, input: AdjudicationInput): Promise<CaseDetail> {
  requireRole(actor, 'ADJUDICATOR');
  const clean = parse(adjudicationSchema, input);
  if ((clean.status === 'UNRESOLVED_ESCALATED') !== (clean.decision === null)) throw new ServiceError(400, 'Unresolved escalation requires no decision. Resolved adjudication requires a decision.');
  validateProblems(clean);
  validateContext(clean);
  if (clean.amendmentId || clean.descriptorRole) throw new ServiceError(400, 'Reviewer amendment and trial-role fields do not apply to adjudication.');
  await rpc(actor, 'select public.rpc_verify_adjudicate($1,$2,$3::jsonb) as value', [caseId(id), clean.level, JSON.stringify(clean)]);
  return getCase(actor, id);
}
export async function adminAction(actor: Actor, input: AdminInput): Promise<Workspace> {
  requireRole(actor, 'INVESTIGATOR');
  const clean = parse(adminSchema, input);
  if (clean.action === 'activate-formal') throw new ServiceError(403, 'Formal activation is disabled. Approved scientific materials and production acceptance evidence are required.');
  let payload: Record<string, unknown>;
  if (clean.action === 'configure') {
    if (!clean.configuration || Object.keys(clean.configuration).some((k) => k !== 'tierVersion') || !['v1.1', 'v1.2'].includes(clean.configuration.tierVersion || '')) throw new ServiceError(400, 'Only the proposed Tier 1 version can be configured. Scientific approval is not available in this pilot.');
    payload = { action: 'SET_PROPOSAL', tier1Version: clean.configuration.tierVersion };
  } else if (clean.action === 'authorize-amendment') {
    if (!clean.caseId || !clean.reviewerId || !clean.level || !clean.reason || !clean.attestation) throw new ServiceError(400, 'Case, reviewer, determination level, amendment reason and attestation are required.');
    payload = { action: 'AUTHORIZE_AMENDMENT', caseId: clean.caseId, reviewerId: clean.reviewerId, level: clean.level, reason: clean.reason, attestation: clean.attestation };
  } else {
    if (!clean.attestation) throw new ServiceError(400, 'An explicit attestation is required.');
    payload = { action: { close: 'CLOSE_REVIEW', 'authorize-adjudication': 'AUTHORIZE_ADJUDICATION', lock: 'LOCK_REFERENCE' }[clean.action], attestation: clean.attestation };
  }
  await rpc(actor, 'select public.rpc_verify_admin($1::jsonb) as value', [JSON.stringify(payload)]);
  return getWorkspace(actor);
}
interface RawExport { state: { phase: Campaign['state']; tier1_proposal: 'v1.1' | 'v1.2' | null; snapshot_hash: string; locked_at: string }; cases: RawCase[]; judgments: RawResponse[]; adjudications: RawAdjudication[]; amendments: unknown[]; audit: unknown[] }
export async function getExportData(actor: Actor): Promise<ExportData> {
  requireRole(actor, 'INVESTIGATOR');
  const raw = await rpc<RawExport>(actor, 'select public.rpc_verify_export() as value');
  const mapped = judgments(raw.judgments);
  const byId = new Map(mapped.map((r) => [r.id, r]));
  return { campaign: { id: 'synthetic-pilot-v1', title: 'Synthetic classification pilot', state: raw.state.phase, mode: 'SYNTHETIC_PILOT', caseCount: raw.cases.length, completed: raw.cases.length * 2, total: raw.cases.length * 2 }, configuration: configuration(raw.state.tier1_proposal),
    cases: raw.cases.map((c) => ({ caseId: c.id, area: c.packet.area, evidenceHash: evidenceHash(c) })),
    judgments: raw.judgments.map((r) => ({ ...byId.get(r.id)!, caseId: r.case_id, level: r.level })),
    adjudications: raw.adjudications.map((r) => ({ ...adjudication(r), caseId: r.case_id, level: r.level })),
    provenance: { schemaVersion: '4.0.1-synthetic', rubricVersion: 'synthetic-v1', analysisPlan: 'PENDING_APPROVAL', judgmentSnapshotHash: raw.state.snapshot_hash, referenceLockedAt: new Date(raw.state.locked_at).toISOString(), source: 'Fictional engineering fixtures only', amendmentAudit: JSON.stringify(raw.amendments), auditTrail: JSON.stringify(raw.audit) } };
}
