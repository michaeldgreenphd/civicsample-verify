-- Opt-in final-set submission. Applying this migration does not choose a protocol,
-- approve a scientific gate, freeze a sample or open review. Earlier modes retain
-- their routing and exports. Guide 4 and its binding are preserved as provenance.
begin;
insert into public.app_schema_version(version, description) values
 ('8.4.0-reviewer-completion', 'Opt-in complete reviewer receipts, all Cannot tell routing, guide 5 and bundle 8.4');

create table public.mu7_completion_protocol_v84 (
 mode text primary key check(mode in ('PILOT','FORMAL')),
 protocol_id text not null check(protocol_id='mu84-finish-and-adjudicate-1'),
 guide_sha256 text not null check(guide_sha256='03cc9a6617aae436bbbc73c6a8d2b792d3808ecebd6b661133e942df4408595e'),
 base_profile_sha256 text not null check(base_profile_sha256 ~ '^[0-9a-f]{64}$'),
 binding_sha256 text not null check(binding_sha256 ~ '^[0-9a-f]{64}$'),
 attestation text not null check(length(btrim(attestation)) between 20 and 4000),
 recorded_by uuid not null references public.users(user_id),
 recorded_at timestamptz not null default now()
);
create table public.mu7_review_completions_v84 (
 mode text not null references public.mu7_completion_protocol_v84(mode),
 reviewer_pseudo_id text not null references public.reviewers(reviewer_pseudo_id),
 reviewer_slot integer not null check(reviewer_slot in (1,2)),
 answer_count integer not null check(answer_count>0),
 answers_text text not null,
 answers_sha256 text not null check(answers_sha256 ~ '^[0-9a-f]{64}$'),
 protocol_binding_sha256 text not null check(protocol_binding_sha256 ~ '^[0-9a-f]{64}$'),
 receipt_sha256 text not null check(receipt_sha256 ~ '^[0-9a-f]{64}$'),
 finished_at timestamptz not null default clock_timestamp(),
 primary key(mode,reviewer_pseudo_id), unique(mode,reviewer_slot)
);
alter table public.mu7_completion_protocol_v84 enable row level security;
alter table public.mu7_review_completions_v84 enable row level security;
revoke all on public.mu7_completion_protocol_v84, public.mu7_review_completions_v84 from public, anon, authenticated, service_role;
grant select(mode,protocol_id,guide_sha256,base_profile_sha256,binding_sha256) on public.mu7_completion_protocol_v84 to authenticated;
grant select on public.mu7_review_completions_v84 to authenticated;
create policy mu84_protocol_read on public.mu7_completion_protocol_v84 for select to authenticated
 using(private.app_role() is not null);
create policy mu84_completions_read on public.mu7_review_completions_v84 for select to authenticated
 using(reviewer_pseudo_id=private.my_reviewer_pseudo_id() or private.mu7_can_read_judgments(mode));
do $$ declare t text; begin
 foreach t in array array['mu7_completion_protocol_v84','mu7_review_completions_v84'] loop
  execute format('create trigger immutable before update or delete on public.%I for each row execute function private.reject_mutation()',t);
  execute format('create trigger no_truncate before truncate on public.%I for each statement execute function private.reject_mutation()',t);
 end loop;
end $$;

create function private.mu84_active(p_mode text) returns boolean
language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.mu7_completion_protocol_v84 where mode=p_mode)
$$;
create function public.rpc_mu84_bind_protocol(p jsonb) returns text
language plpgsql security definer set search_path='' as $$
declare me uuid; base text; h text; m text:=p->>'mode';
begin
 perform private.mu7_assert_keys(p,array['mode','protocol_id','guide_sha256','attestation'],'completion protocol');
 perform pg_catalog.pg_advisory_xact_lock(7024025);
 if current_setting('transaction_isolation')<>'read committed' then raise exception 'MU84-G01: READ COMMITTED required'; end if;
 me:=private.assert_investigator();
 if m is null or m not in ('PILOT','FORMAL')
  or (p->>'protocol_id') is distinct from 'mu84-finish-and-adjudicate-1'
  or (p->>'guide_sha256') is distinct from '03cc9a6617aae436bbbc73c6a8d2b792d3808ecebd6b661133e942df4408595e'
  or coalesce(jsonb_typeof(p->'attestation'),'')<>'string'
  or length(btrim(p->>'attestation')) not between 20 and 4000 then
  raise exception 'MU84-G02: fixed protocol, guide checksum, mode and attestation required';
 end if;
 select binding_sha256 into base from public.mu7_reviewer_profile_v81 where profile_id='mu81-plain-language-r4';
 if not private.mu81_active() or base is null then raise exception 'MU84-G03: bind guide 4 before the completion protocol'; end if;
 if exists(select 1 from public.mu7_judgments where mode=m)
  or exists(select 1 from public.mu7_adjudications where mode=m)
  or exists(select 1 from public.mu7_reference_locks where mode=m)
  or (m='FORMAL' and (private.mu7_frozen() or private.mu7_phase()<>'SIGNED_OFF' and private.mu7_phase()<>'NOT_SIGNED_OFF')) then
  raise exception 'MU84-G04: choose this protocol before answers, freeze or review opening';
 end if;
 h:=private.sha256_hex(concat_ws('|','mu84-completion-binding-1',m,p->>'protocol_id',base,p->>'guide_sha256'));
 insert into public.mu7_completion_protocol_v84(mode,protocol_id,guide_sha256,base_profile_sha256,binding_sha256,attestation,recorded_by)
 values(m,p->>'protocol_id',p->>'guide_sha256',base,h,btrim(p->>'attestation'),me);
 insert into public.audit_log(actor_user_id,actor_role,action,entity_table,entity_id,mode,details)
 values(me,'INVESTIGATOR','INSERT','mu7_completion_protocol_v84',m,m,jsonb_build_object('binding_sha256',h));
 return h;
end $$;

-- The canonical receipt contains immutable row identifiers and hashes, not answer text.
-- The latest content hash already includes the required diabetes observation in v8.1.
create function private.mu84_answers(p_reviewer text,p_mode text)
 returns table(n_assigned integer,n_answered integer,slot integer,txt text)
language sql stable security definer set search_path='' as $$
 select count(*)::integer,count(j.judgment_id)::integer,min(q.reviewer_slot)::integer,
  coalesce(string_agg(concat_ws('|',q.unit_id,q.reviewer_slot,q.assignment_id,j.revision_number,j.content_sha256),
    E'\n' order by q.unit_id collate "C") filter(where j.judgment_id is not null),'')
 from public.mu7_queue q left join lateral (
  select judgment_id,revision_number,content_sha256 from public.mu7_judgments
   where assignment_id=q.assignment_id order by revision_number desc limit 1
 ) j on true where q.reviewer_pseudo_id=p_reviewer and q.mode=p_mode
$$;
create function public.rpc_mu84_my_completion(p_mode text) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare me text:=private.my_reviewer_pseudo_id(); a record; c record;
begin
 if me is null or not private.mu84_active(p_mode) then return null; end if;
 select * into a from private.mu84_answers(me,p_mode);
 if a.n_assigned=0 then return null; end if;
 select * into c from public.mu7_review_completions_v84 where mode=p_mode and reviewer_pseudo_id=me;
 return jsonb_build_object('mode',p_mode,'assigned',a.n_assigned,'answered',a.n_answered,
  'answers_sha256',private.sha256_hex(a.txt),'finished_at',c.finished_at,'receipt_sha256',c.receipt_sha256);
end $$;
create function public.rpc_mu84_finish_review(p_mode text,p_answers_sha256 text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare me text; a record; b text; h text; expected integer; existing record;
begin
 -- Exclusive with other finishes/close and shared answer writes. Re-read identity and
 -- answers AFTER waiting; an old browser tab cannot silently lock a newer answer set.
 perform pg_catalog.pg_advisory_xact_lock(7024025);
 if current_setting('transaction_isolation')<>'read committed' then raise exception 'MU84-G01: READ COMMITTED required'; end if;
 me:=private.my_reviewer_pseudo_id();
 if me is null then raise exception 'MU84-G05: a reviewer must finish their own review' using errcode='42501'; end if;
 select binding_sha256 into b from public.mu7_completion_protocol_v84 where mode=p_mode;
 if b is null then raise exception 'MU84-G06: no completion protocol is recorded for this mode'; end if;
 select * into a from private.mu84_answers(me,p_mode);
 h:=private.sha256_hex(a.txt);
 if p_answers_sha256 is distinct from h then raise exception 'MU84-G07: saved answers changed; reload and check before finishing'; end if;
 select * into existing from public.mu7_review_completions_v84 where mode=p_mode and reviewer_pseudo_id=me;
 if existing.receipt_sha256 is not null then return public.rpc_mu84_my_completion(p_mode); end if;
 if (p_mode='FORMAL' and private.mu7_phase()<>'OPEN') or private.mu7_locked(p_mode) then
  raise exception 'MU84-G08: review is not open for final submission';
 end if;
 select count(*) into expected from public.mu7_units where mode=p_mode;
 if a.n_assigned=0 or a.n_assigned<>expected or a.n_answered<>expected
  or (p_mode='FORMAL' and expected<>100) then
  raise exception 'MU84-G09: save every assigned answer before finishing the complete review';
 end if;
 insert into public.mu7_review_completions_v84(mode,reviewer_pseudo_id,reviewer_slot,answer_count,
  answers_text,answers_sha256,protocol_binding_sha256,receipt_sha256)
 values(p_mode,me,a.slot,a.n_answered,a.txt,h,b,
  private.sha256_hex(concat_ws('|','mu84-completion-receipt-1',p_mode,me,b,h)));
 -- No enumerable answer/receipt hash in the investigator's interim audit channel.
 insert into public.audit_log(actor_user_id,actor_role,action,entity_table,entity_id,mode,details)
 values(private.app_user_id(),'REVIEWER','INSERT','mu7_review_completions_v84',me,p_mode,
  jsonb_build_object('answer_count',a.n_answered,'content_hmac_sha256',private.mu7_audit_digest(h)));
 return public.rpc_mu84_my_completion(p_mode);
end $$;

create function private.mu84_finished_write_guard() returns trigger
language plpgsql security definer set search_path='' as $$
declare m text; r text;
begin
 if tg_table_name='mu7_judgments' then
  select mode,reviewer_pseudo_id into m,r from public.mu7_queue where assignment_id=new.assignment_id;
  if exists(select 1 from public.mu7_review_completions_v84 where mode=m and reviewer_pseudo_id=r) then
   raise exception 'MU84-G10: your finished review is locked; an explicitly authorized amendment is required';
  end if;
 else
  m:=new.mode;
  if exists(select 1 from public.mu7_review_completions_v84 where mode=m) then
   raise exception 'MU84-G11: review inventory is locked after a reviewer finishes';
  end if;
 end if;
 return new;
end $$;
create trigger a10_mu84_finished before insert on public.mu7_judgments for each row execute function private.mu84_finished_write_guard();
create trigger a10_mu84_finished before insert on public.mu7_queue for each row execute function private.mu84_finished_write_guard();
create trigger a10_mu84_finished before insert on public.mu7_units for each row execute function private.mu84_finished_write_guard();

create function private.mu84_both_finished(p_mode text) returns boolean
language sql stable security definer set search_path='' as $$
 select count(*)=2 from public.mu7_review_completions_v84 where mode=p_mode
$$;
create function private.mu84_unit_routing(p_unit text,p_a1 text,p_a2 text) returns text
language sql stable security definer set search_path='' as $$
 select case when private.mu84_active(u.mode) then
  case when not private.mu84_both_finished(u.mode) then 'INCOMPLETE'
       when p_a1='CANNOT_TELL' and p_a2='CANNOT_TELL' then 'ROUTED'
       else private.mu7_routing(p_a1,p_a2) end
  else private.mu7_routing(p_a1,p_a2) end from public.mu7_units u where u.unit_id=p_unit
$$;
create function private.mu84_close_guard() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if new.event_type='FORMAL_CLOSED_COMPLETE' and private.mu84_active('FORMAL') and not private.mu84_both_finished('FORMAL') then
  raise exception 'MU84-G12: both reviewers must finish before complete closure';
 end if;
 return new;
end $$;
create trigger z60_mu84_close before insert on public.mu7_phase_events for each row execute function private.mu84_close_guard();

alter table public.mu7_freeze add column completion_protocol_sha256 text check(completion_protocol_sha256 ~ '^[0-9a-f]{64}$');
create function private.mu84_freeze_protocol() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 select binding_sha256 into new.completion_protocol_sha256 from public.mu7_completion_protocol_v84 where mode='FORMAL';
 return new;
end $$;
create trigger z60_mu84_freeze before insert on public.mu7_freeze for each row execute function private.mu84_freeze_protocol();

-- Keep the existing view columns (and legacy exports) stable. The additional flag
-- has its own relation and is derived from the FINAL independent answers only.
create view public.v_mu84_both_cannot_tell with(security_invoker=true) as
 select unit_id,mode,(answer_effective_slot1='CANNOT_TELL' and answer_effective_slot2='CANNOT_TELL') as both_final_cannot_tell
 from public.v_mu7_final_reference where private.mu84_active(mode) and private.mu84_both_finished(mode);
revoke all on public.v_mu84_both_cannot_tell from public,anon,authenticated,service_role;
grant select on public.v_mu84_both_cannot_tell to authenticated;

revoke all on function private.mu84_active(text), private.mu84_answers(text,text),
 private.mu84_finished_write_guard(),private.mu84_both_finished(text),private.mu84_unit_routing(text,text,text),
 private.mu84_close_guard(),private.mu84_freeze_protocol() from public,anon,authenticated,service_role;
-- View-invoked helpers expose no answers; active/both_finished are not executable by
-- clients. A security-definer wrapper below protects the only view-facing flag.
create function private.mu84_can_read_completed(p_mode text) returns boolean
language sql stable security definer set search_path='' as $$
 select private.mu7_can_read_judgments(p_mode) and private.mu84_active(p_mode) and private.mu84_both_finished(p_mode)
$$;
revoke all on function private.mu84_can_read_completed(text) from public,anon,authenticated,service_role;
grant execute on function private.mu84_can_read_completed(text) to authenticated;
create or replace view public.v_mu84_both_cannot_tell with(security_invoker=true) as
 select unit_id,mode,(answer_effective_slot1='CANNOT_TELL' and answer_effective_slot2='CANNOT_TELL') as both_final_cannot_tell
 from public.v_mu7_final_reference where private.mu84_can_read_completed(mode);
revoke all on function public.rpc_mu84_bind_protocol(jsonb),public.rpc_mu84_my_completion(text),
 public.rpc_mu84_finish_review(text,text) from public,anon,authenticated,service_role;
grant execute on function public.rpc_mu84_bind_protocol(jsonb),public.rpc_mu84_my_completion(text),
 public.rpc_mu84_finish_review(text,text) to authenticated;

-- Additional replacements and export guard follow in this transaction.

create or replace function private.mu7_adjudications_before_insert() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  u record;
  a1 text; a2 text;
begin
  select * into u from public.mu7_units x where x.unit_id = new.unit_id;
  new.mode := u.mode;
  -- GUARD MU7-G37 BEGIN
  if (select r.role from public.users r where r.user_id = new.decided_by) is distinct from 'ADJUDICATOR' then
    raise exception 'MU7-G37: only the adjudicator records a v7 adjudication';
  end if;
  -- GUARD MU7-G37 END
  -- GUARD MU7-G38 BEGIN
  if u.mode = 'FORMAL' and not (private.mu7_closed() and private.mu7_snapshot_taken()) then
    raise exception 'MU7-G38: FORMAL adjudication starts after the close and the snapshot';
  end if;
  if private.mu7_locked(u.mode) then
    raise exception 'MU7-G38: the % reference is locked', u.mode;
  end if;
  -- GUARD MU7-G38 END
  a1 := private.mu7_effective_answer(new.unit_id, 1);
  a2 := private.mu7_effective_answer(new.unit_id, 2);
  -- GUARD MU7-G39 BEGIN
  if private.mu84_unit_routing(new.unit_id, a1, a2) <> 'ROUTED' then
    raise exception 'MU7-G39: only routed units are adjudicated (according to the recorded review protocol); this unit is %',
      private.mu84_unit_routing(new.unit_id, a1, a2);
  end if;
  -- GUARD MU7-G39 END
  -- GUARD MU7-G47 BEGIN
  if new.status = 'DISCORDANT_RESOLVED' and (
       (new.basis = 'REVIEWER_1' and a1 is distinct from new.decision) or (new.basis = 'REVIEWER_2' and a2 is distinct from new.decision)
       or (new.basis = 'NEITHER' and (a1 = new.decision or a2 = new.decision))) then
    raise exception 'MU7-G47: the basis must name the reviewer whose effective answer equals the decision (NEITHER when none does)';
  end if;
  if new.decision = 'DISAGREE' and new.reason_code is not null
     and not private.mu7_reason_ok(u.family, u.assignment_code, new.reason_code) then
    raise exception 'MU7-G47: reason code % does not fit a % unit showing %', new.reason_code, u.family, u.assignment_code;
  end if;
  -- GUARD MU7-G47 END
  new.decided_at := now();
  return new;
end $$;

create or replace function private.mu7_reference_locks_before_insert() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  n_units integer; n_incomplete integer; n_pending integer;
begin
  select count(*),
         count(*) filter (where private.mu84_unit_routing(u.unit_id, private.mu7_effective_answer(u.unit_id, 1), private.mu7_effective_answer(u.unit_id, 2)) = 'INCOMPLETE'),
         count(*) filter (where private.mu84_unit_routing(u.unit_id, private.mu7_effective_answer(u.unit_id, 1), private.mu7_effective_answer(u.unit_id, 2)) = 'ROUTED'
                            and not exists (select 1 from public.mu7_adjudications x where x.unit_id = u.unit_id))
    into n_units, n_incomplete, n_pending
  from public.mu7_units u where u.mode = new.mode;
  -- GUARD MU7-G48 BEGIN
  if new.mode = 'FORMAL' and not (private.mu7_closed() and private.mu7_snapshot_taken()) then
    raise exception 'MU7-G48: the FORMAL reference is locked after the close and the snapshot';
  end if;
  if new.mode = 'PILOT' and n_incomplete > 0 then
    raise exception 'MU7-G48: % PILOT units lack an answer from both reviewers', n_incomplete;
  end if;
  if n_pending > 0 then
    raise exception 'MU7-G48: % routed units are not adjudicated', n_pending;
  end if;
  -- GUARD MU7-G48 END
  if private.mu84_active(new.mode) and not private.mu84_both_finished(new.mode) then
    raise exception 'MU84-G13: both completion receipts are required before the reference lock';
  end if;
  new.n_units_locked := n_units;
  new.locked_at := now();
  return new;
end $$;

create or replace view public.v_mu7_final_reference with (security_invoker = true) as
with e as (
  select v.unit_id,
         max(v.answer_initial) filter (where v.reviewer_slot = 1) as i1, max(v.answer_initial) filter (where v.reviewer_slot = 2) as i2,
         max(v.answer_effective) filter (where v.reviewer_slot = 1) as a1, max(v.answer_effective) filter (where v.reviewer_slot = 2) as a2
  from public.v_mu7_independent_judgments v group by v.unit_id
)
select u.unit_id, u.mode, u.family, u.category, u.unit_role, u.mapping_code, u.assignment_code, u.assignment_status,
       e.i1 as answer_initial_slot1, e.i2 as answer_initial_slot2, e.a1 as answer_effective_slot1, e.a2 as answer_effective_slot2,
       private.mu84_unit_routing(u.unit_id, e.a1, e.a2) as routing,
       case private.mu84_unit_routing(u.unit_id, e.a1, e.a2) when 'CONCORDANT_AGREE' then 'AGREE' when 'CONCORDANT_DISAGREE' then 'DISAGREE'
            when 'BOTH_CANNOT_TELL' then 'CANNOT_TELL' when 'ROUTED' then x.decision end as final_answer,
       case private.mu84_unit_routing(u.unit_id, e.a1, e.a2)
            when 'CONCORDANT_AGREE' then 'CONCORDANT' when 'CONCORDANT_DISAGREE' then 'CONCORDANT'
            when 'BOTH_CANNOT_TELL' then 'CANNOT_TELL_BY_RULE'
            when 'ROUTED' then case when x.adjudication_id is null then 'PENDING_ADJUDICATION'
                                    when x.status = 'UNRESOLVED_ESCALATED' then 'UNRESOLVED' else 'ADJUDICATED' end
            else 'INCOMPLETE' end as final_status,
       x.reason_code as adjudication_reason_code, x.status as adjudication_status, x.basis as adjudication_basis,
       x.disagreement_reason_code as adjudication_disagreement_reason_code
from public.mu7_units u
join e on e.unit_id = u.unit_id
left join public.mu7_adjudications x on x.unit_id = u.unit_id
where private.mu7_can_read_judgments(u.mode);

-- A direct helper call may not reveal another reviewer's progress or a hidden mode.
create or replace function private.mu84_unit_routing(p_unit text,p_a1 text,p_a2 text) returns text
language sql stable security definer set search_path='' as $$
 select case when not private.mu7_can_read_judgments(u.mode) then null
  when private.mu84_active(u.mode) then
   case when not private.mu84_both_finished(u.mode) then 'INCOMPLETE'
        when p_a1='CANNOT_TELL' and p_a2='CANNOT_TELL' then 'ROUTED'
        else private.mu7_routing(p_a1,p_a2) end
  else private.mu7_routing(p_a1,p_a2) end from public.mu7_units u where u.unit_id=p_unit
$$;
grant execute on function private.mu84_unit_routing(text,text,text) to authenticated;

alter table public.mu7_exports drop constraint mu7_exports_format_ck;
alter table public.mu7_exports add constraint mu7_exports_format_ck
 check(bundle_format_version in ('7.0','8.1','8.2','8.3','8.4'));

create or replace function private.mu81_export_version() returns trigger
language plpgsql security definer set search_path = '' as $$
declare n integer; b record; p record;
begin
 -- Unknown formats retain the historical named CHECK-constraint refusal.
 if new.bundle_format_version not in ('7.0','8.1','8.2','8.3','8.4') then return new; end if;
 if private.mu81_reviewer_profile_active() then
   if new.bundle_format_version <> (case when private.mu84_active(new.mode) then '8.4' else '8.3' end) then
     raise exception 'MU81-P04: the reviewer profile requires the bundle matching its recorded completion protocol';
   end if;
   select * into b from public.mu7_reviewer_profile_v81;
   select count(*) into n from public.mu7_judgments where mode=new.mode;
   if (new.row_counts->>'reviewer_guide') is distinct from '1'
      or (new.row_counts->>'judgment_history') is distinct from n::text
      or (new.row_counts->>'subtype_observations') is distinct from n::text
      or (new.file_sha256->>'reviewer_guide.md') is distinct from b.rubric_sha256
      or coalesce(new.file_sha256->>'judgment_history.csv','') !~ '^[0-9a-f]{64}$'
      or coalesce(new.file_sha256->>'subtype_observations.csv','') !~ '^[0-9a-f]{64}$' then
     raise exception 'MU81-P05: bundle 8.3 requires the bound guide and complete history and subtype inventories';
   end if;
   if new.mode='FORMAL' then
     if (select reviewer_profile_sha256 from public.mu7_freeze) is distinct from b.binding_sha256 then
       raise exception 'MU81-P06: the freeze must bind this reviewer profile';
     end if;
     if (select overlap_setting from public.mu7_design)='ONE_PER_TRIAL' then
       select * into p from public.mu7_probability_binding_v81;
       select count(*) into n from public.mu7_units where mode='FORMAL';
       if p.binding_sha256 is null
          or (select probability_binding_sha256 from public.mu7_freeze) is distinct from p.binding_sha256
          or (new.row_counts->>'probabilities') is distinct from n::text
          or (new.row_counts->>'probability_source') is distinct from n::text
          or (new.file_sha256->>'probabilities.csv') is distinct from private.sha256_hex(p.canonical_csv)
          or (new.file_sha256->>'probability_source.csv') is distinct from p.file_sha256 then
         raise exception 'MU81-P07: bundle 8.3 requires the frozen probability source and canonical rows';
       end if;
     end if;
   end if;
 elsif new.bundle_format_version in ('8.3','8.4')
       or (private.mu81_active() and new.bundle_format_version='7.0')
       or (not private.mu81_active() and new.bundle_format_version<>'7.0') then
   raise exception 'MU81-G08: bundle format must match the recorded design and reviewer profile';
 end if;
 if private.mu84_active(new.mode) then
   select count(*) into n from public.mu7_units where mode=new.mode;
   if not private.mu84_both_finished(new.mode)
      or (new.row_counts->>'review_completions') is distinct from '2'
      or (new.row_counts->>'completion_protocol') is distinct from '1'
      or (new.row_counts->>'final_answer_flags') is distinct from n::text
      or (new.file_sha256->>'reviewer_guide_current.md') is distinct from
         (select guide_sha256 from public.mu7_completion_protocol_v84 where mode=new.mode) then
     raise exception 'MU84-G14: completion receipts, final-answer flags and the current guide are required';
   end if;
   if new.mode='FORMAL' and (select completion_protocol_sha256 from public.mu7_freeze) is distinct from
      (select binding_sha256 from public.mu7_completion_protocol_v84 where mode='FORMAL') then
     raise exception 'MU84-G15: the freeze must bind the completion protocol';
   end if;
 end if;
 return new;
end $$;
commit;
