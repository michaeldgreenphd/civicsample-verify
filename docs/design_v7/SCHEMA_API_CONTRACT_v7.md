# Schema and API contract, migration NNNN_v7_mapping_units.sql (PROPOSED)

Migration SHA-256 1af1a8f60f3c31792c8d68ddc296b75f4e3eccf1b8279a2d926c622cf3cd7b65. Additive: no earlier function, constraint, view, trigger or grant changes (tests
MU7-ADD-01 to MU7-ADD-08 compare the catalogue with and without NNNN). The two FINDING-V6-01 helpers keep their 0006
definitions. Numbering: the application repository assigns the next free number (0022 or later).

## Objects

Tables (15, append-only, row-level security on, audited): mu7_design, mu7_phase_events, mu7_units, mu7_unit_design, mu7_frozen_assignments, mu7_gate_approvals, mu7_freeze, mu7_queue, mu7_judgments, mu7_snapshot, mu7_adjudications, mu7_reference_locks, mu7_exports, mu7_training_units, mu7_training_acknowledgments.

Views (6, security_invoker): v_mu7_my_queue, v_mu7_independent_judgments, v_mu7_final_reference, v_mu7_adjudication_queue, v_mu7_export_units, v_mu7_export_unit_design.

RPCs (18, SECURITY DEFINER, empty search_path, EXECUTE for authenticated only; each checks its caller):

- `rpc_mu7_record_design(p jsonb)`
- `rpc_mu7_enroll_reviewer(p_user_id uuid, p_qualifications text default null)`
- `rpc_mu7_import_unit(p jsonb)`
- `rpc_mu7_import_training_unit(p jsonb)`
- `rpc_mu7_approve_gate(p_gate_id text, p_attestation text, p_evidence_reference text default null)`
- `rpc_mu7_freeze(p jsonb)`
- `rpc_mu7_assign_queue(p_mode text, p jsonb)`
- `rpc_mu7_phase(p_event_type text, p jsonb default '{}'::jsonb)`
- `rpc_mu7_get_unit(p_assignment_id uuid)`
- `rpc_mu7_submit(p_assignment_id uuid, p jsonb)`
- `rpc_mu7_snapshot()`
- `rpc_mu7_verify_snapshot()`
- `rpc_mu7_verify_freeze()`
- `rpc_mu7_record_adjudication(p jsonb)`
- `rpc_mu7_lock_reference(p_mode text, p_attestation text)`
- `rpc_mu7_register_export(p jsonb)`
- `rpc_mu7_acknowledge_training()`
- `rpc_mu7_completion_summary(p_mode text)`

New triggers on earlier tables (each only refuses): `a00_mu7_old_design_guard` on tlv5_cases, tlv5_activation,
design_activation_v4 and cases. Once a v7 design is recorded they refuse new v5/v6 FORMAL, CALIBRATION and TRAINING
cases, a v4 or v5 activation and a new FORMAL case of the v2/v3 path. The v5/v6 PILOT path stays open, so the synthetic
walkthrough of the current app keeps working.

## Order of operations (each step refused out of order)

1. `rpc_mu7_record_design` (investigator; refused when a v4, v5 or v6 formal or calibration review exists).
2. PILOT: `rpc_mu7_import_unit` for the synthetic units, `rpc_mu7_assign_queue('PILOT', ...)`, answers, adjudication,
   `rpc_mu7_lock_reference('PILOT')`, `rpc_mu7_register_export` (bundle 7.0), `rpc_mu7_phase('PILOT_SIGNED_OFF')`.
3. `rpc_mu7_enroll_reviewer` (FORMAL, only after the sign-off). Worked examples: `rpc_mu7_import_training_unit`
   (before the formal opening).
4. FORMAL: `rpc_mu7_import_unit` for the 100 units with design rows and frozen assignments;
   `rpc_mu7_approve_gate` for each gate a unit waits for; `rpc_mu7_freeze` with the manifest hashes;
   `rpc_mu7_assign_queue('FORMAL', ...)` equal to the frozen queue; `rpc_mu7_phase('FORMAL_OPENED')`.
5. Reviewers: `v_mu7_my_queue`, `rpc_mu7_get_unit`, `rpc_mu7_submit`. Investigator during the phase:
   `rpc_mu7_completion_summary` (counts only).
6. `rpc_mu7_phase('FORMAL_CLOSED_COMPLETE' or 'FORMAL_CLOSED_INCOMPLETE')`, `rpc_mu7_snapshot`, adjudication of the
   routed units (`v_mu7_adjudication_queue`, `rpc_mu7_record_adjudication`), `rpc_mu7_lock_reference('FORMAL')`,
   export views, `rpc_mu7_register_export`.

## Guards (every refusal the migration makes; each has its own tagged test)

| guard | function | message | tests |
|---|---|---|---|
| MU7-G50 | private.mu7_can_read_judgments | no interim look; the investigator reads FORMAL answers only after the close | MU7-INT-01, MU7-INT-02, MU7-INT-03 |
| MU7-G51 | private.mu7_can_read_judgments | the adjudicator reads FORMAL answers only after the close and the snapshot | MU7-INT-06, MU7-INT-09, MU7-FC-06 |
| MU7-G52 | private.mu7_reviewer_can_read_unit | FORMAL packets are readable from the formal opening onward | MU7-FP-02 |
| MU7-G53 | private.mu7_reviewer_can_read_unit | subgroup units open after every primary unit of the queue is answered | MU7-PR-03 |
| MU7-G15 | private.assert_mu7_trial_block | the packet needs a trial block | MU7-PK-05, MU7-PK-06, MU7-PK-07 |
| MU7-G16 | private.assert_mu7_trial_block | a FORMAL or worked-example packet carries the trial's NCT ID | MU7-PK-08, MU7-PK-09, MU7-PK-10, MU7-PK-R2b, MU7-TR-05 |
| MU7-G14 | private.assert_mu7_packet | packet top-level key "<value>" or schema_version is not allowed (keys: schema_version 7.0, unit, trial, notices) | MU7-PK-02, MU7-PK-03, MU7-PK-04 |
| MU7-G17 | private.assert_mu7_packet | the unit block must equal the unit row (identifier, mode, family, category, role, mapping, assignment) | MU7-PK-11, MU7-PK-12 |
| MU7-G18 | private.assert_mu7_packet | the displayed mapping label and assignment text must be the canonical texts of the frozen assignment | MU7-PK-13, MU7-PK-14, MU7-PK-15, MU7-PK-16, MU7-PK-17, MU7-PK-19, MU7-PK-20 |
| MU7-G19 | private.assert_mu7_packet | a PILOT packet carries the notice "SYNTHETIC UNIT: excluded from every statistic" | MU7-PK-21, MU7-PK-22 |
| MU7-G40 | private.assert_mu7_training_packet | a training packet has schema_version 7.0, a TRAINING unit block with its own ID, a worked_example block, and allowed keys only (offending key: <value>) | MU7-TR-02, MU7-TR-03, MU7-TR-04 |
| MU7-G01 | private.mu7_design_before_insert | only the investigator records the v7 design | MU7-DES-09 |
| MU7-G02 | private.mu7_design_before_insert | a v4, v5 or v6 formal or calibration review already exists in this database; it keeps its design | MU7-D3-02 |
| MU7-G04 | private.mu7_old_design_guard | this database runs review design v7; a new v5 or v6 <value> case is refused | MU7-X-01, MU7-X-02 |
| MU7-G05 | private.mu7_old_design_guard | this database runs review design v7; activating design v4 or v5 is refused | MU7-X-03, MU7-X-04 |
| MU7-G06 | private.mu7_old_design_guard | this database runs review design v7; a new FORMAL case of the v2/v3 path is refused | MU7-X-05 |
| MU7-G10 | private.mu7_units_before_insert | record the v7 design before the first unit | MU7-UNIT-00 |
| MU7-G11 | private.mu7_units_before_insert | the v7 sample is frozen; FORMAL unit <value> cannot be added | MU7-PS-08, MU7-FZ-08 |
| MU7-G12 | private.mu7_units_before_insert | the v7 review is assigned-only; an UNASSIGNED unit is refused | MU7-UNIT-01 |
| MU7-G20 | private.mu7_unit_design_before_insert | the design row's NCT ID must equal the packet's trial | MU7-UNIT-12, MU7-UNIT-13, MU7-UNIT-14, MU7-D2-05 |
| MU7-G21 | private.mu7_unit_design_before_insert | <value> is a worked-example trial and cannot be a FORMAL unit's trial | MU7-TR-10 |
| MU7-G24 | private.mu7_unit_design_before_insert | overlap setting ONE_PER_TRIAL: trial <value> already has a FORMAL unit | MU7-D2-03 |
| MU7-G23 | private.mu7_frozen_assignments_before_insert | the frozen assignment must equal the assignment the unit displays, in the recorded assignment set | MU7-FIMP-09, MU7-FIMP-10, MU7-FIMP-11 |
| MU7-G22 | private.mu7_training_units_before_insert | <value> is a FORMAL unit's trial and cannot be a worked example | MU7-TR-11 |
| MU7-G41 | private.mu7_training_units_before_insert | worked examples are imported before the formal opening | MU7-FP-06 |
| MU7-G26 | private.mu7_freeze_before_insert | the freeze needs exactly <value> primary and <value> subgroup FORMAL units (found <value> and <value>) | MU7-FZ-01, MU7-D2-06 |
| MU7-G27 | private.mu7_freeze_before_insert | <value> FORMAL units lack a design row or a frozen assignment | MU7-D2-08 |
| MU7-G28 | private.mu7_freeze_before_insert | the manifest hashes do not match the imported units (unit list <value>, assignments <value>, design rows <value>) | MU7-FZ-02, MU7-FZ-03 |
| MU7-G29 | private.mu7_freeze_before_insert | units are blocked from the freeze until their gate is approved: <value> | MU7-FZ-04 |
| MU7-G30 | private.mu7_queue_before_insert | a <value> unit goes to an active <value> reviewer | MU7-FQ-03 |
| MU7-G31 | private.mu7_queue_before_insert | the FORMAL queue is assigned after the pilot sign-off and the freeze, before the formal opening | MU7-D2-13 |
| MU7-G32 | private.mu7_queue_before_insert | one reviewer holds one slot per mode, and one slot belongs to one reviewer | MU7-PQ-05 |
| MU7-G42 | private.mu7_phase_events_before_insert | only the investigator records a phase event | MU7-PS-04, MU7-PS-07, MU7-FP-05, MU7-FC-04 |
| MU7-G43 | private.mu7_phase_events_before_insert | the pilot sign-off needs the PILOT reference lock and the registered PILOT export | MU7-PS-01 |
| MU7-G44 | private.mu7_phase_events_before_insert | the formal phase opens after the sign-off, the freeze and the full queue of both reviewers (<value> of <value> assignments) | MU7-PS-09, MU7-D2-11 |
| MU7-G45 | private.mu7_phase_events_before_insert | the formal phase closes only while it is open | MU7-FC-01, MU7-D2-10 |
| MU7-G34 | private.mu7_judgments_before_insert | FORMAL answers are accepted only while the formal phase is open | MU7-PL-03, MU7-FP-03, MU7-FC-03 |
| MU7-G33 | private.mu7_judgments_before_insert | a subgroup unit is answered after every primary unit of the queue | MU7-PR-06 |
| MU7-G35 | private.mu7_judgments_before_insert | reason code <value> does not fit a <value> unit showing <value> | MU7-PR-08 |
| MU7-G36 | private.mu7_judgments_before_insert | a DISAGREE answer needs a note | MU7-PR-07 |
| MU7-G46 | private.mu7_snapshot_before_insert | the snapshot is taken after the formal close | MU7-SN-00, MU7-D2-09 |
| MU7-G37 | private.mu7_adjudications_before_insert | only the adjudicator records a v7 adjudication | MU7-PA-13 |
| MU7-G38 | private.mu7_adjudications_before_insert | FORMAL adjudication starts after the close and the snapshot | MU7-PL-04, MU7-FC-05 |
| MU7-G39 | private.mu7_adjudications_before_insert | only routed units are adjudicated (AGREE against DISAGREE, or exactly one CANNOT_TELL); this unit is <value> | MU7-PA-03, MU7-PA-04, MU7-ADJ-02, MU7-D2-18 |
| MU7-G47 | private.mu7_adjudications_before_insert | the basis must name the reviewer whose effective answer equals the decision (NEITHER when none does) | MU7-PA-05, MU7-PA-06 |
| MU7-G48 | private.mu7_reference_locks_before_insert | the FORMAL reference is locked after the close and the snapshot | MU7-PL-01, MU7-FL-00, MU7-FL-01, MU7-D2-16 |
| MU7-G49 | private.mu7_exports_before_insert | a <value> export is registered after the <value> reference lock | MU7-PX-01, MU7-FX-03 |
| MU7-G07 | private.mu7_assert_keys | <value> needs a JSON object | MU7-DES-03, MU7-UNIT-11, MU7-PR-12 |
| MU7-G08 | public.rpc_mu7_enroll_reviewer | FORMAL v7 reviewers are enrolled after the v7 pilot sign-off | MU7-ENR-00 |
| MU7-G13 | public.rpc_mu7_import_unit | every unit is imported with its design row | MU7-UNIT-08, MU7-UNIT-09, MU7-UNIT-10 |
| MU7-G60 | public.rpc_mu7_assign_queue | the queue covers every <value> unit for both reviewer slots in one call (<value> rows for <value> units) | MU7-PQ-02, MU7-PQ-03 |
| MU7-G61 | public.rpc_mu7_assign_queue | primary units take the first <value> positions of each queue and subgroup units follow | MU7-PQ-04 |
| MU7-G62 | public.rpc_mu7_assign_queue | two units of the same trial are never adjacent in a queue (<value> adjacent pairs) | MU7-FQ-01 |
| MU7-G63 | public.rpc_mu7_assign_queue | the FORMAL queue does not match the frozen queue hash | MU7-FQ-02 |
| MU7-G54 | public.rpc_mu7_get_unit | this assignment is not yours | MU7-PR-04 |
| MU7-G55 | public.rpc_mu7_get_unit | FORMAL units open with the formal phase | MU7-FP-01 |
| MU7-G56 | public.rpc_mu7_get_unit | subgroup units open after every primary unit of your queue is answered | MU7-PR-02 |
| MU7-G57 | public.rpc_mu7_submit | this assignment is not yours | MU7-PR-05 |
| MU7-G58 | public.rpc_mu7_record_adjudication | the adjudicator role is needed to adjudicate | MU7-PA-01, MU7-PA-02 |
| MU7-G59 | public.rpc_mu7_acknowledge_training | only an enrolled reviewer acknowledges the worked examples | MU7-TR-ACK-03 |

## Named constraints

| table | constraint | tests |
|---|---|---|
| mu7_design | mu7_design_assignment_set_ck | MU7-DES-06 |
| mu7_design | mu7_design_overlap_ck | MU7-DES-04 |
| mu7_design | mu7_design_attestation_ck | MU7-DES-05 |
| mu7_phase_events | mu7_phase_event_type_ck | MU7-PS-05 |
| mu7_phase_events | mu7_phase_signoff_fields_ck | MU7-PS-02 |
| mu7_units | mu7_units_category_ck | MU7-UNIT-03 |
| mu7_units | mu7_units_id_ck | MU7-UNIT-02 |
| mu7_units | mu7_units_role_ck | MU7-UNIT-04 |
| mu7_units | mu7_units_mapping_ck | MU7-UNIT-05 |
| mu7_units | mu7_units_assignment_ck | MU7-UNIT-06 |
| mu7_units | mu7_units_parent_row_ck | MU7-UNIT-07 |
| mu7_units | mu7_units_record_category_ck | MU7-UNIT-03b |
| mu7_unit_design | mu7_unit_design_nct_ck | MU7-UNIT-17 |
| mu7_unit_design | mu7_unit_design_n_ck | MU7-UNIT-15 |
| mu7_unit_design | mu7_unit_design_gate_ck | MU7-UNIT-16 |
| mu7_gate_approvals | mu7_gate_id_ck | MU7-GATE-02 |
| mu7_judgments | mu7_judgments_answer_ck | MU7-PR-11 |
| mu7_judgments | mu7_judgments_reason_ck | MU7-PR-09, MU7-PR-10 |
| mu7_adjudications | mu7_adj_decision_ck | MU7-PA-10 |
| mu7_adjudications | mu7_adj_status_ck | MU7-PA-07 |
| mu7_adjudications | mu7_adj_basis_ck | MU7-PA-08 |
| mu7_adjudications | mu7_adj_reason_ck | MU7-PA-09 |
| mu7_exports | mu7_exports_format_ck | MU7-PX-02 |
| mu7_training_units | mu7_training_id_ck | MU7-TR-06 |

## Relaxed on purpose (stated in the migration header, here and in CHANGELIST_v7.md; each tested)

- R1: registry text is shown as registered (decision 24). The packet guard checks keys, never text values, so text that
  names another registry or another trial is accepted (test MU7-PK-R1).
- R2: a FORMAL packet carries the trial's NCT ID and the link to that trial's own record; any other link is refused
  (tests MU7-PK-R2a, MU7-PK-R2b, MU7-PK-08, MU7-PK-09). Packets are not de-identified.
- R3: the worked examples carry the real NCT IDs of the trials printed in eFigure 1 (test MU7-TR-R3); a worked-example
  trial can never be a FORMAL unit's trial, in either order of import (guards MU7-G21 and MU7-G22).

## Reads by role

- Reviewer: the design record, phase events, their own queue rows, their own judgments, the packets of their assigned
  units (FORMAL packets from the formal opening; subgroup packets after every primary unit is answered), the worked
  examples. Never the design rows, frozen assignments, another reviewer's answers or any export view.
- Adjudicator: PILOT answers at any time; FORMAL answers, units and queue rows only after the close and the snapshot;
  the adjudication queue.
- Investigator: every design object; PILOT answers; FORMAL answers only after the close (no interim look), progress
  counts while the phase is open; the export views.
