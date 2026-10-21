-- Synthetic-only application extension. Original v2/v3/v4 objects remain intact.
-- This is a pilot workflow, not an approved formal-study migration.
begin;
insert into public.app_schema_version(version,description) values
 ('4.0.1-synthetic','Synthetic Verify workflow: locked submissions, explicit amendments, authorized blinded adjudication');

create table public.verify_state (
 singleton boolean primary key default true check(singleton),
 phase text not null default 'OPEN' check(phase in ('OPEN','CLOSED','ADJUDICATION','LOCKED')),
 tier1_proposal text default null check(tier1_proposal in ('v1.1','v1.2')),
 snapshot_hash text,
 locked_at timestamptz
);
insert into public.verify_state(singleton) values(true);
create table public.verify_cases (
 id text primary key check(id ~ '^SYN-[0-9]{3}$'),
 kind text not null check(kind in ('DESCRIPTOR','TWO_STEP')),
 packet jsonb not null,
 trial_packet jsonb,
 check((kind='TWO_STEP') = (trial_packet is not null))
);
create table public.verify_assignments (
 case_id text references public.verify_cases(id),
 reviewer_id uuid references public.users(user_id),
 position integer not null,
 primary key(case_id,reviewer_id), unique(reviewer_id,position)
);
create table public.verify_drafts (
 id uuid primary key default gen_random_uuid(),
 amendment_id uuid,
 case_id text references public.verify_cases(id),
 reviewer_id uuid references public.users(user_id),
 level text not null check(level in ('DESCRIPTOR_LEVEL','DESCRIPTOR_LEVEL_IN_TRIAL_CASE','TRIAL_LEVEL')),
 payload jsonb not null,
 updated_at timestamptz not null default clock_timestamp(),
 unique nulls not distinct(case_id,reviewer_id,level,amendment_id),
 foreign key(case_id,reviewer_id) references public.verify_assignments(case_id,reviewer_id)
);
create table public.verify_amendments (
 id uuid primary key default gen_random_uuid(),
 case_id text not null,
 reviewer_id uuid not null,
 level text not null check(level in ('DESCRIPTOR_LEVEL','DESCRIPTOR_LEVEL_IN_TRIAL_CASE','TRIAL_LEVEL')),
 reason text not null check(length(btrim(reason)) between 1 and 4000),
 attestation text not null check(length(btrim(attestation)) between 1 and 4000),
 authorized_by uuid not null references public.users(user_id),
 authorized_at timestamptz not null default clock_timestamp(),
 foreign key(case_id,reviewer_id) references public.verify_assignments(case_id,reviewer_id)
);
alter table public.verify_drafts add foreign key(amendment_id) references public.verify_amendments(id);
create table public.verify_responses (
 id uuid primary key default gen_random_uuid(),
 sequence bigint generated always as identity unique,
 case_id text not null,
 reviewer_id uuid not null,
 level text not null check(level in ('DESCRIPTOR_LEVEL','DESCRIPTOR_LEVEL_IN_TRIAL_CASE','TRIAL_LEVEL')),
 decision text not null check(decision in ('INCLUDE','EXCLUDE','CONTEXT_DEPENDENT','INSUFFICIENT_INFORMATION')),
 rationale text not null check(length(btrim(rationale)) between 1 and 4000),
 uncertain boolean not null default false,
 packet_problem boolean not null default false,
 packet_problem_note text,
 descriptor_role text,
 context_note text not null default '',
 amendment_id uuid unique references public.verify_amendments(id),
 supersedes uuid unique references public.verify_responses(id),
 submitted_at timestamptz not null default clock_timestamp(),
 foreign key(case_id,reviewer_id) references public.verify_assignments(case_id,reviewer_id),
 check((amendment_id is null) = (supersedes is null)),
 check(not packet_problem or coalesce(length(btrim(packet_problem_note)),0)>0),
 check((level='TRIAL_LEVEL') = (descriptor_role is not null))
);
create unique index verify_initial_once on public.verify_responses(case_id,reviewer_id,level) where supersedes is null;
create table public.verify_adjudications (
 id uuid primary key default gen_random_uuid(),
 case_id text not null references public.verify_cases(id),
 level text not null check(level in ('DESCRIPTOR_LEVEL','DESCRIPTOR_LEVEL_IN_TRIAL_CASE','TRIAL_LEVEL')),
 adjudicator_id uuid not null references public.users(user_id),
 decision text check(decision in ('INCLUDE','EXCLUDE','CONTEXT_DEPENDENT','INSUFFICIENT_INFORMATION')),
 status text not null check(status in ('RESOLVED','UNRESOLVED_ESCALATED')),
 rationale text not null check(length(btrim(rationale)) between 1 and 4000),
 basis text not null check(length(btrim(basis)) between 1 and 4000),
 uncertain boolean not null,
 context_note text not null default '',
 packet_problem boolean not null,
 packet_problem_note text,
 check(not packet_problem or coalesce(length(btrim(packet_problem_note)),0)>0),
 reason_code text not null check(reason_code in ('CONSTRUCT_BOUNDARY','POLICY_RULE_INTERPRETATION','MESH_PLACEMENT_MISLEADING','TRIAL_CONTEXT','PACKET_INSUFFICIENT','MULTILABEL_OR_CROSS_AREA','OTHER')),
 created_at timestamptz not null default clock_timestamp(),
 unique(case_id,level),
 check((status='UNRESOLVED_ESCALATED') = (decision is null))
);
create table public.verify_audit (
 sequence bigint generated always as identity primary key,
 actor_id uuid references public.users(user_id),
 action text not null,
 case_id text,
 occurred_at timestamptz not null default clock_timestamp(),
 details jsonb not null default '{}'::jsonb
);

create function private.verify_phase() returns text
 language sql stable security definer set search_path='' as $$select phase from public.verify_state where singleton$$;
create function private.verify_assigned(p_case text) returns boolean
 language sql stable security definer set search_path='' as $$select exists(select 1 from public.verify_assignments where case_id=p_case and reviewer_id=private.app_user_id())$$;
create function private.verify_has_step1(p_case text) returns boolean
 language sql stable security definer set search_path='' as $$select exists(select 1 from public.verify_responses where case_id=p_case and reviewer_id=private.app_user_id() and level='DESCRIPTOR_LEVEL_IN_TRIAL_CASE')$$;
create function private.verify_snapshot() returns text
 language sql stable security definer set search_path='' as $$
 select private.sha256_hex(coalesce(string_agg(to_jsonb(r)::text,E'\n' order by r.sequence),'')) from public.verify_responses r
$$;
create function private.verify_log(p_action text,p_case text default null,p_details jsonb default '{}'::jsonb) returns void
 language sql security definer set search_path='' as $$
 insert into public.verify_audit(actor_id,action,case_id,details) values(private.app_user_id(),p_action,p_case,p_details)
$$;

-- Unconditional append-only enforcement also protects against application-owner mistakes.
do $$declare t text; begin
 foreach t in array array['verify_responses','verify_amendments','verify_adjudications','verify_audit','verify_cases','verify_assignments'] loop
 execute format('create trigger immutable before update or delete or truncate on public.%I for each statement execute function private.reject_mutation()',t);
 end loop;
end$$;

-- Context-dependent is a substantive answer; unknown and unresolved answers do
-- not acquire invented inclusion/exclusion conditions.
create function private.verify_context_valid(p text) returns boolean
 language plpgsql immutable set search_path='' as $$
declare obj jsonb; k text;
begin
 begin obj:=p::jsonb; exception when invalid_text_representation then return false; end;
 if obj is null or jsonb_typeof(obj)<>'object' then return false; end if;
 if (obj - array['clinicalContext','inclusionConditions','exclusionConditions']) <> '{}'::jsonb then return false; end if;
 foreach k in array array['clinicalContext','inclusionConditions','exclusionConditions'] loop
 if coalesce(jsonb_typeof(obj->k),'null')<>'string' or coalesce(obj->>k,'') !~ '[^[:space:]]' then return false; end if;
 end loop;
 return true;
end$$;

create function private.verify_response_guard() returns trigger
 language plpgsql security definer set search_path='' as $$
declare c public.verify_cases; prev uuid; a public.verify_amendments;
begin
 if private.verify_phase()<>'OPEN' then raise exception 'Review is closed'; end if;
 if new.decision='CONTEXT_DEPENDENT' and not private.verify_context_valid(new.context_note) then raise exception 'Structured context is required'; end if;
 if private.app_role()<>'REVIEWER' or new.reviewer_id<>private.app_user_id() or not private.verify_assigned(new.case_id) then raise exception 'Reviewer assignment required'; end if;
 select * into strict c from public.verify_cases where id=new.case_id;
 if (c.kind='DESCRIPTOR' and new.level<>'DESCRIPTOR_LEVEL') or (c.kind='TWO_STEP' and new.level='DESCRIPTOR_LEVEL') then raise exception 'Invalid determination level'; end if;
 if new.level='TRIAL_LEVEL' and not private.verify_has_step1(new.case_id) then raise exception 'Submit descriptor judgment before trial context'; end if;
 if new.level='TRIAL_LEVEL' and new.descriptor_role not in ('DISEASE_STUDIED','COMORBIDITY','COMPLICATION','OUTCOME_ONLY','PREVENTION_TARGET','RISK_FACTOR','OTHER','UNRESOLVABLE') then raise exception 'Invalid synthetic trial role'; end if;
 select id into prev from public.verify_responses where case_id=new.case_id and reviewer_id=new.reviewer_id and level=new.level order by sequence desc limit 1;
 if prev is not null then
   if new.amendment_id is null or new.supersedes is distinct from prev then raise exception 'Final response locked; an authorized amendment is required'; end if;
   select * into a from public.verify_amendments where id=new.amendment_id;
   if a.id is null or a.case_id<>new.case_id or a.reviewer_id<>new.reviewer_id or a.level<>new.level then raise exception 'Amendment does not authorize this response'; end if;
 else
   if new.amendment_id is not null or new.supersedes is not null then raise exception 'Initial response cannot be an amendment'; end if;
 end if;
 return new;
end$$;
create trigger verify_response_guard before insert on public.verify_responses for each row execute function private.verify_response_guard();

create function private.verify_adjudication_guard() returns trigger
 language plpgsql security definer set search_path='' as $$
declare n integer;
begin
 if not private.is_adjudicator() then raise exception 'Adjudicator role required'; end if;
 if new.decision='CONTEXT_DEPENDENT' and not private.verify_context_valid(new.context_note) then raise exception 'Structured context is required'; end if;
 if private.verify_phase()<>'ADJUDICATION' then raise exception 'Adjudication authorization required'; end if;
 if exists(select 1 from public.verify_assignments where case_id=new.case_id and reviewer_id=private.app_user_id()) then raise exception 'Cannot adjudicate an assigned review'; end if;
 select count(distinct reviewer_id) into n from public.verify_responses where case_id=new.case_id and level=new.level;
 if n<>2 then raise exception 'Two independent submissions required'; end if;
 if (select snapshot_hash from public.verify_state) is distinct from private.verify_snapshot() then raise exception 'Judgment snapshot integrity failure'; end if;
 new.adjudicator_id:=private.app_user_id();
 return new;
end$$;
create trigger verify_adjudication_guard before insert on public.verify_adjudications for each row execute function private.verify_adjudication_guard();

-- Row-level security: reviewers see their own records only. Adjudicators see
-- judgments only in the explicitly authorized phase; investigators only counts
-- until reference lock. Case packets are accessible exclusively through the RPC.
do $$declare t text; begin
 foreach t in array array['verify_state','verify_cases','verify_assignments','verify_drafts','verify_amendments','verify_responses','verify_adjudications','verify_audit'] loop
 execute format('alter table public.%I enable row level security',t);
 execute format('revoke all on public.%I from public,anon,authenticated',t);
 end loop;
end$$;
grant select on public.verify_state,public.verify_assignments,public.verify_drafts,public.verify_amendments,public.verify_responses,public.verify_adjudications,public.verify_audit to authenticated;
create policy verify_state_read on public.verify_state for select to authenticated using(private.app_role() is not null);
create policy verify_assignment_read on public.verify_assignments for select to authenticated using(reviewer_id=private.app_user_id() or private.is_investigator());
create policy verify_draft_read on public.verify_drafts for select to authenticated using(reviewer_id=private.app_user_id());
create policy verify_amendment_read on public.verify_amendments for select to authenticated using(reviewer_id=private.app_user_id() or private.is_investigator());
create policy verify_response_read on public.verify_responses for select to authenticated using(reviewer_id=private.app_user_id() or (private.is_adjudicator() and private.verify_phase() in ('ADJUDICATION','LOCKED')) or (private.is_investigator() and private.verify_phase()='LOCKED'));
create policy verify_adjudication_read on public.verify_adjudications for select to authenticated using(private.is_adjudicator() or (private.is_investigator() and private.verify_phase()='LOCKED'));
create policy verify_audit_read on public.verify_audit for select to authenticated using(private.is_investigator());

create function public.rpc_verify_workspace() returns jsonb
 language plpgsql stable security definer set search_path='' as $$
declare role text:=private.app_role(); me uuid:=private.app_user_id(); result jsonb; items jsonb;
begin
 if role is null then raise exception 'Authentication required'; end if;
 if role='INVESTIGATOR' then perform private.assert_investigator(); end if;
 if role='REVIEWER' then
 select coalesce(jsonb_agg(jsonb_build_object('id',c.id,'kind',c.kind,'title',c.packet->>'title','area',c.packet->>'area','position',a.position,
 'status',case when exists(select 1 from public.verify_responses r where r.case_id=c.id and r.reviewer_id=me and r.level=case when c.kind='TWO_STEP' then 'TRIAL_LEVEL' else 'DESCRIPTOR_LEVEL' end) then 'SUBMITTED'
 when exists(select 1 from public.verify_responses r where r.case_id=c.id and r.reviewer_id=me) then 'STEP1_LOCKED'
 when exists(select 1 from public.verify_drafts d where d.case_id=c.id and d.reviewer_id=me) then 'DRAFT' else 'NOT_STARTED' end) order by a.position),'[]'::jsonb)
 into items from public.verify_cases c join public.verify_assignments a on a.case_id=c.id where a.reviewer_id=me;
 elsif role='ADJUDICATOR' then
 if private.verify_phase() in ('ADJUDICATION','LOCKED') then
 select coalesce(jsonb_agg(jsonb_build_object('id',c.id,'kind',c.kind,'title',c.packet->>'title','area',c.packet->>'area','position',0,'status',
 case when (select count(*) from public.verify_adjudications j where j.case_id=c.id)=case when c.kind='TWO_STEP' then 2 else 1 end then 'ADJUDICATED' else 'READY' end) order by c.id),'[]'::jsonb) into items from public.verify_cases c;
 else items:='[]'::jsonb; end if;
 else items:='[]'::jsonb; end if;
 result:=jsonb_build_object('phase',private.verify_phase(),'cases',items,'synthetic',true,'analysisPlanStatus','PENDING_APPROVAL');
 if role='INVESTIGATOR' then
 result:=result || jsonb_build_object('summary',jsonb_build_object('totalCases',(select count(*) from public.verify_cases),'totalAssignments',(select count(*) from public.verify_assignments),'submittedAssignments',(select count(*) from public.verify_assignments a join public.verify_cases c on c.id=a.case_id where exists(select 1 from public.verify_responses r where r.case_id=a.case_id and r.reviewer_id=a.reviewer_id and r.level=case when c.kind='TWO_STEP' then 'TRIAL_LEVEL' else 'DESCRIPTOR_LEVEL' end)), 'totalLevels',(select sum(case when kind='TWO_STEP' then 2 else 1 end) from public.verify_cases),'adjudicatedLevels',(select count(*) from public.verify_adjudications)),
 'tier1Proposal',(select tier1_proposal from public.verify_state),'audit',(select coalesce(jsonb_agg(to_jsonb(x) order by x.sequence desc),'[]'::jsonb) from (select * from public.verify_audit order by sequence desc limit 100) x));
 end if;
 return result;
end$$;

create function public.rpc_verify_case(p_case text) returns jsonb
 language plpgsql stable security definer set search_path='' as $$
declare c public.verify_cases; me uuid:=private.app_user_id(); role text:=private.app_role(); result jsonb; rs jsonb;
begin
 if role='REVIEWER' then
 if not private.verify_assigned(p_case) then raise exception 'Case not assigned'; end if;
 elsif role='ADJUDICATOR' then
 if private.verify_phase() not in ('ADJUDICATION','LOCKED') then raise exception 'Adjudication authorization required'; end if;
 else raise exception 'Case packets restricted to assigned clinical roles'; end if;
 select * into c from public.verify_cases where id=p_case;
 if c.id is null then raise exception 'Case not found'; end if;
 result:=jsonb_build_object('id',c.id,'kind',c.kind,'packet',c.packet,'phase',private.verify_phase(),'synthetic',true,'evidenceHash',private.sha256_hex(c.packet::text||coalesce(c.trial_packet::text,'')));
 if role='ADJUDICATOR' or private.verify_has_step1(p_case) then result:=result||jsonb_build_object('trialPacket',c.trial_packet); end if;
 if role='REVIEWER' then
 select coalesce(jsonb_agg(to_jsonb(r) order by r.sequence),'[]'::jsonb) into rs from public.verify_responses r where case_id=p_case and reviewer_id=me;
 result:=result||jsonb_build_object('responses',rs,'drafts',(select coalesce(jsonb_agg(to_jsonb(d)),'[]'::jsonb) from public.verify_drafts d where case_id=p_case and reviewer_id=me),'amendments',(select coalesce(jsonb_agg(to_jsonb(a)),'[]'::jsonb) from public.verify_amendments a where case_id=p_case and reviewer_id=me and not exists(select 1 from public.verify_responses r where r.amendment_id=a.id)));
 else
 select coalesce(jsonb_agg(to_jsonb(x) order by x.level,x.reviewer_id),'[]'::jsonb) into rs from (select distinct on (reviewer_id,level) * from public.verify_responses where case_id=p_case order by reviewer_id,level,sequence desc) x;
 result:=result||jsonb_build_object('responses',rs,'adjudications',(select coalesce(jsonb_agg(to_jsonb(j)),'[]'::jsonb) from public.verify_adjudications j where case_id=p_case));
 end if;
 return result;
end$$;

create function public.rpc_verify_draft(p_case text,p_level text,p_payload jsonb) returns void
 language plpgsql security definer set search_path='' as $$
declare amendment uuid:=nullif(p_payload->>'amendmentId','')::uuid; has_final boolean;
begin
 if private.app_role()<>'REVIEWER' or not private.verify_assigned(p_case) then raise exception 'Reviewer assignment required'; end if;
 if private.verify_phase()<>'OPEN' then raise exception 'Review is closed'; end if;
 select exists(select 1 from public.verify_responses where case_id=p_case and reviewer_id=private.app_user_id() and level=p_level) into has_final;
 if has_final then
 if amendment is null then raise exception 'Final response locked'; end if;
 if not exists(select 1 from public.verify_amendments a where a.id=amendment and a.case_id=p_case and a.reviewer_id=private.app_user_id() and a.level=p_level and not exists(select 1 from public.verify_responses r where r.amendment_id=a.id)) then raise exception 'Amendment does not authorize this response'; end if;
 elsif amendment is not null then raise exception 'Initial response cannot be an amendment'; end if;
 if p_level='TRIAL_LEVEL' and not private.verify_has_step1(p_case) then raise exception 'Submit descriptor judgment first'; end if;
 if not exists(select 1 from public.verify_cases where id=p_case and ((kind='DESCRIPTOR' and p_level='DESCRIPTOR_LEVEL') or (kind='TWO_STEP' and p_level in ('DESCRIPTOR_LEVEL_IN_TRIAL_CASE','TRIAL_LEVEL')))) then raise exception 'Invalid determination level'; end if;
 insert into public.verify_drafts(case_id,reviewer_id,level,amendment_id,payload) values(p_case,private.app_user_id(),p_level,amendment,p_payload)
 on conflict(case_id,reviewer_id,level,amendment_id) do update set payload=excluded.payload,updated_at=clock_timestamp();
 perform private.verify_log('DRAFT_SAVED',p_case,jsonb_build_object('amendmentId',amendment,'level',p_level));
end$$;
create function public.rpc_verify_submit(p_case text,p_level text,p jsonb) returns uuid
 language plpgsql security definer set search_path='' as $$
declare result uuid; prev uuid;
begin
 select id into prev from public.verify_responses where case_id=p_case and reviewer_id=private.app_user_id() and level=p_level order by sequence desc limit 1;
 insert into public.verify_responses(case_id,reviewer_id,level,decision,rationale,uncertain,packet_problem,packet_problem_note,descriptor_role,context_note,amendment_id,supersedes)
 values(p_case,private.app_user_id(),p_level,p->>'decision',p->>'rationale',coalesce((p->>'uncertain')::boolean,false),coalesce((p->>'packetProblem')::boolean,false),nullif(coalesce(p->>'packetProblemNote',p->>'context'),''),nullif(p->>'descriptorRole',''),coalesce(p->>'context',''),nullif(p->>'amendmentId','')::uuid,prev) returning id into result;
 delete from public.verify_drafts where case_id=p_case and reviewer_id=private.app_user_id() and level=p_level and amendment_id is not distinct from nullif(p->>'amendmentId','')::uuid;
 perform private.verify_log(case when prev is null then 'RESPONSE_SUBMITTED' else 'RESPONSE_AMENDED' end,p_case,jsonb_build_object('responseId',result,'level',p_level));
 return result;
end$$;
create function public.rpc_verify_adjudicate(p_case text,p_level text,p jsonb) returns uuid
 language plpgsql security definer set search_path='' as $$
declare result uuid;
begin
 insert into public.verify_adjudications(case_id,level,adjudicator_id,decision,status,rationale,basis,reason_code,uncertain,context_note,packet_problem,packet_problem_note)
 values(p_case,p_level,private.app_user_id(),nullif(p->>'decision',''),p->>'status',p->>'rationale',p->>'basis',p->>'reasonCode',(p->>'uncertain')::boolean,coalesce(p->>'context',''),(p->>'packetProblem')::boolean,p->>'packetProblemNote') returning id into result;
 perform private.verify_log('ADJUDICATION_RECORDED',p_case,jsonb_build_object('adjudicationId',result,'level',p_level));
 return result;
end$$;
create function public.rpc_verify_admin(p jsonb) returns void
 language plpgsql security definer set search_path='' as $$
declare action text:=p->>'action'; ph text; n integer; result uuid;
begin
 perform private.assert_investigator();
 select phase into ph from public.verify_state where singleton for update;
 if action='SET_PROPOSAL' then
 if ph<>'OPEN' then raise exception 'Configuration locked'; end if;
 update public.verify_state set tier1_proposal=p->>'tier1Version';
 elsif action='AUTHORIZE_AMENDMENT' then
 if ph<>'OPEN' then raise exception 'Amendments require open review; snapshot is immutable'; end if;
 if not exists(select 1 from public.verify_responses where case_id=p->>'caseId' and reviewer_id=(p->>'reviewerId')::uuid and level=p->>'level') then raise exception 'No submitted response to amend'; end if;
 insert into public.verify_amendments(case_id,reviewer_id,level,reason,attestation,authorized_by) values(p->>'caseId',(p->>'reviewerId')::uuid,p->>'level',p->>'reason',p->>'attestation',private.app_user_id()) returning id into result;
 elsif action='CLOSE_REVIEW' then
 if ph<>'OPEN' then raise exception 'Review is not open'; end if;
 if length(btrim(coalesce(p->>'attestation','')))=0 then raise exception 'Attestation required'; end if;
 select count(*) into n from public.verify_assignments a join public.verify_cases c on c.id=a.case_id where not exists(select 1 from public.verify_responses r where r.case_id=a.case_id and r.reviewer_id=a.reviewer_id and r.level=case when c.kind='TWO_STEP' then 'TRIAL_LEVEL' else 'DESCRIPTOR_LEVEL' end);
 if n>0 then raise exception 'All assigned reviewers must submit before close'; end if;
 if exists(select 1 from public.verify_cases c where (select count(*) from public.verify_assignments a where a.case_id=c.id)<>2) then raise exception 'Exactly two independent reviewers required'; end if;
 update public.verify_state set phase='CLOSED',snapshot_hash=private.verify_snapshot();
 elsif action='AUTHORIZE_ADJUDICATION' then
 if ph<>'CLOSED' then raise exception 'Close and snapshot review before authorization'; end if;
 if length(btrim(coalesce(p->>'attestation','')))=0 then raise exception 'Attestation required'; end if;
 if (select snapshot_hash from public.verify_state) is distinct from private.verify_snapshot() then raise exception 'Judgment snapshot integrity failure'; end if;
 update public.verify_state set phase='ADJUDICATION';
 elsif action='LOCK_REFERENCE' then
 if ph<>'ADJUDICATION' then raise exception 'Adjudication phase required'; end if;
 if length(btrim(coalesce(p->>'attestation','')))=0 then raise exception 'Attestation required'; end if;
 if (select count(*) from public.verify_adjudications) <> (select sum(case when kind='TWO_STEP' then 2 else 1 end) from public.verify_cases) then raise exception 'Adjudicate every synthetic case level before locking'; end if;
 if (select snapshot_hash from public.verify_state) is distinct from private.verify_snapshot() then raise exception 'Judgment snapshot integrity failure'; end if;
 update public.verify_state set phase='LOCKED',locked_at=clock_timestamp();
 else raise exception 'Action unavailable: formal activation and imports are disabled'; end if;
 perform private.verify_log(action,p->>'caseId',jsonb_build_object('attestation',p->>'attestation','amendmentId',result,'reason',p->>'reason','tier1Proposal',p->>'tier1Version'));
end$$;
create function public.rpc_verify_export() returns jsonb
 language plpgsql security definer set search_path='' as $$
declare result jsonb;
begin
 perform private.assert_investigator();
 if private.verify_phase()<>'LOCKED' then raise exception 'Reference lock required before export'; end if;
 if (select snapshot_hash from public.verify_state) is distinct from private.verify_snapshot() then raise exception 'Judgment snapshot integrity failure'; end if;
 select jsonb_build_object('synthetic',true,'schemaVersion','4.0.1-synthetic','analysisPlanStatus','PENDING_APPROVAL','state',(select to_jsonb(s) from public.verify_state s),'cases',(select jsonb_agg(to_jsonb(c)||jsonb_build_object('evidenceHash',private.sha256_hex(c.packet::text||coalesce(c.trial_packet::text,''))) order by c.id) from public.verify_cases c),'judgments',(select jsonb_agg(to_jsonb(r) order by r.case_id,r.level,r.reviewer_id,r.sequence) from public.verify_responses r),'adjudications',(select jsonb_agg(to_jsonb(j) order by j.case_id,j.level) from public.verify_adjudications j),'amendments',(select coalesce(jsonb_agg(to_jsonb(a) order by a.authorized_at),'[]'::jsonb) from public.verify_amendments a),'audit',(select jsonb_agg(to_jsonb(a) order by a.sequence) from public.verify_audit a)) into result;
 perform private.verify_log('EXPORT_REQUESTED');
 return result;
end$$;

-- Explicit grants: security-definer entry points are not public/anonymous APIs.
revoke all on function public.rpc_verify_workspace(),public.rpc_verify_case(text),public.rpc_verify_draft(text,text,jsonb),public.rpc_verify_submit(text,text,jsonb),public.rpc_verify_adjudicate(text,text,jsonb),public.rpc_verify_admin(jsonb),public.rpc_verify_export() from public,anon;
grant execute on function public.rpc_verify_workspace(),public.rpc_verify_case(text),public.rpc_verify_draft(text,text,jsonb),public.rpc_verify_submit(text,text,jsonb),public.rpc_verify_adjudicate(text,text,jsonb),public.rpc_verify_admin(jsonb),public.rpc_verify_export() to authenticated;
revoke all on function private.verify_phase(),private.verify_assigned(text),private.verify_has_step1(text),private.verify_snapshot(),private.verify_log(text,text,jsonb),private.verify_response_guard(),private.verify_adjudication_guard(),private.verify_context_valid(text) from public,anon,authenticated;
grant execute on function private.verify_phase() to authenticated;
commit;
