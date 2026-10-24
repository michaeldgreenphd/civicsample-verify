-- Explicit fictional identifiers for disposable v8 FORMAL-workflow tests.
-- No real-design path, pilot path or registry packet rule is relaxed.
begin;
insert into public.app_schema_version(version, description)
values ('8.0.1-v8-synthetic-identifiers', 'Allow non-registry synthetic trial identifiers only in synthetic v8 designs');

create or replace function private.assert_mu7_trial_block(t jsonb, p_mode text, p_training boolean) returns text
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
  if p_mode = 'FORMAL' and not p_training and nct ~ '^SYN-TRIAL-[0-9]{4}$' then
    if t ? 'registry_url' then
      raise exception 'MU8-G04: synthetic trial identifiers must not carry a registry link';
    end if;
    -- Design scope is enforced by the unit insertion trigger below, and again by
    -- the design-row constraint plus the existing packet/design equality guard.
  elsif p_mode = 'FORMAL' or (p_training and nct ~ '^NCT[0-9]{8}$') then
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

create function private.mu8_synthetic_trial_scope() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.packet -> 'trial' ->> 'nct_id' like 'SYN-TRIAL-%' and
     (new.mode <> 'FORMAL' or not exists (
       select 1 from public.mu7_design where design_version like 'SYN-8-%')) then
    raise exception 'MU8-G04: synthetic FORMAL identifiers require a synthetic v8 design';
  end if;
  return new;
end $$;
create trigger a01_mu8_synthetic_trial_scope before insert on public.mu7_units
for each row execute function private.mu8_synthetic_trial_scope();
revoke all on function private.mu8_synthetic_trial_scope() from public, anon, authenticated, service_role;

alter table public.mu7_unit_design drop constraint mu7_unit_design_nct_ck;
alter table public.mu7_unit_design add constraint mu7_unit_design_nct_ck check (
  (mode = 'FORMAL' and (nct_id ~ '^NCT[0-9]{8}$'
    or (nct_id ~ '^SYN-TRIAL-[0-9]{4}$' and design_version like 'SYN-8-%')))
  or (mode = 'PILOT' and nct_id ~ '^SYN-NCT-[0-9]{4}$')
);
commit;
