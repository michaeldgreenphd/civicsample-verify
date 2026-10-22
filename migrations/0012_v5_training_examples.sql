-- =============================================================================
-- migrations/0005_v5_training_examples.sql
-- Clinical review schema v5.1: worked training examples (record category TRAINING_EXAMPLE, prefix EX5-,
-- mode TRAINING) and the trial's NCT identifier in the reviewer packet. Applies ON TOP OF the unchanged
-- schema.sql (v2), 0002 (v3), 0003 (v4) and 0004 (v5), in one transaction.
--
-- Status: PRE-BUILD, PROPOSED. Tested on PGlite only (tests_prebuild/pglite_rls_v5/rls_tests_v5_1.mjs,
-- SCHEMA_TEST_REPORT_v5_1.md). Live PostgreSQL 16 and Supabase migration and RLS tests are REQUIRED
-- before any formal reviewer is invited.
--
-- Why (investigator instruction of 2026-10-22):
--   1. Before the formal review, the reviewers train on three worked examples drawn from real trials of the
--      Figure 3 frame that are NOT in the 100-trial sample. In example 3 the two reviewers disagree, and the
--      disagreement must pass through the adjudicator queue end to end in staging. Calibration cases (CAL5-)
--      are never adjudicated, so the examples get their own category: TRAINING_EXAMPLE, prefix EX5-, mode
--      TRAINING. A training case carries no design row and no label, never appears in the formal queue view
--      or in any export view, and closes when the formal phase opens.
--   2. The reviewer packet shows the trial's NCT identifier as text, without a registry link. 0004 refused
--      any NCT identifier in a packet; 0005 permits exactly one, as trial.nct_id, in the registry format.
--      The registry address and every other blinded key stay refused. This relaxes one 0004 packet rule on
--      the investigator's decision. Residual risk: a reviewer who looks the trial up in the registry sees
--      enrollment, the sex of participants and posted results (REVIEW_RUBRIC_v5_1.md, section 13).
--   3. Overlap guards (strengthenings): a trial used as a training example or a calibration case cannot be
--      imported as a FORMAL case, and the reverse; a packet's trial.nct_id must equal its design row; a trial
--      appears at most once per mode in the design rows.
--
-- What 0005 changes. Nothing else of schema.sql, 0002, 0003 or 0004 is touched.
--   a. CHECK constraints that enumerate modes or categories on tlv5_cases, tlv5_assignments,
--      tlv5_adjudications and tlv5_reference_locks are replaced by versions that add TRAINING and
--      TRAINING_EXAMPLE (the block refuses to run unless it finds exactly the 9 checks that 0004 created).
--   b. Functions replaced with the same signatures (CREATE OR REPLACE keeps owner and privileges):
--      assert_tlv5_packet_blinded, tlv5_can_read_answers, tlv5_cases_before_insert,
--      tlv5_case_design_before_insert, tlv5_assignments_before_insert, tlv5_submissions_before_insert,
--      tlv5_adjudications_before_insert, rpc_tlv5_import_case.
--   c. Policy tlv5_cases_read altered: the adjudicator also reads TRAINING packets.
--   d. Views replaced with the same columns: v_tlv5_my_queue (TRAINING rows removed) and
--      v_tlv5_adjudication_queue (TRAINING rows added).
--   e. New objects: view v_tlv5_my_training_queue, helper private.tlv5_packet_nct(jsonb), unique index
--      tlv5_case_design_mode_nct_unique.
-- Unchanged on purpose: the three export views and tlv5_exports (TRAINING is never exported), the freeze
-- (FORMAL cases and labels only), the snapshot (FORMAL judgments only), every FORMAL adjudication rule.
--
-- Apply after 0004:
--   psql -v ON_ERROR_STOP=1 -f migrations/0005_v5_training_examples.sql
-- =============================================================================
begin;

insert into public.app_schema_version (version, description)
values ('5.1.0', 'review design v5.1: worked training examples (EX5-, TRAINING mode) and the NCT identifier in the reviewer packet');

-- -----------------------------------------------------------------------------
-- a. Mode and category constraints
-- -----------------------------------------------------------------------------
do $$
declare
  r record;
  n integer := 0;
begin
  for r in
    select c.conrelid::regclass as tbl, c.conname
    from pg_constraint c
    where c.contype = 'c'
      and c.conrelid in ('public.tlv5_cases'::regclass, 'public.tlv5_assignments'::regclass,
                         'public.tlv5_adjudications'::regclass, 'public.tlv5_reference_locks'::regclass)
      and pg_get_constraintdef(c.oid) ~ '\m(mode|record_category)\M'
    order by 1, 2
  loop
    execute format('alter table %s drop constraint %I', r.tbl, r.conname);
    n := n + 1;
  end loop;
  if n <> 9 then
    raise exception '0005 expected the 9 mode and category checks created by 0004, found %; inspect the database before applying 0005', n;
  end if;
end $$;

alter table public.tlv5_cases
  add constraint tlv5_cases_mode_v51 check (mode in ('PILOT', 'CALIBRATION', 'FORMAL', 'TRAINING')),
  add constraint tlv5_cases_category_v51 check (record_category in ('SYNTHETIC_PILOT', 'RUBRIC_CALIBRATION',
                                                                    'LABEL_VERIFICATION_FORMAL', 'TRAINING_EXAMPLE')),
  add constraint tlv5_cases_prefix_pilot_v51 check ((mode = 'PILOT') = (case_id like 'SYN-%')),
  add constraint tlv5_cases_prefix_calibration_v51 check ((mode = 'CALIBRATION') = (case_id like 'CAL5-%')),
  add constraint tlv5_cases_prefix_formal_v51 check ((mode = 'FORMAL') = (case_id like 'TLV5-%')),
  add constraint tlv5_cases_prefix_training_v51 check ((mode = 'TRAINING') = (case_id ~ '^EX5-[0-9]{2}$')),
  add constraint tlv5_cases_category_mode_v51 check (
        (mode = 'PILOT' and record_category = 'SYNTHETIC_PILOT')
     or (mode = 'CALIBRATION' and record_category = 'RUBRIC_CALIBRATION')
     or (mode = 'FORMAL' and record_category = 'LABEL_VERIFICATION_FORMAL')
     or (mode = 'TRAINING' and record_category = 'TRAINING_EXAMPLE'));
alter table public.tlv5_assignments
  add constraint tlv5_assignments_mode_v51 check (mode in ('PILOT', 'CALIBRATION', 'FORMAL', 'TRAINING'));
alter table public.tlv5_adjudications
  add constraint tlv5_adjudications_mode_v51 check (mode in ('PILOT', 'FORMAL', 'TRAINING'));
alter table public.tlv5_reference_locks
  add constraint tlv5_reference_locks_mode_v51 check (mode in ('PILOT', 'FORMAL', 'TRAINING'));

-- A trial appears at most once per mode in the design rows (a strengthening).
create unique index tlv5_case_design_mode_nct_unique on public.tlv5_case_design (mode, nct_id);

-- -----------------------------------------------------------------------------
-- b. Helpers and the packet guard
-- -----------------------------------------------------------------------------
-- The NCT identifier a packet shows (trial.nct_id), or null.
create function private.tlv5_packet_nct(p jsonb) returns text
language sql immutable set search_path = '' as $$
  select p -> 'trial' ->> 'nct_id'
$$;

-- Reviewer-visible trial packet (v5.1): allow-listed keys; the NCT identifier at most once, as trial.nct_id,
-- in the registry format; no other blinded key at any depth; no registry address or link anywhere.
create or replace function private.assert_tlv5_packet_blinded(p jsonb) returns void
language plpgsql immutable set search_path = '' as $$
declare
  bad text;
  n_nct integer;
begin
  select k into bad from jsonb_object_keys(p) k
  where k not in ('schema_version', 'case_title', 'trial', 'notices') limit 1;
  if bad is not null then
    raise exception 'v5 packet top-level key "%" is not on the reviewer-visible allow list', bad using errcode = '22023';
  end if;
  select k into bad from private.jsonb_all_keys(coalesce(p -> 'trial', '{}'::jsonb)) k
  where k not in ('nct_id', 'brief_title', 'official_title', 'conditions_registered', 'condition_mesh_headings', 'brief_summary',
                  'interventions', 'intervention_type', 'name', 'description', 'eligibility_age_range',
                  'minimum_age', 'maximum_age')
  limit 1;
  if bad is not null then
    raise exception 'v5 trial packet key "%" is not on the reviewer-visible allow list', bad using errcode = '22023';
  end if;
  select count(*) into n_nct from private.jsonb_all_keys(p) k where k = 'nct_id';
  if n_nct > 1 or (n_nct = 1 and not (coalesce(p -> 'trial', '{}'::jsonb) ? 'nct_id')) then
    raise exception 'v5.1 packets carry the NCT identifier once, as trial.nct_id, and nowhere else' using errcode = '22023';
  end if;
  if n_nct = 1 and (jsonb_typeof(p -> 'trial' -> 'nct_id') is distinct from 'string'
                    or private.tlv5_packet_nct(p) !~ '^(NCT[0-9]{8}|SYN-NCT-?[0-9]{4,8})$') then
    raise exception 'trial.nct_id must be NCT followed by 8 digits (SYN-NCT- and 4 to 8 digits for synthetic cases)' using errcode = '22023';
  end if;
  select k into bad from private.jsonb_all_keys(p) k
  where k <> 'nct_id'
    and k ~* '(^ai_|_ai_|stage_?[abcd]($|_)|llm|prompt|stratum|strata|selection_prob|sampling|weight|tier|label|curated|decision|proposed|adjudicat|reviewer|confidence|rule_|original|expected|enrol|(^|_)sex($|_)|gender|female|(^|_)male($|_)|participant|(^|_)counts?($|_)|ppr|benchmark|result|tree|root|nct|url|link)'
  limit 1;
  if bad is not null then
    raise exception 'v5 packet key "%" could carry blinded content and is not allowed', bad using errcode = '22023';
  end if;
  if p::text ~* 'clinicaltrials\.gov' then
    raise exception 'v5 packets carry no registry address or link (the registry record shows enrollment, sex and results)'
      using errcode = '22023';
  end if;
end $$;

-- Can the current session read the reviewers' answers for a case of this mode?
-- Investigator: PILOT, CALIBRATION and TRAINING any time; FORMAL only after the close. Adjudicator: PILOT and
-- TRAINING any time; FORMAL after the close AND the snapshot; never CALIBRATION.
create or replace function private.tlv5_can_read_answers(p_mode text) returns boolean
language sql stable security definer set search_path = '' as $$
  select case
    when private.is_investigator() then p_mode in ('PILOT', 'CALIBRATION', 'TRAINING') or private.tlv5_phase() = 'CLOSED'
    when private.is_adjudicator() then p_mode in ('PILOT', 'TRAINING')
                                       or (p_mode = 'FORMAL' and private.tlv5_phase() = 'CLOSED' and private.tlv5_snapshot_taken())
    else false end
$$;

-- -----------------------------------------------------------------------------
-- c. Triggers (replaced; every 0004 rule is kept, the TRAINING rules and the overlap guards are added)
-- -----------------------------------------------------------------------------
create or replace function private.tlv5_cases_before_insert() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  nct text;
begin
  perform private.assert_tlv5_packet_blinded(new.packet);
  new.packet_sha256 := private.sha256_hex(new.packet::text);
  nct := private.tlv5_packet_nct(new.packet);
  if new.mode in ('FORMAL', 'CALIBRATION', 'TRAINING') and not private.tlv5_active() then
    raise exception 'activate design v5 before importing % cases', new.mode;
  end if;
  if new.mode in ('FORMAL', 'CALIBRATION') and private.tlv5_frozen() then
    raise exception 'the v5 sample is frozen; % case % cannot be added', new.mode, new.case_id;
  end if;
  if new.mode = 'TRAINING' then
    if private.tlv5_phase() <> 'NOT_OPENED' then
      raise exception 'training examples close when the formal phase opens; % cannot be added', new.case_id;
    end if;
    if nct is null then
      raise exception 'a TRAINING packet shows its trial: trial.nct_id is required';
    end if;
    if exists (select 1 from public.tlv5_cases c where c.mode = 'TRAINING' and private.tlv5_packet_nct(c.packet) = nct) then
      raise exception 'trial % is already a training example', nct;
    end if;
  end if;
  if new.mode in ('TRAINING', 'CALIBRATION') and nct is not null
     and exists (select 1 from public.tlv5_case_design d where d.mode = 'FORMAL' and d.nct_id = nct) then
    raise exception 'trial % is a FORMAL case; it cannot also be a % case', nct, new.mode;
  end if;
  return new;
end $$;

create or replace function private.tlv5_case_design_before_insert() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  pk_nct text;
begin
  if new.mode = 'FORMAL' and private.tlv5_frozen() then
    raise exception 'the v5 sample is frozen; design rows cannot be added';
  end if;
  select private.tlv5_packet_nct(c.packet) into pk_nct from public.tlv5_cases c where c.case_id = new.case_id;
  if pk_nct is not null and pk_nct <> new.nct_id then
    raise exception 'the packet of case % shows a different trial than its design row', new.case_id;
  end if;
  if new.mode = 'FORMAL' and exists (select 1 from public.tlv5_cases c
                                     where c.mode in ('TRAINING', 'CALIBRATION') and private.tlv5_packet_nct(c.packet) = new.nct_id) then
    raise exception 'trial % is a training example or a calibration case; it cannot be a FORMAL case', new.nct_id;
  end if;
  return new;
end $$;

create or replace function private.tlv5_assignments_before_insert() returns trigger
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
  elsif new.mode = 'TRAINING' and private.tlv5_phase() <> 'NOT_OPENED' then
    raise exception 'training examples close when the formal phase opens';
  end if;
  select a.reviewer_slot into other_slot from public.tlv5_assignments a
  where a.reviewer_pseudo_id = new.reviewer_pseudo_id and a.mode = new.mode and a.reviewer_slot <> new.reviewer_slot limit 1;
  if other_slot is not null then
    raise exception 'reviewer % already holds slot %; a reviewer keeps one slot for all cases of a mode', new.reviewer_pseudo_id, other_slot;
  end if;
  return new;
end $$;

create or replace function private.tlv5_submissions_before_insert() returns trigger
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
  if new.mode = 'TRAINING' and private.tlv5_phase() <> 'NOT_OPENED' then
    raise exception 'training examples closed when the formal phase opened';
  end if;
  if new.mode = 'TRAINING' and private.tlv5_locked('TRAINING') then
    raise exception 'the training reference is locked; training submissions are closed';
  end if;
  select max(s.revision_number) into prev from public.tlv5_submissions s where s.assignment_id = new.assignment_id;
  new.revision_number := coalesce(prev, 0) + 1;
  new.submitted_at := now();
  return new;
end $$;

create or replace function private.tlv5_adjudications_before_insert() returns trigger
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
      raise exception 'pilot and training items are adjudicated by the investigator or an ADJUDICATOR';
    end if;
    if new.mode = 'TRAINING' and private.tlv5_phase() <> 'NOT_OPENED' then
      raise exception 'training examples closed when the formal phase opened; no training adjudication after that';
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

-- -----------------------------------------------------------------------------
-- d. Import RPC (replaced): TRAINING maps to TRAINING_EXAMPLE; CALIBRATION and TRAINING carry no design row
-- -----------------------------------------------------------------------------
create or replace function public.rpc_tlv5_import_case(p jsonb) returns text
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := private.assert_investigator();
  m text := p ->> 'mode';
  d jsonb := p -> 'design';
begin
  if m in ('CALIBRATION', 'TRAINING') and d is not null then
    raise exception '% cases carry no design row and no label', m;
  end if;
  insert into public.tlv5_cases (case_id, mode, record_category, packet, packet_sha256, created_by)
  values (p ->> 'case_id', m, case m when 'PILOT' then 'SYNTHETIC_PILOT' when 'CALIBRATION' then 'RUBRIC_CALIBRATION'
                                   when 'TRAINING' then 'TRAINING_EXAMPLE' else 'LABEL_VERIFICATION_FORMAL' end,
          p -> 'packet', repeat('0', 64), me);
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

-- -----------------------------------------------------------------------------
-- e. Row-level security: the adjudicator also reads TRAINING packets
-- -----------------------------------------------------------------------------
alter policy tlv5_cases_read on public.tlv5_cases
  using (private.is_investigator() or private.tlv5_is_assigned(case_id)
         or (private.is_adjudicator() and (mode in ('PILOT', 'TRAINING')
                                           or (mode = 'FORMAL' and private.tlv5_phase() = 'CLOSED' and private.tlv5_snapshot_taken()))));

-- -----------------------------------------------------------------------------
-- f. Views
-- -----------------------------------------------------------------------------
-- The reviewer's work queue: PILOT, CALIBRATION and FORMAL assignments; never a TRAINING example.
create or replace view public.v_tlv5_my_queue with (security_invoker = true) as
select a.assignment_id, a.case_id, a.mode, a.queue_position,
       (select count(*) from public.tlv5_submissions s where s.assignment_id = a.assignment_id) as n_submissions
from public.tlv5_assignments a
where a.reviewer_pseudo_id = private.my_reviewer_pseudo_id() and a.mode <> 'TRAINING';

-- The reviewer's training view: TRAINING assignments only.
create view public.v_tlv5_my_training_queue with (security_invoker = true) as
select a.assignment_id, a.case_id, a.queue_position,
       (select count(*) from public.tlv5_submissions s where s.assignment_id = a.assignment_id) as n_submissions
from public.tlv5_assignments a
where a.reviewer_pseudo_id = private.my_reviewer_pseudo_id() and a.mode = 'TRAINING';

-- Adjudicator queue: PILOT, TRAINING and (after the close and the snapshot) FORMAL items; never a label.
create or replace view public.v_tlv5_adjudication_queue with (security_invoker = true) as
with ci as (
  select c.case_id, c.mode, i.it as item_code
  from public.tlv5_cases c cross join lateral private.tlv5_reviewer_items() as i(it)
  where c.mode in ('PILOT', 'FORMAL', 'TRAINING') and private.tlv5_can_read_answers(c.mode)
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
-- g. Grants for the new objects (replaced objects keep their 0004 privileges)
-- -----------------------------------------------------------------------------
revoke all on public.v_tlv5_my_training_queue from anon, authenticated;
grant select on public.v_tlv5_my_training_queue to authenticated;
revoke all on function private.tlv5_packet_nct(jsonb) from public, anon, authenticated;

commit;
