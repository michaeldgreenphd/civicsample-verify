# Blinded review rubric and adjudication procedure, design v5.1 (DRAFT, not frozen)

> Supplied proposed design document, retained for review. It is not investigator approval. Where it allows investigator adjudication, ordinary revisions, or single-review adjudication, the application retains the stricter standing instructions. Formal activation remains blocked pending reconciliation.

Built 2026-10-22. Design v5 replaces the descriptor-level design v4 for the clinician review: clinicians verify, trial by trial, the therapeutic-area labels that the manuscript uses. Version 5.1 (migration `0005_v5_training_examples.sql`) applies two investigator decisions of 2026-10-22: the packet shows the trial's NCT identifier, and the reviewers train on three worked examples before the formal review (sections 4, 5, 10 and 13). Status: DRAFT. Nothing is frozen, no reviewer has been invited, and no clinical review has taken place. The Tier 0 labels are the parent MeSH categories used in the analysis; the curated v1.2 labels (Tier 1) are PROVISIONAL [PENDING CLINICAL REVIEW]. Agreement between AI stages is consistency, not validation. The formal review begins only after the investigator approves this rubric, the sampling design, the blinding tests and the functionality pilot. Changes from v4 and from v5.0 are listed in section 14.

## 1. What is verified

The unit is one registered trial. For each sampled trial, two clinicians answer, independently and without seeing any label:

1. the seven therapeutic-area questions that correspond to the area labels in the analysis (oncology, cardiovascular, mental health, infectious, metabolic, neurological, respiratory; areas are non-exclusive);
2. the ten Figure 2 condition-row questions (Neoplasms, Diabetes Mellitus, Depression, Obesity, Asthma, Pulmonary Disease Chronic Obstructive, COVID-19, Schizophrenia, Hypertension, Pain);
3. two subgroup questions, each shown only when the clinician's own answer to the matching row is YES: the diabetes type (rule D) and whether the neoplasm studied is malignant (rule K).

Areas (step 1) are the primary verification. Condition rows and subgroups are secondary. Subcategories of an area are not asked; they are recorded only through the condition rows and subgroups.

## 2. Decisions the investigator makes before the freeze

1. Construct (section 11). PROPOSED default: the clinical therapeutic-area construct with the investigator's OQ-01, OQ-03 and OQ-04 policies shown verbatim. Alternative: a MeSH-literal construct ("does a condition studied fall in this MeSH category?"), which verifies the mapping mechanics but not the clinical meaning of the labels. The default changes what a Tier 0 label "means" for cancer trials that also carry an organ-system label; the projected consequence is in `SAMPLING_DESIGN_v5.md` (private).
2. DECIDED (investigator, 2026-10-22): the packet shows the trial's NCT identifier as text, without a registry link (section 5). Reviewers are asked not to look a trial up; a reviewer who opens the registry record sees enrollment, the sex of participants and posted results (section 13).
3. Adjudication scope (section 9). PROPOSED default DISAGREEMENTS_ONLY, as the investigator decided for the small sample; alternative ALL_ITEMS (the adjudicator also confirms concordant items; more adjudicator time).
4. Approval of the subgroup display rule (section 7): a subgroup question appears when the reviewer's OWN row answer is YES, never because the trial is in the frozen row, so the display reveals no label.
5. Whether to run the rubric calibration exercise (section 10) on the six proposed calibration trials.
6. Whether the reviewers' training view shows the adjudicated outcome of worked example 3 (section 10). PROPOSED default: show it after the reviewer's own practice answer. Alternative: show the disagreement and the queue only, so the formal review also measures whether reviewers apply the neoplasm policy unaided.
7. The rubric text itself, which is hashed at the freeze.

## 3. Roles and access

| Role                                               | Accounts                                    | Can                                                                                                                                                                                | Cannot                                                                                         |
| -------------------------------------------------- | ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Reviewer 1, Reviewer 2 (REVIEWER, FORMAL)          | two, pseudonyms R-XXXX                      | read the packets of their assigned trials; submit and revise their own answers until the close                                                                                     | see any label, design field, the other reviewer's answers, any adjudication, any export        |
| Adjudicator (ADJUDICATOR)                          | one, a third clinician who reviews no trial | after the close and the snapshot, read both reviewers' answers and the packets; record adjudications                                                                               | see any label, design field or export; adjudicate before the close; review trials              |
| Investigators (INVESTIGATOR, multi-factor session) | two                                         | import trials, design rows and labels; activate, freeze, open, close, snapshot, lock; read completion counts while open; read judgments after the close and exports after the lock | enter or edit any FORMAL judgment or adjudication; read FORMAL answers while the phase is open |
| Pilot test accounts (REVIEWER, PILOT)              | two                                         | run the synthetic pilot                                                                                                                                                            | take a calibration, training or formal trial                                                   |

No account holds two roles. The database enforces every row of this table (row-level security, triggers and the RPC functions of `migrations/0004_v5_trial_label_verification.sql`).

## 4. Record categories and identifiers

| Category                  | Prefix                                               | Mode        | Enters the analysis                                       |
| ------------------------- | ---------------------------------------------------- | ----------- | --------------------------------------------------------- |
| SYNTHETIC_PILOT           | SYN- (for example SYN-TLV5-001; trials SYN-NCT-0001) | PILOT       | never (pipeline dry run only)                             |
| RUBRIC_CALIBRATION        | CAL5-                                                | CALIBRATION | never; never exported                                     |
| TRAINING_EXAMPLE          | EX5- and two digits (EX5-01 to EX5-03)               | TRAINING    | never; never exported; closes when the formal phase opens |
| LABEL_VERIFICATION_FORMAL | TLV5- (three digits)                                 | FORMAL      | yes, the only category                                    |

A record never changes category. Calibration closes at the freeze; training closes when the formal phase opens. A trial used as a calibration case or a training example can never be a formal case, and the reverse (the database refuses the import). Case identifiers carry no stratum information (they are ordered by a keyed hash).

## 5. What reviewers see

Instructions (every session): the task; the answer options; the three-state rule; that areas are non-exclusive; the uncertainty flag, note and packet-problem fields; the "what you will not see" paragraph.

Rubric (one click away): the seven construct definitions from `CLINICAL_ONTOLOGY.yaml` (`intended_construct`, verbatim); the general policies on comorbidity, complications and trial-level context; the OQ policies (section 11); the condition-row definitions; the subgroup definitions (section 7). No rule ID, no MeSH root code, no statement of the Tier 0 rule.

Trial packet (the allow-list is enforced by the database): the NCT identifier (text, no link), brief title, official title, registered conditions, condition MeSH headings as listed by the registry (names only, no tree numbers), brief summary, interventions (type, name, description), eligibility age range. The packet carries no registry address or link, no enrollment, no eligibility sex, no participant counts, no results and no label. Reviewers are asked not to look a trial up in the registry or elsewhere.

Registry text is shown as registered. A brief summary may mention the sex of the population (for example "women with breast cancer"); the text is not edited, because editing would change what the trial says.

## 6. What reviewers never see

1. Any frozen label: Tier 0, curated v1.2 or v1.1, Figure 2 row membership, the rule D or rule K outcome.
2. The sampling design: frame, stratum, selection probability, weight, development flags.
3. AI outputs of any stage, rationales, prompts, decision files.
4. The other reviewer's answers, notes or progress; any adjudication.
5. Outcome-related fields: enrollment, sex counts, female shares, PPR values, results sections, model estimates.
6. Study files, preprints or slides reporting classifications; reviewers have no repository access.

## 7. Questions and answer options

| Item                                                             | Question                                                                         | Options                                                                                                                                                                               |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AREA_ONCOLOGY ... AREA_RESPIRATORY (7)                           | Does this trial belong to the [area] therapeutic area, as defined in the rubric? | YES, NO, CONTEXT_DEPENDENT, INSUFFICIENT_INFORMATION                                                                                                                                  |
| FIG2_ROW_CAN_ALL ... FIG2_ROW_PAIN (10)                          | Does this trial study [condition]?                                               | YES, NO, INSUFFICIENT_INFORMATION                                                                                                                                                     |
| SG_DIABETES_TYPE (shown only after FIG2_ROW_DIAB = YES)          | Which diabetes does the trial study?                                             | TYPE_2, TYPE_1, BOTH_TYPE_1_AND_TYPE_2, OTHER (detail required: PREDIABETES, GESTATIONAL, LADA_OR_AUTOIMMUNE, MONOGENIC_OR_SECONDARY, DIABETES_NOT_STUDIED, OTHER_SPECIFIED), UNCLEAR |
| SG_NEOPLASM_MALIGNANCY (shown only after FIG2_ROW_CAN_ALL = YES) | Is the neoplasm studied malignant?                                               | MALIGNANT, NON_MALIGNANT (detail required: PRECANCEROUS, BENIGN_NEOPLASM, NOT_A_NEOPLASM, OTHER_SPECIFIED), UNCLEAR                                                                   |

Every item also takes an uncertainty flag and a note; OTHER_SPECIFIED requires a note. A submission is accepted only when it answers all 17 area and row items, and each subgroup item exactly when the matching row answer is YES.

Three states, never collapsed: (1) an answer is recorded; (2) the reviewer records explicitly that the packet cannot decide (CONTEXT_DEPENDENT, INSUFFICIENT_INFORMATION, UNCLEAR); (3) the item was not shown (a subgroup item after a row answer other than YES), exported as NOT_APPLICABLE. A reference item that stays unresolved after adjudication, and a trial that no reviewer submitted (NOT_REVIEWED), are kept apart from all three.

## 8. Order and independence

Each reviewer receives the 100 trials in a reviewer-specific random order (keyed hash of the recorded seed, the reviewer pseudonym and the case ID). Reviewers work alone and do not discuss trials; technical and packet questions go to the investigator and are logged. A reviewer may revise an answer until the formal phase closes; the database keeps the first submission and every revision, and the export carries the initial and the effective answer.

## 9. Adjudication

1. Adjudication opens only after the formal phase closes AND the investigator has taken the snapshot of the independent judgments. No interim looks.
2. Scope (PROPOSED default DISAGREEMENTS_ONLY): an item enters the reference by rule when both reviewers gave the same answer and the same detail code (CONCORDANT_ADOPTED_BY_RULE). The adjudicator resolves every item where the answers or the detail codes differ (DISCORDANT_RESOLVED, with a reason code from the v3 list: CONSTRUCT_BOUNDARY, POLICY_RULE_INTERPRETATION, MESH_PLACEMENT_MISLEADING, TRIAL_CONTEXT, PACKET_INSUFFICIENT, MULTILABEL_OR_CROSS_AREA, OTHER) and every item that only one reviewer answered (SINGLE_REVIEW_ADJUDICATED). An item the adjudicator cannot resolve is UNRESOLVED_ESCALATED. A subgroup item that no reviewer was shown is NOT_APPLICABLE by rule.
3. Only the ADJUDICATOR role adjudicates FORMAL items. The database refuses a FORMAL adjudication by an investigator, and by anyone assigned to review the trial.
4. The adjudicator sees both reviewers' answers, detail codes, notes and uncertainty flags beside the packet and the rubric, and never a label or design field.
5. When the adjudicator resolves a condition row as NO, the matching subgroup item is decided NOT_APPLICABLE; when a row is resolved YES and only one reviewer answered the subgroup, the adjudicator decides the subgroup.
6. The investigator locks the reference when every item that the scope requires has a blinded adjudication. The export views open only after the lock.
7. After the lock, any change is a new adjudication flagged post-unblinding. The primary reference is the last blinded adjudication; post-unblinding rows are reported, never substituted.
8. The reference is the adjudicated judgment of the clinicians who took part, under the frozen rubric. It is not a validated gold standard for all trials.

## 10. Synthetic pilot and rubric calibration

Synthetic pilot (SYN-): ten fictional trials (`SYNTHETIC_PILOT_CASES_v5.csv`), two pilot test accounts, one planted disagreement, adjudication, the pilot lock, the pilot export and a dry run of `validation/performance_analysis_v5.py --allow-pilot`. The v5 pilot sign-off gates design activation and FORMAL reviewer enrolment. Pilot data never enter any statistic.

Rubric calibration (CAL5-, optional, PROPOSED): before the freeze, the two formal reviewers may answer up to six calibration trials drawn from the frame outside the sample, and discuss how the rubric applies with the investigator. Discussion covers the construct and the rubric, never a label. Calibration answers are stored apart, are never exported and never enter the analysis. Rubric edits after calibration produce a new rubric version before the freeze.

Worked training examples (EX5-, TRAINING, investigator decision of 2026-10-22): three registered trials from the Figure 3 frame, outside the 100-trial sample and outside the calibration trials, show the form and the adjudication. Example 1 is a clear single-area trial with a sub-label; in example 2 the two reviewers agree on a single-area cancer trial; in example 3 they disagree on one area, and the item goes to the adjudicator. The private file `WORKED_EXAMPLES_v5.md` holds the packets, the two completed forms, the queue item and the adjudication, written by the study team as illustrations (no clinician's judgment). In staging, the examples are seeded with test accounts and example 3 runs through the adjudicator queue end to end. Before the formal phase opens, the formal reviewers may practise on the three trials; a worked answer is shown to a reviewer only after that reviewer's own practice answer. Training answers and adjudications are never exported and never analysed; the database refuses training work once the formal phase opens. A clarification adopted from the training enters the rubric text before the freeze.

## 11. Construct and ontology policies shown to reviewers (PROPOSED default)

Reviewers see the area definitions (`intended_construct`) and the investigator's policy text verbatim, without rule IDs:

1. Neoplasms (OQ-01): "Classify trials targeting neoplasms under Oncology. Do not add organ-system classifications merely because a cancer originates in that organ. Permit additional therapeutic areas when there is a separate, explicitly investigated clinical indication."
2. Depression (OQ-03): "Include Depression under Mental Health when depressive symptoms or depression are the clinical target, without assuming every trial is a major depressive disorder trial."
3. Smoking cessation (OQ-04): "Include smoking cessation under Mental Health when the trial investigates tobacco dependence, addiction, or a clinically defined substance-use disorder. Do not automatically classify general cessation or prevention interventions as mental-health trials."

Under OQ-01, a lung cancer trial is an oncology trial and, unless a separate respiratory indication is investigated, not a respiratory trial; the Tier 0 rule labels it both. Verification under this construct therefore measures how far the labels in the analysis carry the clinical meaning the manuscript gives them. The alternative (MeSH-literal) construct would show that the mapping works as written, and little more.

## 12. Freeze sequence

1. Investigator decisions in section 2 applied; rubric text rebuilt; SHA-256 recorded.
2. v5 pilot completed, adjudicated, locked, exported and signed off; blinding and integrity tests pass on the live database (`PILOT_ACCEPTANCE_CHECKLIST_v5.md`).
3. Design v5 activated (design v4 can no longer be activated).
4. Formal reviewers enrolled; optional calibration; training on the worked examples (preferably before the freeze, so that a clarification can still enter the rubric).
5. The 100 trials, their design rows and the frozen labels imported; the investigator freezes. The database records the case-list hash and the label-set hash (the procedure of `scripts/03_draw_sample_v5.py`), and refuses any new trial, design row or label afterwards.
6. Formal phase opened; assignments; review; close; snapshot; adjudication; lock; export.

## 13. Residual leakage risks and mitigations

| Risk                                                                                                        | Direction                      | Mitigation                                                                                                                                                         |
| ----------------------------------------------------------------------------------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Condition MeSH headings let a MeSH-literate reviewer infer the Tier 0 label                                 | favours Tier 0                 | headings are registry information a clinician would use; no tree numbers, roots or rule are shown                                                                  |
| The NCT identifier lets a reviewer open the registry record, which shows enrollment, sex and posted results | either                         | identifier shown as text, no link; reviewers instructed not to look trials up; residual risk recorded (investigator decision of 2026-10-22)                        |
| Worked examples teach how the adjudicator reads a policy (example 3: the neoplasm policy)                   | favours the rubric's construct | examples outside the sample; worked answers shown only after the reviewer's own practice answer; the investigator may hide example 3's outcome (section 2, item 6) |
| Construct definitions and OQ policies underlie the curated v1.2 rules                                       | favours Tier 1                 | intended: the reference is the investigator-approved construct; Tier 1 estimates are reported apart and flagged optimistic where development-linked                |
| The subgroup display reveals a label                                                                        | favours Tier 0                 | display keyed on the reviewer's own row answer, enforced by the database                                                                                           |
| Adjudicator exposure                                                                                        | either                         | third clinician; row-level security; adjudication only after the close and the snapshot                                                                            |
| Calibration discussion reveals labels                                                                       | either                         | calibration trials are outside the sample; discussion of the rubric only; never analysed                                                                           |

## 14. Changes from REVIEW_RUBRIC_v4.md

1. The unit is the trial, not the descriptor-area pair; the questions verify the labels the manuscript uses (7 areas, 10 condition rows, 2 subgroups).
2. Development-linked trials are not excluded: the Tier 0 rule was never tuned on trials. Curated v1.2 (Tier 1) estimates use Tier 1-eligible trials, or are flagged optimistic.
3. Packets carry no NCT identifier, no registry link, no enrollment and no eligibility sex (the v4 rubric listed eligibility sex and enrollment for step 2; the 0002 packet guard and the scientific contract exclude them, and v5 follows the guard).
4. Prefixes SYN-, CAL5-, TLV5-; a v5 pilot with its own sign-off; FORMAL adjudication by the ADJUDICATOR role only.
5. Concordance compares the answer and the detail code together.

Changes in v5.1 (from `REVIEW_RUBRIC_v5.md`, migration 0005):

1. The packet shows the NCT identifier as text, without a link (section 2, item 2 decided; sections 5 and 13). The scientific contract's packet item for step 2 (`CLAUDE_CODE_SCIENTIFIC_CONTRACT.md`, 6.3) also lists the registry link, study type, primary purpose, phase, keywords and primary outcome titles; v5.1 follows the investigator's list of 2026-10-22, which omits them. The contract needs a revision to match.
2. A fourth record category, TRAINING_EXAMPLE (EX5-, mode TRAINING), for the worked examples (sections 4 and 10).
3. Overlap guards: a calibration or training trial cannot be a formal trial, and the reverse.
4. A new investigator decision (section 2, item 6) and a training step in the freeze sequence (section 12).
