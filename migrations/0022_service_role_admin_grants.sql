-- =============================================================================
-- migrations/0022_service_role_admin_grants.sql
-- Codex live-staging finding on PR #7 (reviewed commit 3cb7d85): on a hardened Supabase project
-- with automatic table exposure disabled, service_role holds no table privileges in public, and
-- BYPASSRLS does not bypass grants. Auth user creation succeeded while linking the application
-- row through PostgREST returned 403, leaving Auth-only accounts; account_locks had the same gap.
-- This migration grants the privileged administration path the least it needs, explicitly, to
-- service_role only: read and write public.users (account linking by the admin tool; no delete),
-- read, insert and update public.account_locks (lock and release; no delete), read reviewers,
-- app_schema_version and audit_log for verification. Nothing is granted to anon or authenticated.
-- Additive: no earlier object is altered; grants only.
-- =============================================================================
begin;

insert into public.app_schema_version (version, description)
values ('6.0.4-service-role-admin-grants', 'explicit least-privilege service_role grants for account linking, locks and verification on hardened projects');

grant usage on schema public to service_role;
grant select, insert, update on public.users to service_role;
grant select, insert, update on public.account_locks to service_role;
grant select on public.reviewers, public.app_schema_version, public.audit_log to service_role;
-- Identity helpers are called by triggers on these tables under the admin session.
grant usage on schema private to service_role;
grant execute on function private.account_locked(uuid), private.app_user_id(), private.app_role(),
                          private.sha256_hex(text) to service_role;

commit;
