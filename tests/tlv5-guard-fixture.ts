// Synthetic database-boundary fixtures; never connects to an application database.
import { readFile } from 'node:fs/promises';
import { AREA_ITEMS, ROW_ITEMS } from '../src/lib/tlv5-codes';
export interface GuardDb {
  exec(sql: string): Promise<unknown>;
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}
export const GUARD_IDS = {
  investigator: '00000000-0000-4000-8000-0000000000b1',
  a: '00000000-0000-4000-8000-0000000000b2',
  b: '00000000-0000-4000-8000-0000000000b3',
  adjudicator: '00000000-0000-4000-8000-0000000000b4',
};
export type GuardRole = keyof typeof GUARD_IDS;
export const GUARD_MIGRATION = 'migrations/0013_v5_independent_finality_guards.sql';
export const GUARD_CASE = 'SYN-TLV5-GUARD';
export const GUARD_ATT = 'Synthetic engineering attestation for guard tests only.';
export const guardPayload = (answer = 'NO') => ({
  items: [...AREA_ITEMS, ...ROW_ITEMS].map((item_code) => ({
    item_code,
    answer: item_code === 'AREA_ONCOLOGY' ? answer : 'NO',
    uncertain: false,
  })),
});
export const guardAdjudication = {
  case_id: GUARD_CASE,
  item_code: 'AREA_ONCOLOGY',
  decision: 'NO',
  status: 'DISCORDANT_RESOLVED',
  basis: 'REVIEWER_2',
  rationale: 'Synthetic boundary regression only.',
  disagreement_reason_code: 'CONSTRUCT_BOUNDARY',
};
export async function guardSession(db: GuardDb, role: GuardRole) {
  await db.exec('begin');
  await db.exec('set local role authenticated');
  await db.query("select set_config('request.jwt.claims',$1,true)", [
    JSON.stringify({ sub: GUARD_IDS[role], aal: 'aal2' }),
  ]);
}
export async function guardActor<T>(db: GuardDb, role: GuardRole, fn: () => Promise<T>) {
  await guardSession(db, role);
  try {
    const result = await fn();
    await db.exec('commit');
    return result;
  } catch (e) {
    await db.exec('rollback');
    throw e;
  }
}
export async function guardSubmit(db: GuardDb, role: 'a' | 'b', answer = 'NO') {
  return guardActor(db, role, async () => {
    const row = (
      await db.query<{ assignment_id: string }>('select assignment_id from public.tlv5_assignments')
    ).rows[0];
    return db.query('select public.rpc_tlv5_submit($1,$2::jsonb)', [
      row.assignment_id,
      JSON.stringify(guardPayload(answer)),
    ]);
  });
}
export async function seedGuardDatabase(db: GuardDb, strict = true) {
  for (const file of [
    'supabase_test_shim/auth_shim.sql',
    'schema.sql',
    'migrations/0002_v3_review_design.sql',
    'migrations/0003_v4_record_categories_module_b.sql',
    'migrations/0004_synthetic_verify_workflow.sql',
    'migrations/0005_review_integrity_fixes.sql',
    'migrations/0006_reference_integrity.sql',
    'migrations/0007_frozen_contract_guards.sql',
    'migrations/0008_trial_packet_and_concurrency_guards.sql',
    'migrations/0009_canonical_packet_and_lock_state_guards.sql',
    'migrations/0010_investigator_judgment_boundary.sql',
    'migrations/0011_v5_trial_label_verification.sql',
    'migrations/0012_v5_training_examples.sql',
    ...(strict ? [GUARD_MIGRATION] : []),
  ])
    await db.exec(await readFile(file, 'utf8'));
  for (const [role, id] of Object.entries(GUARD_IDS)) {
    const appRole =
      role === 'investigator'
        ? 'INVESTIGATOR'
        : role === 'adjudicator'
          ? 'ADJUDICATOR'
          : 'REVIEWER';
    await db.query('insert into auth.users(id,email) values($1,$2)', [
      id,
      `${role}@example.invalid`,
    ]);
    await db.query(
      'insert into public.users(user_id,auth_uid,email,display_name,role,is_pilot_test_account) values($1,$1,$2,$3,$4,$5)',
      [id, `${role}@example.invalid`, `Synthetic ${role}`, appRole, appRole === 'REVIEWER'],
    );
  }
  await guardActor(db, 'investigator', async () => {
    const payload = {
      case_id: GUARD_CASE,
      mode: 'PILOT',
      packet: {
        schema_version: '5.1',
        case_title: 'Synthetic guard regression',
        trial: { nct_id: 'SYN-NCT-9981', brief_title: 'Fictional guard case' },
      },
      design: {
        nct_id: 'SYN-NCT-9981',
        frame: 'SYN_FRAME',
        stratum: 'SYN_S1',
        variance_stratum: 'SYN_S1',
        frame_stratum_size: 2,
        n_sampled_in_stratum: 1,
        selection_probability: 0.5,
        sampling_seed: 123,
        design_version: 'SYN-GUARD',
        in_mixed_sex_cohort: true,
        figure2_rows: '',
        dev_linked: false,
        tier1_eligible: true,
      },
    };
    await db.query('select public.rpc_tlv5_import_case($1::jsonb)', [JSON.stringify(payload)]);
    for (const [slot, id] of [GUARD_IDS.a, GUARD_IDS.b].entries()) {
      const r = await db.query<{ p: string }>(
        "select public.rpc_enroll_reviewer($1,'PILOT','Synthetic test account') as p",
        [id],
      );
      await db.query("select public.rpc_tlv5_assign('PILOT',$1,$2,$3::text[],123)", [
        r.rows[0].p,
        slot + 1,
        [GUARD_CASE],
      ]);
    }
  });
}

export const guardFreezeInput = {
  label_file_sha256: '1'.repeat(64),
  frozen_items: { rubric: '2'.repeat(64) },
  attestation: GUARD_ATT,
};
export async function guardImportCase(
  db: GuardDb,
  caseId: string,
  nct: string,
  mode: 'PILOT' | 'FORMAL',
) {
  // Caller already has an investigator session. Copy only this synthetic seed.
  await db.query(
    `select public.rpc_tlv5_import_case(jsonb_build_object(
    'case_id',$1::text,'mode',$2::text,
    'packet',jsonb_set(c.packet,'{trial,nct_id}',to_jsonb($3::text)),
    'design',to_jsonb(d)||jsonb_build_object('nct_id',$3::text)))
    from public.tlv5_cases c join public.tlv5_case_design d using(case_id)
    where c.case_id=$4`,
    [caseId, mode, nct, GUARD_CASE],
  );
  if (mode === 'FORMAL')
    await db.query('select public.rpc_tlv5_import_frozen_labels($1::jsonb)', [
      JSON.stringify([
        ...AREA_ITEMS.map((item_code) => ({
          label_set_id: 'SYN-GUARD-LABELS',
          case_id: caseId,
          item_code,
          label_primary: 'NO',
          label_secondary: 'NO',
          dev_linked_area: false,
        })),
        ...ROW_ITEMS.map((item_code) => ({
          label_set_id: 'SYN-GUARD-LABELS',
          case_id: caseId,
          item_code,
          label_primary: 'NO',
        })),
      ]),
    ]);
}
export async function prepareGuardFreeze(db: GuardDb) {
  await guardActor(db, 'investigator', async () => {
    const ids = [];
    for (let n = 2; n <= 10; n++) {
      const id = `SYN-TLV5-GUARD-${n}`;
      ids.push(id);
      await guardImportCase(db, id, `SYN-NCT-${9000 + n}`, 'PILOT');
    }
    const reviewers = (
      await db.query<{ reviewer_pseudo_id: string; reviewer_slot: number }>(
        'select reviewer_pseudo_id,reviewer_slot from public.tlv5_assignments where case_id=$1',
        [GUARD_CASE],
      )
    ).rows;
    for (const r of reviewers)
      await db.query("select public.rpc_tlv5_assign('PILOT',$1,$2,$3::text[],123)", [
        r.reviewer_pseudo_id,
        r.reviewer_slot,
        ids,
      ]);
  });
  for (const role of ['a', 'b'] as const)
    await guardActor(db, role, async () => {
      const assignments = (
        await db.query<{ assignment_id: string }>(
          'select assignment_id from public.tlv5_assignments',
        )
      ).rows;
      for (const row of assignments)
        await db.query('select public.rpc_tlv5_submit($1,$2::jsonb)', [
          row.assignment_id,
          JSON.stringify(guardPayload()),
        ]);
    });
  await guardActor(db, 'investigator', async () => {
    await db.query("select public.rpc_tlv5_lock_reference('PILOT',$1)", [GUARD_ATT]);
    const e = await db.query<{ id: string }>(
      'select public.rpc_tlv5_register_export($1::jsonb) as id',
      [
        JSON.stringify({
          mode: 'PILOT',
          bundle_format_version: '5.0',
          row_counts: {},
          file_sha256: {},
          manifest_sha256: '3'.repeat(64),
          app_git_sha: '4'.repeat(40),
        }),
      ],
    );
    await db.query("select public.rpc_tlv5_phase('PILOT_SIGNED_OFF',$1::jsonb)", [
      JSON.stringify({
        checklist_version: 'SYN-GUARD',
        checklist_sha256: '5'.repeat(64),
        app_git_sha: '4'.repeat(40),
        pilot_export_id: e.rows[0].id,
        attestation: GUARD_ATT,
      }),
    ]);
    await db.query("select public.rpc_tlv5_activate('SYN-GUARD','DISAGREEMENTS_ONLY',$1)", [
      GUARD_ATT,
    ]);
    await guardImportCase(db, 'TLV5-TESTFX-GUARD1', 'SYN-NCT-9901', 'FORMAL');
  });
}
