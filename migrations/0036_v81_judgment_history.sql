-- Export-only history contract. No judgments, snapshots, scientific gates or stored hashes change.
begin;
insert into public.app_schema_version(version, description)
values ('8.1.1-judgment-history', 'Locked investigator history exports and independently verifiable snapshot; no study approval');
create view public.v_mu81_judgment_history with (security_invoker = true) as
select j.unit_id, j.mode, j.assignment_id, j.reviewer_slot, j.reviewer_pseudo_id,
       j.revision_number, j.answer, j.reason_code, j.note, j.uncertain, j.seconds_on_unit,
       j.diabetes_subtype, j.content_sha256,
       to_char(j.submitted_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as submitted_at_utc
from public.mu7_judgments j
where private.is_investigator() and private.mu7_can_read_judgments(j.mode)
  and exists(select 1 from public.mu7_reference_locks l where l.mode=j.mode);
revoke all on public.v_mu81_judgment_history from public, anon, authenticated, service_role;
grant select on public.v_mu81_judgment_history to authenticated;
alter table public.mu7_exports drop constraint mu7_exports_format_ck;
alter table public.mu7_exports add constraint mu7_exports_format_ck check(bundle_format_version in ('7.0','8.1','8.2'));
create or replace function private.mu81_export_version() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
 if new.bundle_format_version in ('7.0','8.1','8.2') and
    ((private.mu81_active() and new.bundle_format_version='7.0') or
     (not private.mu81_active() and new.bundle_format_version<>'7.0')) then
   raise exception 'MU81-G08: bundle format must match the recorded design';
 end if;
 return new;
end $$;
create or replace function private.mu7x_pilot_export_inventory() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  n_locked integer;
begin
  -- Inventory remains required for all supported export formats.
  if new.mode <> 'PILOT' or new.bundle_format_version not in ('7.0','8.1','8.2') then
    return new;
  end if;
  select l.n_units_locked into n_locked from public.mu7_reference_locks l where l.mode = 'PILOT';
  if n_locked is null or (new.row_counts ->> 'units') is distinct from n_locked::text then
    raise exception 'MU7X-G03: a PILOT export states the % locked pilot units in row_counts.units', coalesce(n_locked, 0);
  end if;
  return new;
end $$;

commit;
