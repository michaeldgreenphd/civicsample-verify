# Export to analysis, bundle format 7.0

The app writes one FORMAL bundle after the FORMAL reference lock (`rpc_mu7_register_export` refuses earlier, guard
MU7-G49, and refuses when the judgments no longer match the snapshot). `validation/performance_analysis_v7.py` reads it.

## Files

| file | view | one row per |
|---|---|---|
| units.csv | v_mu7_export_units | unit |
| unit_design.csv | v_mu7_export_unit_design | unit (design row and frozen assignment hash) |
| independent_judgments.csv | v_mu7_independent_judgments | assignment (unit x reviewer slot) |
| final_reference.csv | v_mu7_final_reference | unit |
| manifest.json | | bundle |

Columns (the suite checks each list, steps MU7-EXP-COL-*):

- units.csv: unit_id,mode,record_category,family,category,unit_role,mapping_code,assignment_code,assignment_status,parent_row_code,packet_sha256,created_at
- unit_design.csv: unit_id,mode,nct_id,frame_id,stratum,frame_stratum_size,n_sampled_in_stratum,selection_probability,sampling_seed,prn_key,allocation_option,overlap_setting,design_version,freeze_status,freeze_gate,design_row_sha256,assignment_set_id,assignment_row_sha256
- independent_judgments.csv: unit_id,mode,reviewer_slot,reviewer_pseudo_id,queue_position,judgment_status,answer_initial,reason_initial,note_initial,uncertain_initial,answer_effective,reason_effective,note_effective,uncertain_effective,n_revisions,first_submitted_at,last_submitted_at
- final_reference.csv: unit_id,mode,family,category,unit_role,mapping_code,assignment_code,assignment_status,answer_initial_slot1,answer_initial_slot2,answer_effective_slot1,answer_effective_slot2,routing,final_answer,final_status,adjudication_reason_code,adjudication_status,adjudication_basis,adjudication_disagreement_reason_code

manifest.json: bundle_format_version "7.0", mode "FORMAL", status, design (design_version, assignment_set_id,
overlap_setting, n_primary_planned, n_subgroup_planned), freeze (n_units, n_primary, n_subgroup and the five hashes of
mu7_freeze), snapshot (n_rows, content_sha256), files (SHA-256 of each CSV), row_counts.

## Three-state coding (never a blank answer)

- judgment_status ANSWERED with an answer, or NOT_ANSWERED (the slot never answered: state 3, absent). An answer of
  CANNOT_TELL is the explicit "cannot tell" state (state 2).
- final_status: CONCORDANT (identical answers), ADJUDICATED, CANNOT_TELL_BY_RULE (both CANNOT_TELL), UNRESOLVED
  (routed, escalated without a decision), INCOMPLETE (one reviewer only), PENDING_ADJUDICATION (never present after the
  lock). routing: CONCORDANT_AGREE, CONCORDANT_DISAGREE, BOTH_CANNOT_TELL, ROUTED, INCOMPLETE.

## Analysis (PROPOSED details under gate G-EST-01)

1. Verification first: format 7.0, mode FORMAL, every file hash, the unit list, assignment-set and design-row hashes
   recomputed from the CSV files against the freeze (and against freeze_manifest_v7.json with --design-manifest), one
   row per reviewer slot, every stratum holding exactly its design n. Any failure: exit 3, nothing written.
2. Families AREA and ROW pooled (ROW_BENCHMARKED, the 9 rows of the Figure 3 model, secondary): Hajek ratio estimate,
   stratified linearization variance with the finite population correction, Wilson interval at
   n_eff = min(determinate units, Kish n_eff, theta(1 - theta)/V). R0 (primary): final CANNOT_TELL and unresolved units
   leave the denominator. R2 (sensitivity): they count as not confirmed. INCOMPLETE units leave both.
3. Categories and the four subgroup strata: counts only (fewer than 10 determinate units each); KEEP and REMOVE
   separate; subgroups never pooled.
4. Agreement on the initial answers (the 100 pairs) and on the effective answers: percent agreement, Cohen's kappa over
   AGREE, DISAGREE and CANNOT_TELL, percentile bootstrap interval (2,000 replicates, seed 2026102307).
5. Overlap: ALLOW uses N_h / n_h and, when a trial holds two units of one family, the larger of the stratified and the
   trial-cluster variance with n_eff capped at the number of trials; the bootstrap resamples trials. ONE_PER_TRIAL needs
   the Monte Carlo inclusion probabilities (--probabilities) and uses 1 / pi without the finite population correction.
6. Outputs: family_estimates_v7.csv, category_counts_v7.csv, subgroup_counts_v7.csv, agreement_v7.csv,
   reason_codes_v7.csv, routing_summary_v7.csv, uncertainty_flags_v7.csv, numbers_trace_analysis_v7.csv,
   results_summary_v7.md, run_log_v7.json. Wording: "clinician confirmation of displayed assignments"; intervals as
   "95% CI a% to b%".
