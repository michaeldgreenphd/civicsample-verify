-- View-only practice oversight. This is a restriction on an existing investigator account,
-- not another study role. No existing role, approval, response or MFA setting is changed.
begin;
insert into public.app_schema_version(version, description)
values ('7.0.6-practice-observer', 'restricted investigator access to synthetic practice counts and training only');
alter table public.users add column practice_read_only boolean not null default false;
alter table public.users add constraint users_practice_read_only_ck
  check (not practice_read_only or role = 'INVESTIGATOR');

create or replace function private.is_investigator() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select u.role = 'INVESTIGATOR' and not u.practice_read_only
    and (coalesce((select s.setting_value from public.app_settings s
                   where s.setting_key = 'require_investigator_mfa'), 'true') = 'false'
         or coalesce(auth.jwt() ->> 'aal', '') = 'aal2')
    from public.users u where u.auth_uid = auth.uid() and u.is_active
      and not private.account_locked(u.user_id)), false)
$$;
-- Legacy role-based paths also receive the restricted effective role, even with an aal2 token.
create or replace function private.app_role() returns text
language sql stable security definer set search_path = '' as $$
  select case when u.practice_read_only then 'PRACTICE_OBSERVER' else u.role end
  from public.users u where u.auth_uid = auth.uid() and u.is_active
    and not private.account_locked(u.user_id)
$$;

create function public.rpc_practice_observer_workspace() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not exists(select 1 from public.users u where u.auth_uid = auth.uid()
    and u.is_active and u.role = 'INVESTIGATOR' and u.practice_read_only
    and not private.account_locked(u.user_id)) then
    raise exception 'Practice observer access required';
  end if;
  return jsonb_build_object(
    'pilotUnits', (select count(*) from public.mu7_units where mode='PILOT'),
    'locked', exists(select 1 from public.mu7_reference_locks where mode='PILOT'),
    'completion', coalesce((select jsonb_agg(to_jsonb(t) order by t.reviewer_slot) from (
      select q.reviewer_slot, count(*)::integer as assigned,
        count(*) filter(where exists(select 1 from public.mu7_judgments j
          where j.assignment_id=q.assignment_id))::integer as answered
      from public.mu7_queue q where q.mode='PILOT' group by q.reviewer_slot
    ) t), '[]'::jsonb),
    'training', coalesce((select jsonb_agg(jsonb_build_object(
      'training_unit_id', training_unit_id, 'packet', packet) order by training_unit_id)
      from public.mu7_training_units where nct_id ~ '^SYN-NCT-[0-9]{4}$'), '[]'::jsonb)
  );
end $$;
revoke all on function public.rpc_practice_observer_workspace() from public, anon, service_role;
grant execute on function public.rpc_practice_observer_workspace() to authenticated;

-- Only privileged administration can set the restriction; clients have no users write grant.
create function private.audit_practice_access() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.practice_read_only is distinct from old.practice_read_only then
    insert into public.audit_log(actor_user_id, actor_role, action, entity_table, entity_id, mode, details)
    values(private.app_user_id(), coalesce(private.app_role(), current_user),
      'PRACTICE_ACCESS_CHANGED', 'users', new.user_id::text, null,
      jsonb_build_object('before_read_only',old.practice_read_only,'after_read_only',new.practice_read_only));
  end if;
  return null;
end $$;
revoke all on function private.audit_practice_access() from public, anon, authenticated, service_role;
create trigger users_practice_access_audit after update on public.users
  for each row execute function private.audit_practice_access();
commit;
