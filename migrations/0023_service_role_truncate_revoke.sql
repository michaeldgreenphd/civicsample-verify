-- =============================================================================
-- migrations/0023_service_role_truncate_revoke.sql
-- Hardening observed after the authorized 0022 apply on staging: the project's default
-- privileges give service_role TRUNCATE (and REFERENCES, TRIGGER) on every public table. The
-- administration path never truncates or alters tables; several tables already refuse truncation
-- by trigger, but public.users and others do not. This migration revokes TRUNCATE, REFERENCES and
-- TRIGGER from service_role on every table in public and sets the schema default so later tables
-- do not regain them, leaving the least-privilege grants of 0022 (select/insert/update on the
-- administration tables) in place. Nothing changes for anon or authenticated.
-- Additive: grants only; no earlier object is altered. Prepared for review; not applied remotely.
-- =============================================================================
begin;

insert into public.app_schema_version (version, description)
values ('6.0.5-service-role-truncate-revoke', 'revoke TRUNCATE, REFERENCES and TRIGGER from service_role on public tables; default privileges follow');

do $$
declare
  t record;
begin
  for t in select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public' and c.relkind in ('r', 'p')
  loop
    execute format('revoke truncate, references, trigger on public.%I from service_role', t.relname);
  end loop;
end $$;
-- Tables created later by the migration owner inherit the same restriction.
alter default privileges in schema public revoke truncate, references, trigger on tables from service_role;

commit;
