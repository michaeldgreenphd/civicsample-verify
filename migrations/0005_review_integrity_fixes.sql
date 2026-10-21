-- Review-integrity corrections. This additive migration preserves all source
-- migrations and every recorded response, amendment, adjudication and audit row.
begin;

-- Step 1 is the pre-context determination. Submission makes trial context
-- available immediately, so a later amendment cannot retain that meaning.
-- Guards also cover authorizations issued before this migration.
create function private.verify_step1_lock_guard() returns trigger
 language plpgsql security definer set search_path='' as $$
begin
 if new.level='DESCRIPTOR_LEVEL_IN_TRIAL_CASE' and
    (tg_table_name='verify_amendments' or exists (
      select 1 from public.verify_responses r
      where r.case_id=new.case_id and r.reviewer_id=new.reviewer_id
        and r.level='DESCRIPTOR_LEVEL_IN_TRIAL_CASE'
    )) then
   raise exception 'Pre-context Step 1 is permanently locked after submission';
 end if;
 return new;
end$$;
create trigger verify_step1_lock before insert on public.verify_amendments
 for each row execute function private.verify_step1_lock_guard();
create trigger verify_step1_lock before insert or update on public.verify_drafts
 for each row execute function private.verify_step1_lock_guard();
create trigger verify_step1_lock before insert on public.verify_responses
 for each row execute function private.verify_step1_lock_guard();
revoke all on function private.verify_step1_lock_guard() from public,anon,authenticated;

-- A submitted Step 1 amendment made by an older build cannot be reclassified
-- as pre-context. Preserve it, but fail closed pending investigator disposition.
create function private.verify_assert_precontext_integrity() returns void
 language plpgsql stable security definer set search_path='' as $$
begin
 if exists(select 1 from public.verify_responses
   where level='DESCRIPTOR_LEVEL_IN_TRIAL_CASE' and supersedes is not null) then
   raise exception 'Pre-context Step 1 integrity requires investigator review';
 end if;
end$$;
create function private.verify_reference_integrity_guard() returns trigger
 language plpgsql security definer set search_path='' as $$
begin
 perform private.verify_assert_precontext_integrity();
 return new;
end$$;
create trigger verify_reference_integrity before update on public.verify_state
 for each row when (new.phase <> 'OPEN') execute function private.verify_reference_integrity_guard();
create trigger verify_reference_integrity before insert on public.verify_adjudications
 for each row execute function private.verify_reference_integrity_guard();
revoke all on function private.verify_assert_precontext_integrity(),private.verify_reference_integrity_guard() from public,anon,authenticated;

create or replace function public.rpc_verify_case(p_case text) returns jsonb
 language plpgsql stable security definer set search_path='' as $$
declare c public.verify_cases; me uuid:=private.app_user_id(); role text:=private.app_role(); result jsonb; rs jsonb;
begin
 if role='REVIEWER' then
 if not private.verify_assigned(p_case) then raise exception 'Case not assigned'; end if;
 elsif role='ADJUDICATOR' then
 perform private.verify_assert_precontext_integrity();
 if private.verify_phase() not in ('ADJUDICATION','LOCKED') then raise exception 'Adjudication authorization required'; end if;
 else raise exception 'Case packets restricted to assigned clinical roles'; end if;
 select * into c from public.verify_cases where id=p_case;
 if c.id is null then raise exception 'Case not found'; end if;
 result:=jsonb_build_object('id',c.id,'kind',c.kind,'packet',c.packet,'phase',private.verify_phase(),'synthetic',true,'evidenceHash',private.sha256_hex(c.packet::text||coalesce(c.trial_packet::text,'')));
 if role='ADJUDICATOR' or private.verify_has_step1(p_case) then result:=result||jsonb_build_object('trialPacket',c.trial_packet); end if;
 if role='REVIEWER' then
 select coalesce(jsonb_agg(to_jsonb(r) order by r.sequence),'[]'::jsonb) into rs from public.verify_responses r where case_id=p_case and reviewer_id=me;
 result:=result||jsonb_build_object('responses',rs,'drafts',(select coalesce(jsonb_agg(to_jsonb(d)),'[]'::jsonb) from public.verify_drafts d where case_id=p_case and reviewer_id=me),'amendments',(select coalesce(jsonb_agg(to_jsonb(a)),'[]'::jsonb) from public.verify_amendments a where case_id=p_case and reviewer_id=me and not exists(select 1 from public.verify_responses r where r.amendment_id=a.id)));
 else
 select coalesce(jsonb_agg(to_jsonb(x) order by x.level,x.reviewer_id),'[]'::jsonb) into rs from (select distinct on (reviewer_id,level) * from public.verify_responses where case_id=p_case order by reviewer_id,level,sequence desc) x;
 result:=result||jsonb_build_object('responses',rs,'adjudications',(select coalesce(jsonb_agg(to_jsonb(j)),'[]'::jsonb) from public.verify_adjudications j where case_id=p_case));
 end if;
 return result;
end$$;

-- Clinical context must not be relabeled as a packet defect.
create or replace function public.rpc_verify_submit(p_case text,p_level text,p jsonb) returns uuid
 language plpgsql security definer set search_path='' as $$
declare result uuid; prev uuid;
begin
 select id into prev from public.verify_responses where case_id=p_case and reviewer_id=private.app_user_id() and level=p_level order by sequence desc limit 1;
 insert into public.verify_responses(case_id,reviewer_id,level,decision,rationale,uncertain,packet_problem,packet_problem_note,descriptor_role,context_note,amendment_id,supersedes)
 values(p_case,private.app_user_id(),p_level,p->>'decision',p->>'rationale',coalesce((p->>'uncertain')::boolean,false),coalesce((p->>'packetProblem')::boolean,false),nullif(p->>'packetProblemNote',''),nullif(p->>'descriptorRole',''),coalesce(p->>'context',''),nullif(p->>'amendmentId','')::uuid,prev) returning id into result;
 delete from public.verify_drafts where case_id=p_case and reviewer_id=private.app_user_id() and level=p_level and amendment_id is not distinct from nullif(p->>'amendmentId','')::uuid;
 perform private.verify_log(case when prev is null then 'RESPONSE_SUBMITTED' else 'RESPONSE_AMENDED' end,p_case,jsonb_build_object('responseId',result,'level',p_level));
 return result;
end$$;

-- Export access stays auditable but outside the immutable scientific archive.
create or replace function public.rpc_verify_export() returns jsonb
 language plpgsql security definer set search_path='' as $$
declare result jsonb;
begin
 perform private.assert_investigator();
 if private.verify_phase()<>'LOCKED' then raise exception 'Reference lock required before export'; end if;
 perform private.verify_assert_precontext_integrity();
 if (select snapshot_hash from public.verify_state) is distinct from private.verify_snapshot() then raise exception 'Judgment snapshot integrity failure'; end if;
 select jsonb_build_object('synthetic',true,'schemaVersion','4.0.2-review-integrity','analysisPlanStatus','PENDING_APPROVAL','state',(select to_jsonb(s) from public.verify_state s),'cases',(select jsonb_agg(to_jsonb(c)||jsonb_build_object('evidenceHash',private.sha256_hex(c.packet::text||coalesce(c.trial_packet::text,''))) order by c.id) from public.verify_cases c),'judgments',(select jsonb_agg(to_jsonb(r) order by r.case_id,r.level,r.reviewer_id,r.sequence) from public.verify_responses r),'adjudications',(select jsonb_agg(to_jsonb(j) order by j.case_id,j.level) from public.verify_adjudications j),'amendments',(select coalesce(jsonb_agg(to_jsonb(a) order by a.authorized_at),'[]'::jsonb) from public.verify_amendments a),'audit',(select jsonb_agg(to_jsonb(a) order by a.sequence) from public.verify_audit a where a.action <> 'EXPORT_REQUESTED')) into result;
 perform private.verify_log('EXPORT_REQUESTED');
 return result;
end$$;

create or replace function private.frozen_predictions_v4_before_insert() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  -- Serialize imports before inspecting set identity. Concurrent direct inserts
  -- may be retried after a PostgreSQL deadlock; they cannot commit a mixed set.
  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'Prediction imports and freezing require READ COMMITTED isolation';
  end if;
  lock table public.frozen_predictions_v4 in share row exclusive mode;
  if not private.v4_active() then
    raise exception 'activate design v4 before importing predictions';
  end if;
  if private.v4_frozen() then
    raise exception 'predictions are frozen; an ontology or mapping change after the freeze cannot alter them';
  end if;
  if new.determination_level not in (select private.case_levels_v4(new.case_id)) then
    raise exception 'determination level % does not apply to case %', new.determination_level, new.case_id;
  end if;
  if exists (select 1 from public.frozen_predictions_v4 f where f.prediction_set_id <> new.prediction_set_id) then
    raise exception 'the frozen predictions must carry one prediction-set identifier';
  end if;
  if exists (select 1 from public.frozen_predictions_v4 f where f.tier1_version <> new.tier1_version) then
    raise exception 'the prediction set holds one Tier 1 version; % differs from the version already imported', new.tier1_version;
  end if;
  new.row_sha256 := private.sha256_hex(private.prediction_row_text_v4(new.prediction_set_id, new.case_id, new.determination_level,
                                       new.tier0_binary, new.tier1_version, new.tier1_status_raw, new.tier1_binary,
                                       new.stage_c_trial_status));
  new.imported_at := now();
  return new;
end $$;

create or replace function public.rpc_import_frozen_predictions_v4(p jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := private.assert_investigator();
  n integer;
begin
  -- Take the import lock before INSERT acquires its row-exclusive table lock.
  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'Prediction imports and freezing require READ COMMITTED isolation';
  end if;
  lock table public.frozen_predictions_v4 in share row exclusive mode;
  insert into public.frozen_predictions_v4 (prediction_set_id, case_id, determination_level, tier0_binary, tier1_version,
    tier1_status_raw, tier1_binary, stage_c_trial_status, row_sha256, imported_by)
  select x ->> 'prediction_set_id', x ->> 'case_id', x ->> 'determination_level', x ->> 'tier0_binary', x ->> 'tier1_version',
         x ->> 'tier1_status_raw', x ->> 'tier1_binary', nullif(x ->> 'stage_c_trial_status', ''), repeat('0', 64), me
  from jsonb_array_elements(p) x;
  get diagnostics n = row_count;
  return n;
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
begin
  -- Hold the same lock through hashing and manifest insertion. This also blocks
  -- freezing pre-upgrade mixed rows; no historical rows are rewritten.
  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'Prediction imports and freezing require READ COMMITTED isolation';
  end if;
  lock table public.frozen_predictions_v4 in share row exclusive mode;
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

insert into public.app_schema_version(version,description) values
 ('4.0.2-review-integrity','Stable locked archives, separate packet notes, immutable pre-context Step 1 and single prediction-set identity');
commit;
