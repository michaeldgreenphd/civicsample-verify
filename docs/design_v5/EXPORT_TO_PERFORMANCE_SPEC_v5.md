# Export-to-performance specification, design v5 (bundle format 5.0)

> Supplied proposed design document, retained for review. It is not investigator approval. Where it allows investigator adjudication, ordinary revisions, or single-review adjudication, the application retains the stricter standing instructions. Formal activation remains blocked pending reconciliation.

Built 2026-10-22. Status: PROPOSED; implemented in `validation/performance_analysis_v5.py` and tested on synthetic bundles only (`validation/test_performance_analysis_v5.py`, `validation/fixtures/make_synthetic_v5_bundle.py`). No clinical review has taken place. The database side is `migrations/0004_v5_trial_label_verification.sql`.

## 1. The bundle

The app writes one bundle per locked reference (PILOT or FORMAL): three CSV files written from three investigator-only export views, plus one manifest. CSV: UTF-8, comma, header row, LF line ends, empty field for SQL NULL, booleans `true`/`false`, timestamps ISO 8601 in UTC.

| Role                  | View                           | One row per                                                                                               | Opens                             |
| --------------------- | ------------------------------ | --------------------------------------------------------------------------------------------------------- | --------------------------------- |
| independent_judgments | `v_tlv5_independent_judgments` | trial x reviewer item (19) x reviewer with a submission                                                   | after the close (PILOT: any time) |
| adjudicated_reference | `v_tlv5_adjudicated_reference` | trial x reviewer item (19)                                                                                | after the lock of that mode       |
| frozen_labels         | `v_tlv5_frozen_labels`         | trial x frozen label (17 required, plus RULE_D and RULE_K where the rule applied), with the design fields | after the lock of that mode       |

Columns, exactly and in this order (the PGlite suite checks the views against these lists, `tests_prebuild/pglite_rls_v5/view_columns_v5.json`):

- independent_judgments: record_category, case_id, mode, nct_id, item_family, item_code, reviewer_slot, reviewer_pseudo_id, answer_initial, answer_effective_preclose, detail_initial, detail_effective, n_revisions_preclose, uncertain, packet_issue_flag, first_submitted_at, last_submitted_at.
- adjudicated_reference: record_category, case_id, mode, item_family, item_code, adjudication_id, reference_answer, reference_detail, adjudication_status, adjudication_basis, n_reviewers_submitted, n_reviewer_answers, disagreement_reason_code, adjudicator_pseudo_id, adjudicator_role, adjudication_blinded, post_unblinding_revision_exists, adjudicated_at, reference_lock_id.
- frozen_labels: label_set_id, record_category, case_id, mode, nct_id, item_family, item_code, label_primary, label_secondary, label_informational, dev_linked_area, label_frozen_at, frame, stratum, variance_stratum, frame_stratum_size, n_sampled_in_stratum, selection_probability, sampling_weight, dev_linked, tier1_eligible, design_version.

Manifest (JSON) keys: export_id, export_format_version ("5.0"), mode, created_at, app_git_sha, db_schema_version ("5.0.0"), is_synthetic_fixture, design_version, adjudication_scope, label_set_id, frozen_at, frozen_case_list_sha256, frozen_label_rows_sha256, formal_phase_opened_at, formal_phase_closed_at, formal_phase_status (CLOSED_COMPLETE or CLOSED_INCOMPLETE; PILOT for a pilot bundle), snapshot_taken_at, snapshot_sha256, snapshot_rows, reference_locked, reference_lock_id, reference_locked_at, rubric_version, rubric_sha256, files (a list of {role, name, sha256, rows}). The app registers the manifest hash with `rpc_tlv5_register_export` (bundle_format_version "5.0"). For a PILOT bundle, frozen_at is the pilot lock time and the two frozen hashes are computed by the app with the procedure below.

## 2. Coding (three states, never collapsed)

| Item family            | Answer scale                                                      | Not shown                           | Explicit "cannot tell"                      |
| ---------------------- | ----------------------------------------------------------------- | ----------------------------------- | ------------------------------------------- |
| AREA (7)               | YES, NO, CONTEXT_DEPENDENT, INSUFFICIENT_INFORMATION              | never (always shown)                | CONTEXT_DEPENDENT, INSUFFICIENT_INFORMATION |
| FIG2_ROW (10)          | YES, NO, INSUFFICIENT_INFORMATION                                 | never                               | INSUFFICIENT_INFORMATION                    |
| SG_DIABETES_TYPE       | TYPE_2, TYPE_1, BOTH_TYPE_1_AND_TYPE_2, OTHER (+ detail), UNCLEAR | NOT_APPLICABLE (row answer not YES) | UNCLEAR                                     |
| SG_NEOPLASM_MALIGNANCY | MALIGNANT, NON_MALIGNANT (+ detail), UNCLEAR                      | NOT_APPLICABLE                      | UNCLEAR                                     |

Reference statuses: CONCORDANT_ADOPTED_BY_RULE, CONCORDANT_CONFIRMED, CONCORDANT_REVISED (ALL_ITEMS scope), DISCORDANT_RESOLVED, SINGLE_REVIEW_ADJUDICATED, UNRESOLVED_ESCALATED (no reference answer), NOT_APPLICABLE_BY_RULE (subgroup item no reviewer was shown; answer NOT_APPLICABLE), NOT_REVIEWED (no reviewer submitted the trial; no reference answer). Concordance compares the answer and the detail code together.

## 3. Checks before anything is computed (the run stops on the first failure; nothing is filtered silently)

1. Manifest: format 5.0, schema 5.0.0, mode FORMAL (PILOT only with `--allow-pilot`), reference locked, a synthetic fixture only with `--allow-synthetic`, known scope, hashes present.
2. Files: present, SHA-256 and row counts equal the manifest; exact columns; one mode and record category; no CAL5- case; FORMAL IDs `TLV5-nnn` (synthetic `TLV5-TESTFX-nnnn`).
3. Frozen labels: one label set equal to the manifest; 17 required labels per trial; label scales; the label-set hash and the case-list hash recomputed from the file equal the freeze values; recorded before the freeze; design constant within a trial; weight = 1 / probability = N_h / n_h; n_h trials per stratum present; tier1_eligible = not dev_linked; one frame and design version.
4. Judgments: 19 items per reviewer and trial; scales and detail codes; area and row items never NOT_APPLICABLE; subgroup items answered exactly when the same reviewer's row answer is YES (initial and effective); two different reviewers; one slot per reviewer; revisions recorded; inside the formal phase; row count equals the snapshot.
5. Reference: 19 rows per trial; statuses, bases, v3 reason codes, detail codes valid; blank answer exactly for UNRESOLVED_ESCALATED and NOT_REVIEWED; FORMAL adjudications by the ADJUDICATOR role and blinded; adjudicator distinct from reviewers; rule rows carry adjudicator RULE; adjudications between the snapshot and the lock; every status consistent with the judgments and the scope.

## 4. Hash procedures (identical in the sampling script, the database and the analysis)

- Case list: SHA-256 of the sorted case IDs joined by LF (code-point order).
- Label row: SHA-256 of `label_set_id|case_id|item_code|label_primary|label_secondary|label_informational` (empty string for NULL).
- Label set: SHA-256 of the row hashes joined by LF, rows ordered by case_id then item_code (code-point order).

## 5. Estimands (definitions identical to the planning simulation, `scripts/v5_design.estimand_vectors`)

The unit is the trial. For pooled area estimands the numerator and denominator are per-trial counts over the seven areas. T0 = Tier 0 label YES; T1 = curated v1.2 label YES; Y = reference YES; D = reference determinate under the denominator rule.

| Code | Estimand                                                                                                                                                                                   |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| E1   | pooled Tier 0 PPV: sum(T0 & Y & D) / sum(T0 & D)                                                                                                                                           |
| E3   | Tier 0 PPV per area                                                                                                                                                                        |
| E4   | pooled Tier 0 sensitivity: sum(T0 & Y & D) / sum(Y & D)                                                                                                                                    |
| E5   | pooled Tier 0 specificity: sum(not T0 & not Y & D) / sum(not Y & D)                                                                                                                        |
| E6   | exact match: all seven Tier 0 labels equal the reference, among trials with seven determinate answers                                                                                      |
| E7   | pooled curated v1.2 PPV, Tier 1-eligible (not development-linked) trials only; PROVISIONAL                                                                                                 |
| E7b  | pooled curated v1.2 PPV, all trials; labelled OPTIMISTIC (development-linked trials included)                                                                                              |
| E8   | rule D agreement: the rule's keep or remove decision equals the clinician's (TYPE_2 or BOTH = keep; TYPE_1 or OTHER = remove); UNCLEAR, NOT_APPLICABLE and unresolved excluded and counted |
| E9   | rule K agreement: MALIGNANT = keep, NON_MALIGNANT = remove; as E8                                                                                                                          |
| E10  | pooled Figure 2 row-label PPV, and per row                                                                                                                                                 |
| E11  | pooled Figure 2 row-label sensitivity (descriptive; not in the precision plan)                                                                                                             |

Denominator rules (from v3, renamed for the YES/NO scale): R0_primary excludes CONTEXT_DEPENDENT, INSUFFICIENT_INFORMATION and unresolved references and counts them; R1 treats CONTEXT_DEPENDENT and INSUFFICIENT_INFORMATION as YES; R2 treats them as NO. Unresolved items are excluded under every rule.

Weighting: design-weighted to the sampling frame recorded in the bundle (the Figure 3 model frame for the formal sample), with `performance_analysis_v3.weighted_ratio_v3` (Hajek ratio, stratified linearization with finite population correction, Wilson interval at the effective size capped at the unweighted domain count). Weight = N_h / (trials reviewed in stratum h): a within-stratum nonresponse adjustment that equals the design weight when every sampled trial was reviewed. An estimate with fewer than 10 trials in its domain is reported as not estimable (the v3 threshold). Unweighted sample counts are reported beside every estimate and describe the sample only.

Reviewer agreement (raw agreement and Cohen's kappa per item, effective and initial answers; subgroup items among trials where both reviewers were shown the item) is reported as consistency between two clinicians, never as validation.

## 6. Outputs and refusals

`performance_results_v5.json` and `performance_estimates_v5.csv`; with `--template clinical_review_results_template_v5.md`, a manuscript block and its slot trace. Every slot is filled from a computed value or the run stops (MissingResultError). Synthetic and pilot results carry "SYNTHETIC OR PILOT TEST OUTPUT. NOT STUDY RESULTS." The run never overwrites an existing output file.

## 7. Not estimable by design

1. Curated v1.2 accuracy on Tier 1-eligible trials when fewer than 10 eligible trials enter the domain (expected, because most frame trials carry a development-linked unit).
2. Per-area and per-row estimates whose domain has fewer than 10 sampled trials.
3. The labels on the mixed-sex trials of the supplementary threshold models outside the sampling frame.
4. Anything from pilot or calibration records.
