# Reviewer rubric, review design v7 (mapping units)

For Reviewer 1 and Reviewer 2 (both answer every unit) and for the adjudicator (tie-breaker only).

## 1. What you see and what you answer

Each screen is one unit: one registered trial (its NCT ID, a link to its own ClinicalTrials.gov record, titles,
registered conditions, condition MeSH headings, brief summary, detailed description when the registry has one,
interventions and eligibility ages) and ONE mapping with our assignment, for example "Therapeutic area: Respiratory ...
in this area". You answer one question: is our assignment right for this trial?

- AGREE: the assignment fits the condition the trial studies, as the registry describes it.
- DISAGREE: it does not. Choose the reason code that fits best (section 4) and write a short note; the app refuses a
  DISAGREE without both.
- CANNOT_TELL: the registry text does not let you decide. Use it sparingly; a note helps the adjudicator.
- Uncertain: tick it with any answer when you answer but are not sure.

Judge the trial in front of you only. Registry text is shown as registered: it may name another registry or another
trial (for example a parent study); that does not change the question.

You can revise an answer until the review closes; the first answer and the last one are both kept.

## 2. Areas (56 units)

- Oncology: parent MeSH category C04 Neoplasms
- Cardiovascular: parent MeSH category C14 Cardiovascular Diseases
- Mental health: MeSH F03 Mental Disorders, and the heading Depression (D003863) by the study rule
- Infectious: parent MeSH category C01 Infections
- Metabolic: parent MeSH category C18 Nutritional and Metabolic Diseases
- Neurological: parent MeSH category C10 Nervous System Diseases
- Respiratory: parent MeSH category C08 Respiratory Tract Diseases

Mental health: the study rule counts the MeSH heading Depression (D003863) as Mental health, although MeSH files it
under F01 Behavior and Behavior Mechanisms. A unit assigned Mental health only through that heading shows the note:
"The trial's MeSH heading Depression is counted as Mental health by the study rule; MeSH files it under Behavior." Judge it like any other unit.

Neoplasm policy (OQ-01): trials of neoplasms count under Oncology; an organ-system area is not added only because the
cancer starts in that organ (reason ORGAN_OF_ORIGIN_ONLY). Depression policy text (OQ-03) and smoking cessation policy
text (OQ-04) are pending (gates G-OQ-03 and G-OQ-04); the investigator adds them before the pilot.

## 3. Figure 2 condition rows (40 units)

- Neoplasms
- Diabetes Mellitus
- Depression
- Obesity
- Asthma
- Pulmonary Disease, Chronic Obstructive
- COVID-19
- Schizophrenia
- Hypertension
- Pain (descriptive row)

## 4. Reason codes

| unit shows | reason codes on DISAGREE |
|---|---|
| AREA IN_AREA | ORGAN_OF_ORIGIN_ONLY, NOT_THE_CONDITION_STUDIED, MESH_PLACEMENT_MISLEADING, RUBRIC_POLICY_EXCLUDES, OTHER_SPECIFIED |
| ROW IN_ROW | NOT_THE_CONDITION_STUDIED, MESH_PLACEMENT_MISLEADING, OTHER_SPECIFIED |
| SG D1_KEEP_TYPE2 (type 2 diabetes) | TYPE_1_ONLY, OTHER_DIABETES_TYPE, PREDIABETES_ONLY, DIABETES_NOT_STUDIED, OTHER_SPECIFIED |
| SG D4A_KEEP_UNRESOLVED_PARENT_ONLY (diabetes, type not stated in the registry headings) | TYPE_2_STATED, TYPE_1_ONLY, OTHER_DIABETES_TYPE, PREDIABETES_ONLY, DIABETES_NOT_STUDIED, OTHER_SPECIFIED |
| SG D4B_KEEP_UNRESOLVED_COMPLICATION_ONLY (diabetes, type not stated in the registry headings) | TYPE_2_STATED, TYPE_1_ONLY, OTHER_DIABETES_TYPE, PREDIABETES_ONLY, DIABETES_NOT_STUDIED, OTHER_SPECIFIED |
| SG D2_REMOVE_OTHER_TYPE (type 1, gestational or another specified type of diabetes, with no type 2 heading) | TYPE_2_STUDIED, TYPE_NOT_DETERMINABLE, OTHER_SPECIFIED |
| SG D3_REMOVE_PREDIABETES_ONLY (prediabetes only, with no diabetes mellitus heading) | DIABETES_STUDIED, OTHER_SPECIFIED |
| SG K_KEEP_MALIGNANT_COMPATIBLE (malignant neoplasm, counted in the Neoplasms row) | BENIGN_NEOPLASM, PRECANCEROUS, NOT_A_NEOPLASM, OTHER_SPECIFIED |
| SG K_KEEP_HEURISTIC_NONMALIGNANT_CLASS (malignant neoplasm, counted in the Neoplasms row) | BENIGN_NEOPLASM, PRECANCEROUS, NOT_A_NEOPLASM, OTHER_SPECIFIED |
| SG K_REMOVE_VERIFIED_NONMALIGNANT (non-malignant condition only (every neoplasm heading is a cyst, hamartoma or precancerous condition)) | MALIGNANT_NEOPLASM_STUDIED, OTHER_SPECIFIED |

| reason code | meaning |
|---|---|
| ORGAN_OF_ORIGIN_ONLY | the area follows only from the organ where a cancer starts (neoplasm policy) |
| NOT_THE_CONDITION_STUDIED | the condition behind the assignment is not what the trial studies |
| MESH_PLACEMENT_MISLEADING | the assignment follows from where MeSH files a heading, not from the clinical condition |
| RUBRIC_POLICY_EXCLUDES | a rubric policy excludes this area for this trial |
| OTHER_SPECIFIED | another reason, written in the note |
| TYPE_1_ONLY | the trial studies type 1 diabetes only |
| OTHER_DIABETES_TYPE | another diabetes type (for example gestational, monogenic or secondary) |
| PREDIABETES_ONLY | the trial studies prediabetes only |
| DIABETES_NOT_STUDIED | the trial does not study diabetes |
| TYPE_2_STATED | the registry text states type 2 diabetes although the headings do not |
| TYPE_2_STUDIED | the trial studies type 2 diabetes, so it belongs in the Diabetes Mellitus row |
| TYPE_NOT_DETERMINABLE | the diabetes type cannot be decided from the registry, so the trial should stay in the row as type not stated |
| DIABETES_STUDIED | the trial studies diabetes, not only prediabetes |
| BENIGN_NEOPLASM | the neoplasm studied is benign |
| PRECANCEROUS | the condition studied is precancerous |
| NOT_A_NEOPLASM | the condition studied is not a neoplasm |
| MALIGNANT_NEOPLASM_STUDIED | the trial studies a malignant neoplasm, so it belongs in the Neoplasms row |

## 5. Subgroup units (4 units, shown after every other unit)

A subgroup unit restates its parent row and shows what our rule did with the trial. KEEP means the rule kept the trial
in the row; REMOVE means the rule removed it. AGREE means the outcome shown is right for this trial; DISAGREE with a
REMOVE outcome means the trial belongs in the row.

| stratum | outcomes | screen text | decision shown | text status |
|---|---|---|---|---|
| Rule D kept | D1_KEEP_TYPE2; D4A_KEEP_UNRESOLVED_PARENT_ONLY; D4B_KEEP_UNRESOLVED_COMPLICATION_ONLY | type 2 diabetes; diabetes, type not stated in the registry headings | KEEP: kept in the Diabetes Mellitus row | approved (decision 20) |
| Rule D removed | D2_REMOVE_OTHER_TYPE; D3_REMOVE_PREDIABETES_ONLY | type 1, gestational or another specified type of diabetes, with no type 2 heading; prediabetes only, with no diabetes mellitus heading | REMOVE: removed from the Diabetes Mellitus row | PROPOSED (gate G-TEXT-01) |
| Rule K kept | K_KEEP_MALIGNANT_COMPATIBLE; K_KEEP_HEURISTIC_NONMALIGNANT_CLASS | malignant neoplasm, counted in the Neoplasms row | KEEP: kept in the Neoplasms row | approved (decision 20) |
| Rule K removed | K_REMOVE_VERIFIED_NONMALIGNANT | non-malignant condition only (every neoplasm heading is a cyst, hamartoma or precancerous condition) | REMOVE: removed from the Neoplasms row | PROPOSED (gate G-TEXT-01) |

Rule K removes a trial only when every neoplasm heading is on the verified non-malignant list (MeSH C04.182 Cysts,
C04.445 Hamartoma, C04.834 Precancerous Conditions).

## 6. Adjudication (tie-breaker only)

A unit goes to the adjudicator only when one reviewer answers AGREE and the other DISAGREE, or exactly one answers
CANNOT_TELL. Two identical answers enter the reference by rule; two CANNOT_TELL answers make the final answer
CANNOT_TELL by rule. The adjudicator sees our assignment, both answers, reason codes, notes and uncertainty flags, and
records AGREE or DISAGREE with a basis (the reviewer whose answer is adopted, or neither), or marks the unit unresolved.

## 7. Worked examples (read-only training, outside every total)

EX7-01 (Metabolic area, heading Diabetes Mellitus, Type 2): both reviewers AGREE. EX7-02 (Cardiovascular area through
a neoplasm heading filed under C14): both DISAGREE, MESH_PLACEMENT_MISLEADING. EX7-03 (Respiratory area through a lung
cancer heading): AGREE against DISAGREE (ORGAN_OF_ORIGIN_ONLY); the adjudicator adopts Reviewer 2 under the neoplasm
policy. Nothing is answered on a training screen; an optional acknowledgment records when you read them.

## 8. What the result means

The review measures clinician confirmation of displayed assignments: the share of our assigned mappings that clinicians
confirm after seeing them. It is not a positive predictive value or an accuracy, and it is not a proven bound on
either, because reviewers see our assignment. It cannot detect mappings we missed, because the review shows assigned
mappings only. Limitations stated with the results: the Depression (D003863) exception to MeSH placement, with the
MeSH-only rule as a sensitivity analysis (decision 37); assigned-only sampling; registry text as the only evidence.
