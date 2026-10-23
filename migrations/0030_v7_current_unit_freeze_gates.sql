-- =============================================================================
-- migrations/0030_v7_current_unit_freeze_gates.sql
-- Independent review of PR #11 (reviewed commit 3d414f9): 0024's MU7-G29 lets a unit that waits
-- for a gate into the freeze once any approval row exists in mu7_gate_approvals. Since 0029 an
-- approval belongs to one requirement version, so after a re-specification of G-PAIN-01 the old
-- approval no longer satisfies the gate (rpc_mu7_gate_status reports satisfied = false), yet
-- MU7-G29 still let the four Pain units be frozen. Reproduced in tests/mu7-gates-v8-1.test.ts.
--
-- This migration adds a check after MU7-G29 (0024 stays byte-identical): a FORMAL unit held at the
-- freeze by a gate (freeze_status BLOCKED_PENDING_GATE) whose requirements are recorded in
-- mu7_gate_requirements is frozen only when that gate's latest requirement is SPECIFIED and has an
-- approval of that version naming its decision record (MU7X-G10). A gate without recorded
-- requirements keeps MU7-G29 as its only rule. Nothing is relaxed; nothing is approved.
-- =============================================================================
begin;

insert into public.app_schema_version (version, description)
values ('7.0.5-v7-current-unit-freeze-gates', 'units held by a gate are frozen only with an approval of that gate''s current specified requirement');

-- True when the gate's latest requirement is SPECIFIED and approved in that version, naming its record.
create function private.mu7x_gate_current_approved(p_gate_id text) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((
    select l.requirement_status = 'SPECIFIED' and v.gate_id is not null
           and v.evidence_reference is not distinct from l.decision_reference
    from (select r.* from public.mu7_gate_requirements r where r.gate_id = p_gate_id
          order by r.requirement_version desc limit 1) l
    left join public.mu7_gate_approval_versions v
      on v.gate_id = l.gate_id and v.requirement_version = l.requirement_version), false)
$$;

create function private.mu7x_unit_freeze_gates() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  waiting text;
begin
  select string_agg(distinct x.freeze_gate, ', ' order by x.freeze_gate) into waiting
  from public.mu7_unit_design x
  where x.mode = 'FORMAL' and x.freeze_status = 'BLOCKED_PENDING_GATE'
    and exists (select 1 from public.mu7_gate_requirements r where r.gate_id = x.freeze_gate)
    and not private.mu7x_gate_current_approved(x.freeze_gate);
  if waiting is not null then
    raise exception 'MU7X-G10: units wait for an approval of the current requirement of their gate: %', waiting;
  end if;
  return new;
end $$;
-- After 0024's mu7_freeze_before_insert (MU7-G26 to G29) and before 0026's z20 gate check.
create trigger z15_mu7x_unit_freeze_gates before insert on public.mu7_freeze
  for each row execute function private.mu7x_unit_freeze_gates();

revoke all on function private.mu7x_gate_current_approved(text), private.mu7x_unit_freeze_gates()
  from public, anon, authenticated, service_role;

commit;
