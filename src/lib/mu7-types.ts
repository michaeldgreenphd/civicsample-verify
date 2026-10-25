// Review design v7 (mapping units): data contracts shared by the server and the browser.
// Every DTO here is an explicit allow-list. A reviewer receives the packet of an assigned unit (the
// unit block exactly as stored and the trial block), their own answers and the read-only worked
// examples; never a design row, a sampling weight, another reviewer's answer or an export row.
// The vocabulary is the database's own (tests/handoff/fixtures/v7/VOCABULARY_CONTRACT_v7.json, the
// texts the supplied suite checks against the migration); the wording comes from REVIEW_RUBRIC_v7.md.
import VOCABULARY from '../../tests/handoff/fixtures/v7/VOCABULARY_CONTRACT_v7.json';

export type Mu7Mode = 'PILOT' | 'FORMAL';
export type Mu81Subtype = 'TYPE_2_STATED' | 'TYPE_2_NOT_STATED' | 'CANNOT_TELL_FROM_PACKET';
export const MU81_SUBTYPE_TEXT: Record<Mu81Subtype, string> = {
  TYPE_2_STATED: 'Type 2 diabetes is stated',
  TYPE_2_NOT_STATED: 'Type 2 diabetes is not stated',
  CANNOT_TELL_FROM_PACKET: 'Cannot tell from this packet',
};
export const isMu81Design = (v: unknown) =>
  typeof v === 'string' && (v === 'review-design-v8.1.0' || v.startsWith('SYN-8-1-'));
export type Mu7Answer = 'AGREE' | 'DISAGREE' | 'CANNOT_TELL';
export type Mu7Family = 'AREA' | 'ROW' | 'SG';
export type Mu7Routing =
  'CONCORDANT_AGREE' | 'CONCORDANT_DISAGREE' | 'BOTH_CANNOT_TELL' | 'ROUTED' | 'INCOMPLETE';
export type Mu7FinalStatus =
  | 'CONCORDANT'
  | 'ADJUDICATED'
  | 'CANNOT_TELL_BY_RULE'
  | 'UNRESOLVED'
  | 'INCOMPLETE'
  | 'PENDING_ADJUDICATION';
export type Mu7AdjudicationStatus = 'DISCORDANT_RESOLVED' | 'UNRESOLVED_ESCALATED';
export type Mu7Basis = 'REVIEWER_1' | 'REVIEWER_2' | 'NEITHER' | 'NONE';

export const MU7_ANSWERS: readonly Mu7Answer[] = ['AGREE', 'DISAGREE', 'CANNOT_TELL'];
export const MU7_ANSWER_TEXT: Record<Mu7Answer, { label: string; meaning: string }> = {
  AGREE: {
    label: 'Agree',
    meaning: 'The assignment fits the condition the trial studies, as the registry describes it.',
  },
  DISAGREE: {
    label: 'Disagree',
    meaning: 'It does not. Choose the reason code that fits best and write a short note.',
  },
  CANNOT_TELL: {
    label: 'Cannot tell',
    meaning:
      'The registry text does not let you decide. Use it sparingly; a note helps the adjudicator.',
  },
};
/** Meanings of the reason codes (REVIEW_RUBRIC_v7.md section 4). */
export const MU7_REASON_MEANING: Record<string, string> = {
  ORGAN_OF_ORIGIN_ONLY:
    'The area follows only from the organ where a cancer starts (neoplasm policy).',
  NOT_THE_CONDITION_STUDIED: 'The condition behind the assignment is not what the trial studies.',
  MESH_PLACEMENT_MISLEADING:
    'The assignment follows from where MeSH files a heading, not from the clinical condition.',
  RUBRIC_POLICY_EXCLUDES: 'A rubric policy excludes this area for this trial.',
  OTHER_SPECIFIED: 'Another reason, written in the note.',
  TYPE_1_ONLY: 'The trial studies type 1 diabetes only.',
  OTHER_DIABETES_TYPE: 'Another diabetes type (for example gestational, monogenic or secondary).',
  PREDIABETES_ONLY: 'The trial studies prediabetes only.',
  DIABETES_NOT_STUDIED: 'The trial does not study diabetes.',
  TYPE_2_STATED: 'The registry text states type 2 diabetes although the headings do not.',
  TYPE_2_STUDIED: 'The trial studies type 2 diabetes, so it belongs in the Diabetes Mellitus row.',
  TYPE_NOT_DETERMINABLE:
    'The diabetes type cannot be decided from the registry, so the trial should stay in the row as type not stated.',
  DIABETES_STUDIED: 'The trial studies diabetes, not only prediabetes.',
  BENIGN_NEOPLASM: 'The neoplasm studied is benign.',
  PRECANCEROUS: 'The condition studied is precancerous.',
  NOT_A_NEOPLASM: 'The condition studied is not a neoplasm.',
  MALIGNANT_NEOPLASM_STUDIED:
    'The trial studies a malignant neoplasm, so it belongs in the Neoplasms row.',
};
/** Disagreement reasons the adjudicator may record (the database's own list). */
export const MU7_DISAGREEMENT_REASONS: readonly string[] = VOCABULARY.disagreement_reasons_v3;

/** The reason codes a DISAGREE may carry for a unit showing this family and assignment code. */
export function mu7ReasonCodes(family: string, assignmentCode: string): string[] {
  const reasons = VOCABULARY.reasons as Record<string, string[]>;
  return [...(reasons[`${family}|${assignmentCode}`] ?? [])];
}

// ---- Packets (the unit block and the trial block, re-selected by name) -------------------------
export interface Mu7UnitBlock {
  unit_id: string;
  mode: Mu7Mode | 'TRAINING';
  family: Mu7Family;
  category: string;
  unit_role: 'PRIMARY' | 'SUBGROUP';
  mapping_code: string;
  mapping_label: string;
  assignment_code: string;
  assignment_status: 'ASSIGNED';
  display_text: string;
  display_decision?: string;
  parent_row_code?: string;
  parent_row_label?: string;
  display_note?: string;
}
export interface Mu7TrialBlock {
  nct_id: string;
  registry_url?: string;
  brief_title: string;
  official_title?: string;
  conditions_registered?: string[];
  condition_mesh_headings?: string[];
  brief_summary?: string;
  detailed_description?: string;
  interventions?: { intervention_type: string; name: string; description?: string }[];
  eligibility_age_range?: { minimum_age?: string; maximum_age?: string };
}
export interface Mu7Packet {
  unit: Mu7UnitBlock;
  trial: Mu7TrialBlock;
  notices: string[];
}
export interface Mu7WorkedExample {
  outcome_summary: string;
  teaching_point: string;
  worked_answers: {
    reviewer_slot: number;
    answer: Mu7Answer;
    reason_code: string | null;
    note: string | null;
    uncertain: boolean;
  }[];
  reference: {
    final_answer: Mu7Answer | null;
    status: string;
    basis: string;
    rationale: string | null;
  };
}

// ---- Reviewer --------------------------------------------------------------------------------
export interface Mu7QueueItem {
  assignmentId: string;
  mode: Mu7Mode;
  reviewerSlot: 1 | 2;
  queuePosition: number;
  unitId: string;
  unitRole: 'PRIMARY' | 'SUBGROUP';
  answered: boolean;
  available: boolean;
}
export interface Mu7TrainingView {
  trainingUnitId: string;
  packet: Mu7Packet;
  workedExample: Mu7WorkedExample;
}
export interface Mu7OwnAnswer {
  diabetesSubtype?: Mu81Subtype | null;
  revisionNumber: number;
  answer: Mu7Answer;
  reasonCode: string | null;
  note: string | null;
  uncertain: boolean;
  submittedAt: string;
}
export interface Mu7ReviewerWorkspace {
  kind: 'reviewer';
  designRecorded: boolean;
  enrolled: boolean;
  queue: Mu7QueueItem[];
  training: Mu7TrainingView[];
  trainingAcknowledgedAt: string | null;
}
export interface Mu7ReviewerUnit {
  subtypeRequired?: boolean;
  assignmentId: string;
  mode: Mu7Mode;
  queuePosition: number;
  unitRole: 'PRIMARY' | 'SUBGROUP';
  packet: Mu7Packet;
  reasonCodes: { code: string; meaning: string }[];
  ownAnswers: Mu7OwnAnswer[];
}
export interface Mu7SubmissionInput {
  diabetesSubtype?: Mu81Subtype | null;
  answer: Mu7Answer;
  reasonCode?: string | null;
  note?: string | null;
  uncertain?: boolean;
  secondsOnUnit?: number | null;
}

// ---- Adjudicator -----------------------------------------------------------------------------
export interface Mu7SlotAnswer {
  reviewerSlot: 1 | 2;
  answer: Mu7Answer | null;
  reasonCode: string | null;
  note: string | null;
  uncertain: boolean | null;
}
export interface Mu7AdjudicationRecord {
  decision: 'AGREE' | 'DISAGREE' | null;
  reasonCode: string | null;
  status: Mu7AdjudicationStatus;
  basis: Mu7Basis;
  disagreementReasonCode: string | null;
  rationale: string;
  decidedAt: string;
}
export interface Mu7AdjudicationQueueItem {
  unitId: string;
  mode: Mu7Mode;
  family: Mu7Family;
  category: string;
  unitRole: 'PRIMARY' | 'SUBGROUP';
  mappingLabel: string;
  displayText: string;
  adjudicated: boolean;
}
export interface Mu7AdjudicatorWorkspace {
  kind: 'adjudicator';
  designRecorded: boolean;
  queue: Mu7AdjudicationQueueItem[];
}
export interface Mu7AdjudicatorUnit {
  unitId: string;
  mode: Mu7Mode;
  packet: Mu7Packet;
  answers: [Mu7SlotAnswer, Mu7SlotAnswer];
  reasonCodes: { code: string; meaning: string }[];
  disagreementReasons: readonly string[];
  adjudication: Mu7AdjudicationRecord | null;
  referenceLocked: boolean;
}
export interface Mu7AdjudicationInput {
  unitId: string;
  decision?: 'AGREE' | 'DISAGREE' | null;
  reasonCode?: string | null;
  status: Mu7AdjudicationStatus;
  basis: Mu7Basis;
  disagreementReasonCode?: string | null;
  rationale: string;
}

// ---- Investigator ----------------------------------------------------------------------------
export interface Mu7GateStatus {
  gateId: string;
  requirementVersion: number;
  blocks: string[];
  requirementStatus: 'PENDING_SPECIFICATION' | 'SPECIFIED';
  question: string;
  /** The decision record an approval must name (SPECIFIED requirements only). */
  decisionReference: string | null;
  approvedAt: string | null;
  satisfied: boolean;
}
export interface Mu7RoutingCheck {
  unitId: string;
  family: Mu7Family;
  unitRole: 'PRIMARY' | 'SUBGROUP';
  routing: Mu7Routing;
  finalStatus: Mu7FinalStatus;
  finalAnswer: Mu7Answer | null;
  expectedRouting: Mu7Routing | null;
  matches: boolean | null;
}
export interface Mu7InvestigatorWorkspace {
  kind: 'investigator';
  design: {
    designVersion: string;
    assignmentSetId: string;
    overlapSetting: string;
    nPrimaryPlanned: number;
    nSubgroupPlanned: number;
    recordedAt: string;
  } | null;
  counts: { pilotUnits: number; formalUnits: number; trainingUnits: number; pilotQueue: number };
  pilotReviewers: string[];
  completion: { reviewerSlot: number; assigned: number; answered: number }[];
  /** Synthetic pilot check only: the routing reached against the walkthrough's expected routing. */
  pilotRouting: Mu7RoutingCheck[];
  pilotLock: { nUnitsLocked: number; lockedAt: string } | null;
  exports: {
    exportId: string;
    mode: Mu7Mode;
    manifestSha256: string;
    appGitSha: string;
    createdAt: string;
  }[];
  phaseEvents: { eventType: string; occurredAt: string }[];
  gates: Mu7GateStatus[];
  /** Always false in this build: the FORMAL freeze and opening wait for specified, approved gates. */
  formalOperationsEnabled: false;
  formalDisabledReason: string;
  localTools: boolean;
  appGitSha: string;
}
export type Mu7Workspace =
  Mu7ReviewerWorkspace | Mu7AdjudicatorWorkspace | Mu7InvestigatorWorkspace;

export type Mu7AdminAction =
  | { action: 'record-design'; attestation: string }
  | { action: 'import-pilot' }
  | { action: 'import-training' }
  | { action: 'assign-pilot' }
  | { action: 'lock-pilot'; attestation: string }
  | { action: 'register-pilot-export'; notes?: string }
  /** The investigator's own approval of a SPECIFIED gate; the server cites its decision record. */
  | { action: 'approve-gate'; gateId: string; attestation: string }
  | { action: 'lock-account'; account: 'reviewer-a' | 'reviewer-b' | 'adjudicator'; reason: string }
  | { action: 'unlock-account'; account: 'reviewer-a' | 'reviewer-b' | 'adjudicator' };

// ---- Bundle 7.0 ------------------------------------------------------------------------------
export interface Mu7BundleFile {
  name: string;
  role:
    | 'units'
    | 'unit_design'
    | 'independent_judgments'
    | 'final_reference'
    | 'subtype_observations'
    | 'probabilities'
    | 'probability_source';
  rows: number;
  sha256: string;
  content: string;
}
export interface Mu7Bundle {
  mode: Mu7Mode;
  manifest: Record<string, unknown>;
  manifestName: 'manifest.json';
  manifestText: string;
  manifestSha256: string;
  files: Mu7BundleFile[];
}

/** Packet projection: only the keys the migration admits, re-selected by name. */
export function mu7PacketView(p: Record<string, unknown>): Mu7Packet {
  const u = (p.unit ?? {}) as Record<string, unknown>;
  const t = (p.trial ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
  const strs = (v: unknown) =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : undefined;
  const unit: Mu7UnitBlock = {
    unit_id: String(u.unit_id ?? ''),
    mode: u.mode as Mu7UnitBlock['mode'],
    family: u.family as Mu7Family,
    category: String(u.category ?? ''),
    unit_role: u.unit_role as Mu7UnitBlock['unit_role'],
    mapping_code: String(u.mapping_code ?? ''),
    mapping_label: String(u.mapping_label ?? ''),
    assignment_code: String(u.assignment_code ?? ''),
    assignment_status: 'ASSIGNED',
    display_text: String(u.display_text ?? ''),
  };
  for (const k of [
    'display_decision',
    'parent_row_code',
    'parent_row_label',
    'display_note',
  ] as const)
    if (typeof u[k] === 'string') unit[k] = u[k] as string;
  const trial: Mu7TrialBlock = {
    nct_id: String(t.nct_id ?? ''),
    brief_title: String(t.brief_title ?? ''),
  };
  if (str(t.registry_url)) trial.registry_url = str(t.registry_url);
  if (str(t.official_title)) trial.official_title = str(t.official_title);
  if (strs(t.conditions_registered)) trial.conditions_registered = strs(t.conditions_registered);
  if (strs(t.condition_mesh_headings))
    trial.condition_mesh_headings = strs(t.condition_mesh_headings);
  if (str(t.brief_summary)) trial.brief_summary = str(t.brief_summary);
  if (str(t.detailed_description)) trial.detailed_description = str(t.detailed_description);
  if (Array.isArray(t.interventions))
    trial.interventions = (t.interventions as Record<string, unknown>[]).map((i) => ({
      intervention_type: String(i.intervention_type ?? ''),
      name: String(i.name ?? ''),
      ...(typeof i.description === 'string' ? { description: i.description } : {}),
    }));
  if (t.eligibility_age_range && typeof t.eligibility_age_range === 'object') {
    const e = t.eligibility_age_range as Record<string, unknown>;
    trial.eligibility_age_range = {
      ...(typeof e.minimum_age === 'string' ? { minimum_age: e.minimum_age } : {}),
      ...(typeof e.maximum_age === 'string' ? { maximum_age: e.maximum_age } : {}),
    };
  }
  return { unit, trial, notices: strs(p.notices) ?? [] };
}
