-- =============================================================================
-- migrations/0028_v7_gate_specifications_v8_1.sql
-- Engineering message v8.1 (2026-10-23): two gate facts for review design v7. This migration
-- records them as specified requirements so that an investigator can approve each gate in the
-- application, naming its decision record. It approves nothing: mu7_gate_approvals is untouched,
-- and migration 0026 refuses an approval that does not name the record below (MU7X-G08) and any
-- approval by a non-investigator.
--
--   G-PAIN-01  Investigator decision of 2026-10-23, addendum 8, item 40: the Pain row stays a
--              descriptive row of Figure 2, not modeled; the four Pain units stay in the sample
--              with their row-membership display; the investigator may approve the gate in the
--              app. Rubric revision 1 (docs/design_v7/RUBRIC_PROVENANCE_v7.md) drops the word
--              "provisional". What it holds is unchanged: the formal opening (0026), and the
--              freeze of the Pain units through 0024's MU7-G29 until the approval exists.
--   G-MH-V53   Supporting evidence, not an approval: the G-MH-V53 check of 2026-10-23 (run 2,
--              SHA-256 below) found the v7 Mental health set equal to the v5.3 area flags
--              (1,608 trials, none in only one set) under investigator decision 37. The approval
--              stays the investigator's. What it holds is unchanged: the freeze and the opening.
--
-- Every other gate stays PENDING_SPECIFICATION, so the FORMAL freeze and the formal opening stay
-- disabled (G-PROV-01, G-OVERLAP-01 and G-TEXT-01 hold the freeze; those and G-OQ-03, G-OQ-04 and
-- G-EST-01 hold the opening). Additive: two new requirement versions; nothing is altered.
-- =============================================================================
begin;

insert into public.app_schema_version (version, description)
values ('7.0.3-v7-gate-specifications-v8-1', 'G-PAIN-01 and G-MH-V53 requirements specified with their decision records (engineering message v8.1); no approval recorded');

insert into public.mu7_gate_requirements (gate_id, requirement_version, blocks, requirement_status, question,
                                          decision_reference, source)
values ( 'G-PAIN-01', 2, array['FORMAL_OPEN'], 'SPECIFIED',
       'Pain row: a descriptive row of Figure 2 (not modeled); the four Pain units keep their row-membership display.',
       'investigator decisions 2026-10-23, addendum 8, item 40',
       'engineering message v8.1, item 1');

insert into public.mu7_gate_requirements (gate_id, requirement_version, blocks, requirement_status, question,
                                          decision_reference, source)
values ( 'G-MH-V53', 2, array['FREEZE', 'FORMAL_OPEN'], 'SPECIFIED',
       'Mental health frame equals the v5.3 area flags (decision 37).',
       'investigator decision 37 with the G-MH-V53 check of 2026-10-23, run 2 (SHA-256 7c66e1b098c5cfde2f322f443c3412fd7e766d00e87c83f674e5eed1cc1fd46e)',
       'engineering message v8.1, item 2');

commit;
