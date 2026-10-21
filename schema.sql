-- =============================================================================
-- schema.sql: clinical review application database
-- Schema version 1.0.0
--
-- Target: PostgreSQL 15 or later, written for Supabase (Postgres + Auth + RLS).
-- Apply once, as the database owner, as the first migration
-- (supabase/migrations/0001_clinical_review_schema.sql in the app repository).
--
-- Assumes the Supabase `auth` schema (auth.uid(), auth.jwt()) and the roles
-- `anon`, `authenticated` and `service_role`. To test on plain PostgreSQL,
-- apply supabase_test_shim/auth_shim.sql first.
--
-- Design rules enforced here, in the database, not in the user interface:
--   1. PILOT and FORMAL data never mix. Every case-derived row carries `mode`
--      and a generated `is_pilot` flag; composite foreign keys force a child
--      row to have its case's mode. PILOT case IDs start with 'SYN-' and no
--      FORMAL case ID may.
--   2. FORMAL work is locked until the investigator records the pilot sign-off
--      (review_phase_events FORMAL_UNLOCKED), which requires a completed pilot.
--   3. Reviewers are blinded by row-level security: a reviewer can read only
--      the cases assigned to them, their own drafts and their own reviews.
--      AI classifications, sampling strata and adjudications are
--      investigator-only. Packets are checked for blinded keys on import.
--   4. The investigator cannot read FORMAL review decisions until the FORMAL
--      phase is closed (no interim agreement looks). Completion counts are
--      available through rpc_completion_summary(), which returns no decisions.
--   5. Reviews, adjudications, case versions, AI records, exports, phase
--      events and the audit log are append-only. Corrections are new rows
--      that reference the row they supersede. UPDATE, DELETE and TRUNCATE are
--      rejected by triggers.
--   6. All writes go through SECURITY DEFINER rpc_* functions that check the
--      caller's role. The `authenticated` role has SELECT only (filtered by
--      RLS) and no direct INSERT, UPDATE or DELETE on any table.
--   7. Three-state rule for every layer of every review: a decision code is
--      recorded; INSUFFICIENT_INFORMATION is recorded explicitly; or the layer
--      is not applicable to the case (NULL). States 2 and 3 never collapse.
--
-- Code lists mirror validation/review_codes.py (REVIEW_CODES_VERSION 1.1.0).
-- =============================================================================

begin;

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 0. Version and settings
-- -----------------------------------------------------------------------------

create table public.app_schema_version (
  version      text primary key,
  applied_at   timestamptz not null default now(),
  description  text not null
);
insert into public.app_schema_version (version, description)
values ('1.0.0', 'clinical review schema: users, reviewers, cases, assignments, reviews, adjudications, exports, audit log');

create table public.app_settings (
  setting_key    text primary key check (setting_key in ('require_investigator_mfa')),
  setting_value  text not null check (setting_value in ('true', 'false')),
  updated_at     timestamptz not null default now()
);
insert into public.app_settings (setting_key, setting_value) values ('require_investigator_mfa', 'true');

-- -----------------------------------------------------------------------------
-- 1. People
-- -----------------------------------------------------------------------------

-- Identity table. Names and e-mail addresses live only here and are never
-- exported. auth_uid links to Supabase auth.users(id) when the person first
-- signs in (rpc_claim_account).
create table public.users (
  user_id                uuid primary key default gen_random_uuid(),
  auth_uid               uuid unique,
  email                  text not null,
  display_name           text not null check (length(display_name) between 1 and 200),
  role                   text not null check (role in ('INVESTIGATOR', 'REVIEWER')),
  is_pilot_test_account  boolean not null default false,
  is_active              boolean not null default true,
  created_at             timestamptz not null default now(),
  created_by             uuid references public.users (user_id),
  deactivated_at         timestamptz,
  check (email = lower(email) and position('@' in email) > 1),
  check (not (role = 'INVESTIGATOR' and is_pilot_test_account)),
  check (is_active or deactivated_at is not null)
);
create unique index users_email_key on public.users (email);

-- Pseudonymous reviewer identities. Exports carry reviewer_pseudo_id only.
-- PILOT test accounts (operated by the investigator) get PT- IDs and can only
-- ever touch PILOT cases; FORMAL reviewers get R- IDs.
create table public.reviewers (
  reviewer_pseudo_id      text primary key,
  user_id                 uuid not null unique references public.users (user_id),
  mode_scope              text not null check (mode_scope in ('PILOT', 'FORMAL')),
  qualifications_summary  text check (qualifications_summary is null or length(qualifications_summary) <= 1000),
  enrolled_at             timestamptz not null default now(),
  enrolled_by             uuid not null references public.users (user_id),
  withdrawn_at            timestamptz,
  withdrawal_reason       text,
  check ((mode_scope = 'PILOT'  and reviewer_pseudo_id ~ '^PT-[A-Z0-9]{4}$')
      or (mode_scope = 'FORMAL' and reviewer_pseudo_id ~ '^R-[A-Z0-9]{4}$')),
  check ((withdrawn_at is null) = (withdrawal_reason is null))
);

-- -----------------------------------------------------------------------------
-- 2. Frozen versions (ontology, rules, reviewer rubric, schema, protocol)
-- -----------------------------------------------------------------------------

create table public.ontology_versions (
  version_set_id                 text primary key,
  ontology_version               text not null,
  rule_version                   text not null,
  rubric_version                 text not null,
  classification_schema_version  text not null,
  protocol_version               text not null,
  sampling_design_version        text,
  ontology_sha256                text not null check (ontology_sha256 ~ '^[0-9a-f]{64}$'),
  classification_schema_sha256   text not null check (classification_schema_sha256 ~ '^[0-9a-f]{64}$'),
  rubric_sha256                  text not null check (rubric_sha256 ~ '^[0-9a-f]{64}$'),
  frozen_at                      timestamptz not null,
  registered_at                  timestamptz not null default now(),
  registered_by                  uuid not null references public.users (user_id),
  notes                          text,
  check (version_set_id = ontology_version || '+' || rubric_version)
);

-- -----------------------------------------------------------------------------
-- 3. Review phase (pilot sign-off gate and formal close)
-- -----------------------------------------------------------------------------

create table public.review_phase_events (
  event_id                uuid primary key default gen_random_uuid(),
  event_seq               bigint generated always as identity unique,
  event_type              text not null check (event_type in (
                            'FORMAL_UNLOCKED', 'FORMAL_CLOSED_COMPLETE',
                            'FORMAL_CLOSED_INCOMPLETE', 'FORMAL_REOPENED_BY_AMENDMENT')),
  occurred_at             timestamptz not null default now(),
  actor_user_id           uuid not null references public.users (user_id),
  pilot_checklist_version text,
  pilot_checklist_sha256  text check (pilot_checklist_sha256 is null or pilot_checklist_sha256 ~ '^[0-9a-f]{64}$'),
  app_git_sha             text,
  pilot_export_id         uuid,
  amendment_reference     text,
  attestation             text not null check (length(attestation) >= 20),
  check (event_type <> 'FORMAL_UNLOCKED'
         or (pilot_checklist_version is not null and pilot_checklist_sha256 is not null
             and app_git_sha is not null and pilot_export_id is not null)),
  check (event_type <> 'FORMAL_REOPENED_BY_AMENDMENT' or amendment_reference is not null)
);

-- -----------------------------------------------------------------------------
-- 4. Cases
-- -----------------------------------------------------------------------------

create table public.cases (
  case_id         text primary key check (case_id ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{2,80}$'),
  mode            text not null check (mode in ('PILOT', 'FORMAL')),
  is_pilot        boolean generated always as (mode = 'PILOT') stored,
  unit_type       text not null check (unit_type in ('DESCRIPTOR_AREA', 'TRIAL_AREA')),
  created_at      timestamptz not null default now(),
  created_by      uuid not null references public.users (user_id),
  withdrawn_at    timestamptz,
  withdrawn_reason text,
  unique (case_id, mode),
  check ((mode = 'PILOT') = (case_id like 'SYN-%')),
  check ((withdrawn_at is null) = (withdrawn_reason is null))
);

-- Reviewer-visible content only. Anything blinded (AI output, sampling stratum,
-- selection probability, original decisions) lives in case_design or
-- ai_classifications. The import RPC rejects packets with blinded keys.
create table public.case_versions (
  case_version_id  uuid primary key default gen_random_uuid(),
  case_id          text not null,
  mode             text not null,
  is_pilot         boolean generated always as (mode = 'PILOT') stored,
  version          integer not null check (version >= 1),
  version_set_id   text not null references public.ontology_versions (version_set_id),
  l1_applicable    boolean not null,
  l2_applicable    boolean not null,
  l3_applicable    boolean not null,
  packet           jsonb not null check (jsonb_typeof(packet) = 'object'),
  packet_sha256    text not null check (packet_sha256 ~ '^[0-9a-f]{64}$'),
  change_reason    text not null check (length(change_reason) >= 3),
  created_at       timestamptz not null default now(),
  created_by       uuid not null references public.users (user_id),
  foreign key (case_id, mode) references public.cases (case_id, mode),
  unique (case_id, version),
  unique (case_version_id, case_id, mode),
  check (l1_applicable or l2_applicable or l3_applicable),
  check (not l3_applicable or l2_applicable)
);

-- Investigator-only design and provenance fields for each case.
create table public.case_design (
  case_id                  text primary key,
  mode                     text not null,
  is_pilot                 boolean generated always as (mode = 'PILOT') stored,
  unit_id                  text not null,
  descriptor_ui            text,
  descriptor_name          text,
  area                     text check (area in ('oncology', 'cardiovascular', 'mental_health', 'infectious',
                                                'metabolic', 'neurological', 'respiratory')),
  nct_id                   text,
  condition_row            text,
  benchmark_id             text,
  frame_unit_id            text,
  primary_stratum          text not null,
  selection_probability    numeric not null check (selection_probability > 0 and selection_probability <= 1),
  sampling_weight          numeric generated always as (1 / selection_probability) stored,
  frame_stratum_size       integer check (frame_stratum_size >= 1),
  sampling_design_version  text not null,
  sampling_seed            bigint,
  trial_frequency_weight   numeric check (trial_frequency_weight >= 0),
  n_trials_primary         integer check (n_trials_primary >= 0),
  original_l1_decision     text check (original_l1_decision in ('INCLUDE', 'EXCLUDE', 'CONTEXT_DEPENDENT', 'INSUFFICIENT_INFORMATION')),
  original_l2_decision     text check (original_l2_decision in ('COMPATIBLE', 'INCOMPATIBLE', 'CONTEXT_DEPENDENT', 'INSUFFICIENT_INFORMATION')),
  original_l3_decision     text check (original_l3_decision in ('VALID', 'INVALID', 'CONTEXT_DEPENDENT', 'INSUFFICIENT_INFORMATION')),
  investigator_note        text check (investigator_note is null or length(investigator_note) <= 2000),
  source_file              text not null,
  source_row_sha256        text not null check (source_row_sha256 ~ '^[0-9a-f]{64}$'),
  imported_at              timestamptz not null default now(),
  imported_by              uuid not null references public.users (user_id),
  foreign key (case_id, mode) references public.cases (case_id, mode),
  check ((nct_id is null) or nct_id ~ '^(NCT[0-9]{8}|SYN-NCT-?[0-9]{4,8})$')
);

-- Sampling frame totals for weighting (investigator only).
create table public.sampling_strata (
  sampling_design_version      text not null,
  primary_stratum              text not null,
  mode                         text not null check (mode in ('PILOT', 'FORMAL')),
  is_pilot                     boolean generated always as (mode = 'PILOT') stored,
  frame_stratum_size           integer not null check (frame_stratum_size >= 0),
  n_sampled                    integer not null check (n_sampled >= 0),
  selection_probability        numeric check (selection_probability is null or (selection_probability > 0 and selection_probability <= 1)),
  frame_trial_frequency_total  numeric check (frame_trial_frequency_total is null or frame_trial_frequency_total >= 0),
  description                  text,
  imported_at                  timestamptz not null default now(),
  imported_by                  uuid not null references public.users (user_id),
  primary key (sampling_design_version, primary_stratum, mode)
);

-- AI-stage records (Stage A, B, C and the Stage D decision file), investigator
-- only. Raw statuses are kept as produced; ai_status_mapped uses the documented
-- mapping to reviewer codes (validation/review_codes.py), NULL = not compared.
create table public.ai_classifications (
  ai_record_id        uuid primary key default gen_random_uuid(),
  case_id             text,
  mode                text not null check (mode in ('PILOT', 'FORMAL')),
  is_pilot            boolean generated always as (mode = 'PILOT') stored,
  stage               text not null check (stage in ('A', 'B', 'C', 'D')),
  layer               text not null check (layer in ('clinical_classification', 'benchmark_compatibility', 'analytical_ppr_validity')),
  source_record_id    text not null,
  unit_id             text,
  descriptor_ui       text,
  area                text,
  nct_id              text,
  ai_status_raw       text not null,
  ai_status_mapped    text,
  confidence          text check (confidence is null or confidence in ('HIGH', 'MODERATE', 'LOW')),
  rationale           text,
  rule_ids            text[] not null default '{}',
  evidence            jsonb not null default '[]'::jsonb,
  model_id            text,
  prompt_version      text,
  run_id              text,
  ontology_version    text,
  source_file         text not null,
  source_line_number  integer,
  source_line_sha256  text not null check (source_line_sha256 ~ '^[0-9a-f]{64}$'),
  imported_at         timestamptz not null default now(),
  imported_by         uuid not null references public.users (user_id),
  foreign key (case_id, mode) references public.cases (case_id, mode)
);
create unique index ai_classifications_case_layer_stage on public.ai_classifications (case_id, layer, stage)
  where case_id is not null;

-- -----------------------------------------------------------------------------
-- 5. Assignments, drafts, reviews
-- -----------------------------------------------------------------------------

create table public.assignments (
  assignment_id       uuid primary key default gen_random_uuid(),
  case_id             text not null,
  mode                text not null,
  is_pilot            boolean generated always as (mode = 'PILOT') stored,
  reviewer_pseudo_id  text not null references public.reviewers (reviewer_pseudo_id),
  reviewer_slot       smallint not null check (reviewer_slot in (1, 2)),
  queue_position      integer not null check (queue_position >= 1),
  randomization_seed  bigint not null,
  assigned_at         timestamptz not null default now(),
  assigned_by         uuid not null references public.users (user_id),
  withdrawn_at        timestamptz,
  withdrawn_reason    text,
  foreign key (case_id, mode) references public.cases (case_id, mode),
  unique (case_id, reviewer_pseudo_id),
  unique (assignment_id, case_id, mode, reviewer_pseudo_id),
  check ((withdrawn_at is null) = (withdrawn_reason is null))
);
create unique index assignments_active_slot on public.assignments (case_id, reviewer_slot) where withdrawn_at is null;
create unique index assignments_active_queue on public.assignments (reviewer_pseudo_id, queue_position) where withdrawn_at is null;

-- Save-and-resume drafts: mutable, readable only by their owner.
create table public.review_drafts (
  assignment_id       uuid primary key references public.assignments (assignment_id),
  reviewer_pseudo_id  text not null references public.reviewers (reviewer_pseudo_id),
  mode                text not null check (mode in ('PILOT', 'FORMAL')),
  is_pilot            boolean generated always as (mode = 'PILOT') stored,
  draft               jsonb not null default '{}'::jsonb check (jsonb_typeof(draft) = 'object'),
  saved_at            timestamptz not null default now(),
  save_count          integer not null default 1 check (save_count >= 1)
);

-- One row per submission. Append-only. A revision is a new row with
-- revision_number + 1 and supersedes_review_id pointing at the previous row.
create table public.reviews (
  review_id             uuid primary key default gen_random_uuid(),
  assignment_id         uuid not null,
  case_id               text not null,
  case_version_id       uuid not null,
  mode                  text not null,
  is_pilot              boolean generated always as (mode = 'PILOT') stored,
  reviewer_pseudo_id    text not null,
  revision_number       integer not null check (revision_number >= 1),
  supersedes_review_id  uuid references public.reviews (review_id),
  -- Layer 1: clinical classification
  l1_decision           text check (l1_decision in ('INCLUDE', 'EXCLUDE', 'CONTEXT_DEPENDENT', 'INSUFFICIENT_INFORMATION')),
  l1_rationale          text check (l1_rationale is null or length(l1_rationale) <= 4000),
  l1_uncertain          boolean,
  l1_trial_role         text check (l1_trial_role is null or l1_trial_role in (
                          'DISEASE_STUDIED', 'COMORBIDITY', 'COMPLICATION', 'OUTCOME_ONLY',
                          'PREVENTION_TARGET', 'RISK_FACTOR', 'OTHER', 'UNRESOLVABLE')),
  -- Layer 2: benchmark compatibility
  l2_decision           text check (l2_decision in ('COMPATIBLE', 'INCOMPATIBLE', 'CONTEXT_DEPENDENT', 'INSUFFICIENT_INFORMATION')),
  l2_rationale          text check (l2_rationale is null or length(l2_rationale) <= 4000),
  l2_uncertain          boolean,
  l2_caveat             boolean,
  l2_caveat_text        text check (l2_caveat_text is null or length(l2_caveat_text) <= 2000),
  l2_checks             jsonb check (l2_checks is null or jsonb_typeof(l2_checks) = 'object'),
  -- Layer 3: PPR interpretability (analytical PPR validity)
  l3_decision           text check (l3_decision in ('VALID', 'INVALID', 'CONTEXT_DEPENDENT', 'INSUFFICIENT_INFORMATION')),
  l3_rationale          text check (l3_rationale is null or length(l3_rationale) <= 4000),
  l3_uncertain          boolean,
  l3_caveat             boolean,
  l3_caveat_text        text check (l3_caveat_text is null or length(l3_caveat_text) <= 2000),
  l3_derived_from_l2    boolean not null default false,
  -- Case-level fields
  overall_comment       text check (overall_comment is null or length(overall_comment) <= 4000),
  packet_issue_flag     boolean not null default false,
  packet_issue_note     text check (packet_issue_note is null or length(packet_issue_note) <= 2000),
  seconds_on_case       integer check (seconds_on_case is null or seconds_on_case >= 0),
  version_set_id        text not null references public.ontology_versions (version_set_id),
  app_git_sha           text,
  content_sha256        text not null check (content_sha256 ~ '^[0-9a-f]{64}$'),
  submitted_at          timestamptz not null default now(),
  foreign key (assignment_id, case_id, mode, reviewer_pseudo_id)
    references public.assignments (assignment_id, case_id, mode, reviewer_pseudo_id),
  foreign key (case_version_id, case_id, mode) references public.case_versions (case_version_id, case_id, mode),
  unique (assignment_id, revision_number),
  check ((supersedes_review_id is null) = (revision_number = 1)),
  check ((l1_decision is null) = (l1_uncertain is null)),
  check ((l2_decision is null) = (l2_uncertain is null)),
  check ((l3_decision is null) = (l3_uncertain is null)),
  check ((l2_caveat is not null) = (l2_decision is not distinct from 'COMPATIBLE')),
  check ((l3_caveat is not null) = (l3_decision is not distinct from 'VALID')),
  check (l2_caveat_text is null or l2_caveat is true),
  check (l3_caveat_text is null or l3_caveat is true),
  check (not l3_derived_from_l2 or (l2_decision = 'INCOMPATIBLE' and l3_decision = 'INVALID')),
  check (l1_trial_role is null or l1_decision is not null),
  check (not packet_issue_flag or packet_issue_note is not null)
);
create index reviews_case_idx on public.reviews (case_id, mode);

-- -----------------------------------------------------------------------------
-- 6. Adjudications (investigator), append-only
-- -----------------------------------------------------------------------------

create table public.adjudications (
  adjudication_id             uuid primary key default gen_random_uuid(),
  case_id                     text not null,
  case_version_id             uuid not null,
  mode                        text not null,
  is_pilot                    boolean generated always as (mode = 'PILOT') stored,
  layer                       text not null check (layer in ('clinical_classification', 'benchmark_compatibility', 'analytical_ppr_validity')),
  adjudicated_decision        text,
  adjudicated_caveat          boolean,
  adjudication_status         text not null check (adjudication_status in (
                                'CONCORDANT_CONFIRMED', 'CONCORDANT_REVISED', 'DISCORDANT_RESOLVED', 'UNRESOLVED_ESCALATED')),
  adjudication_basis          text not null check (adjudication_basis in (
                                'REVIEWER_1', 'REVIEWER_2', 'BOTH_REVIEWERS', 'NEITHER', 'NONE')),
  rationale                   text not null check (length(rationale) between 3 and 4000),
  evidence                    jsonb not null default '[]'::jsonb check (jsonb_typeof(evidence) = 'array'),
  considered_review_ids       uuid[] not null check (cardinality(considered_review_ids) >= 1),
  ai_records_viewed           uuid[] not null default '{}',
  supersedes_adjudication_id  uuid references public.adjudications (adjudication_id),
  approved_for_pipeline       boolean not null default false,
  version_set_id              text not null references public.ontology_versions (version_set_id),
  decided_by                  uuid not null references public.users (user_id),
  decided_at                  timestamptz not null default now(),
  foreign key (case_version_id, case_id, mode) references public.case_versions (case_version_id, case_id, mode),
  check ((adjudication_status = 'UNRESOLVED_ESCALATED') = (adjudicated_decision is null)),
  check ((adjudication_status = 'UNRESOLVED_ESCALATED') = (adjudication_basis = 'NONE')),
  check (not (approved_for_pipeline and adjudication_status = 'UNRESOLVED_ESCALATED')),
  check (adjudicated_decision is null
     or (layer = 'clinical_classification' and adjudicated_decision in ('INCLUDE', 'EXCLUDE', 'CONTEXT_DEPENDENT', 'INSUFFICIENT_INFORMATION'))
     or (layer = 'benchmark_compatibility' and adjudicated_decision in ('COMPATIBLE', 'INCOMPATIBLE', 'CONTEXT_DEPENDENT', 'INSUFFICIENT_INFORMATION'))
     or (layer = 'analytical_ppr_validity' and adjudicated_decision in ('VALID', 'INVALID', 'CONTEXT_DEPENDENT', 'INSUFFICIENT_INFORMATION'))),
  check ((adjudicated_caveat is not null) =
         ((layer = 'benchmark_compatibility' and adjudicated_decision is not distinct from 'COMPATIBLE')
       or (layer = 'analytical_ppr_validity' and adjudicated_decision is not distinct from 'VALID')))
);
create index adjudications_case_idx on public.adjudications (case_id, layer);

-- -----------------------------------------------------------------------------
-- 7. Exports and audit log
-- -----------------------------------------------------------------------------

create table public.exports (
  export_id                      uuid primary key default gen_random_uuid(),
  mode                           text not null check (mode in ('PILOT', 'FORMAL')),
  is_pilot                       boolean generated always as (mode = 'PILOT') stored,
  export_type                    text not null check (export_type in (
                                   'ANALYSIS', 'REVIEWS_EFFECTIVE', 'REVIEWS_HISTORY', 'ADJUDICATIONS',
                                   'APPROVED_DECISIONS', 'AUDIT_LOG', 'BUNDLE')),
  export_format_version          text not null,
  review_phase_status            text not null check (review_phase_status in ('PILOT', 'IN_PROGRESS', 'COMPLETE', 'CLOSED_INCOMPLETE')),
  version_set_id                 text references public.ontology_versions (version_set_id),
  ontology_version               text not null,
  rule_version                   text not null,
  rubric_version                 text not null,
  classification_schema_version  text not null,
  sampling_design_version        text,
  db_schema_version              text not null,
  app_git_sha                    text not null,
  row_counts                     jsonb not null check (jsonb_typeof(row_counts) = 'object'),
  file_sha256                    jsonb not null check (jsonb_typeof(file_sha256) = 'object'),
  storage_uri                    text,
  created_by                     uuid not null references public.users (user_id),
  created_at                     timestamptz not null default now(),
  notes                          text,
  check ((mode = 'PILOT') = (review_phase_status = 'PILOT'))
);

alter table public.review_phase_events
  add constraint review_phase_events_pilot_export_fk foreign key (pilot_export_id) references public.exports (export_id);

create table public.audit_log (
  audit_id       bigint generated always as identity primary key,
  occurred_at    timestamptz not null default clock_timestamp(),
  actor_user_id  uuid,
  actor_role     text,
  action         text not null,
  entity_table   text not null,
  entity_id      text,
  mode           text check (mode is null or mode in ('PILOT', 'FORMAL')),
  is_pilot       boolean generated always as (mode = 'PILOT') stored,
  details        jsonb not null default '{}'::jsonb,
  prev_hash      text,
  row_hash       text not null
);

-- -----------------------------------------------------------------------------
-- 8. Helper functions (schema `private`, not exposed through the API)
-- -----------------------------------------------------------------------------

create function private.app_user_id() returns uuid
language sql stable security definer set search_path = '' as $$
  select u.user_id from public.users u
  where u.auth_uid = auth.uid() and u.is_active
$$;

create function private.app_role() returns text
language sql stable security definer set search_path = '' as $$
  select u.role from public.users u where u.auth_uid = auth.uid() and u.is_active
$$;

-- Investigator check. When require_investigator_mfa is 'true' (the default),
-- the session must carry an aal2 (multi-factor) Supabase token.
create function private.is_investigator() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((
    select u.role = 'INVESTIGATOR'
       and (coalesce((select s.setting_value from public.app_settings s
                      where s.setting_key = 'require_investigator_mfa'), 'true') = 'false'
            or coalesce(auth.jwt() ->> 'aal', '') = 'aal2')
    from public.users u where u.auth_uid = auth.uid() and u.is_active), false)
$$;

create function private.my_reviewer_pseudo_id() returns text
language sql stable security definer set search_path = '' as $$
  select r.reviewer_pseudo_id
  from public.reviewers r join public.users u on u.user_id = r.user_id
  where u.auth_uid = auth.uid() and u.is_active and r.withdrawn_at is null
$$;

create function private.assert_investigator() returns uuid
language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.is_investigator() then
    raise exception 'investigator role (with multi-factor session when required) is needed for this action'
      using errcode = '42501';
  end if;
  return private.app_user_id();
end $$;

create function private.formal_phase_status() returns text
language sql stable security definer set search_path = '' as $$
  select coalesce((
    select case e.event_type
             when 'FORMAL_UNLOCKED' then 'IN_PROGRESS'
             when 'FORMAL_REOPENED_BY_AMENDMENT' then 'IN_PROGRESS'
             when 'FORMAL_CLOSED_COMPLETE' then 'COMPLETE'
             when 'FORMAL_CLOSED_INCOMPLETE' then 'CLOSED_INCOMPLETE'
           end
    from public.review_phase_events e
    order by e.event_seq desc limit 1), 'LOCKED')
$$;

create function private.latest_case_version_id(p_case_id text) returns uuid
language sql stable security definer set search_path = '' as $$
  select cv.case_version_id from public.case_versions cv
  where cv.case_id = p_case_id order by cv.version desc limit 1
$$;

create function private.is_assigned(p_case_id text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.assignments a
    where a.case_id = p_case_id and a.withdrawn_at is null
      and a.reviewer_pseudo_id = private.my_reviewer_pseudo_id())
$$;

-- A case is closed to further reviewer submissions when: FORMAL and the formal
-- phase is not IN_PROGRESS; or PILOT and an adjudication exists for it.
-- Returns only a boolean, never decision content.
create function private.case_is_locked(p_case_id text) returns boolean
language sql stable security definer set search_path = '' as $$
  select case c.mode
           when 'FORMAL' then private.formal_phase_status() <> 'IN_PROGRESS'
           else exists (select 1 from public.adjudications j where j.case_id = c.case_id)
         end
  from public.cases c where c.case_id = p_case_id
$$;

create function private.sha256_hex(p text) returns text
language sql immutable set search_path = '' as $$
  select encode(extensions.digest(convert_to(coalesce(p, ''), 'UTF8'), 'sha256'), 'hex')
$$;

-- Recursively list every object key in a jsonb document.
create function private.jsonb_all_keys(p jsonb) returns setof text
language sql immutable set search_path = '' as $$
  with recursive walk(v) as (
    select p
    union all
    select child.value
    from walk w,
         lateral (
           select e.value from jsonb_each(case when jsonb_typeof(w.v) = 'object' then w.v else '{}'::jsonb end) e
           union all
           select a.value from jsonb_array_elements(case when jsonb_typeof(w.v) = 'array' then w.v else '[]'::jsonb end) a
         ) child
  )
  select k.key from walk w, lateral jsonb_object_keys(case when jsonb_typeof(w.v) = 'object' then w.v else '{}'::jsonb end) k(key)
$$;

-- Packets must not carry blinded content. Top-level keys come from an allow
-- list; no key at any depth may look like AI output, sampling design, an
-- original or proposed decision, or another reviewer's work.
create function private.assert_packet_blinded(p jsonb) returns void
language plpgsql immutable set search_path = '' as $$
declare
  bad text;
begin
  select k into bad from jsonb_object_keys(p) k
  where k not in ('schema_version', 'case_title', 'question', 'unit', 'descriptor', 'mesh', 'area',
                  'trial', 'ppr_rows', 'benchmark', 'ppr_inputs', 'links', 'rubric_refs', 'notices')
  limit 1;
  if bad is not null then
    raise exception 'packet top-level key "%" is not on the reviewer-visible allow list', bad using errcode = '22023';
  end if;
  select k into bad from private.jsonb_all_keys(p) k
  where k ~* '(^ai_|_ai_|stage_?[abcd]($|_)|llm|model_id|prompt|stratum|strata|selection_prob|sampling|weight|decision|proposed|adjudicat|reviewer|confidence|rule_id|original_technical|expected)'
  limit 1;
  if bad is not null then
    raise exception 'packet key "%" looks like blinded content and is not allowed in a reviewer packet', bad using errcode = '22023';
  end if;
end $$;

-- Generic append-only guard.
create function private.reject_mutation() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception '% is append-only: % is not allowed', tg_table_name, tg_op using errcode = '42501';
end $$;

-- -----------------------------------------------------------------------------
-- 9. Audit log writer (hash-chained) and audit triggers
-- -----------------------------------------------------------------------------

create function private.audit_before_insert() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  last_hash text;
begin
  perform pg_advisory_xact_lock(hashtext('audit_log_chain'));
  select a.row_hash into last_hash from public.audit_log a order by a.audit_id desc limit 1;
  new.prev_hash := last_hash;
  new.row_hash := private.sha256_hex(coalesce(last_hash, '') || '|' || new.occurred_at::text || '|' ||
                                     coalesce(new.actor_user_id::text, '') || '|' || new.action || '|' ||
                                     new.entity_table || '|' || coalesce(new.entity_id, '') || '|' ||
                                     coalesce(new.mode, '') || '|' || new.details::text);
  return new;
end $$;

create function private.write_audit(p_action text, p_table text, p_entity_id text, p_mode text, p_details jsonb)
returns void language plpgsql security definer set search_path = '' as $$
begin
  insert into public.audit_log (actor_user_id, actor_role, action, entity_table, entity_id, mode, details)
  values (private.app_user_id(), coalesce(private.app_role(), current_user), p_action, p_table, p_entity_id,
          p_mode, coalesce(p_details, '{}'::jsonb));
end $$;

-- Row-level audit trigger. Decision content of reviews and drafts is NOT
-- copied into the audit log (the investigator must not see FORMAL decisions
-- before close); only identifiers and a content hash are logged.
create function private.audit_row() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  rec jsonb := to_jsonb(coalesce(new, old));
  pk text;
  details jsonb;
begin
  pk := coalesce(rec ->> 'review_id', rec ->> 'adjudication_id', rec ->> 'assignment_id', rec ->> 'case_version_id',
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
  else
    details := rec;
  end if;
  insert into public.audit_log (actor_user_id, actor_role, action, entity_table, entity_id, mode, details)
  values (private.app_user_id(), coalesce(private.app_role(), current_user), tg_op, tg_table_name, pk,
          rec ->> 'mode', details);
  return null;
end $$;

-- -----------------------------------------------------------------------------
-- 10. Integrity triggers
-- -----------------------------------------------------------------------------

-- reviewers: role and pilot-test-account consistency
create function private.reviewers_check() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  u record;
begin
  select * into u from public.users where user_id = new.user_id;
  if u.role <> 'REVIEWER' then
    raise exception 'reviewer rows require a REVIEWER user';
  end if;
  if (new.mode_scope = 'PILOT') <> u.is_pilot_test_account then
    raise exception 'PILOT reviewers must be pilot test accounts and FORMAL reviewers must not be';
  end if;
  if tg_op = 'UPDATE' then
    if new.reviewer_pseudo_id <> old.reviewer_pseudo_id or new.user_id <> old.user_id
       or new.mode_scope <> old.mode_scope or new.enrolled_at <> old.enrolled_at
       or (old.withdrawn_at is not null and new.withdrawn_at is distinct from old.withdrawn_at) then
      raise exception 'only qualifications_summary and a first withdrawal may change on reviewers';
    end if;
  end if;
  return new;
end $$;

-- cases: only a first withdrawal may change
create function private.cases_update_check() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.case_id <> old.case_id or new.mode <> old.mode or new.unit_type <> old.unit_type
     or new.created_at <> old.created_at or new.created_by <> old.created_by
     or old.withdrawn_at is not null then
    raise exception 'cases are immutable except for a single withdrawal';
  end if;
  return new;
end $$;

-- assignments: mode scope, phase gate, slot consistency; updates only for withdrawal
create function private.assignments_check() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  rv record;
  c record;
  other_slot smallint;
begin
  if tg_op = 'UPDATE' then
    if new.case_id <> old.case_id or new.reviewer_pseudo_id <> old.reviewer_pseudo_id or new.mode <> old.mode
       or new.reviewer_slot <> old.reviewer_slot or new.queue_position <> old.queue_position
       or new.randomization_seed <> old.randomization_seed or old.withdrawn_at is not null then
      raise exception 'assignments are immutable except for a single withdrawal';
    end if;
    return new;
  end if;
  select r.*, u.is_active as user_active into rv
  from public.reviewers r join public.users u on u.user_id = r.user_id
  where r.reviewer_pseudo_id = new.reviewer_pseudo_id;
  select * into c from public.cases where case_id = new.case_id;
  if rv.withdrawn_at is not null or not rv.user_active then
    raise exception 'reviewer % is withdrawn or inactive', new.reviewer_pseudo_id;
  end if;
  if c.withdrawn_at is not null then
    raise exception 'case % is withdrawn', new.case_id;
  end if;
  if rv.mode_scope <> c.mode then
    raise exception 'mode contamination blocked: % reviewer % cannot be assigned % case %',
      rv.mode_scope, new.reviewer_pseudo_id, c.mode, new.case_id;
  end if;
  if c.mode = 'FORMAL' and private.formal_phase_status() <> 'IN_PROGRESS' then
    raise exception 'FORMAL assignments are locked: formal phase status is %', private.formal_phase_status();
  end if;
  select a.reviewer_slot into other_slot from public.assignments a
  where a.reviewer_pseudo_id = new.reviewer_pseudo_id and a.withdrawn_at is null and a.reviewer_slot <> new.reviewer_slot
  limit 1;
  if other_slot is not null then
    raise exception 'reviewer % already holds slot %; a reviewer keeps one slot for all cases', new.reviewer_pseudo_id, other_slot;
  end if;
  return new;
end $$;

-- reviews: assignment, lock, version, applicability and dependency checks;
-- revision numbering is computed here so callers cannot get it wrong.
create function private.reviews_before_insert() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  a record;
  cv record;
  prev record;
begin
  select * into a from public.assignments where assignment_id = new.assignment_id;
  if a.assignment_id is null or a.withdrawn_at is not null then
    raise exception 'assignment % is missing or withdrawn', new.assignment_id;
  end if;
  if a.reviewer_pseudo_id <> new.reviewer_pseudo_id or a.case_id <> new.case_id or a.mode <> new.mode then
    raise exception 'review does not match its assignment';
  end if;
  if exists (select 1 from public.reviewers r where r.reviewer_pseudo_id = new.reviewer_pseudo_id and r.withdrawn_at is not null) then
    raise exception 'reviewer % is withdrawn', new.reviewer_pseudo_id;
  end if;
  if exists (select 1 from public.cases c where c.case_id = new.case_id and c.withdrawn_at is not null) then
    raise exception 'case % is withdrawn', new.case_id;
  end if;
  if private.case_is_locked(new.case_id) then
    raise exception 'case % is closed to new submissions', new.case_id;
  end if;
  if new.case_version_id <> private.latest_case_version_id(new.case_id) then
    raise exception 'reviews must be submitted against the latest case version';
  end if;
  select * into cv from public.case_versions where case_version_id = new.case_version_id;
  if new.version_set_id <> cv.version_set_id then
    raise exception 'review version set % differs from the case version set %', new.version_set_id, cv.version_set_id;
  end if;
  -- Three-state rule: a decision exists exactly when the layer applies.
  if (new.l1_decision is not null) <> cv.l1_applicable
     or (new.l2_decision is not null) <> cv.l2_applicable
     or (new.l3_decision is not null) <> cv.l3_applicable then
    raise exception 'each applicable layer needs a decision and non-applicable layers must be empty (l1 %, l2 %, l3 %)',
      cv.l1_applicable, cv.l2_applicable, cv.l3_applicable;
  end if;
  -- Dependency rule (PPR-INV-02): INCOMPATIBLE benchmark forces a derived INVALID PPR decision.
  if cv.l3_applicable and new.l2_decision = 'INCOMPATIBLE'
     and not (new.l3_decision = 'INVALID' and new.l3_derived_from_l2) then
    raise exception 'benchmark INCOMPATIBLE requires a derived INVALID PPR decision';
  end if;
  if new.l3_derived_from_l2 and new.l2_decision is distinct from 'INCOMPATIBLE' then
    raise exception 'a derived PPR decision requires benchmark INCOMPATIBLE';
  end if;
  if new.l1_trial_role is not null and (select c.unit_type from public.cases c where c.case_id = new.case_id) <> 'TRIAL_AREA' then
    raise exception 'l1_trial_role is recorded only for trial-level cases';
  end if;
  select r.review_id, r.revision_number into prev from public.reviews r
  where r.assignment_id = new.assignment_id order by r.revision_number desc limit 1;
  new.revision_number := coalesce(prev.revision_number, 0) + 1;
  new.supersedes_review_id := prev.review_id;
  new.submitted_at := now();
  return new;
end $$;

-- adjudications: phase, version, applicability, supersession
create function private.adjudications_before_insert() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  c record;
  cv record;
  cur uuid;
  n_bad integer;
  n_slots integer;
begin
  if (select u.role from public.users u where u.user_id = new.decided_by) is distinct from 'INVESTIGATOR' then
    raise exception 'only the investigator adjudicates';
  end if;
  select * into c from public.cases where case_id = new.case_id;
  if c.withdrawn_at is not null then
    raise exception 'case % is withdrawn', new.case_id;
  end if;
  if new.case_version_id <> private.latest_case_version_id(new.case_id) then
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
  select count(*) into n_bad from unnest(new.considered_review_ids) rid
  where not exists (select 1 from public.reviews r where r.review_id = rid and r.case_id = new.case_id
                    and r.case_version_id = new.case_version_id);
  if n_bad > 0 then
    raise exception 'considered_review_ids must be reviews of this case version';
  end if;
  select j.adjudication_id into cur from public.adjudications j
  where j.case_id = new.case_id and j.layer = new.layer
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

-- case_versions: version numbering and blinded-packet check
create function private.case_versions_before_insert() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform private.assert_packet_blinded(new.packet);
  new.version := coalesce((select max(v.version) from public.case_versions v where v.case_id = new.case_id), 0) + 1;
  new.packet_sha256 := private.sha256_hex(new.packet::text);
  return new;
end $$;

-- review_phase_events: legal transitions and pilot completion evidence
create function private.phase_event_check() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  st text := private.formal_phase_status();
  n_cases integer;
  n_complete integer;
  n_open integer;
begin
  if (select u.role from public.users u where u.user_id = new.actor_user_id) is distinct from 'INVESTIGATOR' then
    raise exception 'only the investigator changes the review phase';
  end if;
  if new.event_type = 'FORMAL_UNLOCKED' then
    if st <> 'LOCKED' then
      raise exception 'formal review was already unlocked (status %)', st;
    end if;
    select count(*) into n_cases from public.cases c where c.mode = 'PILOT' and c.withdrawn_at is null;
    select count(*) into n_complete from public.cases c
    where c.mode = 'PILOT' and c.withdrawn_at is null
      and (select count(distinct a.reviewer_slot) from public.assignments a
           join public.reviews r on r.assignment_id = a.assignment_id
           where a.case_id = c.case_id and a.withdrawn_at is null) = 2
      and exists (select 1 from public.adjudications j where j.case_id = c.case_id);
    if n_cases < 10 or n_complete < 10 then
      raise exception 'pilot incomplete: % active pilot cases, % with two reviews and an adjudication (10 required)',
        n_cases, n_complete;
    end if;
    if not exists (select 1 from public.exports e where e.export_id = new.pilot_export_id and e.mode = 'PILOT') then
      raise exception 'pilot_export_id must reference a PILOT export';
    end if;
  elsif new.event_type in ('FORMAL_CLOSED_COMPLETE', 'FORMAL_CLOSED_INCOMPLETE') then
    if st <> 'IN_PROGRESS' then
      raise exception 'formal review is not in progress (status %)', st;
    end if;
    if new.event_type = 'FORMAL_CLOSED_COMPLETE' then
      select count(*) into n_open from public.assignments a
      join public.cases c on c.case_id = a.case_id
      where a.mode = 'FORMAL' and a.withdrawn_at is null and c.withdrawn_at is null
        and not exists (select 1 from public.reviews r where r.assignment_id = a.assignment_id
                        and r.case_version_id = private.latest_case_version_id(a.case_id));
      if n_open > 0 then
        raise exception '% active FORMAL assignments have no review of the latest case version; close as FORMAL_CLOSED_INCOMPLETE instead', n_open;
      end if;
    end if;
  elsif new.event_type = 'FORMAL_REOPENED_BY_AMENDMENT' then
    if st not in ('COMPLETE', 'CLOSED_INCOMPLETE') then
      raise exception 'only a closed formal review can be reopened';
    end if;
  end if;
  new.occurred_at := now();
  return new;
end $$;

-- Attach triggers ------------------------------------------------------------

create trigger audit_log_chain before insert on public.audit_log
  for each row execute function private.audit_before_insert();

create trigger reviewers_check before insert or update on public.reviewers
  for each row execute function private.reviewers_check();
create trigger cases_update_check before update on public.cases
  for each row execute function private.cases_update_check();
create trigger assignments_check before insert or update on public.assignments
  for each row execute function private.assignments_check();
create trigger reviews_before_insert before insert on public.reviews
  for each row execute function private.reviews_before_insert();
create trigger adjudications_before_insert before insert on public.adjudications
  for each row execute function private.adjudications_before_insert();
create trigger case_versions_before_insert before insert on public.case_versions
  for each row execute function private.case_versions_before_insert();
create trigger phase_event_check before insert on public.review_phase_events
  for each row execute function private.phase_event_check();

-- Append-only tables: reject UPDATE and DELETE row by row, TRUNCATE per statement.
do $$
declare
  t text;
begin
  foreach t in array array['reviews', 'adjudications', 'case_versions', 'case_design', 'ai_classifications',
                           'exports', 'review_phase_events', 'audit_log', 'ontology_versions', 'sampling_strata',
                           'app_schema_version']
  loop
    execute format('create trigger %I before update or delete on public.%I for each row execute function private.reject_mutation()',
                   t || '_append_only', t);
    execute format('create trigger %I before truncate on public.%I for each statement execute function private.reject_mutation()',
                   t || '_no_truncate', t);
  end loop;
  -- Mutable tables still may not be deleted or truncated (withdraw instead).
  foreach t in array array['users', 'reviewers', 'cases', 'assignments']
  loop
    execute format('create trigger %I before delete on public.%I for each row execute function private.reject_mutation()',
                   t || '_no_delete', t);
    execute format('create trigger %I before truncate on public.%I for each statement execute function private.reject_mutation()',
                   t || '_no_truncate', t);
  end loop;
  -- Row audit on every table except the audit log itself.
  foreach t in array array['users', 'reviewers', 'ontology_versions', 'review_phase_events', 'cases', 'case_versions',
                           'case_design', 'sampling_strata', 'ai_classifications', 'assignments', 'review_drafts',
                           'reviews', 'adjudications', 'exports', 'app_settings']
  loop
    execute format('create trigger %I after insert or update or delete on public.%I for each row execute function private.audit_row()',
                   t || '_audit', t);
  end loop;
end $$;

-- users: only first linking of auth_uid, display name and deactivation may change
create function private.users_update_check() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.user_id <> old.user_id or new.email <> old.email or new.role <> old.role
     or new.is_pilot_test_account <> old.is_pilot_test_account or new.created_at <> old.created_at
     or (old.auth_uid is not null and new.auth_uid is distinct from old.auth_uid)
     or (not old.is_active and new.is_active) then
    raise exception 'users: only first account linking, display_name and deactivation may change';
  end if;
  return new;
end $$;
create trigger users_update_check before update on public.users
  for each row execute function private.users_update_check();

-- -----------------------------------------------------------------------------
-- 11. Row-level security
-- -----------------------------------------------------------------------------

alter table public.app_schema_version   enable row level security;
alter table public.app_settings         enable row level security;
alter table public.users                enable row level security;
alter table public.reviewers            enable row level security;
alter table public.ontology_versions    enable row level security;
alter table public.review_phase_events  enable row level security;
alter table public.cases                enable row level security;
alter table public.case_versions        enable row level security;
alter table public.case_design          enable row level security;
alter table public.sampling_strata      enable row level security;
alter table public.ai_classifications   enable row level security;
alter table public.assignments          enable row level security;
alter table public.review_drafts        enable row level security;
alter table public.reviews              enable row level security;
alter table public.adjudications        enable row level security;
alter table public.exports              enable row level security;
alter table public.audit_log            enable row level security;

-- Everyone signed in may read the schema version and the frozen version sets
-- (the rubric version shown on every case page).
create policy app_schema_version_read on public.app_schema_version for select to authenticated using (true);
create policy ontology_versions_read on public.ontology_versions for select to authenticated using (true);

-- Investigator-only tables.
create policy app_settings_inv on public.app_settings for select to authenticated using (private.is_investigator());
create policy phase_events_inv on public.review_phase_events for select to authenticated using (private.is_investigator());
create policy case_design_inv on public.case_design for select to authenticated using (private.is_investigator());
create policy sampling_strata_inv on public.sampling_strata for select to authenticated using (private.is_investigator());
create policy ai_classifications_inv on public.ai_classifications for select to authenticated using (private.is_investigator());
create policy adjudications_inv on public.adjudications for select to authenticated using (private.is_investigator());
create policy exports_inv on public.exports for select to authenticated using (private.is_investigator());
create policy audit_log_inv on public.audit_log for select to authenticated using (private.is_investigator());

-- People: the investigator sees everyone; others see only themselves.
create policy users_read on public.users for select to authenticated
  using (private.is_investigator() or auth_uid = auth.uid());
create policy reviewers_read on public.reviewers for select to authenticated
  using (private.is_investigator() or user_id = private.app_user_id());

-- Cases and packets: investigator, or a reviewer with an active assignment.
create policy cases_read on public.cases for select to authenticated
  using (private.is_investigator() or private.is_assigned(case_id));
create policy case_versions_read on public.case_versions for select to authenticated
  using (private.is_investigator() or private.is_assigned(case_id));

-- Assignments and drafts: own rows only (drafts are never visible to the investigator).
create policy assignments_read on public.assignments for select to authenticated
  using (private.is_investigator() or reviewer_pseudo_id = private.my_reviewer_pseudo_id());
create policy review_drafts_owner on public.review_drafts for select to authenticated
  using (reviewer_pseudo_id = private.my_reviewer_pseudo_id());

-- Reviews: a reviewer reads only their own. The investigator reads PILOT reviews
-- at any time and FORMAL reviews only after the formal phase is closed.
create policy reviews_read on public.reviews for select to authenticated
  using (reviewer_pseudo_id = private.my_reviewer_pseudo_id()
         or (private.is_investigator()
             and (mode = 'PILOT' or private.formal_phase_status() in ('COMPLETE', 'CLOSED_INCOMPLETE'))));

-- -----------------------------------------------------------------------------
-- 12. Views (security_invoker: the caller's RLS applies)
-- -----------------------------------------------------------------------------

-- Reviewer queue in randomized order with derived status. No decision content.
create view public.v_my_queue with (security_invoker = true) as
select a.assignment_id, a.case_id, a.mode, a.is_pilot, a.queue_position, a.reviewer_slot,
       cv.case_version_id, cv.version as case_version, cv.l1_applicable, cv.l2_applicable, cv.l3_applicable,
       cv.packet ->> 'case_title' as case_title,
       private.case_is_locked(a.case_id) as is_locked,
       case
         when exists (select 1 from public.reviews r where r.assignment_id = a.assignment_id
                      and r.case_version_id = cv.case_version_id) then 'SUBMITTED'
         when exists (select 1 from public.reviews r where r.assignment_id = a.assignment_id) then 'NEEDS_RE_REVIEW'
         when exists (select 1 from public.review_drafts d where d.assignment_id = a.assignment_id) then 'DRAFT'
         else 'NOT_STARTED'
       end as queue_status
from public.assignments a
join lateral (select v.* from public.case_versions v where v.case_id = a.case_id order by v.version desc limit 1) cv on true
where a.withdrawn_at is null and a.reviewer_pseudo_id = private.my_reviewer_pseudo_id();

-- Effective review per active assignment: the latest revision on the latest case version.
create view public.v_effective_reviews with (security_invoker = true) as
select distinct on (r.assignment_id) r.*, a.reviewer_slot
from public.reviews r
join public.assignments a on a.assignment_id = r.assignment_id and a.withdrawn_at is null
where r.case_version_id = private.latest_case_version_id(r.case_id)
order by r.assignment_id, r.revision_number desc;

-- Effective adjudication per case and layer: the row nothing supersedes.
create view public.v_effective_adjudications with (security_invoker = true) as
select j.* from public.adjudications j
where not exists (select 1 from public.adjudications k where k.supersedes_adjudication_id = j.adjudication_id);

-- Analysis export: one row per case x applicable layer (columns listed in
-- validation/review_codes.py ANALYSIS_EXPORT_COLUMNS, minus export_id which the
-- export service adds). Readable in full only by the investigator, and FORMAL
-- reviewer columns fill only after the formal phase is closed.
create view public.v_analysis_export with (security_invoker = true) as
with latest as (
  select distinct on (cv.case_id) cv.*
  from public.case_versions cv order by cv.case_id, cv.version desc
),
layers as (
  select l.case_id, x.layer
  from latest l
  cross join lateral (values ('clinical_classification', l.l1_applicable),
                             ('benchmark_compatibility', l.l2_applicable),
                             ('analytical_ppr_validity', l.l3_applicable)) as x(layer, applies)
  where x.applies
),
eff as (
  select * from public.v_effective_reviews
)
select
  c.mode, c.is_pilot, c.case_id, l.version as case_version, c.unit_type, d.unit_id, ly.layer,
  d.primary_stratum, d.selection_probability, d.sampling_weight, d.frame_stratum_size,
  d.descriptor_ui, d.descriptor_name, d.area, d.nct_id, d.condition_row, d.benchmark_id,
  d.trial_frequency_weight, d.n_trials_primary,
  case ly.layer when 'clinical_classification' then d.original_l1_decision
                when 'benchmark_compatibility' then d.original_l2_decision
                else d.original_l3_decision end as original_decision,
  aia.ai_status_raw as ai_stage_a_status_raw, aia.ai_status_mapped as ai_stage_a_decision,
  aib.ai_status_raw as ai_stage_b_status_raw, aib.ai_status_mapped as ai_stage_b_decision,
  aic.ai_status_raw as ai_stage_c_status_raw, aic.ai_status_mapped as ai_stage_c_decision,
  aid.ai_status_raw as decision_file_status_raw, aid.ai_status_mapped as decision_file_decision,
  r1.reviewer_pseudo_id as reviewer_1_pseudo_id, r1.review_id as reviewer_1_review_id,
  r1.revision_number as reviewer_1_revision_number,
  case ly.layer when 'clinical_classification' then r1.l1_decision
                when 'benchmark_compatibility' then r1.l2_decision else r1.l3_decision end as reviewer_1_decision,
  case when r1.review_id is null then null
       when ly.layer = 'analytical_ppr_validity' then r1.l3_derived_from_l2 else false end as reviewer_1_derived,
  case ly.layer when 'benchmark_compatibility' then r1.l2_caveat
                when 'analytical_ppr_validity' then r1.l3_caveat else null end as reviewer_1_caveat,
  case ly.layer when 'clinical_classification' then r1.l1_uncertain
                when 'benchmark_compatibility' then r1.l2_uncertain else r1.l3_uncertain end as reviewer_1_uncertain,
  r1.submitted_at as reviewer_1_submitted_at,
  r2.reviewer_pseudo_id as reviewer_2_pseudo_id, r2.review_id as reviewer_2_review_id,
  r2.revision_number as reviewer_2_revision_number,
  case ly.layer when 'clinical_classification' then r2.l1_decision
                when 'benchmark_compatibility' then r2.l2_decision else r2.l3_decision end as reviewer_2_decision,
  case when r2.review_id is null then null
       when ly.layer = 'analytical_ppr_validity' then r2.l3_derived_from_l2 else false end as reviewer_2_derived,
  case ly.layer when 'benchmark_compatibility' then r2.l2_caveat
                when 'analytical_ppr_validity' then r2.l3_caveat else null end as reviewer_2_caveat,
  case ly.layer when 'clinical_classification' then r2.l1_uncertain
                when 'benchmark_compatibility' then r2.l2_uncertain else r2.l3_uncertain end as reviewer_2_uncertain,
  r2.submitted_at as reviewer_2_submitted_at,
  (r1.review_id is not null and r2.review_id is not null) as double_reviewed,
  case when r1.review_id is null or r2.review_id is null then null
       else (case ly.layer when 'clinical_classification' then r1.l1_decision = r2.l1_decision
                           when 'benchmark_compatibility' then r1.l2_decision = r2.l2_decision
                           else r1.l3_decision = r2.l3_decision end) end as reviewers_agree,
  j.adjudication_id, j.adjudicated_decision, j.adjudicated_caveat, j.adjudication_status, j.adjudication_basis,
  j.decided_at as adjudicated_at, coalesce(j.approved_for_pipeline, false) as approved_for_pipeline,
  ov.ontology_version, ov.rule_version, ov.rubric_version, d.sampling_design_version
from public.cases c
join latest l on l.case_id = c.case_id
join layers ly on ly.case_id = c.case_id
join public.case_design d on d.case_id = c.case_id
join public.ontology_versions ov on ov.version_set_id = l.version_set_id
left join eff r1 on r1.case_id = c.case_id and r1.reviewer_slot = 1
left join eff r2 on r2.case_id = c.case_id and r2.reviewer_slot = 2
left join public.v_effective_adjudications j on j.case_id = c.case_id and j.layer = ly.layer
left join public.ai_classifications aia on aia.case_id = c.case_id and aia.layer = ly.layer and aia.stage = 'A'
left join public.ai_classifications aib on aib.case_id = c.case_id and aib.layer = ly.layer and aib.stage = 'B'
left join public.ai_classifications aic on aic.case_id = c.case_id and aic.layer = ly.layer and aic.stage = 'C'
left join public.ai_classifications aid on aid.case_id = c.case_id and aid.layer = ly.layer and aid.stage = 'D'
where c.withdrawn_at is null;

-- -----------------------------------------------------------------------------
-- 13. RPC functions (the only write path). SECURITY DEFINER, empty search_path.
-- -----------------------------------------------------------------------------

-- Link the signed-in Supabase user to a pre-registered users row (same e-mail).
create function public.rpc_claim_account() returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  em text := lower(coalesce(auth.jwt() ->> 'email', ''));
  uid uuid;
begin
  if auth.uid() is null or em = '' then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  select user_id into uid from public.users where auth_uid = auth.uid();
  if uid is not null then
    return uid;
  end if;
  update public.users set auth_uid = auth.uid()
  where email = em and auth_uid is null and is_active
  returning user_id into uid;
  if uid is null then
    raise exception 'no active invitation for this account' using errcode = '42501';
  end if;
  return uid;
end $$;

create function public.rpc_whoami()
returns table (user_id uuid, role text, is_pilot_test_account boolean, reviewer_pseudo_id text,
               mode_scope text, formal_phase_status text, investigator_session_ok boolean)
language sql stable security definer set search_path = '' as $$
  select u.user_id, u.role, u.is_pilot_test_account, r.reviewer_pseudo_id, r.mode_scope,
         private.formal_phase_status(), private.is_investigator()
  from public.users u left join public.reviewers r on r.user_id = u.user_id and r.withdrawn_at is null
  where u.auth_uid = auth.uid() and u.is_active
$$;

create function public.rpc_register_user(p_email text, p_display_name text, p_role text,
                                         p_is_pilot_test_account boolean default false) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := private.assert_investigator();
  uid uuid;
begin
  insert into public.users (email, display_name, role, is_pilot_test_account, created_by)
  values (lower(p_email), p_display_name, p_role, p_is_pilot_test_account, me)
  returning user_id into uid;
  return uid;
end $$;

-- Bootstrap: the very first INVESTIGATOR row is created by the migration owner
-- or service role (scripts/bootstrap_investigator.py), never through the app.
create function public.rpc_deactivate_user(p_user_id uuid, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := private.assert_investigator();
begin
  if p_user_id = me then
    raise exception 'the investigator cannot deactivate their own account';
  end if;
  update public.users set is_active = false, deactivated_at = now() where user_id = p_user_id and is_active;
  perform private.write_audit('DEACTIVATE_USER', 'users', p_user_id::text, null, jsonb_build_object('reason', p_reason));
end $$;

-- Enroll a REVIEWER user and mint a random pseudonymous ID (not derived from identity).
create function public.rpc_enroll_reviewer(p_user_id uuid, p_mode_scope text, p_qualifications text default null)
returns text language plpgsql security definer set search_path = '' as $$
declare
  me uuid := private.assert_investigator();
  pid text;
  alphabet text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  i int;
begin
  if p_mode_scope = 'FORMAL' and private.formal_phase_status() = 'LOCKED' then
    raise exception 'FORMAL reviewers can be enrolled only after the pilot sign-off unlocks the formal review';
  end if;
  loop
    pid := case p_mode_scope when 'PILOT' then 'PT-' else 'R-' end;
    for i in 1..4 loop
      pid := pid || substr(alphabet, 1 + (get_byte(extensions.gen_random_bytes(1), 0) % length(alphabet)), 1);
    end loop;
    exit when not exists (select 1 from public.reviewers where reviewer_pseudo_id = pid);
  end loop;
  insert into public.reviewers (reviewer_pseudo_id, user_id, mode_scope, qualifications_summary, enrolled_by)
  values (pid, p_user_id, p_mode_scope, p_qualifications, me);
  return pid;
end $$;

create function public.rpc_update_reviewer_qualifications(p_reviewer_pseudo_id text, p_qualifications text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform private.assert_investigator();
  update public.reviewers set qualifications_summary = p_qualifications where reviewer_pseudo_id = p_reviewer_pseudo_id;
end $$;

create function public.rpc_withdraw_reviewer(p_reviewer_pseudo_id text, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform private.assert_investigator();
  update public.reviewers set withdrawn_at = now(), withdrawal_reason = p_reason
  where reviewer_pseudo_id = p_reviewer_pseudo_id and withdrawn_at is null;
  update public.assignments set withdrawn_at = now(), withdrawn_reason = 'reviewer withdrawn: ' || p_reason
  where reviewer_pseudo_id = p_reviewer_pseudo_id and withdrawn_at is null;
end $$;

create function public.rpc_register_ontology_version(p jsonb) returns text
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := private.assert_investigator();
  vid text := (p ->> 'ontology_version') || '+' || (p ->> 'rubric_version');
begin
  insert into public.ontology_versions (version_set_id, ontology_version, rule_version, rubric_version,
    classification_schema_version, protocol_version, sampling_design_version, ontology_sha256,
    classification_schema_sha256, rubric_sha256, frozen_at, registered_by, notes)
  values (vid, p ->> 'ontology_version', p ->> 'rule_version', p ->> 'rubric_version',
    p ->> 'classification_schema_version', p ->> 'protocol_version', p ->> 'sampling_design_version',
    p ->> 'ontology_sha256', p ->> 'classification_schema_sha256', p ->> 'rubric_sha256',
    (p ->> 'frozen_at')::timestamptz, me, p ->> 'notes');
  return vid;
end $$;

-- Import one case: cases + case_versions (version 1) + case_design.
-- p = {case_id, mode, unit_type, version_set_id, l1_applicable, l2_applicable,
--      l3_applicable, packet, change_reason, design: {...}}
create function public.rpc_import_case(p jsonb) returns text
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := private.assert_investigator();
  d jsonb := p -> 'design';
begin
  if (p ->> 'mode') = 'FORMAL' and private.formal_phase_status() = 'LOCKED' then
    raise exception 'FORMAL cases are imported only after the pilot sign-off unlocks the formal review';
  end if;
  insert into public.cases (case_id, mode, unit_type, created_by)
  values (p ->> 'case_id', p ->> 'mode', p ->> 'unit_type', me);
  insert into public.case_versions (case_id, mode, version, version_set_id, l1_applicable, l2_applicable,
                                    l3_applicable, packet, packet_sha256, change_reason, created_by)
  values (p ->> 'case_id', p ->> 'mode', 1, p ->> 'version_set_id', (p ->> 'l1_applicable')::boolean,
          (p ->> 'l2_applicable')::boolean, (p ->> 'l3_applicable')::boolean, p -> 'packet',
          repeat('0', 64), coalesce(p ->> 'change_reason', 'initial import'), me);
  insert into public.case_design (case_id, mode, unit_id, descriptor_ui, descriptor_name, area, nct_id, condition_row,
    benchmark_id, frame_unit_id, primary_stratum, selection_probability, frame_stratum_size, sampling_design_version, sampling_seed,
    trial_frequency_weight, n_trials_primary, original_l1_decision, original_l2_decision, original_l3_decision,
    investigator_note, source_file, source_row_sha256, imported_by)
  values (p ->> 'case_id', p ->> 'mode', d ->> 'unit_id', d ->> 'descriptor_ui', d ->> 'descriptor_name', d ->> 'area',
    d ->> 'nct_id', d ->> 'condition_row', d ->> 'benchmark_id', d ->> 'frame_unit_id', d ->> 'primary_stratum',
    (d ->> 'selection_probability')::numeric, (d ->> 'frame_stratum_size')::integer, d ->> 'sampling_design_version',
    (d ->> 'sampling_seed')::bigint, (d ->> 'trial_frequency_weight')::numeric, (d ->> 'n_trials_primary')::integer,
    d ->> 'original_l1_decision', d ->> 'original_l2_decision', d ->> 'original_l3_decision',
    d ->> 'investigator_note', d ->> 'source_file', d ->> 'source_row_sha256', me);
  return p ->> 'case_id';
end $$;

-- New packet version (for example to correct a packet error). Earlier reviews stay
-- in the database; both reviewers must review the new version.
create function public.rpc_add_case_version(p_case_id text, p_packet jsonb, p_version_set_id text,
                                            p_l1 boolean, p_l2 boolean, p_l3 boolean, p_change_reason text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  me uuid := private.assert_investigator();
  m text;
  vid uuid;
begin
  select mode into m from public.cases where case_id = p_case_id and withdrawn_at is null;
  if m is null then
    raise exception 'case % missing or withdrawn', p_case_id;
  end if;
  if private.case_is_locked(p_case_id) then
    raise exception 'case % is locked; packet changes after close need a protocol amendment', p_case_id;
  end if;
  insert into public.case_versions (case_id, mode, version, version_set_id, l1_applicable, l2_applicable,
                                    l3_applicable, packet, packet_sha256, change_reason, created_by)
  values (p_case_id, m, 1, p_version_set_id, p_l1, p_l2, p_l3, p_packet, repeat('0', 64), p_change_reason, me)
  returning case_version_id into vid;
  return vid;
end $$;

create function public.rpc_withdraw_case(p_case_id text, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform private.assert_investigator();
  update public.cases set withdrawn_at = now(), withdrawn_reason = p_reason
  where case_id = p_case_id and withdrawn_at is null;
end $$;

create function public.rpc_import_ai_classification(p jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := private.assert_investigator();
  rid uuid;
begin
  insert into public.ai_classifications (case_id, mode, stage, layer, source_record_id, unit_id, descriptor_ui, area,
    nct_id, ai_status_raw, ai_status_mapped, confidence, rationale, rule_ids, evidence, model_id, prompt_version,
    run_id, ontology_version, source_file, source_line_number, source_line_sha256, imported_by)
  values (p ->> 'case_id', p ->> 'mode', p ->> 'stage', p ->> 'layer', p ->> 'source_record_id', p ->> 'unit_id',
    p ->> 'descriptor_ui', p ->> 'area', p ->> 'nct_id', p ->> 'ai_status_raw', p ->> 'ai_status_mapped',
    p ->> 'confidence', p ->> 'rationale',
    coalesce((select array_agg(x) from jsonb_array_elements_text(coalesce(p -> 'rule_ids', '[]'::jsonb)) x), '{}'),
    coalesce(p -> 'evidence', '[]'::jsonb), p ->> 'model_id', p ->> 'prompt_version', p ->> 'run_id',
    p ->> 'ontology_version', p ->> 'source_file', (p ->> 'source_line_number')::integer, p ->> 'source_line_sha256', me)
  returning ai_record_id into rid;
  return rid;
end $$;

create function public.rpc_import_sampling_stratum(p jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := private.assert_investigator();
begin
  insert into public.sampling_strata (sampling_design_version, primary_stratum, mode, frame_stratum_size, n_sampled,
    selection_probability, frame_trial_frequency_total, description, imported_by)
  values (p ->> 'sampling_design_version', p ->> 'primary_stratum', p ->> 'mode', (p ->> 'frame_stratum_size')::integer,
    (p ->> 'n_sampled')::integer, (p ->> 'selection_probability')::numeric,
    (p ->> 'frame_trial_frequency_total')::numeric, p ->> 'description', me);
end $$;

-- Assign cases to one reviewer in a reproducible random order:
-- queue position follows md5(seed:reviewer:case_id), appended after the reviewer's
-- current last position. Returns the number of new assignments.
create function public.rpc_assign_cases(p_mode text, p_reviewer_pseudo_id text, p_slot integer,
                                        p_case_ids text[], p_seed bigint) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := private.assert_investigator();
  start_pos integer;
  n integer;
begin
  select coalesce(max(queue_position), 0) into start_pos from public.assignments
  where reviewer_pseudo_id = p_reviewer_pseudo_id and withdrawn_at is null;
  insert into public.assignments (case_id, mode, reviewer_pseudo_id, reviewer_slot, queue_position,
                                  randomization_seed, assigned_by)
  select x.case_id, p_mode, p_reviewer_pseudo_id, p_slot::smallint,
         start_pos + row_number() over (order by md5(p_seed::text || ':' || p_reviewer_pseudo_id || ':' || x.case_id)),
         p_seed, me
  from unnest(p_case_ids) as x(case_id);
  get diagnostics n = row_count;
  perform private.write_audit('ASSIGN_CASES', 'assignments', p_reviewer_pseudo_id, p_mode,
                              jsonb_build_object('n', n, 'seed', p_seed, 'slot', p_slot));
  return n;
end $$;

create function public.rpc_withdraw_assignment(p_assignment_id uuid, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform private.assert_investigator();
  update public.assignments set withdrawn_at = now(), withdrawn_reason = p_reason
  where assignment_id = p_assignment_id and withdrawn_at is null;
end $$;

-- Save-and-resume (reviewer, own assignment, case not locked).
create function public.rpc_save_draft(p_assignment_id uuid, p_draft jsonb) returns timestamptz
language plpgsql security definer set search_path = '' as $$
declare
  me text := private.my_reviewer_pseudo_id();
  a record;
  ts timestamptz;
begin
  select * into a from public.assignments where assignment_id = p_assignment_id;
  if me is null or a.reviewer_pseudo_id is distinct from me or a.withdrawn_at is not null then
    raise exception 'not your active assignment' using errcode = '42501';
  end if;
  if private.case_is_locked(a.case_id) then
    raise exception 'case is closed to further changes';
  end if;
  insert into public.review_drafts (assignment_id, reviewer_pseudo_id, mode, draft)
  values (p_assignment_id, me, a.mode, coalesce(p_draft, '{}'::jsonb))
  on conflict (assignment_id) do update
    set draft = excluded.draft, saved_at = now(), save_count = public.review_drafts.save_count + 1
  returning saved_at into ts;
  return ts;
end $$;

-- Submit a review (reviewer, own assignment). Applies the dependency rule:
-- benchmark INCOMPATIBLE sets a derived INVALID PPR decision.
create function public.rpc_submit_review(p_assignment_id uuid, p jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  me text := private.my_reviewer_pseudo_id();
  a record;
  cv record;
  rid uuid;
  l1d text; l1u boolean; l2d text; l2u boolean; l3d text; l3u boolean; l3r text;
  derived boolean := false;
  content text;
begin
  select * into a from public.assignments where assignment_id = p_assignment_id;
  if me is null or a.reviewer_pseudo_id is distinct from me or a.withdrawn_at is not null then
    raise exception 'not your active assignment' using errcode = '42501';
  end if;
  select * into cv from public.case_versions where case_version_id = private.latest_case_version_id(a.case_id);
  -- Non-applicable layers are forced to NULL (state 3); applicable layers keep what was sent
  -- (the trigger rejects a missing decision on an applicable layer).
  l1d := case when cv.l1_applicable then p ->> 'l1_decision' end;
  l1u := case when l1d is not null then coalesce((p ->> 'l1_uncertain')::boolean, false) end;
  l2d := case when cv.l2_applicable then p ->> 'l2_decision' end;
  l2u := case when l2d is not null then coalesce((p ->> 'l2_uncertain')::boolean, false) end;
  l3d := case when cv.l3_applicable then p ->> 'l3_decision' end;
  l3r := case when cv.l3_applicable then p ->> 'l3_rationale' end;
  if cv.l3_applicable and l2d = 'INCOMPATIBLE' then
    if l3d is not null and l3d <> 'INVALID' then
      raise exception 'benchmark INCOMPATIBLE fixes the PPR decision at INVALID';
    end if;
    l3d := 'INVALID';
    l3r := coalesce(l3r, 'Derived: benchmark judged INCOMPATIBLE (ontology rule PPR-INV-02).');
    derived := true;
  end if;
  l3u := case when l3d is not null then
           case when derived then l2u else coalesce((p ->> 'l3_uncertain')::boolean, false) end end;
  content := concat_ws('|', a.case_id, cv.case_version_id::text, me, l1d, l1u::text, p ->> 'l1_trial_role',
                       l2d, l2u::text, p ->> 'l2_caveat', l3d, l3u::text, p ->> 'l3_caveat', derived::text,
                       p ->> 'l1_rationale', p ->> 'l2_rationale', l3r, p ->> 'overall_comment');
  insert into public.reviews (assignment_id, case_id, case_version_id, mode, reviewer_pseudo_id, revision_number,
    l1_decision, l1_rationale, l1_uncertain, l1_trial_role,
    l2_decision, l2_rationale, l2_uncertain, l2_caveat, l2_caveat_text, l2_checks,
    l3_decision, l3_rationale, l3_uncertain, l3_caveat, l3_caveat_text, l3_derived_from_l2,
    overall_comment, packet_issue_flag, packet_issue_note, seconds_on_case, version_set_id, app_git_sha, content_sha256)
  values (p_assignment_id, a.case_id, cv.case_version_id, a.mode, me, 1,
    l1d, case when l1d is not null then p ->> 'l1_rationale' end, l1u,
    case when l1d is not null then p ->> 'l1_trial_role' end,
    l2d, case when l2d is not null then p ->> 'l2_rationale' end, l2u,
    case when l2d = 'COMPATIBLE' then coalesce((p ->> 'l2_caveat')::boolean, false) end,
    case when l2d = 'COMPATIBLE' and coalesce((p ->> 'l2_caveat')::boolean, false) then p ->> 'l2_caveat_text' end,
    case when l2d is not null then p -> 'l2_checks' end,
    l3d, l3r, l3u,
    case when l3d = 'VALID' then coalesce((p ->> 'l3_caveat')::boolean, false) end,
    case when l3d = 'VALID' and coalesce((p ->> 'l3_caveat')::boolean, false) then p ->> 'l3_caveat_text' end,
    derived,
    p ->> 'overall_comment', coalesce((p ->> 'packet_issue_flag')::boolean, false), p ->> 'packet_issue_note',
    (p ->> 'seconds_on_case')::integer, cv.version_set_id, p ->> 'app_git_sha', private.sha256_hex(content))
  returning review_id into rid;
  delete from public.review_drafts where assignment_id = p_assignment_id;
  return rid;
end $$;

create function public.rpc_record_adjudication(p_case_id text, p_layer text, p_decision text, p_caveat boolean,
  p_status text, p_basis text, p_rationale text, p_evidence jsonb, p_considered_review_ids uuid[],
  p_ai_records_viewed uuid[], p_supersedes uuid, p_approved_for_pipeline boolean) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := private.assert_investigator();
  cvid uuid := private.latest_case_version_id(p_case_id);
  vs text;
  m text;
  jid uuid;
begin
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

-- Pilot sign-off: unlocks the FORMAL review. Requires the completed pilot
-- (checked by trigger) and the SHA-256 of the signed checklist file.
create function public.rpc_unlock_formal_review(p_checklist_version text, p_checklist_sha256 text,
  p_app_git_sha text, p_pilot_export_id uuid, p_attestation text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := private.assert_investigator();
  eid uuid;
begin
  insert into public.review_phase_events (event_type, actor_user_id, pilot_checklist_version, pilot_checklist_sha256,
                                          app_git_sha, pilot_export_id, attestation)
  values ('FORMAL_UNLOCKED', me, p_checklist_version, lower(p_checklist_sha256), p_app_git_sha, p_pilot_export_id,
          p_attestation)
  returning event_id into eid;
  return eid;
end $$;

create function public.rpc_close_formal_review(p_complete boolean, p_attestation text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := private.assert_investigator();
  eid uuid;
begin
  insert into public.review_phase_events (event_type, actor_user_id, attestation)
  values (case when p_complete then 'FORMAL_CLOSED_COMPLETE' else 'FORMAL_CLOSED_INCOMPLETE' end, me, p_attestation)
  returning event_id into eid;
  return eid;
end $$;

create function public.rpc_reopen_formal_review(p_amendment_reference text, p_attestation text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := private.assert_investigator();
  eid uuid;
begin
  insert into public.review_phase_events (event_type, actor_user_id, amendment_reference, attestation)
  values ('FORMAL_REOPENED_BY_AMENDMENT', me, p_amendment_reference, p_attestation)
  returning event_id into eid;
  return eid;
end $$;

-- Register an export written by the app's export service. The phase status is
-- set here from the database, not supplied by the caller.
create function public.rpc_register_export(p jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := private.assert_investigator();
  eid uuid;
  m text := p ->> 'mode';
begin
  insert into public.exports (mode, export_type, export_format_version, review_phase_status, version_set_id,
    ontology_version, rule_version, rubric_version, classification_schema_version, sampling_design_version,
    db_schema_version, app_git_sha, row_counts, file_sha256, storage_uri, created_by, notes)
  values (m, p ->> 'export_type', p ->> 'export_format_version',
    case when m = 'PILOT' then 'PILOT' else private.formal_phase_status() end,
    p ->> 'version_set_id', p ->> 'ontology_version', p ->> 'rule_version', p ->> 'rubric_version',
    p ->> 'classification_schema_version', p ->> 'sampling_design_version',
    (select max(version) from public.app_schema_version), p ->> 'app_git_sha',
    coalesce(p -> 'row_counts', '{}'::jsonb), coalesce(p -> 'file_sha256', '{}'::jsonb), p ->> 'storage_uri', me,
    p ->> 'notes')
  returning export_id into eid;
  return eid;
end $$;

-- Completion counts for monitoring. Returns no decision content, so the
-- investigator can track FORMAL progress without seeing answers.
create function public.rpc_completion_summary(p_mode text)
returns table (reviewer_pseudo_id text, reviewer_slot smallint, n_assigned bigint, n_submitted_latest bigint,
               n_needs_re_review bigint, n_draft bigint, n_not_started bigint, n_packet_issue_flags bigint,
               last_submitted_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.assert_investigator();
  return query
  select a.reviewer_pseudo_id, min(a.reviewer_slot)::smallint, count(*),
         count(*) filter (where s.latest_done),
         count(*) filter (where not s.latest_done and s.any_done),
         count(*) filter (where not s.any_done and s.has_draft),
         count(*) filter (where not s.any_done and not s.has_draft),
         count(*) filter (where s.issue),
         max(s.last_at)
  from public.assignments a
  cross join lateral (
    select exists (select 1 from public.reviews r where r.assignment_id = a.assignment_id
                   and r.case_version_id = private.latest_case_version_id(a.case_id)) as latest_done,
           exists (select 1 from public.reviews r where r.assignment_id = a.assignment_id) as any_done,
           exists (select 1 from public.review_drafts d where d.assignment_id = a.assignment_id) as has_draft,
           exists (select 1 from public.reviews r where r.assignment_id = a.assignment_id and r.packet_issue_flag) as issue,
           (select max(r.submitted_at) from public.reviews r where r.assignment_id = a.assignment_id) as last_at
  ) s
  where a.mode = p_mode and a.withdrawn_at is null
  group by a.reviewer_pseudo_id;
end $$;

-- Packet-issue notes (no decisions) so packet errors can be fixed during the review.
create function public.rpc_packet_issues(p_mode text)
returns table (case_id text, reviewer_pseudo_id text, packet_issue_note text, submitted_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.assert_investigator();
  return query
  select r.case_id, r.reviewer_pseudo_id, r.packet_issue_note, r.submitted_at
  from public.reviews r where r.mode = p_mode and r.packet_issue_flag order by r.submitted_at;
end $$;

create function public.rpc_set_setting(p_key text, p_value text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform private.assert_investigator();
  update public.app_settings set setting_value = p_value, updated_at = now() where setting_key = p_key;
end $$;

-- App-level events (sign-in, export download, consensus page opened).
create function public.rpc_log_event(p_action text, p_details jsonb default '{}'::jsonb) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if private.app_user_id() is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  if p_action !~ '^[A-Z_]{3,40}$' then
    raise exception 'action must be an upper-case identifier';
  end if;
  if not private.is_investigator() and p_action not in ('SIGN_IN', 'SIGN_OUT', 'OPEN_CASE', 'SESSION_TIMEOUT') then
    raise exception 'reviewers may log only SIGN_IN, SIGN_OUT, OPEN_CASE and SESSION_TIMEOUT';
  end if;
  perform private.write_audit(p_action, 'app_event', null, p_details ->> 'mode', coalesce(p_details, '{}'::jsonb));
end $$;

-- -----------------------------------------------------------------------------
-- 14. Privileges
-- -----------------------------------------------------------------------------

-- Supabase grants broad default privileges on new public tables; remove them.
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
grant select on all tables in schema public to authenticated;   -- rows filtered by RLS
-- No INSERT, UPDATE or DELETE for authenticated: every write goes through rpc_*.

revoke all on all functions in schema public from public, anon;
revoke all on all functions in schema private from public, anon, authenticated;
-- Only the helpers used inside RLS policies and security_invoker views are executable by callers.
grant execute on function
  private.app_user_id(), private.app_role(), private.is_investigator(), private.my_reviewer_pseudo_id(),
  private.formal_phase_status(), private.latest_case_version_id(text), private.is_assigned(text),
  private.case_is_locked(text)
to authenticated;
grant execute on function
  public.rpc_claim_account(), public.rpc_whoami(), public.rpc_register_user(text, text, text, boolean),
  public.rpc_deactivate_user(uuid, text), public.rpc_enroll_reviewer(uuid, text, text),
  public.rpc_update_reviewer_qualifications(text, text), public.rpc_withdraw_reviewer(text, text),
  public.rpc_register_ontology_version(jsonb), public.rpc_import_case(jsonb),
  public.rpc_add_case_version(text, jsonb, text, boolean, boolean, boolean, text), public.rpc_withdraw_case(text, text),
  public.rpc_import_ai_classification(jsonb), public.rpc_import_sampling_stratum(jsonb),
  public.rpc_assign_cases(text, text, integer, text[], bigint), public.rpc_withdraw_assignment(uuid, text),
  public.rpc_save_draft(uuid, jsonb), public.rpc_submit_review(uuid, jsonb),
  public.rpc_record_adjudication(text, text, text, boolean, text, text, text, jsonb, uuid[], uuid[], uuid, boolean),
  public.rpc_unlock_formal_review(text, text, text, uuid, text), public.rpc_close_formal_review(boolean, text),
  public.rpc_reopen_formal_review(text, text), public.rpc_register_export(jsonb),
  public.rpc_completion_summary(text), public.rpc_packet_issues(text), public.rpc_set_setting(text, text),
  public.rpc_log_event(text, jsonb)
to authenticated;

commit;
