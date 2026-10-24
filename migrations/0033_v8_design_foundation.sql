-- Design v8 foundation. No sample, policy, gate or rubric is approved.
-- Transition model: one design per database; keep v7 databases and records intact.
-- The three added area labels are proposed vocabulary, usable only in a v8 database.
-- New requirements are installed atomically when a v8 design is recorded. They do not
-- invalidate a v7 practice database's requirements or prior approvals.
begin;

-- A previously recorded v8 design predates these guards: refuse rather than silently
-- treating its records or approvals as reconciled. Use a fresh disposable v8 database.
do $$ begin
  if exists (select 1 from public.mu7_design where design_version like 'review-design-v8%'
             or design_version like 'SYN-8-%') then
    raise exception 'MU8-G01: an existing v8 design requires explicit reconciliation; use a fresh v8 database';
  end if;
end $$;

insert into public.app_schema_version(version, description)
values ('8.0.0-v8-design-foundation', 'Ten-area vocabulary and design-scoped pending v8 gates; no approval or import');

create or replace function private.mu7_category_ok(p_family text, p_category text) returns boolean
language sql immutable set search_path = '' as $$
  select case p_family
    when 'AREA' then p_category in ('ONCOLOGY', 'CARDIOVASCULAR', 'MENTAL_HEALTH', 'INFECTIOUS', 'METABOLIC',
                                   'NEUROLOGICAL', 'RESPIRATORY', 'PATHOLOGICAL', 'IMMUNE', 'UROGENITAL')
    when 'ROW' then p_category in ('CAN_ALL', 'DIAB', 'DEP', 'OBE', 'AST', 'COPD', 'COV', 'SCZ', 'HTN', 'PAIN')
    when 'SG' then p_category in ('RULE_D_KEPT', 'RULE_D_REMOVED', 'RULE_K_KEPT', 'RULE_K_REMOVED')
    else false end
$$;

create or replace function private.mu7_area_label(p_category text) returns text
language sql immutable set search_path = '' as $$
  select case p_category
    when 'ONCOLOGY' then 'Therapeutic area: Oncology (parent MeSH category C04 Neoplasms)'
    when 'CARDIOVASCULAR' then 'Therapeutic area: Cardiovascular (parent MeSH category C14 Cardiovascular Diseases)'
    when 'MENTAL_HEALTH' then 'Therapeutic area: Mental health (MeSH F03 Mental Disorders, and the heading Depression (D003863) by the study rule)'
    when 'INFECTIOUS' then 'Therapeutic area: Infectious (parent MeSH category C01 Infections)'
    when 'METABOLIC' then 'Therapeutic area: Metabolic (parent MeSH category C18 Nutritional and Metabolic Diseases)'
    when 'NEUROLOGICAL' then 'Therapeutic area: Neurological (parent MeSH category C10 Nervous System Diseases)'
    when 'RESPIRATORY' then 'Therapeutic area: Respiratory (parent MeSH category C08 Respiratory Tract Diseases)'
    when 'PATHOLOGICAL' then 'Therapeutic area: Pathological conditions, signs and symptoms (parent MeSH category C23 Pathological Conditions, Signs and Symptoms)'
    when 'IMMUNE' then 'Therapeutic area: Immune (parent MeSH category C20 Immune System Diseases)'
    when 'UROGENITAL' then 'Therapeutic area: Urogenital (parent MeSH category C12 Urogenital Diseases)'
  end
$$;

create function private.mu8_record_pending_requirements() returns trigger
language plpgsql security definer set search_path = '' as $$
declare r record;
begin
  if new.design_version not like 'review-design-v8%' and new.design_version not like 'SYN-8-%' then
    return new;
  end if;
  if new.design_version <> 'review-design-v8.0.0' and new.design_version not like 'SYN-8-%' then
    raise exception 'MU8-G02: unsupported v8 design version';
  end if;
  if new.design_version = 'review-design-v8.0.0'
     and (new.n_primary_planned <> 96 or new.n_subgroup_planned <> 4) then
    raise exception 'MU8-G02: design v8 plans 96 primary and 4 subgroup mappings';
  end if;
  -- Append versions, never mutate previous requirements. Earlier approvals cannot carry
  -- forward to new units, frame checks, rubric policies or statistical specifications.
  for r in select * from (values
    ('G-ALLOC-01', array['FREEZE'], 'Choose and record the allocation rule across ten areas.'),
    ('G-AREA-01', array['FREEZE'], 'Approve reviewer definitions and neoplasm-policy scope for the three added areas.'),
    ('G-TEXT-02', array['FREEZE'], 'Resolve the kept Rule K display wording; current wording remains unchanged until approved.'),
    ('G-RUBRIC-01', array['FREEZE'], 'Approve and bind the complete v8 rubric and its amendments.'),
    ('G-PROV-04', array[]::text[], 'Manuscript-named trial exposure: information-only default; no gate approval implied.'),
    ('G-PAIN-01', array['FORMAL_OPEN'], 'Confirm the Pain row-membership policy for the selected v8 Pain units; benchmark validation is outside scope.'),
    ('G-MH-V53', array['FREEZE', 'FORMAL_OPEN'], 'Approve evidence that the v8 Mental health frame matches the current analysis flags.'),
    ('G-OVERLAP-01', array['FREEZE', 'FORMAL_OPEN'], 'Select one v8 overlap alternative and its probability and variance specification.'),
    ('G-PROV-01', array['FREEZE', 'FORMAL_OPEN'], 'Confirm trial-level provenance exclusions for the selected v8 frame and draw.'),
    ('G-TEXT-01', array['FREEZE', 'FORMAL_OPEN'], 'Approve removed subgroup display texts and reason codes for v8.'),
    ('G-OQ-03', array['FREEZE', 'FORMAL_OPEN'], 'Specify and approve the v8 Depression clinical-review policy.'),
    ('G-OQ-04', array['FREEZE', 'FORMAL_OPEN'], 'Specify and approve the v8 smoking-cessation clinical-review policy.'),
    ('G-EST-01', array['FREEZE', 'FORMAL_OPEN'], 'Approve the v8 estimator, indeterminate outcomes, clustering and probability provenance.')
  ) as x(gate_id, blocks, question) loop
    insert into public.mu7_gate_requirements(gate_id, requirement_version, blocks, requirement_status, question, source)
    select r.gate_id, coalesce(max(g.requirement_version), 0) + 1, r.blocks,
           'PENDING_SPECIFICATION', r.question, 'review design v8 pending decisions; scope: ' || new.design_version
    from public.mu7_gate_requirements g where g.gate_id = r.gate_id;
  end loop;
  return new;
end $$;
create trigger z30_mu8_record_pending_requirements after insert on public.mu7_design
for each row execute function private.mu8_record_pending_requirements();

create function private.mu8_new_area_scope() returns trigger
language plpgsql security definer set search_path = '' as $$
declare dv text;
begin
  if new.packet -> 'unit' ->> 'family' = 'AREA'
     and new.packet -> 'unit' ->> 'category' in ('PATHOLOGICAL', 'IMMUNE', 'UROGENITAL') then
    select design_version into dv from public.mu7_design;
    if dv is null or (dv <> 'review-design-v8.0.0' and dv not like 'SYN-8-%') then
      raise exception 'MU8-G03: added areas require a separate v8 design database';
    end if;
  end if;
  return new;
end $$;
create trigger z30_mu8_new_area_scope before insert on public.mu7_units
for each row execute function private.mu8_new_area_scope();

create trigger z30_mu8_training_area_scope before insert on public.mu7_training_units
for each row execute function private.mu8_new_area_scope();

revoke all on function private.mu8_record_pending_requirements(), private.mu8_new_area_scope()
from public, anon, authenticated, service_role;
commit;
