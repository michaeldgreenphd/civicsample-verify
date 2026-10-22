// Synthetic shared lifecycle for both PGlite and disposable native PostgreSQL.
import assert from 'node:assert/strict';
import { GUARD_IDS, guardActor, type GuardDb, type GuardRole } from './tlv5-guard-fixture';
const j = JSON.stringify;
async function rpc(db: GuardDb, role: GuardRole, sql: string, params: unknown[] = []) {
  return guardActor(db, role, () => db.query(sql, params));
}
export async function exerciseLegacyPilot(db: GuardDb) {
  await rpc(db, 'investigator', 'select public.rpc_register_ontology_version($1::jsonb)', [
    j({
      ontology_version: '1.0.0',
      rule_version: '1.0.0',
      rubric_version: 'R-TEST',
      classification_schema_version: '1.0.0',
      protocol_version: 'P-TEST',
      sampling_design_version: 'SYN-REF-TEST',
      ontology_sha256: 'b'.repeat(64),
      classification_schema_sha256: 'c'.repeat(64),
      rubric_sha256: 'd'.repeat(64),
      frozen_at: '2026-10-20T00:00:00Z',
      notes: 'Synthetic only',
    }),
  ]);
  const ids = Array.from({ length: 10 }, (_, i) => `SYN-${String(i + 101).padStart(3, '0')}`);
  for (const case_id of ids)
    await rpc(db, 'investigator', 'select public.rpc_import_case($1::jsonb)', [
      j({
        case_id,
        mode: 'PILOT',
        unit_type: 'DESCRIPTOR_AREA',
        version_set_id: '1.0.0+R-TEST',
        l1_applicable: true,
        l2_applicable: false,
        l3_applicable: false,
        packet: {
          schema_version: '1.0',
          case_title: 'Synthetic legacy pilot',
          question: 'Synthetic question',
          unit: { unit_type: 'DESCRIPTOR_AREA', unit_id: `${case_id}::infectious` },
          descriptor: { descriptor_ui: `SYN-${case_id}`, name: 'Synthetic descriptor' },
          mesh: { scope_note: 'Synthetic scope', tree_numbers: ['SYN.001'] },
          area: { key: 'infectious', label: 'Synthetic area' },
        },
        change_reason: 'Synthetic initial version',
        design: {
          unit_id: `${case_id}::infectious`,
          descriptor_ui: `SYN-${case_id}`,
          descriptor_name: 'Synthetic descriptor',
          area: 'infectious',
          primary_stratum: 'SYN-STRATUM',
          selection_probability: 0.5,
          frame_stratum_size: 20,
          sampling_design_version: 'SYN-REF-TEST',
          sampling_seed: 123,
          trial_frequency_weight: 1,
          n_trials_primary: 1,
          original_l1_decision: 'INCLUDE',
          source_file: 'synthetic',
          source_row_sha256: 'a'.repeat(64),
        },
      }),
    ]);
  for (const [index, role] of (['a', 'b'] as const).entries()) {
    const pid = (
      await db.query<{ reviewer_pseudo_id: string }>(
        'select reviewer_pseudo_id from public.reviewers where user_id=$1',
        [GUARD_IDS[role]],
      )
    ).rows[0].reviewer_pseudo_id;
    await rpc(db, 'investigator', 'select public.rpc_assign_cases($1,$2,$3,$4,$5)', [
      'PILOT',
      pid,
      index + 1,
      ids,
      123,
    ]);
    const assignments = (
      await db.query<{ assignment_id: string }>(
        'select assignment_id from public.assignments where reviewer_pseudo_id=$1',
        [pid],
      )
    ).rows;
    for (const a of assignments)
      await rpc(db, role, 'select public.rpc_submit_review($1,$2::jsonb)', [
        a.assignment_id,
        j({
          l1_decision: 'INCLUDE',
          l1_rationale: 'Synthetic independent rationale',
          l1_uncertain: false,
        }),
      ]);
    if (role === 'a') {
      assert.equal((await rpc(db, 'adjudicator', 'select * from public.reviews')).rows.length, 0);
      await assert.rejects(
        rpc(
          db,
          'adjudicator',
          "select public.rpc_record_adjudication($1,'clinical_classification','INCLUDE',null,'CONCORDANT_CONFIRMED','BOTH_REVIEWERS','Synthetic rationale',null,'{}'::uuid[],null,null,false)",
          [ids[0]],
        ),
        /both pilot reviewer slots/,
      );
    }
  }
  const sql =
    "select public.rpc_record_adjudication($1,'clinical_classification','INCLUDE',null,'CONCORDANT_CONFIRMED','BOTH_REVIEWERS','Synthetic rationale',null,array(select review_id from public.v_effective_reviews where case_id=$1),null,null,false)";
  await assert.rejects(rpc(db, 'investigator', sql, [ids[0]]), /active ADJUDICATOR/);
  assert.equal((await rpc(db, 'adjudicator', 'select * from public.reviews')).rows.length, 20);
  assert.equal(
    (await rpc(db, 'adjudicator', 'select * from public.case_design_v3')).rows.length,
    0,
  );
  assert.equal(
    (await rpc(db, 'adjudicator', 'select * from public.ai_classifications')).rows.length,
    0,
  );
  for (const id of ids) await rpc(db, 'adjudicator', sql, [id]);
  const rows = (
    await db.query<{ adjudication_blinded: boolean; adjudicator_role: string }>(
      'select adjudication_blinded,adjudicator_role from public.adjudications',
    )
  ).rows;
  assert.equal(rows.length, 10);
  assert.ok(rows.every((r) => r.adjudication_blinded && r.adjudicator_role === 'ADJUDICATOR'));
  const exportId = (
    await rpc(db, 'investigator', 'select public.rpc_register_export($1::jsonb) as id', [
      j({
        mode: 'PILOT',
        export_type: 'ANALYSIS',
        export_format_version: '1',
        version_set_id: '1.0.0+R-TEST',
        ontology_version: '1.0.0',
        rule_version: '1.0.0',
        rubric_version: 'R-TEST',
        classification_schema_version: '1.0.0',
        sampling_design_version: 'SYN-REF-TEST',
        app_git_sha: 'a'.repeat(40),
        row_counts: { rows: 10 },
        file_sha256: { 'synthetic.csv': '2'.repeat(64) },
      }),
    ])
  ).rows[0].id;
  await rpc(db, 'investigator', 'select public.rpc_unlock_formal_review($1,$2,$3,$4,$5)', [
    'SYN-CHECKLIST',
    '1'.repeat(64),
    'a'.repeat(40),
    exportId,
    'Synthetic engineering pilot acceptance only.',
  ]);
}
