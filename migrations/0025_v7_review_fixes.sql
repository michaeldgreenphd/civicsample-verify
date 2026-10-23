-- =============================================================================
-- migrations/0025_v7_review_fixes.sql
-- Engineering review of migration 0024 (review design v7, the supplied NNNN_v7_mapping_units.sql,
-- kept byte-identical). Each fix below was first reproduced on this repository's full chain
-- (tests/mu7-findings.test.ts; native race: tests/mu7-postgres.test.ts). Additive: no table,
-- view, policy or guard of 0024 is dropped or relaxed; one 0024 function (the audit writer) and one
-- 0002 helper (private.is_adjudicator) are replaced with the same signatures and stricter bodies,
-- as 0021 did for the other identity helpers.
--
--   1. Audit disclosure (blocker). 0024 writes each judgment's unsalted content hash into
--      audit_log, which the investigator reads while the formal phase is open; the inputs are
--      low-entropy (answer, flag, seconds), so the investigator could recover FORMAL answers by
--      enumeration. The audit row now carries a keyed digest (HMAC-SHA-256 under a key no
--      application role can read). The judgment row keeps its plain content_sha256, which row-level
--      security hides until the close. Adjudication audit rows get the same treatment.
--   2. Serialization (blocker). 0024 reads the phase, the freeze and the lock state in BEFORE INSERT
--      triggers without a lock, so under READ COMMITTED a submission that read OPEN can commit after
--      the close, after which the singleton snapshot never matches and every FORMAL export is
--      refused. Every v7 write now takes a shared transaction lock and every phase transition
--      (phase event, freeze, snapshot, reference lock, export) an exclusive one, before 0024's own
--      guard trigger reads the state (the same pattern as 0020 for mapping confirmation).
--   3. Account locks. 0021 made app_user_id, app_role, is_investigator and my_reviewer_pseudo_id
--      honour account_locks but not is_adjudicator, which 0024's read policies use: a locked
--      adjudicator's already-issued token kept reading v7 answers, units, queues and adjudications
--      (and the v3 to v5 adjudicator paths). is_adjudicator now honours the lock.
--   4. Smaller findings: each phase event type is recorded once, structurally (unique indexes; at
--      most one close); a PILOT unit that is already adjudicated takes no further answer (a revision
--      would leave the tie-break stale); service_role, which v7 never needs, holds no write
--      privilege on any v7 table.
-- Not changed here (reported to the package authors): the cross-design question with the
-- mapping-confirmation module, RPC-only queue guards, the unverifiable queue hash at the freeze,
-- the PILOT mode literal in rpc_mu7_record_adjudication, and the header of 0024.
-- =============================================================================
begin;

insert into public.app_schema_version (version, description)
values ('7.0.1-v7-review-fixes', 'v7 review fixes: keyed audit digests, phase serialization, lock-aware adjudicator, once-only phase events, no PILOT revision after adjudication, no service_role writes on v7 tables');

-- -----------------------------------------------------------------------------
-- 1. Keyed audit digests for v7 judgments and adjudications
-- -----------------------------------------------------------------------------
create table private.mu7_audit_key (
  singleton  boolean primary key default true check (singleton),
  audit_key  text not null check (audit_key ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now()
);
insert into private.mu7_audit_key (audit_key) values (encode(extensions.gen_random_bytes(32), 'hex'));
revoke all on private.mu7_audit_key from public, anon, authenticated, service_role;
create trigger mu7_audit_key_append_only before update or delete on private.mu7_audit_key
  for each row execute function private.reject_mutation();
create trigger mu7_audit_key_no_truncate before truncate on private.mu7_audit_key
  for each statement execute function private.reject_mutation();

create function private.mu7_audit_digest(p_content text) returns text
language sql stable security definer set search_path = '' as $$
  select encode(extensions.hmac(convert_to(coalesce(p_content, ''), 'UTF8'),
                                convert_to(k.audit_key, 'UTF8'), 'sha256'), 'hex')
  from private.mu7_audit_key k
$$;
revoke all on function private.mu7_audit_digest(text) from public, anon, authenticated, service_role;

-- Same signature and behaviour as 0024 except the two digest fields.
create or replace function private.audit_row_mu7() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  rec jsonb := to_jsonb(new);
  pk text;
  details jsonb;
begin
  pk := coalesce(rec ->> 'judgment_id', rec ->> 'adjudication_id', rec ->> 'assignment_id', rec ->> 'event_id',
                 rec ->> 'freeze_id', rec ->> 'snapshot_id', rec ->> 'lock_id', rec ->> 'export_id', rec ->> 'design_id',
                 rec ->> 'training_unit_id', rec ->> 'gate_id', rec ->> 'unit_id', rec ->> 'reviewer_pseudo_id');
  if tg_table_name = 'mu7_judgments' then
    details := jsonb_build_object('unit_id', rec ->> 'unit_id', 'reviewer_pseudo_id', rec ->> 'reviewer_pseudo_id',
                                  'revision_number', rec ->> 'revision_number',
                                  'content_hmac_sha256', private.mu7_audit_digest(rec ->> 'content_sha256'));
  elsif tg_table_name = 'mu7_adjudications' then
    details := jsonb_build_object('unit_id', rec ->> 'unit_id',
                                  'content_hmac_sha256', private.mu7_audit_digest(concat_ws('|', rec ->> 'decision',
                                    rec ->> 'reason_code', rec ->> 'status', rec ->> 'basis', rec ->> 'rationale')));
  elsif tg_table_name in ('mu7_units', 'mu7_training_units') then
    details := rec - 'packet';
  else
    details := rec;
  end if;
  insert into public.audit_log (actor_user_id, actor_role, action, entity_table, entity_id, mode, details)
  values (private.app_user_id(), coalesce(private.app_role(), current_user), tg_op, tg_table_name, pk, rec ->> 'mode', details);
  return null;
end $$;

-- -----------------------------------------------------------------------------
-- 2. Serialization of v7 writes against v7 phase transitions
-- -----------------------------------------------------------------------------
-- One transaction-level advisory lock key for the whole v7 module. Writers share it; transitions
-- take it exclusively, so a transition waits for in-flight writes to commit and later writes wait
-- for the transition, then 0024's guard trigger (which fires after these, by name order) reads the
-- committed state with a fresh statement snapshot.
create function private.mu7_serialize_write() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform pg_catalog.pg_advisory_xact_lock_shared(7024025);
  return new;
end $$;
create function private.mu7_serialize_transition() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform pg_catalog.pg_advisory_xact_lock(7024025);
  return new;
end $$;
revoke all on function private.mu7_serialize_write(), private.mu7_serialize_transition()
  from public, anon, authenticated, service_role;

do $$
declare
  t text;
begin
  foreach t in array array['mu7_units', 'mu7_unit_design', 'mu7_frozen_assignments', 'mu7_gate_approvals',
                           'mu7_queue', 'mu7_judgments', 'mu7_adjudications', 'mu7_training_units']
  loop
    execute format('create trigger a00_mu7_serialize before insert on public.%I for each row execute function private.mu7_serialize_write()', t);
  end loop;
  foreach t in array array['mu7_phase_events', 'mu7_freeze', 'mu7_snapshot', 'mu7_reference_locks', 'mu7_exports']
  loop
    execute format('create trigger a00_mu7_serialize before insert on public.%I for each row execute function private.mu7_serialize_transition()', t);
  end loop;
end $$;

-- -----------------------------------------------------------------------------
-- 3. The adjudicator helper honours account locks (as 0021 did for the other helpers)
-- -----------------------------------------------------------------------------
create or replace function private.is_adjudicator() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select u.role = 'ADJUDICATOR' from public.users u
                   where u.auth_uid = auth.uid() and u.is_active and not private.account_locked(u.user_id)), false)
$$;

-- -----------------------------------------------------------------------------
-- 4. Smaller findings
-- -----------------------------------------------------------------------------
-- 4a. Each phase event is recorded once; at most one close of either kind.
create unique index mu7_phase_events_once on public.mu7_phase_events (event_type)
  where event_type in ('PILOT_SIGNED_OFF', 'FORMAL_OPENED');
create unique index mu7_phase_events_one_close on public.mu7_phase_events ((true))
  where event_type in ('FORMAL_CLOSED_COMPLETE', 'FORMAL_CLOSED_INCOMPLETE');

-- 4b. No answer on a unit that is already adjudicated (fires after 0024's own guard, by name order,
--     so 0024's refusals keep their tags).
create function private.mu7x_no_answer_after_adjudication() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from public.mu7_adjudications j where j.unit_id = new.unit_id) then
    raise exception 'MU7X-G01: unit % is already adjudicated; a new answer would leave the tie-break stale', new.unit_id;
  end if;
  return new;
end $$;
revoke all on function private.mu7x_no_answer_after_adjudication() from public, anon, authenticated, service_role;
create trigger z10_mu7x_no_answer_after_adjudication before insert on public.mu7_judgments
  for each row execute function private.mu7x_no_answer_after_adjudication();

-- 4c. The administration tooling never writes v7 tables; service_role keeps no write privilege on them.
revoke insert, update, delete on public.mu7_design, public.mu7_phase_events, public.mu7_units, public.mu7_unit_design,
  public.mu7_frozen_assignments, public.mu7_gate_approvals, public.mu7_freeze, public.mu7_queue, public.mu7_judgments,
  public.mu7_snapshot, public.mu7_adjudications, public.mu7_reference_locks, public.mu7_exports,
  public.mu7_training_units, public.mu7_training_acknowledgments
  from service_role;

commit;
