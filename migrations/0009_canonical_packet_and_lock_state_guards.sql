-- Additive canonical-packet validation and READ COMMITTED lock-state concurrency guards.
-- Applies cleanly on top of any database that has applied 0008 (either revision) and
-- preserves all existing pilot/formal records and frozen-reference safeguards.
begin;

-- Do not reinterpret an already locked formal Module A or Module B archive.
-- Synthetic pilot locks use verify_state and do not trigger this boundary.
lock table public.reference_locks, public.mb_reference_lock_v4 in share row exclusive mode;
do $$ begin
  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'Canonical-packet and lock-state guard migration requires READ COMMITTED isolation';
  end if;
  lock table public.reference_locks, public.mb_reference_lock_v4 in share row exclusive mode;
  if (exists(select 1 from public.freeze_manifests_v4)
      and exists(select 1 from public.reference_locks where review_module='ONTOLOGY_AREA'))
     or exists(select 1 from public.mb_reference_lock_v4) then
    raise exception 'Existing locked formal reference requires explicit investigator migration review';
  end if;
end$$;

-- Pre-existing singleton state row so concurrent READ COMMITTED sessions inside
-- SELECT rpc_...() portals observe committed freeze/lock/adjudication transitions
-- via PostgreSQL EvalPlanQual (SELECT ... FOR SHARE / FOR UPDATE).
create table if not exists private.v4_lock_state (
  singleton boolean primary key default true check (singleton),
  frozen boolean not null default false,
  reference_locked boolean not null default false,
  adjudicated_roots jsonb not null default '{}'::jsonb
);
revoke all on table private.v4_lock_state from public, anon, authenticated;
insert into private.v4_lock_state (singleton, frozen, reference_locked, adjudicated_roots)
values (
  true,
  exists (select 1 from public.freeze_manifests_v4),
  exists (select 1 from public.reference_locks where review_module = 'ONTOLOGY_AREA'),
  coalesce(
    (
      select jsonb_object_agg(
        j.case_id || '::' || j.determination_level || '::' || j.layer,
        j.adjudication_id::text
      )
      from public.adjudications j
      where j.mode = 'FORMAL'
        and not j.post_unblinding
        and not exists (
          select 1 from public.adjudications k
          where k.supersedes_adjudication_id = j.adjudication_id
            and not k.post_unblinding
        )
    ),
    '{}'::jsonb
  )
)
on conflict (singleton) do update
  set frozen = excluded.frozen,
      reference_locked = excluded.reference_locked,
      adjudicated_roots = excluded.adjudicated_roots;

create or replace function private.cases_v4_no_withdraw_after_freeze() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  locked_freeze boolean := false;
begin
  if old.withdrawn_at is null and new.withdrawn_at is not null
     and exists (select 1 from public.case_records_v4 r where r.case_id=old.case_id) then
    if current_setting('transaction_isolation') <> 'read committed' then
      raise exception 'Held-out withdrawal requires READ COMMITTED isolation';
    end if;
    lock table public.cases in share row exclusive mode;
    select s.frozen into locked_freeze from private.v4_lock_state s where s.singleton for share;
  end if;
  if old.withdrawn_at is null and new.withdrawn_at is not null
     and (coalesce(locked_freeze, false) or private.v4_frozen())
     and exists (select 1 from public.case_records_v4 r where r.case_id = old.case_id) then
    raise exception 'design v4: % is a frozen held-out case and cannot be withdrawn; the case list is fixed at the freeze', old.case_id;
  end if;
  return new;
end $$;

create or replace function private.case_versions_v4_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  locked_freeze boolean := false;
begin
  if new.mode='FORMAL' and exists(select 1 from public.case_records_v4 r where r.case_id=new.case_id) then
    if current_setting('transaction_isolation') <> 'read committed' then
      raise exception 'Held-out packet versioning requires READ COMMITTED isolation';
    end if;
    lock table public.case_versions in share row exclusive mode;
    select s.frozen into locked_freeze from private.v4_lock_state s where s.singleton for share;
    if coalesce(locked_freeze, false) or private.v4_frozen() then
      raise exception 'Frozen held-out evidence packets cannot be versioned';
    end if;
  end if;
  if new.mode = 'FORMAL' and (coalesce(locked_freeze, false) or private.v4_frozen())
     and (select o.registered_at from public.ontology_versions o where o.version_set_id = new.version_set_id)
         > (select f.frozen_at from public.freeze_manifests_v4 f) then
    raise exception 'a FORMAL case version cannot use a version set registered after the freeze';
  end if;
  return new;
end $$;

create or replace function private.assignments_reference_lock_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  locked_ref boolean := false;
begin
  if old.withdrawn_at is null and new.withdrawn_at is not null
     and exists(select 1 from public.case_records_v4 r where r.case_id=old.case_id) then
    if current_setting('transaction_isolation') <> 'read committed' then
      raise exception 'Held-out withdrawal requires READ COMMITTED isolation';
    end if;
    lock table public.assignments in share row exclusive mode;
    select s.reference_locked into locked_ref from private.v4_lock_state s where s.singleton for share;
    if coalesce(locked_ref, false) or private.reference_locked('ONTOLOGY_AREA') then
      raise exception 'Locked reference prevents assignment withdrawal';
    end if;
  end if;
  return new;
end$$;

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
  lock table public.cases, public.case_versions, public.assignments,
    public.reviews, public.trial_step1_records, public.adjudications,
    public.reference_locks in share row exclusive mode;
  update private.v4_lock_state set reference_locked = true where singleton;
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

create or replace function private.trial_context_packets_v4_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  locked_freeze boolean := false;
begin
  if new.mode = 'FORMAL' and (private.v4_frozen() or exists(select 1 from public.case_records_v4 r where r.case_id = new.case_id)) then
    if current_setting('transaction_isolation') <> 'read committed' then
      raise exception 'Held-out trial context packets require READ COMMITTED isolation';
    end if;
    lock table public.trial_context_packets in share row exclusive mode;
    select s.frozen into locked_freeze from private.v4_lock_state s where s.singleton for share;
    if coalesce(locked_freeze, false) or private.v4_frozen() then
      raise exception 'Frozen held-out trial context packets cannot be added or modified';
    end if;
  end if;
  return new;
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
  if new.mode = 'FORMAL' and private.v4_active() and not new.post_unblinding then
    declare
      roots jsonb;
      rkey text := new.case_id || '::' || new.determination_level || '::' || new.layer;
    begin
      select s.adjudicated_roots into roots from private.v4_lock_state s where s.singleton for update;
      if cur is null and (roots ? rkey) then
        cur := (roots ->> rkey)::uuid;
      end if;
      if new.supersedes_adjudication_id is distinct from cur then
        raise exception 'a new adjudication must supersede the current one (current: %)', coalesce(cur::text, 'none');
      end if;
      update private.v4_lock_state
      set adjudicated_roots = jsonb_set(coalesce(adjudicated_roots, '{}'::jsonb), array[rkey], to_jsonb(new.adjudication_id::text), true)
      where singleton;
    end;
  elsif new.supersedes_adjudication_id is distinct from cur then
    raise exception 'a new adjudication must supersede the current one (current: %)', coalesce(cur::text, 'none');
  end if;
  if new.version_set_id <> cv.version_set_id then
    raise exception 'adjudication version set must match the case version';
  end if;
  new.decided_at := now();
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
  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'Prediction imports and freezing require READ COMMITTED isolation';
  end if;
  lock table public.cases, public.case_records_v4, public.case_versions, public.trial_context_packets in share row exclusive mode;
  lock table public.frozen_predictions_v4 in share row exclusive mode;
  update private.v4_lock_state set frozen = true where singleton;
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

create or replace function public.rpc_verify_author_case(p jsonb) returns text
 language plpgsql security definer set search_path='' as $$
declare
 ph text;
 cid text;
 knd text;
 pkt jsonb;
 tpkt jsonb;
 bad_key text;
 req_key text;
 r record;
 next_pos integer;
begin
 perform private.assert_investigator();
 select phase into ph from public.verify_state where singleton for update;
 if ph <> 'OPEN' then
   raise exception 'Configuration locked';
 end if;
 if coalesce(jsonb_typeof(p), '') <> 'object' then
   raise exception 'Author payload must be a JSON object';
 end if;
 cid := p ->> 'id';
 knd := p ->> 'kind';
 pkt := p -> 'packet';
 if cid is null or cid !~ '^SYN-[0-9]{3}$' then
   raise exception 'Synthetic pilot cases require a SYN-NNN identifier';
 end if;
 if knd is null or knd not in ('DESCRIPTOR', 'TWO_STEP') then
   raise exception 'Synthetic pilot case kind must be DESCRIPTOR or TWO_STEP';
 end if;
 if coalesce(jsonb_typeof(pkt), '') <> 'object' then
   raise exception 'Case packet must be a JSON object';
 end if;
 if knd = 'DESCRIPTOR' and coalesce(jsonb_typeof(p -> 'trialPacket'), 'null') <> 'null' then
   raise exception 'TWO_STEP cases require a trialPacket and DESCRIPTOR cases cannot have one';
 end if;
 if knd = 'TWO_STEP' and coalesce(jsonb_typeof(p -> 'trialPacket'), '') <> 'object' then
   raise exception 'TWO_STEP cases require a trialPacket and DESCRIPTOR cases cannot have one';
 end if;
 tpkt := case when knd = 'TWO_STEP' then p -> 'trialPacket' else null end;

 select k into bad_key from private.jsonb_all_keys(pkt || coalesce(tpkt, '{}'::jsonb)) k
 where k ~* '(^ai_|_ai_|stage_?[abcd]($|_)|llm|model_id|prompt|stratum|strata|selection_prob|sampling|weight|decision|proposed|adjudicat|reviewer|confidence|rule_id|original_technical|expected|tier0|tier1|enrol|female|male|sex|gender|baseline|result|participant|count|ppr|benchmark)'
 limit 1;
 if bad_key is not null then
   raise exception 'Packet key "%" is not allowed in a blinded reviewer packet', bad_key;
 end if;

 if (pkt - array['title','area','descriptorName','descriptorId','scopeNote','entryTerms','treeNumbers','areaDefinition','source','sourceVersion']) <> '{}'::jsonb then
   raise exception 'Case packet must match the canonical EvidencePacket structure (unexpected keys)';
 end if;
 foreach req_key in array array['title','area','descriptorName','descriptorId','scopeNote','areaDefinition','source','sourceVersion'] loop
   if coalesce(jsonb_typeof(pkt -> req_key), '') <> 'string'
      or length(btrim(coalesce(pkt ->> req_key, ''))) = 0
      or length(pkt ->> req_key) > 4000 then
     raise exception 'Case packet must match the canonical EvidencePacket structure (invalid or missing "%")', req_key;
   end if;
 end loop;
 if coalesce(pkt ->> 'descriptorId', '') !~ '^(TESTFX|SYN)-D[0-9]{3,6}$' then
   raise exception 'Case packet must match the canonical EvidencePacket structure (invalid descriptorId)';
 end if;
 if coalesce(jsonb_typeof(pkt -> 'entryTerms'), '') <> 'array'
    or jsonb_array_length(pkt -> 'entryTerms') < 1
    or exists (
      select 1 from jsonb_array_elements(pkt -> 'entryTerms') e
      where coalesce(jsonb_typeof(e), '') <> 'string'
         or length(btrim(coalesce(e #>> '{}', ''))) not between 1 and 200
    ) then
   raise exception 'Case packet must match the canonical EvidencePacket structure (invalid entryTerms)';
 end if;
 if coalesce(jsonb_typeof(pkt -> 'treeNumbers'), '') <> 'array'
    or jsonb_array_length(pkt -> 'treeNumbers') < 1
    or exists (
      select 1 from jsonb_array_elements(pkt -> 'treeNumbers') tn
      where coalesce(jsonb_typeof(tn), '') <> 'object'
         or (tn - array['number', 'label']) <> '{}'::jsonb
         or coalesce(jsonb_typeof(tn -> 'number'), '') <> 'string'
         or coalesce(jsonb_typeof(tn -> 'label'), '') <> 'string'
         or length(btrim(coalesce(tn ->> 'number', ''))) not between 1 and 120
         or length(btrim(coalesce(tn ->> 'label', ''))) not between 1 and 200
    ) then
   raise exception 'Case packet must match the canonical EvidencePacket structure (invalid treeNumbers)';
 end if;

 if tpkt is not null then
   if (tpkt - array['registryId','title','summary','conditions','interventions','primaryOutcomes','studyType','primaryPurpose','phase','ageRange','source','sourceVersion']) <> '{}'::jsonb then
     raise exception 'Trial packet must match the canonical TrialPacket structure (unexpected keys)';
   end if;
   foreach req_key in array array['registryId','title','summary','studyType','primaryPurpose','phase','ageRange','source','sourceVersion'] loop
     if coalesce(jsonb_typeof(tpkt -> req_key), '') <> 'string'
        or length(btrim(coalesce(tpkt ->> req_key, ''))) = 0
        or length(tpkt ->> req_key) > 4000 then
       raise exception 'Trial packet must match the canonical TrialPacket structure (invalid or missing "%")', req_key;
     end if;
   end loop;
   if coalesce(tpkt ->> 'registryId', '') !~ '^SYN-NCT-[0-9]{4,8}$' then
     raise exception 'Trial packet must match the canonical TrialPacket structure (invalid registryId)';
   end if;
   foreach req_key in array array['conditions','interventions','primaryOutcomes'] loop
     if coalesce(jsonb_typeof(tpkt -> req_key), '') <> 'array'
        or jsonb_array_length(tpkt -> req_key) < 1
        or exists (
          select 1 from jsonb_array_elements(tpkt -> req_key) e
          where coalesce(jsonb_typeof(e), '') <> 'string'
             or length(btrim(coalesce(e #>> '{}', ''))) not between 1 and 500
        ) then
       raise exception 'Trial packet must match the canonical TrialPacket structure (invalid "%")', req_key;
     end if;
   end loop;
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
 select jsonb_build_object('synthetic',true,'schemaVersion','4.0.6-canonical-packet-lock-state','analysisPlanStatus','PENDING_APPROVAL','state',(select to_jsonb(s) from public.verify_state s),'cases',(select jsonb_agg(to_jsonb(c)||jsonb_build_object('evidenceHash',private.sha256_hex(c.packet::text||coalesce(c.trial_packet::text,''))) order by c.id) from public.verify_cases c),'judgments',(select jsonb_agg(to_jsonb(r) order by r.case_id,r.level,r.reviewer_id,r.sequence) from public.verify_responses r),'adjudications',(select jsonb_agg(to_jsonb(j) order by j.case_id,j.level) from public.verify_adjudications j),'amendments',(select coalesce(jsonb_agg(to_jsonb(a) order by a.authorized_at),'[]'::jsonb) from public.verify_amendments a),'audit',(select jsonb_agg(to_jsonb(a) order by a.sequence) from public.verify_audit a where a.action <> 'EXPORT_REQUESTED')) into result;
 perform private.verify_log('EXPORT_REQUESTED');
 return result;
end$$;

insert into public.app_schema_version(version,description) values
 ('4.0.6-canonical-packet-lock-state','Canonical EvidencePacket/TrialPacket RPC validation and READ COMMITTED EvalPlanQual lock-state concurrency guards')
on conflict (version) do nothing;
commit;
