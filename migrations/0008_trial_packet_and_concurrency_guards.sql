-- Additive trial-packet, snapshot-isolation, and adjudication-concurrency guards.
-- Preserve all prior migrations and recorded data.
begin;

-- Do not reinterpret an already locked formal Module A or Module B archive.
-- Synthetic pilot locks use verify_state and do not trigger this boundary.
do $$ begin
  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'Trial-packet and concurrency guard migration requires READ COMMITTED isolation';
  end if;
  lock table public.reference_locks, public.mb_reference_lock_v4 in share row exclusive mode;
  if (exists(select 1 from public.freeze_manifests_v4)
      and exists(select 1 from public.reference_locks where review_module='ONTOLOGY_AREA'))
     or exists(select 1 from public.mb_reference_lock_v4) then
    raise exception 'Existing locked formal reference requires explicit investigator migration review';
  end if;
end$$;

-- Every formal v4 TRIAL_AREA case is a two-step case requiring both determinations,
-- even before case_design_v3 is inserted.
create or replace function private.case_levels_v4(p_case_id text) returns setof text
language sql stable security definer set search_path = '' as $$
  select x.lvl from (
    select case when c.unit_type = 'TRIAL_AREA' or coalesce(d.two_step_required, false)
                then array['DESCRIPTOR_LEVEL_IN_TRIAL_CASE', 'TRIAL_LEVEL']
                else array['DESCRIPTOR_LEVEL'] end as lvls
    from public.cases c left join public.case_design_v3 d on d.case_id = c.case_id
    where c.case_id = p_case_id) s, unnest(s.lvls) as x(lvl)
$$;

create or replace function private.case_design_v3_v4_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  ut text;
begin
  if new.mode = 'FORMAL' and private.v4_active() then
    if new.analysis_set <> 'VALIDATION_HELDOUT' then
      raise exception 'design v4: every FORMAL case is held out; analysis_set % is not allowed', new.analysis_set;
    end if;
    select c.unit_type into ut from public.cases c where c.case_id = new.case_id;
    if ut = 'TRIAL_AREA' and not coalesce(new.two_step_required, false) then
      raise exception 'design v4: FORMAL TRIAL_AREA cases require two_step_required = true';
    end if;
  end if;
  return new;
end $$;

-- Step 2 trial-context packets on held-out cases are frozen by rpc_freeze_v4.
create or replace function private.trial_context_packets_v4_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.mode = 'FORMAL' and (private.v4_frozen() or exists(select 1 from public.case_records_v4 r where r.case_id = new.case_id)) then
    if current_setting('transaction_isolation') <> 'read committed' then
      raise exception 'Held-out trial context packets require READ COMMITTED isolation';
    end if;
    lock table public.trial_context_packets in share row exclusive mode;
    if private.v4_frozen() then
      raise exception 'Frozen held-out trial context packets cannot be added or modified';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists trial_context_packets_v4_guard on public.trial_context_packets;
create trigger trial_context_packets_v4_guard before insert on public.trial_context_packets
  for each row execute function private.trial_context_packets_v4_guard();
revoke all on function private.trial_context_packets_v4_guard() from public, anon, authenticated;

-- Serialize formal adjudications before inspecting the current supersession leaf.
create or replace function public.rpc_record_adjudication_v3(p jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := private.app_user_id();
  cid text := p ->> 'case_id';
  cvid uuid;
  vs text;
  m text;
  jid uuid;
begin
  if not (private.is_investigator() or private.is_adjudicator()) then
    raise exception 'investigator (multi-factor session) or ADJUDICATOR role is needed to adjudicate' using errcode = '42501';
  end if;
  cvid := private.latest_case_version_id(cid);
  select version_set_id, mode into vs, m from public.case_versions where case_version_id = cvid;
  if m = 'FORMAL' and private.v4_active() then
    if current_setting('transaction_isolation') <> 'read committed' then
      raise exception 'Formal adjudication requires READ COMMITTED isolation';
    end if;
    lock table public.adjudications in share row exclusive mode;
  end if;
  insert into public.adjudications (case_id, case_version_id, mode, layer, determination_level, adjudicated_decision,
    adjudicated_caveat, adjudication_status, adjudication_basis, rationale, evidence, considered_review_ids, ai_records_viewed,
    supersedes_adjudication_id, approved_for_pipeline, version_set_id, decided_by, disagreement_reason_code)
  values (cid, cvid, m, coalesce(p ->> 'layer', 'clinical_classification'), coalesce(p ->> 'determination_level', 'DESCRIPTOR_LEVEL'),
    p ->> 'decision', (p ->> 'caveat')::boolean, p ->> 'status', p ->> 'basis', p ->> 'rationale',
    coalesce(p -> 'evidence', '[]'::jsonb),
    coalesce((select array_agg(x::uuid) from jsonb_array_elements_text(p -> 'considered_ids') x), '{}'),
    coalesce((select array_agg(x::uuid) from jsonb_array_elements_text(p -> 'ai_records_viewed') x), '{}'),
    (p ->> 'supersedes')::uuid, false, vs, me, p ->> 'reason_code')
  returning adjudication_id into jid;
  return jid;
end $$;

create or replace function private.adjudications_before_insert() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  c record;
  cv record;
  dv3 record;
  cur uuid;
  n_bad integer;
  n_slots integer;
  r_role text;
begin
  if new.mode = 'FORMAL' and private.v4_active() then
    if current_setting('transaction_isolation') <> 'read committed' then
      raise exception 'Formal adjudication requires READ COMMITTED isolation';
    end if;
    lock table public.adjudications in share row exclusive mode;
  end if;
  select u.role into r_role from public.users u where u.user_id = new.decided_by;
  if r_role is distinct from 'INVESTIGATOR' and r_role is distinct from 'ADJUDICATOR' then
    raise exception 'only the investigator or an ADJUDICATOR adjudicates';
  end if;
  select * into c from public.cases where case_id = new.case_id;
  select * into dv3 from public.case_design_v3 where case_id = new.case_id;
  if c.withdrawn_at is not null then
    raise exception 'case % is withdrawn', new.case_id;
  end if;
  if r_role = 'ADJUDICATOR' then
    if c.mode <> 'FORMAL' then
      raise exception 'an ADJUDICATOR adjudicates FORMAL cases only';
    end if;
    if exists (select 1 from public.assignments a join public.reviewers rv on rv.reviewer_pseudo_id = a.reviewer_pseudo_id
               where a.case_id = new.case_id and rv.user_id = new.decided_by) then
      raise exception 'conflict: the adjudicator was assigned to review case %', new.case_id;
    end if;
    if cardinality(new.ai_records_viewed) > 0 then
      raise exception 'an ADJUDICATOR cannot record AI records as viewed';
    end if;
  end if;
  new.adjudicator_role := r_role;
  new.adjudicator_exposed_to_index_labels := (r_role = 'INVESTIGATOR');
  new.post_unblinding := (c.mode = 'FORMAL' and private.reference_locked(private.case_module(new.case_id)));
  if c.unit_type = 'DESCRIPTOR_AREA' and new.determination_level <> 'DESCRIPTOR_LEVEL' then
    raise exception 'descriptor-area cases are adjudicated at DESCRIPTOR_LEVEL';
  end if;
  if c.unit_type = 'TRIAL_AREA' and (coalesce(dv3.two_step_required, false) or (c.mode = 'FORMAL' and private.v4_active()))
     and new.determination_level not in ('DESCRIPTOR_LEVEL_IN_TRIAL_CASE', 'TRIAL_LEVEL') then
    raise exception 'two-step trial cases are adjudicated at DESCRIPTOR_LEVEL_IN_TRIAL_CASE or TRIAL_LEVEL';
  end if;
  if new.case_version_id is distinct from private.latest_case_version_id(new.case_id) then
    raise exception 'adjudicate the latest case version';
  end if;
  select * into cv from public.case_versions where case_version_id = new.case_version_id;
  if (new.layer = 'clinical_classification' and not cv.l1_applicable)
     or (new.layer = 'benchmark_compatibility' and not cv.l2_applicable)
     or (new.layer = 'analytical_ppr_validity' and not cv.l3_applicable) then
    raise exception 'layer % does not apply to case %', new.layer, new.case_id;
  end if;
  if c.mode = 'FORMAL' and private.formal_phase_status() not in ('COMPLETE', 'CLOSED_INCOMPLETE') then
    raise exception 'FORMAL adjudication opens only after the formal phase is closed';
  end if;
  if c.mode = 'PILOT' then
    select count(distinct a.reviewer_slot) into n_slots
    from public.assignments a join public.reviews r on r.assignment_id = a.assignment_id
    where a.case_id = new.case_id and a.withdrawn_at is null and r.case_version_id = new.case_version_id;
    if n_slots < 2 then
      raise exception 'PILOT adjudication needs reviews from both pilot reviewer slots';
    end if;
  end if;
  if new.determination_level = 'DESCRIPTOR_LEVEL_IN_TRIAL_CASE' then
    select count(*) into n_bad from unnest(new.considered_review_ids) rid
    where not exists (select 1 from public.trial_step1_records s where s.step1_id = rid and s.case_id = new.case_id
                      and s.case_version_id = new.case_version_id);
  else
    select count(*) into n_bad from unnest(new.considered_review_ids) rid
    where not exists (select 1 from public.reviews r where r.review_id = rid and r.case_id = new.case_id
                      and r.case_version_id = new.case_version_id);
  end if;
  if n_bad > 0 then
    raise exception 'considered_review_ids must be records of this case version at this determination level';
  end if;
  select j.adjudication_id into cur from public.adjudications j
  where j.case_id = new.case_id and j.layer = new.layer and j.determination_level = new.determination_level
    and not exists (select 1 from public.adjudications k where k.supersedes_adjudication_id = j.adjudication_id)
  order by j.decided_at desc limit 1;
  if new.supersedes_adjudication_id is distinct from cur then
    raise exception 'a new adjudication must supersede the current one (current: %)', coalesce(cur::text, 'none');
  end if;
  if new.version_set_id <> cv.version_set_id then
    raise exception 'adjudication version set must match the case version';
  end if;
  new.decided_at := now();
  return new;
end $$;

-- Require READ COMMITTED and serialize judgment snapshotting with withdrawals and adjudications.
create or replace function public.rpc_snapshot_judgments_v4() returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := private.assert_investigator();
  n integer;
  txt text;
  sid uuid;
begin
  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'Judgment snapshotting requires READ COMMITTED isolation';
  end if;
  lock table public.cases, public.assignments, public.reviews, public.trial_step1_records,
    public.adjudications, public.judgment_snapshots_v4 in share row exclusive mode;
  if not private.v4_frozen() then
    raise exception 'no v4 freeze';
  end if;
  if private.formal_phase_status() not in ('COMPLETE', 'CLOSED_INCOMPLETE') then
    raise exception 'the snapshot is taken after the formal phase closes';
  end if;
  if exists (select 1 from public.adjudications j where j.mode = 'FORMAL') then
    raise exception 'a FORMAL adjudication exists; the independent judgments must be snapshotted before adjudication';
  end if;
  select t.n, t.txt into n, txt from private.judgments_text_v4() t;
  insert into public.judgment_snapshots_v4 (n_rows, content_sha256, taken_by)
  values (n, private.sha256_hex(coalesce(txt, '')), me) returning snapshot_id into sid;
  return sid;
end $$;

-- Freeze locks trial_context_packets and verifies trial packets and prediction levels.
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
  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'Prediction imports and freezing require READ COMMITTED isolation';
  end if;
  lock table public.cases, public.case_records_v4, public.case_versions, public.trial_context_packets in share row exclusive mode;
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
  left join public.case_design_v3 d3 on d3.case_id = r.case_id
  where (c.unit_type = 'TRIAL_AREA' or coalesce(d3.two_step_required, false))
    and (not coalesce(d3.two_step_required, false)
         or not exists (select 1 from public.trial_context_packets tp where tp.case_id = r.case_id));
  if n_missing > 0 then
    raise exception '% active held-out trial cases lack two-step design or a frozen trial-context packet', n_missing;
  end if;
  select count(*) into n_missing from public.case_records_v4 r
  join public.cases c on c.case_id = r.case_id and c.withdrawn_at is null
  cross join lateral private.case_levels_v4(r.case_id) as l(lvl)
  where not exists (select 1 from public.frozen_predictions_v4 f where f.case_id = r.case_id and f.determination_level = l.lvl);
  if n_missing > 0 then
    raise exception '% required case levels have no frozen prediction', n_missing;
  end if;
  if exists (select 1 from public.frozen_predictions_v4 f
             where f.determination_level not in (select private.case_levels_v4(f.case_id))) then
    raise exception 'predictions carry a determination level that does not apply to the case';
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

-- Module B adjudication basis semantics: mirror Module A basis rules.
create or replace function private.assert_mb_adjudication_semantics_v4(
  p_unit text, p_status text, p_decision text, p_basis text
) returns void language plpgsql stable security definer set search_path = '' as $$
declare
  n integer;
  n_dist integer;
  d1 text;
  d2 text;
begin
  with eff as (
    select distinct on (r.mb_assignment_id) a.reviewer_slot, coalesce(r.compatibility, r.eligibility) as ans
    from public.mb_responses_v4 r
    join public.mb_assignments_v4 a on a.mb_assignment_id = r.mb_assignment_id
    where r.mb_unit_id = p_unit
    order by r.mb_assignment_id, r.revision_number desc
  )
  select count(*), count(distinct eff.ans),
         max(eff.ans) filter (where eff.reviewer_slot = 1),
         max(eff.ans) filter (where eff.reviewer_slot = 2)
  into n, n_dist, d1, d2 from eff;
  if n = 0 then
    raise exception 'Module B adjudication semantics: no independent response';
  end if;
  if (p_status = 'UNRESOLVED_ESCALATED') is distinct from (p_decision is null)
     or (p_status = 'UNRESOLVED_ESCALATED') is distinct from (p_basis = 'NONE') then
    raise exception 'Module B adjudication semantics: unresolved requires null decision and NONE basis';
  end if;
  if p_status = 'UNRESOLVED_ESCALATED' then
    return;
  end if;
  if p_basis = 'REVIEWER_1' and (d1 is null or p_decision is distinct from d1) then
    raise exception 'Module B adjudication semantics: REVIEWER_1 basis must adopt reviewer 1';
  elsif p_basis = 'REVIEWER_2' and (d2 is null or p_decision is distinct from d2) then
    raise exception 'Module B adjudication semantics: REVIEWER_2 basis must adopt reviewer 2';
  elsif p_basis = 'NEITHER' and (p_decision is not distinct from d1 or p_decision is not distinct from d2) then
    raise exception 'Module B adjudication semantics: NEITHER basis must differ from all submitted answers';
  end if;
end $$;
revoke all on function private.assert_mb_adjudication_semantics_v4(text, text, text, text) from public, anon, authenticated;

create or replace function private.mb_adjudications_v4_before_insert() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  r_role text;
  n integer;
  n_distinct integer;
  ut text;
begin
  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'Module B adjudication requires READ COMMITTED isolation';
  end if;
  lock table public.mb_adjudications_v4 in share row exclusive mode;
  select u.role into r_role from public.users u where u.user_id = new.decided_by;
  if r_role is null or r_role not in ('INVESTIGATOR', 'ADJUDICATOR') then
    raise exception 'only the investigator or an ADJUDICATOR adjudicates Module B';
  end if;
  if private.mb_phase() <> 'MB_CLOSED' then
    raise exception 'Module B adjudication opens only after the Module B phase closes';
  end if;
  if exists (select 1 from public.mb_reference_lock_v4) then
    raise exception 'the Module B reference is locked';
  end if;
  if exists (select 1 from public.mb_assignments_v4 a join public.reviewers rv on rv.reviewer_pseudo_id = a.reviewer_pseudo_id
             where a.mb_unit_id = new.mb_unit_id and rv.user_id = new.decided_by) then
    raise exception 'conflict: the adjudicator reviewed unit %', new.mb_unit_id;
  end if;
  select u.unit_type into ut from public.mb_units_v4 u where u.mb_unit_id = new.mb_unit_id;
  if new.decision is not null and ((ut = 'CONDITION_ROW_BENCHMARK') <>
       (new.decision in ('COMPATIBLE', 'COMPATIBLE_WITH_CAVEAT', 'INCOMPATIBLE', 'NOT_ESTIMABLE'))) then
    raise exception 'decision % does not fit a % unit', new.decision, ut;
  end if;
  with eff as (
    select distinct on (r.mb_assignment_id) coalesce(r.compatibility, r.eligibility) as ans
    from public.mb_responses_v4 r where r.mb_unit_id = new.mb_unit_id
    order by r.mb_assignment_id, r.revision_number desc)
  select count(*), count(distinct ans) into n, n_distinct from eff;
  if n = 0 then
    raise exception 'unit % has no response to adjudicate', new.mb_unit_id;
  elsif n = 1 and new.status not in ('SINGLE_REVIEW_ADJUDICATED', 'UNRESOLVED_ESCALATED') then
    raise exception 'a single-reviewed Module B unit is SINGLE_REVIEW_ADJUDICATED or UNRESOLVED_ESCALATED';
  elsif n = 2 and n_distinct = 1 then
    raise exception 'the reviewers agree on unit %; it enters the Module B reference by rule', new.mb_unit_id;
  elsif n = 2 and new.status = 'SINGLE_REVIEW_ADJUDICATED' then
    raise exception 'unit % was reviewed twice', new.mb_unit_id;
  end if;
  perform private.assert_mb_adjudication_semantics_v4(new.mb_unit_id, new.status, new.decision, new.basis);
  new.adjudicator_role := r_role;
  new.adjudicator_exposed_to_pipeline_status := (r_role = 'INVESTIGATOR');
  new.decided_at := now();
  return new;
end $$;

create or replace function public.rpc_lock_mb_reference_v4(p_attestation text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := private.assert_investigator();
  n_missing integer;
  n_units integer;
  n_unanswered integer;
  lid uuid;
  a record;
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
  for a in select * from public.mb_adjudications_v4 loop
    perform private.assert_mb_adjudication_semantics_v4(a.mb_unit_id, a.status, a.decision, a.basis);
  end loop;
  insert into public.mb_reference_lock_v4 (n_units, attestation, locked_by) values (n_units, p_attestation, me)
  returning mb_lock_id into lid;
  return lid;
end $$;

create or replace function public.rpc_verify_author_case(p jsonb) returns text
 language plpgsql security definer set search_path='' as $$
declare
 ph text;
 cid text := p ->> 'id';
 knd text := p ->> 'kind';
 pkt jsonb := p -> 'packet';
 tpkt jsonb := case when jsonb_typeof(p -> 'trialPacket') = 'object' then p -> 'trialPacket' else null end;
 bad_key text;
 r record;
 next_pos integer;
begin
 perform private.assert_investigator();
 select phase into ph from public.verify_state where singleton for update;
 if ph <> 'OPEN' then
   raise exception 'Configuration locked';
 end if;
 if cid is null or cid !~ '^SYN-[0-9]{3}$' then
   raise exception 'Synthetic pilot cases require a SYN-NNN identifier';
 end if;
 if knd not in ('DESCRIPTOR', 'TWO_STEP') then
   raise exception 'Synthetic pilot case kind must be DESCRIPTOR or TWO_STEP';
 end if;
 if jsonb_typeof(pkt) <> 'object' then
   raise exception 'Case packet must be a JSON object';
 end if;
 if (knd = 'TWO_STEP') <> (tpkt is not null) then
   raise exception 'TWO_STEP cases require a trialPacket and DESCRIPTOR cases cannot have one';
 end if;
 select k into bad_key from private.jsonb_all_keys(pkt || coalesce(tpkt, '{}'::jsonb)) k
 where k <> 'rubricPrompt'
   and k ~* '(^ai_|_ai_|stage_?[abcd]($|_)|llm|model_id|prompt|stratum|strata|selection_prob|sampling|weight|decision|proposed|adjudicat|reviewer|confidence|rule_id|original_technical|expected|tier0|tier1|enrol|female|male|sex|gender|baseline|result|participant|count|ppr|benchmark)'
 limit 1;
 if bad_key is not null then
   raise exception 'Packet key "%" is not allowed in a blinded reviewer packet', bad_key;
 end if;
 if (pkt::text || coalesce(tpkt::text, '')) ~* '\mNCT[0-9]{8}\M' then
   raise exception 'Real registry identifiers are forbidden in synthetic packets';
 end if;
 insert into public.verify_cases(id, kind, packet, trial_packet)
 values (cid, knd, pkt, tpkt);
 for r in
   select distinct a.reviewer_id
   from public.verify_assignments a
   order by a.reviewer_id
 loop
   select coalesce(max(position), 0) + 1 into next_pos
   from public.verify_assignments
   where reviewer_id = r.reviewer_id;
   insert into public.verify_assignments(case_id, reviewer_id, position)
   values (cid, r.reviewer_id, next_pos);
 end loop;
 perform private.verify_log('CASE_AUTHORED', cid, jsonb_build_object('kind', knd));
 return cid;
end$$;
revoke all on function public.rpc_verify_author_case(jsonb) from public, anon;
grant execute on function public.rpc_verify_author_case(jsonb) to authenticated;

create or replace function public.rpc_verify_export() returns jsonb
 language plpgsql security definer set search_path='' as $$
declare result jsonb;
begin
 perform private.assert_investigator();
 if private.verify_phase()<>'LOCKED' then raise exception 'Reference lock required before export'; end if;
 perform private.verify_assert_precontext_integrity();
 if (select snapshot_hash from public.verify_state) is distinct from private.verify_snapshot() then raise exception 'Judgment snapshot integrity failure'; end if;
 select jsonb_build_object('synthetic',true,'schemaVersion','4.0.5-trial-packet-concurrency-guards','analysisPlanStatus','PENDING_APPROVAL','state',(select to_jsonb(s) from public.verify_state s),'cases',(select jsonb_agg(to_jsonb(c)||jsonb_build_object('evidenceHash',private.sha256_hex(c.packet::text||coalesce(c.trial_packet::text,''))) order by c.id) from public.verify_cases c),'judgments',(select jsonb_agg(to_jsonb(r) order by r.case_id,r.level,r.reviewer_id,r.sequence) from public.verify_responses r),'adjudications',(select jsonb_agg(to_jsonb(j) order by j.case_id,j.level) from public.verify_adjudications j),'amendments',(select coalesce(jsonb_agg(to_jsonb(a) order by a.authorized_at),'[]'::jsonb) from public.verify_amendments a),'audit',(select jsonb_agg(to_jsonb(a) order by a.sequence) from public.verify_audit a where a.action <> 'EXPORT_REQUESTED')) into result;
 perform private.verify_log('EXPORT_REQUESTED');
 return result;
end$$;

insert into public.app_schema_version(version,description) values
 ('4.0.5-trial-packet-concurrency-guards','Frozen trial-context packets, two-step trial design consistency, snapshot isolation, serialized formal adjudications and Module B basis semantics')
on conflict (version) do nothing;
commit;
