-- =============================================================================
-- migrations/0015_v5_review_fixes.sql
-- Additive fixes from the independent review of PR #4 (Codex, reviewed commit 2806fcf1):
--   1. The adjudication basis must agree with the reviewer answers it names. REVIEWER_1 /
--      REVIEWER_2 adopt that reviewer's latest answer and detail code; BOTH_REVIEWERS requires two
--      identical answers; NEITHER requires a decision that matches no reviewer. A locked
--      adjudication can therefore never misstate which reviewer was adopted.
--   2. Reviewer sessions may evaluate private.tlv5_frozen() and private.tlv5_scope(), so the
--      application can show a calibration assignment read-only once the freeze closes calibration
--      and can hide adjudication choices that the DISAGREEMENTS_ONLY scope refuses. Both helpers
--      return campaign state only (a boolean and a scope code), never a label or an answer.
-- No object of schema.sql or migrations 0002 to 0014 is altered or replaced.
-- =============================================================================
begin;

insert into public.app_schema_version (version, description)
values ('5.1.3-v5-review-fixes', 'v5 review fixes: adjudication basis consistency; reviewer-readable freeze and scope state');

create function private.tlv5_adjudication_basis_check() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  a1 text; d1 text; a2 text; d2 text;
begin
  if new.status = 'UNRESOLVED_ESCALATED' then
    return new; -- basis NONE is enforced by the table check
  end if;
  select max(x.answer) filter (where x.reviewer_slot = 1), max(x.detail_code) filter (where x.reviewer_slot = 1),
         max(x.answer) filter (where x.reviewer_slot = 2), max(x.detail_code) filter (where x.reviewer_slot = 2)
    into a1, d1, a2, d2
  from private.tlv5_item_answers(new.case_id, new.item_code) x;
  if new.basis = 'REVIEWER_1' and (a1 is null or (a1, d1) is distinct from (new.decision, new.detail_code)) then
    raise exception 'basis REVIEWER_1 does not match the reviewer answers for item %/%', new.case_id, new.item_code;
  elsif new.basis = 'REVIEWER_2' and (a2 is null or (a2, d2) is distinct from (new.decision, new.detail_code)) then
    raise exception 'basis REVIEWER_2 does not match the reviewer answers for item %/%', new.case_id, new.item_code;
  elsif new.basis = 'BOTH_REVIEWERS' and (a1 is null or a2 is null or (a1, d1) is distinct from (new.decision, new.detail_code)
                                           or (a2, d2) is distinct from (new.decision, new.detail_code)) then
    raise exception 'basis BOTH_REVIEWERS does not match the reviewer answers for item %/%', new.case_id, new.item_code;
  elsif new.basis = 'NEITHER' and ((a1, d1) is not distinct from (new.decision, new.detail_code)
                                   or (a2, d2) is not distinct from (new.decision, new.detail_code)) then
    raise exception 'basis NEITHER does not match the reviewer answers for item %/%', new.case_id, new.item_code;
  elsif new.basis = 'NONE' then
    raise exception 'basis NONE applies only to an escalated item';
  end if;
  return new;
end $$;
revoke all on function private.tlv5_adjudication_basis_check() from public, anon, authenticated;

-- Fires after the existing role, phase and concordance checks (trigger names run in alphabetical order).
create trigger tlv5_adjudications_zz_basis_check before insert on public.tlv5_adjudications
  for each row execute function private.tlv5_adjudication_basis_check();

grant execute on function private.tlv5_frozen(), private.tlv5_scope() to authenticated;

commit;
