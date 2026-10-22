begin;
-- Preserve the independent identity boundary from0010 while restoring a usable
-- legacy PILOT path. No historical judgments, responses, or packets are rewritten.
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
    if c.mode not in ('PILOT', 'FORMAL') then
      raise exception 'an ADJUDICATOR adjudicates PILOT or FORMAL cases only';
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

create or replace function public.rpc_record_adjudication(p_case_id text, p_layer text, p_decision text, p_caveat boolean,
  p_status text, p_basis text, p_rationale text, p_evidence jsonb, p_considered_review_ids uuid[],
  p_ai_records_viewed uuid[], p_supersedes uuid, p_approved_for_pipeline boolean) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := private.app_user_id();
  cvid uuid := private.latest_case_version_id(p_case_id);
  vs text;
  m text;
  jid uuid;
begin
  if not private.is_adjudicator() then
    raise exception 'An active ADJUDICATOR must record their own adjudication; investigators cannot enter judgments' using errcode = '42501';
  end if;
  select version_set_id, mode into vs, m from public.case_versions where case_version_id = cvid;
  insert into public.adjudications (case_id, case_version_id, mode, layer, adjudicated_decision, adjudicated_caveat,
    adjudication_status, adjudication_basis, rationale, evidence, considered_review_ids, ai_records_viewed,
    supersedes_adjudication_id, approved_for_pipeline, version_set_id, decided_by)
  values (p_case_id, cvid, m, p_layer, p_decision, p_caveat, p_status, p_basis, p_rationale,
    coalesce(p_evidence, '[]'::jsonb), p_considered_review_ids, coalesce(p_ai_records_viewed, '{}'),
    p_supersedes, coalesce(p_approved_for_pipeline, false), vs, me)
  returning adjudication_id into jid;
  return jid;
end $$;


-- A pilot adjudicator may read the two submitted responses and evidence only after
-- both active reviewer slots have submitted for the latest case version. No label
-- or audit policy is widened, and reviewers receive no new permissions.
create function private.legacy_pilot_ready_for_adjudicator(p_case_id text) returns boolean
language sql stable security definer set search_path = '' as $$
  select private.is_adjudicator()
    and exists(select 1 from public.cases c where c.case_id=p_case_id and c.mode='PILOT' and c.withdrawn_at is null)
    and not exists(select 1 from public.assignments a join public.reviewers rv on rv.reviewer_pseudo_id=a.reviewer_pseudo_id
                   where a.case_id=p_case_id and rv.user_id=private.app_user_id())
    and (select count(distinct a.reviewer_slot) from public.assignments a
         join public.reviews r on r.assignment_id=a.assignment_id
         join public.reviewers rv on rv.reviewer_pseudo_id=a.reviewer_pseudo_id
         join public.users u on u.user_id=rv.user_id
         where a.case_id=p_case_id and a.withdrawn_at is null and rv.withdrawn_at is null and u.is_active
           and r.case_version_id=private.latest_case_version_id(p_case_id))=2
$$;
revoke all on function private.legacy_pilot_ready_for_adjudicator(text) from public, anon;
grant execute on function private.legacy_pilot_ready_for_adjudicator(text) to authenticated;
create policy legacy_pilot_adjudicator_read on public.cases for select to authenticated
  using (mode='PILOT' and private.legacy_pilot_ready_for_adjudicator(case_id));
create policy legacy_pilot_adjudicator_read on public.case_versions for select to authenticated
  using (mode='PILOT' and private.legacy_pilot_ready_for_adjudicator(case_id));
create policy legacy_pilot_adjudicator_read on public.reviews for select to authenticated
  using (mode='PILOT' and private.legacy_pilot_ready_for_adjudicator(case_id));
create policy legacy_pilot_adjudicator_read on public.assignments for select to authenticated
  using (mode='PILOT' and private.legacy_pilot_ready_for_adjudicator(case_id));
create policy legacy_pilot_adjudicator_read on public.trial_step1_records for select to authenticated
  using (mode='PILOT' and private.legacy_pilot_ready_for_adjudicator(case_id));
create policy legacy_pilot_adjudicator_read on public.trial_context_packets for select to authenticated
  using (mode='PILOT' and private.legacy_pilot_ready_for_adjudicator(case_id));
create policy legacy_pilot_adjudicator_read on public.adjudications for select to authenticated
  using (mode='PILOT' and private.legacy_pilot_ready_for_adjudicator(case_id));

-- Match syntheticCaseAuthorSchema field-specific limits at the direct RPC boundary.
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
 if (p - array['id','kind','packet','trialPacket']) <> '{}'::jsonb then
   raise exception 'Author payload must match the canonical structure (unexpected keys)';
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
      or length(pkt ->> req_key) > 4000
      or length(btrim(pkt ->> req_key)) > (case req_key
        when 'title' then 300 when 'area' then 100 when 'descriptorName' then 300
        when 'scopeNote' then 2000 when 'areaDefinition' then 2000
        when 'source' then 200 when 'sourceVersion' then 100 else 4000 end) then
     raise exception 'Case packet must match the canonical EvidencePacket structure (invalid or missing "%")', req_key;
   end if;
 end loop;
 if coalesce(pkt ->> 'descriptorId', '') !~ '^(TESTFX|SYN)-D[0-9]{3,6}$' then
   raise exception 'Case packet must match the canonical EvidencePacket structure (invalid descriptorId)';
 end if;
 if coalesce(jsonb_typeof(pkt -> 'entryTerms'), '') <> 'array'
    or jsonb_array_length(pkt -> 'entryTerms') not between 1 and 20
    or exists (
      select 1 from jsonb_array_elements(pkt -> 'entryTerms') e
      where coalesce(jsonb_typeof(e), '') <> 'string'
         or length(btrim(coalesce(e #>> '{}', ''))) not between 1 and 200
    ) then
   raise exception 'Case packet must match the canonical EvidencePacket structure (invalid entryTerms)';
 end if;
 if coalesce(jsonb_typeof(pkt -> 'treeNumbers'), '') <> 'array'
    or jsonb_array_length(pkt -> 'treeNumbers') not between 1 and 20
    or exists (
      select 1 from jsonb_array_elements(pkt -> 'treeNumbers') tn
      where coalesce(jsonb_typeof(tn), '') <> 'object'
         or (tn - array['number', 'label']) <> '{}'::jsonb
         or coalesce(jsonb_typeof(tn -> 'number'), '') <> 'string'
         or coalesce(jsonb_typeof(tn -> 'label'), '') <> 'string'
         or length(btrim(coalesce(tn ->> 'number', ''))) not between 1 and 120
         or coalesce(tn ->> 'number', '') !~ '^(TESTFX|SYN)\.[0-9]{3}(\.[0-9]{3})*$'
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
        or length(tpkt ->> req_key) > 4000
        or length(btrim(tpkt ->> req_key)) > (case req_key
          when 'title' then 300 when 'summary' then 4000 when 'sourceVersion' then 100 else 200 end) then
       raise exception 'Trial packet must match the canonical TrialPacket structure (invalid or missing "%")', req_key;
     end if;
   end loop;
   if coalesce(tpkt ->> 'registryId', '') !~ '^SYN-NCT-[0-9]{4,8}$' then
     raise exception 'Trial packet must match the canonical TrialPacket structure (invalid registryId)';
   end if;
   foreach req_key in array array['conditions','interventions','primaryOutcomes'] loop
     if coalesce(jsonb_typeof(tpkt -> req_key), '') <> 'array'
        or jsonb_array_length(tpkt -> req_key) not between 1 and 20
        or exists (
          select 1 from jsonb_array_elements(tpkt -> req_key) e
          where coalesce(jsonb_typeof(e), '') <> 'string'
             or length(btrim(coalesce(e #>> '{}', ''))) not between 1 and
               case when req_key = 'primaryOutcomes' then 300 else 200 end
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

insert into public.app_schema_version(version,description) values
 ('5.1.2-legacy-pilot-packet-guards','Restore independent legacy pilot adjudication and enforce canonical packet size limits')
on conflict(version) do nothing;
commit;
