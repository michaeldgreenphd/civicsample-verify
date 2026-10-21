-- =============================================================================
-- migrations/0003_v4_record_categories_module_b.sql
-- Clinical review schema v4: applies ON TOP OF the unchanged schema.sql (v2) and
-- migrations/0002_v3_review_design.sql (v3).
--
-- Status: PRE-BUILD, PROPOSED. Tested on PGlite only (tests_prebuild/pglite_rls_v4/,
-- SCHEMA_TEST_REPORT_v4.md). Live PostgreSQL 16 and Supabase migration and RLS tests
-- are REQUIRED before any formal reviewer is invited (CLAUDE_CODE_MASTER_PROMPT_v4.md).
--
-- What v4 adds (design: classification_validation/review_design_v4/, decisions D2 and D4):
--   1. Design activation (irreversible). After rpc_activate_design_v4 every FORMAL case
--      must be a held-out case: case ID HO4- (or HO4R- under an approved protocol
--      amendment), a v4 case record with provenance result NO_DEVELOPMENT_FLAG, and a
--      frame unit that is not in the development registry.
--   2. Record categories with distinct identifiers and access rules:
--      DEVELOPMENT (DEV4-, registry only, investigator), RUBRIC_CALIBRATION (CAL4-, own
--      tables, never joined to formal data), SYNTHETIC_PILOT (SYN-, v2 PILOT mode),
--      HELDOUT_FORMAL (HO4-), HELDOUT_EXTENSION_APPROVED (HO4R-), adjudication records
--      (exported as ADJ4- references), Module B (MB4-ROW-, MB4-T).
--   3. Frozen predictions: Tier 0 and Tier 1 per held-out case and determination level,
--      investigator-only (no reviewer or adjudicator policy), write-once, consistent with
--      the deterministic mapping policy, import refused after the freeze.
--   4. One freeze event (rpc_freeze_v4): the held-out case list must equal the v3 sample
--      manifest; every case has its predictions; one Tier 1 version; hashes of the case
--      list, the prediction rows and every frozen file are recorded. After the freeze no
--      FORMAL case, case record, prediction, development or calibration row can be added;
--      a new ontology version must carry the -DVF suffix (development from validation
--      feedback) and FORMAL case versions cannot use it.
--   5. Independent judgments are snapshotted (hash recorded) after the close and before
--      any FORMAL adjudication; v_independent_judgments_v4 exports each reviewer's
--      initial and effective answers, separately from the adjudicated reference.
--   6. Adjudication scope (D2 default DISAGREEMENTS_ONLY): the adjudicator resolves
--      discordant and single-reviewed case levels; concordant case levels enter the
--      reference by rule in v_adjudicated_reference_v4; rpc_lock_reference_v4 checks the
--      scope; the v3 lock is refused for Module A once v4 is active.
--   7. Module B (benchmark compatibility and row eligibility) in its own tables, with its
--      own manifest, phase, assignments, responses, adjudications, lock and export view.
--   8. Two guards that keep the frozen comparison intact: a frozen held-out case cannot be
--      withdrawn, and the formal phase cannot reopen once the judgments are snapshotted.
--   9. The audit log stores trial Step 1 records and Module B responses as identifiers and a
--      hash (FINDING-V4-01: under v3 it stored Step 1 decisions in clear text).
--
-- Apply after schema.sql and 0002, in one transaction each:
--   psql -v ON_ERROR_STOP=1 -f schema.sql
--   psql -v ON_ERROR_STOP=1 -f migrations/0002_v3_review_design.sql
--   psql -v ON_ERROR_STOP=1 -f migrations/0003_v4_record_categories_module_b.sql
-- Every object below is new except the replaced bodies of public.rpc_lock_reference (v3 body
-- plus a v4 guard) and private.audit_row (v2 body plus two branches), and the widened
-- adjudication status constraint.
-- =============================================================================
begin;

insert into public.app_schema_version (version, description)
values ('4.0.0', 'review design v4: held-out record categories, development registry, calibration tables, frozen predictions, v4 freeze, judgment snapshot, adjudication scope, v4 lock and exports, Module B tables');

-- -----------------------------------------------------------------------------
-- 1. Activation, amendments, development registry
-- -----------------------------------------------------------------------------
create table public.design_activation_v4 (
  activation_id       uuid primary key default gen_random_uuid(),
  singleton           boolean not null default true unique check (singleton),
  design_version      text not null check (length(design_version) between 3 and 80),
  adjudication_scope  text not null check (adjudication_scope in ('DISAGREEMENTS_ONLY', 'ALL_CASE_LEVELS')),
  attestation         text not null check (length(attestation) >= 20),
  activated_at        timestamptz not null default now(),
  activated_by        uuid not null references public.users (user_id)
);

create table public.protocol_amendments_v4 (
  amendment_id   text primary key check (amendment_id ~ '^AMD4-[A-Z0-9-]{1,40}$'),
  purpose        text not null check (purpose in ('ADOPT_EXTENSION_30', 'OTHER')),
  description    text not null check (length(description) >= 20),
  approved_at    timestamptz not null default now(),
  approved_by    uuid not null references public.users (user_id)
);

create table public.development_registry_v4 (
  dev_case_id               text primary key check (dev_case_id ~ '^DEV4-[A-Za-z0-9-]{1,40}$'),
  frame_unit_id             text not null unique check (length(frame_unit_id) between 3 and 200),
  unit_type                 text not null check (unit_type in ('DESCRIPTOR_AREA', 'TRIAL_AREA')),
  primary_exclusion_reason  text not null check (primary_exclusion_reason ~ '^E[0-9]{2}_[A-Z0-9_]+$'),
  exclusion_reasons         text not null,
  registered_at             timestamptz not null default now(),
  registered_by             uuid not null references public.users (user_id)
);

-- -----------------------------------------------------------------------------
-- 2. Held-out case records (one per FORMAL case; investigator only)
-- -----------------------------------------------------------------------------
create table public.case_records_v4 (
  case_id                         text primary key,
  mode                            text not null check (mode = 'FORMAL'),
  record_category                 text not null check (record_category in ('HELDOUT_FORMAL', 'HELDOUT_EXTENSION_APPROVED')),
  frame_unit_id                   text not null unique,
  provenance_audit_result         text not null check (provenance_audit_result = 'NO_DEVELOPMENT_FLAG'),
  impact_tier                     text not null,
  policy_governed_neoplasm_gen06  boolean not null default false,
  amendment_id                    text references public.protocol_amendments_v4 (amendment_id),
  design_row_sha256               text not null check (design_row_sha256 ~ '^[0-9a-f]{64}$'),
  recorded_at                     timestamptz not null default now(),
  recorded_by                     uuid not null references public.users (user_id),
  foreign key (case_id, mode) references public.cases (case_id, mode),
  check ((record_category = 'HELDOUT_FORMAL' and case_id like 'HO4-%' and amendment_id is null)
      or (record_category = 'HELDOUT_EXTENSION_APPROVED' and case_id like 'HO4R-%' and amendment_id is not null))
);

-- -----------------------------------------------------------------------------
-- 3. Rubric calibration (own tables; never joined to formal data)
-- -----------------------------------------------------------------------------
create table public.calibration_cases_v4 (
  cal_case_id         text primary key check (cal_case_id ~ '^CAL4-[A-Za-z0-9-]{1,40}$'),
  source_dev_case_id  text not null unique references public.development_registry_v4 (dev_case_id),
  unit_type           text not null check (unit_type in ('DESCRIPTOR_AREA', 'TRIAL_AREA')),
  packet              jsonb not null check (jsonb_typeof(packet) = 'object'),
  packet_sha256       text not null check (packet_sha256 ~ '^[0-9a-f]{64}$'),
  created_at          timestamptz not null default now(),
  created_by          uuid not null references public.users (user_id)
);
create table public.calibration_assignments_v4 (
  cal_assignment_id   uuid primary key default gen_random_uuid(),
  cal_case_id         text not null references public.calibration_cases_v4 (cal_case_id),
  reviewer_pseudo_id  text not null references public.reviewers (reviewer_pseudo_id),
  assigned_at         timestamptz not null default now(),
  assigned_by         uuid not null references public.users (user_id),
  unique (cal_case_id, reviewer_pseudo_id)
);
create table public.calibration_responses_v4 (
  cal_response_id     uuid primary key default gen_random_uuid(),
  cal_assignment_id   uuid not null references public.calibration_assignments_v4 (cal_assignment_id),
  reviewer_pseudo_id  text not null,
  decision            text not null check (decision in ('INCLUDE', 'EXCLUDE', 'CONTEXT_DEPENDENT', 'INSUFFICIENT_INFORMATION')),
  rationale           text check (rationale is null or length(rationale) <= 4000),
  uncertain           boolean not null,
  submitted_at        timestamptz not null default now()
);

-- -----------------------------------------------------------------------------
-- 4. Frozen predictions (investigator only; write-once)
-- -----------------------------------------------------------------------------
create table public.frozen_predictions_v4 (
  prediction_id        uuid primary key default gen_random_uuid(),
  prediction_set_id    text not null check (length(prediction_set_id) between 3 and 80),
  case_id              text not null references public.case_records_v4 (case_id),
  determination_level  text not null check (determination_level in ('DESCRIPTOR_LEVEL', 'DESCRIPTOR_LEVEL_IN_TRIAL_CASE', 'TRIAL_LEVEL')),
  tier0_binary         text not null check (tier0_binary in ('INCLUDE', 'EXCLUDE')),
  tier1_version        text not null check (tier1_version in ('v1.1', 'v1.2')),
  tier1_status_raw     text not null check (tier1_status_raw in ('INCLUDE', 'EXCLUDE', 'CONTEXT_DEPENDENT', 'INSUFFICIENT_EVIDENCE', 'NOT_IN_DECISION_FILE')),
  tier1_binary         text not null check (tier1_binary in ('INCLUDE', 'EXCLUDE')),
  stage_c_trial_status text check (stage_c_trial_status is null or stage_c_trial_status in ('INCLUDE', 'EXCLUDE', 'UNRESOLVED')),
  row_sha256           text not null check (row_sha256 ~ '^[0-9a-f]{64}$'),
  imported_at          timestamptz not null default now(),
  imported_by          uuid not null references public.users (user_id),
  unique (case_id, determination_level),
  -- deterministic mapping policy (CLINICAL_ONTOLOGY.yaml deterministic_mapping_policy)
  check (determination_level = 'TRIAL_LEVEL' or tier1_binary =
         case tier1_status_raw when 'INCLUDE' then 'INCLUDE' when 'EXCLUDE' then 'EXCLUDE'
                               when 'NOT_IN_DECISION_FILE' then 'EXCLUDE' else tier0_binary end),
  check (determination_level <> 'TRIAL_LEVEL' or tier1_binary =
         case when stage_c_trial_status in ('INCLUDE', 'EXCLUDE') then stage_c_trial_status else tier0_binary end)
);

-- -----------------------------------------------------------------------------
-- 5. Freeze and judgment snapshot
-- -----------------------------------------------------------------------------
create table public.freeze_manifests_v4 (
  freeze_id               uuid primary key default gen_random_uuid(),
  singleton               boolean not null default true unique check (singleton),
  design_version          text not null,
  tier1_version           text not null check (tier1_version in ('v1.1', 'v1.2')),
  adjudication_scope      text not null check (adjudication_scope in ('DISAGREEMENTS_ONLY', 'ALL_CASE_LEVELS')),
  n_cases                 integer not null check (n_cases >= 1),
  case_list_sha256        text not null check (case_list_sha256 ~ '^[0-9a-f]{64}$'),
  n_prediction_rows       integer not null check (n_prediction_rows >= 1),
  prediction_rows_sha256  text not null check (prediction_rows_sha256 ~ '^[0-9a-f]{64}$'),
  prediction_file_sha256  text not null check (prediction_file_sha256 ~ '^[0-9a-f]{64}$'),
  frozen_items            jsonb not null check (jsonb_typeof(frozen_items) = 'object'),
  extension_amendment_id  text references public.protocol_amendments_v4 (amendment_id),
  attestation             text not null check (length(attestation) >= 20),
  frozen_at               timestamptz not null default now(),
  frozen_by               uuid not null references public.users (user_id)
);

create table public.judgment_snapshots_v4 (
  snapshot_id     uuid primary key default gen_random_uuid(),
  singleton       boolean not null default true unique check (singleton),
  n_rows          integer not null check (n_rows >= 0),
  content_sha256  text not null check (content_sha256 ~ '^[0-9a-f]{64}$'),
  taken_at        timestamptz not null default now(),
  taken_by        uuid not null references public.users (user_id)
);

-- -----------------------------------------------------------------------------
-- 6. Module B tables
-- -----------------------------------------------------------------------------
create table public.mb_units_v4 (
  mb_unit_id     text primary key check (mb_unit_id ~ '^MB4-(ROW-[A-Za-z0-9_-]{2,60}|T[A-Za-z0-9_-]{1,60})$'),
  unit_type      text not null check (unit_type in ('CONDITION_ROW_BENCHMARK', 'TRIAL_ELIGIBILITY')),
  packet         jsonb not null check (jsonb_typeof(packet) = 'object'),
  packet_sha256  text not null check (packet_sha256 ~ '^[0-9a-f]{64}$'),
  created_at     timestamptz not null default now(),
  created_by     uuid not null references public.users (user_id),
  check ((unit_type = 'CONDITION_ROW_BENCHMARK') = (mb_unit_id like 'MB4-ROW-%'))
);
create table public.mb_unit_design_v4 (
  mb_unit_id                    text primary key references public.mb_units_v4 (mb_unit_id),
  row_id                        text not null,
  stratum                       text not null,
  frame_n                       integer not null check (frame_n >= 1),
  selection_probability         numeric not null check (selection_probability > 0 and selection_probability <= 1),
  sampling_weight               numeric generated always as (1 / selection_probability) stored,
  pipeline_status_provisional   text,
  nct_id                        text check (nct_id is null or nct_id ~ '^(NCT[0-9]{8}|SYN-NCT-?[0-9]{4,8})$'),
  benchmark_id                  text,
  design_row_sha256             text not null check (design_row_sha256 ~ '^[0-9a-f]{64}$'),
  imported_at                   timestamptz not null default now(),
  imported_by                   uuid not null references public.users (user_id)
);
create table public.mb_manifest_v4 (
  mb_manifest_id    uuid primary key default gen_random_uuid(),
  singleton         boolean not null default true unique check (singleton),
  n_units           integer not null check (n_units >= 1),
  unit_list_sha256  text not null check (unit_list_sha256 ~ '^[0-9a-f]{64}$'),
  attestation       text not null check (length(attestation) >= 20),
  frozen_at         timestamptz not null default now(),
  frozen_by         uuid not null references public.users (user_id)
);
create table public.mb_phase_events_v4 (
  event_id     uuid primary key default gen_random_uuid(),
  event_seq    bigint generated always as identity unique,
  event_type   text not null check (event_type in ('MB_OPENED', 'MB_CLOSED')),
  attestation  text not null check (length(attestation) >= 20),
  occurred_at  timestamptz not null default now(),
  actor        uuid not null references public.users (user_id)
);
create table public.mb_assignments_v4 (
  mb_assignment_id    uuid primary key default gen_random_uuid(),
  mb_unit_id          text not null references public.mb_units_v4 (mb_unit_id),
  reviewer_pseudo_id  text not null references public.reviewers (reviewer_pseudo_id),
  reviewer_slot       smallint not null check (reviewer_slot in (1, 2)),
  queue_position      integer not null check (queue_position >= 1),
  assigned_at         timestamptz not null default now(),
  assigned_by         uuid not null references public.users (user_id),
  unique (mb_unit_id, reviewer_pseudo_id),
  unique (mb_unit_id, reviewer_slot),
  unique (mb_assignment_id, mb_unit_id, reviewer_pseudo_id)
);
create table public.mb_responses_v4 (
  mb_response_id      uuid primary key default gen_random_uuid(),
  mb_assignment_id    uuid not null,
  mb_unit_id          text not null,
  reviewer_pseudo_id  text not null,
  revision_number     integer not null check (revision_number >= 1),
  compatibility       text check (compatibility is null or compatibility in ('COMPATIBLE', 'COMPATIBLE_WITH_CAVEAT', 'INCOMPATIBLE', 'NOT_ESTIMABLE')),
  caveat_codes        text[] check (caveat_codes is null or caveat_codes <@ array['CASE_DEFINITION', 'POPULATION_TYPE', 'AGE_RANGE',
                                     'CALENDAR_PERIOD', 'PREVENTION_VS_TREATMENT', 'SUBTYPE_MIX', 'OTHER']::text[]),
  eligibility         text check (eligibility is null or eligibility in ('INCLUDE', 'EXCLUDE', 'UNRESOLVED')),
  exclusion_reason    text check (exclusion_reason is null or exclusion_reason in ('WRONG_CONDITION', 'WRONG_SUBTYPE',
                                     'COMPLICATION_DEFINED_POPULATION', 'NON_MALIGNANT_CONDITION', 'WRONG_HYPERTENSION_TYPE',
                                     'PREVENTION_OR_HEALTHY_VOLUNTEERS', 'AGE_OUTSIDE_BENCHMARK', 'OTHER')),
  rationale           text check (rationale is null or length(rationale) <= 4000),
  uncertain           boolean not null,
  packet_issue_flag   boolean not null default false,
  packet_issue_note   text check (packet_issue_note is null or length(packet_issue_note) <= 2000),
  submitted_at        timestamptz not null default now(),
  foreign key (mb_assignment_id, mb_unit_id, reviewer_pseudo_id)
    references public.mb_assignments_v4 (mb_assignment_id, mb_unit_id, reviewer_pseudo_id),
  unique (mb_assignment_id, revision_number),
  check ((compatibility is null) <> (eligibility is null)),
  check ((coalesce(cardinality(caveat_codes), 0) >= 1) = (coalesce(compatibility in ('COMPATIBLE_WITH_CAVEAT', 'INCOMPATIBLE'), false))),
  check ((exclusion_reason is not null) = (eligibility is not distinct from 'EXCLUDE')),
  check (rationale is not null or compatibility is not distinct from 'COMPATIBLE' or eligibility is not distinct from 'INCLUDE'),
  check (not packet_issue_flag or packet_issue_note is not null)
);
create table public.mb_adjudications_v4 (
  mb_adjudication_id  uuid primary key default gen_random_uuid(),
  mb_unit_id          text not null unique references public.mb_units_v4 (mb_unit_id),
  decision            text,
  status              text not null check (status in ('DISCORDANT_RESOLVED', 'SINGLE_REVIEW_ADJUDICATED', 'UNRESOLVED_ESCALATED')),
  basis               text not null check (basis in ('REVIEWER_1', 'REVIEWER_2', 'NEITHER', 'NONE')),
  rationale           text not null check (length(rationale) between 3 and 4000),
  adjudicator_role    text,
  adjudicator_exposed_to_pipeline_status boolean,
  decided_by          uuid not null references public.users (user_id),
  decided_at          timestamptz not null default now(),
  check ((status = 'UNRESOLVED_ESCALATED') = (decision is null)),
  check ((status = 'UNRESOLVED_ESCALATED') = (basis = 'NONE')),
  check (decision is null or decision in ('COMPATIBLE', 'COMPATIBLE_WITH_CAVEAT', 'INCOMPATIBLE', 'NOT_ESTIMABLE',
                                          'INCLUDE', 'EXCLUDE', 'UNRESOLVED'))
);
create table public.mb_reference_lock_v4 (
  mb_lock_id     uuid primary key default gen_random_uuid(),
  singleton      boolean not null default true unique check (singleton),
  n_units        integer not null check (n_units >= 0),
  attestation    text not null check (length(attestation) >= 20),
  locked_at      timestamptz not null default now(),
  locked_by      uuid not null references public.users (user_id)
);

-- -----------------------------------------------------------------------------
-- 7. Adjudication statuses: v4 adds SINGLE_REVIEW_ADJUDICATED (a case level that only
--    one reviewer answered before the close). CONCORDANT_ADOPTED_BY_RULE is never stored:
--    v_adjudicated_reference_v4 produces it.
-- -----------------------------------------------------------------------------
alter table public.adjudications drop constraint adjudications_adjudication_status_check;
alter table public.adjudications add constraint adjudications_adjudication_status_check check (adjudication_status in (
  'CONCORDANT_CONFIRMED', 'CONCORDANT_REVISED', 'DISCORDANT_RESOLVED', 'UNRESOLVED_ESCALATED', 'SINGLE_REVIEW_ADJUDICATED'));

-- -----------------------------------------------------------------------------
-- 8. Helpers
-- -----------------------------------------------------------------------------
create function private.v4_active() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.design_activation_v4)
$$;

create function private.v4_frozen() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.freeze_manifests_v4)
$$;

create function private.v4_scope() returns text
language sql stable security definer set search_path = '' as $$
  select a.adjudication_scope from public.design_activation_v4 a
$$;

create function private.mb_phase() returns text
language sql stable security definer set search_path = '' as $$
  select coalesce((select e.event_type from public.mb_phase_events_v4 e order by e.event_seq desc limit 1), 'NOT_OPENED')
$$;

create function private.mb_is_assigned(p_unit text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.mb_assignments_v4 a
                 where a.mb_unit_id = p_unit and a.reviewer_pseudo_id = private.my_reviewer_pseudo_id())
$$;

create function private.cal_is_assigned(p_case text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.calibration_assignments_v4 a
                 where a.cal_case_id = p_case and a.reviewer_pseudo_id = private.my_reviewer_pseudo_id())
$$;

-- Effective answers of the reviewers for one held-out case level (descriptor level and trial
-- level from reviews of the latest case version, step 1 from trial_step1_records). Used inside
-- SECURITY DEFINER functions and investigator-only views.
create function private.case_level_answers_v4(p_case_id text, p_level text)
returns table (reviewer_slot smallint, decision text)
language sql stable security definer set search_path = '' as $$
  select a.reviewer_slot, r.l1_decision
  from public.reviews r
  join public.assignments a on a.assignment_id = r.assignment_id and a.withdrawn_at is null
  where p_level in ('DESCRIPTOR_LEVEL', 'TRIAL_LEVEL') and r.case_id = p_case_id
    and r.case_version_id = (select cv.case_version_id from public.case_versions cv where cv.case_id = p_case_id
                             order by cv.version desc limit 1)
    and r.revision_number = (select max(r2.revision_number) from public.reviews r2
                             where r2.assignment_id = r.assignment_id and r2.case_version_id = r.case_version_id)
  union all
  select a.reviewer_slot, s.step1_decision
  from public.trial_step1_records s
  join public.assignments a on a.assignment_id = s.assignment_id and a.withdrawn_at is null
  where p_level = 'DESCRIPTOR_LEVEL_IN_TRIAL_CASE' and s.case_id = p_case_id
    and s.case_version_id = (select cv.case_version_id from public.case_versions cv where cv.case_id = p_case_id
                             order by cv.version desc limit 1)
$$;

-- Required determination levels of a held-out case.
create function private.case_levels_v4(p_case_id text) returns setof text
language sql stable security definer set search_path = '' as $$
  select x.lvl from (
    select case when coalesce(d.two_step_required, false) then array['DESCRIPTOR_LEVEL_IN_TRIAL_CASE', 'TRIAL_LEVEL']
                else array['DESCRIPTOR_LEVEL'] end as lvls
    from public.cases c left join public.case_design_v3 d on d.case_id = c.case_id
    where c.case_id = p_case_id) s, unnest(s.lvls) as x(lvl)
$$;

-- Reviewer-visible Module B packet: allow-listed top-level keys and no key that could carry a
-- benchmark value, participant counts, pipeline status, AI output or design information.
create function private.assert_mb_packet_blinded(p jsonb) returns void
language plpgsql immutable set search_path = '' as $$
declare
  bad text;
begin
  select k into bad from jsonb_object_keys(p) k
  where k not in ('schema_version', 'unit', 'question', 'row', 'benchmark_definition', 'trial', 'links', 'notices')
  limit 1;
  if bad is not null then
    raise exception 'Module B packet top-level key "%" is not on the allow list', bad using errcode = '22023';
  end if;
  select k into bad from private.jsonb_all_keys(p) k
  where k ~* '(value|prevalence|female|(^|_)male|share|ppr|threshold|participant|enrol|result|pipeline|compatib|^ai_|_ai_|stage_?[abcd]($|_)|confidence|weight|stratum|probabil|decision|reviewer|adjudicat|(^|_)counts?($|_)|^n_|number_of)'
  limit 1;
  if bad is not null then
    raise exception 'Module B packet key "%" could carry blinded content and is not allowed', bad using errcode = '22023';
  end if;
end $$;

-- Canonical text of one prediction row (field order is part of the contract).
create function private.prediction_row_text_v4(p_set text, p_case text, p_level text, p_t0 text, p_ver text,
                                               p_status text, p_t1 text, p_stage_c text) returns text
language sql immutable set search_path = '' as $$
  select concat_ws('|', p_set, p_case, p_level, p_t0, p_ver, p_status, p_t1, coalesce(p_stage_c, ''))
$$;

create function private.prediction_rows_sha256_v4() returns text
language sql stable security definer set search_path = '' as $$
  select private.sha256_hex(string_agg(f.row_sha256, E'\n' order by f.case_id collate "C", f.determination_level collate "C"))
  from public.frozen_predictions_v4 f
$$;

-- -----------------------------------------------------------------------------
-- 9. Triggers
-- -----------------------------------------------------------------------------

-- After activation a FORMAL case must carry a held-out prefix; none can be added after the freeze.
create function private.cases_v4_gate() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.mode = 'FORMAL' and private.v4_active() then
    if new.case_id !~ '^HO4R?-' then
      raise exception 'design v4: FORMAL case IDs start with HO4- (or HO4R- under an approved amendment); % is not a held-out case ID', new.case_id;
    end if;
    if private.v4_frozen() then
      raise exception 'design v4: the held-out sample is frozen; case % cannot be added', new.case_id;
    end if;
  end if;
  return new;
end $$;

create function private.case_design_v3_v4_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.mode = 'FORMAL' and private.v4_active() and new.analysis_set <> 'VALIDATION_HELDOUT' then
    raise exception 'design v4: every FORMAL case is held out; analysis_set % is not allowed', new.analysis_set;
  end if;
  return new;
end $$;

create function private.development_registry_v4_before_insert() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if not private.v4_active() then
    raise exception 'activate design v4 before registering development units';
  end if;
  if private.v4_frozen() then
    raise exception 'the held-out sample is frozen; the development registry cannot change';
  end if;
  if exists (select 1 from public.case_records_v4 r where r.frame_unit_id = new.frame_unit_id) then
    raise exception 'frame unit % is already a held-out case; it cannot also be a development unit', new.frame_unit_id;
  end if;
  return new;
end $$;

create function private.protocol_amendments_v4_before_insert() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.purpose = 'ADOPT_EXTENSION_30' and private.v4_frozen() then
    raise exception 'the extension can be adopted only by an amendment approved before the freeze';
  end if;
  return new;
end $$;

create function private.case_records_v4_before_insert() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if not private.v4_active() then
    raise exception 'activate design v4 before recording held-out cases';
  end if;
  if private.v4_frozen() then
    raise exception 'the held-out sample is frozen; case % cannot be recorded', new.case_id;
  end if;
  if exists (select 1 from public.development_registry_v4 d where d.frame_unit_id = new.frame_unit_id) then
    raise exception 'frame unit % is a development unit and can never be a held-out case', new.frame_unit_id;
  end if;
  if new.record_category = 'HELDOUT_EXTENSION_APPROVED'
     and not exists (select 1 from public.protocol_amendments_v4 m where m.amendment_id = new.amendment_id and m.purpose = 'ADOPT_EXTENSION_30') then
    raise exception 'an HO4R- case needs an approved ADOPT_EXTENSION_30 amendment';
  end if;
  return new;
end $$;

create function private.calibration_v4_before_insert() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  rv record;
begin
  if not private.v4_active() then
    raise exception 'activate design v4 before calibration';
  end if;
  if private.v4_frozen() then
    raise exception 'rubric calibration closes at the freeze; calibration records cannot be added';
  end if;
  if tg_table_name = 'calibration_cases_v4' then
    perform private.assert_packet_blinded(new.packet);
    new.packet_sha256 := private.sha256_hex(new.packet::text);
  elsif tg_table_name = 'calibration_assignments_v4' then
    select r.mode_scope, r.withdrawn_at, u.is_active into rv
    from public.reviewers r join public.users u on u.user_id = r.user_id
    where r.reviewer_pseudo_id = new.reviewer_pseudo_id;
    if rv.mode_scope is distinct from 'FORMAL' or rv.withdrawn_at is not null or not rv.is_active then
      raise exception 'calibration is for active FORMAL reviewers only';
    end if;
  end if;
  return new;
end $$;

create function private.frozen_predictions_v4_before_insert() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if not private.v4_active() then
    raise exception 'activate design v4 before importing predictions';
  end if;
  if private.v4_frozen() then
    raise exception 'predictions are frozen; an ontology or mapping change after the freeze cannot alter them';
  end if;
  if new.determination_level not in (select private.case_levels_v4(new.case_id)) then
    raise exception 'determination level % does not apply to case %', new.determination_level, new.case_id;
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

-- FORMAL assignments: only frozen held-out cases.
create function private.assignments_v4_gate() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' and new.mode = 'FORMAL' and private.v4_active() then
    if not private.v4_frozen() then
      raise exception 'design v4: FORMAL assignments open only after rpc_freeze_v4';
    end if;
    if not exists (select 1 from public.case_records_v4 r where r.case_id = new.case_id) then
      raise exception 'design v4: case % is not a frozen held-out case', new.case_id;
    end if;
  end if;
  return new;
end $$;

-- After the freeze, a new ontology version is development from validation feedback.
create function private.ontology_versions_v4_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if private.v4_frozen() and new.ontology_version !~ '-DVF$' then
    raise exception 'after the v4 freeze a new ontology version is development from validation feedback and must end in -DVF';
  end if;
  return new;
end $$;

create function private.case_versions_v4_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.mode = 'FORMAL' and private.v4_frozen()
     and (select o.registered_at from public.ontology_versions o where o.version_set_id = new.version_set_id)
         > (select f.frozen_at from public.freeze_manifests_v4 f) then
    raise exception 'a FORMAL case version cannot use a version set registered after the freeze';
  end if;
  return new;
end $$;

-- FORMAL adjudication under v4: judgment snapshot first; status consistent with the
-- reviewers' answers and with the adjudication scope.
create function private.adjudications_v4_guard() returns trigger
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
  return new;
end $$;

-- After the freeze the held-out case list is fixed: a frozen held-out case cannot be withdrawn
-- (a case that cannot be judged is recorded as UNRESOLVED_ESCALATED instead).
create function private.cases_v4_no_withdraw_after_freeze() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if old.withdrawn_at is null and new.withdrawn_at is not null and private.v4_frozen()
     and exists (select 1 from public.case_records_v4 r where r.case_id = old.case_id) then
    raise exception 'design v4: % is a frozen held-out case and cannot be withdrawn; the case list is fixed at the freeze', old.case_id;
  end if;
  return new;
end $$;

-- The snapshot fixes the independent judgments: the formal phase cannot reopen after it.
create function private.review_phase_events_v4_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.event_type = 'FORMAL_REOPENED_BY_AMENDMENT' and exists (select 1 from public.judgment_snapshots_v4) then
    raise exception 'design v4: the independent judgments are snapshotted; the formal phase cannot reopen';
  end if;
  return new;
end $$;

-- Module B triggers
create function private.mb_units_v4_before_insert() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from public.mb_manifest_v4) then
    raise exception 'the Module B sample is frozen; % rows cannot be added', tg_table_name;
  end if;
  if tg_table_name = 'mb_units_v4' then
    perform private.assert_mb_packet_blinded(new.packet);
    new.packet_sha256 := private.sha256_hex(new.packet::text);
  end if;
  return new;
end $$;

create function private.mb_assignments_v4_before_insert() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  rv record;
begin
  if not exists (select 1 from public.mb_manifest_v4) then
    raise exception 'freeze the Module B sample before assigning units';
  end if;
  if private.mb_phase() <> 'MB_OPENED' then
    raise exception 'Module B assignments need the Module B phase open (status %)', private.mb_phase();
  end if;
  select r.mode_scope, r.withdrawn_at, u.is_active into rv
  from public.reviewers r join public.users u on u.user_id = r.user_id
  where r.reviewer_pseudo_id = new.reviewer_pseudo_id;
  if rv.mode_scope is distinct from 'FORMAL' or rv.withdrawn_at is not null or not rv.is_active then
    raise exception 'Module B units go to active FORMAL reviewers only';
  end if;
  return new;
end $$;

create function private.mb_responses_v4_before_insert() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  ut text;
  prev integer;
begin
  if private.mb_phase() <> 'MB_OPENED' then
    raise exception 'Module B is not open for responses (status %)', private.mb_phase();
  end if;
  select u.unit_type into ut from public.mb_units_v4 u where u.mb_unit_id = new.mb_unit_id;
  if (ut = 'CONDITION_ROW_BENCHMARK') <> (new.compatibility is not null) then
    raise exception 'row units take a compatibility answer and trial units an eligibility answer';
  end if;
  select max(r.revision_number) into prev from public.mb_responses_v4 r where r.mb_assignment_id = new.mb_assignment_id;
  new.revision_number := coalesce(prev, 0) + 1;
  new.submitted_at := now();
  return new;
end $$;

create function private.mb_adjudications_v4_before_insert() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  r_role text;
  n integer;
  n_distinct integer;
  ut text;
begin
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
  new.adjudicator_role := r_role;
  new.adjudicator_exposed_to_pipeline_status := (r_role = 'INVESTIGATOR');
  new.decided_at := now();
  return new;
end $$;

create trigger cases_v4_gate before insert on public.cases
  for each row execute function private.cases_v4_gate();
create trigger cases_v4_no_withdraw_after_freeze before update on public.cases
  for each row execute function private.cases_v4_no_withdraw_after_freeze();
create trigger review_phase_events_v4_guard before insert on public.review_phase_events
  for each row execute function private.review_phase_events_v4_guard();
create trigger case_design_v3_v4_guard before insert on public.case_design_v3
  for each row execute function private.case_design_v3_v4_guard();
create trigger development_registry_v4_before_insert before insert on public.development_registry_v4
  for each row execute function private.development_registry_v4_before_insert();
create trigger protocol_amendments_v4_before_insert before insert on public.protocol_amendments_v4
  for each row execute function private.protocol_amendments_v4_before_insert();
create trigger case_records_v4_before_insert before insert on public.case_records_v4
  for each row execute function private.case_records_v4_before_insert();
create trigger calibration_cases_v4_before_insert before insert on public.calibration_cases_v4
  for each row execute function private.calibration_v4_before_insert();
create trigger calibration_assignments_v4_before_insert before insert on public.calibration_assignments_v4
  for each row execute function private.calibration_v4_before_insert();
create trigger calibration_responses_v4_before_insert before insert on public.calibration_responses_v4
  for each row execute function private.calibration_v4_before_insert();
create trigger frozen_predictions_v4_before_insert before insert on public.frozen_predictions_v4
  for each row execute function private.frozen_predictions_v4_before_insert();
create trigger assignments_v4_gate before insert on public.assignments
  for each row execute function private.assignments_v4_gate();
create trigger ontology_versions_v4_guard before insert on public.ontology_versions
  for each row execute function private.ontology_versions_v4_guard();
create trigger case_versions_v4_guard before insert on public.case_versions
  for each row execute function private.case_versions_v4_guard();
create trigger adjudications_v4_guard before insert on public.adjudications
  for each row execute function private.adjudications_v4_guard();
create trigger mb_units_v4_before_insert before insert on public.mb_units_v4
  for each row execute function private.mb_units_v4_before_insert();
create trigger mb_unit_design_v4_before_insert before insert on public.mb_unit_design_v4
  for each row execute function private.mb_units_v4_before_insert();
create trigger mb_assignments_v4_before_insert before insert on public.mb_assignments_v4
  for each row execute function private.mb_assignments_v4_before_insert();
create trigger mb_responses_v4_before_insert before insert on public.mb_responses_v4
  for each row execute function private.mb_responses_v4_before_insert();
create trigger mb_adjudications_v4_before_insert before insert on public.mb_adjudications_v4
  for each row execute function private.mb_adjudications_v4_before_insert();

-- -----------------------------------------------------------------------------
-- 9b. Audit log: v4 replaces private.audit_row (body otherwise unchanged from schema.sql).
--     Under v3 the audit log stored trial Step 1 records in full, so an investigator could
--     read FORMAL Step 1 decisions there while the formal phase was open (FINDING-V4-01,
--     SCHEMA_TEST_REPORT_v4.md). Step 1 records and Module B responses are now logged as
--     identifiers and a SHA-256 of the row, as schema.sql already does for reviews. The
--     primary-key list gains the v4 identifier columns (placed first; no v2 or v3 table
--     carries them, so v2 and v3 entity IDs are unchanged).
-- -----------------------------------------------------------------------------
create or replace function private.audit_row() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  rec jsonb := to_jsonb(coalesce(new, old));
  pk text;
  details jsonb;
begin
  pk := coalesce(rec ->> 'mb_response_id', rec ->> 'cal_response_id', rec ->> 'prediction_id', rec ->> 'freeze_id',
                 rec ->> 'snapshot_id', rec ->> 'mb_adjudication_id', rec ->> 'mb_assignment_id', rec ->> 'cal_assignment_id',
                 rec ->> 'mb_lock_id', rec ->> 'mb_manifest_id', rec ->> 'activation_id', rec ->> 'amendment_id',
                 rec ->> 'dev_case_id', rec ->> 'cal_case_id', rec ->> 'mb_unit_id',
                 rec ->> 'review_id', rec ->> 'adjudication_id', rec ->> 'assignment_id', rec ->> 'case_version_id',
                 rec ->> 'ai_record_id', rec ->> 'export_id', rec ->> 'event_id', rec ->> 'reviewer_pseudo_id',
                 rec ->> 'case_id', rec ->> 'user_id', rec ->> 'version_set_id', rec ->> 'setting_key',
                 rec ->> 'primary_stratum');
  if tg_table_name = 'reviews' then
    details := jsonb_build_object('case_id', rec ->> 'case_id', 'reviewer_pseudo_id', rec ->> 'reviewer_pseudo_id',
                                  'revision_number', rec ->> 'revision_number', 'content_sha256', rec ->> 'content_sha256');
  elsif tg_table_name = 'review_drafts' then
    details := jsonb_build_object('reviewer_pseudo_id', rec ->> 'reviewer_pseudo_id', 'save_count', rec ->> 'save_count');
  elsif tg_table_name = 'users' then
    details := jsonb_build_object('role', rec ->> 'role', 'is_active', rec ->> 'is_active',
                                  'is_pilot_test_account', rec ->> 'is_pilot_test_account');
  elsif tg_table_name = 'case_versions' then
    details := jsonb_build_object('case_id', rec ->> 'case_id', 'version', rec ->> 'version',
                                  'packet_sha256', rec ->> 'packet_sha256', 'change_reason', rec ->> 'change_reason');
  elsif tg_table_name = 'trial_step1_records' then
    -- v4: answers recorded during a blinded phase are logged as identifiers and a hash only
    details := jsonb_build_object('case_id', rec ->> 'case_id', 'assignment_id', rec ->> 'assignment_id',
                                  'reviewer_pseudo_id', rec ->> 'reviewer_pseudo_id', 'content_sha256', private.sha256_hex(rec::text));
  elsif tg_table_name = 'mb_responses_v4' then
    details := jsonb_build_object('mb_unit_id', rec ->> 'mb_unit_id', 'mb_assignment_id', rec ->> 'mb_assignment_id',
                                  'reviewer_pseudo_id', rec ->> 'reviewer_pseudo_id', 'revision_number', rec ->> 'revision_number',
                                  'content_sha256', private.sha256_hex(rec::text));
  else
    details := rec;
  end if;
  insert into public.audit_log (actor_user_id, actor_role, action, entity_table, entity_id, mode, details)
  values (private.app_user_id(), coalesce(private.app_role(), current_user), tg_op, tg_table_name, pk,
          rec ->> 'mode', details);
  return null;
end $$;

-- Append-only, audit and RLS for every new table.
do $$
declare
  t text;
begin
  foreach t in array array['design_activation_v4', 'protocol_amendments_v4', 'development_registry_v4', 'case_records_v4',
                           'calibration_cases_v4', 'calibration_assignments_v4', 'calibration_responses_v4',
                           'frozen_predictions_v4', 'freeze_manifests_v4', 'judgment_snapshots_v4',
                           'mb_units_v4', 'mb_unit_design_v4', 'mb_manifest_v4', 'mb_phase_events_v4', 'mb_assignments_v4',
                           'mb_responses_v4', 'mb_adjudications_v4', 'mb_reference_lock_v4']
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
-- 10. Row-level security (reads only; every write goes through rpc_*)
-- -----------------------------------------------------------------------------
create policy design_activation_v4_inv on public.design_activation_v4 for select to authenticated using (private.is_investigator());
create policy protocol_amendments_v4_inv on public.protocol_amendments_v4 for select to authenticated using (private.is_investigator());
create policy development_registry_v4_inv on public.development_registry_v4 for select to authenticated using (private.is_investigator());
create policy case_records_v4_inv on public.case_records_v4 for select to authenticated using (private.is_investigator());
create policy frozen_predictions_v4_inv on public.frozen_predictions_v4 for select to authenticated using (private.is_investigator());
create policy freeze_manifests_v4_inv on public.freeze_manifests_v4 for select to authenticated using (private.is_investigator());
create policy judgment_snapshots_v4_inv on public.judgment_snapshots_v4 for select to authenticated using (private.is_investigator());
-- calibration: a reviewer reads their own calibration records until the freeze (the calibration window)
create policy calibration_cases_v4_read on public.calibration_cases_v4 for select to authenticated
  using (private.is_investigator() or (private.cal_is_assigned(cal_case_id) and not private.v4_frozen()));
create policy calibration_assignments_v4_read on public.calibration_assignments_v4 for select to authenticated
  using (private.is_investigator() or (reviewer_pseudo_id = private.my_reviewer_pseudo_id() and not private.v4_frozen()));
create policy calibration_responses_v4_read on public.calibration_responses_v4 for select to authenticated
  using (private.is_investigator() or (reviewer_pseudo_id = private.my_reviewer_pseudo_id() and not private.v4_frozen()));
create policy mb_units_v4_read on public.mb_units_v4 for select to authenticated
  using (private.is_investigator() or private.mb_is_assigned(mb_unit_id)
         or (private.is_adjudicator() and private.mb_phase() = 'MB_CLOSED'));
create policy mb_unit_design_v4_inv on public.mb_unit_design_v4 for select to authenticated using (private.is_investigator());
create policy mb_manifest_v4_inv on public.mb_manifest_v4 for select to authenticated using (private.is_investigator());
create policy mb_phase_events_v4_read on public.mb_phase_events_v4 for select to authenticated
  using (private.is_investigator() or private.is_adjudicator());
create policy mb_assignments_v4_read on public.mb_assignments_v4 for select to authenticated
  using (private.is_investigator() or reviewer_pseudo_id = private.my_reviewer_pseudo_id()
         or (private.is_adjudicator() and private.mb_phase() = 'MB_CLOSED'));
create policy mb_responses_v4_read on public.mb_responses_v4 for select to authenticated
  using (reviewer_pseudo_id = private.my_reviewer_pseudo_id()
         or ((private.is_investigator() or private.is_adjudicator()) and private.mb_phase() = 'MB_CLOSED'));
create policy mb_adjudications_v4_read on public.mb_adjudications_v4 for select to authenticated
  using (private.is_investigator() or (private.is_adjudicator() and decided_by = private.app_user_id()));
create policy mb_reference_lock_v4_read on public.mb_reference_lock_v4 for select to authenticated
  using (private.is_investigator() or private.is_adjudicator());

-- -----------------------------------------------------------------------------
-- 11. RPCs
-- -----------------------------------------------------------------------------
create function public.rpc_activate_design_v4(p_design_version text, p_adjudication_scope text, p_attestation text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  me uuid := private.assert_investigator();
  aid uuid;
begin
  if private.v4_active() then
    raise exception 'design v4 is already active';
  end if;
  if exists (select 1 from public.cases c where c.mode = 'FORMAL' and c.withdrawn_at is null and c.case_id !~ '^HO4R?-') then
    raise exception 'active FORMAL cases without a held-out ID exist; withdraw them before activating design v4';
  end if;
  insert into public.design_activation_v4 (design_version, adjudication_scope, attestation, activated_by)
  values (p_design_version, p_adjudication_scope, p_attestation, me) returning activation_id into aid;
  return aid;
end $$;

create function public.rpc_register_amendment_v4(p jsonb) returns text
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := private.assert_investigator();
begin
  insert into public.protocol_amendments_v4 (amendment_id, purpose, description, approved_by)
  values (p ->> 'amendment_id', p ->> 'purpose', p ->> 'description', me);
  return p ->> 'amendment_id';
end $$;

create function public.rpc_register_development_units_v4(p jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := private.assert_investigator();
  n integer;
begin
  insert into public.development_registry_v4 (dev_case_id, frame_unit_id, unit_type, primary_exclusion_reason, exclusion_reasons, registered_by)
  select x ->> 'dev_case_id', x ->> 'frame_unit_id', x ->> 'unit_type', x ->> 'primary_exclusion_reason',
         coalesce(x ->> 'exclusion_reasons', x ->> 'primary_exclusion_reason'), me
  from jsonb_array_elements(p) x;
  get diagnostics n = row_count;
  return n;
end $$;

create function public.rpc_record_heldout_case_v4(p jsonb) returns text
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := private.assert_investigator();
begin
  insert into public.case_records_v4 (case_id, mode, record_category, frame_unit_id, provenance_audit_result, impact_tier,
    policy_governed_neoplasm_gen06, amendment_id, design_row_sha256, recorded_by)
  values (p ->> 'case_id', 'FORMAL', p ->> 'record_category', p ->> 'frame_unit_id', p ->> 'provenance_audit_result',
    coalesce(p ->> 'impact_tier', 'STANDARD'), coalesce((p ->> 'policy_governed_neoplasm_gen06')::boolean, false),
    p ->> 'amendment_id', private.sha256_hex(p::text), me);
  return p ->> 'case_id';
end $$;

create function public.rpc_import_frozen_predictions_v4(p jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := private.assert_investigator();
  n integer;
begin
  insert into public.frozen_predictions_v4 (prediction_set_id, case_id, determination_level, tier0_binary, tier1_version,
    tier1_status_raw, tier1_binary, stage_c_trial_status, row_sha256, imported_by)
  select x ->> 'prediction_set_id', x ->> 'case_id', x ->> 'determination_level', x ->> 'tier0_binary', x ->> 'tier1_version',
         x ->> 'tier1_status_raw', x ->> 'tier1_binary', nullif(x ->> 'stage_c_trial_status', ''), repeat('0', 64), me
  from jsonb_array_elements(p) x;
  get diagnostics n = row_count;
  return n;
end $$;

-- The single freeze event. The case-list hash uses the method of
-- performance_analysis_v4.case_list_sha256 (case IDs sorted in code-point order, joined by line feeds).
create function public.rpc_freeze_v4(p jsonb) returns uuid
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

-- Recompute the prediction-row hash and compare it with the value recorded at the freeze.
create function public.rpc_verify_frozen_predictions_v4()
returns table (matches boolean, frozen_sha256 text, current_sha256 text)
language plpgsql security definer set search_path = '' as $$
begin
  perform private.assert_investigator();
  return query select f.prediction_rows_sha256 = private.prediction_rows_sha256_v4(), f.prediction_rows_sha256,
                      private.prediction_rows_sha256_v4()
               from public.freeze_manifests_v4 f;
end $$;

create function public.rpc_import_calibration_case_v4(p jsonb) returns text
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := private.assert_investigator();
begin
  insert into public.calibration_cases_v4 (cal_case_id, source_dev_case_id, unit_type, packet, packet_sha256, created_by)
  values (p ->> 'cal_case_id', p ->> 'source_dev_case_id', p ->> 'unit_type', p -> 'packet', repeat('0', 64), me);
  return p ->> 'cal_case_id';
end $$;

create function public.rpc_assign_calibration_v4(p_cal_case_id text, p_reviewer_pseudo_id text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := private.assert_investigator();
  aid uuid;
begin
  insert into public.calibration_assignments_v4 (cal_case_id, reviewer_pseudo_id, assigned_by)
  values (p_cal_case_id, p_reviewer_pseudo_id, me) returning cal_assignment_id into aid;
  return aid;
end $$;

create function public.rpc_submit_calibration_v4(p_cal_assignment_id uuid, p jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  me text := private.my_reviewer_pseudo_id();
  a record;
  rid uuid;
begin
  select * into a from public.calibration_assignments_v4 where cal_assignment_id = p_cal_assignment_id;
  if me is null or a.reviewer_pseudo_id is distinct from me then
    raise exception 'not your calibration assignment' using errcode = '42501';
  end if;
  insert into public.calibration_responses_v4 (cal_assignment_id, reviewer_pseudo_id, decision, rationale, uncertain)
  values (p_cal_assignment_id, me, p ->> 'decision', p ->> 'rationale', coalesce((p ->> 'uncertain')::boolean, false))
  returning cal_response_id into rid;
  return rid;
end $$;

-- v4 reference lock for Module A: the adjudications the scope requires must exist.
create function public.rpc_lock_reference_v4(p_attestation text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := private.assert_investigator();
  n_missing integer;
  n_levels integer;
  lid uuid;
begin
  if not private.v4_frozen() then
    raise exception 'no v4 freeze';
  end if;
  if private.formal_phase_status() not in ('COMPLETE', 'CLOSED_INCOMPLETE') then
    raise exception 'the reference is locked only after the formal phase is closed';
  end if;
  if not exists (select 1 from public.judgment_snapshots_v4) then
    raise exception 'no independent-judgment snapshot';
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
         count(*) filter (where lv.n_ans >= 1)
  into n_missing, n_levels from lv;
  if n_missing > 0 then
    raise exception '% case levels that the adjudication scope requires have no adjudication; the reference cannot be locked', n_missing;
  end if;
  insert into public.reference_locks (review_module, n_case_levels_locked, attestation, locked_by)
  values ('ONTOLOGY_AREA', n_levels, p_attestation, me) returning lock_id into lid;
  return lid;
end $$;

-- v3 lock with a v4 guard (body otherwise unchanged from 0002).
create or replace function public.rpc_lock_reference(p_review_module text, p_attestation text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := private.assert_investigator();
  n_missing integer;
  n_levels integer;
  lid uuid;
begin
  if private.v4_active() and p_review_module = 'ONTOLOGY_AREA' then
    raise exception 'design v4 is active: lock the Module A reference with rpc_lock_reference_v4';
  end if;
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

-- Module B RPCs
create function public.rpc_import_mb_unit_v4(p jsonb) returns text
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := private.assert_investigator();
  d jsonb := p -> 'design';
begin
  insert into public.mb_units_v4 (mb_unit_id, unit_type, packet, packet_sha256, created_by)
  values (p ->> 'mb_unit_id', p ->> 'unit_type', p -> 'packet', repeat('0', 64), me);
  insert into public.mb_unit_design_v4 (mb_unit_id, row_id, stratum, frame_n, selection_probability, pipeline_status_provisional,
    nct_id, benchmark_id, design_row_sha256, imported_by)
  values (p ->> 'mb_unit_id', d ->> 'row_id', d ->> 'stratum', (d ->> 'frame_n')::integer, (d ->> 'selection_probability')::numeric,
    d ->> 'pipeline_status_provisional', d ->> 'nct_id', d ->> 'benchmark_id', private.sha256_hex(d::text), me);
  return p ->> 'mb_unit_id';
end $$;

create function public.rpc_freeze_mb_manifest_v4(p_attestation text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := private.assert_investigator();
  n integer;
  lst text;
  mid uuid;
begin
  select count(*), string_agg(u.mb_unit_id, E'\n' order by u.mb_unit_id collate "C") into n, lst from public.mb_units_v4 u;
  if n = 0 then
    raise exception 'no Module B units';
  end if;
  insert into public.mb_manifest_v4 (n_units, unit_list_sha256, attestation, frozen_by)
  values (n, private.sha256_hex(lst), p_attestation, me) returning mb_manifest_id into mid;
  return mid;
end $$;

create function public.rpc_mb_phase_v4(p_event_type text, p_attestation text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := private.assert_investigator();
  st text := private.mb_phase();
  eid uuid;
begin
  if p_event_type = 'MB_OPENED' and (st <> 'NOT_OPENED' or not exists (select 1 from public.mb_manifest_v4)) then
    raise exception 'Module B opens once, after its sample is frozen (status %)', st;
  end if;
  if p_event_type = 'MB_CLOSED' and st <> 'MB_OPENED' then
    raise exception 'Module B is not open (status %)', st;
  end if;
  insert into public.mb_phase_events_v4 (event_type, attestation, actor) values (p_event_type, p_attestation, me)
  returning event_id into eid;
  return eid;
end $$;

create function public.rpc_assign_mb_units_v4(p_reviewer_pseudo_id text, p_slot integer, p_unit_ids text[], p_seed bigint) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := private.assert_investigator();
  start_pos integer;
  n integer;
begin
  select coalesce(max(queue_position), 0) into start_pos from public.mb_assignments_v4 where reviewer_pseudo_id = p_reviewer_pseudo_id;
  insert into public.mb_assignments_v4 (mb_unit_id, reviewer_pseudo_id, reviewer_slot, queue_position, assigned_by)
  select x.u, p_reviewer_pseudo_id, p_slot::smallint,
         start_pos + row_number() over (order by md5(p_seed::text || ':' || p_reviewer_pseudo_id || ':' || x.u)), me
  from unnest(p_unit_ids) as x(u);
  get diagnostics n = row_count;
  return n;
end $$;

create function public.rpc_submit_mb_response_v4(p_mb_assignment_id uuid, p jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  me text := private.my_reviewer_pseudo_id();
  a record;
  rid uuid;
begin
  select * into a from public.mb_assignments_v4 where mb_assignment_id = p_mb_assignment_id;
  if me is null or a.reviewer_pseudo_id is distinct from me then
    raise exception 'not your Module B assignment' using errcode = '42501';
  end if;
  insert into public.mb_responses_v4 (mb_assignment_id, mb_unit_id, reviewer_pseudo_id, revision_number, compatibility, caveat_codes,
    eligibility, exclusion_reason, rationale, uncertain, packet_issue_flag, packet_issue_note)
  values (p_mb_assignment_id, a.mb_unit_id, me, 1, p ->> 'compatibility',
    (select array_agg(x) from jsonb_array_elements_text(coalesce(p -> 'caveat_codes', '[]'::jsonb)) x),
    p ->> 'eligibility', p ->> 'exclusion_reason', p ->> 'rationale', coalesce((p ->> 'uncertain')::boolean, false),
    coalesce((p ->> 'packet_issue_flag')::boolean, false), p ->> 'packet_issue_note')
  returning mb_response_id into rid;
  return rid;
end $$;

create function public.rpc_record_mb_adjudication_v4(p jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := private.app_user_id();
  jid uuid;
begin
  if not (private.is_investigator() or private.is_adjudicator()) then
    raise exception 'investigator (multi-factor session) or ADJUDICATOR role is needed to adjudicate' using errcode = '42501';
  end if;
  insert into public.mb_adjudications_v4 (mb_unit_id, decision, status, basis, rationale, decided_by)
  values (p ->> 'mb_unit_id', p ->> 'decision', p ->> 'status', p ->> 'basis', p ->> 'rationale', me)
  returning mb_adjudication_id into jid;
  return jid;
end $$;

create function public.rpc_lock_mb_reference_v4(p_attestation text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := private.assert_investigator();
  n_missing integer;
  n_units integer;
  lid uuid;
begin
  if private.mb_phase() <> 'MB_CLOSED' then
    raise exception 'the Module B reference is locked only after Module B closes';
  end if;
  with eff as (
    select distinct on (r.mb_assignment_id) r.mb_unit_id, coalesce(r.compatibility, r.eligibility) as ans
    from public.mb_responses_v4 r order by r.mb_assignment_id, r.revision_number desc
  ), u as (
    select e.mb_unit_id, count(*) as n_ans, count(distinct e.ans) as n_dist from eff e group by e.mb_unit_id
  )
  select count(*) filter (where (u.n_ans = 1 or u.n_dist > 1)
                            and not exists (select 1 from public.mb_adjudications_v4 j where j.mb_unit_id = u.mb_unit_id)),
         count(*)
  into n_missing, n_units from u;
  if n_missing > 0 then
    raise exception '% Module B units that need adjudication have none', n_missing;
  end if;
  insert into public.mb_reference_lock_v4 (n_units, attestation, locked_by) values (n_units, p_attestation, me)
  returning mb_lock_id into lid;
  return lid;
end $$;

-- -----------------------------------------------------------------------------
-- 12. Export views (investigator only; held-out records only)
-- -----------------------------------------------------------------------------

-- Independent judgments: one row per held-out case x determination level x reviewer, after the close.
create view public.v_independent_judgments_v4 with (security_invoker = true) as
with hc as (
  select r.case_id, r.record_category,
         (select max(cv.version) from public.case_versions cv where cv.case_id = r.case_id) as case_version,
         'ONTOLOGY_AREA'::text as review_module,
         c.unit_type, cd.unit_id, cd.nct_id, cd.descriptor_ui, cd.descriptor_name, cd.area
  from public.case_records_v4 r
  join public.cases c on c.case_id = r.case_id and c.withdrawn_at is null
  join public.case_design cd on cd.case_id = r.case_id
), rv as (
  select r.case_id, a.reviewer_slot, r.reviewer_pseudo_id,
         case when coalesce(d.two_step_required, false) then 'TRIAL_LEVEL' else 'DESCRIPTOR_LEVEL' end as determination_level,
         r.revision_number, r.l1_decision, r.l1_uncertain, r.packet_issue_flag, r.submitted_at
  from public.reviews r
  join public.assignments a on a.assignment_id = r.assignment_id and a.withdrawn_at is null
  left join public.case_design_v3 d on d.case_id = r.case_id
  where r.mode = 'FORMAL' and r.case_version_id = private.latest_case_version_id(r.case_id)
), rv_agg as (
  select rv.case_id, rv.determination_level, rv.reviewer_slot, rv.reviewer_pseudo_id,
         (array_agg(rv.l1_decision order by rv.revision_number))[1] as decision_initial,
         (array_agg(rv.l1_decision order by rv.revision_number desc))[1] as decision_effective_preclose,
         count(*) - 1 as n_revisions_preclose,
         (array_agg(rv.l1_uncertain order by rv.revision_number desc))[1] as uncertain,
         bool_or(rv.packet_issue_flag) as packet_issue_flag,
         min(rv.submitted_at) as first_submitted_at, max(rv.submitted_at) as last_submitted_at
  from rv group by rv.case_id, rv.determination_level, rv.reviewer_slot, rv.reviewer_pseudo_id
), s1 as (
  select s.case_id, 'DESCRIPTOR_LEVEL_IN_TRIAL_CASE'::text as determination_level, a.reviewer_slot, s.reviewer_pseudo_id,
         s.step1_decision as decision_initial, s.step1_decision as decision_effective_preclose, 0::bigint as n_revisions_preclose,
         s.step1_uncertain as uncertain, false as packet_issue_flag, s.recorded_at as first_submitted_at, s.recorded_at as last_submitted_at
  from public.trial_step1_records s
  join public.assignments a on a.assignment_id = s.assignment_id and a.withdrawn_at is null
  where s.mode = 'FORMAL' and s.case_version_id = private.latest_case_version_id(s.case_id)
), j as (
  select * from rv_agg union all select * from s1
)
select hc.record_category, hc.case_id, hc.case_version, hc.review_module, hc.unit_type, hc.unit_id, hc.nct_id,
       hc.descriptor_ui, hc.descriptor_name, hc.area, j.determination_level, j.reviewer_slot, j.reviewer_pseudo_id, j.decision_initial, j.decision_effective_preclose,
       j.n_revisions_preclose, j.uncertain, j.packet_issue_flag, j.first_submitted_at, j.last_submitted_at
from hc join j on j.case_id = hc.case_id
where private.is_investigator() and private.formal_phase_status() in ('COMPLETE', 'CLOSED_INCOMPLETE');

-- Canonical text of the independent judgments (timestamps in UTC, ISO 8601), used by the
-- snapshot and by its verification.
create function private.judgments_text_v4(out n integer, out txt text)
language sql stable security definer set search_path = '' as $$
  select count(*)::integer,
         string_agg(concat_ws('|', v.case_id, v.determination_level, v.reviewer_slot::text, v.reviewer_pseudo_id,
                              v.decision_initial, v.decision_effective_preclose, v.n_revisions_preclose::text, v.uncertain::text,
                              to_char(v.first_submitted_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
                              to_char(v.last_submitted_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')),
                    E'\n' order by v.case_id collate "C", v.determination_level collate "C", v.reviewer_slot)
  from public.v_independent_judgments_v4 v
$$;

-- Snapshot of the independent judgments: after the close, before any FORMAL adjudication.
create function public.rpc_snapshot_judgments_v4() returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := private.assert_investigator();
  n integer;
  txt text;
  sid uuid;
begin
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

-- Recompute the independent-judgment hash and compare it with the snapshot (the export writer
-- calls this and refuses to write a bundle when it fails).
create function public.rpc_verify_judgment_snapshot_v4()
returns table (matches boolean, snapshot_sha256 text, current_sha256 text, snapshot_rows integer, current_rows integer)
language plpgsql security definer set search_path = '' as $$
declare
  cur_n integer;
  cur_txt text;
begin
  perform private.assert_investigator();
  select t.n, t.txt into cur_n, cur_txt from private.judgments_text_v4() t;
  return query select s.content_sha256 = private.sha256_hex(coalesce(cur_txt, '')) and s.n_rows = cur_n,
                      s.content_sha256, private.sha256_hex(coalesce(cur_txt, '')), s.n_rows, cur_n
               from public.judgment_snapshots_v4 s;
end $$;

-- Adjudicated reference: one row per held-out case level, after the reference lock. Concordant
-- case levels without an adjudication enter by rule under the DISAGREEMENTS_ONLY scope.
create view public.v_adjudicated_reference_v4 with (security_invoker = true) as
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
  select distinct on (j.case_id, j.determination_level) j.*
  from public.adjudications j
  where j.layer = 'clinical_classification' and not j.post_unblinding and j.mode = 'FORMAL'
  order by j.case_id, j.determination_level, j.decided_at desc
)
select lv.case_id, lv.record_category, lv.determination_level,
       case when ref.adjudication_id is not null then 'ADJ4-' || replace(ref.adjudication_id::text, '-', '')
            else 'RULE-' || lv.case_id || '-' || lv.determination_level end as adjudication_id,
       coalesce(ref.adjudicated_decision, case when ans.n_ans = 2 and ans.n_dist = 1 then ans.shared end) as adjudicated_decision,
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

-- Frozen predictions with the sampling design, after the reference lock.
create view public.v_frozen_predictions_v4 with (security_invoker = true) as
select f.prediction_set_id, r.record_category, f.case_id, r.frame_unit_id, c.unit_type, cd.unit_id, cd.nct_id, cd.descriptor_ui,
       cd.area, f.determination_level, f.tier0_binary, f.tier1_version, f.tier1_status_raw, f.tier1_binary, f.stage_c_trial_status,
       f.imported_at as prediction_frozen_at, d3.selection_stratum, d3.variance_stratum, d3.variance_stratum_size,
       d3.selection_probability, d3.sampling_weight, d3.comparison_cell_v11 as comparison_cell, r.impact_tier,
       r.policy_governed_neoplasm_gen06 as "policy_governed_neoplasm_GEN06", r.provenance_audit_result
from public.frozen_predictions_v4 f
join public.case_records_v4 r on r.case_id = f.case_id
join public.cases c on c.case_id = f.case_id and c.withdrawn_at is null
join public.case_design cd on cd.case_id = f.case_id
join public.case_design_v3 d3 on d3.case_id = f.case_id
where private.is_investigator() and private.reference_locked('ONTOLOGY_AREA');

-- Module B export: one row per unit, after the Module B lock.
create view public.v_module_b_export_v4 with (security_invoker = true) as
with eff as (
  select distinct on (r.mb_assignment_id) r.mb_unit_id, a.reviewer_slot, r.reviewer_pseudo_id,
         coalesce(r.compatibility, r.eligibility) as answer, r.caveat_codes, r.exclusion_reason, r.uncertain
  from public.mb_responses_v4 r join public.mb_assignments_v4 a on a.mb_assignment_id = r.mb_assignment_id
  order by r.mb_assignment_id, r.revision_number desc
)
select u.mb_unit_id, u.unit_type, d.row_id, d.stratum, d.frame_n, d.selection_probability, d.sampling_weight,
       e1.reviewer_pseudo_id as reviewer_1_pseudo_id, e1.answer as reviewer_1_answer,
       e2.reviewer_pseudo_id as reviewer_2_pseudo_id, e2.answer as reviewer_2_answer,
       coalesce(j.decision, case when e1.answer is not null and e1.answer = e2.answer then e1.answer end) as reference_answer,
       coalesce(j.status, case when e1.answer is not null and e1.answer = e2.answer then 'CONCORDANT_ADOPTED_BY_RULE' end) as reference_status,
       j.adjudicator_role, j.adjudicator_exposed_to_pipeline_status
from public.mb_units_v4 u
join public.mb_unit_design_v4 d on d.mb_unit_id = u.mb_unit_id
left join eff e1 on e1.mb_unit_id = u.mb_unit_id and e1.reviewer_slot = 1
left join eff e2 on e2.mb_unit_id = u.mb_unit_id and e2.reviewer_slot = 2
left join public.mb_adjudications_v4 j on j.mb_unit_id = u.mb_unit_id
where private.is_investigator() and exists (select 1 from public.mb_reference_lock_v4);

-- -----------------------------------------------------------------------------
-- 13. Grants (same pattern as v2 and v3: reads filtered by RLS, writes only through rpc_*)
-- -----------------------------------------------------------------------------
revoke all on public.design_activation_v4, public.protocol_amendments_v4, public.development_registry_v4, public.case_records_v4,
              public.calibration_cases_v4, public.calibration_assignments_v4, public.calibration_responses_v4,
              public.frozen_predictions_v4, public.freeze_manifests_v4, public.judgment_snapshots_v4,
              public.mb_units_v4, public.mb_unit_design_v4, public.mb_manifest_v4, public.mb_phase_events_v4,
              public.mb_assignments_v4, public.mb_responses_v4, public.mb_adjudications_v4, public.mb_reference_lock_v4,
              public.v_independent_judgments_v4, public.v_adjudicated_reference_v4, public.v_frozen_predictions_v4,
              public.v_module_b_export_v4
  from anon, authenticated;
grant select on public.design_activation_v4, public.protocol_amendments_v4, public.development_registry_v4, public.case_records_v4,
                public.calibration_cases_v4, public.calibration_assignments_v4, public.calibration_responses_v4,
                public.frozen_predictions_v4, public.freeze_manifests_v4, public.judgment_snapshots_v4,
                public.mb_units_v4, public.mb_unit_design_v4, public.mb_manifest_v4, public.mb_phase_events_v4,
                public.mb_assignments_v4, public.mb_responses_v4, public.mb_adjudications_v4, public.mb_reference_lock_v4,
                public.v_independent_judgments_v4, public.v_adjudicated_reference_v4, public.v_frozen_predictions_v4,
                public.v_module_b_export_v4
  to authenticated;
revoke all on function private.v4_active(), private.v4_frozen(), private.v4_scope(), private.mb_phase(), private.mb_is_assigned(text),
                       private.cal_is_assigned(text), private.case_level_answers_v4(text, text), private.case_levels_v4(text),
                       private.assert_mb_packet_blinded(jsonb),
                       private.prediction_row_text_v4(text, text, text, text, text, text, text, text),
                       private.prediction_rows_sha256_v4(), private.cases_v4_gate(), private.case_design_v3_v4_guard(),
                       private.development_registry_v4_before_insert(), private.protocol_amendments_v4_before_insert(),
                       private.case_records_v4_before_insert(), private.calibration_v4_before_insert(),
                       private.frozen_predictions_v4_before_insert(), private.assignments_v4_gate(),
                       private.ontology_versions_v4_guard(), private.case_versions_v4_guard(), private.adjudications_v4_guard(),
                       private.mb_units_v4_before_insert(), private.mb_assignments_v4_before_insert(),
                       private.mb_responses_v4_before_insert(), private.mb_adjudications_v4_before_insert(),
                       private.judgments_text_v4(), private.cases_v4_no_withdraw_after_freeze(),
                       private.review_phase_events_v4_guard()
  from public, anon, authenticated;
-- helpers called inside RLS policies and security_invoker views
grant execute on function private.mb_phase(), private.mb_is_assigned(text), private.cal_is_assigned(text),
                          private.case_level_answers_v4(text, text), private.case_levels_v4(text), private.v4_frozen()
  to authenticated;
revoke all on function public.rpc_activate_design_v4(text, text, text), public.rpc_register_amendment_v4(jsonb),
                       public.rpc_register_development_units_v4(jsonb), public.rpc_record_heldout_case_v4(jsonb),
                       public.rpc_import_frozen_predictions_v4(jsonb), public.rpc_freeze_v4(jsonb),
                       public.rpc_verify_frozen_predictions_v4(), public.rpc_import_calibration_case_v4(jsonb),
                       public.rpc_assign_calibration_v4(text, text), public.rpc_submit_calibration_v4(uuid, jsonb),
                       public.rpc_snapshot_judgments_v4(), public.rpc_verify_judgment_snapshot_v4(), public.rpc_lock_reference_v4(text),
                       public.rpc_import_mb_unit_v4(jsonb), public.rpc_freeze_mb_manifest_v4(text), public.rpc_mb_phase_v4(text, text),
                       public.rpc_assign_mb_units_v4(text, integer, text[], bigint), public.rpc_submit_mb_response_v4(uuid, jsonb),
                       public.rpc_record_mb_adjudication_v4(jsonb), public.rpc_lock_mb_reference_v4(text)
  from public, anon;
grant execute on function public.rpc_activate_design_v4(text, text, text), public.rpc_register_amendment_v4(jsonb),
                          public.rpc_register_development_units_v4(jsonb), public.rpc_record_heldout_case_v4(jsonb),
                          public.rpc_import_frozen_predictions_v4(jsonb), public.rpc_freeze_v4(jsonb),
                          public.rpc_verify_frozen_predictions_v4(), public.rpc_import_calibration_case_v4(jsonb),
                          public.rpc_assign_calibration_v4(text, text), public.rpc_submit_calibration_v4(uuid, jsonb),
                          public.rpc_snapshot_judgments_v4(), public.rpc_verify_judgment_snapshot_v4(), public.rpc_lock_reference_v4(text),
                          public.rpc_import_mb_unit_v4(jsonb), public.rpc_freeze_mb_manifest_v4(text), public.rpc_mb_phase_v4(text, text),
                          public.rpc_assign_mb_units_v4(text, integer, text[], bigint), public.rpc_submit_mb_response_v4(uuid, jsonb),
                          public.rpc_record_mb_adjudication_v4(jsonb), public.rpc_lock_mb_reference_v4(text)
  to authenticated;

commit;
