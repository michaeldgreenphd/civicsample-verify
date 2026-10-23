-- =============================================================================
-- migrations/0029_v7_versioned_gate_approvals.sql
-- Codex review of PR #11 (reviewed commit f2e3db2): mu7_gate_approvals (0024) is keyed by gate, and
-- 0026 counts an approval only for the requirement version current when it was given. Once a gate
-- is approved, a later reviewed re-specification (a new requirement version) could never be
-- approved again, so that gate would block the formal workflow for good. Reproduced in
-- tests/mu7-gates-v8-1.test.ts.
--
-- This migration keys approvals to requirement versions, append-only: public.mu7_gate_approval_versions
-- holds one approval per (gate, requirement version). rpc_mu7_approve_gate (same signature) records
-- the first approval of a gate in mu7_gate_approvals as before (0024's MU7-G29 and 0026's MU7X-G08
-- still check it) and, for a gate with recorded requirements, an approval of its current version.
-- A re-approval after a re-specification adds a row for the new version only; nothing is updated or
-- deleted. A gate counts as satisfied only through an approval of its latest SPECIFIED version that
-- names that version's decision record (MU7X-G09). Approvals that exist already are carried over to
-- the version they approved. This approves nothing new.
-- =============================================================================
begin;

insert into public.app_schema_version (version, description)
values ('7.0.4-v7-versioned-gate-approvals', 'gate approvals keyed to requirement versions (append-only re-approval after a re-specification)');

create table public.mu7_gate_approval_versions (
  gate_id              text not null,
  requirement_version  integer not null,
  attestation          text not null check (length(attestation) >= 20),
  evidence_reference   text not null check (length(evidence_reference) between 3 and 400),
  approved_at          timestamptz not null default now(),
  approved_by          uuid not null references public.users (user_id),
  primary key (gate_id, requirement_version),
  foreign key (gate_id, requirement_version) references public.mu7_gate_requirements (gate_id, requirement_version)
);
alter table public.mu7_gate_approval_versions enable row level security;
create policy mu7_gate_approval_versions_read on public.mu7_gate_approval_versions for select to authenticated
  using (private.is_investigator());
revoke all on public.mu7_gate_approval_versions from public, anon, authenticated, service_role;
grant select on public.mu7_gate_approval_versions to authenticated;
create trigger mu7_gate_approval_versions_append_only before update or delete on public.mu7_gate_approval_versions
  for each row execute function private.reject_mutation();
create trigger mu7_gate_approval_versions_no_truncate before truncate on public.mu7_gate_approval_versions
  for each statement execute function private.reject_mutation();

-- Carry over approvals given before this migration, to the requirement version current at the time.
insert into public.mu7_gate_approval_versions (gate_id, requirement_version, attestation, evidence_reference,
                                               approved_at, approved_by)
select a.gate_id, r.requirement_version, a.attestation, a.evidence_reference, a.approved_at, a.approved_by
from public.mu7_gate_approvals a
join lateral (
  select x.requirement_version, x.requirement_status, x.decision_reference from public.mu7_gate_requirements x
  where x.gate_id = a.gate_id and x.recorded_at <= a.approved_at
  order by x.requirement_version desc limit 1
) r on true
where r.requirement_status = 'SPECIFIED' and a.evidence_reference is not distinct from r.decision_reference;

-- An approval of a version must be the investigator's, of the latest SPECIFIED version, naming its record.
create function private.mu7x_gate_approval_version_check() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  r record;
begin
  if (select u.role from public.users u where u.user_id = new.approved_by) is distinct from 'INVESTIGATOR' then
    raise exception 'MU7X-G09: only the investigator approves a study-decision gate';
  end if;
  select * into r from public.mu7_gate_requirements g where g.gate_id = new.gate_id
   order by g.requirement_version desc limit 1;
  if not found or r.requirement_version <> new.requirement_version or r.requirement_status <> 'SPECIFIED'
     or new.evidence_reference is distinct from r.decision_reference then
    raise exception 'MU7X-G09: an approval names the latest specified requirement of gate % and its decision record', new.gate_id;
  end if;
  new.approved_at := now();
  return new;
end $$;
create trigger a00_mu7_serialize before insert on public.mu7_gate_approval_versions
  for each row execute function private.mu7_serialize_write();
create trigger z20_mu7x_gate_approval_version_check before insert on public.mu7_gate_approval_versions
  for each row execute function private.mu7x_gate_approval_version_check();
create trigger mu7_gate_approval_versions_audit after insert on public.mu7_gate_approval_versions
  for each row execute function private.audit_row_mu7();

create or replace function public.rpc_mu7_approve_gate(p_gate_id text, p_attestation text, p_evidence_reference text default null)
returns text
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := private.assert_investigator();
  latest record;
begin
  select * into latest from public.mu7_gate_requirements r where r.gate_id = p_gate_id
   order by r.requirement_version desc limit 1;
  -- The first approval of a gate, as 0024 records it (0024's MU7-G29 and 0026's MU7X-G08 check it).
  if not exists (select 1 from public.mu7_gate_approvals a where a.gate_id = p_gate_id) then
    insert into public.mu7_gate_approvals (gate_id, attestation, evidence_reference, approved_by)
    values (p_gate_id, p_attestation, p_evidence_reference, me);
  elsif latest.gate_id is null then
    -- A gate without requirements is approved once, as before.
    raise exception 'MU7X-G09: gate % is already approved', p_gate_id using errcode = '23505';
  end if;
  -- The approval of the gate's current requirement version (a re-approval after a re-specification).
  if latest.gate_id is not null then
    insert into public.mu7_gate_approval_versions (gate_id, requirement_version, attestation, evidence_reference, approved_by)
    values (p_gate_id, latest.requirement_version, p_attestation, coalesce(p_evidence_reference, ''), me);
  end if;
  return p_gate_id;
end $$;

-- Satisfaction: an approval of the latest SPECIFIED version naming its decision record.
create or replace function public.rpc_mu7_gate_status()
returns table (gate_id text, requirement_version integer, blocks text[], requirement_status text, question text,
               decision_reference text, approved_at timestamptz, approval_evidence_reference text, satisfied boolean)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.assert_investigator();
  return query
  with latest as (
    select distinct on (r.gate_id) r.* from public.mu7_gate_requirements r
    order by r.gate_id, r.requirement_version desc
  )
  select l.gate_id, l.requirement_version, l.blocks, l.requirement_status, l.question, l.decision_reference,
         v.approved_at, v.evidence_reference,
         (l.requirement_status = 'SPECIFIED' and v.gate_id is not null
          and v.evidence_reference is not distinct from l.decision_reference)
  from latest l
  left join public.mu7_gate_approval_versions v
    on v.gate_id = l.gate_id and v.requirement_version = l.requirement_version
  order by l.gate_id;
end $$;

create or replace function private.mu7x_unsatisfied_gates(p_operation text) returns text
language sql stable security definer set search_path = '' as $$
  with latest as (
    select distinct on (r.gate_id) r.* from public.mu7_gate_requirements r
    order by r.gate_id, r.requirement_version desc
  )
  select string_agg(l.gate_id || ' (' || case
           when l.requirement_status <> 'SPECIFIED' then 'requirement pending specification'
           when v.gate_id is null then 'not approved'
           else 'approval does not name the specified decision record' end || ')', ', ' order by l.gate_id)
  from latest l
  left join public.mu7_gate_approval_versions v
    on v.gate_id = l.gate_id and v.requirement_version = l.requirement_version
  where p_operation = any (l.blocks)
    and not (l.requirement_status = 'SPECIFIED' and v.gate_id is not null
             and v.evidence_reference is not distinct from l.decision_reference)
$$;

revoke all on function private.mu7x_gate_approval_version_check(), private.mu7x_unsatisfied_gates(text)
  from public, anon, authenticated, service_role;
revoke all on function public.rpc_mu7_gate_status(), public.rpc_mu7_approve_gate(text, text, text)
  from public, anon, service_role;
grant execute on function public.rpc_mu7_gate_status(), public.rpc_mu7_approve_gate(text, text, text) to authenticated;

commit;
