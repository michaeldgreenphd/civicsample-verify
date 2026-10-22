begin;

-- Establish the new guard state from a coherent history while existing writers
-- are excluded. No historical response or frozen export is rewritten.
lock table public.tlv5_cases, public.tlv5_case_design, public.tlv5_frozen_labels,
  public.tlv5_freeze, public.tlv5_assignments, public.tlv5_submissions,
  public.tlv5_adjudications, public.tlv5_reference_locks, public.tlv5_phase_events
  in share row exclusive mode;

-- Preserve the supplied v5 migrations and all historical responses. New v5
-- writes obey the investigator's independent-role and deliberate-final rules.
-- There is no authorized v5 amendment workflow yet: ordinary resubmission is
-- refused rather than silently changing the evaluated response.
create table private.tlv5_final_submissions (
  assignment_id uuid primary key references public.tlv5_assignments(assignment_id)
);
insert into private.tlv5_final_submissions
  select distinct assignment_id from public.tlv5_submissions;
revoke all on private.tlv5_final_submissions from public, anon, authenticated;

create table private.tlv5_final_adjudications (
  case_id text not null references public.tlv5_cases(case_id),
  item_code text not null,
  primary key(case_id,item_code)
);
insert into private.tlv5_final_adjudications
  select distinct case_id,item_code from public.tlv5_adjudications;
revoke all on private.tlv5_final_adjudications from public,anon,authenticated;

-- A row that exists before any request can start provides a current tuple after
-- waiting for another READ COMMITTED writer (EvalPlanQual). Merely re-reading
-- append-only events from a waiting statement can retain an earlier snapshot.
create table private.tlv5_control_state (
  singleton boolean primary key default true check(singleton),
  frozen boolean not null,
  phase text not null check(phase in ('NOT_OPENED','OPEN','CLOSED')),
  locked_modes jsonb not null
);
insert into private.tlv5_control_state values
  (true, private.tlv5_frozen(), private.tlv5_phase(),
   coalesce((select jsonb_object_agg(mode,true) from public.tlv5_reference_locks),'{}'::jsonb));
revoke all on private.tlv5_control_state from public, anon, authenticated;

create function private.tlv5_case_complete(p_case_id text) returns boolean
language sql stable security definer set search_path='' as $$
  select count(distinct a.reviewer_slot)=2
  from public.tlv5_assignments a
  where a.case_id=p_case_id
    and exists(select 1 from public.tlv5_submissions s where s.assignment_id=a.assignment_id)
$$;

create function private.tlv5_can_read_case_answers(p_case_id text) returns boolean
language sql stable security definer set search_path='' as $$
  select exists(select 1 from public.tlv5_cases c where c.case_id=p_case_id
    and private.tlv5_can_read_answers(c.mode)
    and (private.is_investigator()
         or (private.is_adjudicator() and private.tlv5_case_complete(c.case_id))))
$$;

-- Authenticated callers previously could invoke these SECURITY DEFINER helpers
-- directly to bypass table RLS. Authorize the case inside each helper as well.
create or replace function private.tlv5_item_answers(p_case_id text,p_item text)
returns table(reviewer_slot smallint,answer text,detail_code text)
language sql stable security definer set search_path='' as $$
  select a.reviewer_slot,i.answer,i.detail_code
  from public.tlv5_assignments a
  join public.tlv5_submissions s on s.assignment_id=a.assignment_id
    and s.revision_number=(select max(s2.revision_number) from public.tlv5_submissions s2
                          where s2.assignment_id=a.assignment_id)
  join public.tlv5_submission_items i on i.submission_id=s.submission_id and i.item_code=p_item
  where a.case_id=p_case_id and private.tlv5_can_read_case_answers(p_case_id)
$$;
create or replace function private.tlv5_n_reviewed(p_case_id text) returns integer
language sql stable security definer set search_path='' as $$
  select count(distinct a.reviewer_slot)::integer from public.tlv5_assignments a
  where a.case_id=p_case_id and private.tlv5_can_read_case_answers(p_case_id)
    and exists(select 1 from public.tlv5_submissions s where s.assignment_id=a.assignment_id)
$$;

alter policy tlv5_cases_read on public.tlv5_cases using
  (private.is_investigator() or private.tlv5_is_assigned(case_id)
   or (private.is_adjudicator() and private.tlv5_can_read_case_answers(case_id)));
alter policy tlv5_assignments_read on public.tlv5_assignments using
  (private.is_investigator() or reviewer_pseudo_id=private.my_reviewer_pseudo_id()
   or (private.is_adjudicator() and private.tlv5_can_read_case_answers(case_id)));
alter policy tlv5_submissions_read on public.tlv5_submissions using
  (reviewer_pseudo_id=private.my_reviewer_pseudo_id()
   or private.tlv5_can_read_case_answers(case_id));
alter policy tlv5_submission_items_read on public.tlv5_submission_items using
  (exists(select 1 from public.tlv5_submissions s where s.submission_id=tlv5_submission_items.submission_id
    and (s.reviewer_pseudo_id=private.my_reviewer_pseudo_id()
         or private.tlv5_can_read_case_answers(s.case_id))));

create function private.tlv5_independent_finality_guard() returns trigger
language plpgsql security definer set search_path='' as $$
declare
  st private.tlv5_control_state%rowtype;
  m text;
begin
  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'v5 lifecycle writes require READ COMMITTED isolation';
  end if;
  select * into st from private.tlv5_control_state where singleton for update;
  if tg_table_name='tlv5_freeze' then
    update private.tlv5_control_state set frozen=true where singleton;
  elsif tg_table_name='tlv5_phase_events' then
    if new.event_type='FORMAL_OPENED' then
      if st.phase <> 'NOT_OPENED' or not st.frozen then
        raise exception 'v5 formal phase cannot open in its current state';
      end if;
      update private.tlv5_control_state set phase='OPEN' where singleton;
    elsif new.event_type in ('FORMAL_CLOSED_COMPLETE','FORMAL_CLOSED_INCOMPLETE') then
      if st.phase <> 'OPEN' then raise exception 'v5 formal phase is not open'; end if;
      update private.tlv5_control_state set phase='CLOSED' where singleton;
    end if;
  else
    m:=new.mode;
    if tg_table_name='tlv5_reference_locks' then
      if st.locked_modes ? m then raise exception 'v5 reference already locked'; end if;
      if exists(select 1 from public.tlv5_cases c where c.mode=m
                and not private.tlv5_case_complete(c.case_id)) then
        raise exception 'Two independent final submissions per case are required before reference lock';
      end if;
      update private.tlv5_control_state set locked_modes=locked_modes||jsonb_build_object(m,true)
        where singleton;
    else
      if st.locked_modes ? m then raise exception 'v5 reference is locked; writes are closed'; end if;
      if tg_table_name in ('tlv5_cases','tlv5_case_design','tlv5_frozen_labels')
         and m in ('FORMAL','CALIBRATION') and st.frozen then
        raise exception 'v5 sample is frozen; imports are closed';
      end if;
      if tg_table_name in ('tlv5_assignments','tlv5_submissions') then
        if m='FORMAL' and st.phase <> 'OPEN' then
          raise exception 'v5 formal phase is not open';
        elsif m='TRAINING' and st.phase <> 'NOT_OPENED' then
          raise exception 'v5 training is closed';
        elsif m='CALIBRATION' and st.frozen then
          raise exception 'v5 calibration is closed';
        end if;
      end if;
      if tg_table_name='tlv5_submissions' then
        if exists(select 1 from private.tlv5_final_submissions f where f.assignment_id=new.assignment_id) then
          raise exception 'Final v5 submission is locked; an authorized amendment workflow is required';
        end if;
        -- The unique key also refuses concurrent final submissions even when a
        -- statement started before another transaction committed its response.
        insert into private.tlv5_final_submissions values(new.assignment_id);
      elsif tg_table_name='tlv5_adjudications' then
        if private.app_role() is distinct from 'ADJUDICATOR'
           or private.app_user_id() is distinct from new.decided_by
           or not exists(select 1 from public.users u where u.user_id=new.decided_by
                         and u.role='ADJUDICATOR' and u.is_active) then
          raise exception 'An active ADJUDICATOR must record their own adjudication; investigators cannot enter judgments'
            using errcode='42501';
        end if;
        if not private.tlv5_case_complete(new.case_id) then
          raise exception 'Two independent final submissions are required before adjudication';
        end if;
        if m='FORMAL' and st.phase <> 'CLOSED' then
          raise exception 'v5 formal adjudication requires a closed phase';
        elsif m='TRAINING' and st.phase <> 'NOT_OPENED' then
          raise exception 'v5 training is closed';
        end if;
        if exists(select 1 from private.tlv5_final_adjudications j
                  where j.case_id=new.case_id and j.item_code=new.item_code) then
          raise exception 'Final v5 adjudication is locked; an authorized amendment workflow is required';
        end if;
        insert into private.tlv5_final_adjudications values(new.case_id,new.item_code);
      end if;
    end if;
  end if;
  return new;
end $$;

do $$ declare t text; begin
  foreach t in array array['tlv5_cases','tlv5_case_design','tlv5_frozen_labels','tlv5_freeze',
    'tlv5_assignments','tlv5_submissions','tlv5_adjudications','tlv5_reference_locks','tlv5_phase_events'] loop
    execute format('create trigger aa_tlv5_independent_finality before insert on public.%I for each row execute function private.tlv5_independent_finality_guard()',t);
  end loop;
end $$;

revoke all on function private.tlv5_case_complete(text),private.tlv5_can_read_case_answers(text),
  private.tlv5_independent_finality_guard() from public,anon,authenticated;
grant execute on function private.tlv5_can_read_case_answers(text) to authenticated;

-- Freeze/lock calculate aggregates before their INSERT triggers. Acquire the
-- lifecycle lock at RPC entry, before the original calculations, so a waiting
-- request cannot publish counts/hashes computed before an import committed.
alter function public.rpc_tlv5_freeze(jsonb) rename to tlv5_freeze_before_finality;
alter function public.tlv5_freeze_before_finality(jsonb) set schema private;
alter function public.rpc_tlv5_lock_reference(text,text) rename to tlv5_lock_before_finality;
alter function public.tlv5_lock_before_finality(text,text) set schema private;
revoke all on function private.tlv5_freeze_before_finality(jsonb),
  private.tlv5_lock_before_finality(text,text) from public,anon,authenticated;

create function public.rpc_tlv5_freeze(p jsonb) returns uuid
language plpgsql security definer set search_path='' as $$
begin
  perform private.assert_investigator();
  perform 1 from private.tlv5_control_state where singleton for update;
  return private.tlv5_freeze_before_finality(p);
end $$;
create function public.rpc_tlv5_lock_reference(p_mode text,p_attestation text) returns uuid
language plpgsql security definer set search_path='' as $$
begin
  perform private.assert_investigator();
  perform 1 from private.tlv5_control_state where singleton for update;
  return private.tlv5_lock_before_finality(p_mode,p_attestation);
end $$;
revoke all on function public.rpc_tlv5_freeze(jsonb),public.rpc_tlv5_lock_reference(text,text)
  from public,anon;
grant execute on function public.rpc_tlv5_freeze(jsonb),public.rpc_tlv5_lock_reference(text,text)
  to authenticated;

insert into public.app_schema_version(version,description) values
 ('5.1.1-independent-finality','Case-aware blinding, independent adjudicators, immutable final submissions and serialized lifecycle guards');
commit;
