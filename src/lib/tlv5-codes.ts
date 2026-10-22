// Design v5 code lists and the reviewer rubric text. The lists mirror
// migrations/0011_v5_trial_label_verification.sql and analysis/performance_analysis_v5.py exactly.
// The rubric is a DRAFT (docs/design_v5/REVIEW_RUBRIC_v5_1.md, section 2 decisions pending); its
// SHA-256 is computed from the rendered text and recorded in every export manifest.
import { createHash } from 'node:crypto';
import type { Tlv5AreaKey, Tlv5RowKey } from './tlv5-types';

export const AREA_KEYS: readonly Tlv5AreaKey[] = [
  'ONCOLOGY',
  'CARDIOVASCULAR',
  'MENTAL_HEALTH',
  'INFECTIOUS',
  'METABOLIC',
  'NEUROLOGICAL',
  'RESPIRATORY',
];
export const ROW_KEYS: readonly Tlv5RowKey[] = [
  'CAN_ALL',
  'DIAB',
  'DEP',
  'OBE',
  'AST',
  'COPD',
  'COV',
  'SCZ',
  'HTN',
  'PAIN',
];
export const AREA_ITEMS = AREA_KEYS.map((a) => `AREA_${a}`);
export const ROW_ITEMS = ROW_KEYS.map((r) => `FIG2_ROW_${r}`);
export const SG_ITEMS = ['SG_DIABETES_TYPE', 'SG_NEOPLASM_MALIGNANCY'] as const;
export const REVIEWER_ITEMS: readonly string[] = [...AREA_ITEMS, ...ROW_ITEMS, ...SG_ITEMS];
export const SG_ROW: Record<string, string> = {
  SG_DIABETES_TYPE: 'FIG2_ROW_DIAB',
  SG_NEOPLASM_MALIGNANCY: 'FIG2_ROW_CAN_ALL',
};
export const AREA_LABELS: Record<Tlv5AreaKey, string> = {
  ONCOLOGY: 'Oncology',
  CARDIOVASCULAR: 'Cardiovascular',
  MENTAL_HEALTH: 'Mental health',
  INFECTIOUS: 'Infectious',
  METABOLIC: 'Metabolic',
  NEUROLOGICAL: 'Neurological',
  RESPIRATORY: 'Respiratory',
};
export const ROW_LABELS: Record<Tlv5RowKey, string> = {
  CAN_ALL: 'Neoplasms',
  DIAB: 'Diabetes Mellitus',
  DEP: 'Depression',
  OBE: 'Obesity',
  AST: 'Asthma',
  COPD: 'Pulmonary Disease, Chronic Obstructive',
  COV: 'COVID-19',
  SCZ: 'Schizophrenia',
  HTN: 'Hypertension',
  PAIN: 'Pain',
};
export const SCALES: Record<string, readonly string[]> = {
  AREA: ['YES', 'NO', 'CONTEXT_DEPENDENT', 'INSUFFICIENT_INFORMATION'],
  FIG2_ROW: ['YES', 'NO', 'INSUFFICIENT_INFORMATION'],
  SG_DIABETES_TYPE: ['TYPE_2', 'TYPE_1', 'BOTH_TYPE_1_AND_TYPE_2', 'OTHER', 'UNCLEAR'],
  SG_NEOPLASM_MALIGNANCY: ['MALIGNANT', 'NON_MALIGNANT', 'UNCLEAR'],
};
export const DETAIL_CODES: Record<string, readonly string[]> = {
  'SG_DIABETES_TYPE/OTHER': [
    'PREDIABETES',
    'GESTATIONAL',
    'LADA_OR_AUTOIMMUNE',
    'MONOGENIC_OR_SECONDARY',
    'DIABETES_NOT_STUDIED',
    'OTHER_SPECIFIED',
  ],
  'SG_NEOPLASM_MALIGNANCY/NON_MALIGNANT': [
    'PRECANCEROUS',
    'BENIGN_NEOPLASM',
    'NOT_A_NEOPLASM',
    'OTHER_SPECIFIED',
  ],
};
export const ADJUDICATION_STATUSES = [
  'DISCORDANT_RESOLVED',
  'SINGLE_REVIEW_ADJUDICATED',
  'UNRESOLVED_ESCALATED',
  'CONCORDANT_CONFIRMED',
  'CONCORDANT_REVISED',
] as const;
export const ADJUDICATION_BASES = [
  'REVIEWER_1',
  'REVIEWER_2',
  'BOTH_REVIEWERS',
  'NEITHER',
  'NONE',
] as const;
export const DISAGREEMENT_REASONS = [
  'CONSTRUCT_BOUNDARY',
  'POLICY_RULE_INTERPRETATION',
  'MESH_PLACEMENT_MISLEADING',
  'TRIAL_CONTEXT',
  'PACKET_INSUFFICIENT',
  'MULTILABEL_OR_CROSS_AREA',
  'OTHER',
] as const;
export const RULE_D_OUTCOMES = [
  'D1_KEEP_TYPE2',
  'D2_REMOVE_OTHER_TYPE',
  'D3_REMOVE_PREDIABETES_ONLY',
  'D4A_KEEP_UNRESOLVED_PARENT_ONLY',
  'D4B_KEEP_UNRESOLVED_COMPLICATION_ONLY',
] as const;
export const RULE_K_OUTCOMES = [
  'K_KEEP_MALIGNANT_COMPATIBLE',
  'K_KEEP_HEURISTIC_NONMALIGNANT_CLASS',
  'K_REMOVE_VERIFIED_NONMALIGNANT',
] as const;

export function itemFamily(itemCode: string): string {
  if (AREA_ITEMS.includes(itemCode)) return 'AREA';
  if (ROW_ITEMS.includes(itemCode)) return 'FIG2_ROW';
  if ((SG_ITEMS as readonly string[]).includes(itemCode)) return itemCode;
  return 'UNKNOWN';
}
export function answerAllowed(itemCode: string, answer: string): boolean {
  return (SCALES[itemFamily(itemCode)] ?? []).includes(answer);
}
export function detailAllowed(itemCode: string, answer: string, detail?: string | null): boolean {
  const allowed = DETAIL_CODES[`${itemCode}/${answer}`];
  if (!allowed) return detail === undefined || detail === null || detail === '';
  return !!detail && allowed.includes(detail);
}
export function itemQuestion(itemCode: string): string {
  if (itemCode.startsWith('AREA_'))
    return `Does this trial belong to the ${AREA_LABELS[itemCode.slice(5) as Tlv5AreaKey]} therapeutic area, as defined in the rubric?`;
  if (itemCode.startsWith('FIG2_ROW_'))
    return `Does this trial study ${ROW_LABELS[itemCode.slice(9) as Tlv5RowKey]}?`;
  if (itemCode === 'SG_DIABETES_TYPE') return 'Which diabetes does the trial study?';
  return 'Is the neoplasm studied malignant?';
}
export const ANSWER_LABELS: Record<string, string> = {
  YES: 'Yes',
  NO: 'No',
  CONTEXT_DEPENDENT: 'Context dependent',
  INSUFFICIENT_INFORMATION: 'Insufficient information',
  TYPE_2: 'Type 2',
  TYPE_1: 'Type 1',
  BOTH_TYPE_1_AND_TYPE_2: 'Both type 1 and type 2',
  OTHER: 'Other (detail required)',
  UNCLEAR: 'Unclear',
  MALIGNANT: 'Malignant',
  NON_MALIGNANT: 'Non-malignant (detail required)',
  NOT_APPLICABLE: 'Not applicable (item not shown)',
};

/**
 * Reviewer rubric, design v5.1, DRAFT. The seven construct definitions are the `intended_construct`
 * texts of the frozen ontology (v1.0.0) verbatim; the policies are the investigator's OQ-01, OQ-03
 * and OQ-04 texts and the comorbidity, complication and trial-context policies, shown without rule
 * identifiers, MeSH root codes or any statement of the Tier 0 rule.
 */
export const TLV5_RUBRIC_VERSION = 'REVIEW_RUBRIC_v5_1-DRAFT';
export interface RubricSection {
  heading: string;
  paragraphs: string[];
}
export const TLV5_RUBRIC: readonly RubricSection[] = [
  {
    heading: 'Status',
    paragraphs: [
      'DRAFT, not frozen. The investigator has not yet recorded the decisions that precede the freeze (construct, adjudication scope, subgroup display rule, calibration, training outcome display, rubric text). Nothing shown here is a study result.',
      'Your task: for one registered trial, answer the seven therapeutic-area questions, the ten condition-row questions and, when your own answer to a condition row is Yes, the matching subgroup question. Areas are non-exclusive: a trial may belong to several areas or to none.',
    ],
  },
  {
    heading: 'Three states, never collapsed',
    paragraphs: [
      'An answer is recorded (Yes, No, or a subgroup value); or you record explicitly that the packet cannot decide (Context dependent, Insufficient information, Unclear); or the item was not shown to you (a subgroup question after a row answer other than Yes). Each item also takes an uncertainty flag and a note. A note is required when you select OTHER_SPECIFIED.',
      'You may revise an answer until the phase closes; the first submission and every revision are kept. Use the packet-problem flag, with a note, to report a missing or wrong record.',
    ],
  },
  {
    heading: 'What you will not see',
    paragraphs: [
      'Any classification label of the trial, any sampling design field, any model output, the other reviewer’s answers, any adjudication, enrollment, participant counts, sex composition, results, or registry links. The trial identifier is shown as text; please do not look the trial up in the registry or elsewhere.',
    ],
  },
  {
    heading: 'Therapeutic-area constructs',
    paragraphs: [
      'Oncology: Trials whose condition studied is a neoplasm: a malignant neoplasm, an in situ or borderline neoplasm, a clonal precursor of a haematological malignancy, or a haematolymphoid neoplasm, including prevention, screening, treatment, survivorship and supportive care when the cancer is the condition studied.',
      'Cardiovascular: Trials whose condition studied is a disease of the heart or blood vessels as managed in cardiology, vascular medicine, cardiothoracic or vascular surgery, or stroke care: ischaemic heart disease, heart failure, arrhythmias, valvular and congenital heart disease, cardiomyopathies, hypertension, cerebrovascular disease, aortic and peripheral arterial disease, venous thromboembolism and chronic venous disease, vasculitis.',
      'Mental health: Trials whose condition studied is a mental, behavioural or neurodevelopmental disorder (the conditions of DSM-5-TR, ICD-10 chapter F or ICD-11 chapter 6), including substance use disorders, or a clinically significant psychiatric symptom state studied as a mental health condition.',
      'Infectious: Trials whose condition studied is an infection or infectious disease (bacterial, viral, fungal, parasitic, prion), including treatment, prophylaxis and vaccination against a named infection, and infection-defined syndromes such as sepsis.',
      'Metabolic: Trials whose condition studied is a nutritional or metabolic disease: diabetes mellitus and other disorders of glucose metabolism, obesity and overnutrition, lipid disorders, inborn errors of metabolism, metabolic bone disease, malnutrition and nutritional deficiencies, disorders of mineral, electrolyte and acid-base balance, metabolic syndrome, systemic amyloidosis.',
      'Neurological: Trials whose condition studied is a disease of the central or peripheral nervous system, neuromuscular junction or skeletal muscle as managed in neurology, neurosurgery or neurorehabilitation: cerebrovascular disease, epilepsy, headache disorders, neurodegenerative and demyelinating diseases, neuromuscular disease, neuropathies, nervous system infections, traumatic brain and spinal cord injury, neurological sleep disorders, neurocognitive disorders.',
      'Respiratory: Trials whose condition studied is a disease of the airways, lungs, pleura, upper respiratory tract or respiratory control as managed in pulmonology, critical care, allergy or otolaryngology: asthma, COPD, bronchiectasis, cystic fibrosis, interstitial lung disease, pulmonary vascular disease, respiratory infections, respiratory failure and ARDS, sleep-related breathing disorders, rhinitis and sinusitis.',
    ],
  },
  {
    heading: 'General policies',
    paragraphs: [
      'Comorbidity: a condition present in participants but not studied by the trial (eligibility criterion, population descriptor, background disease) does not make that trial a member of the condition’s area.',
      'Complications: a complication of a disease is classified by the area of the complication’s own pathology and the specialty that manages it, not by the parent disease. It keeps the parent disease’s area only when it is an acute manifestation managed as part of the parent disease (for example diabetic ketoacidosis within Metabolic).',
      'Trial-level context: answer Context dependent only when the packet shows that the condition is both studied in a way that belongs to the area and used in a way that does not, so that no single answer is right. Construct ambiguity is not a reason for Context dependent: the policies decide it, or the answer is Insufficient information.',
    ],
  },
  {
    heading: 'Investigator policies (proposed default construct)',
    paragraphs: [
      'Neoplasms: Classify trials targeting neoplasms under Oncology. Do not add organ-system classifications merely because a cancer originates in that organ. Permit additional therapeutic areas when there is a separate, explicitly investigated clinical indication.',
      'Depression: Include Depression under Mental Health when depressive symptoms or depression are the clinical target, without assuming every trial is a major depressive disorder trial.',
      'Smoking cessation: Include smoking cessation under Mental Health when the trial investigates tobacco dependence, addiction, or a clinically defined substance-use disorder. Do not automatically classify general cessation or prevention interventions as mental-health trials.',
    ],
  },
  {
    heading: 'Condition rows and subgroups',
    paragraphs: [
      'Each condition-row question asks whether the trial studies the named condition: Neoplasms; Diabetes Mellitus; Depression; Obesity; Asthma; Pulmonary Disease, Chronic Obstructive; COVID-19; Schizophrenia; Hypertension; Pain. Options: Yes, No, Insufficient information.',
      'Diabetes type (shown only after Diabetes Mellitus = Yes): Type 2; Type 1; Both type 1 and type 2; Other with a required detail (prediabetes, gestational, LADA or autoimmune, monogenic or secondary, diabetes not studied, other specified); Unclear.',
      'Malignancy (shown only after Neoplasms = Yes): Malignant; Non-malignant with a required detail (precancerous, benign neoplasm, not a neoplasm, other specified); Unclear.',
    ],
  },
];
export function renderRubric(): string {
  return (
    `# ${TLV5_RUBRIC_VERSION}\n\n` +
    TLV5_RUBRIC.map((s) => `## ${s.heading}\n\n${s.paragraphs.join('\n\n')}`).join('\n\n') +
    '\n'
  );
}
export function rubricSha256(): string {
  return createHash('sha256').update(renderRubric(), 'utf8').digest('hex');
}
