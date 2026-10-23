-- =============================================================================
-- migrations/proposed/v7_cross_design_coexistence.sql
-- PROPOSED, NOT APPLIED. Not part of the hosted chain (scripts/supabase-identity-tools.mjs), the
-- local loader (src/server/db.ts) or any bootstrap plan. It awaits the investigator's review; on
-- approval it becomes the next numbered additive migration. Tested on a disposable copy of the
-- full chain by tests/mu7-coexistence-proposal.test.ts.
--
-- Finding 3 of the first v7 review (docs/test_runs/V7_MIGRATION_REVIEW.md, section 8): MU7-G02
-- keeps v4, v5 and v6 formal reviews out of a v7 database, but not the mapping-confirmation
-- module (0016) or the v2 formal unlock (schema.sql). Today 0018 refuses EVALUATION mappings, so
-- the reachable effect is limited; the guard below keeps one formal mapping review per database
-- even if a later migration lifts that refusal. It is conservative by construction:
--   * SYNTHETIC_PILOT and TRAINING_EXAMPLE mappings stay allowed in both orders, so the locked
--     synthetic mapping-confirmation pilot on staging (2026-10-23) neither blocks v7 nor changes.
--   * v2 PILOT behaviour is unchanged; only the v2 FORMAL unlock is refused next to v7.
--   * Option 3 of the proposal (no new mapping-confirmation campaign after v7) is NOT included:
--     it changes current synthetic behaviour and needs its own decision.
-- Each side takes one advisory lock so a design recording and a racing import or unlock
-- serialize; neither can commit without seeing the other.
-- =============================================================================
begin;

create function private.mu7c_coexistence_lock() returns void
language sql security definer set search_path = '' as $$
  select pg_advisory_xact_lock(7024027)
$$;

-- 1. No EVALUATION mapping next to a v7 design, and no v7 design next to an EVALUATION mapping
create function private.mu7c_mc_evaluation_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.record_category = 'EVALUATION' then
    perform private.mu7c_coexistence_lock();
    if exists (select 1 from public.mu7_design) then
      raise exception 'MU7C-G01: this database runs review design v7; an EVALUATION mapping-confirmation case is refused';
    end if;
  end if;
  return new;
end $$;
create trigger a10_mu7c_evaluation_guard before insert on public.mc_cases
  for each row execute function private.mu7c_mc_evaluation_guard();

-- 2. No v2 FORMAL unlock next to a v7 design, and no v7 design after a v2 FORMAL unlock
create function private.mu7c_v2_unlock_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.event_type = 'FORMAL_UNLOCKED' then
    perform private.mu7c_coexistence_lock();
    if exists (select 1 from public.mu7_design) then
      raise exception 'MU7C-G02: this database runs review design v7; the v2 formal review cannot be unlocked';
    end if;
  end if;
  return new;
end $$;
create trigger a10_mu7c_v2_unlock_guard before insert on public.review_phase_events
  for each row execute function private.mu7c_v2_unlock_guard();

create function private.mu7c_design_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform private.mu7c_coexistence_lock();
  if exists (select 1 from public.mc_cases c where c.record_category = 'EVALUATION') then
    raise exception 'MU7C-G03: an EVALUATION mapping-confirmation review exists in this database; it keeps its design';
  end if;
  if exists (select 1 from public.review_phase_events e where e.event_type = 'FORMAL_UNLOCKED') then
    raise exception 'MU7C-G03: the v2 formal review is unlocked in this database; it keeps its design';
  end if;
  return new;
end $$;
create trigger z30_mu7c_design_guard before insert on public.mu7_design
  for each row execute function private.mu7c_design_guard();

revoke all on function private.mu7c_coexistence_lock(), private.mu7c_mc_evaluation_guard(),
  private.mu7c_v2_unlock_guard(), private.mu7c_design_guard() from public, anon, authenticated, service_role;

commit;
