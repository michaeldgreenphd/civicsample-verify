<!-- clinical_review_results_template_v5.md : filled by validation/performance_analysis_v5.py (--template). Every slot in double braces
     is replaced by a computed value or the run stops. Wording is a DRAFT for the investigator; numbers come only from the run. -->
Two clinicians independently reviewed {{N_CASES_SAMPLED}} trials sampled from the trials in the threshold model
({{N_CASES_TWO_REVIEWERS}} by both reviewers, {{N_CASES_ONE_REVIEWER}} by one, {{N_CASES_NOT_REVIEWED}} by neither), blinded
to every label; a third clinician adjudicated disagreements. Against the adjudicated reference, the design-weighted positive
predictive value of the therapeutic-area labels used in the analysis was {{PPV_T0_POOLED_W}}; sensitivity
{{SENS_T0_POOLED_W}}; specificity {{SPEC_T0_POOLED_W}}; and all seven area labels of a trial matched the reference for
{{EXACT_MATCH_T0_W}} of trials. The condition-row labels had a positive predictive value of {{PPV_ROWS_POOLED_W}}. The
diabetes-type rule agreed with the clinicians for {{RULE_D_AGREEMENT_W}} and the malignancy rule for {{RULE_K_AGREEMENT_W}}.
The two reviewers agreed on {{RAW_AGREEMENT_AREA_ITEMS}} of area items ({{RAW_AGREEMENT_AREA_ITEMS_CI}}), a measure of
consistency between clinicians, not of validity.
