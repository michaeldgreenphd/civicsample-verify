import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

const ATT = 'Synthetic engineering regression attestation only.';
const MIGRATION = 'migrations/0006_reference_integrity.sql';
const ACTORS = {
  investigator: '00000000-0000-4000-8000-0000000000a1',
  pilotA: '00000000-0000-4000-8000-0000000000a2',
  pilotB: '00000000-0000-4000-8000-0000000000a3',
  reviewerA: '00000000-0000-4000-8000-0000000000a4',
  reviewerB: '00000000-0000-4000-8000-0000000000a5',
  adjudicator: '00000000-0000-4000-8000-0000000000a6',
};
type Role = keyof typeof ACTORS;
const ids = ['HO4-TESTFX-LOCK1', 'HO4-TESTFX-LOCK2'];

async function migratedDb(latest = true, dataDir?: string) {
  const db = new PGlite({ dataDir, extensions: { pgcrypto } });
  await db.waitReady;
  const files = [
    'supabase_test_shim/auth_shim.sql',
    'schema.sql',
    'migrations/0002_v3_review_design.sql',
    'migrations/0003_v4_record_categories_module_b.sql',
    'migrations/0004_synthetic_verify_workflow.sql',
    'migrations/0005_review_integrity_fixes.sql',
  ];
  if (latest) files.push(MIGRATION);
  for (const file of files) await db.exec(await readFile(file, 'utf8'));
  return db;
}
async function rpc<T = unknown>(
  db: PGlite,
  who: Role,
  sql: string,
  params: unknown[] = [],
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.exec('set local role authenticated');
    await tx.query("select set_config('request.jwt.claims',$1,true)", [
      JSON.stringify({ sub: ACTORS[who], aal: 'aal2' }),
    ]);
    const result = await tx.query<Record<string, T>>(sql, params);
    return Object.values(result.rows[0] ?? {})[0];
  });
}
const j = JSON.stringify;
function caseInput(caseId: string, mode: 'PILOT' | 'FORMAL') {
  return {
    case_id: caseId,
    mode,
    unit_type: 'DESCRIPTOR_AREA',
    version_set_id: '1.0.0+R-TEST',
    l1_applicable: true,
    l2_applicable: false,
    l3_applicable: false,
    packet: {
      schema_version: '1.0',
      case_title: 'Fictional integrity regression',
      question: 'Does this fictional descriptor belong?',
      unit: { unit_type: 'DESCRIPTOR_AREA', unit_id: `SYN-${caseId}::infectious` },
      descriptor: { descriptor_ui: `SYN-${caseId}`, name: 'Fictional descriptor' },
      mesh: { scope_note: 'SYNTHETIC ENGINEERING ONLY', tree_numbers: ['SYN.001'] },
      area: { key: 'infectious', label: 'Fictional area' },
    },
    change_reason: 'Synthetic initial version',
    design: {
      unit_id: `SYN-${caseId}::infectious`,
      descriptor_ui: `SYN-${caseId}`,
      descriptor_name: 'Fictional descriptor',
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
  };
}
const freezePayload = {
  tier1_version: 'v1.1',
  prediction_file_sha256: '9'.repeat(64),
  frozen_items: { rubric: 'd'.repeat(64) },
  attestation: ATT,
};

// The fixture uses the real pilot-signoff, formal-freeze, assignment, submission,
// close and snapshot RPCs. No scientific gate or database trigger is disabled.
async function fixture(options: { latest?: boolean; freeze?: boolean } = {}) {
  const db = await migratedDb(options.latest ?? true);
  try {
    for (const [role, id] of Object.entries(ACTORS)) {
      const email = `synthetic-${role.toLowerCase()}@example.invalid`;
      const appRole =
        role === 'investigator'
          ? 'INVESTIGATOR'
          : role === 'adjudicator'
            ? 'ADJUDICATOR'
            : 'REVIEWER';
      await db.query('insert into auth.users(id,email) values($1,$2)', [id, email]);
      await db.query(
        'insert into public.users(user_id,auth_uid,email,display_name,role,is_pilot_test_account) values($1,$1,$2,$3,$4,$5)',
        [id, email, `Synthetic ${role}`, appRole, role.startsWith('pilot')],
      );
    }
    const investigator = (sql: string, params: unknown[] = []) =>
      rpc(db, 'investigator', sql, params);
    const pseudo = {} as Record<'pilotA' | 'pilotB' | 'reviewerA' | 'reviewerB', string>;
    for (const role of ['pilotA', 'pilotB'] as const)
      pseudo[role] = await rpc<string>(
        db,
        'investigator',
        'select public.rpc_enroll_reviewer($1,$2,$3)',
        [ACTORS[role], 'PILOT', 'Synthetic engineering account'],
      );
    await investigator('select public.rpc_register_ontology_version($1)', [
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
        notes: 'Synthetic engineering only',
      }),
    ]);
    const pilotIds = Array.from({ length: 10 }, (_, i) => `SYN-${String(i + 1).padStart(3, '0')}`);
    for (const id of pilotIds)
      await investigator('select public.rpc_import_case($1)', [j(caseInput(id, 'PILOT'))]);
    for (const [slot, role] of (['pilotA', 'pilotB'] as const).entries()) {
      await investigator('select public.rpc_assign_cases($1,$2,$3,$4,$5)', [
        'PILOT',
        pseudo[role],
        slot + 1,
        pilotIds,
        123,
      ]);
      const assignments = (
        await db.query<{ assignment_id: string }>(
          'select assignment_id from public.assignments where reviewer_pseudo_id=$1',
          [pseudo[role]],
        )
      ).rows;
      for (const assignment of assignments)
        await rpc(db, role, 'select public.rpc_submit_review($1,$2)', [
          assignment.assignment_id,
          j({
            l1_decision: 'INCLUDE',
            l1_rationale: 'Synthetic pilot judgment',
            l1_uncertain: false,
          }),
        ]);
    }
    for (const id of pilotIds)
      await investigator(
        "select public.rpc_record_adjudication($1,'clinical_classification','INCLUDE',null,'CONCORDANT_CONFIRMED','BOTH_REVIEWERS','Synthetic pilot adjudication',null,array(select review_id from public.v_effective_reviews where case_id=$1),null,null,false)",
        [id],
      );
    const exportId = await investigator('select public.rpc_register_export($1)', [
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
        app_git_sha: 'abc123',
        row_counts: { rows: 10 },
        file_sha256: { 'synthetic.csv': '2'.repeat(64) },
      }),
    ]);
    await investigator('select public.rpc_unlock_formal_review($1,$2,$3,$4,$5)', [
      'SYN-PILOT-CHECKLIST',
      '1'.repeat(64),
      'abc123',
      exportId,
      ATT,
    ]);
    for (const role of ['reviewerA', 'reviewerB'] as const)
      pseudo[role] = await rpc<string>(
        db,
        'investigator',
        'select public.rpc_enroll_reviewer($1,$2,$3)',
        [ACTORS[role], 'FORMAL', 'Synthetic engineering qualifications'],
      );
    await investigator('select public.rpc_activate_design_v4($1,$2,$3)', [
      'SYN-REF-TEST',
      'DISAGREEMENTS_ONLY',
      ATT,
    ]);
    for (const id of ids) {
      await investigator('select public.rpc_import_case($1)', [j(caseInput(id, 'FORMAL'))]);
      await investigator('select public.rpc_set_case_design_v3($1)', [
        j({
          case_id: id,
          mode: 'FORMAL',
          review_module: 'ONTOLOGY_AREA',
          analysis_set: 'VALIDATION_HELDOUT',
          selection_stratum: 'SYN-STRATUM',
          variance_stratum: 'SYN-VARIANCE',
          variance_stratum_size: 20,
          selection_probability: 0.5,
          comparison_cell_v11: 'OPOS_CPOS',
          original_binary: 'INCLUDE',
          curated_v11_status_raw: 'INCLUDE',
          curated_v11_binary: 'INCLUDE',
          two_step_required: false,
          sampling_design_version: 'SYN-REF-TEST',
        }),
      ]);
      await investigator('select public.rpc_record_heldout_case_v4($1)', [
        j({
          case_id: id,
          record_category: 'HELDOUT_FORMAL',
          frame_unit_id: `SYN-FRAME-${id}`,
          provenance_audit_result: 'NO_DEVELOPMENT_FLAG',
        }),
      ]);
    }
    await investigator('select public.rpc_import_frozen_predictions_v4($1)', [
      j(
        ids.map((id) => ({
          prediction_set_id: 'SYN-PREDICTION-REF',
          case_id: id,
          determination_level: 'DESCRIPTOR_LEVEL',
          tier0_binary: 'INCLUDE',
          tier1_version: 'v1.1',
          tier1_status_raw: 'INCLUDE',
          tier1_binary: 'INCLUDE',
        })),
      ),
    ]);
    const freeze = async () => {
      await investigator('select public.rpc_freeze_sample_manifest($1)', [
        j({
          review_module: 'ONTOLOGY_AREA',
          sampling_design_version: 'SYN-REF-TEST',
          manifest_file_sha256: '3'.repeat(64),
          decision_file_v11_sha256: '4'.repeat(64),
          sampling_seed: 123,
          attestation: ATT,
        }),
      ]);
      return investigator('select public.rpc_freeze_v4($1)', [j(freezePayload)]);
    };
    if (options.freeze !== false) {
      await freeze();
      for (const [slot, role] of (['reviewerA', 'reviewerB'] as const).entries())
        await investigator('select public.rpc_assign_cases($1,$2,$3,$4,$5)', [
          'FORMAL',
          pseudo[role],
          slot + 1,
          ids,
          123,
        ]);
    }
    const assignment = async (role: 'reviewerA' | 'reviewerB', caseId: string) =>
      (
        await db.query<{ assignment_id: string }>(
          'select assignment_id from public.assignments where case_id=$1 and reviewer_pseudo_id=$2',
          [caseId, pseudo[role]],
        )
      ).rows[0].assignment_id;
    const submit = async (role: 'reviewerA' | 'reviewerB', caseId: string) =>
      rpc(db, role, 'select public.rpc_submit_review($1,$2)', [
        await assignment(role, caseId),
        j({
          l1_decision: 'INCLUDE',
          l1_rationale: 'Synthetic formal-path engineering judgment',
          l1_uncertain: false,
        }),
      ]);
    const snapshot = async (complete = false) => {
      await investigator('select public.rpc_close_formal_review($1,$2)', [complete, ATT]);
      await investigator('select public.rpc_snapshot_judgments_v4()');
    };
    const lock = () => investigator('select public.rpc_lock_reference_v4($1)', [ATT]);
    const verify = () =>
      rpc<boolean>(
        db,
        'investigator',
        'select matches from public.rpc_verify_judgment_snapshot_v4()',
      );
    const singleAdjudication = async (caseId: string) => {
      const considered = (
        await db.query<{ review_id: string }>(
          'select review_id from public.reviews where case_id=$1',
          [caseId],
        )
      ).rows.map((r) => r.review_id);
      return rpc(db, 'adjudicator', 'select public.rpc_record_adjudication_v3($1)', [
        j({
          case_id: caseId,
          determination_level: 'DESCRIPTOR_LEVEL',
          decision: 'INCLUDE',
          status: 'SINGLE_REVIEW_ADJUDICATED',
          basis: 'REVIEWER_1',
          rationale: 'Synthetic independent adjudication.',
          considered_ids: considered,
        }),
      ]);
    };
    return {
      db,
      pseudo,
      investigator,
      freeze,
      assignment,
      submit,
      snapshot,
      lock,
      verify,
      singleAdjudication,
    };
  } catch (error) {
    await db.close();
    throw error;
  }
}

for (const withdrawal of ['assignment', 'reviewer'] as const)
  test(`snapshot drift from ${withdrawal} withdrawal refuses lock and leaves no irreversible reference`, async () => {
    const f = await fixture();
    try {
      for (const id of ids)
        for (const role of ['reviewerA', 'reviewerB'] as const) await f.submit(role, id);
      await f.snapshot(true);
      assert.equal(await f.verify(), true);
      if (withdrawal === 'assignment')
        await f.investigator('select public.rpc_withdraw_assignment($1,$2)', [
          await f.assignment('reviewerB', ids[0]),
          'Synthetic withdrawal regression.',
        ]);
      else
        await f.investigator('select public.rpc_withdraw_reviewer($1,$2)', [
          f.pseudo.reviewerB,
          'Synthetic withdrawal regression.',
        ]);
      assert.equal(await f.verify(), false);
      await assert.rejects(f.lock(), /snapshot integrity failure/);
      assert.equal((await f.db.query('select * from public.reference_locks')).rows.length, 0);
    } finally {
      await f.db.close();
    }
  });

test('unchanged snapshot locks every frozen level and later withdrawal cannot alter the reference', async () => {
  const f = await fixture();
  try {
    for (const id of ids)
      for (const role of ['reviewerA', 'reviewerB'] as const) await f.submit(role, id);
    await f.snapshot(true);
    await f.lock();
    assert.equal(
      (
        await f.db.query<{ n_case_levels_locked: number }>(
          'select n_case_levels_locked from public.reference_locks',
        )
      ).rows[0].n_case_levels_locked,
      2,
    );
    assert.equal(await f.verify(), true);
    await assert.rejects(
      f.investigator('select public.rpc_withdraw_assignment($1,$2)', [
        await f.assignment('reviewerB', ids[0]),
        'Synthetic post-lock withdrawal.',
      ]),
      /Locked reference prevents assignment withdrawal/,
    );
    await assert.rejects(
      f.investigator('select public.rpc_withdraw_reviewer($1,$2)', [
        f.pseudo.reviewerB,
        'Synthetic post-lock withdrawal.',
      ]),
      /Locked reference prevents assignment withdrawal/,
    );
    assert.equal(
      (
        await f.db.query<{ withdrawn_at: string | null }>(
          'select withdrawn_at from public.reviewers where reviewer_pseudo_id=$1',
          [f.pseudo.reviewerB],
        )
      ).rows[0].withdrawn_at,
      null,
    );
    assert.equal(await f.verify(), true);
    assert.equal(
      await rpc<number>(
        f.db,
        'investigator',
        'select count(*)::integer from public.v_adjudicated_reference_v4',
      ),
      2,
    );
  } finally {
    await f.db.close();
  }
});

test('incomplete close cannot silently omit a frozen level with no answers', async () => {
  const f = await fixture();
  try {
    await f.submit('reviewerA', ids[0]);
    await f.submit('reviewerB', ids[0]);
    await f.snapshot(false);
    assert.equal(await f.verify(), true);
    await assert.rejects(f.lock(), /frozen case levels have no independent judgment/);
    assert.equal((await f.db.query('select * from public.reference_locks')).rows.length, 0);
  } finally {
    await f.db.close();
  }
});

test('incomplete close retains the permitted single-reviewed adjudicated level', async () => {
  const f = await fixture();
  try {
    await f.submit('reviewerA', ids[0]);
    await f.submit('reviewerB', ids[0]);
    await f.submit('reviewerA', ids[1]);
    await f.snapshot(false);
    await assert.rejects(f.lock(), /have no adjudication/);
    await f.singleAdjudication(ids[1]);
    await f.lock();
    assert.equal(
      await rpc<number>(
        f.db,
        'investigator',
        'select count(*)::integer from public.v_adjudicated_reference_v4',
      ),
      2,
    );
    assert.equal(await f.verify(), true);
  } finally {
    await f.db.close();
  }
});

test('retained predictions for a withdrawn case prevent freeze and preserve all original rows', async () => {
  const f = await fixture({ freeze: false });
  try {
    const before = (await f.db.query('select * from public.frozen_predictions_v4 order by case_id'))
      .rows;
    await f.investigator('select public.rpc_withdraw_case($1,$2)', [
      ids[1],
      'Synthetic pre-freeze withdrawal.',
    ]);
    await assert.rejects(f.freeze(), /Predictions for withdrawn cases prevent freezing/);
    assert.equal((await f.db.query('select * from public.freeze_manifests_v4')).rows.length, 0);
    assert.deepEqual(
      (await f.db.query('select * from public.frozen_predictions_v4 order by case_id')).rows,
      before,
    );
  } finally {
    await f.db.close();
  }
});

test('successful freeze prevents subsequent case withdrawal; reference locks reject stale-snapshot isolation', async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      f.investigator('select public.rpc_withdraw_case($1,$2)', [
        ids[1],
        'Synthetic post-freeze withdrawal.',
      ]),
      /cannot be withdrawn/,
    );
    await assert.rejects(
      f.db.transaction(async (tx) => {
        await tx.exec('set transaction isolation level repeatable read');
        await tx.exec('set local role authenticated');
        await tx.query("select set_config('request.jwt.claims',$1,true)", [
          j({ sub: ACTORS.investigator, aal: 'aal2' }),
        ]);
        return tx.query('select public.rpc_lock_reference_v4($1)', [ATT]);
      }),
      /Reference locking requires READ COMMITTED/,
    );
  } finally {
    await f.db.close();
  }
});

async function prepareModuleB(f: Awaited<ReturnType<typeof fixture>>) {
  const unit = 'MB4-ROW-TESTFX_LOCK';
  await f.investigator('select public.rpc_import_mb_unit_v4($1)', [
    j({
      mb_unit_id: unit,
      unit_type: 'CONDITION_ROW_BENCHMARK',
      packet: {
        schema_version: '1.0',
        unit: { unit_type: 'CONDITION_ROW_BENCHMARK', unit_id: unit },
        question: 'Synthetic benchmark compatibility?',
        row: { condition_row: 'Fictional condition' },
        benchmark_definition: {
          source: 'Synthetic benchmark',
          population: 'Fictional adults',
          case_definition: 'Fictional definition',
        },
        notices: ['SYNTHETIC ENGINEERING ONLY'],
      },
      design: {
        row_id: 'SYN-ROW-LOCK',
        stratum: 'SYN-MB',
        frame_n: 2,
        selection_probability: 0.5,
        benchmark_id: 'SYN-BENCHMARK',
      },
    }),
  ]);
  await f.investigator('select public.rpc_freeze_mb_manifest_v4($1)', [ATT]);
  await f.investigator('select public.rpc_mb_phase_v4($1,$2)', ['MB_OPENED', ATT]);
  await f.investigator('select public.rpc_assign_mb_units_v4($1,$2,$3,$4)', [
    f.pseudo.reviewerA,
    1,
    [unit],
    123,
  ]);
  const assignment = (
    await f.db.query<{ mb_assignment_id: string }>(
      'select mb_assignment_id from public.mb_assignments_v4',
    )
  ).rows[0].mb_assignment_id;
  return {
    unit,
    assignment,
    submit: () =>
      rpc(f.db, 'reviewerA', 'select public.rpc_submit_mb_response_v4($1,$2)', [
        assignment,
        j({
          compatibility: 'COMPATIBLE',
          rationale: 'Synthetic benchmark response.',
          uncertain: false,
        }),
      ]),
  };
}

test('Module B final response cannot be resubmitted through RPC or direct insert', async () => {
  const f = await fixture();
  try {
    const mb = await prepareModuleB(f);
    await mb.submit();
    const before = (await f.db.query('select * from public.mb_responses_v4')).rows;
    await assert.rejects(mb.submit(), /Module B response is final/);
    await assert.rejects(
      f.db.query(
        "insert into public.mb_responses_v4(mb_assignment_id,mb_unit_id,reviewer_pseudo_id,revision_number,compatibility,uncertain) values($1,$2,$3,2,'COMPATIBLE',false)",
        [mb.assignment, mb.unit, f.pseudo.reviewerA],
      ),
      /Module B response is final/,
    );
    assert.deepEqual((await f.db.query('select * from public.mb_responses_v4')).rows, before);
  } finally {
    await f.db.close();
  }
});

test('upgrade preserves legacy Module B revisions and prevents any further resubmission', async () => {
  const f = await fixture({ latest: false });
  try {
    const mb = await prepareModuleB(f);
    await mb.submit();
    await mb.submit();
    const before = (
      await f.db.query('select * from public.mb_responses_v4 order by revision_number')
    ).rows;
    assert.equal(before.length, 2);
    await f.db.exec(await readFile(MIGRATION, 'utf8'));
    await assert.rejects(mb.submit(), /Module B response is final/);
    assert.deepEqual(
      (await f.db.query('select * from public.mb_responses_v4 order by revision_number')).rows,
      before,
    );
  } finally {
    await f.db.close();
  }
});

test('existing persistent database receives 0006 exactly once across restarts', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'verify-reference-upgrade-'));
  try {
    const db = await migratedDb(false, dir);
    await db.query(
      "insert into public.verify_cases(id,kind,packet) values('SYN-901','DESCRIPTOR',$1)",
      [j({ title: 'Fictional preserved packet' })],
    );
    const before = (await db.query('select * from public.verify_cases')).rows;
    await db.close();
    const script = `import {getDb} from './src/server/db.ts'; const db=await getDb(); console.log(JSON.stringify({versions:(await db.query("select count(*)::integer as n from public.app_schema_version where version='4.0.3-reference-integrity'")).rows[0].n,cases:(await db.query('select * from public.verify_cases')).rows})); await db.close();`;
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await promisify(execFile)(
        process.execPath,
        ['--import', 'tsx', '--input-type=module', '-e', script],
        { cwd: process.cwd(), env: { ...process.env, VERIFY_DB_DIR: dir } },
      );
      assert.deepEqual(JSON.parse(result.stdout.trim()), { versions: 1, cases: before });
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
