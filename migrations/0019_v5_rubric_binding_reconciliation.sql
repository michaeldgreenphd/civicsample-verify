-- =============================================================================
-- migrations/0019_v5_rubric_binding_reconciliation.sql
-- Codex re-review of PR #5 (reviewed commit 438f32e), two findings on migration 0017:
--   1. A campaign with review activity recorded before 0017 had no binding, so its old judgments
--      could acquire the current rubric's metadata. This migration marks every mode with prior
--      submissions, adjudications or exports as UNRECONCILED (a sentinel binding whose hash can
--      match no rubric). Activity and exports in that mode stay blocked until an investigator
--      records an explicit reconciliation (rpc_tlv5_reconcile_rubric) naming the rubric those
--      judgments were made under, with an attestation; the reconciliation is append-only and
--      audited, and the effective binding is read from it.
--   2. Any authenticated user could create a binding for any mode. Creation now needs an
--      investigator session, or a reviewer holding an assignment in that mode; every other caller
--      may only verify an existing binding.
-- Additive: no object of schema.sql or migrations 0002 to 0018 is altered or replaced; 0017's
-- RPC is replaced with the same signature.
-- =============================================================================
begin;

insert into public.app_schema_version (version, description)
values ('5.1.5-v5-rubric-reconciliation', 'v5 rubric binding: unreconciled sentinel for pre-0017 activity, investigator reconciliation, creation authority');

create function private.tlv5_unreconciled_sha(p_mode text) returns text
language sql immutable set search_path = '' as $$
  -- A deterministic 64-hex value that is not the hash of any rubric text: hex of 'UNRECONCILED:<mode>'
  -- padded, never produced by sha256 of a rendered rubric in practice and recognisable by the version.
  select private.sha256_hex('UNRECONCILED-PRE-0017:' || p_mode)
$$;
revoke all on function private.tlv5_unreconciled_sha(text) from public, anon, authenticated;

create table public.tlv5_rubric_reconciliations (
  reconciliation_id  uuid primary key default gen_random_uuid(),
  mode               text not null check (mode in ('PILOT', 'CALIBRATION', 'TRAINING', 'FORMAL')),
  from_version       text not null,
  rubric_version     text not null check (length(rubric_version) between 3 and 80),
  rubric_sha256      text not null check (rubric_sha256 ~ '^[0-9a-f]{64}$'),
  attestation        text not null check (length(trim(attestation)) >= 20),
  reconciled_by      uuid not null references public.users (user_id),
  reconciled_at      timestamptz not null default now(),
  unique (mode)
);
create trigger tlv5_rubric_reconciliations_append_only before update or delete on public.tlv5_rubric_reconciliations
  for each row execute function private.reject_mutation();
create trigger tlv5_rubric_reconciliations_no_truncate before truncate on public.tlv5_rubric_reconciliations
  for each statement execute function private.reject_mutation();
create trigger tlv5_rubric_reconciliations_audit after insert on public.tlv5_rubric_reconciliations
  for each row execute function private.audit_row_tlv5();
alter table public.tlv5_rubric_reconciliations enable row level security;
create policy tlv5_rubric_reconciliations_read on public.tlv5_rubric_reconciliations for select to authenticated
  using (private.app_role() is not null);
revoke all on public.tlv5_rubric_reconciliations from anon, authenticated;
grant select on public.tlv5_rubric_reconciliations to authenticated;

-- The effective binding of a mode: the reconciliation when one exists, else the binding row.
create function private.tlv5_effective_rubric(p_mode text, out rubric_version text, out rubric_sha256 text, out unreconciled boolean)
language sql stable security definer set search_path = '' as $$
  select coalesce(r.rubric_version, b.rubric_version), coalesce(r.rubric_sha256, b.rubric_sha256),
         r.mode is null and b.rubric_version = 'UNRECONCILED-PRE-0017'
  from (select p_mode as m) x
  left join public.tlv5_rubric_bindings b on b.mode = x.m
  left join public.tlv5_rubric_reconciliations r on r.mode = x.m
$$;
revoke all on function private.tlv5_effective_rubric(text) from public, anon;
grant execute on function private.tlv5_effective_rubric(text) to authenticated;

-- Upgrade: modes with review activity before this migration and no binding are UNRECONCILED.
insert into public.tlv5_rubric_bindings (mode, rubric_version, rubric_sha256, bound_by)
select m.mode, 'UNRECONCILED-PRE-0017', private.tlv5_unreconciled_sha(m.mode),
       coalesce((select u.user_id from public.users u where u.role = 'INVESTIGATOR' order by u.created_at limit 1),
                (select u.user_id from public.users u order by u.created_at limit 1))
from (select distinct mode from public.tlv5_submissions
      union select distinct mode from public.tlv5_adjudications
      union select distinct mode from public.tlv5_exports) m
where not exists (select 1 from public.tlv5_rubric_bindings b where b.mode = m.mode)
  and exists (select 1 from public.users);

create or replace function public.rpc_tlv5_bind_rubric(p_mode text, p_rubric_version text, p_rubric_sha256 text) returns text
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := private.app_user_id();
  eff record;
  frozen_hash text;
  sha text := lower(p_rubric_sha256);
begin
  if me is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  if sha !~ '^[0-9a-f]{64}$' then
    raise exception 'rubric hash is not a SHA-256';
  end if;
  if p_rubric_version = 'UNRECONCILED-PRE-0017' then
    raise exception 'the unreconciled sentinel cannot be bound by a caller';
  end if;
  if p_mode = 'FORMAL' then
    select f.frozen_items ->> 'rubric' into frozen_hash from public.tlv5_freeze f;
    if frozen_hash is not null and frozen_hash <> sha then
      raise exception 'the runtime rubric does not match the frozen rubric; review activity is blocked';
    end if;
  end if;
  select * into eff from private.tlv5_effective_rubric(p_mode);
  if eff.rubric_version is null then
    -- Creation: an investigator, or a reviewer who holds an assignment in this mode.
    if not (private.is_investigator()
            or exists (select 1 from public.tlv5_assignments a join public.reviewers r on r.reviewer_pseudo_id = a.reviewer_pseudo_id
                       where a.mode = p_mode and r.user_id = me and r.withdrawn_at is null)) then
      raise exception 'only an investigator or a reviewer assigned in % review may bind its rubric', p_mode using errcode = '42501';
    end if;
    insert into public.tlv5_rubric_bindings (mode, rubric_version, rubric_sha256, bound_by)
    values (p_mode, p_rubric_version, sha, me);
    return 'BOUND';
  end if;
  if eff.unreconciled then
    raise exception 'the % rubric is unreconciled: judgments exist from before rubric binding; an investigator must record the rubric they were made under (rpc_tlv5_reconcile_rubric); review activity is blocked', p_mode;
  end if;
  if eff.rubric_sha256 <> sha or eff.rubric_version <> p_rubric_version then
    raise exception 'the runtime rubric (%) differs from the rubric bound to % review (%); review activity is blocked',
      p_rubric_version, p_mode, eff.rubric_version;
  end if;
  return 'VERIFIED';
end $$;

-- Investigator reconciliation of an UNRECONCILED mode: names the rubric the existing judgments
-- were made under. Allowed once per mode, only for the sentinel, with an attestation.
create function public.rpc_tlv5_reconcile_rubric(p_mode text, p_rubric_version text, p_rubric_sha256 text, p_attestation text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := private.assert_investigator();
  eff record;
  rid uuid;
  sha text := lower(p_rubric_sha256);
begin
  select * into eff from private.tlv5_effective_rubric(p_mode);
  if eff.rubric_version is null then
    raise exception 'mode % has no binding to reconcile; its first review activity binds the rubric', p_mode;
  end if;
  if not eff.unreconciled then
    raise exception 'mode % is already bound to % and cannot be rebound', p_mode, eff.rubric_version;
  end if;
  if p_rubric_version = 'UNRECONCILED-PRE-0017' or sha !~ '^[0-9a-f]{64}$' or sha = private.tlv5_unreconciled_sha(p_mode) then
    raise exception 'a reconciliation names a real rubric version and SHA-256';
  end if;
  insert into public.tlv5_rubric_reconciliations (mode, from_version, rubric_version, rubric_sha256, attestation, reconciled_by)
  values (p_mode, 'UNRECONCILED-PRE-0017', p_rubric_version, sha, p_attestation, me) returning reconciliation_id into rid;
  return rid;
end $$;
revoke all on function public.rpc_tlv5_reconcile_rubric(text, text, text, text) from public, anon;
grant execute on function public.rpc_tlv5_reconcile_rubric(text, text, text, text) to authenticated;

commit;
