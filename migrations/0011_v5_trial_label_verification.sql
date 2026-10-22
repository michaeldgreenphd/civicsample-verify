-- =============================================================================
-- migrations/0004_v5_trial_label_verification.sql
-- Clinical review schema v5: trial-level verification of the therapeutic-area labels used in the
-- analysis. Applies ON TOP OF the unchanged schema.sql (v2), 0002 (v3) and 0003 (v4).
--
-- Status: PRE-BUILD, PROPOSED. Tested on PGlite only (tests_prebuild/pglite_rls_v5/,
-- SCHEMA_TEST_REPORT_v5.md). Live PostgreSQL 16 and Supabase migration and RLS tests are REQUIRED
-- before any formal reviewer is invited.
--
-- Why a new migration (design: classification_validation/review_design_v5/, APP_MAPPING_v5.md):
--   The v4 case model stores one area judgment per determination level (reviews.l1_decision; at most
--   two levels per case). A v5 case is one trial carrying 7 area questions, 10 Figure 2 condition-row
--   questions and up to 2 subgroup items, with codes outside the layer-1 scale. The v4 held-out guards
--   also refuse development-linked frame units, which v5 includes on purpose (Tier 0 is a deterministic
--   rule never tuned on trials). v5 therefore lives in its own tables (prefix tlv5_), on the Module B
--   pattern of 0003, and REUSES users, roles, reviewers, pseudonyms, the audit log, the packet-key walker,
--   the investigator multi-factor check and the append-only machinery.
--
-- What v5 adds:
--   1. tlv5_activation (irreversible, singleton). Design v4 and design v5 are mutually exclusive: v5
--      activation is refused once design v4 is active, and a new trigger refuses v4 activation once v5
--      is active (a guard added on top of 0003, never a weakening of it).
--   2. Record categories with distinct prefixes and modes: SYNTHETIC_PILOT (SYN-, PILOT),
--      RUBRIC_CALIBRATION (CAL5-, CALIBRATION, never exported or analysed), LABEL_VERIFICATION_FORMAL
--      (TLV5-, FORMAL). A case never changes category.
--   3. Investigator-only design rows and frozen labels (Tier 0 primary, curated v1.2 secondary, Figure 2
--      row membership, rule D and rule K outcomes), write-once, hashed row by row; no reviewer or
--      adjudicator policy exists on them.
--   4. One freeze (case-list and label-set hashes) before FORMAL assignments; no FORMAL case, design row
--      or label can be added after it.
--   5. Reviewer submissions: one header plus one row per item, append-only; revisions until the close;
--      subgroup items are accepted only when the same submission answers the matching condition row YES
--      (the display rule keys on the reviewer's own answer, never on a frozen label).
--   6. Snapshot of the independent judgments after the close and before any FORMAL adjudication.
--   7. Adjudication by the ADJUDICATOR role only in FORMAL mode (an investigator can never enter a FORMAL
--      judgment), blinded to labels by row-level security; DISAGREEMENTS_ONLY scope by default.
--   8. Reference lock per mode; export views (investigator only) for the independent judgments, the
--      adjudicated reference and the frozen labels; verification functions for both hashes.
--   9. Audit: submissions are logged as identifiers and a hash only (the FINDING-V4-01 rule).
--  10. FORMAL reviewer enrolment for v5 after the v5 pilot sign-off (rpc_tlv5_enroll_reviewer); the v2 path
--      (rpc_enroll_reviewer after the v2 unlock) is unchanged.
--
-- Apply after schema.sql, 0002 and 0003, in one transaction each:
--   psql -v ON_ERROR_STOP=1 -f migrations/0004_v5_trial_label_verification.sql
-- Every object below is new. No object of schema.sql, 0002 or 0003 is replaced or altered. Two new guard
-- triggers are attached to existing tables, and both only refuse: public.design_activation_v4 (refuses v4
-- activation once v5 is active) and public.cases (refuses a FORMAL v2/v3/v4 case once v5 is active).
-- =============================================================================
begin;

insert into public.app_schema_version (version, description)
values ('5.0.0', 'review design v5: trial-level verification of the analysis labels (tlv5_ tables, freeze, submissions, adjudication, lock, exports)');

-- -----------------------------------------------------------------------------
-- 1. Code lists (helpers; the CHECK constraints below use them)
-- -----------------------------------------------------------------------------
create function private.tlv5_item_family(p_item text) returns text
language sql immutable set search_path = '' as $$
  select case
    when p_item in ('AREA_ONCOLOGY', 'AREA_CARDIOVASCULAR', 'AREA_MENTAL_HEALTH', 'AREA_INFECTIOUS', 'AREA_METABOLIC',
                    'AREA_NEUROLOGICAL', 'AREA_RESPIRATORY') then 'AREA'
    when p_item in ('FIG2_ROW_CAN_ALL', 'FIG2_ROW_DIAB', 'FIG2_ROW_DEP', 'FIG2_ROW_OBE', 'FIG2_ROW_AST', 'FIG2_ROW_COPD',
                    'FIG2_ROW_COV', 'FIG2_ROW_SCZ', 'FIG2_ROW_HTN', 'FIG2_ROW_PAIN') then 'FIG2_ROW'
    when p_item = 'SG_DIABETES_TYPE' then 'SG_DIABETES_TYPE'
    when p_item = 'SG_NEOPLASM_MALIGNANCY' then 'SG_NEOPLASM_MALIGNANCY'
    when p_item = 'RULE_D' then 'RULE_D'
    when p_item = 'RULE_K' then 'RULE_K'
    else 'UNKNOWN'  -- never NULL: a NULL would let a CHECK constraint pass silently
  end
$$;

-- Reviewer answer scale per item family (three-state rule: an answer, an explicit unknown, or not applicable)
create function private.tlv5_answer_ok(p_item text, p_answer text) returns boolean
language sql immutable set search_path = '' as $$
  select case private.tlv5_item_family(p_item)
    when 'AREA' then p_answer in ('YES', 'NO', 'CONTEXT_DEPENDENT', 'INSUFFICIENT_INFORMATION')
    when 'FIG2_ROW' then p_answer in ('YES', 'NO', 'INSUFFICIENT_INFORMATION')
    when 'SG_DIABETES_TYPE' then p_answer in ('TYPE_2', 'TYPE_1', 'BOTH_TYPE_1_AND_TYPE_2', 'OTHER', 'UNCLEAR')
    when 'SG_NEOPLASM_MALIGNANCY' then p_answer in ('MALIGNANT', 'NON_MALIGNANT', 'UNCLEAR')
    else false end
$$;

-- A detail code is REQUIRED for SG_DIABETES_TYPE = OTHER and SG_NEOPLASM_MALIGNANCY = NON_MALIGNANT, and
-- forbidden otherwise. Written so that no branch can evaluate to NULL.
create function private.tlv5_detail_ok(p_item text, p_answer text, p_detail text) returns boolean
language sql immutable set search_path = '' as $$
  select case
    when p_item = 'SG_DIABETES_TYPE' and p_answer = 'OTHER'
      then p_detail is not null and p_detail in ('PREDIABETES', 'GESTATIONAL', 'LADA_OR_AUTOIMMUNE', 'MONOGENIC_OR_SECONDARY',
                                                 'DIABETES_NOT_STUDIED', 'OTHER_SPECIFIED')
    when p_item = 'SG_NEOPLASM_MALIGNANCY' and p_answer = 'NON_MALIGNANT'
      then p_detail is not null and p_detail in ('PRECANCEROUS', 'BENIGN_NEOPLASM', 'NOT_A_NEOPLASM', 'OTHER_SPECIFIED')
    else p_detail is null end
$$;

-- -----------------------------------------------------------------------------
-- 2. Tables
-- -----------------------------------------------------------------------------
create table public.tlv5_activation (
  activation_id       uuid primary key default gen_random_uuid(),
  singleton           boolean not null default true unique check (singleton),
  design_version      text not null check (length(design_version) between 3 and 80),
  adjudication_scope  text not null check (adjudication_scope in ('DISAGREEMENTS_ONLY', 'ALL_ITEMS')),
  attestation         text not null check (length(attestation) >= 20),
  activated_at        timestamptz not null default now(),
  activated_by        uuid not null references public.users (user_id)
);

create table public.tlv5_phase_events (
  event_id           uuid primary key default gen_random_uuid(),
  event_seq          bigint generated always as identity unique,
  event_type         text not null check (event_type in ('PILOT_SIGNED_OFF', 'FORMAL_OPENED',
                                                         'FORMAL_CLOSED_COMPLETE', 'FORMAL_CLOSED_INCOMPLETE')),
  checklist_version  text,
  checklist_sha256   text check (checklist_sha256 is null or checklist_sha256 ~ '^[0-9a-f]{64}$'),
  app_git_sha        text,
  pilot_export_id    uuid,
  attestation        text not null check (length(attestation) >= 20),
  occurred_at        timestamptz not null default now(),
  actor              uuid not null references public.users (user_id),
  check (event_type <> 'PILOT_SIGNED_OFF'
         or (checklist_version is not null and checklist_sha256 is not null and app_git_sha is not null
             and pilot_export_id is not null))
);

create table public.tlv5_cases (
  case_id          text primary key check (case_id ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{2,80}$'),
  mode             text not null check (mode in ('PILOT', 'CALIBRATION', 'FORMAL')),
  record_category  text not null check (record_category in ('SYNTHETIC_PILOT', 'RUBRIC_CALIBRATION', 'LABEL_VERIFICATION_FORMAL')),
  packet           jsonb not null check (jsonb_typeof(packet) = 'object'),
  packet_sha256    text not null check (packet_sha256 ~ '^[0-9a-f]{64}$'),
  created_at       timestamptz not null default now(),
  created_by       uuid not null references public.users (user_id),
  unique (case_id, mode),
  check ((mode = 'PILOT') = (case_id like 'SYN-%')),
  check ((mode = 'CALIBRATION') = (case_id like 'CAL5-%')),
  check ((mode = 'FORMAL') = (case_id like 'TLV5-%')),
  check ((mode = 'PILOT' and record_category = 'SYNTHETIC_PILOT')
      or (mode = 'CALIBRATION' and record_category = 'RUBRIC_CALIBRATION')
      or (mode = 'FORMAL' and record_category = 'LABEL_VERIFICATION_FORMAL'))
);

-- Investigator-only design row (never reviewer-visible)
create table public.tlv5_case_design (
  case_id                text primary key,
  mode                   text not null check (mode in ('PILOT', 'FORMAL')),
  nct_id                 text not null check (nct_id ~ '^(NCT[0-9]{8}|SYN-NCT-?[0-9]{4,8})$'),
  frame                  text not null check (length(frame) between 2 and 40),
  stratum                text not null check (length(stratum) between 2 and 80),
  variance_stratum       text not null check (length(variance_stratum) between 2 and 80),
  frame_stratum_size     integer not null check (frame_stratum_size >= 1),
  n_sampled_in_stratum   integer not null check (n_sampled_in_stratum >= 1),
  selection_probability  numeric not null check (selection_probability > 0 and selection_probability <= 1),
  sampling_weight        numeric generated always as (1 / selection_probability) stored,
  sampling_seed          bigint,
  prn                    numeric check (prn is null or (prn >= 0 and prn < 1)),
  design_version         text not null,
  in_mixed_sex_cohort    boolean,
  figure2_rows           text,
  dev_linked             boolean not null,
  tier1_eligible         boolean not null,
  design_row_sha256      text not null check (design_row_sha256 ~ '^[0-9a-f]{64}$'),
  imported_at            timestamptz not null default now(),
  imported_by            uuid not null references public.users (user_id),
  foreign key (case_id, mode) references public.tlv5_cases (case_id, mode),
  check (n_sampled_in_stratum <= frame_stratum_size),
  check (abs(selection_probability - n_sampled_in_stratum::numeric / frame_stratum_size) < 1e-9),
  check (tier1_eligible = not dev_linked)
);

-- Investigator-only, write-once frozen labels: one row per case x item
create table public.tlv5_frozen_labels (
  label_id             uuid primary key default gen_random_uuid(),
  label_set_id         text not null check (length(label_set_id) between 3 and 80),
  case_id              text not null,
  mode                 text not null check (mode in ('PILOT', 'FORMAL')),
  item_code            text not null,
  item_family          text generated always as (private.tlv5_item_family(item_code)) stored,
  label_primary        text not null,
  label_secondary      text,
  label_informational  text,
  dev_linked_area      boolean,
  row_sha256           text not null check (row_sha256 ~ '^[0-9a-f]{64}$'),
  imported_at          timestamptz not null default now(),
  imported_by          uuid not null references public.users (user_id),
  foreign key (case_id, mode) references public.tlv5_cases (case_id, mode),
  unique (case_id, item_code),
  check (private.tlv5_item_family(item_code) in ('AREA', 'FIG2_ROW', 'RULE_D', 'RULE_K')),
  -- every branch below evaluates to true or false, never NULL (a NULL would let the CHECK pass)
  check ((private.tlv5_item_family(item_code) = 'AREA' and label_primary in ('YES', 'NO')
          and label_secondary is not null and label_secondary in ('YES', 'NO')
          and (label_informational is null or label_informational in ('YES', 'NO'))
          and dev_linked_area is not null)
      or (private.tlv5_item_family(item_code) = 'FIG2_ROW' and label_primary in ('YES', 'NO')
          and label_secondary is null and label_informational is null and dev_linked_area is null)
      or (private.tlv5_item_family(item_code) = 'RULE_D'
          and label_primary in ('D1_KEEP_TYPE2', 'D2_REMOVE_OTHER_TYPE', 'D3_REMOVE_PREDIABETES_ONLY',
                                'D4A_KEEP_UNRESOLVED_PARENT_ONLY', 'D4B_KEEP_UNRESOLVED_COMPLICATION_ONLY')
          and label_secondary is null and (label_informational is null or label_informational = 'MIXED_TYPE1_TYPE2')
          and dev_linked_area is null)
      or (private.tlv5_item_family(item_code) = 'RULE_K'
          and label_primary in ('K_KEEP_MALIGNANT_COMPATIBLE', 'K_KEEP_HEURISTIC_NONMALIGNANT_CLASS',
                                'K_REMOVE_VERIFIED_NONMALIGNANT')
          and label_secondary is null and label_informational is null and dev_linked_area is null))
);

create table public.tlv5_freeze (
  freeze_id           uuid primary key default gen_random_uuid(),
  singleton           boolean not null default true unique check (singleton),
  design_version      text not null,
  adjudication_scope  text not null,
  n_cases             integer not null check (n_cases >= 1),
  case_list_sha256    text not null check (case_list_sha256 ~ '^[0-9a-f]{64}$'),
  n_label_rows        integer not null check (n_label_rows >= 1),
  label_rows_sha256   text not null check (label_rows_sha256 ~ '^[0-9a-f]{64}$'),
  label_file_sha256   text not null check (label_file_sha256 ~ '^[0-9a-f]{64}$'),
  frozen_items        jsonb not null check (jsonb_typeof(frozen_items) = 'object'),
  attestation         text not null check (length(attestation) >= 20),
  frozen_at           timestamptz not null default now(),
  frozen_by           uuid not null references public.users (user_id)
);

create table public.tlv5_assignments (
  assignment_id       uuid primary key default gen_random_uuid(),
  case_id             text not null,
  mode                text not null check (mode in ('PILOT', 'CALIBRATION', 'FORMAL')),
  reviewer_pseudo_id  text not null references public.reviewers (reviewer_pseudo_id),
  reviewer_slot       smallint not null check (reviewer_slot in (1, 2)),
  queue_position      integer not null check (queue_position >= 1),
  randomization_seed  bigint not null,
  assigned_at         timestamptz not null default now(),
  assigned_by         uuid not null references public.users (user_id),
  foreign key (case_id, mode) references public.tlv5_cases (case_id, mode),
  unique (case_id, reviewer_pseudo_id),
  unique (case_id, reviewer_slot),
  unique (reviewer_pseudo_id, mode, queue_position),
  unique (assignment_id, case_id, mode, reviewer_pseudo_id)
);

create table public.tlv5_submissions (
  submission_id       uuid primary key default gen_random_uuid(),
  assignment_id       uuid not null,
  case_id             text not null,
  mode                text not null,
  reviewer_pseudo_id  text not null,
  revision_number     integer not null check (revision_number >= 1),
  overall_comment     text check (overall_comment is null or length(overall_comment) <= 4000),
  packet_issue_flag   boolean not null default false,
  packet_issue_note   text check (packet_issue_note is null or length(packet_issue_note) <= 2000),
  seconds_on_case     integer check (seconds_on_case is null or seconds_on_case >= 0),
  n_items             integer not null default 0 check (n_items >= 0),
  content_sha256      text not null check (content_sha256 ~ '^[0-9a-f]{64}$'),
  submitted_at        timestamptz not null default now(),
  foreign key (assignment_id, case_id, mode, reviewer_pseudo_id)
    references public.tlv5_assignments (assignment_id, case_id, mode, reviewer_pseudo_id),
  unique (assignment_id, revision_number),
  check (not packet_issue_flag or packet_issue_note is not null)
);

create table public.tlv5_submission_items (
  submission_id  uuid not null references public.tlv5_submissions (submission_id),
  item_code      text not null,
  answer         text not null,
  uncertain      boolean not null default false,
  note           text check (note is null or length(note) <= 2000),
  detail_code    text,
  primary key (submission_id, item_code),
  check (private.tlv5_item_family(item_code) in ('AREA', 'FIG2_ROW', 'SG_DIABETES_TYPE', 'SG_NEOPLASM_MALIGNANCY')),
  check (private.tlv5_answer_ok(item_code, answer)),
  check (private.tlv5_detail_ok(item_code, answer, detail_code))
);

create table public.tlv5_snapshot (
  snapshot_id     uuid primary key default gen_random_uuid(),
  singleton       boolean not null default true unique check (singleton),
  n_rows          integer not null check (n_rows >= 0),
  content_sha256  text not null check (content_sha256 ~ '^[0-9a-f]{64}$'),
  taken_at        timestamptz not null default now(),
  taken_by        uuid not null references public.users (user_id)
);

create table public.tlv5_adjudications (
  adjudication_id           uuid primary key default gen_random_uuid(),
  case_id                   text not null,
  mode                      text not null check (mode in ('PILOT', 'FORMAL')),
  item_code                 text not null,
  decision                  text,
  detail_code               text,
  status                    text not null check (status in ('DISCORDANT_RESOLVED', 'SINGLE_REVIEW_ADJUDICATED', 'UNRESOLVED_ESCALATED',
                                                            'CONCORDANT_CONFIRMED', 'CONCORDANT_REVISED')),
  basis                     text not null check (basis in ('REVIEWER_1', 'REVIEWER_2', 'BOTH_REVIEWERS', 'NEITHER', 'NONE')),
  rationale                 text not null check (length(rationale) between 3 and 4000),
  -- the v3 reason list (0002), unchanged, so that disagreement summaries stay comparable across designs
  disagreement_reason_code  text check (disagreement_reason_code is null or disagreement_reason_code in (
                              'CONSTRUCT_BOUNDARY', 'POLICY_RULE_INTERPRETATION', 'MESH_PLACEMENT_MISLEADING', 'TRIAL_CONTEXT',
                              'PACKET_INSUFFICIENT', 'MULTILABEL_OR_CROSS_AREA', 'OTHER')),
  adjudicator_role          text,
  adjudication_blinded      boolean,
  post_unblinding           boolean not null default false,
  decided_by                uuid not null references public.users (user_id),
  decided_at                timestamptz not null default now(),
  foreign key (case_id, mode) references public.tlv5_cases (case_id, mode),
  check (private.tlv5_item_family(item_code) in ('AREA', 'FIG2_ROW', 'SG_DIABETES_TYPE', 'SG_NEOPLASM_MALIGNANCY')),
  check ((status = 'UNRESOLVED_ESCALATED') = (decision is null)),
  check ((status = 'UNRESOLVED_ESCALATED') = (basis = 'NONE')),
  check (decision is null or private.tlv5_answer_ok(item_code, decision)
         or (decision = 'NOT_APPLICABLE' and private.tlv5_item_family(item_code) in ('SG_DIABETES_TYPE', 'SG_NEOPLASM_MALIGNANCY'))),
  check (decision is null or private.tlv5_detail_ok(item_code, decision, detail_code))
);

create table public.tlv5_reference_locks (
  lock_id         uuid primary key default gen_random_uuid(),
  mode            text not null unique check (mode in ('PILOT', 'FORMAL')),
  n_items_locked  integer not null check (n_items_locked >= 0),
  attestation     text not null check (length(attestation) >= 20),
  locked_at       timestamptz not null default now(),
  locked_by       uuid not null references public.users (user_id)
);

create table public.tlv5_exports (
  export_id              uuid primary key default gen_random_uuid(),
  mode                   text not null check (mode in ('PILOT', 'FORMAL')),
  bundle_format_version  text not null check (bundle_format_version = '5.0'),
  row_counts             jsonb not null check (jsonb_typeof(row_counts) = 'object'),
  file_sha256            jsonb not null check (jsonb_typeof(file_sha256) = 'object'),
  manifest_sha256        text not null check (manifest_sha256 ~ '^[0-9a-f]{64}$'),
  app_git_sha            text not null,
  created_by             uuid not null references public.users (user_id),
  created_at             timestamptz not null default now(),
  notes                  text
);

-- -----------------------------------------------------------------------------
-- 3. Helpers
-- -----------------------------------------------------------------------------
create function private.tlv5_active() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.tlv5_activation)
$$;

create function private.tlv5_frozen() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.tlv5_freeze)
$$;

create function private.tlv5_scope() returns text
language sql stable security definer set search_path = '' as $$
  select coalesce((select a.adjudication_scope from public.tlv5_activation a), 'DISAGREEMENTS_ONLY')
$$;

create function private.tlv5_pilot_signed_off() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.tlv5_phase_events e where e.event_type = 'PILOT_SIGNED_OFF')
$$;

-- FORMAL phase: NOT_OPENED, OPEN, CLOSED
create function private.tlv5_phase() returns text
language sql stable security definer set search_path = '' as $$
  select coalesce((select case e.event_type when 'FORMAL_OPENED' then 'OPEN' else 'CLOSED' end
                   from public.tlv5_phase_events e
                   where e.event_type in ('FORMAL_OPENED', 'FORMAL_CLOSED_COMPLETE', 'FORMAL_CLOSED_INCOMPLETE')
                   order by e.event_seq desc limit 1), 'NOT_OPENED')
$$;

create function private.tlv5_snapshot_taken() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.tlv5_snapshot)
$$;

create function private.tlv5_locked(p_mode text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.tlv5_reference_locks l where l.mode = p_mode)
$$;

create function private.tlv5_is_assigned(p_case_id text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.tlv5_assignments a
                 where a.case_id = p_case_id and a.reviewer_pseudo_id = private.my_reviewer_pseudo_id())
$$;

-- Can the current session read the reviewers' answers for a case of this mode?
-- Investigator: PILOT and CALIBRATION any time; FORMAL only after the close. Adjudicator: PILOT any time;
-- FORMAL after the close AND the snapshot; never CALIBRATION.
create function private.tlv5_can_read_answers(p_mode text) returns boolean
language sql stable security definer set search_path = '' as $$
  select case
    when private.is_investigator() then p_mode in ('PILOT', 'CALIBRATION') or private.tlv5_phase() = 'CLOSED'
    when private.is_adjudicator() then p_mode = 'PILOT' or (p_mode = 'FORMAL' and private.tlv5_phase() = 'CLOSED'
                                                            and private.tlv5_snapshot_taken())
    else false end
$$;

create function private.tlv5_reviewer_items() returns setof text
language sql immutable set search_path = '' as $$
  select unnest(array['AREA_ONCOLOGY', 'AREA_CARDIOVASCULAR', 'AREA_MENTAL_HEALTH', 'AREA_INFECTIOUS', 'AREA_METABOLIC',
                      'AREA_NEUROLOGICAL', 'AREA_RESPIRATORY', 'FIG2_ROW_CAN_ALL', 'FIG2_ROW_DIAB', 'FIG2_ROW_DEP',
                      'FIG2_ROW_OBE', 'FIG2_ROW_AST', 'FIG2_ROW_COPD', 'FIG2_ROW_COV', 'FIG2_ROW_SCZ', 'FIG2_ROW_HTN',
                      'FIG2_ROW_PAIN', 'SG_DIABETES_TYPE', 'SG_NEOPLASM_MALIGNANCY'])
$$;

-- Effective (latest) answers of the reviewers for one case item, with the detail code. A subgroup item missing
-- from the latest submission has no answer (NOT_APPLICABLE). Two answers agree only when the answer AND the
-- detail code agree. SECURITY DEFINER; every caller is itself guarded.
create function private.tlv5_item_answers(p_case_id text, p_item text)
returns table (reviewer_slot smallint, answer text, detail_code text)
language sql stable security definer set search_path = '' as $$
  select a.reviewer_slot, i.answer, i.detail_code
  from public.tlv5_assignments a
  join public.tlv5_submissions s on s.assignment_id = a.assignment_id
       and s.revision_number = (select max(s2.revision_number) from public.tlv5_submissions s2 where s2.assignment_id = a.assignment_id)
  join public.tlv5_submission_items i on i.submission_id = s.submission_id and i.item_code = p_item
  where a.case_id = p_case_id
$$;

-- Number of reviewer slots with at least one submission on a case (0, 1 or 2).
create function private.tlv5_n_reviewed(p_case_id text) returns integer
language sql stable security definer set search_path = '' as $$
  select count(distinct a.reviewer_slot)::integer from public.tlv5_assignments a
  where a.case_id = p_case_id and exists (select 1 from public.tlv5_submissions s where s.assignment_id = a.assignment_id)
$$;

-- Reviewer-visible trial packet: allow-listed keys, no blinded key at any depth, no NCT identifier in any value.
create function private.assert_tlv5_packet_blinded(p jsonb) returns void
language plpgsql immutable set search_path = '' as $$
declare
  bad text;
begin
  select k into bad from jsonb_object_keys(p) k
  where k not in ('schema_version', 'case_title', 'trial', 'notices') limit 1;
  if bad is not null then
    raise exception 'v5 packet top-level key "%" is not on the reviewer-visible allow list', bad using errcode = '22023';
  end if;
  select k into bad from private.jsonb_all_keys(coalesce(p -> 'trial', '{}'::jsonb)) k
  where k not in ('brief_title', 'official_title', 'conditions_registered', 'condition_mesh_headings', 'brief_summary',
                  'interventions', 'intervention_type', 'name', 'description', 'eligibility_age_range',
                  'minimum_age', 'maximum_age')
  limit 1;
  if bad is not null then
    raise exception 'v5 trial packet key "%" is not on the reviewer-visible allow list', bad using errcode = '22023';
  end if;
  select k into bad from private.jsonb_all_keys(p) k
  where k ~* '(^ai_|_ai_|stage_?[abcd]($|_)|llm|prompt|stratum|strata|selection_prob|sampling|weight|tier|label|curated|decision|proposed|adjudicat|reviewer|confidence|rule_|original|expected|enrol|(^|_)sex($|_)|gender|female|(^|_)male($|_)|participant|(^|_)counts?($|_)|ppr|benchmark|result|tree|root|nct|url|link)'
  limit 1;
  if bad is not null then
    raise exception 'v5 packet key "%" could carry blinded content and is not allowed', bad using errcode = '22023';
  end if;
  if p::text ~* 'NCT[0-9]{8}' or p::text ~* 'clinicaltrials\.gov' then
    raise exception 'v5 packets carry no NCT identifier or registry address (the registry record shows enrollment and sex)'
      using errcode = '22023';
  end if;
end $$;

create function private.tlv5_label_row_text(p_set text, p_case text, p_item text, p_primary text, p_secondary text,
                                            p_info text) returns text
language sql immutable set search_path = '' as $$
  select concat_ws('|', p_set, p_case, p_item, p_primary, coalesce(p_secondary, ''), coalesce(p_info, ''))
$$;

create function private.tlv5_label_rows_sha256(p_mode text) returns text
language sql stable security definer set search_path = '' as $$
  select private.sha256_hex(string_agg(f.row_sha256, E'\n' order by f.case_id collate "C", f.item_code collate "C"))
  from public.tlv5_frozen_labels f where f.mode = p_mode
$$;

-- -----------------------------------------------------------------------------
-- 4. Triggers
-- -----------------------------------------------------------------------------
create function private.tlv5_activation_before_insert() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from public.design_activation_v4) then
    raise exception 'design v4 is active; design v5 cannot be activated (the two designs are mutually exclusive)';
  end if;
  if exists (select 1 from public.cases c where c.mode = 'FORMAL' and c.withdrawn_at is null) then
    raise exception 'active FORMAL cases exist in the v2/v3/v4 case table; withdraw them before activating design v5';
  end if;
  if not private.tlv5_pilot_signed_off() then
    raise exception 'sign off the v5 pilot (PILOT_SIGNED_OFF) before activating design v5';
  end if;
  return new;
end $$;

-- New guard on the v2/v3/v4 case table: once design v5 is active, FORMAL cases live in tlv5_cases only.
-- PILOT cases of the earlier designs are unaffected. A strengthening; nothing of schema.sql or 0002 is relaxed.
create function private.cases_v5_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.mode = 'FORMAL' and exists (select 1 from public.tlv5_activation) then
    raise exception 'design v5 is active; FORMAL cases are imported with rpc_tlv5_import_case, not into the v2/v3/v4 case table';
  end if;
  return new;
end $$;

-- New guard on the v4 activation table: refuse v4 once v5 is active (a strengthening of 0003, nothing relaxed).
create function private.design_activation_v4_v5_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from public.tlv5_activation) then
    raise exception 'design v5 is active; design v4 cannot be activated (the two designs are mutually exclusive)';
  end if;
  return new;
end $$;

create function private.tlv5_phase_events_before_insert() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  ph text := private.tlv5_phase();
  n_cases integer;
  n_complete integer;
  n_open integer;
begin
  if (select u.role from public.users u where u.user_id = new.actor) is distinct from 'INVESTIGATOR' then
    raise exception 'only the investigator changes the v5 phase';
  end if;
  if new.event_type = 'PILOT_SIGNED_OFF' then
    if private.tlv5_pilot_signed_off() then
      raise exception 'the v5 pilot is already signed off';
    end if;
    select count(*) into n_cases from public.tlv5_cases c where c.mode = 'PILOT';
    select count(*) into n_complete from public.tlv5_cases c
    where c.mode = 'PILOT'
      and (select count(distinct a.reviewer_slot) from public.tlv5_assignments a
           where a.case_id = c.case_id and exists (select 1 from public.tlv5_submissions s where s.assignment_id = a.assignment_id)) = 2;
    if n_cases < 10 or n_complete < 10 then
      raise exception 'v5 pilot incomplete: % pilot cases, % with two submissions (10 required)', n_cases, n_complete;
    end if;
    if not private.tlv5_locked('PILOT') then
      raise exception 'lock the pilot reference (adjudicate the pilot disagreements) before the sign-off';
    end if;
    if not exists (select 1 from public.tlv5_exports e where e.export_id = new.pilot_export_id and e.mode = 'PILOT') then
      raise exception 'pilot_export_id must reference a registered v5 PILOT export';
    end if;
  elsif new.event_type = 'FORMAL_OPENED' then
    if ph <> 'NOT_OPENED' then
      raise exception 'the v5 formal phase opens once (status %)', ph;
    end if;
    if not private.tlv5_frozen() then
      raise exception 'freeze the v5 sample and labels (rpc_tlv5_freeze) before opening the formal phase';
    end if;
  else
    if ph <> 'OPEN' then
      raise exception 'the v5 formal phase is not open (status %)', ph;
    end if;
    if new.event_type = 'FORMAL_CLOSED_COMPLETE' then
      select count(*) into n_open from public.tlv5_assignments a
      where a.mode = 'FORMAL' and not exists (select 1 from public.tlv5_submissions s where s.assignment_id = a.assignment_id);
      if n_open > 0 then
        raise exception '% FORMAL assignments have no submission; close as FORMAL_CLOSED_INCOMPLETE instead', n_open;
      end if;
    end if;
  end if;
  new.occurred_at := now();
  return new;
end $$;

create function private.tlv5_cases_before_insert() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform private.assert_tlv5_packet_blinded(new.packet);
  new.packet_sha256 := private.sha256_hex(new.packet::text);
  if new.mode in ('FORMAL', 'CALIBRATION') then
    if not private.tlv5_active() then
      raise exception 'activate design v5 before importing % cases', new.mode;
    end if;
    if private.tlv5_frozen() then
      raise exception 'the v5 sample is frozen; % case % cannot be added', new.mode, new.case_id;
    end if;
  end if;
  return new;
end $$;

create function private.tlv5_case_design_before_insert() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.mode = 'FORMAL' and private.tlv5_frozen() then
    raise exception 'the v5 sample is frozen; design rows cannot be added';
  end if;
  return new;
end $$;

create function private.tlv5_frozen_labels_before_insert() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.mode = 'FORMAL' then
    if not private.tlv5_active() then
      raise exception 'activate design v5 before importing frozen labels';
    end if;
    if private.tlv5_frozen() then
      raise exception 'labels are frozen; an ontology, mapping or rule change after the freeze cannot alter them';
    end if;
  end if;
  if exists (select 1 from public.tlv5_frozen_labels f where f.mode = new.mode and f.label_set_id <> new.label_set_id) then
    raise exception 'one label set per mode; % differs from the label set already imported', new.label_set_id;
  end if;
  if not exists (select 1 from public.tlv5_case_design d where d.case_id = new.case_id) then
    raise exception 'case % has no design row; import the case with its design first', new.case_id;
  end if;
  new.row_sha256 := private.sha256_hex(private.tlv5_label_row_text(new.label_set_id, new.case_id, new.item_code,
                      new.label_primary, new.label_secondary, new.label_informational));
  new.imported_at := now();
  return new;
end $$;

create function private.tlv5_assignments_before_insert() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  rv record;
  other_slot smallint;
begin
  select r.mode_scope, r.withdrawn_at, u.is_active, u.role into rv
  from public.reviewers r join public.users u on u.user_id = r.user_id
  where r.reviewer_pseudo_id = new.reviewer_pseudo_id;
  if rv.withdrawn_at is not null or not coalesce(rv.is_active, false) then
    raise exception 'reviewer % is withdrawn or inactive', new.reviewer_pseudo_id;
  end if;
  if (new.mode = 'PILOT') <> (rv.mode_scope = 'PILOT') then
    raise exception 'mode contamination blocked: % reviewer % cannot be assigned a % case', rv.mode_scope, new.reviewer_pseudo_id, new.mode;
  end if;
  if new.mode = 'FORMAL' then
    if not private.tlv5_frozen() then
      raise exception 'design v5: FORMAL assignments open only after rpc_tlv5_freeze';
    end if;
    if private.tlv5_phase() <> 'OPEN' then
      raise exception 'design v5: FORMAL assignments need the formal phase open (status %)', private.tlv5_phase();
    end if;
  elsif new.mode = 'CALIBRATION' and private.tlv5_frozen() then
    raise exception 'rubric calibration closes at the freeze';
  end if;
  select a.reviewer_slot into other_slot from public.tlv5_assignments a
  where a.reviewer_pseudo_id = new.reviewer_pseudo_id and a.mode = new.mode and a.reviewer_slot <> new.reviewer_slot limit 1;
  if other_slot is not null then
    raise exception 'reviewer % already holds slot %; a reviewer keeps one slot for all cases of a mode', new.reviewer_pseudo_id, other_slot;
  end if;
  return new;
end $$;

create function private.tlv5_submissions_before_insert() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  prev integer;
begin
  if new.mode = 'FORMAL' and private.tlv5_phase() <> 'OPEN' then
    raise exception 'the v5 formal phase is not open for submissions (status %)', private.tlv5_phase();
  end if;
  if new.mode = 'CALIBRATION' and private.tlv5_frozen() then
    raise exception 'rubric calibration closed at the freeze';
  end if;
  if new.mode = 'PILOT' and private.tlv5_locked('PILOT') then
    raise exception 'the pilot reference is locked; pilot submissions are closed';
  end if;
  select max(s.revision_number) into prev from public.tlv5_submissions s where s.assignment_id = new.assignment_id;
  new.revision_number := coalesce(prev, 0) + 1;
  new.submitted_at := now();
  return new;
end $$;

-- Subgroup items are accepted only when the same submission answers the matching condition row YES.
create function private.tlv5_submission_items_before_insert() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  row_item text;
begin
  row_item := case new.item_code when 'SG_DIABETES_TYPE' then 'FIG2_ROW_DIAB'
                                 when 'SG_NEOPLASM_MALIGNANCY' then 'FIG2_ROW_CAN_ALL' end;
  if row_item is not null and not exists (
       select 1 from public.tlv5_submission_items i
       where i.submission_id = new.submission_id and i.item_code = row_item and i.answer = 'YES') then
    raise exception 'item % is shown only when the reviewer answers % YES in the same submission', new.item_code, row_item;
  end if;
  if new.detail_code = 'OTHER_SPECIFIED' and coalesce(length(trim(new.note)), 0) = 0 then
    raise exception 'detail OTHER_SPECIFIED needs a note that specifies it (item %)', new.item_code;
  end if;
  return new;
end $$;

create function private.tlv5_adjudications_before_insert() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  r_role text;
  n integer;
  n_distinct integer;
begin
  select u.role into r_role from public.users u where u.user_id = new.decided_by;
  if new.mode = 'FORMAL' then
    if r_role is distinct from 'ADJUDICATOR' then
      raise exception 'only the ADJUDICATOR role adjudicates FORMAL v5 items; an investigator never enters a FORMAL judgment';
    end if;
    if private.tlv5_phase() <> 'CLOSED' then
      raise exception 'FORMAL adjudication opens only after the v5 formal phase closes';
    end if;
    if not private.tlv5_snapshot_taken() then
      raise exception 'take the independent-judgment snapshot (rpc_tlv5_snapshot) before any FORMAL adjudication';
    end if;
  else
    if r_role not in ('INVESTIGATOR', 'ADJUDICATOR') then
      raise exception 'pilot items are adjudicated by the investigator or an ADJUDICATOR';
    end if;
  end if;
  if exists (select 1 from public.tlv5_assignments a join public.reviewers rv on rv.reviewer_pseudo_id = a.reviewer_pseudo_id
             where a.case_id = new.case_id and rv.user_id = new.decided_by) then
    raise exception 'conflict: the adjudicator reviewed case %', new.case_id;
  end if;
  select count(*), count(distinct x.answer || '|' || coalesce(x.detail_code, '')) into n, n_distinct
  from private.tlv5_item_answers(new.case_id, new.item_code) x;
  if n = 0 then
    raise exception 'item %/% has no reviewer answer to adjudicate', new.case_id, new.item_code;
  elsif n = 1 then
    if new.status not in ('SINGLE_REVIEW_ADJUDICATED', 'UNRESOLVED_ESCALATED') then
      raise exception 'a single-reviewed item is SINGLE_REVIEW_ADJUDICATED or UNRESOLVED_ESCALATED';
    end if;
  elsif n_distinct = 1 then
    if private.tlv5_scope() = 'DISAGREEMENTS_ONLY' and not private.tlv5_locked(new.mode) then
      raise exception 'adjudication scope DISAGREEMENTS_ONLY: concordant items enter the reference by rule';
    end if;
    if new.status not in ('CONCORDANT_CONFIRMED', 'CONCORDANT_REVISED', 'UNRESOLVED_ESCALATED') then
      raise exception 'the reviewers agree on this item; status % does not fit', new.status;
    end if;
  else
    if new.status not in ('DISCORDANT_RESOLVED', 'UNRESOLVED_ESCALATED') then
      raise exception 'the reviewers disagree on this item; status % does not fit', new.status;
    end if;
    if new.disagreement_reason_code is null then
      raise exception 'a discordant item needs a disagreement reason code';
    end if;
  end if;
  new.adjudicator_role := r_role;
  new.adjudication_blinded := (r_role = 'ADJUDICATOR');
  new.post_unblinding := private.tlv5_locked(new.mode);
  new.decided_at := now();
  return new;
end $$;

create trigger tlv5_activation_before_insert before insert on public.tlv5_activation
  for each row execute function private.tlv5_activation_before_insert();
create trigger design_activation_v4_v5_guard before insert on public.design_activation_v4
  for each row execute function private.design_activation_v4_v5_guard();
create trigger cases_v5_guard before insert on public.cases
  for each row execute function private.cases_v5_guard();
create trigger tlv5_phase_events_before_insert before insert on public.tlv5_phase_events
  for each row execute function private.tlv5_phase_events_before_insert();
create trigger tlv5_cases_before_insert before insert on public.tlv5_cases
  for each row execute function private.tlv5_cases_before_insert();
create trigger tlv5_case_design_before_insert before insert on public.tlv5_case_design
  for each row execute function private.tlv5_case_design_before_insert();
create trigger tlv5_frozen_labels_before_insert before insert on public.tlv5_frozen_labels
  for each row execute function private.tlv5_frozen_labels_before_insert();
create trigger tlv5_assignments_before_insert before insert on public.tlv5_assignments
  for each row execute function private.tlv5_assignments_before_insert();
create trigger tlv5_submissions_before_insert before insert on public.tlv5_submissions
  for each row execute function private.tlv5_submissions_before_insert();
create trigger tlv5_submission_items_before_insert before insert on public.tlv5_submission_items
  for each row execute function private.tlv5_submission_items_before_insert();
create trigger tlv5_adjudications_before_insert before insert on public.tlv5_adjudications
  for each row execute function private.tlv5_adjudications_before_insert();

-- Audit: submissions and their items as identifiers and a hash only; every other v5 row in full.
create function private.audit_row_tlv5() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  rec jsonb := to_jsonb(coalesce(new, old));
  pk text;
  details jsonb;
  m text;
begin
  pk := coalesce(rec ->> 'submission_id', rec ->> 'adjudication_id', rec ->> 'assignment_id', rec ->> 'label_id',
                 rec ->> 'freeze_id', rec ->> 'snapshot_id', rec ->> 'lock_id', rec ->> 'export_id', rec ->> 'event_id',
                 rec ->> 'activation_id', rec ->> 'case_id');
  if tg_table_name = 'tlv5_submissions' then
    details := jsonb_build_object('case_id', rec ->> 'case_id', 'assignment_id', rec ->> 'assignment_id',
                                  'reviewer_pseudo_id', rec ->> 'reviewer_pseudo_id', 'revision_number', rec ->> 'revision_number',
                                  'content_sha256', rec ->> 'content_sha256');
  elsif tg_table_name = 'tlv5_submission_items' then
    details := jsonb_build_object('submission_id', rec ->> 'submission_id', 'content_sha256', private.sha256_hex(rec::text));
  else
    details := rec;
  end if;
  m := case when rec ->> 'mode' in ('PILOT', 'FORMAL') then rec ->> 'mode' end;
  insert into public.audit_log (actor_user_id, actor_role, action, entity_table, entity_id, mode, details)
  values (private.app_user_id(), coalesce(private.app_role(), current_user), tg_op, tg_table_name, pk, m, details);
  return null;
end $$;

do $$
declare
  t text;
begin
  foreach t in array array['tlv5_activation', 'tlv5_phase_events', 'tlv5_cases', 'tlv5_case_design', 'tlv5_frozen_labels',
                           'tlv5_freeze', 'tlv5_assignments', 'tlv5_submissions', 'tlv5_submission_items', 'tlv5_snapshot',
                           'tlv5_adjudications', 'tlv5_reference_locks', 'tlv5_exports']
  loop
    execute format('create trigger %I before update or delete on public.%I for each row execute function private.reject_mutation()',
                   t || '_append_only', t);
    execute format('create trigger %I before truncate on public.%I for each statement execute function private.reject_mutation()',
                   t || '_no_truncate', t);
    execute format('create trigger %I after insert on public.%I for each row execute function private.audit_row_tlv5()',
                   t || '_audit', t);
    execute format('alter table public.%I enable row level security', t);
  end loop;
end $$;

-- -----------------------------------------------------------------------------
-- 5. Row-level security (reads only; every write goes through rpc_tlv5_*)
-- -----------------------------------------------------------------------------
create policy tlv5_activation_inv on public.tlv5_activation for select to authenticated using (private.is_investigator());
create policy tlv5_phase_events_read on public.tlv5_phase_events for select to authenticated
  using (private.is_investigator() or private.is_adjudicator());
create policy tlv5_cases_read on public.tlv5_cases for select to authenticated
  using (private.is_investigator() or private.tlv5_is_assigned(case_id)
         or (private.is_adjudicator() and (mode = 'PILOT' or (mode = 'FORMAL' and private.tlv5_phase() = 'CLOSED'
                                                               and private.tlv5_snapshot_taken()))));
create policy tlv5_case_design_inv on public.tlv5_case_design for select to authenticated using (private.is_investigator());
create policy tlv5_frozen_labels_inv on public.tlv5_frozen_labels for select to authenticated using (private.is_investigator());
create policy tlv5_freeze_inv on public.tlv5_freeze for select to authenticated using (private.is_investigator());
create policy tlv5_assignments_read on public.tlv5_assignments for select to authenticated
  using (private.is_investigator() or reviewer_pseudo_id = private.my_reviewer_pseudo_id()
         or (private.is_adjudicator() and mode <> 'CALIBRATION' and private.tlv5_can_read_answers(mode)));
create policy tlv5_submissions_read on public.tlv5_submissions for select to authenticated
  using (reviewer_pseudo_id = private.my_reviewer_pseudo_id() or private.tlv5_can_read_answers(mode));
create policy tlv5_submission_items_read on public.tlv5_submission_items for select to authenticated
  using (exists (select 1 from public.tlv5_submissions s where s.submission_id = tlv5_submission_items.submission_id
                 and (s.reviewer_pseudo_id = private.my_reviewer_pseudo_id() or private.tlv5_can_read_answers(s.mode))));
create policy tlv5_snapshot_inv on public.tlv5_snapshot for select to authenticated using (private.is_investigator());
create policy tlv5_adjudications_read on public.tlv5_adjudications for select to authenticated
  using (private.is_investigator() or (private.is_adjudicator() and decided_by = private.app_user_id()));
create policy tlv5_reference_locks_read on public.tlv5_reference_locks for select to authenticated
  using (private.is_investigator() or private.is_adjudicator());
create policy tlv5_exports_inv on public.tlv5_exports for select to authenticated using (private.is_investigator());

-- -----------------------------------------------------------------------------
-- 6. RPCs
-- -----------------------------------------------------------------------------
create function public.rpc_tlv5_phase(p_event_type text, p jsonb default '{}'::jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := private.assert_investigator();
  eid uuid;
begin
  insert into public.tlv5_phase_events (event_type, checklist_version, checklist_sha256, app_git_sha, pilot_export_id, attestation, actor)
  values (p_event_type, p ->> 'checklist_version', lower(p ->> 'checklist_sha256'), p ->> 'app_git_sha',
          nullif(p ->> 'pilot_export_id', '')::uuid, p ->> 'attestation', me)
  returning event_id into eid;
  return eid;
end $$;

create function public.rpc_tlv5_activate(p_design_version text, p_adjudication_scope text, p_attestation text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := private.assert_investigator();
  aid uuid;
begin
  insert into public.tlv5_activation (design_version, adjudication_scope, attestation, activated_by)
  values (p_design_version, p_adjudication_scope, p_attestation, me) returning activation_id into aid;
  return aid;
end $$;

-- FORMAL reviewer enrolment for v5: after the v5 pilot sign-off (the v2 path still requires the v2 unlock).
create function public.rpc_tlv5_enroll_reviewer(p_user_id uuid, p_qualifications text default null) returns text
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := private.assert_investigator();
  pid text;
  alphabet text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  i int;
begin
  if not private.tlv5_pilot_signed_off() then
    raise exception 'FORMAL v5 reviewers are enrolled only after the v5 pilot sign-off';
  end if;
  loop
    pid := 'R-';
    for i in 1..4 loop
      pid := pid || substr(alphabet, 1 + (get_byte(extensions.gen_random_bytes(1), 0) % length(alphabet)), 1);
    end loop;
    exit when not exists (select 1 from public.reviewers where reviewer_pseudo_id = pid);
  end loop;
  insert into public.reviewers (reviewer_pseudo_id, user_id, mode_scope, qualifications_summary, enrolled_by)
  values (pid, p_user_id, 'FORMAL', p_qualifications, me);
  return pid;
end $$;

-- One case: packet (reviewer-visible) and, for PILOT and FORMAL, the investigator-only design row.
create function public.rpc_tlv5_import_case(p jsonb) returns text
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := private.assert_investigator();
  m text := p ->> 'mode';
  d jsonb := p -> 'design';
begin
  insert into public.tlv5_cases (case_id, mode, record_category, packet, packet_sha256, created_by)
  values (p ->> 'case_id', m, case m when 'PILOT' then 'SYNTHETIC_PILOT' when 'CALIBRATION' then 'RUBRIC_CALIBRATION'
                                   else 'LABEL_VERIFICATION_FORMAL' end, p -> 'packet', repeat('0', 64), me);
  if m in ('PILOT', 'FORMAL') then
    if d is null then
      raise exception 'PILOT and FORMAL cases need a design row';
    end if;
    insert into public.tlv5_case_design (case_id, mode, nct_id, frame, stratum, variance_stratum, frame_stratum_size,
      n_sampled_in_stratum, selection_probability, sampling_seed, prn, design_version, in_mixed_sex_cohort, figure2_rows,
      dev_linked, tier1_eligible, design_row_sha256, imported_by)
    values (p ->> 'case_id', m, d ->> 'nct_id', d ->> 'frame', d ->> 'stratum', coalesce(d ->> 'variance_stratum', d ->> 'stratum'),
      (d ->> 'frame_stratum_size')::integer, (d ->> 'n_sampled_in_stratum')::integer, (d ->> 'selection_probability')::numeric,
      (d ->> 'sampling_seed')::bigint, (d ->> 'prn')::numeric, d ->> 'design_version', (d ->> 'in_mixed_sex_cohort')::boolean,
      d ->> 'figure2_rows', (d ->> 'dev_linked')::boolean, (d ->> 'tier1_eligible')::boolean, private.sha256_hex(d::text), me);
  end if;
  return p ->> 'case_id';
end $$;

create function public.rpc_tlv5_import_frozen_labels(p jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := private.assert_investigator();
  n integer;
begin
  insert into public.tlv5_frozen_labels (label_set_id, case_id, mode, item_code, label_primary, label_secondary,
    label_informational, dev_linked_area, row_sha256, imported_by)
  select x ->> 'label_set_id', x ->> 'case_id', c.mode, x ->> 'item_code', x ->> 'label_primary',
         nullif(x ->> 'label_secondary', ''), nullif(x ->> 'label_informational', ''),
         nullif(x ->> 'dev_linked_area', '')::boolean, repeat('0', 64), me
  from jsonb_array_elements(p) x
  join public.tlv5_cases c on c.case_id = x ->> 'case_id';
  get diagnostics n = row_count;
  if n <> jsonb_array_length(p) then
    raise exception 'frozen-label import: % of % rows matched a v5 case', n, jsonb_array_length(p);
  end if;
  return n;
end $$;

-- The single freeze. Every FORMAL case needs a design row and its 17 area and row labels.
create function public.rpc_tlv5_freeze(p jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := private.assert_investigator();
  n_cases integer;
  n_missing integer;
  n_labels integer;
  lst text;
  bad text;
  fid uuid;
begin
  if not private.tlv5_active() then
    raise exception 'activate design v5 first';
  end if;
  if private.tlv5_frozen() then
    raise exception 'the v5 freeze has already happened';
  end if;
  select count(*) into n_missing from public.tlv5_cases c
  where c.mode = 'FORMAL' and not exists (select 1 from public.tlv5_case_design d where d.case_id = c.case_id);
  if n_missing > 0 then
    raise exception '% FORMAL cases have no design row', n_missing;
  end if;
  select count(*) into n_missing from public.tlv5_cases c
  cross join lateral (select unnest(array['AREA_ONCOLOGY', 'AREA_CARDIOVASCULAR', 'AREA_MENTAL_HEALTH', 'AREA_INFECTIOUS',
                                          'AREA_METABOLIC', 'AREA_NEUROLOGICAL', 'AREA_RESPIRATORY', 'FIG2_ROW_CAN_ALL',
                                          'FIG2_ROW_DIAB', 'FIG2_ROW_DEP', 'FIG2_ROW_OBE', 'FIG2_ROW_AST', 'FIG2_ROW_COPD',
                                          'FIG2_ROW_COV', 'FIG2_ROW_SCZ', 'FIG2_ROW_HTN', 'FIG2_ROW_PAIN']) as it) i
  where c.mode = 'FORMAL'
    and not exists (select 1 from public.tlv5_frozen_labels f where f.case_id = c.case_id and f.item_code = i.it);
  if n_missing > 0 then
    raise exception '% required area or row labels are missing', n_missing;
  end if;
  if jsonb_typeof(coalesce(p -> 'frozen_items', 'null'::jsonb)) <> 'object' then
    raise exception 'frozen_items must be an object of SHA-256 values';
  end if;
  select e.key into bad from jsonb_each_text(p -> 'frozen_items') e where e.value !~ '^[0-9a-f]{64}$' limit 1;
  if bad is not null then
    raise exception 'frozen item % is not a SHA-256 value', bad;
  end if;
  select count(*), string_agg(c.case_id, E'\n' order by c.case_id collate "C") into n_cases, lst
  from public.tlv5_cases c where c.mode = 'FORMAL';
  if n_cases = 0 then
    raise exception 'no FORMAL v5 cases to freeze';
  end if;
  select count(*) into n_labels from public.tlv5_frozen_labels f where f.mode = 'FORMAL';
  insert into public.tlv5_freeze (design_version, adjudication_scope, n_cases, case_list_sha256, n_label_rows, label_rows_sha256,
    label_file_sha256, frozen_items, attestation, frozen_by)
  values ((select a.design_version from public.tlv5_activation a), private.tlv5_scope(), n_cases, private.sha256_hex(lst),
    n_labels, private.tlv5_label_rows_sha256('FORMAL'), lower(p ->> 'label_file_sha256'), p -> 'frozen_items',
    p ->> 'attestation', me)
  returning freeze_id into fid;
  return fid;
end $$;

create function public.rpc_tlv5_verify_frozen_labels()
returns table (matches boolean, frozen_sha256 text, current_sha256 text, frozen_rows integer, current_rows integer)
language plpgsql security definer set search_path = '' as $$
begin
  perform private.assert_investigator();
  return query select f.label_rows_sha256 = private.tlv5_label_rows_sha256('FORMAL')
                        and f.n_label_rows = (select count(*)::integer from public.tlv5_frozen_labels l where l.mode = 'FORMAL'),
                      f.label_rows_sha256, private.tlv5_label_rows_sha256('FORMAL'), f.n_label_rows,
                      (select count(*)::integer from public.tlv5_frozen_labels l where l.mode = 'FORMAL')
               from public.tlv5_freeze f;
end $$;

-- Reviewer-specific order: md5(seed:reviewer:case); the seed is recorded on every assignment.
create function public.rpc_tlv5_assign(p_mode text, p_reviewer_pseudo_id text, p_slot integer, p_case_ids text[], p_seed bigint)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  me uuid := private.assert_investigator();
  start_pos integer;
  n integer;
begin
  select coalesce(max(queue_position), 0) into start_pos from public.tlv5_assignments
  where reviewer_pseudo_id = p_reviewer_pseudo_id and mode = p_mode;
  insert into public.tlv5_assignments (case_id, mode, reviewer_pseudo_id, reviewer_slot, queue_position, randomization_seed, assigned_by)
  select x.c, p_mode, p_reviewer_pseudo_id, p_slot::smallint,
         start_pos + row_number() over (order by md5(p_seed::text || ':' || p_reviewer_pseudo_id || ':' || x.c)), p_seed, me
  from unnest(p_case_ids) as x(c);
  get diagnostics n = row_count;
  return n;
end $$;

-- One submission: header plus every item (7 area items, 10 condition-row items, and each subgroup item whose
-- condition row is answered YES). Refused as a whole when anything is missing or out of scale.
create function public.rpc_tlv5_submit(p_assignment_id uuid, p jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  me text := private.my_reviewer_pseudo_id();
  a record;
  sid uuid;
  n_area integer;
  n_row integer;
  need_d boolean;
  need_k boolean;
  have_d boolean;
  have_k boolean;
  n_items integer;
begin
  select * into a from public.tlv5_assignments where assignment_id = p_assignment_id;
  if me is null or a.reviewer_pseudo_id is distinct from me then
    raise exception 'not your v5 assignment' using errcode = '42501';
  end if;
  if jsonb_typeof(coalesce(p -> 'items', 'null'::jsonb)) <> 'array' then
    raise exception 'items must be an array';
  end if;
  insert into public.tlv5_submissions (assignment_id, case_id, mode, reviewer_pseudo_id, revision_number, overall_comment,
    packet_issue_flag, packet_issue_note, seconds_on_case, n_items, content_sha256)
  values (p_assignment_id, a.case_id, a.mode, me, 1, p ->> 'overall_comment', coalesce((p ->> 'packet_issue_flag')::boolean, false),
    p ->> 'packet_issue_note', (p ->> 'seconds_on_case')::integer, jsonb_array_length(p -> 'items'),
    private.sha256_hex((p -> 'items')::text))
  returning submission_id into sid;
  -- area and condition-row items first, subgroup items after (the item trigger checks the row answer)
  insert into public.tlv5_submission_items (submission_id, item_code, answer, uncertain, note, detail_code)
  select sid, x ->> 'item_code', x ->> 'answer', coalesce((x ->> 'uncertain')::boolean, false), x ->> 'note', nullif(x ->> 'detail_code', '')
  from jsonb_array_elements(p -> 'items') x
  where private.tlv5_item_family(x ->> 'item_code') in ('AREA', 'FIG2_ROW');
  insert into public.tlv5_submission_items (submission_id, item_code, answer, uncertain, note, detail_code)
  select sid, x ->> 'item_code', x ->> 'answer', coalesce((x ->> 'uncertain')::boolean, false), x ->> 'note', nullif(x ->> 'detail_code', '')
  from jsonb_array_elements(p -> 'items') x
  where coalesce(private.tlv5_item_family(x ->> 'item_code'), 'UNKNOWN') not in ('AREA', 'FIG2_ROW');
  select count(*) filter (where private.tlv5_item_family(i.item_code) = 'AREA'),
         count(*) filter (where private.tlv5_item_family(i.item_code) = 'FIG2_ROW'),
         bool_or(i.item_code = 'FIG2_ROW_DIAB' and i.answer = 'YES'),
         bool_or(i.item_code = 'FIG2_ROW_CAN_ALL' and i.answer = 'YES'),
         bool_or(i.item_code = 'SG_DIABETES_TYPE'), bool_or(i.item_code = 'SG_NEOPLASM_MALIGNANCY'), count(*)
  into n_area, n_row, need_d, need_k, have_d, have_k, n_items
  from public.tlv5_submission_items i where i.submission_id = sid;
  if n_area <> 7 or n_row <> 10 then
    raise exception 'a v5 submission answers all 7 area items and all 10 condition-row items (got % and %)', n_area, n_row;
  end if;
  if coalesce(need_d, false) <> coalesce(have_d, false) or coalesce(need_k, false) <> coalesce(have_k, false) then
    raise exception 'subgroup items: answer the diabetes type when the diabetes row is YES and the malignancy item when the neoplasms row is YES, and only then';
  end if;
  if n_items <> jsonb_array_length(p -> 'items') then
    raise exception 'duplicate or unknown items in the submission';
  end if;
  return sid;
end $$;

-- Completion counts while the phase is open: no answer content.
create function public.rpc_tlv5_completion_summary(p_mode text)
returns table (reviewer_pseudo_id text, reviewer_slot smallint, n_assigned bigint, n_submitted bigint, n_with_revisions bigint)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.assert_investigator();
  return query
  select a.reviewer_pseudo_id, min(a.reviewer_slot), count(*),
         count(*) filter (where exists (select 1 from public.tlv5_submissions s where s.assignment_id = a.assignment_id)),
         count(*) filter (where (select count(*) from public.tlv5_submissions s where s.assignment_id = a.assignment_id) > 1)
  from public.tlv5_assignments a where a.mode = p_mode group by a.reviewer_pseudo_id order by 2;
end $$;

create function public.rpc_tlv5_record_adjudication(p jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := private.app_user_id();
  m text;
  jid uuid;
begin
  if not (private.is_investigator() or private.is_adjudicator()) then
    raise exception 'investigator (multi-factor session) or ADJUDICATOR role is needed to adjudicate' using errcode = '42501';
  end if;
  select c.mode into m from public.tlv5_cases c where c.case_id = p ->> 'case_id';
  if m is null or m = 'CALIBRATION' then
    raise exception 'case % is not a PILOT or FORMAL v5 case', p ->> 'case_id';
  end if;
  insert into public.tlv5_adjudications (case_id, mode, item_code, decision, detail_code, status, basis, rationale,
    disagreement_reason_code, decided_by)
  values (p ->> 'case_id', m, p ->> 'item_code', p ->> 'decision', nullif(p ->> 'detail_code', ''), p ->> 'status',
    p ->> 'basis', p ->> 'rationale', p ->> 'disagreement_reason_code', me)
  returning adjudication_id into jid;
  return jid;
end $$;

-- Reference lock (once per mode): every item the scope requires has a blinded adjudication.
create function public.rpc_tlv5_lock_reference(p_mode text, p_attestation text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := private.assert_investigator();
  n_missing integer;
  n_items integer;
  lid uuid;
begin
  if p_mode = 'FORMAL' and (private.tlv5_phase() <> 'CLOSED' or not private.tlv5_snapshot_taken()) then
    raise exception 'the FORMAL reference is locked only after the close and the snapshot';
  end if;
  with ci as (
    select c.case_id, i.it as item_code
    from public.tlv5_cases c cross join lateral private.tlv5_reviewer_items() as i(it)
    where c.mode = p_mode
  ), lv as (
    select ci.case_id, ci.item_code,
           (select count(*) from private.tlv5_item_answers(ci.case_id, ci.item_code)) as n_ans,
           (select count(distinct x.answer || '|' || coalesce(x.detail_code, '')) from private.tlv5_item_answers(ci.case_id, ci.item_code) x) as n_dist
    from ci
  )
  select count(*) filter (where lv.n_ans >= 1 and (lv.n_ans = 1 or lv.n_dist > 1 or private.tlv5_scope() = 'ALL_ITEMS')
                            and not exists (select 1 from public.tlv5_adjudications j where j.case_id = lv.case_id
                                            and j.item_code = lv.item_code and not j.post_unblinding)),
         count(*) filter (where lv.n_ans >= 1)
  into n_missing, n_items from lv;
  if n_missing > 0 then
    raise exception '% items that the adjudication scope requires have no adjudication; the reference cannot be locked', n_missing;
  end if;
  insert into public.tlv5_reference_locks (mode, n_items_locked, attestation, locked_by)
  values (p_mode, n_items, p_attestation, me) returning lock_id into lid;
  return lid;
end $$;

create function public.rpc_tlv5_register_export(p jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := private.assert_investigator();
  eid uuid;
begin
  if not private.tlv5_locked(p ->> 'mode') then
    raise exception 'a v5 % bundle is registered only after that reference is locked', p ->> 'mode';
  end if;
  insert into public.tlv5_exports (mode, bundle_format_version, row_counts, file_sha256, manifest_sha256, app_git_sha, created_by, notes)
  values (p ->> 'mode', p ->> 'bundle_format_version', coalesce(p -> 'row_counts', '{}'::jsonb), coalesce(p -> 'file_sha256', '{}'::jsonb),
          lower(p ->> 'manifest_sha256'), p ->> 'app_git_sha', me, p ->> 'notes')
  returning export_id into eid;
  return eid;
end $$;

-- -----------------------------------------------------------------------------
-- 7. Views (security_invoker: the underlying RLS applies; exports are investigator only)
-- -----------------------------------------------------------------------------
create view public.v_tlv5_my_queue with (security_invoker = true) as
select a.assignment_id, a.case_id, a.mode, a.queue_position,
       (select count(*) from public.tlv5_submissions s where s.assignment_id = a.assignment_id) as n_submissions
from public.tlv5_assignments a
where a.reviewer_pseudo_id = private.my_reviewer_pseudo_id();

-- Independent judgments: one row per case x reviewer item x reviewer, initial and effective answers;
-- a subgroup item absent from a submission is NOT_APPLICABLE (state 3, never blank).
create view public.v_tlv5_independent_judgments with (security_invoker = true) as
with asg as (
  select a.assignment_id, a.case_id, a.mode, a.reviewer_slot, a.reviewer_pseudo_id,
         (select max(s.revision_number) from public.tlv5_submissions s where s.assignment_id = a.assignment_id) as max_rev
  from public.tlv5_assignments a
  where a.mode in ('PILOT', 'FORMAL')
), grid as (
  select g.*, i.it as item_code from asg g cross join lateral private.tlv5_reviewer_items() as i(it) where g.max_rev is not null
), first_s as (
  select s.assignment_id, s.submission_id, s.submitted_at from public.tlv5_submissions s where s.revision_number = 1
), last_s as (
  select s.assignment_id, s.submission_id, s.submitted_at from public.tlv5_submissions s
  where s.revision_number = (select max(s2.revision_number) from public.tlv5_submissions s2 where s2.assignment_id = s.assignment_id)
)
select c.record_category, gr.case_id, gr.mode, d.nct_id, private.tlv5_item_family(gr.item_code) as item_family, gr.item_code,
       gr.reviewer_slot, gr.reviewer_pseudo_id,
       coalesce(fi.answer, 'NOT_APPLICABLE') as answer_initial,
       coalesce(li.answer, 'NOT_APPLICABLE') as answer_effective_preclose,
       fi.detail_code as detail_initial, li.detail_code as detail_effective, gr.max_rev - 1 as n_revisions_preclose,
       coalesce(li.uncertain, false) as uncertain,
       (select bool_or(s.packet_issue_flag) from public.tlv5_submissions s where s.assignment_id = gr.assignment_id) as packet_issue_flag,
       fs.submitted_at as first_submitted_at, ls.submitted_at as last_submitted_at
from grid gr
join public.tlv5_cases c on c.case_id = gr.case_id
left join public.tlv5_case_design d on d.case_id = gr.case_id
join first_s fs on fs.assignment_id = gr.assignment_id
join last_s ls on ls.assignment_id = gr.assignment_id
left join public.tlv5_submission_items fi on fi.submission_id = fs.submission_id and fi.item_code = gr.item_code
left join public.tlv5_submission_items li on li.submission_id = ls.submission_id and li.item_code = gr.item_code
where private.is_investigator() and (gr.mode = 'PILOT' or private.tlv5_phase() = 'CLOSED');

create function private.tlv5_judgments_text(out n integer, out txt text)
language sql stable security definer set search_path = '' as $$
  select count(*)::integer,
         string_agg(concat_ws('|', v.case_id, v.item_code, v.reviewer_slot::text, v.reviewer_pseudo_id, v.answer_initial,
                              v.answer_effective_preclose, coalesce(v.detail_initial, ''), coalesce(v.detail_effective, ''),
                              v.n_revisions_preclose::text,
                              v.uncertain::text,
                              to_char(v.first_submitted_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
                              to_char(v.last_submitted_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')),
                    E'\n' order by v.case_id collate "C", v.item_code collate "C", v.reviewer_slot)
  from public.v_tlv5_independent_judgments v where v.mode = 'FORMAL'
$$;

create function public.rpc_tlv5_snapshot() returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := private.assert_investigator();
  n integer;
  txt text;
  sid uuid;
begin
  if private.tlv5_phase() <> 'CLOSED' then
    raise exception 'the v5 snapshot is taken after the formal phase closes';
  end if;
  if exists (select 1 from public.tlv5_adjudications j where j.mode = 'FORMAL') then
    raise exception 'a FORMAL adjudication exists; the independent judgments must be snapshotted before adjudication';
  end if;
  select t.n, t.txt into n, txt from private.tlv5_judgments_text() t;
  insert into public.tlv5_snapshot (n_rows, content_sha256, taken_by) values (n, private.sha256_hex(coalesce(txt, '')), me)
  returning snapshot_id into sid;
  return sid;
end $$;

create function public.rpc_tlv5_verify_snapshot()
returns table (matches boolean, snapshot_sha256 text, current_sha256 text, snapshot_rows integer, current_rows integer)
language plpgsql security definer set search_path = '' as $$
declare
  cur_n integer;
  cur_txt text;
begin
  perform private.assert_investigator();
  select t.n, t.txt into cur_n, cur_txt from private.tlv5_judgments_text() t;
  return query select s.content_sha256 = private.sha256_hex(coalesce(cur_txt, '')) and s.n_rows = cur_n,
                      s.content_sha256, private.sha256_hex(coalesce(cur_txt, '')), s.n_rows, cur_n
               from public.tlv5_snapshot s;
end $$;

-- Adjudicated reference: one row per case x reviewer item, after the lock of that mode. Concordant items
-- enter by rule under DISAGREEMENTS_ONLY; a subgroup item that no reviewer was shown is NOT_APPLICABLE by
-- rule; a case that no reviewer submitted is NOT_REVIEWED (no reference answer; never NOT_APPLICABLE).
-- Concordance compares the answer and the detail code together, so a concordant item carries both.
create view public.v_tlv5_adjudicated_reference with (security_invoker = true) as
with ci as (
  select c.case_id, c.mode, c.record_category, i.it as item_code, private.tlv5_n_reviewed(c.case_id) as n_rev
  from public.tlv5_cases c cross join lateral private.tlv5_reviewer_items() as i(it)
  where c.mode in ('PILOT', 'FORMAL')
), ans as (
  select ci.*, (select count(*) from private.tlv5_item_answers(ci.case_id, ci.item_code)) as n_ans,
         (select count(distinct x.answer || '|' || coalesce(x.detail_code, '')) from private.tlv5_item_answers(ci.case_id, ci.item_code) x) as n_dist,
         (select min(x.answer) from private.tlv5_item_answers(ci.case_id, ci.item_code) x) as shared,
         (select min(x.detail_code) from private.tlv5_item_answers(ci.case_id, ci.item_code) x) as shared_detail
  from ci
), ref as (
  select distinct on (j.case_id, j.item_code) j.* from public.tlv5_adjudications j where not j.post_unblinding
  order by j.case_id, j.item_code, j.decided_at desc
)
select ans.record_category, ans.case_id, ans.mode, private.tlv5_item_family(ans.item_code) as item_family, ans.item_code,
       case when ref.adjudication_id is not null then 'ADJ5-' || replace(ref.adjudication_id::text, '-', '')
            else 'RULE-' || ans.case_id || '-' || ans.item_code end as adjudication_id,
       case when ref.adjudication_id is not null then ref.decision
            when ans.n_rev = 0 then null
            when ans.n_ans = 2 and ans.n_dist = 1 then ans.shared
            when ans.n_ans = 0 then 'NOT_APPLICABLE' end as reference_answer,
       case when ref.adjudication_id is not null then ref.detail_code
            when ans.n_ans = 2 and ans.n_dist = 1 then ans.shared_detail end as reference_detail,
       case when ref.adjudication_id is not null then ref.status
            when ans.n_rev = 0 then 'NOT_REVIEWED'
            when ans.n_ans = 2 and ans.n_dist = 1 then 'CONCORDANT_ADOPTED_BY_RULE'
            when ans.n_ans = 0 then 'NOT_APPLICABLE_BY_RULE' end as adjudication_status,
       case when ref.adjudication_id is not null then ref.basis
            when ans.n_rev = 0 then 'NONE'
            when ans.n_ans = 2 and ans.n_dist = 1 then 'BOTH_REVIEWERS'
            when ans.n_ans = 0 then 'NONE' end as adjudication_basis,
       ans.n_rev as n_reviewers_submitted, ans.n_ans as n_reviewer_answers,
       ref.disagreement_reason_code,
       case when ref.adjudication_id is not null then 'A-' || upper(substr(md5(ref.decided_by::text), 1, 6)) else 'RULE' end
         as adjudicator_pseudo_id,
       case when ref.adjudication_id is not null then ref.adjudicator_role else 'RULE' end as adjudicator_role,
       coalesce(ref.adjudication_blinded, true) as adjudication_blinded,
       exists (select 1 from public.tlv5_adjudications k where k.case_id = ans.case_id and k.item_code = ans.item_code
               and k.post_unblinding) as post_unblinding_revision_exists,
       coalesce(ref.decided_at, lk.locked_at) as adjudicated_at, lk.lock_id as reference_lock_id
from ans
join public.tlv5_reference_locks lk on lk.mode = ans.mode
left join ref on ref.case_id = ans.case_id and ref.item_code = ans.item_code
where private.is_investigator();

-- Frozen labels with the sampling design, after the lock of that mode.
create view public.v_tlv5_frozen_labels with (security_invoker = true) as
select f.label_set_id, c.record_category, f.case_id, f.mode, d.nct_id, f.item_family, f.item_code, f.label_primary,
       f.label_secondary, f.label_informational, f.dev_linked_area, f.imported_at as label_frozen_at, d.frame, d.stratum,
       d.variance_stratum, d.frame_stratum_size, d.n_sampled_in_stratum, d.selection_probability, d.sampling_weight,
       d.dev_linked, d.tier1_eligible, d.design_version
from public.tlv5_frozen_labels f
join public.tlv5_cases c on c.case_id = f.case_id
join public.tlv5_case_design d on d.case_id = f.case_id
where private.is_investigator() and private.tlv5_locked(f.mode);

-- Adjudicator queue: items with at least one answer, both reviewers' answers side by side; never a label.
create view public.v_tlv5_adjudication_queue with (security_invoker = true) as
with ci as (
  select c.case_id, c.mode, i.it as item_code
  from public.tlv5_cases c cross join lateral private.tlv5_reviewer_items() as i(it)
  where c.mode in ('PILOT', 'FORMAL') and private.tlv5_can_read_answers(c.mode)
), x as (
  select ci.*,
         (select a.answer from private.tlv5_item_answers(ci.case_id, ci.item_code) a where a.reviewer_slot = 1) as reviewer_1_answer,
         (select a.detail_code from private.tlv5_item_answers(ci.case_id, ci.item_code) a where a.reviewer_slot = 1) as reviewer_1_detail,
         (select a.answer from private.tlv5_item_answers(ci.case_id, ci.item_code) a where a.reviewer_slot = 2) as reviewer_2_answer,
         (select a.detail_code from private.tlv5_item_answers(ci.case_id, ci.item_code) a where a.reviewer_slot = 2) as reviewer_2_detail
  from ci
)
select x.case_id, x.mode, x.item_code, x.reviewer_1_answer, x.reviewer_1_detail, x.reviewer_2_answer, x.reviewer_2_detail,
       ((x.reviewer_1_answer, x.reviewer_1_detail) is distinct from (x.reviewer_2_answer, x.reviewer_2_detail)) as needs_adjudication,
       exists (select 1 from public.tlv5_adjudications j where j.case_id = x.case_id and j.item_code = x.item_code) as adjudicated
from x
where (x.reviewer_1_answer is not null or x.reviewer_2_answer is not null)
  and (private.is_adjudicator() or private.is_investigator());

-- -----------------------------------------------------------------------------
-- 8. Grants (reads filtered by RLS, writes only through rpc_tlv5_*)
-- -----------------------------------------------------------------------------
revoke all on public.tlv5_activation, public.tlv5_phase_events, public.tlv5_cases, public.tlv5_case_design,
              public.tlv5_frozen_labels, public.tlv5_freeze, public.tlv5_assignments, public.tlv5_submissions,
              public.tlv5_submission_items, public.tlv5_snapshot, public.tlv5_adjudications, public.tlv5_reference_locks,
              public.tlv5_exports, public.v_tlv5_my_queue, public.v_tlv5_independent_judgments,
              public.v_tlv5_adjudicated_reference, public.v_tlv5_frozen_labels, public.v_tlv5_adjudication_queue
  from anon, authenticated;
grant select on public.tlv5_activation, public.tlv5_phase_events, public.tlv5_cases, public.tlv5_case_design,
                public.tlv5_frozen_labels, public.tlv5_freeze, public.tlv5_assignments, public.tlv5_submissions,
                public.tlv5_submission_items, public.tlv5_snapshot, public.tlv5_adjudications, public.tlv5_reference_locks,
                public.tlv5_exports, public.v_tlv5_my_queue, public.v_tlv5_independent_judgments,
                public.v_tlv5_adjudicated_reference, public.v_tlv5_frozen_labels, public.v_tlv5_adjudication_queue
  to authenticated;
revoke all on function private.tlv5_item_family(text), private.tlv5_answer_ok(text, text), private.tlv5_detail_ok(text, text, text),
                       private.tlv5_active(), private.tlv5_frozen(), private.tlv5_scope(), private.tlv5_pilot_signed_off(),
                       private.tlv5_phase(), private.tlv5_snapshot_taken(), private.tlv5_locked(text), private.tlv5_is_assigned(text),
                       private.tlv5_can_read_answers(text), private.tlv5_reviewer_items(), private.tlv5_item_answers(text, text),
                       private.tlv5_n_reviewed(text), private.assert_tlv5_packet_blinded(jsonb), private.tlv5_label_row_text(text, text, text, text, text, text),
                       private.tlv5_label_rows_sha256(text), private.tlv5_activation_before_insert(),
                       private.design_activation_v4_v5_guard(), private.cases_v5_guard(), private.tlv5_phase_events_before_insert(),
                       private.tlv5_cases_before_insert(), private.tlv5_case_design_before_insert(),
                       private.tlv5_frozen_labels_before_insert(), private.tlv5_assignments_before_insert(),
                       private.tlv5_submissions_before_insert(), private.tlv5_submission_items_before_insert(),
                       private.tlv5_adjudications_before_insert(), private.audit_row_tlv5(), private.tlv5_judgments_text()
  from public, anon, authenticated;
-- helpers called inside RLS policies, CHECK constraints and security_invoker views
grant execute on function private.tlv5_item_family(text), private.tlv5_answer_ok(text, text), private.tlv5_detail_ok(text, text, text),
                          private.tlv5_phase(), private.tlv5_snapshot_taken(), private.tlv5_locked(text), private.tlv5_is_assigned(text),
                          private.tlv5_can_read_answers(text), private.tlv5_reviewer_items(), private.tlv5_item_answers(text, text),
                          private.tlv5_n_reviewed(text)
  to authenticated;
revoke all on function public.rpc_tlv5_phase(text, jsonb), public.rpc_tlv5_activate(text, text, text),
                       public.rpc_tlv5_enroll_reviewer(uuid, text), public.rpc_tlv5_import_case(jsonb),
                       public.rpc_tlv5_import_frozen_labels(jsonb), public.rpc_tlv5_freeze(jsonb),
                       public.rpc_tlv5_verify_frozen_labels(), public.rpc_tlv5_assign(text, text, integer, text[], bigint),
                       public.rpc_tlv5_submit(uuid, jsonb), public.rpc_tlv5_completion_summary(text),
                       public.rpc_tlv5_record_adjudication(jsonb), public.rpc_tlv5_lock_reference(text, text),
                       public.rpc_tlv5_register_export(jsonb), public.rpc_tlv5_snapshot(), public.rpc_tlv5_verify_snapshot()
  from public, anon;
grant execute on function public.rpc_tlv5_phase(text, jsonb), public.rpc_tlv5_activate(text, text, text),
                          public.rpc_tlv5_enroll_reviewer(uuid, text), public.rpc_tlv5_import_case(jsonb),
                          public.rpc_tlv5_import_frozen_labels(jsonb), public.rpc_tlv5_freeze(jsonb),
                          public.rpc_tlv5_verify_frozen_labels(), public.rpc_tlv5_assign(text, text, integer, text[], bigint),
                          public.rpc_tlv5_submit(uuid, jsonb), public.rpc_tlv5_completion_summary(text),
                          public.rpc_tlv5_record_adjudication(jsonb), public.rpc_tlv5_lock_reference(text, text),
                          public.rpc_tlv5_register_export(jsonb), public.rpc_tlv5_snapshot(), public.rpc_tlv5_verify_snapshot()
  to authenticated;

commit;
