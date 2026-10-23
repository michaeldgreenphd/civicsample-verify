-- =============================================================================
-- migrations/NNNN_v7_mapping_units.sql   (PROPOSED change set for engineering review; NNNN is a placeholder)
-- Clinical review schema v7: the MAPPING-UNIT design. Each review unit is ONE (trial, mapping) pair: one therapeutic
-- area, one Figure 2 condition row, or one rule D / rule K subgroup outcome, with OUR assignment shown. Both
-- reviewers answer every unit: AGREE, DISAGREE (reason code and note) or CANNOT_TELL, with an optional uncertainty
-- flag. The adjudicator breaks ties only (AGREE against DISAGREE, or exactly one CANNOT_TELL).
--
-- Status: PRE-BUILD, PROPOSED. Tested on PGlite 0.3.16 (PostgreSQL 17.5 in WebAssembly) on top of the reference stack
-- of the v6 handoff (schema.sql, 0002 to 0006). It is NOT tested on Supabase or on live PostgreSQL 16, and NOT on the
-- application repository's own migration chain (its later migrations are not in this package). The engineering
-- review runs the same suite on that chain before anything is applied anywhere. Numbering: the application
-- repository assigns the next free number (0022 or later); this file never renumbers or edits an earlier migration.
--
-- Additive only. Nothing in schema.sql or in 0002 to 0006 is replaced, dropped or weakened: no CREATE OR REPLACE of an
-- existing function, no dropped or replaced constraint, no edited view. The two FINDING-V6-01 helpers
-- (private.tlv5_item_answers, private.tlv5_n_reviewed) are not touched. New objects:
--   tables   mu7_design, mu7_phase_events, mu7_units, mu7_unit_design, mu7_frozen_assignments, mu7_gate_approvals,
--            mu7_freeze, mu7_queue, mu7_judgments, mu7_snapshot, mu7_adjudications, mu7_reference_locks, mu7_exports,
--            mu7_training_units, mu7_training_acknowledgments (all append-only, row-level security on, audited)
--   helpers  private.mu7_* ; RPCs public.rpc_mu7_* ; security_invoker views v_mu7_my_queue,
--            v_mu7_adjudication_queue, v_mu7_independent_judgments, v_mu7_final_reference, v_mu7_export_units,
--            v_mu7_export_unit_design (bundle format 7.0)
--   new triggers on earlier tables (each only refuses; none rewrites a row): once a v7 design is recorded, no new
--            v5/v6 FORMAL, CALIBRATION or TRAINING case (tlv5_cases), no v5 activation (tlv5_activation), no v4
--            activation (design_activation_v4), no new FORMAL case of the v2/v3 path (cases).
--
-- Guards. Every refusal this file describes is a block marked "-- GUARD MU7-Gnn BEGIN" ... "-- GUARD MU7-Gnn END" whose
-- error message starts with "MU7-Gnn:". The suite tags each guard's test with that ID and expects that exact tag; the
-- mutation harness removes one block at a time and confirms that the guard's own test then fails. Table constraints
-- are named mu7_*_ck; their tests expect the constraint name, and the harness drops each named constraint in turn.
--
-- RELAXED on purpose (each is stated here, in SCHEMA_API_CONTRACT_v7.md and in CHANGELIST_v7.md, and tested):
--   R1  Registry text is shown as registered (investigator decision 24): the packet guard checks KEYS, never the text
--       values, so a brief summary or description that names another registry or another trial is accepted
--       (test MU7-PK-R1).
--   R2  A FORMAL packet carries the trial's NCT ID and a link to that trial's own ClinicalTrials.gov record
--       (registry_url must equal https://clinicaltrials.gov/study/<the packet's NCT ID>; tests MU7-PK-R2a, MU7-PK-R2b).
--       Packets are not de-identified.
--   R3  Training units (EX7-) carry the real NCT IDs of the three worked examples already printed in eFigure 1
--       (test MU7-TR-R3); a training trial can never also be a FORMAL unit's trial (guards in both directions).
--
-- Apply after the migration that precedes it in the application repository, in one transaction:
--   psql -v ON_ERROR_STOP=1 -f migrations/NNNN_v7_mapping_units.sql
-- Then, before the first v7 unit: rpc_mu7_record_design(...). Nothing here resets, rewrites or deletes existing data.
-- =============================================================================
begin;

insert into public.app_schema_version (version, description)
values ('7.0.0', 'review design v7: mapping units (one trial x one mapping), both reviewers answer every unit, routed tie-break adjudication, bundle format 7.0');

-- -----------------------------------------------------------------------------
-- 1. Vocabulary (immutable helpers used by constraints; the suite checks them against review_design_v7 constants)
-- -----------------------------------------------------------------------------
create function private.mu7_category_ok(p_family text, p_category text) returns boolean
language sql immutable set search_path = '' as $$
  select case p_family
    when 'AREA' then p_category in ('ONCOLOGY', 'CARDIOVASCULAR', 'MENTAL_HEALTH', 'INFECTIOUS', 'METABOLIC',
                                    'NEUROLOGICAL', 'RESPIRATORY')
    when 'ROW'  then p_category in ('CAN_ALL', 'DIAB', 'DEP', 'OBE', 'AST', 'COPD', 'COV', 'SCZ', 'HTN', 'PAIN')
    when 'SG'   then p_category in ('RULE_D_KEPT', 'RULE_D_REMOVED', 'RULE_K_KEPT', 'RULE_K_REMOVED')
    else false end
$$;

create function private.mu7_mapping_code(p_family text, p_category text) returns text
language sql immutable set search_path = '' as $$
  select case p_family
    when 'AREA' then 'AREA_' || p_category
    when 'ROW'  then 'FIG2_ROW_' || p_category
    when 'SG'   then case when p_category like 'RULE_D_%' then 'RULE_D' when p_category like 'RULE_K_%' then 'RULE_K' end
  end
$$;

create function private.mu7_parent_row(p_family text, p_category text) returns text
language sql immutable set search_path = '' as $$
  select case when p_family <> 'SG' then null
              when p_category like 'RULE_D_%' then 'FIG2_ROW_DIAB'
              when p_category like 'RULE_K_%' then 'FIG2_ROW_CAN_ALL' end
$$;

-- An ASSIGNED unit shows a positive assignment; UNASSIGNED is in the domain for a later design, and the v7 import
-- refuses it (guard MU7-G12: the review is assigned-only, investigator decision 20).
create function private.mu7_assignment_ok(p_family text, p_category text, p_code text, p_status text) returns boolean
language sql immutable set search_path = '' as $$
  select case
    when p_status = 'UNASSIGNED' then (p_family = 'AREA' and p_code = 'NOT_IN_AREA') or (p_family = 'ROW' and p_code = 'NOT_IN_ROW')
    when p_status <> 'ASSIGNED' then false
    when p_family = 'AREA' then p_code = 'IN_AREA'
    when p_family = 'ROW'  then p_code = 'IN_ROW'
    when p_category = 'RULE_D_KEPT'    then p_code in ('D1_KEEP_TYPE2', 'D4A_KEEP_UNRESOLVED_PARENT_ONLY', 'D4B_KEEP_UNRESOLVED_COMPLICATION_ONLY')
    when p_category = 'RULE_D_REMOVED' then p_code in ('D2_REMOVE_OTHER_TYPE', 'D3_REMOVE_PREDIABETES_ONLY')
    when p_category = 'RULE_K_KEPT'    then p_code in ('K_KEEP_MALIGNANT_COMPATIBLE', 'K_KEEP_HEURISTIC_NONMALIGNANT_CLASS')
    when p_category = 'RULE_K_REMOVED' then p_code = 'K_REMOVE_VERIFIED_NONMALIGNANT'
    else false end
$$;

create function private.mu7_area_label(p_category text) returns text
language sql immutable set search_path = '' as $$
  select case p_category
    when 'ONCOLOGY' then 'Therapeutic area: Oncology (parent MeSH category C04 Neoplasms)'
    when 'CARDIOVASCULAR' then 'Therapeutic area: Cardiovascular (parent MeSH category C14 Cardiovascular Diseases)'
    when 'MENTAL_HEALTH' then 'Therapeutic area: Mental health (MeSH F03 Mental Disorders, and the heading Depression (D003863) by the study rule)'
    when 'INFECTIOUS' then 'Therapeutic area: Infectious (parent MeSH category C01 Infections)'
    when 'METABOLIC' then 'Therapeutic area: Metabolic (parent MeSH category C18 Nutritional and Metabolic Diseases)'
    when 'NEUROLOGICAL' then 'Therapeutic area: Neurological (parent MeSH category C10 Nervous System Diseases)'
    when 'RESPIRATORY' then 'Therapeutic area: Respiratory (parent MeSH category C08 Respiratory Tract Diseases)'
  end
$$;

create function private.mu7_row_label(p_row text) returns text
language sql immutable set search_path = '' as $$
  select case p_row
    when 'CAN_ALL' then 'Neoplasms' when 'DIAB' then 'Diabetes Mellitus' when 'DEP' then 'Depression'
    when 'OBE' then 'Obesity' when 'AST' then 'Asthma' when 'COPD' then 'Pulmonary Disease, Chronic Obstructive'
    when 'COV' then 'COVID-19' when 'SCZ' then 'Schizophrenia' when 'HTN' then 'Hypertension' when 'PAIN' then 'Pain'
  end
$$;

create function private.mu7_mapping_label(p_family text, p_category text) returns text
language sql immutable set search_path = '' as $$
  select case p_family
    when 'AREA' then private.mu7_area_label(p_category)
    when 'ROW'  then 'Figure 2 condition row: ' || private.mu7_row_label(p_category)
    when 'SG'   then case when p_category like 'RULE_D_%' then 'Rule D, diabetes type' else 'Rule K, malignancy' end
  end
$$;

create function private.mu7_display_text(p_family text, p_code text) returns text
language sql immutable set search_path = '' as $$
  select case
    when p_family = 'AREA' then 'in this area'
    when p_family = 'ROW' then 'in this row'
    when p_code = 'D1_KEEP_TYPE2' then 'type 2 diabetes'
    when p_code in ('D4A_KEEP_UNRESOLVED_PARENT_ONLY', 'D4B_KEEP_UNRESOLVED_COMPLICATION_ONLY') then 'diabetes, type not stated in the registry headings'
    when p_code in ('K_KEEP_MALIGNANT_COMPATIBLE', 'K_KEEP_HEURISTIC_NONMALIGNANT_CLASS') then 'malignant neoplasm, counted in the Neoplasms row'
    when p_code = 'D2_REMOVE_OTHER_TYPE' then 'type 1, gestational or another specified type of diabetes, with no type 2 heading'
    when p_code = 'D3_REMOVE_PREDIABETES_ONLY' then 'prediabetes only, with no diabetes mellitus heading'
    when p_code = 'K_REMOVE_VERIFIED_NONMALIGNANT' then 'non-malignant condition only (every neoplasm heading is a cyst, hamartoma or precancerous condition)'
  end
$$;

create function private.mu7_display_decision(p_category text) returns text
language sql immutable set search_path = '' as $$
  select case p_category
    when 'RULE_D_KEPT' then 'KEEP: kept in the Diabetes Mellitus row'
    when 'RULE_D_REMOVED' then 'REMOVE: removed from the Diabetes Mellitus row'
    when 'RULE_K_KEPT' then 'KEEP: kept in the Neoplasms row'
    when 'RULE_K_REMOVED' then 'REMOVE: removed from the Neoplasms row'
  end
$$;

create function private.mu7_mh_note() returns text
language sql immutable set search_path = '' as $$
  select 'The trial''s MeSH heading Depression is counted as Mental health by the study rule; MeSH files it under Behavior.'::text
$$;

-- Reason codes on DISAGREE, by the kind of assignment the unit shows (REVIEW_RUBRIC_v7.md, section 4)
create function private.mu7_reason_ok(p_family text, p_code text, p_reason text) returns boolean
language sql immutable set search_path = '' as $$
  select coalesce(case
    when p_family = 'AREA' then p_reason in ('ORGAN_OF_ORIGIN_ONLY', 'NOT_THE_CONDITION_STUDIED', 'MESH_PLACEMENT_MISLEADING',
                                             'RUBRIC_POLICY_EXCLUDES', 'OTHER_SPECIFIED')
    when p_family = 'ROW' then p_reason in ('NOT_THE_CONDITION_STUDIED', 'MESH_PLACEMENT_MISLEADING', 'OTHER_SPECIFIED')
    when p_code = 'D1_KEEP_TYPE2' then p_reason in ('TYPE_1_ONLY', 'OTHER_DIABETES_TYPE', 'PREDIABETES_ONLY', 'DIABETES_NOT_STUDIED',
                                                    'OTHER_SPECIFIED')
    when p_code in ('D4A_KEEP_UNRESOLVED_PARENT_ONLY', 'D4B_KEEP_UNRESOLVED_COMPLICATION_ONLY')
      then p_reason in ('TYPE_2_STATED', 'TYPE_1_ONLY', 'OTHER_DIABETES_TYPE', 'PREDIABETES_ONLY', 'DIABETES_NOT_STUDIED', 'OTHER_SPECIFIED')
    when p_code = 'D2_REMOVE_OTHER_TYPE' then p_reason in ('TYPE_2_STUDIED', 'TYPE_NOT_DETERMINABLE', 'OTHER_SPECIFIED')
    when p_code = 'D3_REMOVE_PREDIABETES_ONLY' then p_reason in ('DIABETES_STUDIED', 'OTHER_SPECIFIED')
    when p_code in ('K_KEEP_MALIGNANT_COMPATIBLE', 'K_KEEP_HEURISTIC_NONMALIGNANT_CLASS')
      then p_reason in ('BENIGN_NEOPLASM', 'PRECANCEROUS', 'NOT_A_NEOPLASM', 'OTHER_SPECIFIED')
    when p_code = 'K_REMOVE_VERIFIED_NONMALIGNANT' then p_reason in ('MALIGNANT_NEOPLASM_STUDIED', 'OTHER_SPECIFIED')
    else false end, false)
$$;

-- Routing of one unit from the two effective answers (investigator decision 21, the cannot-tell rule)
create function private.mu7_routing(p_a1 text, p_a2 text) returns text
language sql immutable set search_path = '' as $$
  select case
    when p_a1 is null or p_a2 is null then 'INCOMPLETE'
    when p_a1 = 'AGREE' and p_a2 = 'AGREE' then 'CONCORDANT_AGREE'
    when p_a1 = 'DISAGREE' and p_a2 = 'DISAGREE' then 'CONCORDANT_DISAGREE'
    when p_a1 = 'CANNOT_TELL' and p_a2 = 'CANNOT_TELL' then 'BOTH_CANNOT_TELL'
    else 'ROUTED' end
$$;

create function private.mu7_assignment_row_text(p_set text, p_unit text, p_mapping text, p_code text, p_status text) returns text
language sql immutable set search_path = '' as $$
  select p_set || '|' || p_unit || '|' || p_mapping || '|' || p_code || '|' || p_status
$$;

create function private.mu7_design_row_text(p_unit text, p_nct text, p_frame text, p_stratum text, p_frame_size integer,
                                            p_sample_size integer, p_option text, p_overlap text, p_seed bigint, p_prn text) returns text
language sql immutable set search_path = '' as $$
  select p_unit || '|' || p_nct || '|' || p_frame || '|' || p_stratum || '|' || p_frame_size::text || '|' || p_sample_size::text
         || '|' || p_option || '|' || p_overlap || '|' || p_seed::text || '|' || p_prn
$$;

-- -----------------------------------------------------------------------------
-- 2. Tables
-- -----------------------------------------------------------------------------
create table public.mu7_design (
  design_id           uuid primary key default gen_random_uuid(),
  singleton           boolean not null default true unique check (singleton),
  design_version      text not null check (length(design_version) between 3 and 80),
  assignment_set_id   text not null constraint mu7_design_assignment_set_ck check (assignment_set_id ~ '^(MU7|SYN7)-ASSIGN-[A-Z0-9-]{3,60}$'),
  overlap_setting     text not null constraint mu7_design_overlap_ck check (overlap_setting in ('ALLOW', 'ONE_PER_TRIAL')),
  n_primary_planned   integer not null check (n_primary_planned between 1 and 1000),
  n_subgroup_planned  integer not null check (n_subgroup_planned between 0 and 100),
  adjudication_scope  text not null default 'ROUTED_ONLY' check (adjudication_scope = 'ROUTED_ONLY'),
  attestation         text not null constraint mu7_design_attestation_ck check (length(attestation) >= 20),
  recorded_at         timestamptz not null default now(),
  recorded_by         uuid not null references public.users (user_id)
);

create table public.mu7_phase_events (
  event_id           uuid primary key default gen_random_uuid(),
  event_seq          bigint generated always as identity unique,
  event_type         text not null constraint mu7_phase_event_type_ck check (event_type in ('PILOT_SIGNED_OFF', 'FORMAL_OPENED',
                                                         'FORMAL_CLOSED_COMPLETE', 'FORMAL_CLOSED_INCOMPLETE')),
  checklist_version  text,
  checklist_sha256   text check (checklist_sha256 is null or checklist_sha256 ~ '^[0-9a-f]{64}$'),
  app_git_sha        text,
  pilot_export_id    uuid,
  attestation        text not null check (length(attestation) >= 20),
  occurred_at        timestamptz not null default now(),
  actor              uuid not null references public.users (user_id),
  constraint mu7_phase_signoff_fields_ck check (event_type <> 'PILOT_SIGNED_OFF'
         or (checklist_version is not null and checklist_sha256 is not null and app_git_sha is not null
             and pilot_export_id is not null))
);

create table public.mu7_units (
  unit_id            text primary key,
  mode               text not null check (mode in ('PILOT', 'FORMAL')),
  record_category    text not null,
  family             text not null check (family in ('AREA', 'ROW', 'SG')),
  category           text not null,
  unit_role          text not null check (unit_role in ('PRIMARY', 'SUBGROUP')),
  mapping_code       text not null,
  assignment_code    text not null,
  assignment_status  text not null check (assignment_status in ('ASSIGNED', 'UNASSIGNED')),
  parent_row_code    text,
  packet             jsonb not null check (jsonb_typeof(packet) = 'object'),
  packet_sha256      text not null check (packet_sha256 ~ '^[0-9a-f]{64}$'),
  created_at         timestamptz not null default now(),
  created_by         uuid not null references public.users (user_id),
  unique (unit_id, mode),
  constraint mu7_units_category_ck check (private.mu7_category_ok(family, category)),
  constraint mu7_units_id_ck check (unit_id ~ ('^' || case mode when 'FORMAL' then 'MU7' else 'SYN7' end || '-' || family || '-'
                                               || category || '-[0-9]{3}$')),
  constraint mu7_units_role_ck check ((family = 'SG') = (unit_role = 'SUBGROUP')),
  constraint mu7_units_mapping_ck check (mapping_code = private.mu7_mapping_code(family, category)),
  constraint mu7_units_assignment_ck check (private.mu7_assignment_ok(family, category, assignment_code, assignment_status)),
  constraint mu7_units_parent_row_ck check (parent_row_code is not distinct from private.mu7_parent_row(family, category)),
  constraint mu7_units_record_category_ck check ((mode = 'PILOT' and record_category = 'SYNTHETIC_PILOT')
                                                 or (mode = 'FORMAL' and record_category = 'MAPPING_UNIT_FORMAL'))
);

-- Investigator-only design row (never reviewer-visible)
create table public.mu7_unit_design (
  unit_id               text primary key,
  mode                  text not null,
  nct_id                text not null,
  frame_id              text not null check (length(frame_id) between 2 and 80),
  stratum               text not null check (length(stratum) between 2 and 80),
  frame_stratum_size    integer not null check (frame_stratum_size >= 1),
  n_sampled_in_stratum  integer not null check (n_sampled_in_stratum >= 1),
  selection_probability double precision not null check (selection_probability > 0 and selection_probability <= 1),
  sampling_seed         bigint not null,
  prn_key               text not null check (prn_key ~ '^[0-9a-f]{64}$'),
  allocation_option     text not null check (allocation_option in ('A', 'B', 'C')),
  overlap_setting       text not null check (overlap_setting in ('ALLOW', 'ONE_PER_TRIAL')),
  design_version        text not null,
  freeze_status         text not null check (freeze_status in ('READY', 'BLOCKED_PENDING_GATE')),
  freeze_gate           text check (freeze_gate is null or freeze_gate ~ '^G-[A-Z0-9-]{2,30}$'),
  design_row_sha256     text not null check (design_row_sha256 ~ '^[0-9a-f]{64}$'),
  imported_at           timestamptz not null default now(),
  imported_by           uuid not null references public.users (user_id),
  foreign key (unit_id, mode) references public.mu7_units (unit_id, mode),
  constraint mu7_unit_design_nct_ck check ((mode = 'FORMAL' and nct_id ~ '^NCT[0-9]{8}$')
                                           or (mode = 'PILOT' and nct_id ~ '^SYN-NCT-[0-9]{4}$')),
  constraint mu7_unit_design_n_ck check (n_sampled_in_stratum <= frame_stratum_size),
  constraint mu7_unit_design_gate_ck check ((freeze_status = 'BLOCKED_PENDING_GATE') = (freeze_gate is not null))
);

create table public.mu7_frozen_assignments (
  unit_id            text primary key,
  mode               text not null check (mode = 'FORMAL'),
  assignment_set_id  text not null,
  mapping_code       text not null,
  assignment_code    text not null,
  assignment_status  text not null,
  row_sha256         text not null check (row_sha256 ~ '^[0-9a-f]{64}$'),
  imported_at        timestamptz not null default now(),
  imported_by        uuid not null references public.users (user_id),
  foreign key (unit_id, mode) references public.mu7_units (unit_id, mode)
);

create table public.mu7_gate_approvals (
  gate_id             text primary key constraint mu7_gate_id_ck check (gate_id ~ '^G-[A-Z0-9-]{2,30}$'),
  attestation         text not null check (length(attestation) >= 20),
  evidence_reference  text check (evidence_reference is null or length(evidence_reference) <= 400),
  approved_at         timestamptz not null default now(),
  approved_by         uuid not null references public.users (user_id)
);

create table public.mu7_freeze (
  freeze_id              uuid primary key default gen_random_uuid(),
  singleton              boolean not null default true unique check (singleton),
  n_units                integer not null default 0,
  n_primary              integer not null default 0,
  n_subgroup             integer not null default 0,
  unit_list_sha256       text not null check (unit_list_sha256 ~ '^[0-9a-f]{64}$'),
  assignment_set_sha256  text not null check (assignment_set_sha256 ~ '^[0-9a-f]{64}$'),
  design_rows_sha256     text not null check (design_rows_sha256 ~ '^[0-9a-f]{64}$'),
  queue_sha256           text not null check (queue_sha256 ~ '^[0-9a-f]{64}$'),
  packets_sha256         text not null default repeat('0', 64) check (packets_sha256 ~ '^[0-9a-f]{64}$'),
  attestation            text not null check (length(attestation) >= 20),
  frozen_at              timestamptz not null default now(),
  frozen_by              uuid not null references public.users (user_id)
);

create table public.mu7_queue (
  assignment_id       uuid primary key default gen_random_uuid(),
  unit_id             text not null,
  mode                text not null check (mode in ('PILOT', 'FORMAL')),
  reviewer_pseudo_id  text not null references public.reviewers (reviewer_pseudo_id),
  reviewer_slot       smallint not null check (reviewer_slot in (1, 2)),
  queue_position      integer not null check (queue_position >= 1),
  assigned_at         timestamptz not null default now(),
  assigned_by         uuid not null references public.users (user_id),
  foreign key (unit_id, mode) references public.mu7_units (unit_id, mode),
  unique (unit_id, reviewer_slot),
  unique (unit_id, reviewer_pseudo_id),
  unique (reviewer_pseudo_id, mode, queue_position),
  unique (mode, reviewer_slot, queue_position),
  unique (assignment_id, unit_id, mode, reviewer_pseudo_id, reviewer_slot)
);

-- Append-only: a revision is a new row; the initial answer is revision 1, the effective answer the last revision
create table public.mu7_judgments (
  judgment_id         uuid primary key default gen_random_uuid(),
  assignment_id       uuid not null,
  unit_id             text not null,
  mode                text not null,
  reviewer_pseudo_id  text not null,
  reviewer_slot       smallint not null,
  revision_number     integer not null check (revision_number >= 1),
  answer              text not null constraint mu7_judgments_answer_ck check (answer in ('AGREE', 'DISAGREE', 'CANNOT_TELL')),
  reason_code         text,
  note                text check (note is null or length(note) <= 2000),
  uncertain           boolean not null default false,
  seconds_on_unit     integer check (seconds_on_unit is null or seconds_on_unit >= 0),
  content_sha256      text not null check (content_sha256 ~ '^[0-9a-f]{64}$'),
  submitted_at        timestamptz not null default now(),
  foreign key (assignment_id, unit_id, mode, reviewer_pseudo_id, reviewer_slot)
    references public.mu7_queue (assignment_id, unit_id, mode, reviewer_pseudo_id, reviewer_slot),
  unique (assignment_id, revision_number),
  constraint mu7_judgments_reason_ck check ((answer = 'DISAGREE') = (reason_code is not null))
);

create table public.mu7_snapshot (
  snapshot_id     uuid primary key default gen_random_uuid(),
  singleton       boolean not null default true unique check (singleton),
  n_rows          integer not null default 0 check (n_rows >= 0),
  content_sha256  text not null default repeat('0', 64) check (content_sha256 ~ '^[0-9a-f]{64}$'),
  taken_at        timestamptz not null default now(),
  taken_by        uuid not null references public.users (user_id)
);

create table public.mu7_adjudications (
  adjudication_id           uuid primary key default gen_random_uuid(),
  unit_id                   text not null,
  mode                      text not null check (mode in ('PILOT', 'FORMAL')),
  decision                  text constraint mu7_adj_decision_ck check (decision is null or decision in ('AGREE', 'DISAGREE')),
  reason_code               text,
  status                    text not null check (status in ('DISCORDANT_RESOLVED', 'UNRESOLVED_ESCALATED')),
  basis                     text not null check (basis in ('REVIEWER_1', 'REVIEWER_2', 'NEITHER', 'NONE')),
  disagreement_reason_code  text check (disagreement_reason_code is null or disagreement_reason_code in (
                              'CONSTRUCT_BOUNDARY', 'POLICY_RULE_INTERPRETATION', 'MESH_PLACEMENT_MISLEADING', 'TRIAL_CONTEXT',
                              'PACKET_INSUFFICIENT', 'MULTILABEL_OR_CROSS_AREA', 'OTHER')),
  rationale                 text not null check (length(rationale) between 3 and 4000),
  decided_by                uuid not null references public.users (user_id),
  decided_at                timestamptz not null default now(),
  foreign key (unit_id, mode) references public.mu7_units (unit_id, mode),
  unique (unit_id),
  constraint mu7_adj_status_ck check ((status = 'UNRESOLVED_ESCALATED') = (decision is null)),
  constraint mu7_adj_basis_ck check ((status = 'UNRESOLVED_ESCALATED') = (basis = 'NONE')),
  constraint mu7_adj_reason_ck check ((coalesce(decision, '') = 'DISAGREE') = (reason_code is not null))
);

create table public.mu7_reference_locks (
  lock_id         uuid primary key default gen_random_uuid(),
  mode            text not null unique check (mode in ('PILOT', 'FORMAL')),
  n_units_locked  integer not null default 0 check (n_units_locked >= 0),
  attestation     text not null check (length(attestation) >= 20),
  locked_at       timestamptz not null default now(),
  locked_by       uuid not null references public.users (user_id)
);

create table public.mu7_exports (
  export_id              uuid primary key default gen_random_uuid(),
  mode                   text not null check (mode in ('PILOT', 'FORMAL')),
  bundle_format_version  text not null constraint mu7_exports_format_ck check (bundle_format_version = '7.0'),
  row_counts             jsonb not null check (jsonb_typeof(row_counts) = 'object'),
  file_sha256            jsonb not null check (jsonb_typeof(file_sha256) = 'object'),
  manifest_sha256        text not null check (manifest_sha256 ~ '^[0-9a-f]{64}$'),
  app_git_sha            text not null check (length(app_git_sha) between 4 and 64),
  notes                  text check (notes is null or length(notes) <= 4000),
  created_by             uuid not null references public.users (user_id),
  created_at             timestamptz not null default now()
);

-- Read-only worked examples (investigator decision 22): no answer table exists for them
create table public.mu7_training_units (
  training_unit_id  text primary key constraint mu7_training_id_ck check (training_unit_id ~ '^EX7-[0-9]{2}$'),
  nct_id            text not null check (nct_id ~ '^NCT[0-9]{8}$' or nct_id ~ '^SYN-NCT-[0-9]{4}$'),
  packet            jsonb not null check (jsonb_typeof(packet) = 'object'),
  packet_sha256     text not null check (packet_sha256 ~ '^[0-9a-f]{64}$'),
  imported_at       timestamptz not null default now(),
  imported_by       uuid not null references public.users (user_id)
);

create table public.mu7_training_acknowledgments (
  reviewer_pseudo_id  text primary key references public.reviewers (reviewer_pseudo_id),
  acknowledged_at     timestamptz not null default now()
);

-- -----------------------------------------------------------------------------
-- 3. State helpers
-- -----------------------------------------------------------------------------
create function private.mu7_design_recorded() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.mu7_design)
$$;

create function private.mu7_phase() returns text
language sql stable security definer set search_path = '' as $$
  select coalesce((
    select case e.event_type when 'PILOT_SIGNED_OFF' then 'SIGNED_OFF' when 'FORMAL_OPENED' then 'OPEN'
                             when 'FORMAL_CLOSED_COMPLETE' then 'CLOSED_COMPLETE'
                             when 'FORMAL_CLOSED_INCOMPLETE' then 'CLOSED_INCOMPLETE' end
    from public.mu7_phase_events e order by e.event_seq desc limit 1), 'NOT_SIGNED_OFF')
$$;

create function private.mu7_closed() returns boolean
language sql stable security definer set search_path = '' as $$
  select private.mu7_phase() in ('CLOSED_COMPLETE', 'CLOSED_INCOMPLETE')
$$;

create function private.mu7_signed_off() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.mu7_phase_events e where e.event_type = 'PILOT_SIGNED_OFF')
$$;

create function private.mu7_frozen() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.mu7_freeze)
$$;

create function private.mu7_snapshot_taken() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.mu7_snapshot)
$$;

create function private.mu7_locked(p_mode text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.mu7_reference_locks l where l.mode = p_mode)
$$;

create function private.mu7_unit_role(p_unit_id text) returns text
language sql stable security definer set search_path = '' as $$
  select u.unit_role from public.mu7_units u where u.unit_id = p_unit_id
$$;

-- Has this reviewer answered every PRIMARY unit of their queue in this mode? (internal: never granted to clients,
-- because with another reviewer's ID it would reveal that reviewer's progress)
create function private.mu7_primary_done(p_reviewer text, p_mode text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.mu7_queue q where q.reviewer_pseudo_id = p_reviewer and q.mode = p_mode)
     and not exists (
       select 1 from public.mu7_queue q join public.mu7_units u on u.unit_id = q.unit_id
       where q.reviewer_pseudo_id = p_reviewer and q.mode = p_mode and u.unit_role = 'PRIMARY'
         and not exists (select 1 from public.mu7_judgments j where j.assignment_id = q.assignment_id))
$$;

-- Effective (last) answer of one slot on one unit (internal only)
create function private.mu7_effective_answer(p_unit_id text, p_slot integer) returns text
language sql stable security definer set search_path = '' as $$
  select j.answer from public.mu7_judgments j
  where j.unit_id = p_unit_id and j.reviewer_slot = p_slot order by j.revision_number desc limit 1
$$;

-- Who may read the answers of a mode (the FINDING-V6-01 lesson: every helper that exposes answers checks its caller)
create function private.mu7_can_read_judgments(p_mode text) returns boolean
language plpgsql stable security definer set search_path = '' as $$
begin
  if private.is_investigator() then
    if p_mode = 'PILOT' then
      return true;
    end if;
    -- GUARD MU7-G50 BEGIN
    if not private.mu7_closed() then
      return false;   -- MU7-G50: no interim look; the investigator reads FORMAL answers only after the close
    end if;
    -- GUARD MU7-G50 END
    return p_mode = 'FORMAL';
  end if;
  if private.is_adjudicator() then
    if p_mode = 'PILOT' then
      return true;
    end if;
    -- GUARD MU7-G51 BEGIN
    if not (private.mu7_closed() and private.mu7_snapshot_taken()) then
      return false;   -- MU7-G51: the adjudicator reads FORMAL answers only after the close and the snapshot
    end if;
    -- GUARD MU7-G51 END
    return p_mode = 'FORMAL';
  end if;
  return false;
end $$;

-- May the calling reviewer read this unit's packet now?
create function private.mu7_reviewer_can_read_unit(p_unit_id text) returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare
  me text := private.my_reviewer_pseudo_id();
  m text;
begin
  if me is null then
    return false;
  end if;
  select q.mode into m from public.mu7_queue q where q.unit_id = p_unit_id and q.reviewer_pseudo_id = me;
  if m is null then
    return false;
  end if;
  -- GUARD MU7-G52 BEGIN
  if m = 'FORMAL' and private.mu7_phase() not in ('OPEN', 'CLOSED_COMPLETE', 'CLOSED_INCOMPLETE') then
    return false;     -- MU7-G52: FORMAL packets are readable from the formal opening onward
  end if;
  -- GUARD MU7-G52 END
  -- GUARD MU7-G53 BEGIN
  if private.mu7_unit_role(p_unit_id) = 'SUBGROUP' and not private.mu7_primary_done(me, m) then
    return false;     -- MU7-G53: subgroup units open after every primary unit of the queue is answered
  end if;
  -- GUARD MU7-G53 END
  return true;
end $$;

-- -----------------------------------------------------------------------------
-- 4. Packet guards (allow lists of KEYS; text values are not scanned: relaxed rule R1)
-- -----------------------------------------------------------------------------
create function private.assert_mu7_trial_block(t jsonb, p_mode text, p_training boolean) returns text
language plpgsql immutable set search_path = '' as $$
declare
  bad text;
  nct text := t ->> 'nct_id';
begin
  -- GUARD MU7-G15 BEGIN
  if t is null or jsonb_typeof(t) <> 'object' then
    raise exception 'MU7-G15: the packet needs a trial block' using errcode = '22023';
  end if;
  select k into bad from jsonb_object_keys(t) k
  where k not in ('nct_id', 'registry_url', 'brief_title', 'official_title', 'conditions_registered', 'condition_mesh_headings',
                  'brief_summary', 'detailed_description', 'interventions', 'eligibility_age_range') limit 1;
  if bad is not null then
    raise exception 'MU7-G15: trial key "%" is not on the allow list', bad using errcode = '22023';
  end if;
  select k into bad from private.jsonb_all_keys(t -> 'interventions') k
  where k not in ('intervention_type', 'name', 'description') limit 1;
  if bad is null then
    select k into bad from private.jsonb_all_keys(t -> 'eligibility_age_range') k where k not in ('minimum_age', 'maximum_age') limit 1;
  end if;
  if bad is not null then
    raise exception 'MU7-G15: trial key "%" is not on the allow list', bad using errcode = '22023';
  end if;
  -- GUARD MU7-G15 END
  -- GUARD MU7-G16 BEGIN
  if p_mode = 'FORMAL' or (p_training and nct ~ '^NCT[0-9]{8}$') then
    if nct is null or nct !~ '^NCT[0-9]{8}$' then
      raise exception 'MU7-G16: a FORMAL or worked-example packet carries the trial''s NCT ID' using errcode = '22023';
    end if;
    if (t ->> 'registry_url') is distinct from ('https://clinicaltrials.gov/study/' || nct) then
      raise exception 'MU7-G16: registry_url must link the trial''s own record (https://clinicaltrials.gov/study/%)', nct
        using errcode = '22023';
    end if;
  else
    if nct is null or nct !~ '^SYN-NCT-[0-9]{4}$' or t ? 'registry_url' then
      raise exception 'MU7-G16: a synthetic packet carries a SYN-NCT-nnnn identifier and no registry link' using errcode = '22023';
    end if;
  end if;
  -- GUARD MU7-G16 END
  return nct;
end $$;

create function private.assert_mu7_packet(p jsonb, p_unit_id text, p_mode text, p_family text, p_category text, p_role text,
                                          p_mapping text, p_code text, p_status text, p_parent text) returns text
language plpgsql immutable set search_path = '' as $$
declare
  bad text;
  u jsonb := p -> 'unit';
begin
  -- GUARD MU7-G14 BEGIN
  select k into bad from jsonb_object_keys(p) k where k not in ('schema_version', 'unit', 'trial', 'notices') limit 1;
  if bad is not null or (p ->> 'schema_version') is distinct from '7.0' then
    raise exception 'MU7-G14: packet top-level key "%" or schema_version is not allowed (keys: schema_version 7.0, unit, trial, notices)',
      coalesce(bad, p ->> 'schema_version') using errcode = '22023';
  end if;
  select k into bad from jsonb_object_keys(coalesce(u, '{}'::jsonb)) k
  where k not in ('unit_id', 'mode', 'family', 'category', 'unit_role', 'mapping_code', 'mapping_label', 'assignment_code',
                  'assignment_status', 'display_text', 'display_decision', 'parent_row_code', 'parent_row_label', 'display_note')
  limit 1;
  if u is null or bad is not null then
    raise exception 'MU7-G14: unit key "%" is not on the allow list', coalesce(bad, '(no unit block)') using errcode = '22023';
  end if;
  -- GUARD MU7-G14 END
  -- GUARD MU7-G17 BEGIN
  if (u ->> 'unit_id') is distinct from p_unit_id or (u ->> 'mode') is distinct from p_mode
     or (u ->> 'family') is distinct from p_family or (u ->> 'category') is distinct from p_category
     or (u ->> 'unit_role') is distinct from p_role or (u ->> 'mapping_code') is distinct from p_mapping
     or (u ->> 'assignment_code') is distinct from p_code or (u ->> 'assignment_status') is distinct from p_status
     or (u ->> 'parent_row_code') is distinct from p_parent then
    raise exception 'MU7-G17: the unit block must equal the unit row (identifier, mode, family, category, role, mapping, assignment)'
      using errcode = '22023';
  end if;
  -- GUARD MU7-G17 END
  -- GUARD MU7-G18 BEGIN
  if (u ->> 'mapping_label') is distinct from private.mu7_mapping_label(p_family, p_category)
     or (u ->> 'display_text') is distinct from private.mu7_display_text(p_family, p_code) then
    raise exception 'MU7-G18: the displayed mapping label and assignment text must be the canonical texts of the frozen assignment'
      using errcode = '22023';
  end if;
  if p_family = 'SG' then
    if (u ->> 'display_decision') is distinct from private.mu7_display_decision(p_category)
       or (u ->> 'parent_row_label') is distinct from private.mu7_row_label(replace(p_parent, 'FIG2_ROW_', '')) then
      raise exception 'MU7-G18: a subgroup unit restates its parent row and its KEEP or REMOVE decision in the canonical text'
        using errcode = '22023';
    end if;
  elsif u ? 'display_decision' or u ? 'parent_row_label' then
    raise exception 'MU7-G18: only subgroup units carry a display decision and a parent row' using errcode = '22023';
  end if;
  if u ? 'display_note' and not (p_family = 'AREA' and p_category = 'MENTAL_HEALTH'
                                 and (u ->> 'display_note') = private.mu7_mh_note()) then
    raise exception 'MU7-G18: a display note is allowed only on a Mental health unit, in the canonical wording' using errcode = '22023';
  end if;
  -- GUARD MU7-G18 END
  -- GUARD MU7-G19 BEGIN
  if p_mode = 'PILOT' and not coalesce((p -> 'notices') @> '["SYNTHETIC UNIT: excluded from every statistic"]'::jsonb, false) then
    raise exception 'MU7-G19: a PILOT packet carries the notice "SYNTHETIC UNIT: excluded from every statistic"' using errcode = '22023';
  end if;
  if p_mode = 'FORMAL' and coalesce(jsonb_array_length(p -> 'notices'), 0) > 0 then
    raise exception 'MU7-G19: a FORMAL packet carries no notice' using errcode = '22023';
  end if;
  -- GUARD MU7-G19 END
  return private.assert_mu7_trial_block(p -> 'trial', p_mode, false);
end $$;

create function private.assert_mu7_training_packet(p jsonb, p_id text) returns text
language plpgsql immutable set search_path = '' as $$
declare
  bad text;
  u jsonb := p -> 'unit';
begin
  -- GUARD MU7-G40 BEGIN
  select k into bad from jsonb_object_keys(p) k where k not in ('schema_version', 'unit', 'trial', 'worked_example', 'notices') limit 1;
  if bad is null then
    select k into bad from jsonb_object_keys(coalesce(u, '{}'::jsonb)) k
    where k not in ('unit_id', 'mode', 'family', 'category', 'unit_role', 'mapping_code', 'mapping_label', 'assignment_code',
                    'assignment_status', 'display_text', 'mapping_basis') limit 1;
  end if;
  if bad is null then
    select k into bad from private.jsonb_all_keys(coalesce(p -> 'worked_example', '{}'::jsonb)) k
    where k not in ('outcome_summary', 'teaching_point', 'worked_answers', 'reviewer_slot', 'answer', 'reason_code', 'note',
                    'uncertain', 'reference', 'final_answer', 'status', 'basis', 'rationale', 'disagreement_reason_code',
                    'routed_to_adjudicator', 'routing_reason') limit 1;
  end if;
  if bad is not null or (p ->> 'schema_version') is distinct from '7.0' or u is null or (u ->> 'unit_id') is distinct from p_id
     or (u ->> 'mode') is distinct from 'TRAINING' or not (p ? 'worked_example') then
    raise exception 'MU7-G40: a training packet has schema_version 7.0, a TRAINING unit block with its own ID, a worked_example block, and allowed keys only (offending key: %)',
      coalesce(bad, '(none)') using errcode = '22023';
  end if;
  if not private.mu7_category_ok(u ->> 'family', u ->> 'category')
     or (u ->> 'mapping_label') is distinct from private.mu7_mapping_label(u ->> 'family', u ->> 'category')
     or (u ->> 'display_text') is distinct from private.mu7_display_text(u ->> 'family', u ->> 'assignment_code') then
    raise exception 'MU7-G40: a training unit shows the canonical mapping label and assignment text of its family' using errcode = '22023';
  end if;
  -- GUARD MU7-G40 END
  return private.assert_mu7_trial_block(p -> 'trial', 'TRAINING', true);
end $$;

-- -----------------------------------------------------------------------------
-- 5. Triggers: design, cross-design exclusion, units, design rows, assignments, gates, freeze
-- -----------------------------------------------------------------------------
create function private.mu7_design_before_insert() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  -- GUARD MU7-G01 BEGIN
  if (select u.role from public.users u where u.user_id = new.recorded_by) is distinct from 'INVESTIGATOR' then
    raise exception 'MU7-G01: only the investigator records the v7 design';
  end if;
  -- GUARD MU7-G01 END
  -- GUARD MU7-G02 BEGIN
  if exists (select 1 from public.tlv5_cases c where c.mode in ('FORMAL', 'CALIBRATION'))
     or exists (select 1 from public.tlv5_activation) or exists (select 1 from public.design_activation_v4) then
    raise exception 'MU7-G02: a v4, v5 or v6 formal or calibration review already exists in this database; it keeps its design';
  end if;
  -- GUARD MU7-G02 END
  new.recorded_at := now();
  return new;
end $$;

create function private.mu7_old_design_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  -- GUARD MU7-G04 BEGIN
  if private.mu7_design_recorded() and tg_table_name = 'tlv5_cases'
     and (to_jsonb(new) ->> 'mode') in ('FORMAL', 'CALIBRATION', 'TRAINING') then
    raise exception 'MU7-G04: this database runs review design v7; a new v5 or v6 % case is refused', to_jsonb(new) ->> 'mode';
  end if;
  -- GUARD MU7-G04 END
  -- GUARD MU7-G05 BEGIN
  if private.mu7_design_recorded() and tg_table_name in ('tlv5_activation', 'design_activation_v4') then
    raise exception 'MU7-G05: this database runs review design v7; activating design v4 or v5 is refused';
  end if;
  -- GUARD MU7-G05 END
  -- GUARD MU7-G06 BEGIN
  if private.mu7_design_recorded() and tg_table_name = 'cases' and (to_jsonb(new) ->> 'mode') = 'FORMAL' then
    raise exception 'MU7-G06: this database runs review design v7; a new FORMAL case of the v2/v3 path is refused';
  end if;
  -- GUARD MU7-G06 END
  return new;
end $$;

create function private.mu7_units_before_insert() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  -- GUARD MU7-G10 BEGIN
  if not private.mu7_design_recorded() then
    raise exception 'MU7-G10: record the v7 design before the first unit';
  end if;
  -- GUARD MU7-G10 END
  -- GUARD MU7-G11 BEGIN
  if new.mode = 'FORMAL' and private.mu7_frozen() then
    raise exception 'MU7-G11: the v7 sample is frozen; FORMAL unit % cannot be added', new.unit_id;
  end if;
  if new.mode = 'PILOT' and private.mu7_signed_off() then
    raise exception 'MU7-G11: the v7 pilot is signed off; PILOT unit % cannot be added', new.unit_id;
  end if;
  -- GUARD MU7-G11 END
  -- GUARD MU7-G12 BEGIN
  if new.assignment_status <> 'ASSIGNED' then
    raise exception 'MU7-G12: the v7 review is assigned-only; an UNASSIGNED unit is refused';
  end if;
  -- GUARD MU7-G12 END
  perform private.assert_mu7_packet(new.packet, new.unit_id, new.mode, new.family, new.category, new.unit_role,
                                    new.mapping_code, new.assignment_code, new.assignment_status, new.parent_row_code);
  new.packet_sha256 := private.sha256_hex(new.packet::text);
  new.created_at := now();
  return new;
end $$;

create function private.mu7_unit_design_before_insert() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  d record;
  pk jsonb;
begin
  select * into d from public.mu7_design;
  select u.packet into pk from public.mu7_units u where u.unit_id = new.unit_id and u.mode = new.mode;
  -- GUARD MU7-G20 BEGIN
  if pk is null or (pk -> 'trial' ->> 'nct_id') is distinct from new.nct_id then
    raise exception 'MU7-G20: the design row''s NCT ID must equal the packet''s trial';
  end if;
  if abs(new.selection_probability - new.n_sampled_in_stratum::double precision / new.frame_stratum_size) > 1e-12 then
    raise exception 'MU7-G20: selection_probability must equal n_sampled_in_stratum / frame_stratum_size';
  end if;
  if new.mode = 'FORMAL' and (new.design_version is distinct from d.design_version or new.overlap_setting is distinct from d.overlap_setting) then
    raise exception 'MU7-G20: a FORMAL design row carries the recorded design version and overlap setting';
  end if;
  -- GUARD MU7-G20 END
  -- GUARD MU7-G21 BEGIN
  if new.mode = 'FORMAL' and exists (select 1 from public.mu7_training_units t where t.nct_id = new.nct_id) then
    raise exception 'MU7-G21: % is a worked-example trial and cannot be a FORMAL unit''s trial', new.nct_id;
  end if;
  -- GUARD MU7-G21 END
  -- GUARD MU7-G24 BEGIN
  if new.mode = 'FORMAL' and d.overlap_setting = 'ONE_PER_TRIAL'
     and exists (select 1 from public.mu7_unit_design x where x.mode = 'FORMAL' and x.nct_id = new.nct_id) then
    raise exception 'MU7-G24: overlap setting ONE_PER_TRIAL: trial % already has a FORMAL unit', new.nct_id;
  end if;
  -- GUARD MU7-G24 END
  new.design_row_sha256 := private.sha256_hex(private.mu7_design_row_text(new.unit_id, new.nct_id, new.frame_id, new.stratum,
                             new.frame_stratum_size, new.n_sampled_in_stratum, new.allocation_option, new.overlap_setting,
                             new.sampling_seed, new.prn_key));
  new.imported_at := now();
  return new;
end $$;

create function private.mu7_frozen_assignments_before_insert() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  u record;
begin
  select * into u from public.mu7_units x where x.unit_id = new.unit_id and x.mode = new.mode;
  -- GUARD MU7-G23 BEGIN
  if new.assignment_set_id is distinct from (select d.assignment_set_id from public.mu7_design d)
     or new.mapping_code is distinct from u.mapping_code or new.assignment_code is distinct from u.assignment_code
     or new.assignment_status is distinct from u.assignment_status then
    raise exception 'MU7-G23: the frozen assignment must equal the assignment the unit displays, in the recorded assignment set';
  end if;
  if new.row_sha256 is distinct from private.sha256_hex(private.mu7_assignment_row_text(new.assignment_set_id, new.unit_id,
                                     new.mapping_code, new.assignment_code, new.assignment_status)) then
    raise exception 'MU7-G23: row_sha256 does not match the canonical assignment row';
  end if;
  -- GUARD MU7-G23 END
  new.imported_at := now();
  return new;
end $$;

create function private.mu7_training_units_before_insert() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  new.nct_id := private.assert_mu7_training_packet(new.packet, new.training_unit_id);
  -- GUARD MU7-G22 BEGIN
  if exists (select 1 from public.mu7_unit_design d where d.mode = 'FORMAL' and d.nct_id = new.nct_id) then
    raise exception 'MU7-G22: % is a FORMAL unit''s trial and cannot be a worked example', new.nct_id;
  end if;
  -- GUARD MU7-G22 END
  -- GUARD MU7-G41 BEGIN
  if private.mu7_phase() in ('OPEN', 'CLOSED_COMPLETE', 'CLOSED_INCOMPLETE') then
    raise exception 'MU7-G41: worked examples are imported before the formal opening';
  end if;
  -- GUARD MU7-G41 END
  new.packet_sha256 := private.sha256_hex(new.packet::text);
  new.imported_at := now();
  return new;
end $$;

create function private.mu7_freeze_before_insert() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  d record;
  n_p integer; n_s integer;
  h_units text; h_asg text; h_design text;
  missing integer;
  blocked text;
begin
  select * into d from public.mu7_design;
  select count(*) filter (where u.unit_role = 'PRIMARY'), count(*) filter (where u.unit_role = 'SUBGROUP')
    into n_p, n_s from public.mu7_units u where u.mode = 'FORMAL';
  -- GUARD MU7-G26 BEGIN
  if d.design_id is null or n_p <> d.n_primary_planned or n_s <> d.n_subgroup_planned then
    raise exception 'MU7-G26: the freeze needs exactly % primary and % subgroup FORMAL units (found % and %)',
      d.n_primary_planned, d.n_subgroup_planned, n_p, n_s;
  end if;
  -- GUARD MU7-G26 END
  select count(*) into missing from public.mu7_units u
  where u.mode = 'FORMAL' and (not exists (select 1 from public.mu7_unit_design x where x.unit_id = u.unit_id)
                               or not exists (select 1 from public.mu7_frozen_assignments a where a.unit_id = u.unit_id));
  -- GUARD MU7-G27 BEGIN
  if missing > 0 then
    raise exception 'MU7-G27: % FORMAL units lack a design row or a frozen assignment', missing;
  end if;
  -- GUARD MU7-G27 END
  select private.sha256_hex(string_agg(u.unit_id, E'\n' order by u.unit_id collate "C")) into h_units
  from public.mu7_units u where u.mode = 'FORMAL';
  select private.sha256_hex(string_agg(a.row_sha256, E'\n' order by a.unit_id collate "C")) into h_asg
  from public.mu7_frozen_assignments a;
  select private.sha256_hex(string_agg(x.design_row_sha256, E'\n' order by x.unit_id collate "C")) into h_design
  from public.mu7_unit_design x where x.mode = 'FORMAL';
  -- GUARD MU7-G28 BEGIN
  if new.unit_list_sha256 is distinct from h_units or new.assignment_set_sha256 is distinct from h_asg
     or new.design_rows_sha256 is distinct from h_design then
    raise exception 'MU7-G28: the manifest hashes do not match the imported units (unit list %, assignments %, design rows %)',
      h_units, h_asg, h_design;
  end if;
  -- GUARD MU7-G28 END
  select string_agg(distinct x.freeze_gate, ', ') into blocked from public.mu7_unit_design x
  where x.mode = 'FORMAL' and x.freeze_status = 'BLOCKED_PENDING_GATE'
    and not exists (select 1 from public.mu7_gate_approvals g where g.gate_id = x.freeze_gate);
  -- GUARD MU7-G29 BEGIN
  if blocked is not null then
    raise exception 'MU7-G29: units are blocked from the freeze until their gate is approved: %', blocked;
  end if;
  -- GUARD MU7-G29 END
  new.n_units := n_p + n_s;
  new.n_primary := n_p;
  new.n_subgroup := n_s;
  select private.sha256_hex(string_agg(u.packet_sha256, E'\n' order by u.unit_id collate "C")) into new.packets_sha256
  from public.mu7_units u where u.mode = 'FORMAL';
  new.frozen_at := now();
  return new;
end $$;

-- -----------------------------------------------------------------------------
-- 6. Triggers: queue, phase, judgments, snapshot, adjudication, lock, export
-- -----------------------------------------------------------------------------
create function private.mu7_queue_before_insert() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  r record;
begin
  select * into r from public.reviewers x where x.reviewer_pseudo_id = new.reviewer_pseudo_id;
  -- GUARD MU7-G30 BEGIN
  if r.withdrawn_at is not null or r.mode_scope is distinct from new.mode then
    raise exception 'MU7-G30: a % unit goes to an active % reviewer', new.mode, new.mode;
  end if;
  -- GUARD MU7-G30 END
  -- GUARD MU7-G31 BEGIN
  if new.mode = 'FORMAL' and (not private.mu7_frozen() or private.mu7_phase() <> 'SIGNED_OFF') then
    raise exception 'MU7-G31: the FORMAL queue is assigned after the pilot sign-off and the freeze, before the formal opening';
  end if;
  if new.mode = 'PILOT' and (private.mu7_signed_off() or private.mu7_locked('PILOT')) then
    raise exception 'MU7-G31: the PILOT queue is assigned before the pilot lock';
  end if;
  -- GUARD MU7-G31 END
  -- GUARD MU7-G32 BEGIN
  if exists (select 1 from public.mu7_queue q where q.mode = new.mode and q.reviewer_pseudo_id = new.reviewer_pseudo_id
             and q.reviewer_slot <> new.reviewer_slot)
     or exists (select 1 from public.mu7_queue q where q.mode = new.mode and q.reviewer_slot = new.reviewer_slot
                and q.reviewer_pseudo_id <> new.reviewer_pseudo_id) then
    raise exception 'MU7-G32: one reviewer holds one slot per mode, and one slot belongs to one reviewer';
  end if;
  -- GUARD MU7-G32 END
  new.assigned_at := now();
  return new;
end $$;

create function private.mu7_phase_events_before_insert() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  n_asg integer; n_units integer; n_answered integer;
begin
  -- GUARD MU7-G42 BEGIN
  if (select u.role from public.users u where u.user_id = new.actor) is distinct from 'INVESTIGATOR' then
    raise exception 'MU7-G42: only the investigator records a phase event';
  end if;
  if exists (select 1 from public.mu7_phase_events e where e.event_type = new.event_type)
     or (new.event_type like 'FORMAL_CLOSED_%' and private.mu7_closed()) then
    raise exception 'MU7-G42: phase event % is recorded once', new.event_type;
  end if;
  -- GUARD MU7-G42 END
  if new.event_type = 'PILOT_SIGNED_OFF' then
    -- GUARD MU7-G43 BEGIN
    if not private.mu7_locked('PILOT')
       or not exists (select 1 from public.mu7_exports x where x.export_id = new.pilot_export_id and x.mode = 'PILOT') then
      raise exception 'MU7-G43: the pilot sign-off needs the PILOT reference lock and the registered PILOT export';
    end if;
    -- GUARD MU7-G43 END
  elsif new.event_type = 'FORMAL_OPENED' then
    select count(*) into n_units from public.mu7_units u where u.mode = 'FORMAL';
    select count(*) into n_asg from public.mu7_queue q where q.mode = 'FORMAL';
    -- GUARD MU7-G44 BEGIN
    if private.mu7_phase() <> 'SIGNED_OFF' or not private.mu7_frozen() or n_units = 0 or n_asg <> 2 * n_units then
      raise exception 'MU7-G44: the formal phase opens after the sign-off, the freeze and the full queue of both reviewers (% of % assignments)',
        n_asg, 2 * n_units;
    end if;
    -- GUARD MU7-G44 END
  elsif new.event_type in ('FORMAL_CLOSED_COMPLETE', 'FORMAL_CLOSED_INCOMPLETE') then
    select count(*), count(*) filter (where exists (select 1 from public.mu7_judgments j where j.assignment_id = q.assignment_id))
      into n_asg, n_answered from public.mu7_queue q where q.mode = 'FORMAL';
    -- GUARD MU7-G45 BEGIN
    if private.mu7_phase() <> 'OPEN' then
      raise exception 'MU7-G45: the formal phase closes only while it is open';
    end if;
    if new.event_type = 'FORMAL_CLOSED_COMPLETE' and n_answered < n_asg then
      raise exception 'MU7-G45: FORMAL_CLOSED_COMPLETE needs every assignment answered (% of %); close as incomplete instead',
        n_answered, n_asg;
    end if;
    -- GUARD MU7-G45 END
  end if;
  new.occurred_at := now();
  return new;
end $$;

create function private.mu7_judgments_before_insert() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  q record;
  u record;
begin
  select * into q from public.mu7_queue x where x.assignment_id = new.assignment_id;
  select * into u from public.mu7_units x where x.unit_id = q.unit_id;
  new.unit_id := q.unit_id;
  new.mode := q.mode;
  new.reviewer_pseudo_id := q.reviewer_pseudo_id;
  new.reviewer_slot := q.reviewer_slot;
  -- GUARD MU7-G34 BEGIN
  if q.mode = 'FORMAL' and private.mu7_phase() <> 'OPEN' then
    raise exception 'MU7-G34: FORMAL answers are accepted only while the formal phase is open';
  end if;
  if q.mode = 'PILOT' and private.mu7_locked('PILOT') then
    raise exception 'MU7-G34: the PILOT reference is locked; no more PILOT answers';
  end if;
  -- GUARD MU7-G34 END
  -- GUARD MU7-G33 BEGIN
  if u.unit_role = 'SUBGROUP' and not private.mu7_primary_done(q.reviewer_pseudo_id, q.mode) then
    raise exception 'MU7-G33: a subgroup unit is answered after every primary unit of the queue';
  end if;
  -- GUARD MU7-G33 END
  -- GUARD MU7-G35 BEGIN
  if new.answer = 'DISAGREE' and new.reason_code is not null
     and not private.mu7_reason_ok(u.family, u.assignment_code, new.reason_code) then
    raise exception 'MU7-G35: reason code % does not fit a % unit showing %', new.reason_code, u.family, u.assignment_code;
  end if;
  -- GUARD MU7-G35 END
  -- GUARD MU7-G36 BEGIN
  if new.answer = 'DISAGREE' and length(btrim(coalesce(new.note, ''))) < 3 then
    raise exception 'MU7-G36: a DISAGREE answer needs a note';
  end if;
  -- GUARD MU7-G36 END
  new.revision_number := coalesce((select max(j.revision_number) from public.mu7_judgments j
                                   where j.assignment_id = new.assignment_id), 0) + 1;
  new.submitted_at := now();
  new.content_sha256 := private.sha256_hex(concat_ws('|', new.assignment_id::text, new.revision_number::text, new.answer,
                          coalesce(new.reason_code, ''), coalesce(new.note, ''), new.uncertain::text,
                          coalesce(new.seconds_on_unit::text, '')));
  return new;
end $$;

-- Snapshot text: every FORMAL judgment row, in a fixed order (unit, slot, revision)
create function private.mu7_judgments_text(out n integer, out txt text)
language sql stable security definer set search_path = '' as $$
  select count(*)::integer,
         string_agg(concat_ws('|', j.unit_id, j.reviewer_slot::text, j.reviewer_pseudo_id, j.revision_number::text, j.answer,
                              coalesce(j.reason_code, ''), coalesce(j.note, ''), j.uncertain::text, j.content_sha256,
                              to_char(j.submitted_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')),
                    E'\n' order by j.unit_id collate "C", j.reviewer_slot, j.revision_number)
  from public.mu7_judgments j where j.mode = 'FORMAL'
$$;

create function private.mu7_snapshot_before_insert() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  t record;
begin
  -- GUARD MU7-G46 BEGIN
  if not private.mu7_closed() then
    raise exception 'MU7-G46: the snapshot is taken after the formal close';
  end if;
  -- GUARD MU7-G46 END
  select * into t from private.mu7_judgments_text();
  new.n_rows := t.n;
  new.content_sha256 := private.sha256_hex(coalesce(t.txt, ''));
  new.taken_at := now();
  return new;
end $$;

create function private.mu7_adjudications_before_insert() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  u record;
  a1 text; a2 text;
begin
  select * into u from public.mu7_units x where x.unit_id = new.unit_id;
  new.mode := u.mode;
  -- GUARD MU7-G37 BEGIN
  if (select r.role from public.users r where r.user_id = new.decided_by) is distinct from 'ADJUDICATOR' then
    raise exception 'MU7-G37: only the adjudicator records a v7 adjudication';
  end if;
  -- GUARD MU7-G37 END
  -- GUARD MU7-G38 BEGIN
  if u.mode = 'FORMAL' and not (private.mu7_closed() and private.mu7_snapshot_taken()) then
    raise exception 'MU7-G38: FORMAL adjudication starts after the close and the snapshot';
  end if;
  if private.mu7_locked(u.mode) then
    raise exception 'MU7-G38: the % reference is locked', u.mode;
  end if;
  -- GUARD MU7-G38 END
  a1 := private.mu7_effective_answer(new.unit_id, 1);
  a2 := private.mu7_effective_answer(new.unit_id, 2);
  -- GUARD MU7-G39 BEGIN
  if private.mu7_routing(a1, a2) <> 'ROUTED' then
    raise exception 'MU7-G39: only routed units are adjudicated (AGREE against DISAGREE, or exactly one CANNOT_TELL); this unit is %',
      private.mu7_routing(a1, a2);
  end if;
  -- GUARD MU7-G39 END
  -- GUARD MU7-G47 BEGIN
  if new.status = 'DISCORDANT_RESOLVED' and (
       (new.basis = 'REVIEWER_1' and a1 is distinct from new.decision) or (new.basis = 'REVIEWER_2' and a2 is distinct from new.decision)
       or (new.basis = 'NEITHER' and (a1 = new.decision or a2 = new.decision))) then
    raise exception 'MU7-G47: the basis must name the reviewer whose effective answer equals the decision (NEITHER when none does)';
  end if;
  if new.decision = 'DISAGREE' and new.reason_code is not null
     and not private.mu7_reason_ok(u.family, u.assignment_code, new.reason_code) then
    raise exception 'MU7-G47: reason code % does not fit a % unit showing %', new.reason_code, u.family, u.assignment_code;
  end if;
  -- GUARD MU7-G47 END
  new.decided_at := now();
  return new;
end $$;

create function private.mu7_reference_locks_before_insert() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  n_units integer; n_incomplete integer; n_pending integer;
begin
  select count(*),
         count(*) filter (where private.mu7_routing(private.mu7_effective_answer(u.unit_id, 1), private.mu7_effective_answer(u.unit_id, 2)) = 'INCOMPLETE'),
         count(*) filter (where private.mu7_routing(private.mu7_effective_answer(u.unit_id, 1), private.mu7_effective_answer(u.unit_id, 2)) = 'ROUTED'
                            and not exists (select 1 from public.mu7_adjudications x where x.unit_id = u.unit_id))
    into n_units, n_incomplete, n_pending
  from public.mu7_units u where u.mode = new.mode;
  -- GUARD MU7-G48 BEGIN
  if new.mode = 'FORMAL' and not (private.mu7_closed() and private.mu7_snapshot_taken()) then
    raise exception 'MU7-G48: the FORMAL reference is locked after the close and the snapshot';
  end if;
  if new.mode = 'PILOT' and n_incomplete > 0 then
    raise exception 'MU7-G48: % PILOT units lack an answer from both reviewers', n_incomplete;
  end if;
  if n_pending > 0 then
    raise exception 'MU7-G48: % routed units are not adjudicated', n_pending;
  end if;
  -- GUARD MU7-G48 END
  new.n_units_locked := n_units;
  new.locked_at := now();
  return new;
end $$;

create function private.mu7_exports_before_insert() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  t record;
begin
  -- GUARD MU7-G49 BEGIN
  if not private.mu7_locked(new.mode) then
    raise exception 'MU7-G49: a % export is registered after the % reference lock', new.mode, new.mode;
  end if;
  if new.mode = 'FORMAL' then
    select * into t from private.mu7_judgments_text();
    if not exists (select 1 from public.mu7_snapshot s where s.n_rows = t.n and s.content_sha256 = private.sha256_hex(coalesce(t.txt, ''))) then
      raise exception 'MU7-G49: the judgments no longer match the snapshot';
    end if;
  end if;
  -- GUARD MU7-G49 END
  new.created_at := now();
  return new;
end $$;

-- Audit (hash-chained public.audit_log of schema.sql). No answer content: judgments and adjudications are logged as
-- identifiers and a content hash, units and training units without their packet.
create function private.audit_row_mu7() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  rec jsonb := to_jsonb(new);
  pk text;
  details jsonb;
begin
  pk := coalesce(rec ->> 'judgment_id', rec ->> 'adjudication_id', rec ->> 'assignment_id', rec ->> 'event_id',
                 rec ->> 'freeze_id', rec ->> 'snapshot_id', rec ->> 'lock_id', rec ->> 'export_id', rec ->> 'design_id',
                 rec ->> 'training_unit_id', rec ->> 'gate_id', rec ->> 'unit_id', rec ->> 'reviewer_pseudo_id');
  if tg_table_name = 'mu7_judgments' then
    details := jsonb_build_object('unit_id', rec ->> 'unit_id', 'reviewer_pseudo_id', rec ->> 'reviewer_pseudo_id',
                                  'revision_number', rec ->> 'revision_number', 'content_sha256', rec ->> 'content_sha256');
  elsif tg_table_name = 'mu7_adjudications' then
    details := jsonb_build_object('unit_id', rec ->> 'unit_id',
                                  'content_sha256', private.sha256_hex(concat_ws('|', rec ->> 'decision', rec ->> 'reason_code',
                                                    rec ->> 'status', rec ->> 'basis', rec ->> 'rationale')));
  elsif tg_table_name in ('mu7_units', 'mu7_training_units') then
    details := rec - 'packet';
  else
    details := rec;
  end if;
  insert into public.audit_log (actor_user_id, actor_role, action, entity_table, entity_id, mode, details)
  values (private.app_user_id(), coalesce(private.app_role(), current_user), tg_op, tg_table_name, pk, rec ->> 'mode', details);
  return null;
end $$;

create trigger mu7_design_before_insert before insert on public.mu7_design for each row execute function private.mu7_design_before_insert();
create trigger mu7_units_before_insert before insert on public.mu7_units for each row execute function private.mu7_units_before_insert();
create trigger mu7_unit_design_before_insert before insert on public.mu7_unit_design for each row execute function private.mu7_unit_design_before_insert();
create trigger mu7_frozen_assignments_before_insert before insert on public.mu7_frozen_assignments for each row execute function private.mu7_frozen_assignments_before_insert();
create trigger mu7_training_units_before_insert before insert on public.mu7_training_units for each row execute function private.mu7_training_units_before_insert();
create trigger mu7_freeze_before_insert before insert on public.mu7_freeze for each row execute function private.mu7_freeze_before_insert();
create trigger mu7_queue_before_insert before insert on public.mu7_queue for each row execute function private.mu7_queue_before_insert();
create trigger mu7_phase_events_before_insert before insert on public.mu7_phase_events for each row execute function private.mu7_phase_events_before_insert();
create trigger mu7_judgments_before_insert before insert on public.mu7_judgments for each row execute function private.mu7_judgments_before_insert();
create trigger mu7_snapshot_before_insert before insert on public.mu7_snapshot for each row execute function private.mu7_snapshot_before_insert();
create trigger mu7_adjudications_before_insert before insert on public.mu7_adjudications for each row execute function private.mu7_adjudications_before_insert();
create trigger mu7_reference_locks_before_insert before insert on public.mu7_reference_locks for each row execute function private.mu7_reference_locks_before_insert();
create trigger mu7_exports_before_insert before insert on public.mu7_exports for each row execute function private.mu7_exports_before_insert();
-- new refusing triggers on earlier tables; PostgreSQL fires triggers of one event in name order, and the a00_ prefix
-- sorts before every earlier trigger on these tables (cases_v4_gate, cases_v5_guard, design_activation_v4_v5_guard,
-- tlv5_activation_before_insert, tlv5_cases_before_insert), so the v7 refusal is the first and only message
create trigger a00_mu7_old_design_guard before insert on public.tlv5_cases for each row execute function private.mu7_old_design_guard();
create trigger a00_mu7_old_design_guard before insert on public.tlv5_activation for each row execute function private.mu7_old_design_guard();
create trigger a00_mu7_old_design_guard before insert on public.design_activation_v4 for each row execute function private.mu7_old_design_guard();
create trigger a00_mu7_old_design_guard before insert on public.cases for each row execute function private.mu7_old_design_guard();

do $$
declare
  t text;
begin
  foreach t in array array['mu7_design', 'mu7_phase_events', 'mu7_units', 'mu7_unit_design', 'mu7_frozen_assignments',
                           'mu7_gate_approvals', 'mu7_freeze', 'mu7_queue', 'mu7_judgments', 'mu7_snapshot',
                           'mu7_adjudications', 'mu7_reference_locks', 'mu7_exports', 'mu7_training_units',
                           'mu7_training_acknowledgments']
  loop
    execute format('create trigger %I before update or delete on public.%I for each row execute function private.reject_mutation()',
                   t || '_append_only', t);
    execute format('create trigger %I before truncate on public.%I for each statement execute function private.reject_mutation()',
                   t || '_no_truncate', t);
    execute format('create trigger %I after insert on public.%I for each row execute function private.audit_row_mu7()',
                   t || '_audit', t);
    execute format('alter table public.%I enable row level security', t);
  end loop;
end $$;

-- -----------------------------------------------------------------------------
-- 7. Row-level security (reads only; every write goes through an RPC)
-- -----------------------------------------------------------------------------
create policy mu7_design_read on public.mu7_design for select to authenticated using (private.app_role() is not null);
create policy mu7_phase_events_read on public.mu7_phase_events for select to authenticated using (private.app_role() is not null);
create policy mu7_units_read on public.mu7_units for select to authenticated
  using (private.is_investigator() or private.mu7_reviewer_can_read_unit(unit_id)
         or (private.is_adjudicator() and private.mu7_can_read_judgments(mode)));
create policy mu7_unit_design_inv on public.mu7_unit_design for select to authenticated using (private.is_investigator());
create policy mu7_frozen_assignments_inv on public.mu7_frozen_assignments for select to authenticated using (private.is_investigator());
create policy mu7_gate_approvals_inv on public.mu7_gate_approvals for select to authenticated using (private.is_investigator());
create policy mu7_freeze_inv on public.mu7_freeze for select to authenticated using (private.is_investigator());
create policy mu7_queue_read on public.mu7_queue for select to authenticated
  using (private.is_investigator() or reviewer_pseudo_id = private.my_reviewer_pseudo_id()
         or (private.is_adjudicator() and private.mu7_can_read_judgments(mode)));
create policy mu7_judgments_read on public.mu7_judgments for select to authenticated
  using (reviewer_pseudo_id = private.my_reviewer_pseudo_id() or private.mu7_can_read_judgments(mode));
create policy mu7_snapshot_inv on public.mu7_snapshot for select to authenticated using (private.is_investigator());
create policy mu7_adjudications_read on public.mu7_adjudications for select to authenticated using (private.mu7_can_read_judgments(mode));
create policy mu7_reference_locks_read on public.mu7_reference_locks for select to authenticated
  using (private.is_investigator() or private.is_adjudicator());
create policy mu7_exports_inv on public.mu7_exports for select to authenticated using (private.is_investigator());
create policy mu7_training_units_read on public.mu7_training_units for select to authenticated using (private.app_role() is not null);
create policy mu7_training_ack_read on public.mu7_training_acknowledgments for select to authenticated
  using (private.is_investigator() or reviewer_pseudo_id = private.my_reviewer_pseudo_id());

-- -----------------------------------------------------------------------------
-- 8. Views (security_invoker: the caller's row-level security applies)
-- -----------------------------------------------------------------------------
create view public.v_mu7_my_queue with (security_invoker = true) as
select q.assignment_id, q.mode, q.reviewer_slot, q.queue_position, q.unit_id, private.mu7_unit_role(q.unit_id) as unit_role,
       exists (select 1 from public.mu7_judgments j where j.assignment_id = q.assignment_id) as answered,
       private.mu7_reviewer_can_read_unit(q.unit_id) as available
from public.mu7_queue q
where q.reviewer_pseudo_id = private.my_reviewer_pseudo_id();

-- Export 1 (bundle 7.0): one row per assignment (unit x reviewer slot). judgment_status NOT_ANSWERED marks an
-- assignment with no answer (state 3, absent), never a blank answer.
create view public.v_mu7_independent_judgments with (security_invoker = true) as
with j as (
  select j.assignment_id, j.answer, j.reason_code, j.note, j.uncertain, j.revision_number, j.submitted_at,
         row_number() over (partition by j.assignment_id order by j.revision_number) as rn_first,
         row_number() over (partition by j.assignment_id order by j.revision_number desc) as rn_last,
         count(*) over (partition by j.assignment_id) as n_rev,
         min(j.submitted_at) over (partition by j.assignment_id) as first_at,
         max(j.submitted_at) over (partition by j.assignment_id) as last_at
  from public.mu7_judgments j
)
select q.unit_id, q.mode, q.reviewer_slot, q.reviewer_pseudo_id, q.queue_position,
       case when f.assignment_id is null then 'NOT_ANSWERED' else 'ANSWERED' end as judgment_status,
       f.answer as answer_initial, f.reason_code as reason_initial, f.note as note_initial, f.uncertain as uncertain_initial,
       l.answer as answer_effective, l.reason_code as reason_effective, l.note as note_effective, l.uncertain as uncertain_effective,
       coalesce(f.n_rev - 1, 0)::integer as n_revisions, f.first_at as first_submitted_at, f.last_at as last_submitted_at
from public.mu7_queue q
left join j f on f.assignment_id = q.assignment_id and f.rn_first = 1
left join j l on l.assignment_id = q.assignment_id and l.rn_last = 1
where private.mu7_can_read_judgments(q.mode);

-- Export 2 (bundle 7.0): one row per unit with the final answer and how it was reached
create view public.v_mu7_final_reference with (security_invoker = true) as
with e as (
  select v.unit_id,
         max(v.answer_initial) filter (where v.reviewer_slot = 1) as i1, max(v.answer_initial) filter (where v.reviewer_slot = 2) as i2,
         max(v.answer_effective) filter (where v.reviewer_slot = 1) as a1, max(v.answer_effective) filter (where v.reviewer_slot = 2) as a2
  from public.v_mu7_independent_judgments v group by v.unit_id
)
select u.unit_id, u.mode, u.family, u.category, u.unit_role, u.mapping_code, u.assignment_code, u.assignment_status,
       e.i1 as answer_initial_slot1, e.i2 as answer_initial_slot2, e.a1 as answer_effective_slot1, e.a2 as answer_effective_slot2,
       private.mu7_routing(e.a1, e.a2) as routing,
       case private.mu7_routing(e.a1, e.a2) when 'CONCORDANT_AGREE' then 'AGREE' when 'CONCORDANT_DISAGREE' then 'DISAGREE'
            when 'BOTH_CANNOT_TELL' then 'CANNOT_TELL' when 'ROUTED' then x.decision end as final_answer,
       case private.mu7_routing(e.a1, e.a2)
            when 'CONCORDANT_AGREE' then 'CONCORDANT' when 'CONCORDANT_DISAGREE' then 'CONCORDANT'
            when 'BOTH_CANNOT_TELL' then 'CANNOT_TELL_BY_RULE'
            when 'ROUTED' then case when x.adjudication_id is null then 'PENDING_ADJUDICATION'
                                    when x.status = 'UNRESOLVED_ESCALATED' then 'UNRESOLVED' else 'ADJUDICATED' end
            else 'INCOMPLETE' end as final_status,
       x.reason_code as adjudication_reason_code, x.status as adjudication_status, x.basis as adjudication_basis,
       x.disagreement_reason_code as adjudication_disagreement_reason_code
from public.mu7_units u
join e on e.unit_id = u.unit_id
left join public.mu7_adjudications x on x.unit_id = u.unit_id
where private.mu7_can_read_judgments(u.mode);

create view public.v_mu7_adjudication_queue with (security_invoker = true) as
select r.unit_id, r.mode, r.family, r.category, r.unit_role, r.mapping_code, r.assignment_code, u.packet,
       s1.answer_effective as reviewer_1_answer, s1.reason_effective as reviewer_1_reason_code, s1.note_effective as reviewer_1_note,
       s1.uncertain_effective as reviewer_1_uncertain,
       s2.answer_effective as reviewer_2_answer, s2.reason_effective as reviewer_2_reason_code, s2.note_effective as reviewer_2_note,
       s2.uncertain_effective as reviewer_2_uncertain,
       r.final_status in ('ADJUDICATED', 'UNRESOLVED') as adjudicated
from public.v_mu7_final_reference r
join public.mu7_units u on u.unit_id = r.unit_id
join public.v_mu7_independent_judgments s1 on s1.unit_id = r.unit_id and s1.reviewer_slot = 1
join public.v_mu7_independent_judgments s2 on s2.unit_id = r.unit_id and s2.reviewer_slot = 2
where r.routing = 'ROUTED' and (private.is_adjudicator() or private.is_investigator());

-- Export 3 and 4 (bundle 7.0, investigator only through row-level security)
create view public.v_mu7_export_units with (security_invoker = true) as
select u.unit_id, u.mode, u.record_category, u.family, u.category, u.unit_role, u.mapping_code, u.assignment_code,
       u.assignment_status, u.parent_row_code, u.packet_sha256, u.created_at
from public.mu7_units u where private.is_investigator();

create view public.v_mu7_export_unit_design with (security_invoker = true) as
select d.unit_id, d.mode, d.nct_id, d.frame_id, d.stratum, d.frame_stratum_size, d.n_sampled_in_stratum, d.selection_probability,
       d.sampling_seed, d.prn_key, d.allocation_option, d.overlap_setting, d.design_version, d.freeze_status, d.freeze_gate,
       d.design_row_sha256, a.assignment_set_id, a.row_sha256 as assignment_row_sha256
from public.mu7_unit_design d
left join public.mu7_frozen_assignments a on a.unit_id = d.unit_id
where private.is_investigator();

-- -----------------------------------------------------------------------------
-- 9. RPCs (the only write path). SECURITY DEFINER, empty search_path.
-- -----------------------------------------------------------------------------
create function private.mu7_assert_keys(p jsonb, p_allowed text[], p_what text) returns void
language plpgsql immutable set search_path = '' as $$
declare
  bad text;
begin
  -- GUARD MU7-G07 BEGIN
  if p is null or jsonb_typeof(p) <> 'object' then
    raise exception 'MU7-G07: % needs a JSON object', p_what using errcode = '22023';
  end if;
  select k into bad from jsonb_object_keys(p) k where not (k = any (p_allowed)) limit 1;
  if bad is not null then
    raise exception 'MU7-G07: key "%" is not accepted by %', bad, p_what using errcode = '22023';
  end if;
  -- GUARD MU7-G07 END
end $$;

create function public.rpc_mu7_record_design(p jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := private.assert_investigator();
  rid uuid;
begin
  perform private.mu7_assert_keys(p, array['design_version', 'assignment_set_id', 'overlap_setting', 'n_primary_planned',
                                           'n_subgroup_planned', 'attestation'], 'rpc_mu7_record_design');
  insert into public.mu7_design (design_version, assignment_set_id, overlap_setting, n_primary_planned, n_subgroup_planned,
                                 attestation, recorded_by)
  values (p ->> 'design_version', p ->> 'assignment_set_id', p ->> 'overlap_setting', (p ->> 'n_primary_planned')::integer,
          (p ->> 'n_subgroup_planned')::integer, p ->> 'attestation', me)
  returning design_id into rid;
  return rid;
end $$;

create function public.rpc_mu7_enroll_reviewer(p_user_id uuid, p_qualifications text default null) returns text
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := private.assert_investigator();
  pid text;
  alphabet text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  i int;
begin
  -- GUARD MU7-G08 BEGIN
  if not private.mu7_signed_off() then
    raise exception 'MU7-G08: FORMAL v7 reviewers are enrolled after the v7 pilot sign-off';
  end if;
  -- GUARD MU7-G08 END
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

-- One unit: packet (reviewer-visible), the investigator-only design row and, for FORMAL, the frozen assignment.
-- The call is atomic: any refusal leaves nothing behind.
create function public.rpc_mu7_import_unit(p jsonb) returns text
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := private.assert_investigator();
  m text := p ->> 'mode';
  d jsonb := p -> 'design';
  a jsonb := p -> 'assignment';
begin
  perform private.mu7_assert_keys(p, array['unit_id', 'mode', 'record_category', 'family', 'category', 'unit_role', 'mapping_code',
                                           'assignment_code', 'assignment_status', 'parent_row_code', 'packet', 'design',
                                           'assignment'], 'rpc_mu7_import_unit');
  insert into public.mu7_units (unit_id, mode, record_category, family, category, unit_role, mapping_code, assignment_code,
                                assignment_status, parent_row_code, packet, packet_sha256, created_by)
  values (p ->> 'unit_id', m, case m when 'PILOT' then 'SYNTHETIC_PILOT' else 'MAPPING_UNIT_FORMAL' end, p ->> 'family',
          p ->> 'category', p ->> 'unit_role', p ->> 'mapping_code', p ->> 'assignment_code', p ->> 'assignment_status',
          p ->> 'parent_row_code', p -> 'packet', repeat('0', 64), me);
  -- GUARD MU7-G13 BEGIN
  if d is null then
    raise exception 'MU7-G13: every unit is imported with its design row';
  end if;
  if (m = 'FORMAL') <> (a is not null) then
    raise exception 'MU7-G13: a FORMAL unit is imported with its frozen assignment, and a PILOT unit without one';
  end if;
  if p ? 'record_category' and (p ->> 'record_category') is distinct from
     (case m when 'PILOT' then 'SYNTHETIC_PILOT' else 'MAPPING_UNIT_FORMAL' end) then
    raise exception 'MU7-G13: record_category must be SYNTHETIC_PILOT for PILOT and MAPPING_UNIT_FORMAL for FORMAL';
  end if;
  -- GUARD MU7-G13 END
  perform private.mu7_assert_keys(d, array['nct_id', 'frame_id', 'stratum', 'frame_stratum_size', 'n_sampled_in_stratum',
                                           'selection_probability', 'sampling_seed', 'prn_key', 'allocation_option',
                                           'overlap_setting', 'design_version', 'freeze_status', 'freeze_gate'], 'the design row');
  insert into public.mu7_unit_design (unit_id, mode, nct_id, frame_id, stratum, frame_stratum_size, n_sampled_in_stratum,
                                      selection_probability, sampling_seed, prn_key, allocation_option, overlap_setting,
                                      design_version, freeze_status, freeze_gate, design_row_sha256, imported_by)
  values (p ->> 'unit_id', m, d ->> 'nct_id', d ->> 'frame_id', d ->> 'stratum', (d ->> 'frame_stratum_size')::integer,
          (d ->> 'n_sampled_in_stratum')::integer, (d ->> 'selection_probability')::double precision,
          (d ->> 'sampling_seed')::bigint, d ->> 'prn_key', d ->> 'allocation_option', d ->> 'overlap_setting',
          d ->> 'design_version', d ->> 'freeze_status', d ->> 'freeze_gate', repeat('0', 64), me);
  if a is not null then
    perform private.mu7_assert_keys(a, array['assignment_set_id', 'mapping_code', 'assignment_code', 'assignment_status',
                                             'row_sha256'], 'the frozen assignment');
    insert into public.mu7_frozen_assignments (unit_id, mode, assignment_set_id, mapping_code, assignment_code, assignment_status,
                                               row_sha256, imported_by)
    values (p ->> 'unit_id', m, a ->> 'assignment_set_id', a ->> 'mapping_code', a ->> 'assignment_code',
            a ->> 'assignment_status', a ->> 'row_sha256', me);
  end if;
  return p ->> 'unit_id';
end $$;

create function public.rpc_mu7_import_training_unit(p jsonb) returns text
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := private.assert_investigator();
begin
  perform private.mu7_assert_keys(p, array['training_unit_id', 'packet'], 'rpc_mu7_import_training_unit');
  insert into public.mu7_training_units (training_unit_id, nct_id, packet, packet_sha256, imported_by)
  values (p ->> 'training_unit_id', 'SYN-NCT-0000', p -> 'packet', repeat('0', 64), me);
  return p ->> 'training_unit_id';
end $$;

create function public.rpc_mu7_approve_gate(p_gate_id text, p_attestation text, p_evidence_reference text default null) returns text
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := private.assert_investigator();
begin
  insert into public.mu7_gate_approvals (gate_id, attestation, evidence_reference, approved_by)
  values (p_gate_id, p_attestation, p_evidence_reference, me);
  return p_gate_id;
end $$;

create function public.rpc_mu7_freeze(p jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := private.assert_investigator();
  fid uuid;
begin
  perform private.mu7_assert_keys(p, array['unit_list_sha256', 'assignment_set_sha256', 'design_rows_sha256', 'queue_sha256',
                                           'attestation'], 'rpc_mu7_freeze');
  insert into public.mu7_freeze (unit_list_sha256, assignment_set_sha256, design_rows_sha256, queue_sha256, attestation, frozen_by)
  values (p ->> 'unit_list_sha256', p ->> 'assignment_set_sha256', p ->> 'design_rows_sha256', p ->> 'queue_sha256',
          p ->> 'attestation', me)
  returning freeze_id into fid;
  return fid;
end $$;

-- Both reviewer queues of one mode in one call: {"slots": [{"reviewer_slot": 1, "reviewer_pseudo_id": "...",
-- "unit_ids": [...in queue order...]}, {"reviewer_slot": 2, ...}]}. All or nothing.
create function public.rpc_mu7_assign_queue(p_mode text, p jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := private.assert_investigator();
  s jsonb;
  n_units integer; n_primary integer; n_rows integer;
  bad integer;
  h text;
begin
  perform private.mu7_assert_keys(p, array['slots'], 'rpc_mu7_assign_queue');
  select count(*), count(*) filter (where u.unit_role = 'PRIMARY') into n_units, n_primary from public.mu7_units u where u.mode = p_mode;
  for s in select * from jsonb_array_elements(coalesce(p -> 'slots', '[]'::jsonb)) loop
    perform private.mu7_assert_keys(s, array['reviewer_slot', 'reviewer_pseudo_id', 'unit_ids'], 'a queue slot');
    insert into public.mu7_queue (unit_id, mode, reviewer_pseudo_id, reviewer_slot, queue_position, assigned_by)
    select e.value, p_mode, s ->> 'reviewer_pseudo_id', (s ->> 'reviewer_slot')::smallint, e.ordinality::integer, me
    from jsonb_array_elements_text(s -> 'unit_ids') with ordinality e;
  end loop;
  select count(*) into n_rows from public.mu7_queue q where q.mode = p_mode;
  -- GUARD MU7-G60 BEGIN
  if n_units = 0 or n_rows <> 2 * n_units
     or (select count(distinct q.reviewer_slot) from public.mu7_queue q where q.mode = p_mode) <> 2 then
    raise exception 'MU7-G60: the queue covers every % unit for both reviewer slots in one call (% rows for % units)',
      p_mode, n_rows, n_units;
  end if;
  -- GUARD MU7-G60 END
  select count(*) into bad from public.mu7_queue q join public.mu7_units u on u.unit_id = q.unit_id
  where q.mode = p_mode and ((u.unit_role = 'PRIMARY') <> (q.queue_position <= n_primary));
  -- GUARD MU7-G61 BEGIN
  if bad > 0 then
    raise exception 'MU7-G61: primary units take the first % positions of each queue and subgroup units follow', n_primary;
  end if;
  -- GUARD MU7-G61 END
  select count(*) into bad
  from public.mu7_queue q1
  join public.mu7_queue q2 on q2.mode = q1.mode and q2.reviewer_slot = q1.reviewer_slot and q2.queue_position = q1.queue_position + 1
  join public.mu7_unit_design d1 on d1.unit_id = q1.unit_id
  join public.mu7_unit_design d2 on d2.unit_id = q2.unit_id
  where q1.mode = p_mode and d1.nct_id = d2.nct_id;
  -- GUARD MU7-G62 BEGIN
  if bad > 0 then
    raise exception 'MU7-G62: two units of the same trial are never adjacent in a queue (% adjacent pairs)', bad;
  end if;
  -- GUARD MU7-G62 END
  if p_mode = 'FORMAL' then
    select private.sha256_hex(string_agg(q.reviewer_slot::text || '|' || q.queue_position::text || '|' || q.unit_id, E'\n'
                                         order by q.reviewer_slot, q.queue_position))
      into h from public.mu7_queue q where q.mode = 'FORMAL';
    -- GUARD MU7-G63 BEGIN
    if h is distinct from (select f.queue_sha256 from public.mu7_freeze f) then
      raise exception 'MU7-G63: the FORMAL queue does not match the frozen queue hash';
    end if;
    -- GUARD MU7-G63 END
  end if;
  return n_rows;
end $$;

create function public.rpc_mu7_phase(p_event_type text, p jsonb default '{}'::jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := private.assert_investigator();
  eid uuid;
begin
  perform private.mu7_assert_keys(p, array['checklist_version', 'checklist_sha256', 'app_git_sha', 'pilot_export_id', 'attestation'],
                                  'rpc_mu7_phase');
  insert into public.mu7_phase_events (event_type, checklist_version, checklist_sha256, app_git_sha, pilot_export_id, attestation, actor)
  values (p_event_type, p ->> 'checklist_version', p ->> 'checklist_sha256', p ->> 'app_git_sha',
          (p ->> 'pilot_export_id')::uuid, p ->> 'attestation', me)
  returning event_id into eid;
  return eid;
end $$;

-- The reviewer's screen for one assignment: the packet, the queue position and the role. Server-side gates.
create function public.rpc_mu7_get_unit(p_assignment_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  q record;
  u record;
begin
  select * into q from public.mu7_queue x where x.assignment_id = p_assignment_id;
  -- GUARD MU7-G54 BEGIN
  if q.assignment_id is null or q.reviewer_pseudo_id is distinct from private.my_reviewer_pseudo_id() then
    raise exception 'MU7-G54: this assignment is not yours' using errcode = '42501';
  end if;
  -- GUARD MU7-G54 END
  -- GUARD MU7-G55 BEGIN
  if q.mode = 'FORMAL' and private.mu7_phase() not in ('OPEN', 'CLOSED_COMPLETE', 'CLOSED_INCOMPLETE') then
    raise exception 'MU7-G55: FORMAL units open with the formal phase';
  end if;
  -- GUARD MU7-G55 END
  select * into u from public.mu7_units x where x.unit_id = q.unit_id;
  -- GUARD MU7-G56 BEGIN
  if u.unit_role = 'SUBGROUP' and not private.mu7_primary_done(q.reviewer_pseudo_id, q.mode) then
    raise exception 'MU7-G56: subgroup units open after every primary unit of your queue is answered';
  end if;
  -- GUARD MU7-G56 END
  return jsonb_build_object('assignment_id', q.assignment_id, 'mode', q.mode, 'queue_position', q.queue_position,
                            'unit_role', u.unit_role, 'packet', u.packet);
end $$;

create function public.rpc_mu7_submit(p_assignment_id uuid, p jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  q record;
  jid uuid;
begin
  select * into q from public.mu7_queue x where x.assignment_id = p_assignment_id;
  -- GUARD MU7-G57 BEGIN
  if q.assignment_id is null or q.reviewer_pseudo_id is distinct from private.my_reviewer_pseudo_id() then
    raise exception 'MU7-G57: this assignment is not yours' using errcode = '42501';
  end if;
  -- GUARD MU7-G57 END
  perform private.mu7_assert_keys(p, array['answer', 'reason_code', 'note', 'uncertain', 'seconds_on_unit'], 'rpc_mu7_submit');
  insert into public.mu7_judgments (assignment_id, unit_id, mode, reviewer_pseudo_id, reviewer_slot, revision_number, answer,
                                    reason_code, note, uncertain, seconds_on_unit, content_sha256)
  values (q.assignment_id, q.unit_id, q.mode, q.reviewer_pseudo_id, q.reviewer_slot, 1, p ->> 'answer', p ->> 'reason_code',
          p ->> 'note', coalesce((p ->> 'uncertain')::boolean, false), (p ->> 'seconds_on_unit')::integer, repeat('0', 64))
  returning judgment_id into jid;
  return jid;
end $$;

create function public.rpc_mu7_snapshot() returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := private.assert_investigator();
  sid uuid;
begin
  insert into public.mu7_snapshot (taken_by) values (me) returning snapshot_id into sid;
  return sid;
end $$;

create function public.rpc_mu7_verify_snapshot()
returns table (n_rows_snapshot integer, n_rows_now integer, sha256_snapshot text, sha256_now text, matches boolean)
language plpgsql stable security definer set search_path = '' as $$
declare
  me uuid := private.assert_investigator();
  t record;
begin
  select * into t from private.mu7_judgments_text();
  return query select s.n_rows, t.n, s.content_sha256, private.sha256_hex(coalesce(t.txt, '')),
                      s.n_rows = t.n and s.content_sha256 = private.sha256_hex(coalesce(t.txt, ''))
               from public.mu7_snapshot s;
end $$;

create function public.rpc_mu7_verify_freeze()
returns table (quantity text, frozen text, recomputed text, matches boolean)
language plpgsql stable security definer set search_path = '' as $$
declare
  me uuid := private.assert_investigator();
  f record;
  h_units text; h_asg text; h_design text; h_queue text; h_packets text;
begin
  select * into f from public.mu7_freeze;
  select private.sha256_hex(string_agg(u.unit_id, E'\n' order by u.unit_id collate "C")),
         private.sha256_hex(string_agg(u.packet_sha256, E'\n' order by u.unit_id collate "C"))
    into h_units, h_packets from public.mu7_units u where u.mode = 'FORMAL';
  select private.sha256_hex(string_agg(private.sha256_hex(private.mu7_assignment_row_text(a.assignment_set_id, a.unit_id,
           a.mapping_code, a.assignment_code, a.assignment_status)), E'\n' order by a.unit_id collate "C"))
    into h_asg from public.mu7_frozen_assignments a;
  select private.sha256_hex(string_agg(private.sha256_hex(private.mu7_design_row_text(d.unit_id, d.nct_id, d.frame_id, d.stratum,
           d.frame_stratum_size, d.n_sampled_in_stratum, d.allocation_option, d.overlap_setting, d.sampling_seed, d.prn_key)),
           E'\n' order by d.unit_id collate "C"))
    into h_design from public.mu7_unit_design d where d.mode = 'FORMAL';
  select private.sha256_hex(string_agg(q.reviewer_slot::text || '|' || q.queue_position::text || '|' || q.unit_id, E'\n'
                                       order by q.reviewer_slot, q.queue_position))
    into h_queue from public.mu7_queue q where q.mode = 'FORMAL';
  return query values ('unit_list_sha256', f.unit_list_sha256, h_units, f.unit_list_sha256 = h_units),
                      ('assignment_set_sha256', f.assignment_set_sha256, h_asg, f.assignment_set_sha256 = h_asg),
                      ('design_rows_sha256', f.design_rows_sha256, h_design, f.design_rows_sha256 = h_design),
                      ('queue_sha256', f.queue_sha256, h_queue, f.queue_sha256 is not distinct from h_queue),
                      ('packets_sha256', f.packets_sha256, h_packets, f.packets_sha256 = h_packets);
end $$;

create function public.rpc_mu7_record_adjudication(p jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := private.app_user_id();
  aid uuid;
begin
  -- GUARD MU7-G58 BEGIN
  if not private.is_adjudicator() then
    raise exception 'MU7-G58: the adjudicator role is needed to adjudicate' using errcode = '42501';
  end if;
  -- GUARD MU7-G58 END
  perform private.mu7_assert_keys(p, array['unit_id', 'decision', 'reason_code', 'status', 'basis', 'disagreement_reason_code',
                                           'rationale'], 'rpc_mu7_record_adjudication');
  insert into public.mu7_adjudications (unit_id, mode, decision, reason_code, status, basis, disagreement_reason_code, rationale,
                                        decided_by)
  values (p ->> 'unit_id', 'PILOT', p ->> 'decision', p ->> 'reason_code', p ->> 'status', p ->> 'basis',
          p ->> 'disagreement_reason_code', p ->> 'rationale', me)
  returning adjudication_id into aid;
  return aid;
end $$;

create function public.rpc_mu7_lock_reference(p_mode text, p_attestation text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := private.assert_investigator();
  lid uuid;
begin
  insert into public.mu7_reference_locks (mode, attestation, locked_by) values (p_mode, p_attestation, me) returning lock_id into lid;
  return lid;
end $$;

create function public.rpc_mu7_register_export(p jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := private.assert_investigator();
  xid uuid;
begin
  perform private.mu7_assert_keys(p, array['mode', 'bundle_format_version', 'row_counts', 'file_sha256', 'manifest_sha256',
                                           'app_git_sha', 'notes'], 'rpc_mu7_register_export');
  insert into public.mu7_exports (mode, bundle_format_version, row_counts, file_sha256, manifest_sha256, app_git_sha, notes, created_by)
  values (p ->> 'mode', p ->> 'bundle_format_version', p -> 'row_counts', p -> 'file_sha256', p ->> 'manifest_sha256',
          p ->> 'app_git_sha', p ->> 'notes', me)
  returning export_id into xid;
  return xid;
end $$;

-- Optional acknowledgment that the reviewer read the worked examples (decision 22): a timestamp, gating nothing
create function public.rpc_mu7_acknowledge_training() returns timestamptz
language plpgsql security definer set search_path = '' as $$
declare
  me text := private.my_reviewer_pseudo_id();
  ts timestamptz;
begin
  -- GUARD MU7-G59 BEGIN
  if me is null then
    raise exception 'MU7-G59: only an enrolled reviewer acknowledges the worked examples' using errcode = '42501';
  end if;
  -- GUARD MU7-G59 END
  insert into public.mu7_training_acknowledgments (reviewer_pseudo_id) values (me) on conflict (reviewer_pseudo_id) do nothing;
  select a.acknowledged_at into ts from public.mu7_training_acknowledgments a where a.reviewer_pseudo_id = me;
  return ts;
end $$;

-- Progress counts only (no answer content): safe for the investigator while the formal phase is open
create function public.rpc_mu7_completion_summary(p_mode text)
returns table (reviewer_slot smallint, n_assigned integer, n_answered integer)
language plpgsql stable security definer set search_path = '' as $$
declare
  me uuid := private.assert_investigator();
begin
  return query
    select q.reviewer_slot, count(*)::integer,
           count(*) filter (where exists (select 1 from public.mu7_judgments j where j.assignment_id = q.assignment_id))::integer
    from public.mu7_queue q where q.mode = p_mode group by q.reviewer_slot order by q.reviewer_slot;
end $$;

-- -----------------------------------------------------------------------------
-- 10. Grants (reads filtered by row-level security, writes only through RPCs)
-- -----------------------------------------------------------------------------
revoke all on public.mu7_design, public.mu7_phase_events, public.mu7_units, public.mu7_unit_design, public.mu7_frozen_assignments,
              public.mu7_gate_approvals, public.mu7_freeze, public.mu7_queue, public.mu7_judgments, public.mu7_snapshot,
              public.mu7_adjudications, public.mu7_reference_locks, public.mu7_exports, public.mu7_training_units,
              public.mu7_training_acknowledgments, public.v_mu7_my_queue, public.v_mu7_independent_judgments,
              public.v_mu7_final_reference, public.v_mu7_adjudication_queue, public.v_mu7_export_units,
              public.v_mu7_export_unit_design
  from anon, authenticated;
grant select on public.mu7_design, public.mu7_phase_events, public.mu7_units, public.mu7_unit_design, public.mu7_frozen_assignments,
                public.mu7_gate_approvals, public.mu7_freeze, public.mu7_queue, public.mu7_judgments, public.mu7_snapshot,
                public.mu7_adjudications, public.mu7_reference_locks, public.mu7_exports, public.mu7_training_units,
                public.mu7_training_acknowledgments, public.v_mu7_my_queue, public.v_mu7_independent_judgments,
                public.v_mu7_final_reference, public.v_mu7_adjudication_queue, public.v_mu7_export_units,
                public.v_mu7_export_unit_design
  to authenticated;

do $$
declare
  f record;
begin
  -- every new private function: no client access by default
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'private' and (p.proname like 'mu7\_%' or p.proname like 'assert\_mu7\_%' or p.proname = 'audit_row_mu7')
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f.sig);
  end loop;
  -- every new RPC: authenticated only (each checks its caller)
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname like 'rpc\_mu7\_%'
  loop
    execute format('revoke all on function %s from public, anon', f.sig);
    execute format('grant execute on function %s to authenticated', f.sig);
  end loop;
end $$;
-- helpers called inside row-level security policies and security_invoker views: each returns only a boolean about the
-- caller's own rights, a unit's role, or a routing class computed from its arguments; none returns answer content
grant execute on function private.mu7_can_read_judgments(text), private.mu7_reviewer_can_read_unit(text),
                          private.mu7_unit_role(text), private.mu7_routing(text, text)
  to authenticated;

commit;
