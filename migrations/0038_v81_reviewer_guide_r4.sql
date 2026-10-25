-- Revision 4 changes only a guide heading and its revision label. Existing bindings,
-- guide bytes, judgments, packets, gates and lifecycle restrictions remain unchanged.
begin;
insert into public.app_schema_version(version, description) values
 ('8.1.3-reviewer-guide-r4', 'Permit immutable reviewer guide revision 4 while preserving revision 3');

alter table public.mu7_reviewer_profile_v81
 drop constraint mu7_reviewer_profile_v81_profile_id_check,
 drop constraint mu7_reviewer_profile_v81_rubric_sha256_check,
 add constraint mu81_reviewer_profile_known_pair check (
   (profile_id = 'mu81-plain-language-r3' and
    rubric_sha256 = '1cd8584d68a313e60aab2f5e03f36fba66105c31b0050dec1be7d8f36ddba284') or
   (profile_id = 'mu81-plain-language-r4' and
    rubric_sha256 = '1eee3cdcae8f9c097a119255cbd410524f2d2ad08a24df3f02de38a1c096c88a')
 );

create or replace function public.rpc_mu81_bind_reviewer_profile(p jsonb) returns text
language plpgsql security definer set search_path = '' as $$
declare me uuid := private.assert_investigator(); digest text;
begin
 perform private.mu7_assert_keys(p, array['profile_id','rubric_sha256','attestation'], 'reviewer profile');
 if jsonb_typeof(p->'profile_id') is distinct from 'string'
    or jsonb_typeof(p->'rubric_sha256') is distinct from 'string'
    or jsonb_typeof(p->'attestation') is distinct from 'string'
    or not coalesce(
      ((p->>'profile_id') = 'mu81-plain-language-r3' and
       (p->>'rubric_sha256') = '1cd8584d68a313e60aab2f5e03f36fba66105c31b0050dec1be7d8f36ddba284') or
      ((p->>'profile_id') = 'mu81-plain-language-r4' and
       (p->>'rubric_sha256') = '1eee3cdcae8f9c097a119255cbd410524f2d2ad08a24df3f02de38a1c096c88a'), false)
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

create or replace function private.mu81_reviewer_profile_active() returns boolean
language sql stable security definer set search_path = '' as $$
 select private.mu81_active() and exists(select 1 from public.mu7_reviewer_profile_v81 b
   join public.mu7_design d on d.design_version = b.design_version
   where b.profile_id in ('mu81-plain-language-r3', 'mu81-plain-language-r4'))
$$;
revoke all on function private.mu81_reviewer_profile_active() from public, anon, authenticated, service_role;

commit;
