begin;

-- Add an independent identity boundary without replacing any existing phase,
-- evidence, assignment, blinding, supersession or reference-lock guard.
-- Existing adjudications (including historical investigator PILOT entries) are
-- immutable historical records: this migration neither rewrites nor deletes them.
create function private.require_independent_adjudicator_v4() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if private.app_role() is distinct from 'ADJUDICATOR'
     or private.app_user_id() is distinct from new.decided_by
     or not exists (
       select 1 from public.users u
       where u.user_id = new.decided_by and u.role = 'ADJUDICATOR' and u.is_active
     ) then
    raise exception 'An active ADJUDICATOR must record their own adjudication; investigators cannot enter judgments'
      using errcode = '42501';
  end if;
  return new;
end $$;

-- Trigger names sort before the historical BEFORE INSERT guards. A rejected
-- investigator cannot reach their state changes, even by naming another decider.
create trigger aa_independent_adjudicator_boundary
  before insert on public.adjudications
  for each row execute function private.require_independent_adjudicator_v4();
create trigger aa_independent_adjudicator_boundary
  before insert on public.mb_adjudications_v4
  for each row execute function private.require_independent_adjudicator_v4();
revoke all on function private.require_independent_adjudicator_v4() from public, anon, authenticated;

insert into public.app_schema_version(version,description) values
 ('4.0.7-investigator-judgment-boundary','Independent adjudicator identity required for new Module A and Module B adjudications; historical rows preserved')
on conflict (version) do nothing;
commit;
