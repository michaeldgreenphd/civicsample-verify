-- Preserve the immutable pilot unit inventory when registering the completion bundle.
-- Existing migrations, exports and reference locks remain unchanged.
begin;
insert into public.app_schema_version(version, description) values
 ('8.4.1-pilot-export-inventory', 'Validate locked pilot unit counts for bundle 8.4');

create or replace function private.mu7x_pilot_export_inventory() returns trigger
language plpgsql security definer set search_path = '' as $$
declare n_locked integer;
begin
 if new.mode <> 'PILOT' or new.bundle_format_version not in ('7.0','8.1','8.2','8.3','8.4') then return new; end if;
 select l.n_units_locked into n_locked from public.mu7_reference_locks l where l.mode = 'PILOT';
 if n_locked is null or (new.row_counts ->> 'units') is distinct from n_locked::text then
   raise exception 'MU7X-G03: a PILOT export states the % locked pilot units in row_counts.units', coalesce(n_locked, 0);
 end if;
 return new;
end $$;
commit;
