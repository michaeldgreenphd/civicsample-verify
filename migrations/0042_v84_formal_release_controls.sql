-- Investigator-only, explicit lifecycle actions over the existing scientific guards.
-- This installs controls; it records no approval, assignment, freeze or phase event.
begin;
insert into public.app_schema_version(version, description) values
 ('8.4.2-formal-release-controls', 'Plan-bound investigator controls for the prepared formal review');

create function private.mu84_release_state() returns jsonb
language sql stable security definer set search_path='' as $$
 select jsonb_build_object(
  'prepared',exists(select 1 from public.mu7_sample_intake_v81),
  'phase',private.mu7_phase(),
  'formal_units',(select count(*) from public.mu7_units where mode='FORMAL'),
  'training_units',(select count(*) from public.mu7_training_units),
  'pilot_locked',private.mu7_locked('PILOT'),
  'pilot_exports',coalesce((select jsonb_agg(jsonb_build_object('id',export_id,'manifest',manifest_sha256) order by created_at,export_id)
    from public.mu7_exports where mode='PILOT'),'[]'::jsonb),
  'protocol_bound',private.mu84_active('FORMAL'),
  'descriptive_plan_recorded',coalesce((select decision_reference = 'mu84-descriptive-agreement-1; SHA-256 86f4484fded816889147c8f608d2b9b5ad266cb60bd4e23cd1e7fe02d7c5436b'
    from public.mu7_gate_requirements where gate_id='G-EST-01' order by requirement_version desc limit 1),false),
  'frozen',private.mu7_frozen(),
  'assignments',(select count(*) from public.mu7_queue where mode='FORMAL'),
  'completion',coalesce((select jsonb_agg(to_jsonb(t) order by reviewer_slot) from (
    select q.reviewer_slot,count(*)::integer as assigned,
     count(*) filter(where exists(select 1 from public.mu7_judgments j where j.assignment_id=q.assignment_id))::integer as answered,
     exists(select 1 from public.mu7_review_completions_v84 c where c.mode='FORMAL' and c.reviewer_slot=q.reviewer_slot) as finished
    from public.mu7_queue q where q.mode='FORMAL' group by q.reviewer_slot
  ) t),'[]'::jsonb),
  'snapshot_recorded',exists(select 1 from public.mu7_snapshot),
  'reference_locked',private.mu7_locked('FORMAL'),
  'formal_exports',(select count(*) from public.mu7_exports where mode='FORMAL'),
  'freeze_blockers',private.mu7x_unsatisfied_gates('FREEZE'),
  'opening_blockers',private.mu7x_unsatisfied_gates('FORMAL_OPEN'),
  'gate_versions',(select jsonb_agg(to_jsonb(g) order by gate_id) from public.rpc_mu7_gate_status() g),
  'reviewers',coalesce((select jsonb_agg(jsonb_build_object('id',user_id,'label',display_name) order by display_name,user_id)
    from public.users where role='REVIEWER' and is_active and not is_pilot_test_account
      and not private.account_locked(user_id)),'[]'::jsonb),
  'intake_manifest',(select manifest from public.mu7_sample_intake_v81)
 )
$$;
revoke all on function private.mu84_release_state() from public,anon,authenticated,service_role;

create function public.rpc_mu84_release_status() returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare s jsonb;
begin
 perform private.assert_investigator();
 s:=private.mu84_release_state();
 return (s-'intake_manifest'-'gate_versions')||jsonb_build_object('state_sha256',private.sha256_hex(s::text));
end $$;

create function public.rpc_mu84_release_action(p_action text,p_state_sha256 text,p jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare s jsonb; m jsonb; me uuid; att text; u uuid; pid text; slots jsonb:='[]'::jsonb; i integer;
begin
 perform private.assert_investigator();
 if current_setting('transaction_isolation')<>'read committed' then
  raise exception 'MU84-L01: READ COMMITTED required';
 end if;
 perform pg_catalog.pg_advisory_xact_lock(7024025);
 me:=private.assert_investigator();
 s:=private.mu84_release_state();
 if p_state_sha256 is distinct from private.sha256_hex(s::text) then
  raise exception 'MU84-L02: review status changed; refresh the plan before confirming';
 end if;
 att:=btrim(p->>'attestation');
 if coalesce(length(att),0) not between 20 and 2000 then
  raise exception 'MU84-L03: a specific investigator attestation is required';
 end if;
 if not (s->>'prepared')::boolean then
  raise exception 'MU84-L04: a verified preparation receipt is required';
 end if;
 m:=s->'intake_manifest';
 if private.mu81_intake_inventory() is distinct from (m-'queue_sha256'-'probability_binding_sha256') then
  raise exception 'MU84-L05: current packets and provenance differ from the preparation receipt';
 end if;
 if p_action='record-descriptive-plan' then
  perform private.mu7_assert_keys(p,array['attestation'],'release action');
  if private.mu7_frozen() or private.mu7_phase() not in ('NOT_SIGNED_OFF','SIGNED_OFF')
    or (s->>'descriptive_plan_recorded')::boolean then
   raise exception 'MU84-L12: record the reporting scope once, before the freeze and opening';
  end if;
  insert into public.mu7_gate_requirements(gate_id,requirement_version,blocks,requirement_status,question,decision_reference,source)
  select 'G-EST-01',max(requirement_version)+1,array['FREEZE','FORMAL_OPEN'],'SPECIFIED',
   'Approve descriptive sample counts and agreement, with area and condition-row results separate. Population estimates, weights and confidence intervals are deferred; provenance is retained.',
   'mu84-descriptive-agreement-1; SHA-256 86f4484fded816889147c8f608d2b9b5ad266cb60bd4e23cd1e7fe02d7c5436b',
   'Investigator scope instruction of 2026-10-27; docs/DESCRIPTIVE_REVIEW_PLAN.md. Recording this specification approves no gate.'
  from public.mu7_gate_requirements where gate_id='G-EST-01';
 elsif p_action='bind-completion' then
  perform private.mu7_assert_keys(p,array['attestation'],'release action');
  perform public.rpc_mu84_bind_protocol(jsonb_build_object('mode','FORMAL',
   'protocol_id','mu84-finish-and-adjudicate-1',
   'guide_sha256','03cc9a6617aae436bbbc73c6a8d2b792d3808ecebd6b661133e942df4408595e','attestation',att));
 elsif p_action='accept-pilot' then
  perform private.mu7_assert_keys(p,array['attestation','pilot_export_id','checklist_version','checklist_sha256','app_git_sha'],'release action');
  perform public.rpc_mu7_phase('PILOT_SIGNED_OFF',p);
 elsif p_action='freeze-sample' then
  perform private.mu7_assert_keys(p,array['attestation'],'release action');
  if not private.mu84_active('FORMAL') or not (s->>'descriptive_plan_recorded')::boolean
    or (s->>'formal_units')::integer<>100 or (s->>'training_units')::integer<>3 then
   raise exception 'MU84-L06: record the final-submission protocol, reporting scope, 100 mappings and three separate training examples first';
  end if;
  perform public.rpc_mu7_freeze((m-'packet_inventory_sha256'-'probability_binding_sha256')||jsonb_build_object('attestation',att));
 elsif p_action='assign-reviewers' then
  perform private.mu7_assert_keys(p,array['attestation','reviewer_ids','qualifications','queue'],'release action');
  if not private.mu7_frozen() or private.mu7_phase()<>'SIGNED_OFF'
    or (s->>'assignments')::integer<>0 then
   raise exception 'MU84-L07: assign the two reviewers after sign-off and freeze, before opening';
  end if;
  if jsonb_typeof(p->'reviewer_ids') is distinct from 'array' or jsonb_array_length(p->'reviewer_ids')<>2
    or (p#>>'{reviewer_ids,0}') is not distinct from (p#>>'{reviewer_ids,1}')
    or jsonb_typeof(p->'qualifications') is distinct from 'array' or jsonb_array_length(p->'qualifications')<>2
    or jsonb_typeof(p->'queue') is distinct from 'array' or jsonb_array_length(p->'queue')<>200 then
   raise exception 'MU84-L08: two distinct qualified reviewers and the complete prepared queue are required';
  end if;
  for i in 0..1 loop
   u:=(p->'reviewer_ids'->>i)::uuid;
   if not exists(select 1 from public.users where user_id=u and role='REVIEWER' and is_active
        and not is_pilot_test_account and not private.account_locked(user_id))
     or coalesce(length(btrim(p->'qualifications'->>i)),0) not between 20 and 2000 then
    raise exception 'MU84-L08: each slot needs an active clinical reviewer and recorded qualifications';
   end if;
   select reviewer_pseudo_id into pid from public.reviewers where user_id=u and mode_scope='FORMAL' and withdrawn_at is null;
   if pid is null then pid:=public.rpc_mu7_enroll_reviewer(u,p->'qualifications'->>i); end if;
   slots:=slots||jsonb_build_array(jsonb_build_object('reviewer_slot',i+1,'reviewer_pseudo_id',pid,
    'unit_ids',(select jsonb_agg(q->>'unit_id' order by (q->>'queue_position')::integer)
       from jsonb_array_elements(p->'queue') q where q->>'reviewer_slot'=(i+1)::text)));
  end loop;
  -- The existing RPC verifies both complete queues and the frozen queue checksum atomically.
  perform public.rpc_mu7_assign_queue('FORMAL',jsonb_build_object('slots',slots));
 elsif p_action='open-review' then
  perform private.mu7_assert_keys(p,array['attestation'],'release action');
  if not private.mu84_active('FORMAL') or not (s->>'descriptive_plan_recorded')::boolean or (s->>'formal_units')::integer<>100
    or (s->>'assignments')::integer<>200 or (s->>'training_units')::integer<>3 then
   raise exception 'MU84-L09: the reviewed protocol, 100 mappings, 200 assignments and three training examples are required';
  end if;
  perform public.rpc_mu7_phase('FORMAL_OPENED',jsonb_build_object('attestation',att));
 elsif p_action='close-review' then
  perform private.mu7_assert_keys(p,array['attestation'],'release action');
  if not private.mu84_both_finished('FORMAL') then
   raise exception 'MU84-L10: both reviewers must finish and lock their 100 answers before closing';
  end if;
  perform public.rpc_mu7_phase('FORMAL_CLOSED_COMPLETE',jsonb_build_object('attestation',att));
  perform public.rpc_mu7_snapshot();
 elsif p_action='lock-reference' then
  perform private.mu7_assert_keys(p,array['attestation'],'release action');
  perform public.rpc_mu7_lock_reference('FORMAL',att);
 else
  raise exception 'MU84-L11: unsupported release action';
 end if;
 insert into public.audit_log(actor_user_id,actor_role,action,entity_table,entity_id,mode,details)
 values(me,'INVESTIGATOR','RELEASE_ACTION','mu7_design','formal-release','FORMAL',
  jsonb_build_object('action',p_action,'attestation',att));
 return public.rpc_mu84_release_status();
end $$;
revoke all on function public.rpc_mu84_release_status(),public.rpc_mu84_release_action(text,text,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.rpc_mu84_release_status(),public.rpc_mu84_release_action(text,text,jsonb) to authenticated;
commit;
