// Review design v7: the synthetic material the local walkthrough uses. SYNTHETIC ONLY.
// - The 12 pilot units come unchanged from the supplied public file
//   tests/handoff/fixtures/v7/SYNTHETIC_PILOT_UNITS_v7.json: `units[i].import` goes to
//   rpc_mu7_import_unit as is; `units[i].walkthrough` (planted answers and expected routing) never
//   reaches the database and is used here only for the investigator's synthetic routing check.
// - The three worked examples are SYNTHETIC counterparts of the rubric's EX7-01 to EX7-03
//   (REVIEW_RUBRIC_v7.md section 7) with fictional trials. The real worked examples are private
//   (data_private) and never part of this repository.
// - The design record is a synthetic local design; the study's design values wait for the
//   investigator (gate G-OVERLAP-01 among others).
import PILOT from '../../tests/handoff/fixtures/v7/SYNTHETIC_PILOT_UNITS_v7.json';
import VOCABULARY from '../../tests/handoff/fixtures/v7/VOCABULARY_CONTRACT_v7.json';
import type { Mu7Answer, Mu7Routing } from './mu7-types';

export interface Mu7PilotImport {
  unit_id: string;
  mode: 'PILOT';
  unit_role: 'PRIMARY' | 'SUBGROUP';
  family: string;
  [key: string]: unknown;
}
interface PilotFileUnit {
  import: Mu7PilotImport;
  walkthrough: {
    planted_answers: {
      reviewer_slot: 1 | 2;
      answer: Mu7Answer;
      reason_code: string | null;
      note: string | null;
      uncertain: boolean;
    }[];
    expected_routing: string;
  };
}
const UNITS = (PILOT as unknown as { units: PilotFileUnit[] }).units;

export const MU7_PILOT_STATUS = (PILOT as { status: string }).status;
export const MU7_PILOT_IMPORTS: readonly Mu7PilotImport[] = UNITS.map((u) => u.import);
/** The walkthrough's planted answers (tests and the scripted demo only; never sent as imports). */
export const MU7_PILOT_PLANTED = Object.fromEntries(
  UNITS.map((u) => [u.import.unit_id, u.walkthrough.planted_answers]),
) as Record<string, PilotFileUnit['walkthrough']['planted_answers']>;
const ROUTING: Record<string, Mu7Routing> = {
  BOTH_AGREE: 'CONCORDANT_AGREE',
  BOTH_DISAGREE: 'CONCORDANT_DISAGREE',
  BOTH_CANNOT_TELL: 'BOTH_CANNOT_TELL',
  AGREE_VS_DISAGREE: 'ROUTED',
  ONE_CANNOT_TELL: 'ROUTED',
};
/** The routing the walkthrough expects for each synthetic pilot unit, in the database's terms. */
export const MU7_PILOT_EXPECTED_ROUTING: Record<string, Mu7Routing> = Object.fromEntries(
  UNITS.map((u) => [u.import.unit_id, ROUTING[u.walkthrough.expected_routing]]),
);

/** Pilot queues: primary units first, then subgroup units; slot 2 in reverse order within each. */
export function mu7PilotQueues(): { slot1: string[]; slot2: string[] } {
  const prim = MU7_PILOT_IMPORTS.filter((u) => u.unit_role === 'PRIMARY').map((u) => u.unit_id);
  const sg = MU7_PILOT_IMPORTS.filter((u) => u.unit_role === 'SUBGROUP').map((u) => u.unit_id);
  return { slot1: [...prim, ...sg], slot2: [...[...prim].reverse(), ...[...sg].reverse()] };
}

export const MU7_SYNTHETIC_DESIGN = {
  design_version: 'SYN-7-LOCAL-WALKTHROUGH',
  assignment_set_id: 'SYN7-ASSIGN-LOCAL-WALKTHROUGH',
  overlap_setting: 'ALLOW',
  n_primary_planned: 96,
  n_subgroup_planned: 4,
} as const;

// ---- Synthetic worked examples ---------------------------------------------------------------
const label = (family: string, category: string) =>
  (VOCABULARY.mapping_labels as Record<string, string>)[`${family}|${category}`];
const trial = (
  n: number,
  title: string,
  conditions: string[],
  headings: string[],
  summary: string,
) => ({
  nct_id: `SYN-NCT-93${String(n).padStart(2, '0')}`,
  brief_title: title,
  official_title: `${title}: a fictional study for reviewer training only`,
  conditions_registered: conditions,
  condition_mesh_headings: headings,
  brief_summary: `SYNTHETIC TRAINING TEXT. ${summary}`,
  interventions: [{ intervention_type: 'DRUG', name: 'Synthetic drug', description: 'fictional' }],
  eligibility_age_range: { minimum_age: '18 Years', maximum_age: 'N/A' },
});
const areaUnit = (id: string, category: string) => ({
  unit_id: id,
  mode: 'TRAINING',
  family: 'AREA',
  category,
  unit_role: 'PRIMARY',
  mapping_code: `AREA_${category}`,
  mapping_label: label('AREA', category),
  assignment_code: 'IN_AREA',
  assignment_status: 'ASSIGNED',
  display_text: 'in this area',
});
const NOTICE = 'SYNTHETIC TRAINING EXAMPLE, READ ONLY: outside every total';
export const MU7_SYNTHETIC_TRAINING: readonly {
  training_unit_id: string;
  packet: Record<string, unknown>;
}[] = [
  {
    training_unit_id: 'EX7-01',
    packet: {
      schema_version: '7.0',
      unit: areaUnit('EX7-01', 'METABOLIC'),
      trial: trial(
        1,
        'Synthetic glucose-lowering therapy in adults with type 2 diabetes',
        ['Type 2 diabetes'],
        ['Diabetes Mellitus, Type 2'],
        'A fictional trial of a glucose-lowering drug in adults with type 2 diabetes.',
      ),
      worked_example: {
        outcome_summary: 'Both reviewers AGREE.',
        teaching_point:
          'The registered condition is type 2 diabetes, a metabolic disease; the Metabolic assignment fits.',
        worked_answers: [
          { reviewer_slot: 1, answer: 'AGREE', reason_code: null, note: null, uncertain: false },
          { reviewer_slot: 2, answer: 'AGREE', reason_code: null, note: null, uncertain: false },
        ],
        reference: {
          final_answer: 'AGREE',
          status: 'CONCORDANT',
          basis: 'BOTH_REVIEWERS',
          rationale: null,
        },
      },
      notices: [NOTICE],
    },
  },
  {
    training_unit_id: 'EX7-02',
    packet: {
      schema_version: '7.0',
      unit: areaUnit('EX7-02', 'CARDIOVASCULAR'),
      trial: trial(
        2,
        'Synthetic radiotherapy schedule for a fictional heart tumour',
        ['Synthetic cardiac tumour'],
        ['Heart Neoplasms'],
        'A fictional trial whose only heading is a neoplasm heading that MeSH also files under C14.',
      ),
      worked_example: {
        outcome_summary: 'Both reviewers DISAGREE (MESH_PLACEMENT_MISLEADING).',
        teaching_point:
          'The Cardiovascular assignment follows from where MeSH files a neoplasm heading, not from the clinical condition.',
        worked_answers: [
          {
            reviewer_slot: 1,
            answer: 'DISAGREE',
            reason_code: 'MESH_PLACEMENT_MISLEADING',
            note: 'Synthetic note: a tumour trial, not a cardiovascular disease trial.',
            uncertain: false,
          },
          {
            reviewer_slot: 2,
            answer: 'DISAGREE',
            reason_code: 'MESH_PLACEMENT_MISLEADING',
            note: 'Synthetic note: the heading sits under C14 only by MeSH placement.',
            uncertain: false,
          },
        ],
        reference: {
          final_answer: 'DISAGREE',
          status: 'CONCORDANT',
          basis: 'BOTH_REVIEWERS',
          rationale: null,
        },
      },
      notices: [NOTICE],
    },
  },
  {
    training_unit_id: 'EX7-03',
    packet: {
      schema_version: '7.0',
      unit: areaUnit('EX7-03', 'RESPIRATORY'),
      trial: trial(
        3,
        'Synthetic targeted therapy in a fictional lung cancer',
        ['Synthetic non-small cell lung cancer'],
        ['Lung Neoplasms'],
        'A fictional trial in a lung cancer; the Respiratory area follows only from the organ where the cancer starts.',
      ),
      worked_example: {
        outcome_summary:
          'AGREE against DISAGREE (ORGAN_OF_ORIGIN_ONLY); the adjudicator adopts Reviewer 2.',
        teaching_point:
          'Under the neoplasm policy a cancer trial counts under Oncology; an organ-system area is not added only because the cancer starts in that organ.',
        worked_answers: [
          { reviewer_slot: 1, answer: 'AGREE', reason_code: null, note: null, uncertain: true },
          {
            reviewer_slot: 2,
            answer: 'DISAGREE',
            reason_code: 'ORGAN_OF_ORIGIN_ONLY',
            note: 'Synthetic note: organ of origin only.',
            uncertain: false,
          },
        ],
        reference: {
          final_answer: 'DISAGREE',
          status: 'DISCORDANT_RESOLVED',
          basis: 'REVIEWER_2',
          rationale: 'Synthetic: the neoplasm policy applies.',
        },
        routed_to_adjudicator: true,
        routing_reason: 'AGREE against DISAGREE',
        disagreement_reason_code: 'POLICY_RULE_INTERPRETATION',
      },
      notices: [NOTICE],
    },
  },
];
