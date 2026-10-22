-- =============================================================================
-- migrations/0020_mapping_confirmation_completeness_and_serialization.sql
-- Codex re-review of PR #6 (reviewed commit 8285044), two findings on migration 0018:
--   1. Completeness: the lock guard counted assignments without a response but not a missing
--      second slot or an unassigned mapping. Now every non-training mapping must hold both
--      reviewer slots before the campaign closes (assignments are only possible while OPEN) and
--      a final response in both slots before it locks.
--   2. Serialization: mapping writes read the phase without a lock while the phase transition
--      updated it, so an uncommitted import, assignment, response or adjudication could commit
--      into a closed or locked campaign on PostgreSQL. Every mapping write now takes a shared
--      lock on the campaign row and reads the phase under it; a phase transition takes the
--      exclusive row lock, so it waits for in-flight writes and later writes see the new phase.
--      READ COMMITTED is required so the recheck sees committed state.
-- Additive: migrations 0016 and 0018 are unchanged; their trigger functions are replaced.
-- =============================================================================
begin;

insert into public.app_schema_version (version, description)
values ('6.0.2-mapping-confirmation-completeness-serialization', 'mapping confirmation: two reviewer slots per mapping before close, two finals before lock, campaign-row locking for every write and phase transition');

-- Shared campaign lock for writers: blocks while a phase transition is in flight and returns the
-- committed phase once it is acquired.
create function private.mc_phase_for_write() returns text
language plpgsql security definer set search_path = '' as $$
declare
  ph text;
begin
  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'mapping-confirmation writes require READ COMMITTED isolation';
  end if;
  select c.phase into ph from public.mc_campaign c where c.singleton for share;
  return coalesce(ph, 'OPEN');
end $$;
revoke all on function private.mc_phase_for_write() from public, anon, authenticated;

create or replace function private.mc_cases_before_insert() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  camp record;
begin
  if private.mc_phase_for_write() <> 'OPEN' then
    raise exception 'mapping cases are imported only while the campaign is open';
  end if;
  select * into camp from public.mc_campaign;
  if camp.singleton is null then
    raise exception 'create the mapping-confirmation campaign (rpc_mc_create_campaign) before importing cases';
  end if;
  if new.record_category = 'EVALUATION' then
    raise exception 'evaluation import is disabled pending scientific approval; only synthetic mappings may be imported';
  end if;
  if new.trial_ref !~ '^SYN-NCT-[0-9]{4,8}$' then
    raise exception 'only synthetic trial references (SYN-NCT-) may be imported in this build';
  end if;
  if new.condition_set_id <> camp.condition_set_id then
    raise exception 'mapping % names condition set % but the campaign is %', new.case_id, new.condition_set_id, camp.condition_set_id;
  end if;
  perform private.assert_mc_assignment(new.assignment);
  perform private.assert_mc_evidence(new.evidence);
  new.assignment_sha256 := private.sha256_hex(new.assignment::text);
  new.evidence_sha256 := private.sha256_hex(new.evidence::text);
  return new;
end $$;

create or replace function private.mc_assignments_before_insert() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  rv record;
  cat text;
  other smallint;
begin
  if private.mc_phase_for_write() <> 'OPEN' then
    raise exception 'mapping assignments are made only while the campaign is open';
  end if;
  select r.mode_scope, r.withdrawn_at, u.is_active into rv
  from public.reviewers r join public.users u on u.user_id = r.user_id
  where r.reviewer_pseudo_id = new.reviewer_pseudo_id;
  if rv.withdrawn_at is not null or not coalesce(rv.is_active, false) then
    raise exception 'reviewer % is withdrawn or inactive', new.reviewer_pseudo_id;
  end if;
  select c.record_category into cat from public.mc_cases c where c.case_id = new.case_id;
  if (cat = 'SYNTHETIC_PILOT') <> (rv.mode_scope = 'PILOT') then
    raise exception 'mode contamination blocked: % reviewer % cannot take a % mapping', rv.mode_scope, new.reviewer_pseudo_id, cat;
  end if;
  select a.reviewer_slot into other from public.mc_assignments a
  where a.reviewer_pseudo_id = new.reviewer_pseudo_id and a.reviewer_slot <> new.reviewer_slot limit 1;
  if other is not null then
    raise exception 'reviewer % already holds slot %; a reviewer keeps one slot', new.reviewer_pseudo_id, other;
  end if;
  return new;
end $$;

create or replace function private.mc_responses_before_insert() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  c record;
  camp record;
begin
  if private.mc_phase_for_write() <> 'OPEN' then
    raise exception 'the campaign is closed; mapping responses are final';
  end if;
  if exists (select 1 from public.mc_responses r where r.assignment_id = new.assignment_id) then
    raise exception 'the final mapping response is locked; an authorized amendment workflow is required';
  end if;
  select * into c from public.mc_cases where case_id = new.case_id;
  select * into camp from public.mc_campaign;
  if new.displayed_assignment_sha256 <> c.assignment_sha256 or new.displayed_evidence_sha256 <> c.evidence_sha256
     or new.displayed_evidence_version <> c.evidence_version then
    raise exception 'the response does not reference the assignment and evidence currently on record for case %', new.case_id;
  end if;
  if new.rubric_version <> camp.rubric_version or new.rubric_sha256 <> camp.rubric_sha256 then
    raise exception 'the response does not reference the campaign rubric';
  end if;
  new.submitted_at := now();
  return new;
end $$;

create or replace function private.mc_adjudications_before_insert() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  r_role text;
  a1 text;
  a2 text;
begin
  select u.role into r_role from public.users u where u.user_id = new.decided_by and u.is_active;
  if r_role is distinct from 'ADJUDICATOR' or new.decided_by is distinct from private.app_user_id() then
    raise exception 'An active ADJUDICATOR must record their own adjudication; investigators cannot enter judgments'
      using errcode = '42501';
  end if;
  if private.mc_phase_for_write() <> 'ADJUDICATION' then
    raise exception 'mapping adjudication opens only after the close and the investigator authorization, and ends at the lock';
  end if;
  if not private.mc_case_complete(new.case_id) then
    raise exception 'Two independent final submissions are required before adjudication';
  end if;
  if exists (select 1 from public.mc_assignments a join public.reviewers rv on rv.reviewer_pseudo_id = a.reviewer_pseudo_id
             where a.case_id = new.case_id and rv.user_id = new.decided_by) then
    raise exception 'conflict: the adjudicator reviewed mapping %', new.case_id;
  end if;
  select max(r.answer) filter (where a.reviewer_slot = 1), max(r.answer) filter (where a.reviewer_slot = 2) into a1, a2
  from public.mc_assignments a join public.mc_responses r on r.assignment_id = a.assignment_id where a.case_id = new.case_id;
  if a1 = a2 and a1 <> 'INSUFFICIENT_INFORMATION' then
    raise exception 'the reviewers agree on mapping %; concordant mappings are not adjudicated', new.case_id;
  end if;
  if new.status = 'RUBRIC_ADDITION_REVIEWED' then
    if a1 <> 'INSUFFICIENT_INFORMATION' or a2 <> 'INSUFFICIENT_INFORMATION' then
      raise exception 'RUBRIC_ADDITION_REVIEWED applies only when both reviewers proposed the rubric addition on mapping %', new.case_id;
    end if;
  elsif new.status = 'DISCORDANT_RESOLVED' then
    if a1 = a2 then
      raise exception 'both reviewers proposed a rubric addition on mapping %; status RUBRIC_ADDITION_REVIEWED or UNRESOLVED_ESCALATED applies', new.case_id;
    end if;
    if new.basis = 'REVIEWER_1' and a1 is distinct from new.decision then
      raise exception 'basis REVIEWER_1 does not match the reviewer answers for mapping %', new.case_id;
    elsif new.basis = 'REVIEWER_2' and a2 is distinct from new.decision then
      raise exception 'basis REVIEWER_2 does not match the reviewer answers for mapping %', new.case_id;
    elsif new.basis = 'NEITHER' and (a1 is not distinct from new.decision or a2 is not distinct from new.decision) then
      raise exception 'basis NEITHER does not match the reviewer answers for mapping %', new.case_id;
    end if;
  end if;
  new.adjudicator_role := r_role;
  new.decided_at := now();
  return new;
end $$;

create or replace function private.mc_campaign_events_before_insert() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  ph text;
  n_open integer;
  n_incomplete integer;
begin
  if not private.is_investigator() then
    raise exception 'only the investigator changes the mapping-confirmation phase' using errcode = '42501';
  end if;
  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'mapping-confirmation phase transitions require READ COMMITTED isolation';
  end if;
  -- Exclusive campaign lock: waits for every in-flight mapping write, and later writes wait here.
  select c.phase into ph from public.mc_campaign c where c.singleton for update;
  ph := coalesce(ph, 'OPEN');
  if new.event_type = 'CLOSED' then
    if ph <> 'OPEN' then raise exception 'the campaign is not open (phase %)', ph; end if;
    -- Every non-training mapping needs both reviewer slots: assignments are impossible after the close.
    select count(*) into n_incomplete from public.mc_cases c
    where c.record_category <> 'TRAINING_EXAMPLE'
      and (select count(distinct a.reviewer_slot) from public.mc_assignments a where a.case_id = c.case_id) < 2;
    if n_incomplete > 0 then
      raise exception '% mappings lack a second reviewer assignment; the campaign cannot be closed', n_incomplete;
    end if;
    update public.mc_campaign set phase = 'CLOSED' where singleton;
  elsif new.event_type = 'ADJUDICATION_AUTHORIZED' then
    if ph <> 'CLOSED' then raise exception 'close the campaign before authorizing adjudication (phase %)', ph; end if;
    update public.mc_campaign set phase = 'ADJUDICATION' where singleton;
  elsif new.event_type = 'LOCKED' then
    if ph <> 'ADJUDICATION' then raise exception 'authorize adjudication before locking (phase %)', ph; end if;
    -- Every non-training mapping needs a final response in both slots (covers missing and
    -- unanswered assignments alike).
    select count(*) into n_incomplete from public.mc_cases c
    where c.record_category <> 'TRAINING_EXAMPLE' and not private.mc_case_complete(c.case_id);
    if n_incomplete > 0 then
      raise exception '% mappings lack two final responses; an incomplete campaign cannot be locked', n_incomplete;
    end if;
    select count(*) into n_open from public.mc_cases c
    where c.record_category <> 'TRAINING_EXAMPLE'
      and ((select count(distinct r.answer) from public.mc_assignments a join public.mc_responses r on r.assignment_id = a.assignment_id
            where a.case_id = c.case_id) > 1
           or exists (select 1 from public.mc_assignments a join public.mc_responses r on r.assignment_id = a.assignment_id
                      where a.case_id = c.case_id and r.answer = 'INSUFFICIENT_INFORMATION'))
      and not exists (select 1 from public.mc_adjudications j where j.case_id = c.case_id);
    if n_open > 0 then
      raise exception '% disagreeing or insufficient-information mappings have no adjudication; the campaign cannot be locked', n_open;
    end if;
    update public.mc_campaign set phase = 'LOCKED' where singleton;
  end if;
  new.occurred_at := now();
  return new;
end $$;

commit;
