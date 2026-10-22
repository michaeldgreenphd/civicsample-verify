-- =============================================================================
-- migrations/0017_v5_rubric_binding.sql
-- Codex finding on PR #5: a rubric text change must not silently apply to a campaign whose
-- immutable responses were made under the previous text. Each v5 mode binds the rubric version
-- and SHA-256 of its first review activity; later submissions, adjudications and exports under a
-- different runtime rubric are refused instead of mixing instructions or misreporting provenance.
-- FORMAL additionally must match the hash recorded at the freeze. Additive: no object of
-- schema.sql or migrations 0002 to 0016 is altered or replaced.
-- =============================================================================
begin;

insert into public.app_schema_version (version, description)
values ('5.1.4-v5-rubric-binding', 'v5 rubric binding: one rubric version and hash per mode, fixed by the first review activity');

create table public.tlv5_rubric_bindings (
  mode            text primary key check (mode in ('PILOT', 'CALIBRATION', 'TRAINING', 'FORMAL')),
  rubric_version  text not null check (length(rubric_version) between 3 and 80),
  rubric_sha256   text not null check (rubric_sha256 ~ '^[0-9a-f]{64}$'),
  bound_at        timestamptz not null default now(),
  bound_by        uuid not null references public.users (user_id)
);
create trigger tlv5_rubric_bindings_append_only before update or delete on public.tlv5_rubric_bindings
  for each row execute function private.reject_mutation();
create trigger tlv5_rubric_bindings_no_truncate before truncate on public.tlv5_rubric_bindings
  for each statement execute function private.reject_mutation();
create trigger tlv5_rubric_bindings_audit after insert on public.tlv5_rubric_bindings
  for each row execute function private.audit_row_tlv5();
alter table public.tlv5_rubric_bindings enable row level security;
create policy tlv5_rubric_bindings_read on public.tlv5_rubric_bindings for select to authenticated
  using (private.app_role() is not null);
revoke all on public.tlv5_rubric_bindings from anon, authenticated;
grant select on public.tlv5_rubric_bindings to authenticated;

-- Bind the runtime rubric to a mode, or verify it against the existing binding. Called by the
-- application inside the same transaction as the review activity (submission, adjudication,
-- export registration), so a mismatch rolls that activity back.
create function public.rpc_tlv5_bind_rubric(p_mode text, p_rubric_version text, p_rubric_sha256 text) returns text
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := private.app_user_id();
  existing record;
  frozen_hash text;
  sha text := lower(p_rubric_sha256);
begin
  if me is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  if sha !~ '^[0-9a-f]{64}$' then
    raise exception 'rubric hash is not a SHA-256';
  end if;
  if p_mode = 'FORMAL' then
    select f.frozen_items ->> 'rubric' into frozen_hash from public.tlv5_freeze f;
    if frozen_hash is not null and frozen_hash <> sha then
      raise exception 'the runtime rubric does not match the frozen rubric; review activity is blocked';
    end if;
  end if;
  select * into existing from public.tlv5_rubric_bindings b where b.mode = p_mode;
  if existing.mode is null then
    insert into public.tlv5_rubric_bindings (mode, rubric_version, rubric_sha256, bound_by)
    values (p_mode, p_rubric_version, sha, me);
    return 'BOUND';
  end if;
  if existing.rubric_sha256 <> sha or existing.rubric_version <> p_rubric_version then
    raise exception 'the runtime rubric (%) differs from the rubric bound to % review (%); review activity is blocked',
      p_rubric_version, p_mode, existing.rubric_version;
  end if;
  return 'VERIFIED';
end $$;
revoke all on function public.rpc_tlv5_bind_rubric(text, text, text) from public, anon;
grant execute on function public.rpc_tlv5_bind_rubric(text, text, text) to authenticated;

commit;
