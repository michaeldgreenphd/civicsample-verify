-- =============================================================================
-- migrations/0002_v3_review_design.sql
-- Clinical review schema v3: applies ON TOP OF the unchanged v2 schema.sql.
--
-- Status: PRE-BUILD. Tested on PGlite only (tests_prebuild/pglite_rls_v3/,
-- SCHEMA_TEST_REPORT_v3.md). Live PostgreSQL 16 and Supabase tests are REQUIRED
-- before any formal reviewer is invited (CLAUDE_CODE_MASTER_PROMPT_v3.md).
--
-- What v3 adds (design: classification_validation/review_design_v3/):
--   1. ADJUDICATOR role: a third clinician who adjudicates FORMAL cases blind to
--      original, curated and AI labels. Reads FORMAL cases, packets, reviews and
--      step-1 records only after the formal phase closes; never case_design,
--      case_design_v3, ai_classifications, sampling_strata, exports or audit_log.
--   2. Adjudication provenance set by the database, never by the caller:
--      adjudicator_role, adjudicator_exposed_to_index_labels (TRUE for every
--      investigator adjudication), post_unblinding (TRUE after REFERENCE_LOCKED),
--      adjudication_blinded (generated). Determination levels and disagreement
--      reason codes. Conflict rule: nobody adjudicates a case they were assigned.
--   3. Investigator-only v3 design record per case (case_design_v3): review
--      module, analysis set, strata, index labels, two-step flag;
--      tuning_use_allowed is always FALSE.
--   4. Frozen sample manifests: a FORMAL case can be assigned only if it is in a
--      frozen manifest; no case may be added to a module after its freeze.
--   5. Two-step trial cases: Step 1 (descriptor level, no trial information) is a
--      separate append-only record; the trial-context packet is readable by the
--      reviewer only after their Step 1 exists; a Step 2 review is refused
--      without Step 1.
--   6. Reference lock per review module: refused until the formal phase is
--      closed and every double-reviewed case and level has an adjudication.
--      v_analysis_export_v3 returns rows only after the lock.
--   7. Helper hardening (v2 findings FINDING-01 and FINDING-02):
--      private.case_is_locked() and private.latest_case_version_id() return NULL
--      to a signed-in caller who is not the investigator, the adjudicator or
--      assigned to the case.
-- Not in this migration (Claude Code builds and tests them; see the master
-- prompt): Module B unit types, forms and export (CONDITION_ROW_BENCHMARK,
-- TRIAL_ELIGIBILITY); the analysis export writer.
--
-- Apply after schema.sql, in one transaction:
--   psql -v ON_ERROR_STOP=1 -f schema.sql
--   psql -v ON_ERROR_STOP=1 -f migrations/0002_v3_review_design.sql
-- =============================================================================
begin;

insert into public.app_schema_version (version, description)
values ('3.0.0', 'review design v3: ADJUDICATOR role, blinded adjudication provenance, v3 case design, frozen sample manifests, two-step trial cases, reference lock, v3 export view');

-- -----------------------------------------------------------------------------
-- 1. Roles
-- -----------------------------------------------------------------------------
alter table public.users drop constraint users_role_check;
alter table public.users add constraint users_role_check check (role in ('INVESTIGATOR', 'REVIEWER', 'ADJUDICATOR'));
alter table public.users add constraint users_adjudicator_not_pilot check (not (role = 'ADJUDICATOR' and is_pilot_test_account));

create function private.is_adjudicator() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select u.role = 'ADJUDICATOR' from public.users u
                   where u.auth_uid = auth.uid() and u.is_active), false)
$$;

-- -----------------------------------------------------------------------------
-- 2. v3 design record (investigator only, append-only)
-- -----------------------------------------------------------------------------
create table public.case_design_v3 (
  case_id                    text primary key,
  mode                       text not null,
  is_pilot                   boolean generated always as (mode = 'PILOT') stored,
  review_module              text not null default 'ONTOLOGY_AREA' check (review_module in ('ONTOLOGY_AREA', 'BENCHMARK_COMPATIBILITY')),
  analysis_set               text not null check (analysis_set in ('VALIDATION_HELDOUT', 'DEVELOPMENT_KNOWN_ISSUE', 'PILOT_SYNTHETIC')),
  development_basis          text,
  selection_stratum          text not null,
  variance_stratum           text not null,
  variance_stratum_size      integer not null check (variance_stratum_size >= 1),
  selection_probability      numeric not null check (selection_probability > 0 and selection_probability <= 1),
  sampling_weight            numeric generated always as (1 / selection_probability) stored,
  comparison_cell_v11        text,
  original_binary            text check (original_binary in ('INCLUDE', 'EXCLUDE')),
  curated_v11_status_raw     text check (curated_v11_status_raw in ('INCLUDE', 'EXCLUDE', 'CONTEXT_DEPENDENT', 'INSUFFICIENT_EVIDENCE', 'NOT_IN_DECISION_FILE')),
  curated_v11_binary         text check (curated_v11_binary in ('INCLUDE', 'EXCLUDE')),
  two_step_required          boolean not null default false,
  tuning_use_allowed         boolean not null default false check (tuning_use_allowed = false),
  sampling_design_version    text not null,
  design_row_sha256          text not null check (design_row_sha256 ~ '^[0-9a-f]{64}$'),
  imported_at                timestamptz not null default now(),
  imported_by                uuid not null references public.users (user_id),
  foreign key (case_id, mode) references public.cases (case_id, mode),
  check ((mode = 'PILOT') = (analysis_set = 'PILOT_SYNTHETIC'))
);

-- -----------------------------------------------------------------------------
-- 3. Frozen sample manifests (investigator only, append-only)
-- -----------------------------------------------------------------------------
create table public.sample_manifests (
  manifest_id                uuid primary key default gen_random_uuid(),
  review_module              text not null unique check (review_module in ('ONTOLOGY_AREA', 'BENCHMARK_COMPATIBILITY')),
  sampling_design_version    text not null,
  manifest_file_sha256       text not null check (manifest_file_sha256 ~ '^[0-9a-f]{64}$'),
  decision_file_v11_sha256   text check (decision_file_v11_sha256 is null or decision_file_v11_sha256 ~ '^[0-9a-f]{64}$'),
  sampling_seed              bigint,
  n_cases                    integer not null check (n_cases >= 1),
  case_list_sha256           text not null check (case_list_sha256 ~ '^[0-9a-f]{64}$'),
  attestation                text not null check (length(attestation) >= 20),
  frozen_at                  timestamptz not null default now(),
  frozen_by                  uuid not null references public.users (user_id)
);
create table public.sample_manifest_cases (
  manifest_id                uuid not null references public.sample_manifests (manifest_id),
  case_id                    text not null,
  mode                       text not null check (mode = 'FORMAL'),
  design_row_sha256          text not null,
  primary key (manifest_id, case_id),
  foreign key (case_id, mode) references public.cases (case_id, mode)
);

-- -----------------------------------------------------------------------------
-- 4. Two-step trial cases
-- -----------------------------------------------------------------------------
create table public.trial_step1_records (
  step1_id            uuid primary key default gen_random_uuid(),
  assignment_id       uuid not null unique,
  case_id             text not null,
  case_version_id     uuid not null,
  mode                text not null,
  is_pilot            boolean generated always as (mode = 'PILOT') stored,
  reviewer_pseudo_id  text not null,
  step1_decision      text not null check (step1_decision in ('INCLUDE', 'EXCLUDE', 'CONTEXT_DEPENDENT', 'INSUFFICIENT_INFORMATION')),
  step1_rationale     text check (step1_rationale is null or length(step1_rationale) <= 4000),
  step1_uncertain     boolean not null,
  content_sha256      text not null check (content_sha256 ~ '^[0-9a-f]{64}$'),
  recorded_at         timestamptz not null default now(),
  foreign key (assignment_id, case_id, mode, reviewer_pseudo_id)
    references public.assignments (assignment_id, case_id, mode, reviewer_pseudo_id),
  foreign key (case_version_id, case_id, mode) references public.case_versions (case_version_id, case_id, mode)
);
create table public.trial_context_packets (
  case_id         text primary key,
  mode            text not null,
  is_pilot        boolean generated always as (mode = 'PILOT') stored,
  packet          jsonb not null check (jsonb_typeof(packet) = 'object'),
  packet_sha256   text not null check (packet_sha256 ~ '^[0-9a-f]{64}$'),
  created_at      timestamptz not null default now(),
  created_by      uuid not null references public.users (user_id),
  foreign key (case_id, mode) references public.cases (case_id, mode)
);

-- -----------------------------------------------------------------------------
-- 5. Reference lock (append-only)
-- -----------------------------------------------------------------------------
create table public.reference_locks (
  lock_id                uuid primary key default gen_random_uuid(),
  review_module          text not null unique check (review_module in ('ONTOLOGY_AREA', 'BENCHMARK_COMPATIBILITY')),
  n_case_levels_locked   integer not null check (n_case_levels_locked >= 0),
  attestation            text not null check (length(attestation) >= 20),
  locked_at              timestamptz not null default now(),
  locked_by              uuid not null references public.users (user_id)
);

-- -----------------------------------------------------------------------------
-- 6. Adjudication provenance (set by trigger)
-- -----------------------------------------------------------------------------
alter table public.adjudications
  add column determination_level text not null default 'DESCRIPTOR_LEVEL'
    check (determination_level in ('DESCRIPTOR_LEVEL', 'DESCRIPTOR_LEVEL_IN_TRIAL_CASE', 'TRIAL_LEVEL')),
  add column adjudicator_role text check (adjudicator_role is null or adjudicator_role in ('INVESTIGATOR', 'ADJUDICATOR')),
  add column adjudicator_exposed_to_index_labels boolean,
  add column post_unblinding boolean not null default false,
  add column disagreement_reason_code text check (disagreement_reason_code is null or disagreement_reason_code in (
    'CONSTRUCT_BOUNDARY', 'POLICY_RULE_INTERPRETATION', 'MESH_PLACEMENT_MISLEADING', 'TRIAL_CONTEXT',
    'PACKET_INSUFFICIENT', 'MULTILABEL_OR_CROSS_AREA', 'OTHER')),
  add column adjudication_blinded boolean generated always as
    (coalesce(not adjudicator_exposed_to_index_labels, false) and not post_unblinding) stored;

-- The v2 view was created with j.* before these columns existed; recreate it so the
-- new provenance columns are visible (existing columns keep their order).
create or replace view public.v_effective_adjudications with (security_invoker = true) as
select j.* from public.adjudications j
where not exists (select 1 from public.adjudications k where k.supersedes_adjudication_id = j.adjudication_id);

-- -----------------------------------------------------------------------------
-- 7. Helpers
-- -----------------------------------------------------------------------------
create function private.case_module(p_case_id text) returns text
language sql stable security definer set search_path = '' as $$
  select coalesce((select d.review_module from public.case_design_v3 d where d.case_id = p_case_id), 'ONTOLOGY_AREA')
$$;

create function private.reference_locked(p_module text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.reference_locks l where l.review_module = p_module)
$$;

-- TRUE when the caller has an active assignment on the case and has recorded Step 1 on it.
create function private.step1_recorded(p_case_id text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.trial_step1_records s
    join public.assignments a on a.assignment_id = s.assignment_id and a.withdrawn_at is null
    where s.case_id = p_case_id and a.reviewer_pseudo_id = private.my_reviewer_pseudo_id())
$$;

-- FINDING-01 / FINDING-02 hardening: answer only the investigator, the adjudicator,
-- a reviewer assigned to the case, or internal calls without a signed-in user.
create or replace function private.latest_case_version_id(p_case_id text) returns uuid
language sql stable security definer set search_path = '' as $$
  select case when auth.uid() is null or private.is_investigator() or private.is_adjudicator()
                   or private.is_assigned(p_case_id)
              then (select cv.case_version_id from public.case_versions cv
                    where cv.case_id = p_case_id order by cv.version desc limit 1)
         end
$$;

create or replace function private.case_is_locked(p_case_id text) returns boolean
language sql stable security definer set search_path = '' as $$
  select case when auth.uid() is null or private.is_investigator() or private.is_adjudicator()
                   or private.is_assigned(p_case_id)
              then (select case c.mode
                             when 'FORMAL' then private.formal_phase_status() <> 'IN_PROGRESS'
                             else exists (select 1 from public.adjudications j where j.case_id = c.case_id)
                           end
                    from public.cases c where c.case_id = p_case_id)
         end
$$;

-- Trial-context packet check: the v2 allow list, plus no key that could carry
-- participant counts, sex composition, results or benchmark information.
create function private.assert_trial_packet_blinded(p jsonb) returns void
language plpgsql immutable set search_path = '' as $$
declare
  bad text;
begin
  perform private.assert_packet_blinded(p);
  select k into bad from private.jsonb_all_keys(p) k
  where k ~* '(enrol|female|male|sex|gender|baseline|result|participant|count|ppr|benchmark)'
  limit 1;
  if bad is not null then
    raise exception 'trial packet key "%" could carry outcome-derived or benchmark information and is not allowed', bad using errcode = '22023';
  end if;
end $$;

-- -----------------------------------------------------------------------------
-- 8. Triggers
-- -----------------------------------------------------------------------------

-- Adjudications (replaces the v2 body; the v2 trigger keeps calling this name).
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
  -- provenance is set here, never taken from the caller
  new.adjudicator_role := r_role;
  new.adjudicator_exposed_to_index_labels := (r_role = 'INVESTIGATOR');
  new.post_unblinding := (c.mode = 'FORMAL' and private.reference_locked(private.case_module(new.case_id)));
  -- determination level must fit the unit
  if c.unit_type = 'DESCRIPTOR_AREA' and new.determination_level <> 'DESCRIPTOR_LEVEL' then
    raise exception 'descriptor-area cases are adjudicated at DESCRIPTOR_LEVEL';
  end if;
  if c.unit_type = 'TRIAL_AREA' and coalesce(dv3.two_step_required, false)
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
  -- considered records: reviews of this case version, or Step 1 records for the step-1 level
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

-- v3 design rows: one per case; FORMAL rows refused after the module's manifest is frozen.
create function private.case_design_v3_before_insert() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.mode = 'FORMAL' and exists (select 1 from public.sample_manifests m where m.review_module = new.review_module) then
    raise exception 'the % sample manifest is frozen; adding a case needs a protocol amendment and a new design version', new.review_module;
  end if;
  if new.two_step_required and (select c.unit_type from public.cases c where c.case_id = new.case_id) <> 'TRIAL_AREA' then
    raise exception 'two_step_required applies to TRIAL_AREA cases only';
  end if;
  return new;
end $$;

-- FORMAL assignment needs the case in a frozen manifest.
create function private.assignments_v3_gate() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' and new.mode = 'FORMAL'
     and not exists (select 1 from public.sample_manifest_cases mc where mc.case_id = new.case_id) then
    raise exception 'FORMAL case % is not in a frozen sample manifest; freeze the manifest before assigning', new.case_id;
  end if;
  return new;
end $$;

-- A Step 2 review of a two-step trial case needs the reviewer's Step 1 record.
create function private.reviews_v3_require_step1() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if coalesce((select d.two_step_required from public.case_design_v3 d where d.case_id = new.case_id), false)
     and not exists (select 1 from public.trial_step1_records s where s.assignment_id = new.assignment_id) then
    raise exception 'record Step 1 (descriptor level, without trial information) before the trial-level review';
  end if;
  return new;
end $$;

create function private.trial_context_packets_before_insert() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform private.assert_trial_packet_blinded(new.packet);
  if (select c.unit_type from public.cases c where c.case_id = new.case_id) <> 'TRIAL_AREA' then
    raise exception 'trial-context packets belong to TRIAL_AREA cases only';
  end if;
  new.packet_sha256 := private.sha256_hex(new.packet::text);
  return new;
end $$;

create trigger case_design_v3_before_insert before insert on public.case_design_v3
  for each row execute function private.case_design_v3_before_insert();
create trigger assignments_v3_gate before insert on public.assignments
  for each row execute function private.assignments_v3_gate();
create trigger reviews_v3_require_step1 before insert on public.reviews
  for each row execute function private.reviews_v3_require_step1();
create trigger trial_context_packets_before_insert before insert on public.trial_context_packets
  for each row execute function private.trial_context_packets_before_insert();

do $$
declare
  t text;
begin
  foreach t in array array['case_design_v3', 'sample_manifests', 'sample_manifest_cases', 'trial_step1_records',
                           'trial_context_packets', 'reference_locks']
  loop
    execute format('create trigger %I before update or delete on public.%I for each row execute function private.reject_mutation()',
                   t || '_append_only', t);
    execute format('create trigger %I before truncate on public.%I for each statement execute function private.reject_mutation()',
                   t || '_no_truncate', t);
    execute format('create trigger %I after insert or update or delete on public.%I for each row execute function private.audit_row()',
                   t || '_audit', t);
    execute format('alter table public.%I enable row level security', t);
  end loop;
end $$;

-- -----------------------------------------------------------------------------
-- 9. Row-level security
-- -----------------------------------------------------------------------------
create policy case_design_v3_inv on public.case_design_v3 for select to authenticated using (private.is_investigator());
create policy sample_manifests_inv on public.sample_manifests for select to authenticated using (private.is_investigator());
create policy sample_manifest_cases_inv on public.sample_manifest_cases for select to authenticated using (private.is_investigator());
create policy reference_locks_read on public.reference_locks for select to authenticated
  using (private.is_investigator() or private.is_adjudicator());

-- Step 1 records: own rows; the investigator after the formal phase closes (PILOT any time);
-- the adjudicator for FORMAL cases after the formal phase closes.
create policy trial_step1_read on public.trial_step1_records for select to authenticated
  using (reviewer_pseudo_id = private.my_reviewer_pseudo_id()
         or (private.is_investigator() and (mode = 'PILOT' or private.formal_phase_status() in ('COMPLETE', 'CLOSED_INCOMPLETE')))
         or (private.is_adjudicator() and mode = 'FORMAL' and private.formal_phase_status() in ('COMPLETE', 'CLOSED_INCOMPLETE')));

-- Trial-context packet: released to an assigned reviewer only after their Step 1 exists.
create policy trial_context_read on public.trial_context_packets for select to authenticated
  using (private.is_investigator()
         or (private.is_assigned(case_id) and private.step1_recorded(case_id))
         or (private.is_adjudicator() and mode = 'FORMAL' and private.formal_phase_status() in ('COMPLETE', 'CLOSED_INCOMPLETE')));

-- ADJUDICATOR reads of the v2 tables: FORMAL only, after the formal phase closes.
create policy cases_read_adj on public.cases for select to authenticated
  using (private.is_adjudicator() and mode = 'FORMAL' and private.formal_phase_status() in ('COMPLETE', 'CLOSED_INCOMPLETE'));
create policy case_versions_read_adj on public.case_versions for select to authenticated
  using (private.is_adjudicator() and mode = 'FORMAL' and private.formal_phase_status() in ('COMPLETE', 'CLOSED_INCOMPLETE'));
create policy reviews_read_adj on public.reviews for select to authenticated
  using (private.is_adjudicator() and mode = 'FORMAL' and private.formal_phase_status() in ('COMPLETE', 'CLOSED_INCOMPLETE'));
create policy assignments_read_adj on public.assignments for select to authenticated
  using (private.is_adjudicator() and mode = 'FORMAL' and private.formal_phase_status() in ('COMPLETE', 'CLOSED_INCOMPLETE'));
create policy adjudications_read_adj on public.adjudications for select to authenticated
  using (private.is_adjudicator() and mode = 'FORMAL');

-- -----------------------------------------------------------------------------
-- 10. RPCs
-- -----------------------------------------------------------------------------
create function public.rpc_set_case_design_v3(p jsonb) returns text
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := private.assert_investigator();
begin
  insert into public.case_design_v3 (case_id, mode, review_module, analysis_set, development_basis, selection_stratum,
    variance_stratum, variance_stratum_size, selection_probability, comparison_cell_v11, original_binary,
    curated_v11_status_raw, curated_v11_binary, two_step_required, sampling_design_version, design_row_sha256, imported_by)
  values (p ->> 'case_id', p ->> 'mode', coalesce(p ->> 'review_module', 'ONTOLOGY_AREA'), p ->> 'analysis_set',
    p ->> 'development_basis', p ->> 'selection_stratum', p ->> 'variance_stratum', (p ->> 'variance_stratum_size')::integer,
    (p ->> 'selection_probability')::numeric, p ->> 'comparison_cell_v11', p ->> 'original_binary',
    p ->> 'curated_v11_status_raw', p ->> 'curated_v11_binary', coalesce((p ->> 'two_step_required')::boolean, false),
    p ->> 'sampling_design_version', private.sha256_hex(p::text), me);
  return p ->> 'case_id';
end $$;

create function public.rpc_add_trial_context_packet(p_case_id text, p_packet jsonb) returns text
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := private.assert_investigator();
  m text;
  sha text;
begin
  select c.mode into m from public.cases c where c.case_id = p_case_id;
  insert into public.trial_context_packets (case_id, mode, packet, packet_sha256, created_by)
  values (p_case_id, m, p_packet, repeat('0', 64), me)
  returning packet_sha256 into sha;
  return sha;
end $$;

-- Freeze the sample for one module. The case list is computed by the database from the
-- active FORMAL cases that carry a v3 design row for the module; the caller supplies the
-- SHA-256 of the manifest file frozen outside the database, for the record.
create function public.rpc_freeze_sample_manifest(p jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := private.assert_investigator();
  mod text := coalesce(p ->> 'review_module', 'ONTOLOGY_AREA');
  n integer;
  n_missing integer;
  lst text;
  mid uuid;
begin
  if private.formal_phase_status() <> 'IN_PROGRESS' then
    raise exception 'the sample manifest is frozen after the pilot sign-off unlocks the formal phase (status %)', private.formal_phase_status();
  end if;
  select count(*) into n_missing from public.cases c
  where c.mode = 'FORMAL' and c.withdrawn_at is null
    and not exists (select 1 from public.case_design_v3 d where d.case_id = c.case_id);
  if n_missing > 0 then
    raise exception '% active FORMAL cases have no v3 design row', n_missing;
  end if;
  select count(*), string_agg(c.case_id || ':' || d.design_row_sha256, '|' order by c.case_id) into n, lst
  from public.cases c join public.case_design_v3 d on d.case_id = c.case_id
  where c.mode = 'FORMAL' and c.withdrawn_at is null and d.review_module = mod;
  if n = 0 then
    raise exception 'no active FORMAL cases in module %', mod;
  end if;
  insert into public.sample_manifests (review_module, sampling_design_version, manifest_file_sha256, decision_file_v11_sha256,
    sampling_seed, n_cases, case_list_sha256, attestation, frozen_by)
  values (mod, p ->> 'sampling_design_version', lower(p ->> 'manifest_file_sha256'), lower(p ->> 'decision_file_v11_sha256'),
    (p ->> 'sampling_seed')::bigint, n, private.sha256_hex(lst), p ->> 'attestation', me)
  returning manifest_id into mid;
  insert into public.sample_manifest_cases (manifest_id, case_id, mode, design_row_sha256)
  select mid, c.case_id, 'FORMAL', d.design_row_sha256
  from public.cases c join public.case_design_v3 d on d.case_id = c.case_id
  where c.mode = 'FORMAL' and c.withdrawn_at is null and d.review_module = mod;
  return mid;
end $$;

create function public.rpc_record_trial_step1(p_assignment_id uuid, p jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  me text := private.my_reviewer_pseudo_id();
  a record;
  sid uuid;
  cvid uuid;
begin
  select * into a from public.assignments where assignment_id = p_assignment_id;
  if me is null or a.reviewer_pseudo_id is distinct from me or a.withdrawn_at is not null then
    raise exception 'not your active assignment' using errcode = '42501';
  end if;
  if not coalesce((select d.two_step_required from public.case_design_v3 d where d.case_id = a.case_id), false) then
    raise exception 'case % is not a two-step trial case', a.case_id;
  end if;
  if private.case_is_locked(a.case_id) then
    raise exception 'case % is closed to submissions', a.case_id;
  end if;
  cvid := private.latest_case_version_id(a.case_id);
  insert into public.trial_step1_records (assignment_id, case_id, case_version_id, mode, reviewer_pseudo_id, step1_decision,
    step1_rationale, step1_uncertain, content_sha256)
  values (p_assignment_id, a.case_id, cvid, a.mode, me, p ->> 'step1_decision', p ->> 'step1_rationale',
    coalesce((p ->> 'step1_uncertain')::boolean, false), private.sha256_hex(p::text))
  returning step1_id into sid;
  return sid;
end $$;

-- Adjudication with determination level and reason code; callable by the investigator
-- (flagged exposed to index labels) or an ADJUDICATOR (blinded).
create function public.rpc_record_adjudication_v3(p jsonb) returns uuid
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

-- Lock the reference standard for one module. Refused unless the formal phase is closed, the
-- module's manifest is frozen, and every double-reviewed case and level has an adjudication.
create function public.rpc_lock_reference(p_review_module text, p_attestation text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := private.assert_investigator();
  n_missing integer;
  n_levels integer;
  lid uuid;
begin
  if private.formal_phase_status() not in ('COMPLETE', 'CLOSED_INCOMPLETE') then
    raise exception 'the reference is locked only after the formal phase is closed';
  end if;
  if not exists (select 1 from public.sample_manifests m where m.review_module = p_review_module) then
    raise exception 'no frozen sample manifest for module %', p_review_module;
  end if;
  with mc as (
    select c.case_id, d.two_step_required
    from public.sample_manifest_cases x join public.sample_manifests m on m.manifest_id = x.manifest_id
    join public.cases c on c.case_id = x.case_id
    join public.case_design_v3 d on d.case_id = c.case_id
    where m.review_module = p_review_module and c.withdrawn_at is null
  ), lv as (
    select mc.case_id, case when mc.two_step_required then 'TRIAL_LEVEL' else 'DESCRIPTOR_LEVEL' end as lvl,
           (select count(distinct er.reviewer_slot) from public.v_effective_reviews er where er.case_id = mc.case_id) as n_rev
    from mc
    union all
    select mc.case_id, 'DESCRIPTOR_LEVEL_IN_TRIAL_CASE',
           (select count(distinct a.reviewer_slot) from public.trial_step1_records s
            join public.assignments a on a.assignment_id = s.assignment_id and a.withdrawn_at is null
            where s.case_id = mc.case_id and s.case_version_id = private.latest_case_version_id(mc.case_id))
    from mc where mc.two_step_required
  )
  select count(*) filter (where lv.n_rev >= 2
                            and not exists (select 1 from public.v_effective_adjudications j
                                            where j.case_id = lv.case_id and j.determination_level = lv.lvl
                                              and j.layer = 'clinical_classification')),
         count(*) filter (where lv.n_rev >= 2)
  into n_missing, n_levels
  from lv;
  if n_missing > 0 then
    raise exception '% double-reviewed case levels have no adjudication; the reference cannot be locked', n_missing;
  end if;
  insert into public.reference_locks (review_module, n_case_levels_locked, attestation, locked_by)
  values (p_review_module, n_levels, p_attestation, me)
  returning lock_id into lid;
  return lid;
end $$;

-- -----------------------------------------------------------------------------
-- 11. v3 analysis export view: one row per FORMAL case x determination level.
-- Rows only for the investigator and only after the module's reference lock.
-- Primary reference = the latest adjudication entered before the lock.
-- -----------------------------------------------------------------------------
create view public.v_analysis_export_v3 with (security_invoker = true) as
with lv as (
  select c.case_id, c.mode, c.unit_type, d.review_module, 'DESCRIPTOR_LEVEL'::text as determination_level
  from public.cases c join public.case_design_v3 d on d.case_id = c.case_id
  where c.mode = 'FORMAL' and c.withdrawn_at is null and not d.two_step_required
  union all
  select c.case_id, c.mode, c.unit_type, d.review_module, x.lvl
  from public.cases c join public.case_design_v3 d on d.case_id = c.case_id
  cross join (values ('DESCRIPTOR_LEVEL_IN_TRIAL_CASE'), ('TRIAL_LEVEL')) as x(lvl)
  where c.mode = 'FORMAL' and c.withdrawn_at is null and d.two_step_required
),
rev as (
  select er.case_id, er.reviewer_slot, er.reviewer_pseudo_id, er.l1_decision as decision, er.l1_uncertain as uncertain
  from public.v_effective_reviews er where er.mode = 'FORMAL'
),
s1 as (
  select s.case_id, a.reviewer_slot, s.reviewer_pseudo_id, s.step1_decision as decision, s.step1_uncertain as uncertain
  from public.trial_step1_records s
  join public.assignments a on a.assignment_id = s.assignment_id and a.withdrawn_at is null
  where s.mode = 'FORMAL' and s.case_version_id = private.latest_case_version_id(s.case_id)
),
ans as (
  select lv.case_id, lv.determination_level, r.reviewer_slot, r.reviewer_pseudo_id, r.decision, r.uncertain
  from lv join rev r on r.case_id = lv.case_id and lv.determination_level in ('DESCRIPTOR_LEVEL', 'TRIAL_LEVEL')
  union all
  select lv.case_id, lv.determination_level, s.reviewer_slot, s.reviewer_pseudo_id, s.decision, s.uncertain
  from lv join s1 s on s.case_id = lv.case_id and lv.determination_level = 'DESCRIPTOR_LEVEL_IN_TRIAL_CASE'
),
ref as (
  select distinct on (j.case_id, j.determination_level) j.*
  from public.adjudications j
  where j.layer = 'clinical_classification' and not j.post_unblinding
  order by j.case_id, j.determination_level, j.decided_at desc
)
select lv.case_id, lv.mode, false as is_pilot, lv.review_module, lv.unit_type, cd.unit_id, cd.nct_id, cd.descriptor_ui,
       cd.descriptor_name, cd.area, lv.determination_level, 'clinical_classification'::text as layer,
       d3.analysis_set, d3.development_basis, d3.selection_stratum, d3.variance_stratum, d3.variance_stratum_size,
       d3.selection_probability, d3.sampling_weight, d3.comparison_cell_v11, cd.trial_frequency_weight,
       d3.original_binary, d3.curated_v11_status_raw, d3.curated_v11_binary, d3.tuning_use_allowed,
       a1.reviewer_pseudo_id as reviewer_1_pseudo_id, a1.decision as reviewer_1_decision, a1.uncertain as reviewer_1_uncertain,
       a2.reviewer_pseudo_id as reviewer_2_pseudo_id, a2.decision as reviewer_2_decision, a2.uncertain as reviewer_2_uncertain,
       (a1.decision is not null and a2.decision is not null) as double_reviewed,
       case when a1.decision is not null and a2.decision is not null then a1.decision = a2.decision end as reviewers_agree,
       ref.adjudication_id, ref.adjudicated_decision, ref.adjudication_status, ref.adjudication_basis,
       ref.disagreement_reason_code, ref.adjudicator_role, ref.adjudication_blinded, ref.adjudicator_exposed_to_index_labels,
       exists (select 1 from public.adjudications k where k.case_id = lv.case_id and k.determination_level = lv.determination_level
               and k.post_unblinding) as post_unblinding_revision_exists,
       d3.sampling_design_version
from lv
join public.case_design cd on cd.case_id = lv.case_id
join public.case_design_v3 d3 on d3.case_id = lv.case_id
left join ans a1 on a1.case_id = lv.case_id and a1.determination_level = lv.determination_level and a1.reviewer_slot = 1
left join ans a2 on a2.case_id = lv.case_id and a2.determination_level = lv.determination_level and a2.reviewer_slot = 2
left join ref on ref.case_id = lv.case_id and ref.determination_level = lv.determination_level
where private.is_investigator() and private.reference_locked(lv.review_module);

-- -----------------------------------------------------------------------------
-- 12. Grants (same pattern as v2: reads filtered by RLS, writes only through rpc_*)
-- -----------------------------------------------------------------------------
revoke all on public.case_design_v3, public.sample_manifests, public.sample_manifest_cases, public.trial_step1_records,
              public.trial_context_packets, public.reference_locks, public.v_analysis_export_v3 from anon, authenticated;
grant select on public.case_design_v3, public.sample_manifests, public.sample_manifest_cases, public.trial_step1_records,
                public.trial_context_packets, public.reference_locks, public.v_analysis_export_v3 to authenticated;
revoke all on function private.is_adjudicator(), private.case_module(text), private.reference_locked(text),
                       private.step1_recorded(text), private.assert_trial_packet_blinded(jsonb),
                       private.case_design_v3_before_insert(), private.assignments_v3_gate(),
                       private.reviews_v3_require_step1(), private.trial_context_packets_before_insert()
  from public, anon, authenticated;
grant execute on function private.is_adjudicator(), private.reference_locked(text), private.step1_recorded(text),
                          private.case_module(text)
  to authenticated;
revoke all on function public.rpc_set_case_design_v3(jsonb), public.rpc_add_trial_context_packet(text, jsonb),
                       public.rpc_freeze_sample_manifest(jsonb), public.rpc_record_trial_step1(uuid, jsonb),
                       public.rpc_record_adjudication_v3(jsonb), public.rpc_lock_reference(text, text)
  from public, anon;
grant execute on function public.rpc_set_case_design_v3(jsonb), public.rpc_add_trial_context_packet(text, jsonb),
                          public.rpc_freeze_sample_manifest(jsonb), public.rpc_record_trial_step1(uuid, jsonb),
                          public.rpc_record_adjudication_v3(jsonb), public.rpc_lock_reference(text, text)
  to authenticated;

commit;
