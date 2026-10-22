-- =============================================================================
-- migrations/0016_mapping_confirmation.sql
-- Mapping-confirmation review (investigator decisions of 2026-10-22, docs/REVIEW_WORKFLOW_DECISIONS.md).
--
-- The unit is one trial-to-condition mapping. Two independent reviewers see the trial title, the
-- available registry/AACT brief summary and the EXISTING assignment under review, and answer YES or
-- NO (or INSUFFICIENT_INFORMATION, which is recorded as a proposed rubric addition, never as an
-- approval) with an annotation. Reviewers never see each other's answers; a separate ADJUDICATOR
-- resolves disagreements after both independent final submissions, after the investigator closes
-- the campaign and authorizes adjudication. This is a mapping confirmation, not a blinded clinical
-- reference assessment: every response records the review mode, the displayed assignment and its
-- hash, the evidence hash, the rubric version and the build, and the export carries no sampling
-- probability, weight or accuracy statistic.
--
-- Additive: no object of schema.sql or migrations 0002 to 0015 is altered or replaced. New tables
-- carry the prefix mc_, new functions rpc_mc_* and private.mc_*. Every mc_ table is append-only
-- and audited; responses and adjudications are audited as identifiers and a hash only.
-- Record categories: SYNTHETIC_PILOT (MC-SYN-), TRAINING_EXAMPLE (MC-TRN-, never exported),
-- EVALUATION (MC-EVAL-, the future 100 mappings; the public application imports synthetic
-- records only). The ten-condition list is a PROPOSED condition set; its approval is pending.
-- =============================================================================
begin;

insert into public.app_schema_version (version, description)
values ('6.0.0-mapping-confirmation', 'mapping-confirmation review: trial-to-condition mapping units with visible assignment, yes/no responses, independent adjudication, typed export');

-- -----------------------------------------------------------------------------
-- 1. Code lists
-- -----------------------------------------------------------------------------
create function private.mc_condition_ok(p_code text) returns boolean
language sql immutable set search_path = '' as $$
  -- The ten condition rows of the PPR figure data (analysis primary v5, PROPOSED condition set
  -- CONDSET-FIG2-v5.1-PROPOSED). PAIN has no compatible benchmark and is shown as female share only;
  -- whether it enters the 100 mappings is an open investigator decision recorded in the docs.
  select p_code in ('CAN_ALL', 'DIAB', 'DEP', 'OBE', 'AST', 'COPD', 'COV', 'SCZ', 'HTN', 'PAIN')
$$;
create function private.mc_category_prefix_ok(p_category text, p_case_id text) returns boolean
language sql immutable set search_path = '' as $$
  select case p_category
    when 'SYNTHETIC_PILOT' then p_case_id like 'MC-SYN-%'
    when 'TRAINING_EXAMPLE' then p_case_id like 'MC-TRN-%'
    when 'EVALUATION' then p_case_id like 'MC-EVAL-%'
    else false end
$$;

-- -----------------------------------------------------------------------------
-- 2. Tables
-- -----------------------------------------------------------------------------
-- One campaign state row; phases: OPEN (import, assign, submit) -> CLOSED (no submissions)
-- -> ADJUDICATION (adjudicator reads both finals of complete cases) -> LOCKED (export).
create table public.mc_campaign (
  singleton              boolean primary key default true check (singleton),
  review_mode            text not null default 'MAPPING_CONFIRMATION' check (review_mode = 'MAPPING_CONFIRMATION'),
  assignment_visibility  text not null default 'EXISTING_ASSIGNMENT_VISIBLE' check (assignment_visibility = 'EXISTING_ASSIGNMENT_VISIBLE'),
  condition_set_id       text not null check (length(condition_set_id) between 3 and 80),
  condition_set_status   text not null check (condition_set_status in ('PROPOSED', 'APPROVED')),
  rubric_version         text not null check (length(rubric_version) between 3 and 80),
  rubric_sha256          text not null check (rubric_sha256 ~ '^[0-9a-f]{64}$'),
  phase                  text not null default 'OPEN' check (phase in ('OPEN', 'CLOSED', 'ADJUDICATION', 'LOCKED')),
  created_at             timestamptz not null default now(),
  created_by             uuid not null references public.users (user_id)
);

create table public.mc_campaign_events (
  event_id     uuid primary key default gen_random_uuid(),
  event_seq    bigint generated always as identity unique,
  event_type   text not null check (event_type in ('CLOSED', 'ADJUDICATION_AUTHORIZED', 'LOCKED')),
  attestation  text not null check (length(attestation) >= 20),
  app_git_sha  text not null,
  occurred_at  timestamptz not null default now(),
  actor        uuid not null references public.users (user_id)
);

-- A mapping unit: the trial, the condition row and the existing assignment under review, plus the
-- reviewer-visible evidence assembled from source fields (never generated).
create table public.mc_cases (
  case_id              text primary key check (case_id ~ '^MC-(SYN|TRN|EVAL)-[A-Z0-9][A-Z0-9-]{1,40}$'),
  record_category      text not null check (record_category in ('SYNTHETIC_PILOT', 'TRAINING_EXAMPLE', 'EVALUATION')),
  trial_ref            text not null check (trial_ref ~ '^(NCT[0-9]{8}|SYN-NCT-[0-9]{4,8})$'),
  condition_code       text not null check (private.mc_condition_ok(condition_code)),
  condition_label      text not null check (length(condition_label) between 2 and 120),
  condition_set_id     text not null check (length(condition_set_id) between 3 and 80),
  assignment           jsonb not null check (jsonb_typeof(assignment) = 'object'),
  assignment_sha256    text not null check (assignment_sha256 ~ '^[0-9a-f]{64}$'),
  evidence             jsonb not null check (jsonb_typeof(evidence) = 'object'),
  evidence_sha256      text not null check (evidence_sha256 ~ '^[0-9a-f]{64}$'),
  evidence_version     integer not null default 1 check (evidence_version >= 1),
  created_at           timestamptz not null default now(),
  created_by           uuid not null references public.users (user_id),
  check (private.mc_category_prefix_ok(record_category, case_id)),
  check (record_category <> 'SYNTHETIC_PILOT' or trial_ref like 'SYN-NCT-%'),
  unique (trial_ref, condition_code)
);

create table public.mc_assignments (
  assignment_id       uuid primary key default gen_random_uuid(),
  case_id             text not null references public.mc_cases (case_id),
  reviewer_pseudo_id  text not null references public.reviewers (reviewer_pseudo_id),
  reviewer_slot       smallint not null check (reviewer_slot in (1, 2)),
  queue_position      integer not null check (queue_position >= 1),
  randomization_seed  bigint not null,
  assigned_at         timestamptz not null default now(),
  assigned_by         uuid not null references public.users (user_id),
  unique (case_id, reviewer_pseudo_id),
  unique (case_id, reviewer_slot),
  unique (reviewer_pseudo_id, queue_position),
  unique (assignment_id, case_id, reviewer_pseudo_id)
);

-- One final response per assignment: immutable, with the provenance needed to interpret it.
create table public.mc_responses (
  response_id                 uuid primary key default gen_random_uuid(),
  assignment_id               uuid not null unique,
  case_id                     text not null,
  reviewer_pseudo_id          text not null,
  answer                      text not null check (answer in ('YES', 'NO', 'INSUFFICIENT_INFORMATION')),
  annotation                  text check (annotation is null or length(annotation) between 1 and 4000),
  rubric_addition_proposed    boolean not null,
  review_mode                 text not null check (review_mode = 'MAPPING_CONFIRMATION'),
  assignment_visibility       text not null check (assignment_visibility = 'EXISTING_ASSIGNMENT_VISIBLE'),
  displayed_assignment_sha256 text not null check (displayed_assignment_sha256 ~ '^[0-9a-f]{64}$'),
  displayed_evidence_sha256   text not null check (displayed_evidence_sha256 ~ '^[0-9a-f]{64}$'),
  displayed_evidence_version  integer not null check (displayed_evidence_version >= 1),
  rubric_version              text not null,
  rubric_sha256               text not null check (rubric_sha256 ~ '^[0-9a-f]{64}$'),
  app_git_sha                 text not null,
  seconds_on_case             integer check (seconds_on_case is null or seconds_on_case >= 0),
  content_sha256              text not null check (content_sha256 ~ '^[0-9a-f]{64}$'),
  submitted_at                timestamptz not null default now(),
  foreign key (assignment_id, case_id, reviewer_pseudo_id)
    references public.mc_assignments (assignment_id, case_id, reviewer_pseudo_id),
  check (answer = 'YES' or (annotation is not null and length(trim(annotation)) > 0)),
  check (rubric_addition_proposed = (answer = 'INSUFFICIENT_INFORMATION'))
);
create index mc_responses_case_idx on public.mc_responses (case_id);

-- One adjudication per case, by the independent ADJUDICATOR only, after both finals.
create table public.mc_adjudications (
  adjudication_id  uuid primary key default gen_random_uuid(),
  case_id          text not null unique references public.mc_cases (case_id),
  decision         text check (decision is null or decision in ('YES', 'NO')),
  status           text not null check (status in ('DISCORDANT_RESOLVED', 'UNRESOLVED_ESCALATED', 'RUBRIC_ADDITION_REVIEWED')),
  basis            text not null check (basis in ('REVIEWER_1', 'REVIEWER_2', 'NEITHER', 'NONE')),
  rationale        text not null check (length(rationale) between 3 and 4000),
  adjudicator_role text,
  decided_by       uuid not null references public.users (user_id),
  decided_at       timestamptz not null default now(),
  check ((status = 'UNRESOLVED_ESCALATED') = (decision is null)),
  check ((status = 'UNRESOLVED_ESCALATED') = (basis = 'NONE'))
);

create table public.mc_exports (
  export_id        uuid primary key default gen_random_uuid(),
  format_version   text not null check (format_version = 'mapping-confirmation-1.0'),
  row_counts       jsonb not null check (jsonb_typeof(row_counts) = 'object'),
  file_sha256      jsonb not null check (jsonb_typeof(file_sha256) = 'object'),
  manifest_sha256  text not null check (manifest_sha256 ~ '^[0-9a-f]{64}$'),
  app_git_sha      text not null,
  created_by       uuid not null references public.users (user_id),
  created_at       timestamptz not null default now(),
  notes            text
);

-- -----------------------------------------------------------------------------
-- 3. Helpers
-- -----------------------------------------------------------------------------
create function private.mc_phase() returns text
language sql stable security definer set search_path = '' as $$
  select coalesce((select c.phase from public.mc_campaign c), 'OPEN')
$$;
create function private.mc_is_assigned(p_case_id text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.mc_assignments a
                 where a.case_id = p_case_id and a.reviewer_pseudo_id = private.my_reviewer_pseudo_id())
$$;
-- Both independent finals exist for the case.
create function private.mc_case_complete(p_case_id text) returns boolean
language sql stable security definer set search_path = '' as $$
  select (select count(distinct a.reviewer_slot) from public.mc_assignments a
          join public.mc_responses r on r.assignment_id = a.assignment_id where a.case_id = p_case_id) = 2
$$;
-- The adjudicator reads a case and its responses only after both finals and the authorization.
create function private.mc_adjudicator_can_read(p_case_id text) returns boolean
language sql stable security definer set search_path = '' as $$
  select private.is_adjudicator() and private.mc_phase() in ('ADJUDICATION', 'LOCKED')
         and private.mc_case_complete(p_case_id)
$$;
-- The investigator reads responses only once the campaign is closed (counts only while open).
create function private.mc_investigator_can_read_responses() returns boolean
language sql stable security definer set search_path = '' as $$
  select private.is_investigator() and private.mc_phase() <> 'OPEN'
$$;

-- Reviewer-visible evidence: assembled from source fields; allow-listed keys only; a missing
-- summary is marked explicitly; no key may carry a prediction, model reasoning or another
-- reviewer's work; no registry address; the optional detailed description needs provenance.
create function private.assert_mc_evidence(p jsonb) returns void
language plpgsql immutable set search_path = '' as $$
declare
  bad text;
  s jsonb;
begin
  select k into bad from jsonb_object_keys(p) k
  where k not in ('schema_version', 'brief_title', 'brief_summary', 'detailed_description', 'source') limit 1;
  if bad is not null then
    raise exception 'mapping evidence key "%" is not on the reviewer-visible allow list', bad using errcode = '22023';
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
    if coalesce(jsonb_typeof(s -> 'present'), '') <> 'boolean' or coalesce(jsonb_typeof(s -> 'source_field'), '') <> 'string' then
      raise exception 'detailed_description needs present and source_field provenance' using errcode = '22023';
    end if;
  end if;
  s := p -> 'source';
  if coalesce(jsonb_typeof(s), '') <> 'object' or coalesce(jsonb_typeof(s -> 'system'), '') <> 'string'
     or coalesce(jsonb_typeof(s -> 'version'), '') <> 'string' or coalesce(jsonb_typeof(s -> 'fields'), '') <> 'array' then
    raise exception 'mapping evidence source needs system, version and fields' using errcode = '22023';
  end if;
  select k into bad from private.jsonb_all_keys(p) k
  where k ~* '(^ai_|_ai_|stage_?[abcd]($|_)|llm|model|prompt|predict|reason|rationale|confidence|label|tier|curated|stratum|strata|weight|probab|sampling|reviewer|adjudicat|decision|expected|enrol|(^|_)sex($|_)|gender|female|(^|_)male($|_)|participant|count|result|url|link)'
  limit 1;
  if bad is not null then
    raise exception 'mapping evidence key "%" could carry a prediction, reasoning or outcome field and is not allowed', bad using errcode = '22023';
  end if;
  if p::text ~* 'clinicaltrials\.gov|https?://' then
    raise exception 'mapping evidence carries no registry link or address' using errcode = '22023';
  end if;
end $$;

-- The displayed assignment: what is under review, with its source and version; no prediction detail.
create function private.assert_mc_assignment(p jsonb) returns void
language plpgsql immutable set search_path = '' as $$
declare
  bad text;
begin
  select k into bad from jsonb_object_keys(p) k
  where k not in ('assigned', 'assignment_source', 'assignment_version') limit 1;
  if bad is not null then
    raise exception 'assignment key "%" is not on the allow list', bad using errcode = '22023';
  end if;
  if coalesce(jsonb_typeof(p -> 'assigned'), '') <> 'boolean' or coalesce(jsonb_typeof(p -> 'assignment_source'), '') <> 'string'
     or coalesce(jsonb_typeof(p -> 'assignment_version'), '') <> 'string' then
    raise exception 'assignment needs assigned, assignment_source and assignment_version' using errcode = '22023';
  end if;
end $$;

-- -----------------------------------------------------------------------------
-- 4. Triggers
-- -----------------------------------------------------------------------------
create function private.mc_cases_before_insert() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if private.mc_phase() <> 'OPEN' then
    raise exception 'mapping cases are imported only while the campaign is open';
  end if;
  perform private.assert_mc_assignment(new.assignment);
  perform private.assert_mc_evidence(new.evidence);
  new.assignment_sha256 := private.sha256_hex(new.assignment::text);
  new.evidence_sha256 := private.sha256_hex(new.evidence::text);
  if not exists (select 1 from public.mc_campaign) then
    raise exception 'create the mapping-confirmation campaign (rpc_mc_create_campaign) before importing cases';
  end if;
  return new;
end $$;

create function private.mc_assignments_before_insert() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  rv record;
  cat text;
  other smallint;
begin
  if private.mc_phase() <> 'OPEN' then
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

create function private.mc_responses_before_insert() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  c record;
  camp record;
begin
  if private.mc_phase() <> 'OPEN' then
    raise exception 'the campaign is closed; mapping responses are final';
  end if;
  if exists (select 1 from public.mc_responses r where r.assignment_id = new.assignment_id) then
    raise exception 'the final mapping response is locked; an authorized amendment workflow is required';
  end if;
  select * into c from public.mc_cases where case_id = new.case_id;
  select * into camp from public.mc_campaign;
  -- The response records exactly what was displayed; a stale or foreign hash is refused.
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

create function private.mc_adjudications_before_insert() returns trigger
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
  if (a1 = 'INSUFFICIENT_INFORMATION' or a2 = 'INSUFFICIENT_INFORMATION') and new.status = 'DISCORDANT_RESOLVED' and a1 = a2 then
    raise exception 'both reviewers proposed a rubric addition; status RUBRIC_ADDITION_REVIEWED or UNRESOLVED_ESCALATED applies';
  end if;
  new.adjudicator_role := r_role;
  new.decided_at := now();
  return new;
end $$;

create function private.mc_campaign_events_before_insert() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  ph text := private.mc_phase();
  n_open integer;
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
    select count(*) into n_open from public.mc_cases c
    where c.record_category <> 'TRAINING_EXAMPLE' and private.mc_case_complete(c.case_id)
      and (select count(distinct r.answer) from public.mc_assignments a join public.mc_responses r on r.assignment_id = a.assignment_id
           where a.case_id = c.case_id) > 1
      and not exists (select 1 from public.mc_adjudications j where j.case_id = c.case_id);
    if n_open > 0 then
      raise exception '% disagreeing mappings have no adjudication; the campaign cannot be locked', n_open;
    end if;
    update public.mc_campaign set phase = 'LOCKED' where singleton;
  end if;
  new.occurred_at := now();
  return new;
end $$;

create trigger mc_cases_before_insert before insert on public.mc_cases
  for each row execute function private.mc_cases_before_insert();
create trigger mc_assignments_before_insert before insert on public.mc_assignments
  for each row execute function private.mc_assignments_before_insert();
create trigger mc_responses_before_insert before insert on public.mc_responses
  for each row execute function private.mc_responses_before_insert();
create trigger mc_adjudications_before_insert before insert on public.mc_adjudications
  for each row execute function private.mc_adjudications_before_insert();
create trigger mc_campaign_events_before_insert before insert on public.mc_campaign_events
  for each row execute function private.mc_campaign_events_before_insert();

-- Audit: responses and adjudications as identifiers and a hash; every other row in full.
create function private.audit_row_mc() returns trigger
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
  else
    details := rec;
  end if;
  insert into public.audit_log (actor_user_id, actor_role, action, entity_table, entity_id, mode, details)
  values (private.app_user_id(), coalesce(private.app_role(), current_user), tg_op, tg_table_name, pk, null, details);
  return null;
end $$;

do $$
declare
  t text;
begin
  foreach t in array array['mc_campaign_events', 'mc_cases', 'mc_assignments', 'mc_responses', 'mc_adjudications', 'mc_exports']
  loop
    execute format('create trigger %I before update or delete on public.%I for each row execute function private.reject_mutation()', t || '_append_only', t);
    execute format('create trigger %I before truncate on public.%I for each statement execute function private.reject_mutation()', t || '_no_truncate', t);
    execute format('create trigger %I after insert on public.%I for each row execute function private.audit_row_mc()', t || '_audit', t);
  end loop;
  -- The campaign row changes only through the phase events trigger (phase column), never by callers.
  execute 'create trigger mc_campaign_no_delete before delete on public.mc_campaign for each row execute function private.reject_mutation()';
  execute 'create trigger mc_campaign_no_truncate before truncate on public.mc_campaign for each statement execute function private.reject_mutation()';
  execute 'create trigger mc_campaign_audit after insert or update on public.mc_campaign for each row execute function private.audit_row_mc()';
end $$;

create function private.mc_campaign_update_check() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.review_mode <> old.review_mode or new.assignment_visibility <> old.assignment_visibility
     or new.condition_set_id <> old.condition_set_id or new.rubric_version <> old.rubric_version
     or new.rubric_sha256 <> old.rubric_sha256 or new.created_at <> old.created_at or new.created_by <> old.created_by
     or new.condition_set_status <> old.condition_set_status then
    raise exception 'the mapping-confirmation campaign is immutable except for its phase';
  end if;
  return new;
end $$;
create trigger mc_campaign_update_check before update on public.mc_campaign
  for each row execute function private.mc_campaign_update_check();

-- -----------------------------------------------------------------------------
-- 5. Row-level security
-- -----------------------------------------------------------------------------
alter table public.mc_campaign enable row level security;
alter table public.mc_campaign_events enable row level security;
alter table public.mc_cases enable row level security;
alter table public.mc_assignments enable row level security;
alter table public.mc_responses enable row level security;
alter table public.mc_adjudications enable row level security;
alter table public.mc_exports enable row level security;

create policy mc_campaign_read on public.mc_campaign for select to authenticated using (private.app_role() is not null);
create policy mc_campaign_events_read on public.mc_campaign_events for select to authenticated
  using (private.is_investigator() or private.is_adjudicator());
create policy mc_cases_read on public.mc_cases for select to authenticated
  using (private.is_investigator() or private.mc_is_assigned(case_id) or private.mc_adjudicator_can_read(case_id)
         or (record_category = 'TRAINING_EXAMPLE' and (private.my_reviewer_pseudo_id() is not null or private.is_adjudicator())));
create policy mc_assignments_read on public.mc_assignments for select to authenticated
  using (private.is_investigator() or reviewer_pseudo_id = private.my_reviewer_pseudo_id()
         or private.mc_adjudicator_can_read(case_id));
create policy mc_responses_read on public.mc_responses for select to authenticated
  using (reviewer_pseudo_id = private.my_reviewer_pseudo_id() or private.mc_investigator_can_read_responses()
         or private.mc_adjudicator_can_read(case_id));
create policy mc_adjudications_read on public.mc_adjudications for select to authenticated
  using (private.is_investigator() or (private.is_adjudicator() and decided_by = private.app_user_id()));
create policy mc_exports_inv on public.mc_exports for select to authenticated using (private.is_investigator());

-- -----------------------------------------------------------------------------
-- 6. RPCs (the only write path)
-- -----------------------------------------------------------------------------
create function public.rpc_mc_create_campaign(p jsonb) returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := private.assert_investigator();
begin
  insert into public.mc_campaign (condition_set_id, condition_set_status, rubric_version, rubric_sha256, created_by)
  values (p ->> 'condition_set_id', p ->> 'condition_set_status', p ->> 'rubric_version', lower(p ->> 'rubric_sha256'), me);
  return true;
end $$;

-- p = {case_id, record_category, trial_ref, condition_code, condition_label, condition_set_id, assignment, evidence}
create function public.rpc_mc_import_case(p jsonb) returns text
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := private.assert_investigator();
begin
  insert into public.mc_cases (case_id, record_category, trial_ref, condition_code, condition_label, condition_set_id,
                               assignment, assignment_sha256, evidence, evidence_sha256, created_by)
  values (p ->> 'case_id', p ->> 'record_category', p ->> 'trial_ref', p ->> 'condition_code', p ->> 'condition_label',
          p ->> 'condition_set_id', p -> 'assignment', repeat('0', 64), p -> 'evidence', repeat('0', 64), me);
  return p ->> 'case_id';
end $$;

create function public.rpc_mc_assign(p_reviewer_pseudo_id text, p_slot integer, p_case_ids text[], p_seed bigint) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := private.assert_investigator();
  start_pos integer;
  n integer;
begin
  select coalesce(max(queue_position), 0) into start_pos from public.mc_assignments where reviewer_pseudo_id = p_reviewer_pseudo_id;
  insert into public.mc_assignments (case_id, reviewer_pseudo_id, reviewer_slot, queue_position, randomization_seed, assigned_by)
  select x.c, p_reviewer_pseudo_id, p_slot::smallint,
         start_pos + row_number() over (order by md5(p_seed::text || ':' || p_reviewer_pseudo_id || ':' || x.c)), p_seed, me
  from unnest(p_case_ids) as x(c);
  get diagnostics n = row_count;
  return n;
end $$;

-- p = {answer, annotation, displayed_assignment_sha256, displayed_evidence_sha256, displayed_evidence_version,
--      rubric_version, rubric_sha256, app_git_sha, seconds_on_case}
create function public.rpc_mc_submit(p_assignment_id uuid, p jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  me text := private.my_reviewer_pseudo_id();
  a record;
  rid uuid;
begin
  select * into a from public.mc_assignments where assignment_id = p_assignment_id;
  if me is null or a.reviewer_pseudo_id is distinct from me then
    raise exception 'not your mapping assignment' using errcode = '42501';
  end if;
  insert into public.mc_responses (assignment_id, case_id, reviewer_pseudo_id, answer, annotation, rubric_addition_proposed,
    review_mode, assignment_visibility, displayed_assignment_sha256, displayed_evidence_sha256, displayed_evidence_version,
    rubric_version, rubric_sha256, app_git_sha, seconds_on_case, content_sha256)
  values (p_assignment_id, a.case_id, me, p ->> 'answer', nullif(trim(coalesce(p ->> 'annotation', '')), ''),
    (p ->> 'answer') = 'INSUFFICIENT_INFORMATION', 'MAPPING_CONFIRMATION', 'EXISTING_ASSIGNMENT_VISIBLE',
    lower(p ->> 'displayed_assignment_sha256'), lower(p ->> 'displayed_evidence_sha256'), (p ->> 'displayed_evidence_version')::integer,
    p ->> 'rubric_version', lower(p ->> 'rubric_sha256'), p ->> 'app_git_sha', (p ->> 'seconds_on_case')::integer,
    private.sha256_hex(concat_ws('|', a.case_id, me, p ->> 'answer', coalesce(p ->> 'annotation', ''),
                                 lower(p ->> 'displayed_assignment_sha256'), lower(p ->> 'displayed_evidence_sha256'))))
  returning response_id into rid;
  return rid;
end $$;

create function public.rpc_mc_phase(p_event_type text, p_attestation text, p_app_git_sha text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := private.assert_investigator();
  eid uuid;
begin
  insert into public.mc_campaign_events (event_type, attestation, app_git_sha, actor)
  values (p_event_type, p_attestation, p_app_git_sha, me) returning event_id into eid;
  return eid;
end $$;

-- p = {case_id, decision, status, basis, rationale}
create function public.rpc_mc_adjudicate(p jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := private.app_user_id();
  jid uuid;
begin
  if not private.is_adjudicator() then
    raise exception 'ADJUDICATOR role is needed to adjudicate' using errcode = '42501';
  end if;
  insert into public.mc_adjudications (case_id, decision, status, basis, rationale, decided_by)
  values (p ->> 'case_id', p ->> 'decision', p ->> 'status', p ->> 'basis', p ->> 'rationale', me)
  returning adjudication_id into jid;
  return jid;
end $$;

-- Counts only; no answer content.
create function public.rpc_mc_completion_summary()
returns table (reviewer_pseudo_id text, reviewer_slot smallint, n_assigned bigint, n_submitted bigint)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.assert_investigator();
  return query
  select a.reviewer_pseudo_id, min(a.reviewer_slot), count(*),
         count(*) filter (where exists (select 1 from public.mc_responses r where r.assignment_id = a.assignment_id))
  from public.mc_assignments a group by a.reviewer_pseudo_id order by 2;
end $$;

create function public.rpc_mc_register_export(p jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := private.assert_investigator();
  eid uuid;
begin
  if private.mc_phase() <> 'LOCKED' then
    raise exception 'a mapping-confirmation export is registered only after the lock';
  end if;
  insert into public.mc_exports (format_version, row_counts, file_sha256, manifest_sha256, app_git_sha, created_by, notes)
  values (p ->> 'format_version', coalesce(p -> 'row_counts', '{}'::jsonb), coalesce(p -> 'file_sha256', '{}'::jsonb),
          lower(p ->> 'manifest_sha256'), p ->> 'app_git_sha', me, p ->> 'notes')
  returning export_id into eid;
  return eid;
end $$;

-- -----------------------------------------------------------------------------
-- 7. Views (security_invoker: the caller's RLS applies)
-- -----------------------------------------------------------------------------
create view public.v_mc_my_queue with (security_invoker = true) as
select a.assignment_id, a.case_id, a.queue_position, c.record_category, c.condition_code, c.condition_label,
       c.evidence ->> 'brief_title' as brief_title,
       exists (select 1 from public.mc_responses r where r.assignment_id = a.assignment_id) as submitted
from public.mc_assignments a join public.mc_cases c on c.case_id = a.case_id
where a.reviewer_pseudo_id = private.my_reviewer_pseudo_id();

-- Adjudicator queue: complete cases only, both answers side by side; disagreement or a proposed
-- rubric addition needs the adjudicator.
create view public.v_mc_adjudication_queue with (security_invoker = true) as
select c.case_id, c.record_category, c.condition_code, c.condition_label, c.evidence ->> 'brief_title' as brief_title,
       (select r.answer from public.mc_assignments a join public.mc_responses r on r.assignment_id = a.assignment_id
        where a.case_id = c.case_id and a.reviewer_slot = 1) as reviewer_1_answer,
       (select r.answer from public.mc_assignments a join public.mc_responses r on r.assignment_id = a.assignment_id
        where a.case_id = c.case_id and a.reviewer_slot = 2) as reviewer_2_answer,
       (select count(distinct r.answer) from public.mc_assignments a join public.mc_responses r on r.assignment_id = a.assignment_id
        where a.case_id = c.case_id) > 1
       or exists (select 1 from public.mc_assignments a join public.mc_responses r on r.assignment_id = a.assignment_id
                  where a.case_id = c.case_id and r.answer = 'INSUFFICIENT_INFORMATION') as needs_adjudication,
       exists (select 1 from public.mc_adjudications j where j.case_id = c.case_id) as adjudicated
from public.mc_cases c
where private.mc_adjudicator_can_read(c.case_id) or (private.is_investigator() and private.mc_phase() <> 'OPEN');

-- Export (investigator, after the lock): one row per mapping and reviewer slot; training rows never.
create view public.v_mc_export with (security_invoker = true) as
select c.record_category, c.case_id, c.trial_ref, c.condition_code, c.condition_label, c.condition_set_id,
       c.assignment ->> 'assignment_source' as assignment_source, c.assignment ->> 'assignment_version' as assignment_version,
       c.assignment_sha256, c.evidence_sha256, c.evidence_version,
       (c.evidence -> 'brief_summary' ->> 'present')::boolean as brief_summary_present,
       c.evidence ? 'detailed_description' as detailed_description_included,
       a.reviewer_slot, a.reviewer_pseudo_id, r.answer, r.annotation, r.rubric_addition_proposed, r.review_mode,
       r.assignment_visibility, r.displayed_assignment_sha256, r.displayed_evidence_sha256, r.rubric_version, r.rubric_sha256,
       r.app_git_sha as response_app_git_sha, r.submitted_at,
       j.adjudication_id, j.decision as adjudicated_decision, j.status as adjudication_status, j.basis as adjudication_basis,
       j.adjudicator_role, j.decided_at as adjudicated_at
from public.mc_cases c
join public.mc_assignments a on a.case_id = c.case_id
left join public.mc_responses r on r.assignment_id = a.assignment_id
left join public.mc_adjudications j on j.case_id = c.case_id
where c.record_category <> 'TRAINING_EXAMPLE' and private.is_investigator() and private.mc_phase() = 'LOCKED';

-- -----------------------------------------------------------------------------
-- 8. Grants
-- -----------------------------------------------------------------------------
revoke all on public.mc_campaign, public.mc_campaign_events, public.mc_cases, public.mc_assignments, public.mc_responses,
              public.mc_adjudications, public.mc_exports, public.v_mc_my_queue, public.v_mc_adjudication_queue, public.v_mc_export
  from anon, authenticated;
grant select on public.mc_campaign, public.mc_campaign_events, public.mc_cases, public.mc_assignments, public.mc_responses,
                public.mc_adjudications, public.mc_exports, public.v_mc_my_queue, public.v_mc_adjudication_queue, public.v_mc_export
  to authenticated;
revoke all on function private.mc_condition_ok(text), private.mc_category_prefix_ok(text, text), private.mc_phase(),
                       private.mc_is_assigned(text), private.mc_case_complete(text), private.mc_adjudicator_can_read(text),
                       private.mc_investigator_can_read_responses(), private.assert_mc_evidence(jsonb), private.assert_mc_assignment(jsonb),
                       private.mc_cases_before_insert(), private.mc_assignments_before_insert(), private.mc_responses_before_insert(),
                       private.mc_adjudications_before_insert(), private.mc_campaign_events_before_insert(), private.audit_row_mc(),
                       private.mc_campaign_update_check()
  from public, anon, authenticated;
grant execute on function private.mc_phase(), private.mc_is_assigned(text), private.mc_adjudicator_can_read(text),
                          private.mc_investigator_can_read_responses()
  to authenticated;
revoke all on function public.rpc_mc_create_campaign(jsonb), public.rpc_mc_import_case(jsonb),
                       public.rpc_mc_assign(text, integer, text[], bigint), public.rpc_mc_submit(uuid, jsonb),
                       public.rpc_mc_phase(text, text, text), public.rpc_mc_adjudicate(jsonb), public.rpc_mc_completion_summary(),
                       public.rpc_mc_register_export(jsonb)
  from public, anon;
grant execute on function public.rpc_mc_create_campaign(jsonb), public.rpc_mc_import_case(jsonb),
                          public.rpc_mc_assign(text, integer, text[], bigint), public.rpc_mc_submit(uuid, jsonb),
                          public.rpc_mc_phase(text, text, text), public.rpc_mc_adjudicate(jsonb), public.rpc_mc_completion_summary(),
                          public.rpc_mc_register_export(jsonb)
  to authenticated;

commit;
