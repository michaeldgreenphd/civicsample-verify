// Mapping-confirmation review (docs/REVIEW_WORKFLOW_DECISIONS.md, 2026-10-22; docs/MAPPING_CONFIRMATION.md).
// The unit is one trial-to-condition mapping. The existing assignment is visible by investigator
// decision; this is a mapping confirmation, not a blinded clinical reference assessment, and its
// records never mix with the v4/v5 blinded-reference outputs.
import { createHash } from 'node:crypto';

export const MC_REVIEW_MODE = 'MAPPING_CONFIRMATION' as const;
export const MC_ASSIGNMENT_VISIBILITY = 'EXISTING_ASSIGNMENT_VISIBLE' as const;
export const MC_FORMAT_VERSION = 'mapping-confirmation-1.0' as const;
export const MC_EVIDENCE_SCHEMA = 'mc-evidence-1' as const;
/** PROPOSED: the ten condition rows of the PPR figure data (analysis primary v5 tables, 2026-10-20).
 *  Approval of the list, of the Pain row and of the "Neoplasms" relabel is an investigator item. */
export const MC_CONDITION_SET_ID = 'CONDSET-PPR-FIG2-v5.1-PROPOSED' as const;
export const MC_CONDITION_SET_STATUS = 'PROPOSED' as const;
export interface McCondition {
  code: string;
  label: string;
  /** Row status in the PPR figure data: compared with a benchmark, or shown as female share only. */
  figureRow: 'BENCHMARKED' | 'FEMALE_SHARE_ONLY';
  note?: string;
}
export const MC_CONDITIONS: readonly McCondition[] = [
  { code: 'OBE', label: 'Obesity', figureRow: 'BENCHMARKED' },
  { code: 'AST', label: 'Asthma', figureRow: 'BENCHMARKED' },
  { code: 'HTN', label: 'Hypertension', figureRow: 'BENCHMARKED' },
  { code: 'DEP', label: 'Depression', figureRow: 'BENCHMARKED' },
  { code: 'DIAB', label: 'Diabetes Mellitus', figureRow: 'BENCHMARKED' },
  { code: 'COV', label: 'COVID-19', figureRow: 'BENCHMARKED' },
  { code: 'SCZ', label: 'Schizophrenia', figureRow: 'BENCHMARKED' },
  {
    code: 'CAN_ALL',
    label: 'Neoplasms',
    figureRow: 'BENCHMARKED',
    note: 'Figure data row "Cancer & Neoplasms (All)"; relabel to "Neoplasms" per the revision decision list (pending confirmation).',
  },
  { code: 'COPD', label: 'Pulmonary Disease, Chronic Obstructive', figureRow: 'BENCHMARKED' },
  {
    code: 'PAIN',
    label: 'Pain',
    figureRow: 'FEMALE_SHARE_ONLY',
    note: 'No compatible benchmark; shown as female share only (ten figure rows, nine regression rows). Inclusion in the 100 mappings is an open investigator decision.',
  },
];
export const MC_CONDITION_CODES = MC_CONDITIONS.map((c) => c.code);

export type McAnswer = 'YES' | 'NO' | 'INSUFFICIENT_INFORMATION';
export const MC_ANSWERS: readonly McAnswer[] = ['YES', 'NO', 'INSUFFICIENT_INFORMATION'];
export const MC_ANSWER_LABELS: Record<McAnswer, string> = {
  YES: 'Yes, the mapping is appropriate',
  NO: 'No, the mapping is not appropriate',
  INSUFFICIENT_INFORMATION: 'Insufficient information (proposed rubric addition)',
};
export type McRecordCategory = 'SYNTHETIC_PILOT' | 'TRAINING_EXAMPLE' | 'EVALUATION';
export type McPhase = 'OPEN' | 'CLOSED' | 'ADJUDICATION' | 'LOCKED';
export type McEventType = 'CLOSED' | 'ADJUDICATION_AUTHORIZED' | 'LOCKED';
export type McAdjudicationStatus =
  'DISCORDANT_RESOLVED' | 'UNRESOLVED_ESCALATED' | 'RUBRIC_ADDITION_REVIEWED';
export const MC_ADJUDICATION_STATUSES: readonly McAdjudicationStatus[] = [
  'DISCORDANT_RESOLVED',
  'RUBRIC_ADDITION_REVIEWED',
  'UNRESOLVED_ESCALATED',
];
export type McAdjudicationBasis = 'REVIEWER_1' | 'REVIEWER_2' | 'NEITHER' | 'NONE';

/** The reviewer-visible evidence, assembled from source fields only (never generated). */
export interface McEvidence {
  schema_version: typeof MC_EVIDENCE_SCHEMA;
  brief_title: string;
  brief_summary: { present: true; text: string } | { present: false };
  /** Optional, collapsible on screen; scientific inclusion is pending. Needs source provenance. */
  detailed_description?:
    | { present: true; text: string; source_field: string }
    | { present: false; source_field: string };
  source: { system: string; version: string; fields: string[] };
}
/** The existing assignment under review. */
export interface McAssignmentUnderReview {
  assigned: boolean;
  assignment_source: string;
  assignment_version: string;
}
export interface McCaseInput {
  caseId: string;
  recordCategory: McRecordCategory;
  trialRef: string;
  conditionCode: string;
  conditionLabel: string;
  assignment: McAssignmentUnderReview;
  evidence: McEvidence;
}

// ------------------------------------------------------------------------------------------
// Rubric (DRAFT; hashed into every response and export)
// ------------------------------------------------------------------------------------------
export const MC_RUBRIC_VERSION = 'MAPPING_CONFIRMATION_RUBRIC-DRAFT-1';
export const MC_RUBRIC: readonly { heading: string; paragraphs: string[] }[] = [
  {
    heading: 'What you are asked',
    paragraphs: [
      'Each item shows one trial and one condition, together with the existing assignment of that trial to the condition. Using the trial title and the brief summary shown, decide whether that assignment is appropriate.',
      'Answer Yes when the trial studies the condition shown (as a studied population or target of the intervention). Answer No when it does not, and write a short annotation saying why.',
    ],
  },
  {
    heading: 'Evidence',
    paragraphs: [
      'The evidence is the trial title and the brief summary from the registry source record. When the source has no brief summary, the item says so; nothing is generated in its place. A detailed description is shown collapsed only when the source record holds one.',
      'You will not see any model output, reasoning, population counts or other reviewers’ answers. Do not look the trial up elsewhere; judge the mapping on the evidence shown.',
    ],
  },
  {
    heading: 'Insufficient information (proposed)',
    paragraphs: [
      'When the evidence does not allow a Yes or No, choose Insufficient information and write what is missing. This response is recorded as a proposed rubric addition and reviewed by the adjudicator; it is never counted as an approval.',
    ],
  },
  {
    heading: 'Finality',
    paragraphs: [
      'A submitted answer is final. Two reviewers answer every item independently; a separate adjudicator resolves disagreements after both have submitted.',
    ],
  },
];
export function renderMcRubric(): string {
  return (
    `# ${MC_RUBRIC_VERSION}\n\n` +
    MC_RUBRIC.map((s) => `## ${s.heading}\n\n${s.paragraphs.join('\n\n')}`).join('\n\n') +
    '\n'
  );
}
export function mcRubricSha256(): string {
  return createHash('sha256').update(renderMcRubric(), 'utf8').digest('hex');
}

// ------------------------------------------------------------------------------------------
// DTOs (explicit allow-lists; raw rows never leave the server)
// ------------------------------------------------------------------------------------------
export interface McCampaignState {
  reviewMode: typeof MC_REVIEW_MODE;
  assignmentVisibility: typeof MC_ASSIGNMENT_VISIBILITY;
  conditionSetId: string;
  conditionSetStatus: 'PROPOSED' | 'APPROVED';
  rubricVersion: string;
  rubricSha256: string;
  phase: McPhase;
  createdAt: string;
}
export interface McQueueItem {
  assignmentId: string;
  caseId: string;
  queuePosition: number;
  recordCategory: McRecordCategory;
  conditionCode: string;
  conditionLabel: string;
  briefTitle: string;
  submitted: boolean;
}
export interface McCaseView {
  caseId: string;
  recordCategory: McRecordCategory;
  trialRef: string;
  conditionCode: string;
  conditionLabel: string;
  conditionSetId: string;
  assignment: McAssignmentUnderReview;
  assignmentSha256: string;
  evidence: McEvidence;
  evidenceSha256: string;
  evidenceVersion: number;
}
export interface McOwnResponse {
  answer: McAnswer;
  annotation: string | null;
  rubricAdditionProposed: boolean;
  submittedAt: string;
}
export interface McReviewerCase {
  assignmentId: string;
  case: McCaseView;
  campaign: McCampaignState;
  submissionsOpen: boolean;
  /** Only this reviewer's own final answer; never another reviewer's. */
  ownResponse: McOwnResponse | null;
}
export interface McTrainingExample {
  caseId: string;
  case: McCaseView | null;
  walkthrough: McTrainingWalkthrough;
}
export interface McTrainingWalkthrough {
  caseId: string;
  purpose: string;
  reviewer1: { answer: McAnswer; annotation: string };
  reviewer2: { answer: McAnswer; annotation: string };
  adjudication: {
    decision: 'YES' | 'NO' | null;
    status: McAdjudicationStatus;
    rationale: string;
  } | null;
  discussion: string;
}
export interface McReviewerWorkspace {
  kind: 'reviewer';
  campaign: McCampaignState | null;
  queue: McQueueItem[];
  training: McTrainingExample[];
}
export interface McAdjudicationQueueItem {
  caseId: string;
  recordCategory: McRecordCategory;
  conditionCode: string;
  conditionLabel: string;
  briefTitle: string;
  reviewer1Answer: McAnswer | null;
  reviewer2Answer: McAnswer | null;
  needsAdjudication: boolean;
  adjudicated: boolean;
}
export interface McAdjudicatorCase {
  case: McCaseView;
  campaign: McCampaignState;
  responses: {
    reviewerSlot: 1 | 2;
    answer: McAnswer;
    annotation: string | null;
    rubricAdditionProposed: boolean;
  }[];
  adjudication: McAdjudicationRecord | null;
}
export interface McAdjudicationRecord {
  adjudicationId: string;
  caseId: string;
  decision: 'YES' | 'NO' | null;
  status: McAdjudicationStatus;
  basis: McAdjudicationBasis;
  rationale: string;
  decidedAt: string;
}
export interface McAdjudicatorWorkspace {
  kind: 'adjudicator';
  campaign: McCampaignState | null;
  queue: McAdjudicationQueueItem[];
  training: McTrainingExample[];
}
export interface McCompletionRow {
  reviewerPseudoId: string;
  reviewerSlot: number;
  assigned: number;
  submitted: number;
}
export interface McInvestigatorWorkspace {
  kind: 'investigator';
  campaign: McCampaignState | null;
  conditions: McCondition[];
  counts: { syntheticPilot: number; trainingExample: number; evaluation: number };
  completion: McCompletionRow[];
  reviewers: { pseudoId: string; modeScope: 'PILOT' | 'FORMAL' }[];
  events: { eventType: McEventType; occurredAt: string }[];
  exports: { exportId: string; createdAt: string; manifestSha256: string }[];
  adjudicationsRecorded: number;
  /** Always false in this build: evaluation import needs the approved condition set, frame, rubric and analysis plan. */
  evaluationImportAllowed: false;
  appGitSha: string;
}
export type McWorkspace = McReviewerWorkspace | McAdjudicatorWorkspace | McInvestigatorWorkspace;

export interface McSubmissionInput {
  answer: McAnswer;
  annotation?: string;
  displayedAssignmentSha256: string;
  displayedEvidenceSha256: string;
  displayedEvidenceVersion: number;
  rubricVersion: string;
  rubricSha256: string;
  secondsOnCase?: number;
}
export interface McAdjudicationInput {
  caseId: string;
  decision?: 'YES' | 'NO';
  status: McAdjudicationStatus;
  basis: McAdjudicationBasis;
  rationale: string;
}
export type McAdminAction =
  | { action: 'create-campaign' }
  | { action: 'import-synthetic' }
  | { action: 'import-evaluation' }
  | { action: 'assign'; seed: number }
  | { action: 'phase'; eventType: McEventType; attestation: string }
  | { action: 'register-export'; notes?: string };

export interface McBundleFile {
  role: 'cases' | 'responses';
  name: string;
  rows: number;
  sha256: string;
  content: string;
}
export interface McBundle {
  manifest: Record<string, unknown>;
  manifestName: string;
  manifestSha256: string;
  files: McBundleFile[];
}
