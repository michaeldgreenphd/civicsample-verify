# Pending decisions and approval gates, review design v7

Every default chosen by the analysis lead is PROPOSED and names the gate that approves it. The freeze in the app is
refused while a unit waits for its gate (guard MU7-G29); the remaining gates are approvals the investigator records in
INVESTIGATOR_DECISIONS files and, where a unit depends on them, in the app (rpc_mu7_approve_gate).

| gate | question | PROPOSED default or state | what it blocks | approves |
|---|---|---|---|---|
| G-PAIN-01 | Reconcile the Pain row benchmark conflict (addendum 6, item 28). | Pain units stay in the sample, provisional | the freeze of the 4 Pain units (guard MU7-G29) | investigator |
| G-MH-V53 | Mental health frame equals the v5.3 area flags (decision 37). | the frame of decision 36, computed from the mesh-list headings | the freeze; tools/check_mh_frame_v53_v7.py exits 2 until analysis/primary_v5_3 exists | investigator, after the v5.3 rerun |
| G-PROV-01 | Apply the trial-level provenance rules PV04 to PV08. | PROPOSED: applied | the frame and the draw | investigator |
| G-PROV-02 | Keep descriptor-level development links (PV09) eligible. | PROPOSED: eligible, as in design v5 | nothing until changed | investigator |
| G-PROV-03 | Keep the six former calibration trials excluded. | excluded under PV03 (decision 26) | nothing until changed | investigator |
| G-OVERLAP-01 | May one trial hold units in two strata? | PROPOSED: ALLOW (both settings coded and tested) | the draw (step 03 --overlap) and the analysis weights | investigator |
| G-OQ-03 | Depression policy text in the rubric (OQ-03). | open; decision 36 settles the analysis rule only | the rubric text | investigator |
| G-OQ-04 | Smoking cessation policy text in the rubric (OQ-04). | open | the rubric text | investigator |
| G-TEXT-01 | Display texts and reason codes of the three removed subgroup outcomes (new in v7). | PROPOSED texts of REVIEW_RUBRIC_v7.md section 5 | the freeze (displayed texts are hashed) | investigator |
| G-EST-01 | Estimator details: interval rule, single-review units excluded, trial clustering, ROW_BENCHMARKED secondary. | PROPOSED as in EXPORT_TO_PERFORMANCE_SPEC_v7.md | the analysis plan | investigator and Maryam Aziz |

## Resolved since v6 (recorded, not reopened)

- Decisions 18 to 25 (addendum 5): Option A; both reviewers answer every unit; the adjudicator breaks ties only;
  assigned-only frame; Pain and subgroup units included; subgroup units after every primary unit, server-side, restating
  the parent row; the cannot-tell rule; read-only training with the outcome of example 3, no practice answers, an
  optional acknowledgment timestamp; no calibration round; registry text that names another registry or trial accepted.
- Decisions 26 to 35 (addendum 6): calibration trials not returned (provenance audit instead); figure-printed trials
  excluded; Pain units provisional; the outcome is clinician confirmation of displayed assignments; KEEP and REMOVE
  outcomes separate; repeated trials PENDING (G-OVERLAP-01); 100 units and 200 judgments throughout; eFigure 1 Part C
  units column shows "[pending]".
- Decisions 36 to 39 (addendum 7): D003863 counts as Mental health in the main analysis, the MeSH-only rule is a
  sensitivity analysis, v5.3 runs in analysis/primary_v5_3, and the review frame and display follow the new rule. The
  depression designation question of addendum 6 is resolved for the analysis by decision 36; the rubric policy text
  stays with G-OQ-03.

## Out of scope here

Manuscript items of addenda 5 and 6 (figure and supplement text) belong to the manuscript workstream; this design only
supplies the units column of eFigure 1 Part C ("[pending]" until the freeze).
