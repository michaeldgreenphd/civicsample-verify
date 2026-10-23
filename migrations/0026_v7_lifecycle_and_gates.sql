-- =============================================================================
-- migrations/0026_v7_lifecycle_and_gates.sql
-- Second review round on migrations 0024 (the supplied v7 migration, byte-identical) and 0025:
-- the independent review of PR #8 (4e20ea0) and the automated review of PR #9 (f741d25). Each
-- defect was reproduced on this repository's full chain first (tests/mu7-lifecycle.test.ts runs
-- every check without and with 0026; native races in tests/mu7-postgres.test.ts). Additive: no
-- table, view, policy or guard of 0024 or 0025 is dropped or relaxed. The one replaced object is
-- 0025's own serialization trigger on mu7_adjudications, which becomes exclusive (stricter).
--
--   1. Empty pilot. 0024's PILOT lock refuses only units without two answers, so with zero pilot
--      units the investigator could lock, export an empty bundle and sign off without a pilot.
--      The PILOT lock now needs a nonempty inventory with at least one primary unit and both
--      reviewer slots assigned on every unit; the PILOT export must state the locked unit count;
--      the sign-off must name an export of exactly that locked inventory.
--   2. Pilot import after the pilot lock. 0024 stops pilot imports only at the sign-off, so a unit
--      added between lock and sign-off was outside the attested inventory. Refused after the lock
--      (serialized with the lock by 0025's lock: imports share it, locks take it exclusively).
--   3. Scientific gates. 0024 opens the formal phase on the sign-off, the freeze and the queues,
--      without the approvals of PENDING_DECISIONS_v7.md. The exact approval requirement of each
--      gate is not yet specified by the investigator, so the documented state is enforced: every
--      gate's requirement is PENDING_SPECIFICATION, which keeps the FORMAL freeze and the formal
--      opening disabled. A requirement becomes SPECIFIED only through a later reviewed migration
--      naming the decision record; an approval counts only when its evidence_reference names that
--      decision record and it was recorded after the specification; an approval of a pending gate is
--      refused, since an approval cannot be replaced. Which operation each gate blocks follows the
--      table of PENDING_DECISIONS_v7.md and is itself an engineering proposal for the investigator to
--      confirm. Nothing here creates a specified requirement or an approval, and none is inferred.
--   4. Adjudication against revisions (PR #9 review). 0025 took the shared lock on adjudications,
--      so a PILOT revision and the first adjudication of the same unit could both commit and leave
--      a stale tie-break. Adjudications now take the exclusive lock.
-- =============================================================================
begin;

insert into public.app_schema_version (version, description)
values ('7.0.2-v7-lifecycle-and-gates', 'v7 lifecycle: nonempty bound pilot inventory, no pilot import after the pilot lock, freeze and formal opening gated by specified and approved study decisions, exclusive adjudication lock');

-- -----------------------------------------------------------------------------
-- 1. The pilot inventory: nonempty, dually assigned, bound through export and sign-off
-- -----------------------------------------------------------------------------
create function private.mu7x_pilot_lock_inventory() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  n_units integer; n_primary integer; n_short integer;
begin
  if new.mode <> 'PILOT' then
    return new;
  end if;
  select count(*), count(*) filter (where u.unit_role = 'PRIMARY'),
         count(*) filter (where (select count(distinct q.reviewer_slot) from public.mu7_queue q
                                  where q.unit_id = u.unit_id and q.mode = 'PILOT') <> 2)
    into n_units, n_primary, n_short
  from public.mu7_units u where u.mode = 'PILOT';
  if n_units = 0 or n_primary = 0 then
    raise exception 'MU7X-G02: the PILOT reference cannot lock an empty pilot (% units, % primary)', n_units, n_primary;
  end if;
  if n_short > 0 then
    raise exception 'MU7X-G02: % PILOT units are not assigned to both reviewer slots', n_short;
  end if;
  return new;
end $$;
create trigger z20_mu7x_pilot_lock_inventory before insert on public.mu7_reference_locks
  for each row execute function private.mu7x_pilot_lock_inventory();

create function private.mu7x_pilot_export_inventory() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  n_locked integer;
begin
  -- Another bundle format is refused by 0024's mu7_exports_format_ck; leave that refusal to it.
  if new.mode <> 'PILOT' or new.bundle_format_version is distinct from '7.0' then
    return new;
  end if;
  select l.n_units_locked into n_locked from public.mu7_reference_locks l where l.mode = 'PILOT';
  if n_locked is null or (new.row_counts ->> 'units') is distinct from n_locked::text then
    raise exception 'MU7X-G03: a PILOT export states the % locked pilot units in row_counts.units', coalesce(n_locked, 0);
  end if;
  return new;
end $$;
create trigger z20_mu7x_pilot_export_inventory before insert on public.mu7_exports
  for each row execute function private.mu7x_pilot_export_inventory();

create function private.mu7x_signoff_inventory() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  n_locked integer; exported text; n_now integer;
begin
  if new.event_type <> 'PILOT_SIGNED_OFF' then
    return new;
  end if;
  select l.n_units_locked into n_locked from public.mu7_reference_locks l where l.mode = 'PILOT';
  select e.row_counts ->> 'units' into exported from public.mu7_exports e
   where e.export_id = new.pilot_export_id and e.mode = 'PILOT';
  select count(*) into n_now from public.mu7_units u where u.mode = 'PILOT';
  if n_locked is null or n_locked = 0 or exported is distinct from n_locked::text or n_now <> n_locked then
    raise exception 'MU7X-G04: the sign-off names a PILOT export of the locked pilot inventory (locked %, exported %, now %)',
      coalesce(n_locked, 0), coalesce(exported, 'none'), n_now;
  end if;
  return new;
end $$;
create trigger z20_mu7x_signoff_inventory before insert on public.mu7_phase_events
  for each row execute function private.mu7x_signoff_inventory();

-- -----------------------------------------------------------------------------
-- 2. No pilot unit after the pilot lock
-- -----------------------------------------------------------------------------
create function private.mu7x_no_pilot_import_after_lock() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.mode = 'PILOT' and exists (select 1 from public.mu7_reference_locks l where l.mode = 'PILOT') then
    raise exception 'MU7X-G05: the PILOT reference is locked; pilot unit % cannot be added', new.unit_id;
  end if;
  return new;
end $$;
create trigger z20_mu7x_no_pilot_import_after_lock before insert on public.mu7_units
  for each row execute function private.mu7x_no_pilot_import_after_lock();

-- -----------------------------------------------------------------------------
-- 3. Study-decision gates: specified requirements and matching approvals
-- -----------------------------------------------------------------------------
create table public.mu7_gate_requirements (
  gate_id              text not null check (gate_id ~ '^G-[A-Z0-9-]{2,30}$'),
  requirement_version  integer not null check (requirement_version >= 1),
  blocks               text[] not null check (blocks <@ array['FREEZE', 'FORMAL_OPEN']::text[]),
  requirement_status   text not null check (requirement_status in ('PENDING_SPECIFICATION', 'SPECIFIED')),
  question             text not null check (length(question) between 10 and 400),
  decision_reference   text check (decision_reference is null or length(decision_reference) between 3 and 400),
  source               text not null check (length(source) between 3 and 200),
  recorded_at          timestamptz not null default now(),
  primary key (gate_id, requirement_version),
  check ((requirement_status = 'SPECIFIED') = (decision_reference is not null))
);
alter table public.mu7_gate_requirements enable row level security;
create policy mu7_gate_requirements_read on public.mu7_gate_requirements for select to authenticated
  using (private.is_investigator());
revoke all on public.mu7_gate_requirements from public, anon, authenticated, service_role;
grant select on public.mu7_gate_requirements to authenticated;
create trigger mu7_gate_requirements_append_only before update or delete on public.mu7_gate_requirements
  for each row execute function private.reject_mutation();
create trigger mu7_gate_requirements_no_truncate before truncate on public.mu7_gate_requirements
  for each statement execute function private.reject_mutation();

-- The documented state (design_v7/PENDING_DECISIONS_v7.md, 2026-10-23): no requirement is specified.
insert into public.mu7_gate_requirements (gate_id, requirement_version, blocks, requirement_status, question, source) values
  ('G-PAIN-01', 1, array['FORMAL_OPEN'], 'PENDING_SPECIFICATION', 'Reconcile the Pain row benchmark conflict (addendum 6, item 28); the Pain units are also held at the freeze by MU7-G29.', 'PENDING_DECISIONS_v7.md'),
  ('G-MH-V53', 1, array['FREEZE', 'FORMAL_OPEN'], 'PENDING_SPECIFICATION', 'Mental health frame equals the v5.3 area flags (decision 37).', 'PENDING_DECISIONS_v7.md'),
  ('G-PROV-01', 1, array['FREEZE', 'FORMAL_OPEN'], 'PENDING_SPECIFICATION', 'Apply the trial-level provenance rules PV04 to PV08 (frame and draw).', 'PENDING_DECISIONS_v7.md'),
  ('G-PROV-02', 1, array[]::text[], 'PENDING_SPECIFICATION', 'Keep descriptor-level development links (PV09) eligible; blocks nothing until changed.', 'PENDING_DECISIONS_v7.md'),
  ('G-PROV-03', 1, array[]::text[], 'PENDING_SPECIFICATION', 'Keep the six former calibration trials excluded (PV03); blocks nothing until changed.', 'PENDING_DECISIONS_v7.md'),
  ('G-OVERLAP-01', 1, array['FREEZE', 'FORMAL_OPEN'], 'PENDING_SPECIFICATION', 'May one trial hold units in two strata (the draw and the analysis weights)?', 'PENDING_DECISIONS_v7.md'),
  ('G-TEXT-01', 1, array['FREEZE', 'FORMAL_OPEN'], 'PENDING_SPECIFICATION', 'Display texts and reason codes of the removed subgroup outcomes (hashed at the freeze).', 'PENDING_DECISIONS_v7.md'),
  ('G-OQ-03', 1, array['FORMAL_OPEN'], 'PENDING_SPECIFICATION', 'Depression policy text in the rubric (OQ-03).', 'PENDING_DECISIONS_v7.md'),
  ('G-OQ-04', 1, array['FORMAL_OPEN'], 'PENDING_SPECIFICATION', 'Smoking cessation policy text in the rubric (OQ-04).', 'PENDING_DECISIONS_v7.md'),
  ('G-EST-01', 1, array['FORMAL_OPEN'], 'PENDING_SPECIFICATION', 'Estimator details: interval rule, single-review units, trial clustering, ROW_BENCHMARKED secondary.', 'PENDING_DECISIONS_v7.md');
-- Every later requirement (a specification, from a reviewed migration) is audited. The seed above is the documented
-- starting state and is not, so an upgrade of an existing database adds no audit row of its own.
create trigger mu7_gate_requirements_audit after insert on public.mu7_gate_requirements
  for each row execute function private.audit_row_mu7();

-- Effective requirement per gate (latest version) and whether it is satisfied; investigator only.
-- (A function, not a v_mu7_ view: the supplied suite counts the six v7 views by that name pattern.)
create function public.rpc_mu7_gate_status()
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
         a.approved_at, a.evidence_reference,
         (l.requirement_status = 'SPECIFIED' and a.gate_id is not null
          and a.evidence_reference is not distinct from l.decision_reference
          and a.approved_at >= l.recorded_at)
  from latest l
  left join public.mu7_gate_approvals a on a.gate_id = l.gate_id
  order by l.gate_id;
end $$;
revoke all on function public.rpc_mu7_gate_status() from public, anon, authenticated, service_role;
grant execute on function public.rpc_mu7_gate_status() to authenticated;

create function private.mu7x_unsatisfied_gates(p_operation text) returns text
language sql stable security definer set search_path = '' as $$
  with latest as (
    select distinct on (r.gate_id) r.* from public.mu7_gate_requirements r
    order by r.gate_id, r.requirement_version desc
  )
  select string_agg(l.gate_id || ' (' || case
           when l.requirement_status <> 'SPECIFIED' then 'requirement pending specification'
           when a.gate_id is null then 'not approved'
           else 'approval does not name the specified decision record' end || ')', ', ' order by l.gate_id)
  from latest l left join public.mu7_gate_approvals a on a.gate_id = l.gate_id
  where p_operation = any (l.blocks)
    and not (l.requirement_status = 'SPECIFIED' and a.gate_id is not null
             and a.evidence_reference is not distinct from l.decision_reference
             and a.approved_at >= l.recorded_at)
$$;
revoke all on function private.mu7x_unsatisfied_gates(text) from public, anon, authenticated, service_role;

create function private.mu7x_freeze_gates() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  missing text := private.mu7x_unsatisfied_gates('FREEZE');
begin
  if missing is not null then
    raise exception 'MU7X-G06: the FORMAL freeze is disabled until these study decisions are specified and approved: %', missing;
  end if;
  return new;
end $$;
create trigger z20_mu7x_freeze_gates before insert on public.mu7_freeze
  for each row execute function private.mu7x_freeze_gates();

create function private.mu7x_formal_open_gates() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  missing text;
begin
  if new.event_type <> 'FORMAL_OPENED' then
    return new;
  end if;
  missing := private.mu7x_unsatisfied_gates('FORMAL_OPEN');
  if missing is not null then
    raise exception 'MU7X-G07: the formal phase stays closed until these study decisions are specified and approved: %', missing;
  end if;
  return new;
end $$;
create trigger z21_mu7x_formal_open_gates before insert on public.mu7_phase_events
  for each row execute function private.mu7x_formal_open_gates();

-- An approval counts once and cannot be replaced (mu7_gate_approvals.gate_id is the key), so an approval recorded before
-- its requirement is specified, or naming another decision record, would block the gate for good. Refuse both.
create function private.mu7x_gate_approval_specified() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  r record;
begin
  select * into r from public.mu7_gate_requirements g where g.gate_id = new.gate_id
   order by g.requirement_version desc limit 1;
  if found and r.requirement_status <> 'SPECIFIED' then
    raise exception 'MU7X-G08: gate % cannot be approved while its requirement is pending specification', new.gate_id;
  end if;
  if found and new.evidence_reference is distinct from r.decision_reference then
    raise exception 'MU7X-G08: an approval of gate % names its specified decision record as evidence_reference', new.gate_id;
  end if;
  return new;
end $$;
create trigger z20_mu7x_gate_approval_specified before insert on public.mu7_gate_approvals
  for each row execute function private.mu7x_gate_approval_specified();

revoke all on function private.mu7x_gate_approval_specified(), private.mu7x_pilot_lock_inventory(), private.mu7x_pilot_export_inventory(),
  private.mu7x_signoff_inventory(), private.mu7x_no_pilot_import_after_lock(), private.mu7x_freeze_gates(),
  private.mu7x_formal_open_gates()
  from public, anon, authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 4. Adjudications conflict exclusively with judgment inserts
-- -----------------------------------------------------------------------------
drop trigger a00_mu7_serialize on public.mu7_adjudications;
create trigger a00_mu7_serialize before insert on public.mu7_adjudications
  for each row execute function private.mu7_serialize_transition();

commit;
