-- =============================================================================
-- supabase_test_shim/auth_shim.sql
-- Minimal stand-in for the Supabase `auth` schema and roles so that schema.sql
-- can be applied and tested on plain PostgreSQL (local runs and CI).
-- NEVER apply this file to a Supabase project: Supabase provides the real ones.
--
-- Tests impersonate a user with:
--   set role authenticated;
--   select set_config('request.jwt.claims', '{"sub":"<auth uuid>","email":"a@b.org","aal":"aal2"}', false);
-- =============================================================================
create schema if not exists auth;

create table if not exists auth.users (
  id     uuid primary key,
  email  text not null
);

create or replace function auth.jwt() returns jsonb
language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb)
$$;

create or replace function auth.uid() returns uuid
language sql stable as $$
  select nullif(auth.jwt() ->> 'sub', '')::uuid
$$;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
end $$;

grant usage on schema auth to anon, authenticated, service_role;
grant usage on schema public to anon, authenticated, service_role;
grant execute on function auth.uid(), auth.jwt() to anon, authenticated, service_role;
