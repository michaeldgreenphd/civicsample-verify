-- Opt-in reviewer wording profile. Historical designs, packets and judgments keep their meaning.
-- This binding records the investigator's chosen presentation, never a scientific gate approval.
begin;
insert into public.app_schema_version(version, description) values
 ('8.1.2-reviewer-profile', 'Immutable opt-in plain-language reviewer profile before any v8.1 review or training activity');

create table public.mu7_reviewer_profile_v81 (
 singleton boolean primary key default true check(singleton),
 profile_id text not null check(profile_id = 'mu81-plain-language-r3'),
 rubric_sha256 text not null check(rubric_sha256 = '1cd8584d68a313e60aab2f5e03f36fba66105c31b0050dec1be7d8f36ddba284'),
 design_version text not null,
 binding_sha256 text not null check(binding_sha256 ~ '^[0-9a-f]{64}$'),
 attestation text not null check(length(btrim(attestation)) between 20 and 4000),
 recorded_by uuid not null references public.users(user_id),
 recorded_at timestamptz not null default now()
);
alter table public.mu7_reviewer_profile_v81 enable row level security;
revoke all on public.mu7_reviewer_profile_v81 from public, anon, authenticated, service_role;
create trigger mu81_reviewer_profile_append_only before update or delete on public.mu7_reviewer_profile_v81
 for each row execute function private.reject_mutation();
create trigger mu81_reviewer_profile_no_truncate before truncate on public.mu7_reviewer_profile_v81
 for each statement execute function private.reject_mutation();

create function private.mu81_reviewer_profile_before_insert() returns trigger
language plpgsql security definer set search_path = '' as $$
declare me uuid := private.assert_investigator(); dv text;
begin
 -- The same exclusive lock used by freeze/close also waits for in-flight imports.
 perform pg_catalog.pg_advisory_xact_lock(7024025);
 if current_setting('transaction_isolation') <> 'read committed' then
   raise exception 'MU81-P01: READ COMMITTED required';
 end if;
 -- A user may have been locked while this statement waited for an import to finish.
 me := private.assert_investigator();
 select design_version into dv from public.mu7_design;
 if not private.mu81_active() then
   raise exception 'MU81-P01: record a v8.1 design before choosing a reviewer profile';
 end if;
 if exists(select 1 from public.mu7_units) or exists(select 1 from public.mu7_training_units)
    or exists(select 1 from public.mu7_queue) or exists(select 1 from public.mu7_judgments)
    or exists(select 1 from public.mu7_adjudications) or exists(select 1 from public.mu7_freeze)
    or exists(select 1 from public.mu7_phase_events) or exists(select 1 from public.mu7_reference_locks)
    or exists(select 1 from public.mu7_training_acknowledgments) then
   raise exception 'MU81-P02: choose the reviewer profile before importing units or training or recording review activity';
 end if;
 new.design_version := dv;
 new.recorded_by := me;
 new.recorded_at := now();
 new.binding_sha256 := private.sha256_hex(concat_ws('|', 'mu81-reviewer-profile-1', dv, new.profile_id, new.rubric_sha256));
 return new;
end $$;
create trigger mu81_reviewer_profile_before_insert before insert on public.mu7_reviewer_profile_v81
 for each row execute function private.mu81_reviewer_profile_before_insert();
revoke all on function private.mu81_reviewer_profile_before_insert() from public, anon, authenticated, service_role;

create function public.rpc_mu81_bind_reviewer_profile(p jsonb) returns text
language plpgsql security definer set search_path = '' as $$
declare me uuid := private.assert_investigator(); digest text;
begin
 perform private.mu7_assert_keys(p, array['profile_id','rubric_sha256','attestation'], 'reviewer profile');
 if jsonb_typeof(p->'profile_id') is distinct from 'string'
    or jsonb_typeof(p->'rubric_sha256') is distinct from 'string'
    or jsonb_typeof(p->'attestation') is distinct from 'string'
    or (p->>'profile_id') is distinct from 'mu81-plain-language-r3'
    or (p->>'rubric_sha256') is distinct from '1cd8584d68a313e60aab2f5e03f36fba66105c31b0050dec1be7d8f36ddba284'
    or length(btrim(p->>'attestation')) not between 20 and 4000 then
   raise exception 'MU81-P03: fixed reviewer profile, rubric checksum and a 20 to 4000 character attestation required';
 end if;
 insert into public.mu7_reviewer_profile_v81(profile_id, rubric_sha256, design_version, binding_sha256, attestation, recorded_by)
 values(p->>'profile_id', p->>'rubric_sha256', '', repeat('0',64), btrim(p->>'attestation'), me)
 returning binding_sha256 into digest;
 insert into public.audit_log(actor_user_id, actor_role, action, entity_table, entity_id, details)
 values(me, 'INVESTIGATOR', 'INSERT', 'mu7_reviewer_profile_v81', p->>'profile_id',
        jsonb_build_object('profile_id',p->>'profile_id','rubric_sha256',p->>'rubric_sha256','binding_sha256',digest));
 return digest;
end $$;
revoke all on function public.rpc_mu81_bind_reviewer_profile(jsonb) from public, anon, authenticated, service_role;
grant execute on function public.rpc_mu81_bind_reviewer_profile(jsonb) to authenticated;

create function private.mu81_reviewer_profile_active() returns boolean
language sql stable security definer set search_path = '' as $$
 select private.mu81_active() and exists(select 1 from public.mu7_reviewer_profile_v81 b
   join public.mu7_design d on d.design_version = b.design_version
   where b.profile_id = 'mu81-plain-language-r3')
$$;
revoke all on function private.mu81_reviewer_profile_active() from public, anon, authenticated, service_role;

create function public.rpc_mu81_reviewer_profile() returns jsonb
language sql stable security definer set search_path = '' as $$
 select case when private.app_role() is not null and private.mu81_reviewer_profile_active() then
   (select jsonb_build_object('profile_id',profile_id,'rubric_sha256',rubric_sha256,
     'binding_sha256',binding_sha256,'design_version',design_version) from public.mu7_reviewer_profile_v81)
   else null end
$$;
revoke all on function public.rpc_mu81_reviewer_profile() from public, anon, authenticated, service_role;
grant execute on function public.rpc_mu81_reviewer_profile() to authenticated;

-- Preserve the original contract as private helpers; replace the original function OIDs so that
-- every existing packet, reviewer and adjudicator guard calls the version-aware implementation.
create function private.mu81_legacy_display_text(p_family text, p_code text) returns text
language sql immutable set search_path = '' as $$
  select case
    when p_family = 'AREA' then 'in this area'
    when p_family = 'ROW' then 'in this row'
    when p_code = 'D1_KEEP_TYPE2' then 'type 2 diabetes'
    when p_code in ('D4A_KEEP_UNRESOLVED_PARENT_ONLY', 'D4B_KEEP_UNRESOLVED_COMPLICATION_ONLY') then 'diabetes, type not stated in the registry headings'
    when p_code in ('K_KEEP_MALIGNANT_COMPATIBLE', 'K_KEEP_HEURISTIC_NONMALIGNANT_CLASS') then 'malignant neoplasm, counted in the Neoplasms row'
    when p_code = 'D2_REMOVE_OTHER_TYPE' then 'type 1, gestational or another specified type of diabetes, with no type 2 heading'
    when p_code = 'D3_REMOVE_PREDIABETES_ONLY' then 'prediabetes only, with no diabetes mellitus heading'
    when p_code = 'K_REMOVE_VERIFIED_NONMALIGNANT' then 'non-malignant condition only (every neoplasm heading is a cyst, hamartoma or precancerous condition)'
  end
$$;
create function private.mu81_legacy_reason_ok(p_family text, p_code text, p_reason text) returns boolean
language sql immutable set search_path = '' as $$
 select coalesce(case
    when p_family = 'AREA' then p_reason in ('ORGAN_OF_ORIGIN_ONLY','NOT_THE_CONDITION_STUDIED','MESH_PLACEMENT_MISLEADING','RUBRIC_POLICY_EXCLUDES','OTHER_SPECIFIED')
    when p_family = 'ROW' then p_reason in ('NOT_THE_CONDITION_STUDIED','MESH_PLACEMENT_MISLEADING','OTHER_SPECIFIED')
    when p_code = 'D1_KEEP_TYPE2' then p_reason in ('TYPE_1_ONLY','OTHER_DIABETES_TYPE','PREDIABETES_ONLY','DIABETES_NOT_STUDIED','OTHER_SPECIFIED')
    when p_code in ('D4A_KEEP_UNRESOLVED_PARENT_ONLY','D4B_KEEP_UNRESOLVED_COMPLICATION_ONLY') then p_reason in ('TYPE_2_STATED','TYPE_1_ONLY','OTHER_DIABETES_TYPE','PREDIABETES_ONLY','DIABETES_NOT_STUDIED','OTHER_SPECIFIED')
    when p_code = 'D2_REMOVE_OTHER_TYPE' then p_reason in ('TYPE_2_STUDIED','TYPE_NOT_DETERMINABLE','OTHER_SPECIFIED')
    when p_code = 'D3_REMOVE_PREDIABETES_ONLY' then p_reason in ('DIABETES_STUDIED','OTHER_SPECIFIED')
    when p_code in ('K_KEEP_MALIGNANT_COMPATIBLE','K_KEEP_HEURISTIC_NONMALIGNANT_CLASS') then p_reason in ('BENIGN_NEOPLASM','PRECANCEROUS','NOT_A_NEOPLASM','OTHER_SPECIFIED')
    when p_code = 'K_REMOVE_VERIFIED_NONMALIGNANT' then p_reason in ('MALIGNANT_NEOPLASM_STUDIED','OTHER_SPECIFIED')
    else false end, false)
$$;
revoke all on function private.mu81_legacy_display_text(text,text), private.mu81_legacy_reason_ok(text,text,text)
 from public, anon, authenticated, service_role;

create or replace function private.mu7_display_text(p_family text, p_code text) returns text
language sql stable security definer set search_path = '' as $$
 select case when private.mu81_reviewer_profile_active() and p_family='SG' then
   case when p_code in ('K_KEEP_MALIGNANT_COMPATIBLE','K_KEEP_HEURISTIC_NONMALIGNANT_CLASS') then
     'a neoplasm heading other than a cyst, hamartoma or precancerous condition, counted in the Neoplasms row'
   when p_code='K_REMOVE_VERIFIED_NONMALIGNANT' then
     'cyst, hamartoma or precancerous condition only (every neoplasm heading is one of these)'
   else private.mu81_legacy_display_text(p_family,p_code) end
 else private.mu81_legacy_display_text(p_family,p_code) end
$$;
create or replace function private.mu7_reason_ok(p_family text, p_code text, p_reason text) returns boolean
language sql stable security definer set search_path = '' as $$
 select case when private.mu81_reviewer_profile_active() and p_family='SG' then
   case when p_code in ('K_KEEP_MALIGNANT_COMPATIBLE','K_KEEP_HEURISTIC_NONMALIGNANT_CLASS') and p_reason='BENIGN_NEOPLASM' then false
   when p_code='K_REMOVE_VERIFIED_NONMALIGNANT' and p_reason='NONMALIGNANT_NEOPLASM_STUDIED' then true
   else private.mu81_legacy_reason_ok(p_family,p_code,p_reason) end
 else private.mu81_legacy_reason_ok(p_family,p_code,p_reason) end
$$;
revoke all on function private.mu7_display_text(text,text), private.mu7_reason_ok(text,text,text)
 from public, anon, authenticated, service_role;
-- These validators now depend on a database-bound profile; they may not be constant-folded.
alter function private.assert_mu7_packet(jsonb,text,text,text,text,text,text,text,text,text) stable;
alter function private.assert_mu7_training_packet(jsonb,text) stable;

create function private.mu81_reviewer_profile_answer_note() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
 if private.mu81_reviewer_profile_active() and new.answer='CANNOT_TELL'
    and length(btrim(coalesce(new.note,''))) < 3 then
   raise exception 'MU81-P08: explain the missing information for Cannot tell';
 end if;
 return new;
end $$;
create trigger z50_mu81_reviewer_profile_answer_note before insert on public.mu7_judgments
 for each row execute function private.mu81_reviewer_profile_answer_note();
revoke all on function private.mu81_reviewer_profile_answer_note() from public, anon, authenticated, service_role;

alter table public.mu7_freeze add column reviewer_profile_sha256 text
 check(reviewer_profile_sha256 is null or reviewer_profile_sha256 ~ '^[0-9a-f]{64}$');
create function private.mu81_freeze_reviewer_profile() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
 -- Binding is opt-in. Old databases and unbound versions retain a null marker.
 new.reviewer_profile_sha256 := null;
 if private.mu81_reviewer_profile_active() then
   select binding_sha256 into new.reviewer_profile_sha256 from public.mu7_reviewer_profile_v81;
 end if;
 return new;
end $$;
create trigger z50_mu81_freeze_reviewer_profile before insert on public.mu7_freeze
 for each row execute function private.mu81_freeze_reviewer_profile();
revoke all on function private.mu81_freeze_reviewer_profile() from public, anon, authenticated, service_role;

-- The opt-in profile is distinguishable in exported data. The complete guide and full revision
-- history accompany it; older profiles keep the pre-existing export contracts unchanged.
alter table public.mu7_exports drop constraint mu7_exports_format_ck;
alter table public.mu7_exports add constraint mu7_exports_format_ck
 check(bundle_format_version in ('7.0','8.1','8.2','8.3'));
create or replace function private.mu81_export_version() returns trigger
language plpgsql security definer set search_path = '' as $$
declare n integer; b record; p record;
begin
 -- Unknown formats retain the historical named CHECK-constraint refusal.
 if new.bundle_format_version not in ('7.0','8.1','8.2','8.3') then return new; end if;
 if private.mu81_reviewer_profile_active() then
   if new.bundle_format_version <> '8.3' then
     raise exception 'MU81-P04: the reviewer profile requires bundle 8.3';
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
 elsif new.bundle_format_version='8.3'
       or (private.mu81_active() and new.bundle_format_version='7.0')
       or (not private.mu81_active() and new.bundle_format_version<>'7.0') then
   raise exception 'MU81-G08: bundle format must match the recorded design and reviewer profile';
 end if;
 return new;
end $$;
create or replace function private.mu7x_pilot_export_inventory() returns trigger
language plpgsql security definer set search_path = '' as $$
declare n_locked integer;
begin
 if new.mode <> 'PILOT' or new.bundle_format_version not in ('7.0','8.1','8.2','8.3') then return new; end if;
 select l.n_units_locked into n_locked from public.mu7_reference_locks l where l.mode = 'PILOT';
 if n_locked is null or (new.row_counts ->> 'units') is distinct from n_locked::text then
   raise exception 'MU7X-G03: a PILOT export states the % locked pilot units in row_counts.units', coalesce(n_locked, 0);
 end if;
 return new;
end $$;
commit;
