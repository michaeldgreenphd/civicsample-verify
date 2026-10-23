-- =============================================================================
-- migrations/0021_account_locks.sql
-- Codex re-review of PR #7 (reviewed commit 9b714cb): a temporary account lock must be reversible.
-- The preserved users_update_check trigger (schema.sql) forbids reactivating a deactivated user,
-- so deactivation is permanent by design. This migration adds a separate, reversible lock:
-- public.account_locks. While a user has an unreleased lock, every identity helper resolves to
-- no user (app_user_id, app_role, is_investigator, my_reviewer_pseudo_id, rpc_whoami), so an
-- already-issued access token is refused by every RLS policy and RPC immediately; releasing the
-- lock restores access. Locks are written only by privileged tooling (service role); no
-- application role may insert, update or delete them. Deactivation stays permanent.
-- Additive: schema.sql and migrations 0002 to 0020 are unchanged; the four helpers and rpc_whoami
-- are replaced with the same signatures.
-- =============================================================================
begin;

insert into public.app_schema_version (version, description)
values ('6.0.3-account-locks', 'reversible account locks honoured by every identity helper; deactivation remains permanent');

create table public.account_locks (
  lock_id      uuid primary key default gen_random_uuid(),
  user_id      uuid not null references public.users (user_id),
  locked_at    timestamptz not null default now(),
  locked_by    text not null check (length(locked_by) between 3 and 120),
  reason       text check (reason is null or length(reason) <= 2000),
  released_at  timestamptz,
  released_by  text check ((released_at is null) = (released_by is null))
);
create unique index account_locks_one_active on public.account_locks (user_id) where released_at is null;
create index account_locks_user_idx on public.account_locks (user_id);

create function private.account_locked(p_user_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.account_locks l where l.user_id = p_user_id and l.released_at is null)
$$;
revoke all on function private.account_locked(uuid) from public, anon;
grant execute on function private.account_locked(uuid) to authenticated;

create or replace function private.app_user_id() returns uuid
language sql stable security definer set search_path = '' as $$
  select u.user_id from public.users u
  where u.auth_uid = auth.uid() and u.is_active and not private.account_locked(u.user_id)
$$;
create or replace function private.app_role() returns text
language sql stable security definer set search_path = '' as $$
  select u.role from public.users u
  where u.auth_uid = auth.uid() and u.is_active and not private.account_locked(u.user_id)
$$;
create or replace function private.is_investigator() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((
    select u.role = 'INVESTIGATOR'
       and (coalesce((select s.setting_value from public.app_settings s
                      where s.setting_key = 'require_investigator_mfa'), 'true') = 'false'
            or coalesce(auth.jwt() ->> 'aal', '') = 'aal2')
    from public.users u where u.auth_uid = auth.uid() and u.is_active and not private.account_locked(u.user_id)), false)
$$;
create or replace function private.my_reviewer_pseudo_id() returns text
language sql stable security definer set search_path = '' as $$
  select r.reviewer_pseudo_id
  from public.reviewers r join public.users u on u.user_id = r.user_id
  where u.auth_uid = auth.uid() and u.is_active and r.withdrawn_at is null and not private.account_locked(u.user_id)
$$;
create or replace function public.rpc_whoami()
returns table (user_id uuid, role text, is_pilot_test_account boolean, reviewer_pseudo_id text,
               mode_scope text, formal_phase_status text, investigator_session_ok boolean)
language sql stable security definer set search_path = '' as $$
  select u.user_id, u.role, u.is_pilot_test_account, r.reviewer_pseudo_id, r.mode_scope,
         private.formal_phase_status(), private.is_investigator()
  from public.users u left join public.reviewers r on r.user_id = u.user_id and r.withdrawn_at is null
  where u.auth_uid = auth.uid() and u.is_active and not private.account_locked(u.user_id)
$$;

-- Audit every lock and release; keep the row history (releases update released_at only).
create function private.account_locks_before_update() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.lock_id <> old.lock_id or new.user_id <> old.user_id or new.locked_at <> old.locked_at
     or new.locked_by <> old.locked_by or old.released_at is not null then
    raise exception 'account_locks: only an unreleased lock may be released, once';
  end if;
  return new;
end $$;
create trigger account_locks_before_update before update on public.account_locks
  for each row execute function private.account_locks_before_update();
create trigger account_locks_no_delete before delete on public.account_locks
  for each row execute function private.reject_mutation();
create trigger account_locks_no_truncate before truncate on public.account_locks
  for each statement execute function private.reject_mutation();
create function private.audit_account_lock() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.audit_log (actor_user_id, actor_role, action, entity_table, entity_id, mode, details)
  values (private.app_user_id(), coalesce(private.app_role(), current_user),
          case when tg_op = 'INSERT' then 'ACCOUNT_LOCKED' else 'ACCOUNT_LOCK_RELEASED' end,
          'account_locks', new.lock_id::text, null,
          jsonb_build_object('user_id', new.user_id, 'locked_by', new.locked_by, 'released_by', new.released_by));
  return null;
end $$;
create trigger account_locks_audit after insert or update on public.account_locks
  for each row execute function private.audit_account_lock();

alter table public.account_locks enable row level security;
create policy account_locks_investigator_read on public.account_locks for select to authenticated
  using (private.is_investigator());
revoke all on public.account_locks from anon, authenticated;
grant select on public.account_locks to authenticated;

commit;
