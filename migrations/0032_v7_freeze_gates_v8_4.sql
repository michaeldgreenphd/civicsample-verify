-- =============================================================================
-- migrations/0032_v7_freeze_gates_v8_4.sql
-- Engineering messages v8.3 (gate G-PAIN-01) and v8.4 (clarifications, section 1), and the
-- investigator's instruction of 2026-10-24 on G-EST-01. Three study-decision gates now hold the
-- FORMAL freeze as well as the formal opening, and G-PAIN-01 is re-specified with its full
-- decision record. This migration approves nothing: mu7_gate_approvals and
-- mu7_gate_approval_versions are untouched, and every approval stays the investigator's own act in
-- the application (0026, MU7X-G08; 0029, MU7X-G09).
--
--   G-OQ-03, G-OQ-04  Investigator decisions of 2026-10-22, item 2: the Depression and smoking
--                     cessation policy texts are confirmed before the freeze (v8.4, item 1.2). The
--                     texts themselves (rubric version 7.2) await the investigator's approval, so
--                     version 2 stays PENDING_SPECIFICATION: neither gate can be approved, and the
--                     freeze stays refused, until a later reviewed migration names the decision record.
--   G-EST-01          Investigator instruction of 2026-10-24: approval of the estimator details is a
--                     prerequisite for the freeze. The estimator itself is not approved (PROPOSED in
--                     EXPORT_TO_PERFORMANCE_SPEC_v7.md); version 2 stays PENDING_SPECIFICATION.
--   G-PAIN-01         Investigator decisions of 2026-10-23, addendum 11, item 60 (v8.3): addendum 8,
--                     item 40, with the Pain paragraph of rubric version 7.1, meets the decision
--                     requirement. Version 3 names that whole record; version 2 (0028) named item 40
--                     alone and came from v8.1, item 1, which v8.2 withdrew. What the gate holds is
--                     unchanged: the formal opening, and the four Pain units at the freeze (0024,
--                     MU7-G29; 0030, MU7X-G10) until the investigator approves version 3.
--
-- Unchanged: G-MH-V53, G-PROV-01, G-OVERLAP-01 and G-TEXT-01 hold the freeze and the opening
-- (0026, 0028); G-PROV-02 and G-PROV-03 hold nothing (0026). The questions of G-OQ-03, G-OQ-04 and
-- G-EST-01 are those of version 1. Additive: four new requirement versions; no function, trigger,
-- table or earlier row is altered, and the guards of 0026 and 0029 read the latest version.
-- =============================================================================
begin;

insert into public.app_schema_version (version, description)
values ('7.0.7-v7-freeze-gates-v8-4', 'G-OQ-03, G-OQ-04 and G-EST-01 hold the FORMAL freeze (still pending specification); G-PAIN-01 re-specified with addendum 11, item 60 and rubric 7.1; no approval recorded');

insert into public.mu7_gate_requirements (gate_id, requirement_version, blocks, requirement_status, question,
                                          decision_reference, source)
values ( 'G-OQ-03', 2, array['FREEZE', 'FORMAL_OPEN'], 'PENDING_SPECIFICATION',
       'Depression policy text in the rubric (OQ-03).',
       null,
       'investigator decisions 2026-10-22, item 2 (confirm before the freeze); engineering message v8.4, item 1.2');

insert into public.mu7_gate_requirements (gate_id, requirement_version, blocks, requirement_status, question,
                                          decision_reference, source)
values ( 'G-OQ-04', 2, array['FREEZE', 'FORMAL_OPEN'], 'PENDING_SPECIFICATION',
       'Smoking cessation policy text in the rubric (OQ-04).',
       null,
       'investigator decisions 2026-10-22, item 2 (confirm before the freeze); engineering message v8.4, item 1.2');

insert into public.mu7_gate_requirements (gate_id, requirement_version, blocks, requirement_status, question,
                                          decision_reference, source)
values ( 'G-EST-01', 2, array['FREEZE', 'FORMAL_OPEN'], 'PENDING_SPECIFICATION',
       'Estimator details: interval rule, single-review units, trial clustering, ROW_BENCHMARKED secondary.',
       null,
       'investigator instruction of 2026-10-24: approval before the freeze; the estimator is not approved');

insert into public.mu7_gate_requirements (gate_id, requirement_version, blocks, requirement_status, question,
                                          decision_reference, source)
values ( 'G-PAIN-01', 3, array['FORMAL_OPEN'], 'SPECIFIED',
       'Pain row: a descriptive row of Figure 2 (not modeled), defined for reviewers by the Pain paragraph of rubric 7.1; the four Pain units keep their row-membership display.',
       'investigator decisions 2026-10-23, addendum 8, item 40, and addendum 11, item 60, with rubric 7.1 (SHA-256 9ab8d6a9aa146b648358c7f3993068a8963146861a5d0b04ae5d6e1bda60cf46)',
       'engineering message v8.3, items 1 and 2');

commit;
