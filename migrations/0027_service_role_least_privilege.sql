-- =============================================================================
-- migrations/0027_service_role_least_privilege.sql
-- Codex review of PR #7 (reviewed commit 6661144) on migration 0023: on a project whose defaults
-- grant service_role broad table access, 0023 removes only TRUNCATE, REFERENCES and TRIGGER and
-- leaves DELETE, INSERT and UPDATE (and on PostgreSQL 17 MAINTAIN) on every table outside the
-- administration allowlist, so the service-role key could still change application records.
-- Reproduced in tests/service-role-dml.test.ts. A read-only inspection of staging (2026-10-23)
-- found no such DML grant there today, but its schema default for tables created by postgres
-- still grants service_role TRUNCATE, REFERENCES, TRIGGER and MAINTAIN on every new table.
-- This migration revokes every privilege from service_role on every table and view in public,
-- re-grants exactly the 0022 administration privileges, and removes service_role from the
-- schema default for tables, so later tables grant it nothing. anon and authenticated are not
-- changed. Additive: grants only; no earlier object is altered.
-- =============================================================================
begin;

insert into public.app_schema_version (version, description)
values ('6.0.6-service-role-least-privilege', 'service_role holds exactly the 0022 administration grants on public tables; default privileges follow');

do $$
declare
  t record;
begin
  for t in select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm', 'f')
  loop
    execute format('revoke all on public.%I from service_role', t.relname);
  end loop;
end $$;
-- Exactly the administration path of 0022: account linking, locks, verification reads.
grant select, insert, update on public.users to service_role;
grant select, insert, update on public.account_locks to service_role;
grant select on public.reviewers, public.app_schema_version, public.audit_log to service_role;
-- Tables created later by the migration owner grant service_role nothing.
alter default privileges in schema public revoke all on tables from service_role;

commit;
