-- Read-only upgrade/startup preflight. Run inside the same READ COMMITTED
-- transaction as pending 0008/0009 migrations, before either changes functions.
-- Already-upgraded databases are checked too: never repair frozen study data here.
do $$ begin
  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'Frozen trial compatibility preflight requires READ COMMITTED isolation';
  end if;
end $$;

-- A separate LOCK statement ensures the following DO sees the committed state
-- after any concurrent freeze. Keep these locks through the migration commit.
lock table public.cases, public.case_records_v4, public.case_versions,
  public.case_design_v3, public.trial_context_packets, public.frozen_predictions_v4,
  public.freeze_manifests_v4 in share row exclusive mode;

do $$ begin
  if exists (select 1 from public.freeze_manifests_v4) then
    if exists (
      select 1 from public.case_records_v4 r
      join public.cases c on c.case_id = r.case_id and c.withdrawn_at is null
      left join public.case_design_v3 d on d.case_id = r.case_id
      where c.unit_type = 'TRIAL_AREA'
        and (d.two_step_required is distinct from true
             or not exists (select 1 from public.trial_context_packets p where p.case_id = r.case_id))
    ) or exists (
      with required as (
        select r.case_id, unnest(case
          when c.unit_type = 'TRIAL_AREA' or coalesce(d.two_step_required, false)
            then array['DESCRIPTOR_LEVEL_IN_TRIAL_CASE', 'TRIAL_LEVEL']
          else array['DESCRIPTOR_LEVEL'] end) as determination_level
        from public.case_records_v4 r
        join public.cases c on c.case_id = r.case_id and c.withdrawn_at is null
        left join public.case_design_v3 d on d.case_id = r.case_id
      )
      select 1 from required r
      full join public.frozen_predictions_v4 p
        on p.case_id = r.case_id and p.determination_level = r.determination_level
      where r.case_id is null or p.case_id is null
    ) then
      raise exception 'Frozen trial contract is incompatible with the current schema; explicit investigator migration review is required';
    end if;
  end if;
end $$;
