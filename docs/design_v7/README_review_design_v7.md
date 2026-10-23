# Review design v7: the mapping-unit confirmation review

Status: PROPOSED design, built 2026-10-23T03:08:40Z. The allocation (Option A) is APPROVED (decision 18); the unit sample is
PROPOSED and not frozen; 8 approval gates stay open (G-PAIN-01, G-MH-V53, G-PROV-01, G-OVERLAP-01, G-TEXT-01, G-EST-01, G-OQ-03, G-OQ-04; PENDING_DECISIONS_v7.md).
Every default chosen by the analysis lead is labelled PROPOSED with the gate that approves it.

## What changed from v6

Design v6 asked two reviewers to answer every one of 1,747 displayed labels on 100 trials. Design v7 reviews
100 mapping units instead. A unit is one (trial, mapping) pair: one therapeutic area, one Figure 2 condition
row, or one rule D or rule K subgroup outcome, with our assignment shown. Both reviewers answer every unit, so the review
holds 200 initial judgments; the adjudicator only breaks ties. The 3
worked examples (EX7-01 to EX7-03) are read-only training and sit outside every total.

- 56 area units (8 in each of the 7 Tier 0 areas), 40 row units (4 in each of the 10 Figure 2 rows, Pain
  included) and 4 subgroup units (rule D kept, rule D removed, rule K kept, rule K removed).
- Answers: AGREE, DISAGREE (a reason code and a note) or CANNOT_TELL, with an optional uncertainty flag.
- Outcome: clinician confirmation of displayed assignments. It is not a positive predictive value, not an accuracy and
  not a proven bound on either; the review shows assigned mappings only, so it cannot detect missed mappings.
- The 4 Pain units are provisional and blocked from the freeze until gate G-PAIN-01 resolves the Pain row
  definition (decision 28).
- Mental health follows decision 36: any MeSH F03 heading, or the heading Depression (D003863), which MeSH files under
  F01 Behavior only. Gate G-MH-V53 compares the frame with the v5.3 area flags before the freeze.

## How to run (Maryam Aziz or Michael Green)

```sh
cd scripts
SG_V7_OUT=/path/to/a/NEW/folder PGLITE_DIR=/path/with/node_modules PYTHON=python3 sh run_all_v7.sh
```

Steps: 00 input checks (R extracts the v5.2 objects; 66 of 66 checks passed in this run),
01 unit frames and the provenance audit, 02 allocation and precision projections, 03 the draw, the frozen-assignment
file, the queues and the freeze manifest, 04 the Monte Carlo inclusion probabilities of the ONE_PER_TRIAL alternative,
05 the training units, 06 the unit packets and the synthetic pilot, 07 every database and analysis test, 08 these
documents, 09 the two archives. Every writer refuses to overwrite; a rerun needs a new output folder. Nothing is deleted.

## Folder map

- `scripts/`: the pipeline (steps 00 to 09) and `v7_common.py` (constants, each checked against the data).
- `db/migrations/NNNN_v7_mapping_units.sql`: the PROPOSED additive migration (number assigned by the app repository,
  0022 or later). `db/tests_prebuild/pglite_v7/`: the PGlite suite, the mutation harness and the private dry run.
- `code/validation/`: `performance_analysis_v7.py`, `mu7_estimators.py`, `mu7_bundle.py`, the synthetic bundle
  fixture and the tests.
- `tools/`: `check_public_repo_leakage_v7.py` (with `--packets` and `--negative-control`) and
  `check_mh_frame_v53_v7.py` (gate G-MH-V53).
- `tables/`, `logs/`, `numbers_trace_v7.csv`: every number the documents use.
- Private files (real NCT IDs or registry text) carry `_PRIVATE` or a private name and travel only in
  `claude_code_private_staging_v7.zip` (PRIVATE_TRANSFER_LIST_v7.md).

## Documents

SAMPLING_SPEC_v7.md, ALLOCATION_PROPOSAL_v7.md, PROVENANCE_AUDIT_SUMMARY_v7.md, PENDING_DECISIONS_v7.md,
REVIEW_RUBRIC_v7.md, EFIGURE1_PART_C_ALIGNMENT_v7.md, APP_MAPPING_v7.md, SCHEMA_API_CONTRACT_v7.md,
BEHAVIOR_TEST_SPEC_v7.md, EXPORT_TO_PERFORMANCE_SPEC_v7.md, SCHEMA_TEST_REPORT_v7.md, PILOT_ACCEPTANCE_CHECKLIST_v7.md,
APP_IMPORT_STEPS_v7.md, PRIVATE_TRANSFER_LIST_v7.md, CHANGELIST_v7.md, NEXT_MESSAGE_FOR_CLAUDE_CODE_v8.md.
