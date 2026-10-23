# App import steps, review design v7

Staging only until the investigator says otherwise. Each step names its file and its RPC. Real files come from
data_private/ (PRIVATE_TRANSFER_LIST_v7.md); synthetic files are public.

1. Engineering review of NNNN_v7_mapping_units.sql as a pull request; assign the next free migration number (0022 or
   later); apply it to a disposable staging copy only after the review, in one transaction. Never renumber, edit or
   replay an earlier migration.
2. Record the design: `rpc_mu7_record_design` with design_version "review-design-v7.0.0", assignment_set_id
   "MU7-ASSIGN-PROPOSED-20261023", overlap_setting from freeze_manifest_v7_PROPOSED.json ("ALLOW", PENDING
   gate G-OVERLAP-01), n_primary_planned 96, n_subgroup_planned 4. On a
   database that already holds a v5 or v6 formal or calibration review the call is refused (MU7-G02).
3. Synthetic pilot (public SYNTHETIC_PILOT_UNITS_v7.json): send each `units[i].import` object unchanged to
   `rpc_mu7_import_unit`; never send `units[i].walkthrough`. Enrol the pilot accounts, assign both queues in one call
   (`rpc_mu7_assign_queue('PILOT', ...)`), enter the planted answers, adjudicate the routed units, lock, export, check
   the routing against `expected_routing`, then sign off (PILOT_ACCEPTANCE_CHECKLIST_v7.md).
4. Worked examples (private MU7_IMPORT_TRAINING_v7_PRIVATE.json): `rpc_mu7_import_training_unit` for each object.
5. FORMAL dry run on a disposable staging copy (private MU7_IMPORT_UNITS_v7_PROPOSED_PRIVATE.json): import the 100
   units (`units[i]`, unchanged). The freeze with `manifest_hashes` must be refused by MU7-G29 while gate G-PAIN-01 is
   open; that refusal shows the database reproduced the unit list, assignment and design-row hashes. Do not approve a
   gate in staging on the investigator's behalf.
6. Never freeze, open the formal phase, enrol a formal reviewer or import real data into production without the
   investigator's written instruction.
