-- Additive frozen-contract guards. Preserve all prior migrations and recorded data.
begin;

-- This migration changes reference-selection semantics. Do not reinterpret an
-- already locked formal archive, even when its existing rows appear valid.
-- Synthetic pilot locks use verify_state and do not trigger this boundary.
do $$ begin
  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'Frozen-contract migration requires READ COMMITTED isolation';
  end if;
  -- Serialize the preflight with reference-lock creation. Hold this lock through
  -- COMMIT so no formal lock can appear between the check and semantic upgrade.
  lock table public.reference_locks in share row exclusive mode;
  if exists(select 1 from public.freeze_manifests_v4)
     and exists(select 1 from public.reference_locks where review_module='ONTOLOGY_AREA') then
    raise exception 'Existing locked formal reference requires explicit investigator migration review';
  end if;
end$$;

-- This mirrors the reviewed v4 analysis contract. It validates provenance,
-- not clinical correctness, and never invents a reference answer.
create function private.assert_adjudication_semantics_v4(
 p_case text,p_level text,p_status text,p_decision text,p_basis text,p_reason text
) returns void language plpgsql stable security definer set search_path='' as $$
declare n integer; n_dist integer; d1 text; d2 text;
begin
 select count(*),count(distinct a.decision),
   max(a.decision) filter(where a.reviewer_slot=1),
   max(a.decision) filter(where a.reviewer_slot=2)
 into n,n_dist,d1,d2 from private.case_level_answers_v4(p_case,p_level) a;
 if n=0 then raise exception 'Adjudication semantics: no independent answer'; end if;
 if (p_status='UNRESOLVED_ESCALATED') is distinct from (p_decision is null)
    or (p_status='UNRESOLVED_ESCALATED') is distinct from (p_basis='NONE') then
   raise exception 'Adjudication semantics: unresolved requires null decision and NONE basis';
 end if;
 if n=1 and p_status not in ('SINGLE_REVIEW_ADJUDICATED','UNRESOLVED_ESCALATED') then
   raise exception 'Adjudication semantics: single review requires single-review or unresolved status';
 elsif n=2 and n_dist=1 and p_status not in ('CONCORDANT_CONFIRMED','CONCORDANT_REVISED','UNRESOLVED_ESCALATED') then
   raise exception 'Adjudication semantics: agreeing reviews require concordant or unresolved status';
 elsif n=2 and n_dist>1 and (p_status not in ('DISCORDANT_RESOLVED','UNRESOLVED_ESCALATED') or p_reason is null) then
   raise exception 'Adjudication semantics: discordant reviews require matching status and reason';
 end if;
 if p_status='UNRESOLVED_ESCALATED' then return; end if;
 if p_status='CONCORDANT_CONFIRMED' and p_decision is distinct from d1 then
   raise exception 'Adjudication semantics: confirmed decision must equal the shared answer';
 elsif p_status='CONCORDANT_REVISED' and p_decision is not distinct from d1 then
   raise exception 'Adjudication semantics: revised decision must differ from the shared answer';
 end if;
 if p_basis='REVIEWER_1' and (d1 is null or p_decision is distinct from d1) then
   raise exception 'Adjudication semantics: REVIEWER_1 basis must adopt reviewer 1';
 elsif p_basis='REVIEWER_2' and (d2 is null or p_decision is distinct from d2) then
   raise exception 'Adjudication semantics: REVIEWER_2 basis must adopt reviewer 2';
 elsif p_basis='BOTH_REVIEWERS' and (n<>2 or n_dist<>1 or p_decision is distinct from d1) then
   raise exception 'Adjudication semantics: BOTH_REVIEWERS basis must adopt the shared answer';
 elsif p_basis='NEITHER' and (p_decision is not distinct from d1 or p_decision is not distinct from d2) then
   raise exception 'Adjudication semantics: NEITHER basis must differ from all submitted answers';
 end if;
end$$;
revoke all on function private.assert_adjudication_semantics_v4(text,text,text,text,text,text) from public,anon,authenticated;

create or replace function private.adjudications_v4_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  n integer;
  n_distinct integer;
begin
  if new.mode <> 'FORMAL' or not private.v4_active() or new.layer <> 'clinical_classification' then
    return new;
  end if;
  if not exists (select 1 from public.judgment_snapshots_v4) then
    raise exception 'take the independent-judgment snapshot (rpc_snapshot_judgments_v4) before any FORMAL adjudication';
  end if;
  select count(*), count(distinct a.decision) into n, n_distinct
  from private.case_level_answers_v4(new.case_id, new.determination_level) a;
  if n = 0 then
    raise exception 'case level %/% has no reviewer answer to adjudicate', new.case_id, new.determination_level;
  elsif n = 1 then
    if new.adjudication_status not in ('SINGLE_REVIEW_ADJUDICATED', 'UNRESOLVED_ESCALATED') then
      raise exception 'a single-reviewed case level is SINGLE_REVIEW_ADJUDICATED or UNRESOLVED_ESCALATED';
    end if;
  elsif n_distinct = 1 then
    -- after the reference lock a record is a post-unblinding revision and never enters the
    -- primary reference, so the scope rule applies only before the lock
    if private.v4_scope() = 'DISAGREEMENTS_ONLY' and not private.reference_locked('ONTOLOGY_AREA') then
      raise exception 'adjudication scope DISAGREEMENTS_ONLY: concordant case levels enter the reference by rule';
    end if;
    if new.adjudication_status not in ('CONCORDANT_CONFIRMED', 'CONCORDANT_REVISED', 'UNRESOLVED_ESCALATED') then
      raise exception 'the reviewers agree on this case level; status % does not fit', new.adjudication_status;
    end if;
  else
    if new.adjudication_status not in ('DISCORDANT_RESOLVED', 'UNRESOLVED_ESCALATED') then
      raise exception 'the reviewers disagree on this case level; status % does not fit', new.adjudication_status;
    end if;
    if new.disagreement_reason_code is null then
      raise exception 'a discordant case level needs a disagreement reason code';
    end if;
  end if;
  perform private.assert_adjudication_semantics_v4(new.case_id,new.determination_level,
    new.adjudication_status,new.adjudicated_decision,new.adjudication_basis,new.disagreement_reason_code);
  return new;
end $$;

-- Choose the blinded supersession leaf, including tied timestamps. An explicit
-- unresolved adjudication keeps its null decision; concordance is only a fallback
-- when no adjudication exists. Later post-unblinding rows never replace it.
create or replace view public.v_adjudicated_reference_v4 with (security_invoker = true) as
with lk as (
  select l.lock_id, l.locked_at from public.reference_locks l where l.review_module = 'ONTOLOGY_AREA'
), lv as (
  select r.case_id, r.record_category, x.lvl as determination_level
  from public.case_records_v4 r
  join public.cases c on c.case_id = r.case_id and c.withdrawn_at is null
  cross join lateral private.case_levels_v4(r.case_id) as x(lvl)
), ans as (
  select lv.case_id, lv.determination_level,
         (select count(*) from private.case_level_answers_v4(lv.case_id, lv.determination_level)) as n_ans,
         (select count(distinct a.decision) from private.case_level_answers_v4(lv.case_id, lv.determination_level) a) as n_dist,
         (select min(a.decision) from private.case_level_answers_v4(lv.case_id, lv.determination_level) a) as shared
  from lv
), ref as (
  select j.*
  from public.adjudications j
  where j.layer = 'clinical_classification' and not j.post_unblinding and j.mode = 'FORMAL'
    and not exists(select 1 from public.adjudications k
      where k.supersedes_adjudication_id=j.adjudication_id and not k.post_unblinding)
)
select lv.case_id, lv.record_category, lv.determination_level,
       case when ref.adjudication_id is not null then 'ADJ4-' || replace(ref.adjudication_id::text, '-', '')
            else 'RULE-' || lv.case_id || '-' || lv.determination_level end as adjudication_id,
       case when ref.adjudication_id is not null then ref.adjudicated_decision
            when ans.n_ans=2 and ans.n_dist=1 then ans.shared end as adjudicated_decision,
       coalesce(ref.adjudication_status, case when ans.n_ans = 2 and ans.n_dist = 1 then 'CONCORDANT_ADOPTED_BY_RULE' end) as adjudication_status,
       coalesce(ref.adjudication_basis, case when ans.n_ans = 2 and ans.n_dist = 1 then 'BOTH_REVIEWERS' end) as adjudication_basis,
       ref.disagreement_reason_code,
       case when ref.adjudication_id is not null then 'A-' || upper(substr(md5(ref.decided_by::text), 1, 6)) else 'RULE' end as adjudicator_pseudo_id,
       case when ref.adjudication_id is not null then ref.adjudicator_role else 'CONCORDANCE_RULE' end as adjudicator_role,
       coalesce(ref.adjudication_blinded, true) as adjudication_blinded,
       coalesce(ref.adjudicator_exposed_to_index_labels, false) as adjudicator_exposed_to_index_labels,
       exists (select 1 from public.adjudications k where k.case_id = lv.case_id and k.determination_level = lv.determination_level
               and k.post_unblinding) as post_unblinding_revision_exists,
       coalesce(ref.decided_at, lk.locked_at) as adjudicated_at,
       lk.lock_id as reference_lock_id
from lv
join ans on ans.case_id = lv.case_id and ans.determination_level = lv.determination_level
cross join lk
left join ref on ref.case_id = lv.case_id and ref.determination_level = lv.determination_level
where private.is_investigator() and ans.n_ans >= 1;

-- Recheck legacy effective adjudications before the irreversible lock. Invalid
-- historical rows stay recorded; an explicit valid supersession can correct them.
create function private.reference_adjudication_semantics_guard() returns trigger
 language plpgsql security definer set search_path='' as $$
declare a record;
begin
 if new.review_module='ONTOLOGY_AREA' and private.v4_active() then
   if exists(select 1 from public.adjudications j
     join public.case_records_v4 r on r.case_id=j.case_id
     where j.mode='FORMAL' and j.layer='clinical_classification' and not j.post_unblinding
       and not exists(select 1 from public.adjudications k
         where k.supersedes_adjudication_id=j.adjudication_id and not k.post_unblinding)
     group by j.case_id,j.determination_level having count(*)>1) then
     raise exception 'Reference integrity: multiple primary adjudication leaves';
   end if;
   for a in select j.* from public.adjudications j
     join public.case_records_v4 r on r.case_id=j.case_id
     where j.mode='FORMAL' and j.layer='clinical_classification' and not j.post_unblinding
       and not exists(select 1 from public.adjudications k
         where k.supersedes_adjudication_id=j.adjudication_id and not k.post_unblinding)
   loop
     perform private.assert_adjudication_semantics_v4(a.case_id,a.determination_level,
       a.adjudication_status,a.adjudicated_decision,a.adjudication_basis,a.disagreement_reason_code);
   end loop;
 end if;
 return new;
end$$;
create trigger reference_adjudication_semantics before insert on public.reference_locks
 for each row execute function private.reference_adjudication_semantics_guard();
revoke all on function private.reference_adjudication_semantics_guard() from public,anon,authenticated;

create or replace function private.case_versions_v4_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.mode='FORMAL' and exists(select 1 from public.case_records_v4 r where r.case_id=new.case_id) then
    if current_setting('transaction_isolation') <> 'read committed' then
      raise exception 'Held-out packet versioning requires READ COMMITTED isolation';
    end if;
    -- Freeze holds this same lock until its manifest commits. A concurrent
    -- insertion either completes before freeze or observes the committed lock.
    lock table public.case_versions in share row exclusive mode;
    if private.v4_frozen() then
      raise exception 'Frozen held-out evidence packets cannot be versioned';
    end if;
  end if;
  if new.mode = 'FORMAL' and private.v4_frozen()
     and (select o.registered_at from public.ontology_versions o where o.version_set_id = new.version_set_id)
         > (select f.frozen_at from public.freeze_manifests_v4 f) then
    raise exception 'a FORMAL case version cannot use a version set registered after the freeze';
  end if;
  return new;
end $$;

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
  n_extensions integer;
  n_amendments integer;
  extension_id text;
begin
  -- Hold the same lock through hashing and manifest insertion. This also blocks
  -- freezing pre-upgrade mixed rows; no historical rows are rewritten.
  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'Prediction imports and freezing require READ COMMITTED isolation';
  end if;
  -- Cases first: withdrawal takes this same lock and rechecks freeze state.
  lock table public.cases, public.case_records_v4, public.case_versions in share row exclusive mode;
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
  select count(*),count(distinct r.amendment_id),min(r.amendment_id)
  into n_extensions,n_amendments,extension_id
  from public.case_records_v4 r join public.cases c on c.case_id=r.case_id and c.withdrawn_at is null
  where r.record_category='HELDOUT_EXTENSION_APPROVED';
  if (n_extensions=0 and p->>'extension_amendment_id' is not null)
     or (n_extensions>0 and (n_amendments<>1 or extension_id is distinct from p->>'extension_amendment_id')) then
    raise exception 'Freeze extension amendment must match every retained extension case, and be null when none exist';
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

create or replace function public.rpc_lock_mb_reference_v4(p_attestation text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := private.assert_investigator();
  n_missing integer;
  n_units integer;
  n_unanswered integer;
  lid uuid;
begin
  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'Module B reference locking requires READ COMMITTED isolation';
  end if;
  lock table public.mb_units_v4, public.mb_assignments_v4, public.mb_responses_v4,
    public.mb_adjudications_v4, public.mb_reference_lock_v4 in share row exclusive mode;
  if private.mb_phase() <> 'MB_CLOSED' then
    raise exception 'the Module B reference is locked only after Module B closes';
  end if;
  with eff as (
    select distinct on (r.mb_assignment_id) r.mb_unit_id, coalesce(r.compatibility, r.eligibility) as ans
    from public.mb_responses_v4 r order by r.mb_assignment_id, r.revision_number desc
  ), u as (
    select m.mb_unit_id,count(e.mb_unit_id) as n_ans,count(distinct e.ans) as n_dist
    from public.mb_units_v4 m left join eff e on e.mb_unit_id=m.mb_unit_id group by m.mb_unit_id
  )
  select count(*) filter (where (u.n_ans = 1 or u.n_dist > 1)
                            and not exists (select 1 from public.mb_adjudications_v4 j where j.mb_unit_id = u.mb_unit_id)),
         count(*),count(*) filter(where u.n_ans=0)
  into n_missing,n_units,n_unanswered from u;
  if n_unanswered>0 then
    raise exception '% frozen Module B units have no independent response; reference lock refused', n_unanswered;
  end if;
  if n_missing > 0 then
    raise exception '% Module B units that need adjudication have none', n_missing;
  end if;
  insert into public.mb_reference_lock_v4 (n_units, attestation, locked_by) values (n_units, p_attestation, me)
  returning mb_lock_id into lid;
  return lid;
end $$;

create or replace function public.rpc_verify_export() returns jsonb
 language plpgsql security definer set search_path='' as $$
declare result jsonb;
begin
 perform private.assert_investigator();
 if private.verify_phase()<>'LOCKED' then raise exception 'Reference lock required before export'; end if;
 perform private.verify_assert_precontext_integrity();
 if (select snapshot_hash from public.verify_state) is distinct from private.verify_snapshot() then raise exception 'Judgment snapshot integrity failure'; end if;
 select jsonb_build_object('synthetic',true,'schemaVersion','4.0.4-frozen-contract','analysisPlanStatus','PENDING_APPROVAL','state',(select to_jsonb(s) from public.verify_state s),'cases',(select jsonb_agg(to_jsonb(c)||jsonb_build_object('evidenceHash',private.sha256_hex(c.packet::text||coalesce(c.trial_packet::text,''))) order by c.id) from public.verify_cases c),'judgments',(select jsonb_agg(to_jsonb(r) order by r.case_id,r.level,r.reviewer_id,r.sequence) from public.verify_responses r),'adjudications',(select jsonb_agg(to_jsonb(j) order by j.case_id,j.level) from public.verify_adjudications j),'amendments',(select coalesce(jsonb_agg(to_jsonb(a) order by a.authorized_at),'[]'::jsonb) from public.verify_amendments a),'audit',(select jsonb_agg(to_jsonb(a) order by a.sequence) from public.verify_audit a where a.action <> 'EXPORT_REQUESTED')) into result;
 perform private.verify_log('EXPORT_REQUESTED');
 return result;
end$$;

insert into public.app_schema_version(version,description) values
 ('4.0.4-frozen-contract','Adjudication semantics, complete Module B references, frozen evidence packets and consistent extension authorization');
commit;
