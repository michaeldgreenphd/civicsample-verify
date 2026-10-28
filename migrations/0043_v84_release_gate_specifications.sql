-- Reviewed, fixed questions for the prepared v8.1 study. This installs a recording
-- operation only: no evidence, requirement, approval, freeze or phase is recorded
-- by applying the migration. An investigator must supply checked evidence files;
-- each scientific approval remains a separate existing rpc_mu7_approve_gate call.
begin;
insert into public.app_schema_version(version, description) values
 ('8.4.3-release-gate-specifications', 'Evidence-bound specifications for prepared v8.1 release; no approvals');

create table public.mu7_release_specification_v84 (
 singleton boolean primary key default true check(singleton),
 evidence jsonb not null,
 bindings jsonb not null,
 binding_sha256 text not null check(binding_sha256 ~ '^[a-f0-9]{64}$'),
 attestation text not null check(length(btrim(attestation)) between 20 and 2000),
 recorded_by uuid not null references public.users(user_id),
 recorded_at timestamptz not null default now()
);
alter table public.mu7_release_specification_v84 enable row level security;
revoke all on public.mu7_release_specification_v84 from public,anon,authenticated,service_role;
grant select on public.mu7_release_specification_v84 to authenticated;
create policy mu84_release_specification_read on public.mu7_release_specification_v84
 for select to authenticated using(private.is_investigator());
create trigger mu84_release_specification_immutable before update or delete
 on public.mu7_release_specification_v84 for each row execute function private.reject_mutation();
create trigger mu84_release_specification_no_truncate before truncate
 on public.mu7_release_specification_v84 for each statement execute function private.reject_mutation();

create function public.rpc_mu84_record_release_specifications(p_state_sha256 text,p jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
 me uuid; s jsonb; att text; e jsonb; b jsonb; h text; r record; latest record;
 evidence_sorted jsonb; receipt record; profile record; protocol record; probability record;
 gates text[]:=array['G-ALLOC-01','G-AREA-01','G-MH-V53','G-OQ-03','G-OQ-04',
  'G-OVERLAP-01','G-PAIN-01','G-PROV-01','G-RUBRIC-01','G-TEXT-01','G-TEXT-02'];
begin
 perform private.assert_investigator();
 if current_setting('transaction_isolation')<>'read committed' then
  raise exception 'MU84-L13: READ COMMITTED required';
 end if;
 perform pg_catalog.pg_advisory_xact_lock(7024025);
 me:=private.assert_investigator();
 s:=private.mu84_release_state();
 if p_state_sha256 is distinct from private.sha256_hex(s::text) then
  raise exception 'MU84-L14: review status changed; refresh before recording specifications';
 end if;
 perform private.mu7_assert_keys(p,array['attestation','evidence'],'release specifications');
 att:=btrim(p->>'attestation');
 if jsonb_typeof(p->'attestation') is distinct from 'string' or coalesce(length(att),0) not between 20 and 2000 then
  raise exception 'MU84-L15: a specific preparation attestation is required';
 end if;
 if private.mu7_frozen() or private.mu7_phase() not in ('NOT_SIGNED_OFF','SIGNED_OFF')
   or exists(select 1 from public.mu7_release_specification_v84)
   or exists(select 1 from public.mu7_queue where mode='FORMAL')
   or exists(select 1 from public.mu7_judgments where mode='FORMAL')
   or exists(select 1 from public.mu7_gate_approvals where gate_id=any(gates)) then
  raise exception 'MU84-L16: record specifications once, before target-gate approvals, freeze or formal activity';
 end if;
 select * into receipt from public.mu7_sample_intake_v81;
 select * into profile from public.mu7_reviewer_profile_v81;
 select * into protocol from public.mu7_completion_protocol_v84 where mode='FORMAL';
 select * into probability from public.mu7_probability_binding_v81;
 if receipt.singleton is distinct from true
  or profile.profile_id is distinct from 'mu81-plain-language-r4'
  or profile.rubric_sha256 is distinct from '1eee3cdcae8f9c097a119255cbd410524f2d2ad08a24df3f02de38a1c096c88a'
  or protocol.protocol_id is distinct from 'mu84-finish-and-adjudicate-1'
  or protocol.guide_sha256 is distinct from '03cc9a6617aae436bbbc73c6a8d2b792d3808ecebd6b661133e942df4408595e'
  or protocol.base_profile_sha256 is distinct from profile.binding_sha256
  or (select design_version from public.mu7_design) is distinct from 'review-design-v8.1.0'
  or (select overlap_setting from public.mu7_design) is distinct from 'ONE_PER_TRIAL'
  or probability.binding_sha256 is null
  or probability.binding_sha256 is distinct from receipt.manifest->>'probability_binding_sha256'
  or private.mu81_intake_inventory() is distinct from (receipt.manifest-'queue_sha256'-'probability_binding_sha256') then
  raise exception 'MU84-L17: the verified intake, one-per-trial probability binding and current guides are required';
 end if;
 -- Pin the scope to the actual recorded sample, not a caller's description of it.
 if (select count(*) from public.mu7_units where mode='FORMAL')<>100
  or (select count(distinct nct_id) from public.mu7_unit_design where mode='FORMAL')<>100
  or (select count(*) from public.mu7_units where mode='FORMAL' and family='AREA')<>56
  or (select count(distinct category) from public.mu7_units where mode='FORMAL' and family='AREA')<>10
  or (select count(*) from (select category from public.mu7_units where mode='FORMAL' and family='AREA'
      group by category having count(*)=6) x)<>6
  or (select count(*) from (select category from public.mu7_units where mode='FORMAL' and family='AREA'
      group by category having count(*)=5) x)<>4
  or (select count(*) from public.mu7_units where mode='FORMAL' and family='ROW')<>40
  or (select count(*) from (select category from public.mu7_units where mode='FORMAL' and family='ROW'
      group by category having count(*)=4) x)<>10
  or (select count(*) from public.mu7_units where mode='FORMAL' and family='SG')<>4
  or (select count(distinct category) from public.mu7_units where mode='FORMAL' and family='SG')<>4 then
  raise exception 'MU84-L17: expected 56 area, 40 condition-row and four subgroup mappings on 100 different trials';
 end if;
 if jsonb_typeof(p->'evidence') is distinct from 'array' then
  raise exception 'MU84-L18: exactly eleven checked evidence references and checksums are required';
 end if;
 if jsonb_array_length(p->'evidence')<>11 then
  raise exception 'MU84-L18: exactly eleven checked evidence references and checksums are required';
 end if;
 for e in select value from jsonb_array_elements(p->'evidence') loop
  perform private.mu7_assert_keys(e,array['gate_id','reference','sha256'],'gate evidence');
  if jsonb_typeof(e->'gate_id') is distinct from 'string' or not coalesce(e->>'gate_id'=any(gates),false)
   or jsonb_typeof(e->'reference') is distinct from 'string'
   or coalesce(length(btrim(e->>'reference')),0) not between 8 and 240
   or jsonb_typeof(e->'sha256') is distinct from 'string'
   or coalesce(e->>'sha256','') !~ '^[a-f0-9]{64}$' then
   raise exception 'MU84-L18: each gate needs a checked evidence reference and SHA-256';
  end if;
 end loop;
 if (select count(distinct value->>'gate_id') from jsonb_array_elements(p->'evidence'))<>11 then
  raise exception 'MU84-L18: each required gate must occur exactly once';
 end if;
 select jsonb_agg(value order by value->>'gate_id') into evidence_sorted from jsonb_array_elements(p->'evidence');
 b:=jsonb_build_object('specification_version','mu84-release-specifications-1',
  'intake_payload_sha256',receipt.payload_sha256,'manifest',receipt.manifest,
  'source_import_sha256',receipt.source_import_sha256,'profile_binding_sha256',profile.binding_sha256,
  'protocol_binding_sha256',protocol.binding_sha256,'guide_sha256',protocol.guide_sha256,
  'probability_binding_sha256',probability.binding_sha256);
 h:=private.sha256_hex(jsonb_build_object('bindings',b,'evidence',evidence_sorted)::text);
 insert into public.mu7_release_specification_v84(evidence,bindings,binding_sha256,attestation,recorded_by)
 values(evidence_sorted,b,h,att,me);
 for r in select * from (values
  ('G-ALLOC-01','Approve the recorded allocation: 56 mappings across all ten areas (six areas with six, four with five), four mappings in each of ten condition rows, and four subgroup checks. The checked allocation record and exact prepared sample are bound to this requirement.'),
  ('G-AREA-01','Approve all ten displayed MeSH parent areas without extra narrower definitions for the three broader areas. Apply the guide''s cancer-origin, spread and course policy to additional areas; benign tumors are judged by clinical fit.'),
  ('G-MH-V53','Approve the checked evidence that the Mental-health sampling frame matches the final analysis flags, including the stated Depression exception. The evidence reference must concern this prepared sample and its current frame, not an older draw.'),
  ('G-OQ-03','Approve the same Depression definition for the condition row and Mental-health area: depressive disorder, or symptoms treated, prevented, used for selection or measured as the primary outcome. A secondary outcome, exclusion or safety mention alone is insufficient.'),
  ('G-OQ-04','Approve Mental-health membership for tobacco or nicotine dependence, addiction or a clinically defined substance-use disorder; general cessation, prevention or policy programs do not qualify automatically. Apply the guide consistently to the displayed assignment.'),
  ('G-OVERLAP-01','Approve one mapping per trial for these 100 trials. Retain nominal n/N and the separately bound estimated inclusion probabilities. Initial reporting is descriptive; population analysis, weighting and interval methods require a separate later decision.'),
  ('G-PAIN-01','Approve the four Pain units as broad Pain row-membership checks: any kind or duration of pain studied may qualify. This does not validate the chronic-pain prevalence benchmark or approve a manuscript model. Apply the current guide to this sample.'),
  ('G-PROV-01','Approve the checked historical development, calibration, training and other stated trial-level exclusions for this frame and draw. Technical packet preparation without clinical judgments does not itself exclude a trial. Record reviewer/adjudicator exposure separately; do not infer independence from software checks.'),
  ('G-RUBRIC-01','Approve guide revision 5, its preserved revision-4 clinical definitions and the separate required diabetes stated-type observation. Reviewers may revise until finishing all 100; final sets lock. Any Cannot tell, including both, routes to adjudication with the original flag retained. Subtype observations are not adjudicated.'),
  ('G-TEXT-01','Approve the displayed inclusion/exclusion questions and reasons in the bound guide. Diabetes of unstated type remains unstated, with a separate required three-state observation on the specified units. Neoplasm removals describe cyst, hamartoma or precancerous headings only; clinical disagreement is permitted.'),
  ('G-TEXT-02','Approve Neoplasms membership of any behavior and the kept-neoplasm wording: a heading other than a cyst, hamartoma or precancerous condition, counted in the row. Neither a kept heading nor an Agree answer establishes malignancy. Underlying sorting, packets and counts remain unchanged.')
 ) x(gate_id,question) loop
  select * into latest from public.mu7_gate_requirements where gate_id=r.gate_id order by requirement_version desc limit 1;
  if not found or latest.requirement_status<>'PENDING_SPECIFICATION' then
   raise exception 'MU84-L19: every target must still have its pending requirement; no specification is replaced';
  end if;
  insert into public.mu7_gate_requirements(gate_id,requirement_version,blocks,requirement_status,question,decision_reference,source)
  values(r.gate_id,latest.requirement_version+1,latest.blocks,'SPECIFIED',r.question,
   'mu84-release-specifications-1; '||r.gate_id||'; binding SHA-256 '||h,
   'Reviewed migration 0043; investigator-supplied checked evidence and bound guide. Specification only; approval remains separate.');
 end loop;
 insert into public.audit_log(actor_user_id,actor_role,action,entity_table,entity_id,mode,details)
 values(me,'INVESTIGATOR','INSERT','mu7_release_specification_v84','release-specifications','FORMAL',
  jsonb_build_object('binding_sha256',h,'requirements',11,'approvals_recorded',0));
 return jsonb_build_object('specified',11,'approvals_recorded',0,'binding_sha256',h);
end $$;
revoke all on function public.rpc_mu84_record_release_specifications(text,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.rpc_mu84_record_release_specifications(text,jsonb) to authenticated;
commit;
