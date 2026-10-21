-- Additive integrity corrections; prior submissions and source migrations remain unchanged.
begin;

create or replace function public.rpc_lock_reference_v4(p_attestation text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := private.assert_investigator();
  n_missing integer;
  n_levels integer;
  n_unanswered integer;
  lid uuid;
begin
  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'Reference locking requires READ COMMITTED isolation';
  end if;
  -- Serialize with withdrawals and every input to the judgment/reference views.
  -- Hold these locks until the immutable reference-lock insert commits.
  lock table public.cases, public.case_versions, public.assignments,
    public.reviews, public.trial_step1_records, public.adjudications,
    public.reference_locks in share row exclusive mode;
  if not private.v4_frozen() then
    raise exception 'no v4 freeze';
  end if;
  if private.formal_phase_status() not in ('COMPLETE', 'CLOSED_INCOMPLETE') then
    raise exception 'the reference is locked only after the formal phase is closed';
  end if;
  if not exists (select 1 from public.judgment_snapshots_v4) then
    raise exception 'no independent-judgment snapshot';
  end if;
  if not exists (select 1 from public.rpc_verify_judgment_snapshot_v4() s where s.matches) then
    raise exception 'Independent-judgment snapshot integrity failure; reference lock refused';
  end if;
  with lv as (
    select r.case_id, l.lvl,
           (select count(*) from private.case_level_answers_v4(r.case_id, l.lvl)) as n_ans,
           (select count(distinct a.decision) from private.case_level_answers_v4(r.case_id, l.lvl) a) as n_dist
    from public.case_records_v4 r
    join public.cases c on c.case_id = r.case_id and c.withdrawn_at is null
    cross join lateral private.case_levels_v4(r.case_id) as l(lvl)
  )
  select count(*) filter (where lv.n_ans >= 1
                            and (lv.n_ans = 1 or lv.n_dist > 1 or private.v4_scope() = 'ALL_CASE_LEVELS')
                            and not exists (select 1 from public.v_effective_adjudications j
                                            where j.case_id = lv.case_id and j.determination_level = lv.lvl
                                              and j.layer = 'clinical_classification')),
         count(*), count(*) filter (where lv.n_ans = 0)
  into n_missing, n_levels, n_unanswered from lv;
  if n_unanswered > 0 then
    raise exception '% frozen case levels have no independent judgment; reference lock refused', n_unanswered;
  end if;
  if n_missing > 0 then
    raise exception '% case levels that the adjudication scope requires have no adjudication; the reference cannot be locked', n_missing;
  end if;
  insert into public.reference_locks (review_module, n_case_levels_locked, attestation, locked_by)
  values ('ONTOLOGY_AREA', n_levels, p_attestation, me) returning lock_id into lid;
  return lid;
end $$;

-- An investigator can withdraw before lock (which invalidates the old
-- snapshot), but cannot mutate a successfully locked reference via withdrawal.
create function private.assignments_reference_lock_guard() returns trigger
 language plpgsql security definer set search_path='' as $$
begin
 if old.withdrawn_at is null and new.withdrawn_at is not null
    and exists(select 1 from public.case_records_v4 r where r.case_id=old.case_id) then
   if current_setting('transaction_isolation') <> 'read committed' then
     raise exception 'Held-out withdrawal requires READ COMMITTED isolation';
   end if;
   lock table public.assignments in share row exclusive mode;
   if private.reference_locked('ONTOLOGY_AREA') then
     raise exception 'Locked reference prevents assignment withdrawal';
   end if;
 end if;
 return new;
end$$;
create trigger assignments_reference_lock_guard before update on public.assignments
 for each row execute function private.assignments_reference_lock_guard();
revoke all on function private.assignments_reference_lock_guard() from public,anon,authenticated;

create or replace function public.rpc_freeze_v4(p jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := private.assert_investigator();
  n_cases integer;
  n_missing integer;
  n_pred integer;
  lst text;
  fid uuid;
  bad text;
begin
  -- Hold the same lock through hashing and manifest insertion. This also blocks
  -- freezing pre-upgrade mixed rows; no historical rows are rewritten.
  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'Prediction imports and freezing require READ COMMITTED isolation';
  end if;
  -- Cases first: withdrawal takes this same lock and rechecks freeze state.
  lock table public.cases in share row exclusive mode;
  lock table public.frozen_predictions_v4 in share row exclusive mode;
  if exists (select 1 from public.frozen_predictions_v4 f
             join public.cases c on c.case_id=f.case_id where c.withdrawn_at is not null) then
    raise exception 'Predictions for withdrawn cases prevent freezing';
  end if;
  if (select count(distinct prediction_set_id) from public.frozen_predictions_v4) <> 1 then
    raise exception 'freeze requires exactly one prediction-set identifier';
  end if;
  if not private.v4_active() then
    raise exception 'activate design v4 first';
  end if;
  if private.v4_frozen() then
    raise exception 'the v4 freeze has already happened';
  end if;
  if private.formal_phase_status() <> 'IN_PROGRESS' then
    raise exception 'freeze after the pilot sign-off and before the formal review opens to reviewers (status %)', private.formal_phase_status();
  end if;
  if not exists (select 1 from public.sample_manifests m where m.review_module = 'ONTOLOGY_AREA') then
    raise exception 'freeze the v3 sample manifest (rpc_freeze_sample_manifest) first';
  end if;
  select count(*) into n_missing from public.cases c
  where c.mode = 'FORMAL' and c.withdrawn_at is null
    and (not exists (select 1 from public.case_records_v4 r where r.case_id = c.case_id)
         or not exists (select 1 from public.sample_manifest_cases x join public.sample_manifests m on m.manifest_id = x.manifest_id
                        where x.case_id = c.case_id and m.review_module = 'ONTOLOGY_AREA'));
  if n_missing > 0 then
    raise exception '% active FORMAL cases lack a held-out case record or are not in the v3 sample manifest', n_missing;
  end if;
  select count(*) into n_missing from public.sample_manifest_cases x join public.sample_manifests m on m.manifest_id = x.manifest_id
  join public.cases c on c.case_id = x.case_id and c.withdrawn_at is null
  where m.review_module = 'ONTOLOGY_AREA' and not exists (select 1 from public.case_records_v4 r where r.case_id = x.case_id);
  if n_missing > 0 then
    raise exception '% v3 manifest cases have no held-out case record', n_missing;
  end if;
  select count(*) into n_missing from public.case_records_v4 r
  join public.cases c on c.case_id = r.case_id and c.withdrawn_at is null
  cross join lateral private.case_levels_v4(r.case_id) as l(lvl)
  where not exists (select 1 from public.frozen_predictions_v4 f where f.case_id = r.case_id and f.determination_level = l.lvl);
  if n_missing > 0 then
    raise exception '% required case levels have no frozen prediction', n_missing;
  end if;
  if exists (select 1 from public.frozen_predictions_v4 f where f.tier1_version <> (p ->> 'tier1_version')) then
    raise exception 'predictions carry a Tier 1 version other than %', p ->> 'tier1_version';
  end if;
  if jsonb_typeof(coalesce(p -> 'frozen_items', 'null'::jsonb)) <> 'object' then
    raise exception 'frozen_items must be an object of SHA-256 values';
  end if;
  select e.key into bad from jsonb_each_text(p -> 'frozen_items') e where e.value !~ '^[0-9a-f]{64}$' limit 1;
  if bad is not null then
    raise exception 'frozen item % is not a SHA-256 value', bad;
  end if;
  select count(*), string_agg(r.case_id, E'\n' order by r.case_id collate "C") into n_cases, lst
  from public.case_records_v4 r join public.cases c on c.case_id = r.case_id and c.withdrawn_at is null;
  select count(*) into n_pred from public.frozen_predictions_v4;
  insert into public.freeze_manifests_v4 (design_version, tier1_version, adjudication_scope, n_cases, case_list_sha256,
    n_prediction_rows, prediction_rows_sha256, prediction_file_sha256, frozen_items, extension_amendment_id, attestation, frozen_by)
  values ((select a.design_version from public.design_activation_v4 a), p ->> 'tier1_version', private.v4_scope(), n_cases,
    private.sha256_hex(lst), n_pred, private.prediction_rows_sha256_v4(), lower(p ->> 'prediction_file_sha256'),
    p -> 'frozen_items', p ->> 'extension_amendment_id', p ->> 'attestation', me)
  returning freeze_id into fid;
  return fid;
end $$;

create or replace function private.cases_v4_no_withdraw_after_freeze() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if old.withdrawn_at is null and new.withdrawn_at is not null
     and exists (select 1 from public.case_records_v4 r where r.case_id=old.case_id) then
    if current_setting('transaction_isolation') <> 'read committed' then
      raise exception 'Held-out withdrawal requires READ COMMITTED isolation';
    end if;
    lock table public.cases in share row exclusive mode;
  end if;
  if old.withdrawn_at is null and new.withdrawn_at is not null and private.v4_frozen()
     and exists (select 1 from public.case_records_v4 r where r.case_id = old.case_id) then
    raise exception 'design v4: % is a frozen held-out case and cannot be withdrawn; the case list is fixed at the freeze', old.case_id;
  end if;
  return new;
end $$;

-- Module B is still optional/unapproved. No amendment workflow is authorized.
create or replace function private.mb_responses_v4_before_insert() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  ut text;

begin
  if private.mb_phase() <> 'MB_OPENED' then
    raise exception 'Module B is not open for responses (status %)', private.mb_phase();
  end if;
  select u.unit_type into ut from public.mb_units_v4 u where u.mb_unit_id = new.mb_unit_id;
  if (ut = 'CONDITION_ROW_BENCHMARK') <> (new.compatibility is not null) then
    raise exception 'row units take a compatibility answer and trial units an eligibility answer';
  end if;
  if exists(select 1 from public.mb_responses_v4 r where r.mb_assignment_id=new.mb_assignment_id) then
    raise exception 'Module B response is final; amendments are not enabled';
  end if;
  -- Concurrent first submissions both use revision 1; the existing unique
  -- (assignment, revision) constraint admits at most one. Prior rows stay intact.
  new.revision_number := 1;
  new.submitted_at := now();
  return new;
end $$;

create or replace function public.rpc_verify_export() returns jsonb
 language plpgsql security definer set search_path='' as $$
declare result jsonb;
begin
 perform private.assert_investigator();
 if private.verify_phase()<>'LOCKED' then raise exception 'Reference lock required before export'; end if;
 perform private.verify_assert_precontext_integrity();
 if (select snapshot_hash from public.verify_state) is distinct from private.verify_snapshot() then raise exception 'Judgment snapshot integrity failure'; end if;
 select jsonb_build_object('synthetic',true,'schemaVersion','4.0.3-reference-integrity','analysisPlanStatus','PENDING_APPROVAL','state',(select to_jsonb(s) from public.verify_state s),'cases',(select jsonb_agg(to_jsonb(c)||jsonb_build_object('evidenceHash',private.sha256_hex(c.packet::text||coalesce(c.trial_packet::text,''))) order by c.id) from public.verify_cases c),'judgments',(select jsonb_agg(to_jsonb(r) order by r.case_id,r.level,r.reviewer_id,r.sequence) from public.verify_responses r),'adjudications',(select jsonb_agg(to_jsonb(j) order by j.case_id,j.level) from public.verify_adjudications j),'amendments',(select coalesce(jsonb_agg(to_jsonb(a) order by a.authorized_at),'[]'::jsonb) from public.verify_amendments a),'audit',(select jsonb_agg(to_jsonb(a) order by a.sequence) from public.verify_audit a where a.action <> 'EXPORT_REQUESTED')) into result;
 perform private.verify_log('EXPORT_REQUESTED');
 return result;
end$$;

insert into public.app_schema_version(version,description) values
 ('4.0.3-reference-integrity','Atomic reference verification, complete frozen-level coverage, withdrawal-safe freeze and final Module B submissions');
commit;
