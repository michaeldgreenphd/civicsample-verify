-- =============================================================================
-- migrations/0018_mapping_confirmation_review_fixes.sql
-- Codex review of PR #6 (reviewed commit 259df861). Additive: migration 0016 is unchanged; the
-- functions, view and constraints below replace or tighten what 0016 created.
--   1. Synthetic-only import at the database boundary: EVALUATION records and real registry
--      references are refused by the import trigger until formal activation is approved.
--   2. Lock guard: every assigned non-training mapping needs both final responses; any
--      disagreement or any INSUFFICIENT_INFORMATION response needs an adjudication.
--   3. Adjudication: decision and basis are validated together against the reviewer answers;
--      RUBRIC_ADDITION_REVIEWED records the concordant insufficient-information outcome with no
--      YES/NO decision and basis NONE.
--   4. Export view carries the assignment value and the displayed evidence version.
--   5. Import consistency: condition_set_id equals the campaign's; condition code and label form
--      one entry of the condition set; evidence schema_version is required; a detailed
--      description is consistent (present with text, absent without); provenance names
--      (source.system, source.version, source.fields, detailed_description.source_field) are
--      validated against the same boundary as the keys.
--   6. Audit rows for mc_cases carry identifiers and hashes, never the evidence payload.
--   7. Attestations need twenty non-blank characters.
-- =============================================================================
begin;

insert into public.app_schema_version (version, description)
values ('6.0.1-mapping-confirmation-review-fixes', 'mapping confirmation: synthetic-only import, complete-campaign lock, decision/basis consistency, export columns, import consistency, hash-only audit');

-- -----------------------------------------------------------------------------
-- Condition set entries (code and label as one entry; PROPOSED, approval pending)
-- -----------------------------------------------------------------------------
create function private.mc_condition_label(p_code text) returns text
language sql immutable set search_path = '' as $$
  select case p_code
    when 'OBE' then 'Obesity'
    when 'AST' then 'Asthma'
    when 'HTN' then 'Hypertension'
    when 'DEP' then 'Depression'
    when 'DIAB' then 'Diabetes Mellitus'
    when 'COV' then 'COVID-19'
    when 'SCZ' then 'Schizophrenia'
    when 'CAN_ALL' then 'Neoplasms'
    when 'COPD' then 'Pulmonary Disease, Chronic Obstructive'
    when 'PAIN' then 'Pain'
  end
$$;
revoke all on function private.mc_condition_label(text) from public, anon, authenticated;
alter table public.mc_cases add constraint mc_cases_condition_entry_check
  check (condition_label = private.mc_condition_label(condition_code));
alter table public.mc_campaign_events add constraint mc_campaign_events_attestation_text_check
  check (length(trim(attestation)) >= 20);

-- -----------------------------------------------------------------------------
-- Evidence: keys and provenance values on one allow list; required schema version
-- -----------------------------------------------------------------------------
create or replace function private.assert_mc_evidence(p jsonb) returns void
language plpgsql immutable set search_path = '' as $$
declare
  bad text;
  s jsonb;
  forbidden text := '(^ai_|_ai_|stage_?[abcd]($|_)|llm|model|prompt|predict|reason|rationale|confidence|label|tier|curated|stratum|strata|weight|probab|sampling|reviewer|adjudicat|decision|expected|enrol|(^|_)sex($|_)|gender|female|(^|_)male($|_)|participant|count|result|url|link|classif|infer|score)';
begin
  select k into bad from jsonb_object_keys(p) k
  where k not in ('schema_version', 'brief_title', 'brief_summary', 'detailed_description', 'source') limit 1;
  if bad is not null then
    raise exception 'mapping evidence key "%" is not on the reviewer-visible allow list', bad using errcode = '22023';
  end if;
  if p ->> 'schema_version' is distinct from 'mc-evidence-1' then
    raise exception 'mapping evidence schema_version must be mc-evidence-1' using errcode = '22023';
  end if;
  if coalesce(jsonb_typeof(p -> 'brief_title'), '') <> 'string' or length(p ->> 'brief_title') = 0 then
    raise exception 'mapping evidence needs brief_title from the source record' using errcode = '22023';
  end if;
  s := p -> 'brief_summary';
  if coalesce(jsonb_typeof(s), '') <> 'object' or coalesce(jsonb_typeof(s -> 'present'), '') <> 'boolean' then
    raise exception 'brief_summary must be an object with an explicit present flag' using errcode = '22023';
  end if;
  if (s ->> 'present')::boolean then
    if coalesce(jsonb_typeof(s -> 'text'), '') <> 'string' or length(s ->> 'text') = 0 then
      raise exception 'a present brief_summary carries the source text' using errcode = '22023';
    end if;
  elsif coalesce(jsonb_typeof(s -> 'text'), 'null') <> 'null' then
    raise exception 'a missing brief_summary carries no text (never generate or substitute one)' using errcode = '22023';
  end if;
  if p ? 'detailed_description' then
    s := p -> 'detailed_description';
    if coalesce(jsonb_typeof(s), '') <> 'object' or coalesce(jsonb_typeof(s -> 'present'), '') <> 'boolean'
       or coalesce(jsonb_typeof(s -> 'source_field'), '') <> 'string' then
      raise exception 'detailed_description needs present and source_field provenance' using errcode = '22023';
    end if;
    if s ->> 'source_field' <> 'detailed_description' then
      raise exception 'detailed_description provenance names a field that is not a registry description' using errcode = '22023';
    end if;
    if (s ->> 'present')::boolean then
      if coalesce(jsonb_typeof(s -> 'text'), '') <> 'string' or length(s ->> 'text') = 0 then
        raise exception 'a present detailed_description carries the source text' using errcode = '22023';
      end if;
    elsif coalesce(jsonb_typeof(s -> 'text'), 'null') <> 'null' then
      raise exception 'a missing detailed_description carries no text (never generate or substitute one)' using errcode = '22023';
    end if;
  end if;
  s := p -> 'source';
  if coalesce(jsonb_typeof(s), '') <> 'object' or coalesce(jsonb_typeof(s -> 'system'), '') <> 'string'
     or coalesce(jsonb_typeof(s -> 'version'), '') <> 'string' or coalesce(jsonb_typeof(s -> 'fields'), '') <> 'array' then
    raise exception 'mapping evidence source needs system, version and fields' using errcode = '22023';
  end if;
  if (s ->> 'system') !~ '^[A-Z][A-Z0-9_]{1,39}$' or (s ->> 'system') ~* forbidden then
    raise exception 'mapping evidence source.system "%" is not an accepted registry source name', s ->> 'system' using errcode = '22023';
  end if;
  if length(s ->> 'version') not between 1 and 80 or (s ->> 'version') ~* forbidden then
    raise exception 'mapping evidence source.version is not an accepted provenance value' using errcode = '22023';
  end if;
  select f into bad from jsonb_array_elements_text(s -> 'fields') f
  where f not in ('brief_title', 'brief_summary', 'detailed_description') limit 1;
  if bad is not null then
    raise exception 'mapping evidence source field "%" is not a reviewer-visible registry field', bad using errcode = '22023';
  end if;
  select k into bad from private.jsonb_all_keys(p) k where k ~* forbidden limit 1;
  if bad is not null then
    raise exception 'mapping evidence key "%" could carry a prediction, reasoning or outcome field and is not allowed', bad using errcode = '22023';
  end if;
  if p::text ~* 'clinicaltrials\.gov|https?://' then
    raise exception 'mapping evidence carries no registry link or address' using errcode = '22023';
  end if;
end $$;

-- -----------------------------------------------------------------------------
-- Import: synthetic only, one condition set, consistent entries
-- -----------------------------------------------------------------------------
create or replace function private.mc_cases_before_insert() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  camp record;
begin
  if private.mc_phase() <> 'OPEN' then
    raise exception 'mapping cases are imported only while the campaign is open';
  end if;
  select * into camp from public.mc_campaign;
  if camp.singleton is null then
    raise exception 'create the mapping-confirmation campaign (rpc_mc_create_campaign) before importing cases';
  end if;
  -- The 100 evaluation mappings and any real registry reference wait for the approved condition
  -- set, sampling frame, frozen rubric and analysis specification; this build is synthetic only.
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

-- -----------------------------------------------------------------------------
-- Adjudication: decision and basis together, against the two final answers
-- -----------------------------------------------------------------------------
alter table public.mc_adjudications drop constraint mc_adjudications_check;
alter table public.mc_adjudications drop constraint mc_adjudications_check1;
alter table public.mc_adjudications add constraint mc_adjudications_decision_status_check
  check ((decision is null) = (status in ('UNRESOLVED_ESCALATED', 'RUBRIC_ADDITION_REVIEWED')));
alter table public.mc_adjudications add constraint mc_adjudications_basis_decision_check
  check ((basis = 'NONE') = (decision is null));

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
  if private.mc_phase() <> 'ADJUDICATION' then
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

-- -----------------------------------------------------------------------------
-- Lock: complete campaign, every disagreement and proposed rubric addition adjudicated
-- -----------------------------------------------------------------------------
create or replace function private.mc_campaign_events_before_insert() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  ph text := private.mc_phase();
  n_open integer;
  n_incomplete integer;
begin
  if not private.is_investigator() then
    raise exception 'only the investigator changes the mapping-confirmation phase' using errcode = '42501';
  end if;
  if new.event_type = 'CLOSED' then
    if ph <> 'OPEN' then raise exception 'the campaign is not open (phase %)', ph; end if;
    update public.mc_campaign set phase = 'CLOSED' where singleton;
  elsif new.event_type = 'ADJUDICATION_AUTHORIZED' then
    if ph <> 'CLOSED' then raise exception 'close the campaign before authorizing adjudication (phase %)', ph; end if;
    update public.mc_campaign set phase = 'ADJUDICATION' where singleton;
  elsif new.event_type = 'LOCKED' then
    if ph <> 'ADJUDICATION' then raise exception 'authorize adjudication before locking (phase %)', ph; end if;
    select count(*) into n_incomplete from public.mc_assignments a join public.mc_cases c on c.case_id = a.case_id
    where c.record_category <> 'TRAINING_EXAMPLE'
      and not exists (select 1 from public.mc_responses r where r.assignment_id = a.assignment_id);
    if n_incomplete > 0 then
      raise exception '% assigned mappings have no final response; an incomplete campaign cannot be locked', n_incomplete;
    end if;
    select count(*) into n_open from public.mc_cases c
    where c.record_category <> 'TRAINING_EXAMPLE'
      and exists (select 1 from public.mc_assignments a join public.mc_responses r on r.assignment_id = a.assignment_id where a.case_id = c.case_id)
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

-- -----------------------------------------------------------------------------
-- Audit: identifiers and hashes for mapping cases (never the evidence payload)
-- -----------------------------------------------------------------------------
create or replace function private.audit_row_mc() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  rec jsonb := to_jsonb(coalesce(new, old));
  pk text;
  details jsonb;
begin
  pk := coalesce(rec ->> 'response_id', rec ->> 'adjudication_id', rec ->> 'assignment_id', rec ->> 'export_id',
                 rec ->> 'event_id', rec ->> 'case_id', rec ->> 'singleton');
  if tg_table_name = 'mc_responses' then
    details := jsonb_build_object('case_id', rec ->> 'case_id', 'assignment_id', rec ->> 'assignment_id',
                                  'reviewer_pseudo_id', rec ->> 'reviewer_pseudo_id', 'content_sha256', rec ->> 'content_sha256');
  elsif tg_table_name = 'mc_adjudications' then
    details := jsonb_build_object('case_id', rec ->> 'case_id', 'status', rec ->> 'status',
                                  'content_sha256', private.sha256_hex(rec::text));
  elsif tg_table_name = 'mc_cases' then
    details := jsonb_build_object('case_id', rec ->> 'case_id', 'record_category', rec ->> 'record_category',
                                  'condition_code', rec ->> 'condition_code', 'condition_set_id', rec ->> 'condition_set_id',
                                  'assignment_sha256', rec ->> 'assignment_sha256', 'evidence_sha256', rec ->> 'evidence_sha256',
                                  'evidence_version', rec -> 'evidence_version');
  else
    details := rec;
  end if;
  insert into public.audit_log (actor_user_id, actor_role, action, entity_table, entity_id, mode, details)
  values (private.app_user_id(), coalesce(private.app_role(), current_user), tg_op, tg_table_name, pk, null, details);
  return null;
end $$;

-- -----------------------------------------------------------------------------
-- Export: the assignment value and the displayed evidence version
-- -----------------------------------------------------------------------------
drop view public.v_mc_export;
create view public.v_mc_export with (security_invoker = true) as
select c.record_category, c.case_id, c.trial_ref, c.condition_code, c.condition_label, c.condition_set_id,
       (c.assignment ->> 'assigned')::boolean as assignment_assigned,
       c.assignment ->> 'assignment_source' as assignment_source, c.assignment ->> 'assignment_version' as assignment_version,
       c.assignment_sha256, c.evidence_sha256, c.evidence_version,
       (c.evidence -> 'brief_summary' ->> 'present')::boolean as brief_summary_present,
       c.evidence ? 'detailed_description' as detailed_description_included,
       a.reviewer_slot, a.reviewer_pseudo_id, r.answer, r.annotation, r.rubric_addition_proposed, r.review_mode,
       r.assignment_visibility, r.displayed_assignment_sha256, r.displayed_evidence_sha256, r.displayed_evidence_version,
       r.rubric_version, r.rubric_sha256, r.app_git_sha as response_app_git_sha, r.submitted_at,
       j.adjudication_id, j.decision as adjudicated_decision, j.status as adjudication_status, j.basis as adjudication_basis,
       j.adjudicator_role, j.decided_at as adjudicated_at
from public.mc_cases c
join public.mc_assignments a on a.case_id = c.case_id
left join public.mc_responses r on r.assignment_id = a.assignment_id
left join public.mc_adjudications j on j.case_id = c.case_id
where c.record_category <> 'TRAINING_EXAMPLE' and private.is_investigator() and private.mc_phase() = 'LOCKED';
revoke all on public.v_mc_export from anon, authenticated;
grant select on public.v_mc_export to authenticated;

commit;
