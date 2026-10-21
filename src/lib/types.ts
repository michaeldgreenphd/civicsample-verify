export type Role = 'INVESTIGATOR' | 'REVIEWER' | 'ADJUDICATOR';
export type Decision = 'INCLUDE' | 'EXCLUDE' | 'CONTEXT_DEPENDENT' | 'INSUFFICIENT_INFORMATION';
export type ApprovalState = 'PROPOSED' | 'APPROVED' | 'FROZEN';
export interface Actor {
  id: string;
  role: Role;
  displayName: string;
}
export interface JudgmentInput {
  decision: Decision;
  rationale: string;
  uncertain: boolean;
  context: string;
  packetProblem: boolean;
  level?: string;
  amendmentId?: string;
  descriptorRole?: string;
  packetProblemNote?: string;
  status?: 'RESOLVED' | 'UNRESOLVED_ESCALATED';
  basis?: string;
  reasonCode?: string;
}
export interface Judgment extends JudgmentInput {
  id: string;
  submittedAt: string;
  reviewerSlot?: string;
  version?: number;
}
export interface Gate {
  id: string;
  label: string;
  state: 'PASS' | 'BLOCKED' | 'NOT_TESTED';
  detail: string;
}
export interface QueueItem {
  caseId: string;
  title: string;
  area: string;
  unitType: 'DESCRIPTOR_AREA' | 'TRIAL_AREA';
  status: 'NOT_STARTED' | 'DRAFT' | 'STEP1_LOCKED' | 'SUBMITTED' | 'ADJUDICATED';
}
export interface Campaign {
  id: string;
  title: string;
  state: 'OPEN' | 'CLOSED' | 'ADJUDICATION' | 'LOCKED';
  mode: 'SYNTHETIC_PILOT';
  caseCount: number;
  completed: number;
  total: number;
}
export interface Configuration {
  tierVersion: 'PENDING' | 'v1.1' | 'v1.2';
  tierState: ApprovalState;
  rubricState: ApprovalState;
  sampleState: ApprovalState;
  adjudicationScope: 'ALL_CASE_LEVELS' | 'DISAGREEMENTS_ONLY';
  analysisPlanState: ApprovalState;
}
export interface Workspace {
  user: Actor;
  campaign: Campaign;
  queue: QueueItem[];
  gates: Gate[];
  configuration: Configuration;
  progress?: { label: string; completed: number; total: number }[];
  notice?: string;
}
export interface EvidencePacket {
  descriptorName: string;
  descriptorId: string;
  scopeNote: string;
  entryTerms: string[];
  treeNumbers: { number: string; label: string }[];
  areaDefinition: string;
  source: string;
  sourceVersion: string;
}
export interface TrialPacket {
  registryId: string;
  title: string;
  summary: string;
  conditions: string[];
  interventions: string[];
  primaryOutcomes: string[];
  studyType: string;
  primaryPurpose: string;
  phase: string;
  ageRange: string;
  source: string;
  sourceVersion: string;
}
export interface CaseDetail {
  caseId: string;
  title: string;
  area: string;
  unitType: 'DESCRIPTOR_AREA' | 'TRIAL_AREA';
  phase: Campaign['state'];
  packet: EvidencePacket;
  trialPacket?: TrialPacket;
  step1Required: boolean;
  step1Locked: boolean;
  step1?: Judgment;
  draft?: JudgmentInput;
  drafts?: JudgmentInput[];
  submission?: Judgment;
  humanReviews?: Judgment[];
  adjudication?: Adjudication;
  evidenceHash: string;
  availableAmendments?: { id: string; level: string; reason: string }[];
  adjudications?: Adjudication[];
}
export interface AdminInput {
  action:
    | 'close'
    | 'authorize-adjudication'
    | 'lock'
    | 'configure'
    | 'activate-formal'
    | 'authorize-amendment';
  caseId?: string;
  reviewerId?: string;
  level?: string;
  reason?: string;
  attestation?: string;
  configuration?: Partial<Configuration>;
}
export interface ExportData {
  campaign: Campaign;
  configuration: Configuration;
  cases: { caseId: string; area: string; evidenceHash: string }[];
  judgments: (Judgment & { caseId: string; level: string })[];
  adjudications: (Adjudication & { caseId: string; level: string })[];
  provenance: Record<string, string>;
}

export interface AdjudicationInput extends Omit<JudgmentInput, 'decision'> {
  decision: Decision | null;
  status: 'RESOLVED' | 'UNRESOLVED_ESCALATED';
  basis: string;
  reasonCode: string;
}
export interface Adjudication extends Omit<Judgment, 'decision'> {
  decision: Decision | null;
  status: 'RESOLVED' | 'UNRESOLVED_ESCALATED';
}
