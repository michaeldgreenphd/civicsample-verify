# App mapping, review design v7

Which screen uses which database object. Every write goes through an RPC; every read is filtered by row-level
security; the app adds no rule of its own and never decides what a role may see.

## Reviewer (Reviewer 1, Reviewer 2; pilot accounts PT-, formal accounts R-)

- Queue: `select * from v_mu7_my_queue order by queue_position` (assignment, position, unit role, answered, available).
  Subgroup units show as not available until every primary unit is answered.
- Unit screen: `rpc_mu7_get_unit(assignment_id)` returns the packet. Show the unit block exactly as stored: the mapping
  label, the assignment text, for a subgroup unit the parent row and the KEEP or REMOVE decision, and the Mental health
  note when present. Show the trial block with the registry link; show registry text as registered.
- Answer: `rpc_mu7_submit(assignment_id, {answer, reason_code, note, uncertain, seconds_on_unit})`. The reason-code list
  depends on the unit (REVIEW_RUBRIC_v7.md section 4); a DISAGREE needs a reason code and a note. A resubmission is a
  revision; show the reviewer their own last answer (`select * from mu7_judgments`, own rows only).
- Training: `select * from mu7_training_units` (read-only; render the worked example, never a form);
  `rpc_mu7_acknowledge_training()` records the optional timestamp.

## Adjudicator (tie-breaker only)

- Queue: `select * from v_mu7_adjudication_queue` (routed units only, with our assignment, both answers, reason codes,
  notes, uncertainty flags and the packet). FORMAL rows appear only after the close and the snapshot.
- Decision: `rpc_mu7_record_adjudication({unit_id, decision, reason_code, status, basis, disagreement_reason_code,
  rationale})`; status DISCORDANT_RESOLVED with AGREE or DISAGREE and the basis, or UNRESOLVED_ESCALATED with basis NONE.

## Investigator console (multi-factor session)

Design record, imports (`rpc_mu7_import_unit`, `rpc_mu7_import_training_unit`), gate approvals (`rpc_mu7_approve_gate`),
freeze (`rpc_mu7_freeze`, `rpc_mu7_verify_freeze`), queues (`rpc_mu7_assign_queue`), phase events (`rpc_mu7_phase`),
progress (`rpc_mu7_completion_summary`: counts only while the phase is open), snapshot (`rpc_mu7_snapshot`,
`rpc_mu7_verify_snapshot`), lock (`rpc_mu7_lock_reference`), export (the four export views and
`rpc_mu7_register_export`), reviewer enrolment (`rpc_mu7_enroll_reviewer` after the sign-off; pilot accounts through the
existing `rpc_enroll_reviewer(user, 'PILOT', ...)`).

## Error messages

Every refusal of the v7 database starts with its guard tag (MU7-Gnn:) or names its constraint (mu7_*_ck). Show the
message; never retry around it.
