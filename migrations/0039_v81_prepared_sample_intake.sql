-- Atomic preparation of a checked 100-mapping candidate. No approval, freeze,
-- reviewer enrolment, queue assignment, phase event or clinical answer is created.
begin;
insert into public.app_schema_version(version, description) values
 ('8.1.4-prepared-sample-intake', 'Atomic investigator-only intake with immutable receipt and safe retry');

create table public.mu7_sample_intake_v81 (
 singleton boolean primary key default true check(singleton),
 payload_sha256 text not null check(payload_sha256 ~ '^[a-f0-9]{64}$'),
 source_import_sha256 text not null check(source_import_sha256 ~ '^[a-f0-9]{64}$'),
 prepared_by_build text not null check(prepared_by_build ~ '^[a-f0-9]{40}$'),
 manifest jsonb not null,
 attestation text not null check(length(btrim(attestation)) between 20 and 2000),
 recorded_by uuid not null references public.users(user_id),
 recorded_at timestamptz not null default now()
);
alter table public.mu7_sample_intake_v81 enable row level security;
revoke all on public.mu7_sample_intake_v81 from public, anon, authenticated, service_role;
create trigger mu81_intake_immutable before update or delete on public.mu7_sample_intake_v81
 for each row execute function private.reject_mutation();
create trigger mu81_intake_no_truncate before truncate on public.mu7_sample_intake_v81
 for each statement execute function private.reject_mutation();

-- Recheck actual formal content on a retry, even if another import path was used later.
create function private.mu81_intake_inventory() returns jsonb
language sql stable security definer set search_path = '' as $$
 select jsonb_build_object(
   'unit_list_sha256', (select private.sha256_hex(string_agg(unit_id,E'\n' order by unit_id collate "C")) from public.mu7_units where mode='FORMAL'),
   'assignment_set_sha256', (select private.sha256_hex(string_agg(a.row_sha256,E'\n' order by a.unit_id collate "C")) from public.mu7_frozen_assignments a join public.mu7_units u using(unit_id) where u.mode='FORMAL'),
   'design_rows_sha256', (select private.sha256_hex(string_agg(design_row_sha256,E'\n' order by unit_id collate "C")) from public.mu7_unit_design where mode='FORMAL'),
   'packet_inventory_sha256', (select private.sha256_hex(string_agg(unit_id||'|'||packet_sha256,E'\n' order by unit_id collate "C")) from public.mu7_units where mode='FORMAL')
 )
$$;
revoke all on function private.mu81_intake_inventory() from public, anon, authenticated, service_role;

create function public.rpc_mu81_intake_status() returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
 perform private.assert_investigator();
 return jsonb_build_object('state', case
   when exists(select 1 from public.mu7_freeze) or exists(select 1 from public.mu7_phase_events where event_type='FORMAL_OPEN') then 'CLOSED'
   when exists(select 1 from public.mu7_sample_intake_v81) then 'RECORDED'
   when exists(select 1 from public.mu7_design) or exists(select 1 from public.mu7_units)
     or exists(select 1 from public.mu7_training_units) then 'OCCUPIED'
   else 'EMPTY' end);
end $$;

create function public.rpc_mu81_stage_sample(p jsonb, p_attestation text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare me uuid; x jsonb; m jsonb; h text; b text; prior text;
begin
 perform private.assert_investigator();
 if current_setting('transaction_isolation') <> 'read committed' then
   raise exception 'MU81-I01: READ COMMITTED required';
 end if;
 perform pg_catalog.pg_advisory_xact_lock(7024025);
 me := private.assert_investigator(); -- re-check after waiting, including MFA and account lock
 if length(btrim(coalesce(p_attestation,''))) not between 20 and 2000 then
   raise exception 'MU81-I02: explicit preparation attestation required';
 end if;
 perform private.mu7_assert_keys(p, array['format','prepared_by_build','source_import_sha256',
   'design','reviewer_profile','units','queue','expected','probability_binding'], 'sample intake');
 if p->>'format' is distinct from 'civicsample-formal-intake-1.0'
   or coalesce(p->>'prepared_by_build','') !~ '^[a-f0-9]{40}$'
   or coalesce(p->>'source_import_sha256','') !~ '^[a-f0-9]{64}$' then
   raise exception 'MU81-I02: unsupported prepared sample';
 end if;
 h := private.sha256_hex(p::text);
 if exists(select 1 from public.mu7_freeze) or exists(select 1 from public.mu7_phase_events where event_type='FORMAL_OPEN') then
   raise exception 'MU81-I03: the formal lifecycle has advanced beyond preparation';
 end if;
 select payload_sha256 into prior from public.mu7_sample_intake_v81;
 if prior is not null then
   if prior <> h then raise exception 'MU81-I03: a different prepared sample is already recorded'; end if;
   if private.mu81_intake_inventory() is distinct from
     ((p->'expected') - 'queue_sha256' - 'probability_binding_sha256') then
     raise exception 'MU81-I04: recorded inventory no longer matches the prepared sample';
   end if;
   return jsonb_build_object('state','ALREADY_RECORDED','mappings',100,'queue_positions_checked',200);
 end if;
 -- A new workspace only. Never replace the existing synthetic practice design or its records.
 if exists(select 1 from public.mu7_design) or exists(select 1 from public.mu7_units)
   or exists(select 1 from public.mu7_training_units) or exists(select 1 from public.mu7_queue)
   or exists(select 1 from public.mu7_gate_approvals) or exists(select 1 from public.mu7_phase_events)
   or exists(select 1 from public.mu7_freeze) or exists(select 1 from public.mu7_judgments)
   or exists(select 1 from public.mu7_adjudications) or exists(select 1 from public.mu7_snapshot)
   or exists(select 1 from public.mu7_reference_locks) or exists(select 1 from public.mu7_exports) then
   raise exception 'MU81-I03: intake requires a new empty review workspace';
 end if;
 perform private.mu7_assert_keys(p->'design',array['design_version','assignment_set_id','overlap_setting',
   'n_primary_planned','n_subgroup_planned'],'intake design');
 if p#>>'{design,design_version}' is distinct from 'review-design-v8.1.0'
   or p#>>'{design,n_primary_planned}' is distinct from '96'
   or p#>>'{design,n_subgroup_planned}' is distinct from '4'
   or coalesce(p#>>'{design,overlap_setting}','') not in ('ALLOW','ONE_PER_TRIAL') then
   raise exception 'MU81-I02: expected the reviewed 100-mapping design';
 end if;
 if jsonb_typeof(p->'units') is distinct from 'array' or jsonb_typeof(p->'queue') is distinct from 'array' then
   raise exception 'MU81-I02: complete units and queue required';
 end if;
 if jsonb_array_length(p->'units') <> 100 or jsonb_array_length(p->'queue') <> 200 then
   raise exception 'MU81-I02: exactly 100 mappings and 200 planned positions required';
 end if;
 if (select count(*) from jsonb_array_elements(p->'units') u where u->>'family'='AREA') <> 56
   or (select count(*) from jsonb_array_elements(p->'units') u where u->>'family'='ROW') <> 40
   or (select count(*) from jsonb_array_elements(p->'units') u where u->>'family'='SG') <> 4
   or exists(select 1 from jsonb_array_elements(p->'units') u where u->>'mode' is distinct from 'FORMAL') then
   raise exception 'MU81-I02: candidate must contain 56 area, 40 condition and four subgroup mappings';
 end if;
 perform public.rpc_mu7_record_design((p->'design') || jsonb_build_object('attestation',btrim(p_attestation)));
 perform private.mu7_assert_keys(p->'reviewer_profile',array['profile_id','rubric_sha256'],'intake profile');
 perform public.rpc_mu81_bind_reviewer_profile((p->'reviewer_profile') || jsonb_build_object('attestation',btrim(p_attestation)));
 for x in select value from jsonb_array_elements(p->'units') loop
   perform public.rpc_mu7_import_unit(x); -- retain every existing packet, provenance and n/N guard
 end loop;
 if p#>>'{design,overlap_setting}'='ONE_PER_TRIAL' and
   (select count(distinct nct_id) from public.mu7_unit_design where mode='FORMAL') <> 100 then
   raise exception 'MU81-I04: ONE_PER_TRIAL requires 100 different trials';
 end if;
 -- Compare the actual PostgreSQL hashes, not the source's Python/JSON packet encoding.
 m := private.mu81_intake_inventory();
 for x in select value from jsonb_array_elements(p->'queue') loop
   perform private.mu7_assert_keys(x,array['reviewer_slot','queue_position','unit_id'],'intake queue');
   if coalesce(x->>'reviewer_slot','') not in ('1','2')
     or coalesce(x->>'queue_position','') !~ '^([1-9]|[1-9][0-9]|100)$'
     or not exists(select 1 from public.mu7_units u where u.unit_id=x->>'unit_id') then
     raise exception 'MU81-I04: invalid planned queue';
   end if;
 end loop;
 if exists(select 1 from jsonb_array_elements(p->'queue') q group by q->>'reviewer_slot'
    having count(*)<>100 or count(distinct q->>'unit_id')<>100 or count(distinct q->>'queue_position')<>100) then
   raise exception 'MU81-I04: each reviewer must have the same 100 mappings once';
 end if;
 select private.sha256_hex(string_agg(concat_ws('|',q->>'reviewer_slot',q->>'queue_position',q->>'unit_id'),
   E'\n' order by (q->>'reviewer_slot')::integer,(q->>'queue_position')::integer)) into h
   from jsonb_array_elements(p->'queue') q;
 m := m || jsonb_build_object('queue_sha256',h);
 if p#>>'{design,overlap_setting}'='ONE_PER_TRIAL' then
   b := public.rpc_mu81_bind_probabilities(p->'probability_binding');
 elsif p->'probability_binding' is distinct from 'null'::jsonb then
   raise exception 'MU81-I04: ALLOW has no Monte Carlo binding';
 end if;
 m := m || jsonb_build_object('probability_binding_sha256',b);
 if m is distinct from p->'expected' then
   raise exception 'MU81-I04: prepared and database inventories differ';
 end if;
 insert into public.mu7_sample_intake_v81(payload_sha256,source_import_sha256,prepared_by_build,manifest,attestation,recorded_by)
 values(private.sha256_hex(p::text),p->>'source_import_sha256',p->>'prepared_by_build',m,btrim(p_attestation),me);
 insert into public.audit_log(actor_user_id,actor_role,action,entity_table,entity_id,details)
 values(me,'INVESTIGATOR','INSERT','mu7_sample_intake_v81','prepared-sample',
   jsonb_build_object('payload_sha256',private.sha256_hex(p::text),'mappings',100));
 return jsonb_build_object('state','RECORDED','mappings',100,'queue_positions_checked',200);
end $$;
revoke all on function public.rpc_mu81_intake_status(), public.rpc_mu81_stage_sample(jsonb,text)
 from public, anon, authenticated, service_role;
grant execute on function public.rpc_mu81_intake_status(), public.rpc_mu81_stage_sample(jsonb,text) to authenticated;
commit;
