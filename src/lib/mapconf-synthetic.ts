// SYNTHETIC FIXTURES ONLY. Fictional trials (SYN-NCT-… references), fictional titles and
// summaries, invented by engineering for the mapping-confirmation pilot and the three synthetic
// training walkthroughs. No real trial, registry text, label, reviewer answer or person appears.
// The real three worked examples are adapted only after their compatibility is documented
// (docs/MAPPING_CONFIRMATION.md, "Training examples").
import {
  MC_EVIDENCE_SCHEMA,
  type McCaseInput,
  type McEvidence,
  type McTrainingWalkthrough,
} from './mapconf-types';

const SOURCE = {
  system: 'SYNTHETIC_FIXTURE',
  version: 'syn-mc-1',
  fields: ['brief_title', 'brief_summary'],
};
function evidence(title: string, summary: string | null, detailed?: string): McEvidence {
  const out: McEvidence = {
    schema_version: MC_EVIDENCE_SCHEMA,
    brief_title: title,
    brief_summary: summary === null ? { present: false } : { present: true, text: summary },
    source: detailed ? { ...SOURCE, fields: [...SOURCE.fields, 'detailed_description'] } : SOURCE,
  };
  if (detailed)
    out.detailed_description = {
      present: true,
      text: detailed,
      source_field: 'detailed_description',
    };
  return out;
}
const assignment = {
  assigned: true,
  assignment_source: 'SYN-CONDITION-MAP',
  assignment_version: 'syn-1',
};
const syn = (
  n: number,
  conditionCode: string,
  conditionLabel: string,
  title: string,
  summary: string | null,
  detailed?: string,
): McCaseInput => ({
  caseId: `MC-SYN-${String(n).padStart(3, '0')}`,
  recordCategory: 'SYNTHETIC_PILOT',
  trialRef: `SYN-NCT-${String(1000 + n)}`,
  conditionCode,
  conditionLabel,
  assignment,
  evidence: evidence(title, summary, detailed),
});

export const MC_SYNTHETIC_PILOT_CASES: readonly McCaseInput[] = [
  syn(
    1,
    'OBE',
    'Obesity',
    'Fictional Lifestyle Program for Adults With Obesity',
    'A fictional randomized study comparing a structured lifestyle program with usual care in adults with a body mass index of 30 or more.',
  ),
  syn(
    2,
    'AST',
    'Asthma',
    'Fictional Inhaled Regimen in Persistent Asthma',
    'A fictional trial of a twice-daily inhaled regimen in adults with persistent asthma not controlled on standard therapy.',
  ),
  syn(
    3,
    'HTN',
    'Hypertension',
    'Fictional Home Monitoring Study in Uncontrolled Hypertension',
    null,
  ),
  syn(
    4,
    'DEP',
    'Depression',
    'Fictional Brief Therapy for Major Depressive Episode',
    'A fictional study of a six-session therapy for adults with a current major depressive episode.',
  ),
  syn(
    5,
    'DIAB',
    'Diabetes Mellitus',
    'Fictional Glucose Sensor Study in Type 2 Diabetes',
    'A fictional crossover study of a continuous glucose sensor in adults with type 2 diabetes.',
    'Fictional detailed description: participants wear the sensor for two periods of fourteen days separated by a wash-out period. This text exists only to exercise the collapsible detailed-description field with source provenance.',
  ),
  syn(
    6,
    'COV',
    'COVID-19',
    'Fictional Outpatient Treatment of Mild COVID-19',
    'A fictional placebo-controlled trial of an oral agent started within five days of symptom onset in outpatients with confirmed mild COVID-19.',
  ),
  syn(
    7,
    'SCZ',
    'Schizophrenia',
    'Fictional Long-Acting Injectable in Schizophrenia',
    'A fictional open-label study of a long-acting injectable antipsychotic in adults with schizophrenia after a recent relapse.',
  ),
  syn(
    8,
    'CAN_ALL',
    'Neoplasms',
    'Fictional Supportive Care During Chemotherapy for Solid Tumours',
    'A fictional trial of a supportive-care bundle during first-line chemotherapy for adults with advanced solid tumours.',
  ),
  syn(
    9,
    'COPD',
    'Pulmonary Disease, Chronic Obstructive',
    'Fictional Pulmonary Rehabilitation After COPD Exacerbation',
    'A fictional study of early pulmonary rehabilitation after a hospital admission for an exacerbation of chronic obstructive pulmonary disease.',
  ),
  syn(
    10,
    'PAIN',
    'Pain',
    'Fictional Analgesic Protocol After Knee Surgery',
    'A fictional comparison of two analgesic protocols for post-operative pain after elective knee surgery.',
  ),
  // Planted disagreement for the synthetic pilot: a vaccine study of healthy volunteers mapped to
  // COVID-19; one scripted reviewer answers YES and the other NO in the tests and the browser run.
  syn(
    11,
    'COV',
    'COVID-19',
    'Fictional Vaccine Immunogenicity Study in Healthy Volunteers',
    'A fictional study of antibody responses to a vaccine in healthy adult volunteers without current infection.',
  ),
  // A mapping whose summary is missing; the scripted reviewers answer INSUFFICIENT_INFORMATION.
  syn(12, 'DEP', 'Depression', 'Fictional Registry Follow-up Study', null),
];

export const MC_SYNTHETIC_TRAINING_CASES: readonly McCaseInput[] = [
  {
    caseId: 'MC-TRN-001',
    recordCategory: 'TRAINING_EXAMPLE',
    trialRef: 'SYN-NCT-2001',
    conditionCode: 'HTN',
    conditionLabel: 'Hypertension',
    assignment,
    evidence: evidence(
      'Fictional Salt-Reduction Trial in Adults With Hypertension',
      'A fictional randomized trial of dietary salt reduction in adults with treated hypertension, with blood pressure at twelve weeks as the outcome.',
    ),
  },
  {
    caseId: 'MC-TRN-002',
    recordCategory: 'TRAINING_EXAMPLE',
    trialRef: 'SYN-NCT-2002',
    conditionCode: 'DIAB',
    conditionLabel: 'Diabetes Mellitus',
    assignment,
    evidence: evidence(
      'Fictional Foot-Care Education in Community Pharmacies',
      'A fictional cluster trial of a foot-care education leaflet for all adult customers of community pharmacies.',
    ),
  },
  {
    caseId: 'MC-TRN-003',
    recordCategory: 'TRAINING_EXAMPLE',
    trialRef: 'SYN-NCT-2003',
    conditionCode: 'AST',
    conditionLabel: 'Asthma',
    assignment,
    evidence: evidence('Fictional Air-Filter Study in Households With Children', null),
  },
];

/** Scripted walkthroughs for the synthetic training examples. These are not reviewer submissions
 *  and are stored nowhere in the database; the screens label them as synthetic. */
export const MC_SYNTHETIC_TRAINING_WALKTHROUGHS: readonly McTrainingWalkthrough[] = [
  {
    caseId: 'MC-TRN-001',
    purpose: 'A clear Yes: the studied population is the condition shown.',
    reviewer1: {
      answer: 'YES',
      annotation: 'Adults with treated hypertension are the enrolled population.',
    },
    reviewer2: {
      answer: 'YES',
      annotation: 'Blood pressure outcome in a hypertensive population.',
    },
    adjudication: null,
    discussion: 'Both scripted reviewers agree. Concordant mappings are not adjudicated.',
  },
  {
    caseId: 'MC-TRN-002',
    purpose: 'A disagreement resolved by the adjudicator.',
    reviewer1: { answer: 'YES', annotation: 'Foot care is a diabetes topic.' },
    reviewer2: {
      answer: 'NO',
      annotation:
        'The population is all pharmacy customers; the summary does not say the trial studies people with diabetes.',
    },
    adjudication: {
      decision: 'NO',
      status: 'DISCORDANT_RESOLVED',
      rationale:
        'The evidence shown describes a general adult population; a topical link is not a studied condition under the rubric.',
    },
    discussion:
      'The adjudicator reads both annotations after both final answers exist and decides on the evidence shown.',
  },
  {
    caseId: 'MC-TRN-003',
    purpose: 'Insufficient information: a missing summary is marked, never filled in.',
    reviewer1: {
      answer: 'INSUFFICIENT_INFORMATION',
      annotation:
        'The source has no brief summary; the title alone does not say whether children with asthma are enrolled.',
    },
    reviewer2: {
      answer: 'INSUFFICIENT_INFORMATION',
      annotation: 'Title only; no population stated.',
    },
    adjudication: {
      decision: null,
      status: 'RUBRIC_ADDITION_REVIEWED',
      rationale:
        'Both reviewers proposed the rubric addition; recorded for the investigator, not counted as an approval.',
    },
    discussion: 'Insufficient information is a proposed rubric addition and never an approval.',
  },
];
