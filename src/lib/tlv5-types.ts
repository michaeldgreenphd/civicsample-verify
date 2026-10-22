// Design v5 (trial-level label verification) DTOs. Every shape here is an explicit allow-list of
// what a role may receive; nothing is a raw database row. See docs/design_v5/APP_MAPPING_v5_1.md.
import type { Actor } from './types';

export type Tlv5Mode = 'PILOT' | 'CALIBRATION' | 'TRAINING' | 'FORMAL';
export type Tlv5AreaKey =
  | 'ONCOLOGY'
  | 'CARDIOVASCULAR'
  | 'MENTAL_HEALTH'
  | 'INFECTIOUS'
  | 'METABOLIC'
  | 'NEUROLOGICAL'
  | 'RESPIRATORY';
export type Tlv5RowKey =
  'CAN_ALL' | 'DIAB' | 'DEP' | 'OBE' | 'AST' | 'COPD' | 'COV' | 'SCZ' | 'HTN' | 'PAIN';

/** Reviewer-visible trial packet (the only packet shape the database accepts for v5.1). */
export interface Tlv5TrialPacket {
  schema_version: string;
  case_title: string;
  trial: {
    nct_id?: string;
    brief_title: string;
    official_title: string;
    conditions_registered: string[];
    condition_mesh_headings: string[];
    brief_summary: string;
    interventions: { intervention_type: string; name: string; description: string }[];
    eligibility_age_range: { minimum_age: string; maximum_age: string };
  };
  notices: string[];
}

export interface Tlv5ItemInput {
  itemCode: string;
  answer: string;
  uncertain: boolean;
  note?: string;
  detailCode?: string;
}
export interface Tlv5SubmissionInput {
  items: Tlv5ItemInput[];
  overallComment?: string;
  packetIssueFlag: boolean;
  packetIssueNote?: string;
  secondsOnCase?: number;
}
export interface Tlv5Submission extends Tlv5SubmissionInput {
  revision: number;
  submittedAt: string;
}

export interface Tlv5QueueItem {
  assignmentId: string;
  caseId: string;
  mode: Tlv5Mode;
  title: string;
  queuePosition: number;
  submissions: number;
}

export interface Tlv5State {
  schemaVersions: string[];
  activation: { designVersion: string; adjudicationScope: string; activatedAt: string } | null;
  pilotSignedOff: boolean;
  pilotSignOff: { checklistVersion: string; appGitSha: string; occurredAt: string } | null;
  phase: 'NOT_OPENED' | 'OPEN' | 'CLOSED';
  phaseEvents: { eventType: string; occurredAt: string }[];
  frozen: {
    designVersion: string;
    nCases: number;
    nLabelRows: number;
    caseListSha256: string;
    labelRowsSha256: string;
    frozenAt: string;
  } | null;
  snapshot: { rows: number; sha256: string; takenAt: string } | null;
  /** Readable by every role through the database helper. */
  snapshotTaken: boolean;
  /** Readable by every role through private.tlv5_scope() (migration 0015). */
  adjudicationScope: 'DISAGREEMENTS_ONLY' | 'ALL_ITEMS';
  locks: Partial<Record<'PILOT' | 'TRAINING' | 'FORMAL', { lockedAt: string; items: number }>>;
  /** Submissions are accepted for this mode right now (the database enforces this independently). */
  submissionsOpen: Record<Tlv5Mode, boolean>;
}

export interface Tlv5ReviewerWorkspace {
  kind: 'reviewer';
  user: Actor;
  reviewer: { pseudoId: string; modeScope: 'PILOT' | 'FORMAL' } | null;
  queue: Tlv5QueueItem[];
  training: Tlv5QueueItem[];
  state: Tlv5State;
  rubricVersion: string;
}
export interface Tlv5AdjudicatorCase {
  caseId: string;
  mode: Tlv5Mode;
  title: string;
  itemsNeedingAdjudication: number;
  itemsAdjudicated: number;
  itemsWithAnswers: number;
}
export interface Tlv5AdjudicatorWorkspace {
  kind: 'adjudicator';
  user: Actor;
  cases: Tlv5AdjudicatorCase[];
  state: Tlv5State;
  rubricVersion: string;
}
export interface Tlv5CompletionRow {
  reviewerPseudoId: string;
  reviewerSlot: number;
  assigned: number;
  submitted: number;
  withRevisions: number;
}
export interface Tlv5InvestigatorWorkspace {
  kind: 'investigator';
  user: Actor;
  state: Tlv5State;
  counts: Record<Tlv5Mode, number>;
  completion: Record<Tlv5Mode, Tlv5CompletionRow[]>;
  reviewers: {
    pseudoId: string;
    modeScope: 'PILOT' | 'FORMAL';
    account: string | null;
    withdrawn: boolean;
  }[];
  formalCandidates: { account: string; userId: string; displayName: string }[];
  exports: {
    exportId: string;
    mode: string;
    createdAt: string;
    manifestSha256: string;
    appGitSha: string;
  }[];
  verification: {
    frozenLabels: { matches: boolean; frozenRows: number; currentRows: number } | null;
    snapshot: { matches: boolean; snapshotRows: number; currentRows: number } | null;
  };
  rubricVersion: string;
  rubricSha256: string;
  appGitSha: string;
}
export type Tlv5Workspace =
  Tlv5ReviewerWorkspace | Tlv5AdjudicatorWorkspace | Tlv5InvestigatorWorkspace;

export interface Tlv5ReviewerCase {
  caseId: string;
  mode: Tlv5Mode;
  assignmentId: string;
  packet: Tlv5TrialPacket;
  submissions: Tlv5Submission[];
  submissionsOpen: boolean;
  /** The runtime rubric differs from the rubric bound to this mode's first review activity. */
  rubricMismatch: boolean;
  /** TRAINING only, and only after this reviewer's own practice submission exists. */
  workedAnswer?: { items: Tlv5ItemInput[]; note: string } | null;
}
export interface Tlv5QueueRow {
  itemCode: string;
  reviewer1Answer: string | null;
  reviewer1Detail: string | null;
  reviewer1Uncertain: boolean | null;
  reviewer1Note: string | null;
  reviewer2Answer: string | null;
  reviewer2Detail: string | null;
  reviewer2Uncertain: boolean | null;
  reviewer2Note: string | null;
  needsAdjudication: boolean;
  adjudicated: boolean;
}
export interface Tlv5AdjudicationRecord {
  adjudicationId: string;
  itemCode: string;
  decision: string | null;
  detailCode: string | null;
  status: string;
  basis: string;
  rationale: string;
  disagreementReasonCode: string | null;
  adjudicatorRole: string | null;
  blinded: boolean | null;
  postUnblinding: boolean;
  decidedAt: string;
}
export interface Tlv5AdjudicatorCaseDetail {
  caseId: string;
  mode: Tlv5Mode;
  packet: Tlv5TrialPacket;
  items: Tlv5QueueRow[];
  adjudications: Tlv5AdjudicationRecord[];
  adjudicationOpen: boolean;
  /** The active adjudication scope; under DISAGREEMENTS_ONLY concordant items enter by rule. */
  adjudicationScope: 'DISAGREEMENTS_ONLY' | 'ALL_ITEMS';
}
export interface Tlv5AdjudicationInput {
  caseId: string;
  itemCode: string;
  decision: string | null;
  detailCode?: string;
  status: string;
  basis: string;
  rationale: string;
  disagreementReasonCode?: string;
}

export type Tlv5AdminAction =
  | { action: 'import-pilot' }
  | { action: 'assign'; mode: 'PILOT' | 'FORMAL' | 'TRAINING'; seed: number }
  | { action: 'lock'; mode: 'PILOT' | 'TRAINING' | 'FORMAL'; attestation: string }
  | { action: 'register-export'; mode: 'PILOT' | 'FORMAL'; notes?: string }
  | { action: 'sign-off'; checklistVersion: string; checklistSha256: string; attestation: string }
  | { action: 'activate'; designVersion: string; adjudicationScope: string; attestation: string }
  | { action: 'enroll-formal'; userId: string; qualifications?: string }
  | { action: 'freeze'; labelFileSha256: string; attestation: string }
  | {
      action: 'phase';
      eventType: 'FORMAL_OPENED' | 'FORMAL_CLOSED_COMPLETE' | 'FORMAL_CLOSED_INCOMPLETE';
      attestation: string;
    }
  | { action: 'snapshot' }
  | { action: 'provision-staging-accounts' };

export interface Tlv5BundleFile {
  role: 'independent_judgments' | 'adjudicated_reference' | 'frozen_labels';
  name: string;
  rows: number;
  sha256: string;
  content: string;
}
export interface Tlv5Bundle {
  manifest: Record<string, unknown>;
  manifestName: string;
  manifestSha256: string;
  files: Tlv5BundleFile[];
}

export interface Tlv5PilotCase {
  caseId: string;
  nctId: string;
  briefTitle: string;
  officialTitle: string;
  conditionsRegistered: string[];
  conditionMeshHeadings: string[];
  briefSummary: string;
  interventions: { interventionType: string; name: string; description: string }[];
  minimumAge: string;
  maximumAge: string;
  tier0Areas: string[];
  curatedV12Areas: string[];
  figure2Rows: string[];
  ruleD: string | null;
  ruleK: string | null;
  scriptAccount1: string;
  scriptAccount2: string;
  plantedDisagreement: string;
  notes: string;
}
