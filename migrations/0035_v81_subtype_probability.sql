-- Addendum 1 engineering choices: separate subtype observation and probability binding.
-- Opt-in via a NEW v8.1 design; existing v7/v8.0 records and MU7-G20 are unchanged.
-- No clinical policy, estimator, sample or gate is approved by this migration.
begin;
insert into public.app_schema_version(version, description)
values ('8.1.0-subtype-probability', 'Versioned subtype observations and frozen probability provenance; no study approval');
create function private.mu81_active() returns boolean
language sql stable security definer set search_path = '' as $$
 select coalesce((select design_version = 'review-design-v8.1.0' or design_version like 'SYN-8-1-%' from public.mu7_design), false)
$$;
revoke all on function private.mu81_active() from public, anon, authenticated, service_role;
-- A design that was recorded without these guards cannot silently acquire new semantics.
do $$ begin
 if private.mu81_active() then raise exception 'MU81-G01: existing v8.1 design needs explicit reconciliation'; end if;
end $$;
create or replace function private.mu8_record_pending_requirements() returns trigger
language plpgsql security definer set search_path = '' as $$
declare r record;
begin
  if new.design_version not like 'review-design-v8%' and new.design_version not like 'SYN-8-%' then
    return new;
  end if;
  if new.design_version not in ('review-design-v8.0.0', 'review-design-v8.1.0') and new.design_version not like 'SYN-8-%' then
    raise exception 'MU8-G02: unsupported v8 design version';
  end if;
  if new.design_version in ('review-design-v8.0.0', 'review-design-v8.1.0')
     and (new.n_primary_planned <> 96 or new.n_subgroup_planned <> 4) then
    raise exception 'MU8-G02: design v8 plans 96 primary and 4 subgroup mappings';
  end if;
  -- Append versions, never mutate previous requirements. Earlier approvals cannot carry
  -- forward to new units, frame checks, rubric policies or statistical specifications.
  for r in select * from (values
    ('G-ALLOC-01', array['FREEZE'], 'Choose and record the allocation rule across ten areas.'),
    ('G-AREA-01', array['FREEZE'], 'Approve reviewer definitions and neoplasm-policy scope for the three added areas.'),
    ('G-TEXT-02', array['FREEZE'], 'Resolve the kept Rule K display wording; current wording remains unchanged until approved.'),
    ('G-RUBRIC-01', array['FREEZE'], 'Approve and bind the complete v8 rubric and its amendments.'),
    ('G-PROV-04', array[]::text[], 'Manuscript-named trial exposure: information-only default; no gate approval implied.'),
    ('G-PAIN-01', array['FORMAL_OPEN'], 'Confirm the Pain row-membership policy for the selected v8 Pain units; benchmark validation is outside scope.'),
    ('G-MH-V53', array['FREEZE', 'FORMAL_OPEN'], 'Approve evidence that the v8 Mental health frame matches the current analysis flags.'),
    ('G-OVERLAP-01', array['FREEZE', 'FORMAL_OPEN'], 'Select one v8 overlap alternative and its probability and variance specification.'),
    ('G-PROV-01', array['FREEZE', 'FORMAL_OPEN'], 'Confirm trial-level provenance exclusions for the selected v8 frame and draw.'),
    ('G-TEXT-01', array['FREEZE', 'FORMAL_OPEN'], 'Approve removed subgroup display texts and reason codes for v8.'),
    ('G-OQ-03', array['FREEZE', 'FORMAL_OPEN'], 'Specify and approve the v8 Depression clinical-review policy.'),
    ('G-OQ-04', array['FREEZE', 'FORMAL_OPEN'], 'Specify and approve the v8 smoking-cessation clinical-review policy.'),
    ('G-EST-01', array['FREEZE', 'FORMAL_OPEN'], 'Approve the v8 estimator, indeterminate outcomes, clustering and probability provenance.')
  ) as x(gate_id, blocks, question) loop
    insert into public.mu7_gate_requirements(gate_id, requirement_version, blocks, requirement_status, question, source)
    select r.gate_id, coalesce(max(g.requirement_version), 0) + 1, r.blocks,
           'PENDING_SPECIFICATION', r.question, 'review design v8 pending decisions; scope: ' || new.design_version
    from public.mu7_gate_requirements g where g.gate_id = r.gate_id;
  end loop;
  return new;
end $$;
create or replace function private.mu8_new_area_scope() returns trigger
language plpgsql security definer set search_path = '' as $$
declare dv text;
begin
  if new.packet -> 'unit' ->> 'family' = 'AREA'
     and new.packet -> 'unit' ->> 'category' in ('PATHOLOGICAL', 'IMMUNE', 'UROGENITAL') then
    select design_version into dv from public.mu7_design;
    if dv is null or (dv not in ('review-design-v8.0.0', 'review-design-v8.1.0') and dv not like 'SYN-8-%') then
      raise exception 'MU8-G03: added areas require a separate v8 design database';
    end if;
  end if;
  return new;
end $$;

alter table public.mu7_judgments add column diabetes_subtype text
 check (diabetes_subtype in ('TYPE_2_STATED','TYPE_2_NOT_STATED','CANNOT_TELL_FROM_PACKET'));
create function private.mu81_subtype_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare needed boolean;
begin
 select private.mu81_active() and u.assignment_code in ('D4A_KEEP_UNRESOLVED_PARENT_ONLY','D4B_KEEP_UNRESOLVED_COMPLICATION_ONLY')
 into needed from public.mu7_units u where u.unit_id = new.unit_id;
 if coalesce(needed,false) <> (new.diabetes_subtype is not null) then
   raise exception 'MU81-G02: the subtype observation is required only for v8.1 D4A/D4B judgments';
 end if;
 if needed and new.reason_code = 'TYPE_2_STATED' then
   raise exception 'MU81-G03: record stated type in the separate subtype observation';
 end if;
 if private.mu81_active() then
   new.content_sha256 := private.sha256_hex(concat_ws('|','mu81-judgment-1',new.content_sha256,coalesce(new.diabetes_subtype,'')));
 end if;
 return new;
end $$;
-- Alphabetically after the original guard computes the revision and content hash.
create trigger z40_mu81_subtype before insert on public.mu7_judgments
 for each row execute function private.mu81_subtype_guard();
revoke all on function private.mu81_subtype_guard() from public, anon, authenticated, service_role;
create or replace function public.rpc_mu7_submit(p_assignment_id uuid, p jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  q record;
  jid uuid;
begin
  select * into q from public.mu7_queue x where x.assignment_id = p_assignment_id;
  -- GUARD MU7-G57 BEGIN
  if q.assignment_id is null or q.reviewer_pseudo_id is distinct from private.my_reviewer_pseudo_id() then
    raise exception 'MU7-G57: this assignment is not yours' using errcode = '42501';
  end if;
  -- GUARD MU7-G57 END
  perform private.mu7_assert_keys(p, array['answer', 'reason_code', 'note', 'uncertain', 'seconds_on_unit', 'diabetes_subtype'], 'rpc_mu7_submit');
  insert into public.mu7_judgments (assignment_id, unit_id, mode, reviewer_pseudo_id, reviewer_slot, revision_number, answer,
                                    reason_code, note, uncertain, seconds_on_unit, content_sha256, diabetes_subtype)
  values (q.assignment_id, q.unit_id, q.mode, q.reviewer_pseudo_id, q.reviewer_slot, 1, p ->> 'answer', p ->> 'reason_code',
          p ->> 'note', coalesce((p ->> 'uncertain')::boolean, false), (p ->> 'seconds_on_unit')::integer, repeat('0', 64), p ->> 'diabetes_subtype')
  returning judgment_id into jid;
  return jid;
end $$;

create or replace function public.rpc_mu7_get_unit(p_assignment_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  q record;
  u record;
begin
  select * into q from public.mu7_queue x where x.assignment_id = p_assignment_id;
  -- GUARD MU7-G54 BEGIN
  if q.assignment_id is null or q.reviewer_pseudo_id is distinct from private.my_reviewer_pseudo_id() then
    raise exception 'MU7-G54: this assignment is not yours' using errcode = '42501';
  end if;
  -- GUARD MU7-G54 END
  -- GUARD MU7-G55 BEGIN
  if q.mode = 'FORMAL' and private.mu7_phase() not in ('OPEN', 'CLOSED_COMPLETE', 'CLOSED_INCOMPLETE') then
    raise exception 'MU7-G55: FORMAL units open with the formal phase';
  end if;
  -- GUARD MU7-G55 END
  select * into u from public.mu7_units x where x.unit_id = q.unit_id;
  -- GUARD MU7-G56 BEGIN
  if u.unit_role = 'SUBGROUP' and not private.mu7_primary_done(q.reviewer_pseudo_id, q.mode) then
    raise exception 'MU7-G56: subgroup units open after every primary unit of your queue is answered';
  end if;
  -- GUARD MU7-G56 END
  return jsonb_build_object('assignment_id', q.assignment_id, 'mode', q.mode, 'queue_position', q.queue_position,
                            'unit_role', u.unit_role, 'packet', u.packet, 'subtype_required', private.mu81_active() and u.assignment_code in ('D4A_KEEP_UNRESOLVED_PARENT_ONLY', 'D4B_KEEP_UNRESOLVED_COMPLICATION_ONLY'));
end $$;


-- Separate export view: historical bundle 7.0 and membership routing remain unchanged.
create view public.v_mu81_subtypes with (security_invoker = true) as
select j.unit_id, j.mode, j.reviewer_slot, j.revision_number, j.answer, j.diabetes_subtype,
       j.content_sha256
from public.mu7_judgments j
where private.is_investigator() and private.mu7_can_read_judgments(j.mode);
revoke all on public.v_mu81_subtypes from public, anon, authenticated, service_role;
grant select on public.v_mu81_subtypes to authenticated;

-- One immutable probability artifact per design. No application role can write it directly.
-- Bind the unchanged source CSV bytes separately from canonical rows. Canonical decimal strings
-- have no exponent or insignificant trailing zero. Numeric conversion is exact, without rounding.
create table public.mu7_probability_binding_v81 (
 singleton boolean primary key default true check(singleton),
 binding_version text not null check(binding_version = 'mu81-probability-1'),
 design_version text not null,
 method text not null check(method = 'MONTE_CARLO_ONE_PER_TRIAL'),
 replicates integer not null check(replicates > 1),
 seed bigint not null,
 source_csv text not null,
 canonical_csv text not null,
 file_sha256 text not null check(file_sha256 ~ '^[0-9a-f]{64}$'),
 rows_sha256 text not null check(rows_sha256 ~ '^[0-9a-f]{64}$'),
 binding_sha256 text not null check(binding_sha256 ~ '^[0-9a-f]{64}$'),
 recorded_by uuid not null references public.users(user_id),
 recorded_at timestamptz not null default now()
);
alter table public.mu7_probability_binding_v81 enable row level security;
revoke all on public.mu7_probability_binding_v81 from public, anon, authenticated, service_role;
grant select on public.mu7_probability_binding_v81 to authenticated;
create policy mu81_probability_read on public.mu7_probability_binding_v81 for select to authenticated
 using (private.is_investigator());
create trigger mu81_probability_append_only before update or delete on public.mu7_probability_binding_v81
 for each row execute function private.reject_mutation();
create trigger mu81_probability_no_truncate before truncate on public.mu7_probability_binding_v81
 for each statement execute function private.reject_mutation();

create function public.rpc_mu81_bind_probabilities(p jsonb) returns text
language plpgsql security definer set search_path = '' as $$
declare me uuid := private.assert_investigator(); d record; x jsonb; body text := ''; csv text;
        uid text; prev text := ''; pi text; se text; n integer := 0; expected integer; digest text;
        source_rows text[]; line text; cols text[]; source_ids text[] := array[]::text[]; source_row jsonb;
begin
 perform pg_catalog.pg_advisory_xact_lock(7024025);
 if current_setting('transaction_isolation') <> 'read committed' then
   raise exception 'MU81-G04: READ COMMITTED required';
 end if;
 select * into d from public.mu7_design;
 if not private.mu81_active() or d.overlap_setting <> 'ONE_PER_TRIAL' then
   raise exception 'MU81-G04: binding requires a v8.1 ONE_PER_TRIAL design';
 end if;
 if exists(select 1 from public.mu7_freeze) then raise exception 'MU81-G04: already frozen'; end if;
 perform private.mu7_assert_keys(p, array['binding_version','method','replicates','seed','source_csv','file_sha256','rows_sha256','rows'], 'probability binding');
 if (p->>'binding_version') is distinct from 'mu81-probability-1'
    or (p->>'method') is distinct from 'MONTE_CARLO_ONE_PER_TRIAL'
    or coalesce(p->>'replicates','') !~ '^[1-9][0-9]{0,8}$'
    or coalesce(p->>'seed','') !~ '^(0|[1-9][0-9]{0,14})$'
    or coalesce(jsonb_typeof(p->'rows'),'') <> 'array' then
   raise exception 'MU81-G05: invalid probability binding metadata';
 end if;
 for x in select value from jsonb_array_elements(p->'rows') loop
   perform private.mu7_assert_keys(x,array['unit_id','pi_i','mc_standard_error'],'probability row');
   uid := x->>'unit_id'; pi := x->>'pi_i'; se := x->>'mc_standard_error';
   if coalesce(uid,'') !~ '^MU7-(AREA|ROW|SG)-[A-Z0-9_]{2,40}-[0-9]{3}$'
      or uid collate "C" <= prev collate "C"
      or coalesce(pi,'') !~ '^(0|1|0\.[0-9]{0,29}[1-9])$'
      or coalesce(se,'') !~ '^(0|1|0\.[0-9]{0,29}[1-9])$' then
     raise exception 'MU81-G05: rows must be unique, sorted and use canonical decimal strings';
   end if;
   if pi::numeric <= 0 or pi::numeric > 1 or se::numeric > 1 then
     raise exception 'MU81-G05: probability or Monte Carlo error outside range';
   end if;
   if not exists(select 1 from public.mu7_unit_design ud where ud.unit_id=uid and ud.mode='FORMAL'
                 and ud.sampling_seed=(p->>'seed')::bigint) then
     raise exception 'MU81-G05: unknown unit or mismatched sampling seed';
   end if;
   body := body || uid || ',' || pi || ',' || se || E'\n'; prev := uid; n := n+1;
 end loop;
 select count(*) into expected from public.mu7_units where mode='FORMAL';
 if n=0 or n<>expected or n<>d.n_primary_planned+d.n_subgroup_planned then
   raise exception 'MU81-G05: bind exactly the complete planned FORMAL inventory';
 end if;
 csv := E'unit_id,pi_i,mc_standard_error\n' || body;
 if (p->>'file_sha256') is distinct from private.sha256_hex(p->>'source_csv')
    or (p->>'rows_sha256') is distinct from private.sha256_hex(body) then
   raise exception 'MU81-G06: probability file or row digest mismatch';
 end if;
 -- Preserve and verify the original ten-column probability file, not a reconstructed copy.
 -- This deliberately accepts only its simple LF-delimited unquoted contract.
 if coalesce(p->>'source_csv','') = '' or right(p->>'source_csv',1) <> E'\n'
    or position(E'\r' in p->>'source_csv') > 0 or position('"' in p->>'source_csv') > 0 then
   raise exception 'MU81-G06: unsupported source CSV serialization';
 end if;
 source_rows := string_to_array(left(p->>'source_csv',length(p->>'source_csv')-1), E'\n');
 if source_rows[1] <> 'unit_id,stratum,N_h,n_h,nominal_probability_n_h_over_N_h,pi_mc_ONE_PER_TRIAL,mc_se,pattern_group_units,weight_ONE_PER_TRIAL,ratio_mc_to_nominal'
    or array_length(source_rows,1) <> n+1 then
   raise exception 'MU81-G06: probability source header or inventory mismatch';
 end if;
 foreach line in array source_rows[2:array_length(source_rows,1)] loop
   cols := string_to_array(line,',');
   if array_length(cols,1) <> 10 or cols[1]=any(source_ids)
      or cols[3] !~ '^[1-9][0-9]*$' or cols[4] !~ '^[1-9][0-9]*$'
      or cols[5] !~ '^[0-9]+([.][0-9]+)?([eE][+-]?[0-9]+)?$'
      or cols[6] !~ '^[0-9]+([.][0-9]+)?([eE][+-]?[0-9]+)?$'
      or cols[7] !~ '^[0-9]+([.][0-9]+)?([eE][+-]?[0-9]+)?$' then
     raise exception 'MU81-G06: invalid or duplicate source probability row';
   end if;
   select value into source_row from jsonb_array_elements(p->'rows') where value->>'unit_id'=cols[1];
   if source_row is null or cols[6]::numeric <> (source_row->>'pi_i')::numeric
      or cols[7]::numeric <> (source_row->>'mc_standard_error')::numeric then
     raise exception 'MU81-G06: source probabilities differ from binding rows';
   end if;
   if not exists(select 1 from public.mu7_unit_design ud where ud.unit_id=cols[1] and ud.mode='FORMAL'
      and ud.stratum=cols[2] and ud.frame_stratum_size=cols[3]::integer and ud.n_sampled_in_stratum=cols[4]::integer
      and abs(ud.selection_probability - cols[5]::double precision) < 1e-12) then
     raise exception 'MU81-G06: source nominal design differs from imported design';
   end if;
   source_ids := array_append(source_ids,cols[1]);
 end loop;
 digest := private.sha256_hex(concat_ws('|','mu81-probability-1',d.design_version,'MONTE_CARLO_ONE_PER_TRIAL',
                p->>'replicates',p->>'seed',p->>'file_sha256',p->>'rows_sha256'));
 insert into public.mu7_probability_binding_v81(binding_version,design_version,method,replicates,seed,source_csv,canonical_csv,
 file_sha256,rows_sha256,binding_sha256,recorded_by)
 values('mu81-probability-1',d.design_version,'MONTE_CARLO_ONE_PER_TRIAL',(p->>'replicates')::integer,
 (p->>'seed')::bigint,p->>'source_csv',csv,p->>'file_sha256',p->>'rows_sha256',digest,me);
 insert into public.audit_log(actor_user_id,actor_role,action,entity_table,entity_id,mode,details)
 values(me,'INVESTIGATOR','INSERT','mu7_probability_binding_v81',digest,'FORMAL',
   jsonb_build_object('binding_version','mu81-probability-1','binding_sha256',digest));
 return digest;
end $$;
revoke all on function public.rpc_mu81_bind_probabilities(jsonb) from public, anon, authenticated, service_role;
grant execute on function public.rpc_mu81_bind_probabilities(jsonb) to authenticated;

alter table public.mu7_freeze add column probability_binding_sha256 text
 check (probability_binding_sha256 ~ '^[0-9a-f]{64}$');
create function private.mu81_freeze_binding() returns trigger
language plpgsql security definer set search_path = '' as $$
declare b record;
begin
 new.probability_binding_sha256 := null;
 if private.mu81_active() and (select overlap_setting='ONE_PER_TRIAL' from public.mu7_design) then
   select * into b from public.mu7_probability_binding_v81;
   if b.binding_sha256 is null then raise exception 'MU81-G07: bind probabilities before freeze'; end if;
   new.probability_binding_sha256 := b.binding_sha256;
 end if;
 return new;
end $$;
create trigger z40_mu81_freeze_binding before insert on public.mu7_freeze
 for each row execute function private.mu81_freeze_binding();
revoke all on function private.mu81_freeze_binding() from public, anon, authenticated, service_role;
alter table public.mu7_exports drop constraint mu7_exports_format_ck;
alter table public.mu7_exports add constraint mu7_exports_format_ck check(bundle_format_version in ('7.0','8.1'));
create function private.mu81_export_version() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
 if new.bundle_format_version in ('7.0','8.1') and new.bundle_format_version is distinct from (case when private.mu81_active() then '8.1' else '7.0' end) then
   raise exception 'MU81-G08: bundle format must match the recorded design';
 end if;
 return new;
end $$;
create trigger z40_mu81_export_version before insert on public.mu7_exports
 for each row execute function private.mu81_export_version();
revoke all on function private.mu81_export_version() from public, anon, authenticated, service_role;
create or replace function private.mu7x_pilot_export_inventory() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  n_locked integer;
begin
  -- Inventory remains required for both versioned export formats.
  if new.mode <> 'PILOT' or new.bundle_format_version not in ('7.0','8.1') then
    return new;
  end if;
  select l.n_units_locked into n_locked from public.mu7_reference_locks l where l.mode = 'PILOT';
  if n_locked is null or (new.row_counts ->> 'units') is distinct from n_locked::text then
    raise exception 'MU7X-G03: a PILOT export states the % locked pilot units in row_counts.units', coalesce(n_locked, 0);
  end if;
  return new;
end $$;

create function public.rpc_mu81_vocabulary() returns text
language sql stable security definer set search_path = '' as $$
 select case when private.app_role() is not null and private.mu81_active() then 'mu81-subtype-1' else null end
$$;
revoke all on function public.rpc_mu81_vocabulary() from public, anon, authenticated, service_role;
grant execute on function public.rpc_mu81_vocabulary() to authenticated;
create function private.mu81_adjudication_reason() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
 if private.mu81_active() and new.reason_code='TYPE_2_STATED'
    and exists(select 1 from public.mu7_units where unit_id=new.unit_id and assignment_code in ('D4A_KEEP_UNRESOLVED_PARENT_ONLY','D4B_KEEP_UNRESOLVED_COMPLICATION_ONLY')) then
   raise exception 'MU81-G03: stated type is a separate observation, never an adjudicated reason';
 end if;
 return new;
end $$;
create trigger z40_mu81_adjudication before insert on public.mu7_adjudications
 for each row execute function private.mu81_adjudication_reason();
revoke all on function private.mu81_adjudication_reason() from public, anon, authenticated, service_role;
commit;
