# Mapping confirmation — synthetic implementation (2026-10-22)

This module implements the investigator's latest decisions ([REVIEW_WORKFLOW_DECISIONS.md](REVIEW_WORKFLOW_DECISIONS.md)) as a distinct review mode with its own typed data and export contract. It is built and tested with synthetic fixtures only. No real trial, registry text, assignment, worked example, reviewer answer or person is in this repository, and the public application cannot import evaluation records.

## Review design encoded here

- **Unit:** one trial-to-condition mapping (`mc_cases`), not a trial with a questionnaire. The target of 100 mappings across the ten PPR-figure conditions is recorded as the `EVALUATION` record category; its import is disabled in the application until the scientific items below are approved.
- **What the reviewer sees:** the trial title, the brief summary from the registry/AACT source record, the condition, and the **existing assignment under review** (`assignment.assigned`, `assignment_source`, `assignment_version`). A missing summary is shown as missing (`brief_summary.present = false`) and nothing is generated or substituted; the database refuses a "missing" summary that carries text. An optional detailed description is shown collapsed, only with `source_field` provenance, and its scientific inclusion is pending. No registry link is added; the evidence is refused if it contains a registry address or URL. The trial reference is shown once, as text.
- **What the reviewer never sees:** model reasoning, unrelated predictions, labels, counts, sampling fields, or the other reviewer's answer. The evidence and assignment objects are allow-listed at the database boundary; any other key, and any nested key that looks like a prediction, rationale, label, weight, participant or reviewer field, is refused on import.
- **Answer:** `YES` / `NO` with an annotation (required for `NO`), plus `INSUFFICIENT_INFORMATION`, which requires an annotation and is recorded as `rubric_addition_proposed = true`. It is never counted as an approval; the adjudicator reviews it (`RUBRIC_ADDITION_REVIEWED` or `UNRESOLVED_ESCALATED`).
- **Independence and finality:** two reviewer slots per mapping; one immutable final response per assignment; row-level security hides every other reviewer's rows; the investigator reads counts only while the campaign is open.
- **Adjudication:** a separate `ADJUDICATOR` account, after both final submissions **and** after the investigator closes the campaign and authorizes adjudication; concordant mappings are not adjudicated; one adjudication per mapping; the adjudicator cannot adjudicate a mapping they reviewed; the investigator cannot enter a judgment through any path.
- **Provenance on every response:** `review_mode = MAPPING_CONFIRMATION`, `assignment_visibility = EXISTING_ASSIGNMENT_VISIBLE`, the displayed assignment hash, the displayed evidence hash and version, the rubric version and hash, the application build commit and the time. A response whose hashes do not match the mapping on record is refused.
- **Separation from v4/v5:** no v4/v5 table, migration or view is altered. Training examples (`TRAINING_EXAMPLE`) never export. The export carries no sampling probability, weight or label column, and the manifest states that no accuracy statistic is computed until an analysis specification for this mode is approved. The v4/v5 accuracy calculations are not reused.

The label for the workflow is "Mapping confirmation". It is not described anywhere as a blinded clinical reference assessment.

## Proposed ten-condition list (approval pending)

Identified from the PPR condition summary table of the primary v5 analysis (`ppr_condition_summary_v5.csv`, tables dated 2026-10-20; the v5.1 table dated 2026-10-21 lists the same ten rows). The application stores this list as condition set `CONDSET-PPR-FIG2-v5.1-PROPOSED` with status `PROPOSED`. Benchmark values are not copied into this repository.

| Code      | Label in figure data                   | Benchmark comparison | Notes                                                                                                                                |
| --------- | -------------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `OBE`     | Obesity                                | yes                  |                                                                                                                                      |
| `AST`     | Asthma                                 | yes                  |                                                                                                                                      |
| `HTN`     | Hypertension                           | yes                  |                                                                                                                                      |
| `DEP`     | Depression                             | yes                  |                                                                                                                                      |
| `DIAB`    | Diabetes Mellitus                      | yes                  |                                                                                                                                      |
| `COV`     | COVID-19                               | yes                  |                                                                                                                                      |
| `SCZ`     | Schizophrenia                          | yes                  |                                                                                                                                      |
| `CAN_ALL` | Cancer & Neoplasms (All)               | yes                  | The revision decision list relabels this row "Neoplasms"; the application uses "Neoplasms" and keeps the code `CAN_ALL`.             |
| `COPD`    | Pulmonary Disease, Chronic Obstructive | yes                  |                                                                                                                                      |
| `PAIN`    | Pain                                   | **no**               | No compatible benchmark; shown as female share only (marked `NOT_ESTIMABLE`). Ten figure rows versus nine regression/benchmark rows. |

Discrepancies to resolve before the evaluation sample is defined:

1. **Pain.** The figure shows ten conditions but the benchmark comparison has nine. The earlier Pain exclusion and the later decision to show it as female share only mean that whether Pain mappings belong in the 100 is an explicit investigator decision. The application accepts `PAIN` as a condition code so that either decision can be represented, and flags it as `FEMALE_SHARE_ONLY` in the investigator console.
2. **Neoplasms label.** The figure data row is "Cancer & Neoplasms (All)"; the decision list renames it "Neoplasms". The application shows "Neoplasms"; confirm which label the frozen condition set uses.
3. **Figure numbering.** The PPR figure was renumbered in the revision; the condition set id refers to "FIG2" as the current numbering and must be confirmed.
4. **Sampling frame and controls.** Reviewing only currently positive mappings assesses the correctness of those mappings and cannot by itself establish sensitivity or specificity. The `assignment.assigned = false` representation exists so negative/control mappings can be added if the investigator defines them. No sampling probabilities are fabricated and no trial-level weights are transplanted onto mapping units.
5. **Therapeutic-area assessment.** Desired as a secondary assessment; its unit and allocation are not specified. Nothing in this module adds therapeutic-area items to the primary denominator.

## Training examples

The three real worked examples were supplied for the older trial-level design (a 19-item questionnaire per trial). Their compatibility with mapping units is not documented, and they hold real registry identifiers, so they are not loaded. The application ships three **synthetic** training mappings (`MC-TRN-001` to `MC-TRN-003`) with scripted walkthroughs that are rendered from source constants, stored nowhere in the database, labelled synthetic on screen, and never attributed to any account: a concordant Yes, a disagreement resolved by the adjudicator, and a concordant Insufficient information. The disagreement and adjudication path itself is exercised with the synthetic pilot mappings (`MC-SYN-011`, `MC-SYN-012`) in the automated tests and the browser run. Adapting the real examples needs: (a) a decision on which condition row each example maps to, (b) their evidence rebuilt from the registry fields (not the questionnaire packets), and (c) an import run on a private database, never in this repository.

## Data contract (migration 0016)

Additive migration `migrations/0016_mapping_confirmation.sql` (numbered after the PR #4 review-fix migration 0015), schema marker `6.0.0-mapping-confirmation`. Tables are append-only and audited; responses and adjudications are audited as identifiers and a hash only.

| Object                                                    | Purpose                                                                                                                                                                                                         |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mc_campaign`, `mc_campaign_events`                       | One campaign; phases `OPEN → CLOSED → ADJUDICATION → LOCKED` by investigator attestation; review mode, assignment visibility, condition set id/status, rubric version/hash are immutable.                       |
| `mc_cases`                                                | Mapping units: `case_id` (`MC-SYN-`, `MC-TRN-`, `MC-EVAL-`), `record_category`, `trial_ref`, `condition_code` (ten codes), `assignment` and `evidence` JSON with trigger-computed SHA-256 hashes and a version. |
| `mc_assignments`                                          | Reviewer slot 1/2, seeded queue order; PILOT-scope reviewers take synthetic mappings only.                                                                                                                      |
| `mc_responses`                                            | One final response per assignment with full provenance; refused after the close.                                                                                                                                |
| `mc_adjudications`                                        | One per mapping; `ADJUDICATOR` only; phase `ADJUDICATION`; both finals required; disagreements or proposed rubric additions only.                                                                               |
| `mc_exports`                                              | Registered exports (hashes, counts, build commit), after the lock only.                                                                                                                                         |
| `v_mc_my_queue`, `v_mc_adjudication_queue`, `v_mc_export` | Reviewer queue; complete mappings for the adjudicator (empty before authorization); typed export rows for the investigator after the lock, excluding training examples.                                         |
| `rpc_mc_*`                                                | The only write paths: `create_campaign`, `import_case`, `assign`, `submit`, `phase`, `adjudicate`, `completion_summary` (counts only), `register_export`.                                                       |

Export format `mapping-confirmation-1.0`: `mapping_confirmation_cases.csv` (one row per mapping with hashes, evidence flags and the adjudication), `mapping_confirmation_responses.csv` (one row per mapping and reviewer slot with provenance) and `mapping_confirmation_bundle.manifest.json` (review mode, assignment visibility, condition set, rubric, phase timestamps, counts, `weights_or_probabilities: NONE`, `analysis_specification: PENDING`). Columns are fixed in `src/lib/mapconf-export.ts`; the v5 sampling and label columns are forbidden by the writer.

## Application

- Tab "Mapping confirmation" ([src/app/mapconf-workspace.tsx](../src/app/mapconf-workspace.tsx)): reviewer queue and form, adjudicator queue and form, investigator console (create the synthetic campaign, import the twelve synthetic mappings and three synthetic training examples, assign, close, authorize, lock, build and register the export; the evaluation import button is disabled and the route returns 409).
- Routes under `/api/mc/*` ([src/app/api/[...path]/route.ts](../src/app/api/%5B...path%5D/route.ts)); service [src/server/mapconf.ts](../src/server/mapconf.ts); rubric and types [src/lib/mapconf-types.ts](../src/lib/mapconf-types.ts); fixtures [src/lib/mapconf-synthetic.ts](../src/lib/mapconf-synthetic.ts).
- Tests: `tests/mapconf.test.ts` (service lifecycle), `tests/mapconf-guards.test.ts` (database boundary, evidence allow-list), `tests/mapconf-postgres.test.ts` (native PostgreSQL 16, skipped as BLOCKED without `VERIFY_PG_TEST_URL`), `tests/e2e/mapconf.spec.ts` (served browser run with axe checks).

## What remains for the investigator

1. Approve or amend the ten-condition list (Pain, Neoplasms label, figure numbering).
2. Define the sampling frame for the 100 mappings and any negative/control coverage; decide the therapeutic-area secondary assessment.
3. Approve the rubric text (`MAPPING_CONFIRMATION_RUBRIC-DRAFT-1` is hashed into every response) and the analysis specification for this mode.
4. Decide the compatibility and mapping of the three worked examples.
5. Provide the private configuration path for the Supabase staging integration (see [SUPABASE_IDENTITY.md](SUPABASE_IDENTITY.md) when present).
