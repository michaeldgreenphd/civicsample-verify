-- =============================================================================
-- supabase_test_shim/mu7x_gates_specified_test_only.sql
-- MU7X-TEST-ONLY-GATE-SPECIFICATION. NEVER apply this file to a Supabase project or any shared
-- database, and never read it as a study decision. It exists only so the supplied v7 suite
-- (tests/handoff/v7.mjs), which predates migration 0026, can still exercise every supplied
-- behaviour in a disposable test database: it records a SYNTHETIC version 2 of each gate
-- requirement that blocks nothing and names the suite's own synthetic evidence string. The real
-- requirements stay PENDING_SPECIFICATION (0026) until the investigator decides them. The hosted
-- bootstrap plan refuses any file that carries the marker on the first line of this comment.
-- =============================================================================
insert into public.mu7_gate_requirements (gate_id, requirement_version, blocks, requirement_status, question,
                                           decision_reference, source)
select r.gate_id, r.requirement_version + 1, array[]::text[], 'SPECIFIED', r.question,
       'synthetic decision record', 'SYNTHETIC test shim, disposable databases only'
from public.mu7_gate_requirements r
where r.requirement_version = (select max(x.requirement_version) from public.mu7_gate_requirements x where x.gate_id = r.gate_id);
