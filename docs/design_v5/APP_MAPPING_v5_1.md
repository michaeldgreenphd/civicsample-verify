# App mapping, design v5.1 (trial-level label verification, with worked training examples)

> Supplied proposed design document, retained for review. It is not investigator approval. Where it allows investigator adjudication, ordinary revisions, or single-review adjudication, the application retains the stricter standing instructions. Formal activation remains blocked pending reconciliation.

Built 2026-10-22. How the review app uses `migrations/0004_v5_trial_label_verification.sql` and `migrations/0005_v5_training_examples.sql` (v5.1: the TRAINING mode for the worked examples and the NCT identifier in the packet). Status: PROPOSED. Every write goes through an `rpc_tlv5_*` function; reads go through tables and views filtered by row-level security. The app never decides who may see what: the database does, and the app must not add a path around it (no service-role key in the browser, no server-side query that bypasses row-level security for a reviewer or the adjudicator).

## 1. Why a new module

The v4 case model stores one area decision per determination level (at most two levels per case) on the layer-1 scale, and its held-out guards refuse development-linked units. A v5 case is one trial with 7 area items, 10 condition-row items and up to 2 subgroup items with their own scales, and the frame deliberately keeps development-linked trials. v5 therefore lives in its own `tlv5_` tables on the Module B pattern of 0003 and reuses the users, roles, pseudonyms, audit log, packet-key walker, multi-factor check and append-only machinery. The v4 tables stay in the schema unused; design v4 cannot be activated once v5 is active, and design v5 cannot be activated once v4 is. Module B (0003) is separate and unchanged.

## 2. Accounts (staging first; production only at the formal unlock)

| Account                 | Role                         | Created with                                                                                     | Notes                                                            |
| ----------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------- |
| two investigators       | INVESTIGATOR                 | `rpc_register_user` (role INVESTIGATOR)                                                          | multi-factor (aal2) sessions required for every investigator RPC |
| two pilot test accounts | REVIEWER, pilot test account | `rpc_register_user(..., true)` then `rpc_enroll_reviewer(uid, 'PILOT')`                          | pseudonyms PT-XXXX; never the formal reviewers' accounts         |
| Reviewer 1, Reviewer 2  | REVIEWER                     | `rpc_register_user(..., false)` then `rpc_tlv5_enroll_reviewer(uid)` after the v5 pilot sign-off | pseudonyms R-XXXX                                                |
| adjudicator             | ADJUDICATOR                  | `rpc_register_user(..., 'ADJUDICATOR', false)`                                                   | never enrolled as a reviewer (the database refuses)              |

The roster (names) is in `NEXT_MESSAGE_FOR_CLAUDE_CODE_v5.md`, item 1. No account holds two roles.

## 3. Screens and the database calls behind them

| Screen                | Who          | Reads                                                                                                                                                                                                                                                                   | Writes                                                                                                                               |
| --------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Reviewer queue        | reviewer     | `v_tlv5_my_queue` (own PILOT, CALIBRATION and FORMAL assignments, queue position, number of submissions; never a training example)                                                                                                                                      | none                                                                                                                                 |
| Training view         | reviewer     | `v_tlv5_my_training_queue` (own TRAINING assignments only), the packets of those cases, own training submissions; the worked answers of an example from the private file `worked_examples_v5.json`, shown only after the reviewer has submitted a practice answer to it | `rpc_tlv5_submit` on a TRAINING assignment (practice; never exported)                                                                |
| Trial form (19 items) | reviewer     | `tlv5_cases.packet` (own assigned trials only), own `tlv5_submissions` and `tlv5_submission_items`                                                                                                                                                                      | `rpc_tlv5_submit(assignment_id, {items, overall_comment, packet_issue_flag, packet_issue_note, seconds_on_case})`                    |
| Investigator setup    | investigator | everything below, by role                                                                                                                                                                                                                                               | `rpc_tlv5_import_case`, `rpc_tlv5_import_frozen_labels`, `rpc_tlv5_activate`, `rpc_tlv5_freeze`, `rpc_tlv5_assign`, `rpc_tlv5_phase` |
| Progress while open   | investigator | `rpc_tlv5_completion_summary(mode)` (counts only)                                                                                                                                                                                                                       | none                                                                                                                                 |
| Close and snapshot    | investigator | `rpc_tlv5_verify_snapshot()`                                                                                                                                                                                                                                            | `rpc_tlv5_phase('FORMAL_CLOSED_COMPLETE' or 'FORMAL_CLOSED_INCOMPLETE')`, `rpc_tlv5_snapshot()`                                      |
| Adjudication queue    | adjudicator  | `v_tlv5_adjudication_queue` (both answers and detail codes per item, never a label; PILOT and TRAINING items any time, FORMAL items after the close and the snapshot; filter on `mode`), `tlv5_cases`, `tlv5_submission_items` (notes)                                  | `rpc_tlv5_record_adjudication({case_id, item_code, decision, detail_code, status, basis, rationale, disagreement_reason_code})`      |
| Lock and export       | investigator | `v_tlv5_independent_judgments`, `v_tlv5_adjudicated_reference`, `v_tlv5_frozen_labels`, `rpc_tlv5_verify_frozen_labels()`                                                                                                                                               | `rpc_tlv5_lock_reference(mode)`, `rpc_tlv5_register_export(manifest)`                                                                |

The trial form must show each subgroup question only while the reviewer's own answer to the matching row (Diabetes Mellitus; Neoplasms) is YES, and must drop the subgroup answer if the reviewer changes the row answer; the database refuses a submission that breaks this rule, and refuses any submission missing one of the 17 area and row items. There is no server-side draft in v5: a draft lives in the browser until the reviewer submits; each submit is a new revision.

## 4. Order of operations (each step is refused by the database when out of order)

1. Pilot (PILOT mode, before activation): import 10 SYN- trials with design rows and pilot labels; assign both pilot accounts; both submit; plant one disagreement; the adjudicator (or an investigator) adjudicates it; `rpc_tlv5_lock_reference('PILOT')`; export the pilot bundle and run `performance_analysis_v5 --allow-pilot`; register the export; `rpc_tlv5_phase('PILOT_SIGNED_OFF', {checklist_version, checklist_sha256, app_git_sha, pilot_export_id, attestation})`.
2. `rpc_tlv5_activate(design_version, 'DISAGREEMENTS_ONLY', attestation)`. Refused while design v4 is active or any active FORMAL v2/v3/v4 case exists.
3. Enrol the two formal reviewers (`rpc_tlv5_enroll_reviewer`); optional calibration on CAL5- trials (`mode = 'CALIBRATION'`, no design row).
4. Training (v5.1): import the three EX5- worked examples (`mode = 'TRAINING'`, no design row, no label; the packet must show `trial.nct_id`); assign them with `rpc_tlv5_assign('TRAINING', pseudonym, slot, case_ids, seed)`; submissions, the adjudicator queue and `rpc_tlv5_record_adjudication` work as in the pilot; `rpc_tlv5_lock_reference('TRAINING')`. Training is refused before activation and once the formal phase opens; run it before the freeze when possible.
5. Import the 100 TLV5- trials with their design rows and the frozen labels; `rpc_tlv5_freeze({label_file_sha256, frozen_items, attestation})`; check `rpc_tlv5_verify_frozen_labels()` and compare the freeze hashes with the private freeze manifest.
6. `rpc_tlv5_phase('FORMAL_OPENED')`; assign each reviewer all trials with a recorded seed (`rpc_tlv5_assign('FORMAL', pseudonym, slot, case_ids, seed)`).
7. Close; snapshot; adjudication; lock; export the three views and the manifest; register the export.

## 5. Packet builder

The packet is JSON with top-level keys `schema_version`, `case_title`, `trial`, `notices` only; `trial` may hold `nct_id` (v5.1: the trial's identifier, exactly once, `NCT` and 8 digits, or `SYN-NCT-` and 4 to 8 digits for synthetic cases; equal to the design row), `brief_title`, `official_title`, `conditions_registered`, `condition_mesh_headings` (names only), `brief_summary`, `interventions` (`intervention_type`, `name`, `description`), `eligibility_age_range` (`minimum_age`, `maximum_age`). The database refuses any other key at any depth, a second or misplaced `nct_id`, any other key that looks like a label, design, sex, enrollment, count, result, tree number, NCT or link field, and any value containing a ClinicalTrials.gov address (`private.assert_tlv5_packet_blinded`, as replaced by 0005). Show the identifier as plain text, never as a link. Build packets from the registry fields of the trial; do not paraphrase registry text.

## 6. What the app must never do

1. Show a label, a design field, the other reviewer's answers or an adjudication to a reviewer.
2. Show a label or design field to the adjudicator.
3. Let an investigator enter or edit a FORMAL judgment or adjudication, or read FORMAL answers while the phase is open (the audit log holds identifiers and hashes only).
4. Put a registry link or address in a packet, or render the NCT identifier as a link.
5. Show a training example in the reviewer queue, export a training answer, or seed the illustrative training answers under a real person's account (staging test accounts only).
6. Import a v5 trial into the v2/v3/v4 case tables (refused once v5 is active).
7. Overwrite or delete any v5 row (every v5 table is append-only).

## 7. Worked training examples in staging (v5.1)

The private file `worked_examples_v5.json` (placed in `data_private/`, never committed) holds, for each example, the `rpc_tlv5_import_case` payload, the two `rpc_tlv5_submit` payloads, the adjudicator queue item that must appear, the `rpc_tlv5_record_adjudication` payload and the training reference expected after the lock. Seed them in staging with three test accounts (STAGING_REVIEWER_SLOT_1, STAGING_REVIEWER_SLOT_2 with FORMAL scope, STAGING_ADJUDICATOR), through the same RPCs as the app; example 3 must appear in the adjudicator queue (one item, AREA_RESPIRATORY, YES against NO), be adjudicated by the test adjudicator, and the training lock must then succeed. The private script `scripts/07_db_training_dryrun_v5.mjs` runs this sequence on PGlite.

## 8. Known limitations

1. A reviewer who withdraws cannot be replaced in the same slot; the close is then INCOMPLETE and the single-reviewed items are adjudicated as SINGLE_REVIEW_ADJUDICATED. Replacement needs a protocol amendment and a schema change.
2. Tested on PGlite only. Live PostgreSQL 16 and Supabase tests, with the five staging accounts, are required before the formal unlock.
