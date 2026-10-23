# Change list, review design v7 (from v6)

Design
- Unit of review: one (trial, mapping) pair instead of one trial with all its displayed labels (100 trials and
  1,747 labels in v6). 100 units, both reviewers answer all: 200 initial judgments. Training outside the totals.
- Allocation Option A (APPROVED): 56 area, 40 row (Pain included), 4 subgroup units. Seed 2026102307.
- Frames: Mental health under decision 36 (F03 or D003863); provenance rules PV01 to PV08 applied (PV04 to PV08
  PROPOSED); the three figure-printed trials excluded; the six former calibration trials stay excluded (PV03).
- Outcome wording: clinician confirmation of displayed assignments (never PPV or accuracy, never a bound).
- Removed subgroup outcomes are displayed for the first time, with PROPOSED texts and reason codes (gate G-TEXT-01).
- Interval rule: Wilson at n_eff = min(determinate units, Kish n_eff, variance-based n_eff) (PROPOSED, gate G-EST-01);
  rule R1 dropped (R0 primary, R2 sensitivity).
- Overlap of trials across strata: parameter ALLOW (PROPOSED default) or ONE_PER_TRIAL, both coded and tested.

Database (NNNN_v7_mapping_units.sql, PROPOSED, additive)
- New: 15 tables, 6 views, 18 RPCs, private helpers, 60 tagged guards,
  24 named constraints, four refusing triggers on earlier tables.
- Unchanged: schema.sql and 0002 to 0006, including the FINDING-V6-01 helpers (tests MU7-ADD-01 to MU7-ADD-08).
- Relaxed on purpose and tested: R1 registry text naming other registries or trials accepted; R2 the packet carries the
  NCT ID and its own registry link; R3 the worked examples carry real NCT IDs (never a FORMAL trial).
- The design-row hash now includes the NCT ID, so the freeze binds each unit to its trial.

Analysis
- validation/performance_analysis_v7.py, mu7_estimators.py (weights, trial clustering), mu7_bundle.py, the synthetic
  bundle fixture and 22 tests.

Withdrawn from the v7 message
- "Build the confirm design on a FRESH staging database" and "apply 0006 and record CONFIRM_V6": replaced by the
  engineering review of NNNN as a pull request (NEXT_MESSAGE_FOR_CLAUDE_CODE_v8.md). The v6 confirm design is not run.
