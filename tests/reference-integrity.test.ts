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
const FROZEN_MIGRATION = 'migrations/0007_frozen_contract_guards.sql';
const TRIAL_CONCURRENCY_MIGRATION = 'migrations/0008_trial_packet_and_concurrency_guards.sql';
const CANONICAL_LOCK_STATE_MIGRATION = 'migrations/0009_canonical_packet_and_lock_state_guards.sql';
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

async function migratedDb(latest = true, dataDir?: string, through = 9) {
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
  if (latest && through >= 7) files.push(FROZEN_MIGRATION);
  if (latest && through >= 8) files.push(TRIAL_CONCURRENCY_MIGRATION);
  if (latest && through >= 9) files.push(CANONICAL_LOCK_STATE_MIGRATION);
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
async function fixture(
  options: {
    latest?: boolean;
    freeze?: boolean;
    through?: number;
    scope?: 'DISAGREEMENTS_ONLY' | 'ALL_CASE_LEVELS';
    dataDir?: string;
    trialDesign?: 'one-step' | 'two-step';
  } = {},
) {
  const db = await migratedDb(options.latest ?? true, options.dataDir, options.through ?? 9);
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
      options.scope ?? 'DISAGREEMENTS_ONLY',
      ATT,
    ]);
    for (const id of ids) {
      const input = caseInput(id, 'FORMAL');
      const trial = { nct_id: 'SYN-NCT-9001', brief_title: 'Fictional upgrade trial' };
      await investigator('select public.rpc_import_case($1)', [
        j(
          options.trialDesign
            ? {
                ...input,
                unit_type: 'TRIAL_AREA',
                packet: {
                  ...input.packet,
                  unit: { ...input.packet.unit, unit_type: 'TRIAL_AREA' },
                  trial,
                },
                design: { ...input.design, nct_id: trial.nct_id },
              }
            : input,
        ),
      ]);
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
          curated_v11_status_raw:
            options.trialDesign === 'two-step' ? 'CONTEXT_DEPENDENT' : 'INCLUDE',
          curated_v11_binary: 'INCLUDE',
          two_step_required: options.trialDesign === 'two-step',
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
    if (options.trialDesign === 'two-step') {
      for (const id of ids)
        await investigator('select public.rpc_add_trial_context_packet($1,$2)', [
          id,
          j({
            schema_version: '1.0',
            trial: { nct_id: 'SYN-NCT-9001', brief_title: 'Fictional upgrade trial context' },
            notices: ['SYNTHETIC ENGINEERING ONLY'],
          }),
        ]);
    }
    await investigator('select public.rpc_import_frozen_predictions_v4($1)', [
      j(
        ids.flatMap((id) =>
          (options.trialDesign === 'two-step'
            ? ['DESCRIPTOR_LEVEL_IN_TRIAL_CASE', 'TRIAL_LEVEL']
            : ['DESCRIPTOR_LEVEL']
          ).map((level) => ({
            prediction_set_id: 'SYN-PREDICTION-REF',
            case_id: id,
            determination_level: level,
            tier0_binary: 'INCLUDE',
            tier1_version: 'v1.1',
            tier1_status_raw: options.trialDesign === 'two-step' ? 'CONTEXT_DEPENDENT' : 'INCLUDE',
            tier1_binary: 'INCLUDE',
            ...(level === 'TRIAL_LEVEL' ? { stage_c_trial_status: 'INCLUDE' } : {}),
          })),
        ),
      ),
    ]);
    const freeze = async (extra: Record<string, unknown> = {}) => {
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
      return investigator('select public.rpc_freeze_v4($1)', [j({ ...freezePayload, ...extra })]);
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
    const submit = async (role: 'reviewerA' | 'reviewerB', caseId: string, decision = 'INCLUDE') =>
      rpc(db, role, 'select public.rpc_submit_review($1,$2)', [
        await assignment(role, caseId),
        j({
          l1_decision: decision,
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

async function prepareModuleB(f: Awaited<ReturnType<typeof fixture>>, extraUnits: string[] = []) {
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
  for (const extra of extraUnits) {
    await f.investigator('select public.rpc_import_mb_unit_v4($1)', [
      j({
        mb_unit_id: extra,
        unit_type: 'CONDITION_ROW_BENCHMARK',
        packet: {
          schema_version: '1.0',
          unit: { unit_type: 'CONDITION_ROW_BENCHMARK', unit_id: extra },
          question: 'Fictional benchmark compatibility?',
          row: { condition_row: 'Fictional condition' },
          benchmark_definition: { source: 'Synthetic source' },
          notices: ['SYNTHETIC ENGINEERING ONLY'],
        },
        design: {
          row_id: `SYN-${extra}`,
          stratum: 'SYN-MB',
          frame_n: 2,
          selection_probability: 0.5,
          benchmark_id: 'SYN-BENCHMARK',
        },
      }),
    ]);
  }
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

type Fixture = Awaited<ReturnType<typeof fixture>>;
async function adjudicationPayload(
  f: Fixture,
  caseId: string,
  status: string,
  decision: string | null,
  basis: string,
  extra: Record<string, unknown> = {},
) {
  const considered = (
    await f.db.query<{ review_id: string }>(
      'select review_id from public.reviews where case_id=$1',
      [caseId],
    )
  ).rows.map((r) => r.review_id);
  return {
    case_id: caseId,
    determination_level: 'DESCRIPTOR_LEVEL',
    status,
    decision,
    basis,
    rationale: 'Synthetic adjudication semantics regression.',
    considered_ids: considered,
    ...extra,
  };
}
async function adjudication(
  f: Fixture,
  caseId: string,
  status: string,
  decision: string | null,
  basis: string,
  extra: Record<string, unknown> = {},
) {
  return rpc<string>(f.db, 'adjudicator', 'select public.rpc_record_adjudication_v3($1)', [
    j(await adjudicationPayload(f, caseId, status, decision, basis, extra)),
  ]);
}
async function completeReviews(f: Fixture) {
  for (const id of ids)
    for (const role of ['reviewerA', 'reviewerB'] as const) await f.submit(role, id);
  await f.snapshot(true);
}

test('formal adjudication rejects contradictory status or basis before insertion and accepts justified decisions', async () => {
  const f = await fixture({ scope: 'ALL_CASE_LEVELS' });
  try {
    await f.submit('reviewerA', ids[0]);
    await f.submit('reviewerB', ids[0]);
    await f.submit('reviewerA', ids[1]);
    await f.submit('reviewerB', ids[1], 'EXCLUDE');
    await f.snapshot(true);
    const invalid = [
      [ids[0], 'CONCORDANT_CONFIRMED', 'EXCLUDE', 'NEITHER'],
      [ids[0], 'CONCORDANT_REVISED', 'INCLUDE', 'BOTH_REVIEWERS'],
      [ids[0], 'CONCORDANT_REVISED', 'EXCLUDE', 'REVIEWER_1'],
      [ids[0], 'CONCORDANT_REVISED', 'EXCLUDE', 'REVIEWER_2'],
      [ids[0], 'CONCORDANT_REVISED', 'EXCLUDE', 'BOTH_REVIEWERS'],
      [ids[0], 'CONCORDANT_CONFIRMED', 'INCLUDE', 'NEITHER'],
      [ids[1], 'DISCORDANT_RESOLVED', 'EXCLUDE', 'REVIEWER_1'],
      [ids[1], 'DISCORDANT_RESOLVED', 'INCLUDE', 'REVIEWER_2'],
      [ids[1], 'DISCORDANT_RESOLVED', 'INCLUDE', 'BOTH_REVIEWERS'],
      [ids[1], 'DISCORDANT_RESOLVED', 'INCLUDE', 'NEITHER'],
    ];
    for (const [caseId, status, decision, basis] of invalid)
      await assert.rejects(
        adjudication(f, caseId, status, decision, basis, { reason_code: 'CONSTRUCT_BOUNDARY' }),
        /Adjudication semantics/,
      );
    assert.equal(
      (await f.db.query("select * from public.adjudications where mode='FORMAL'")).rows.length,
      0,
    );
    await adjudication(f, ids[0], 'CONCORDANT_REVISED', 'EXCLUDE', 'NEITHER');
    await adjudication(f, ids[1], 'DISCORDANT_RESOLVED', 'EXCLUDE', 'REVIEWER_2', {
      reason_code: 'CONSTRUCT_BOUNDARY',
    });
    await f.lock();
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

test('invalid legacy adjudication blocks lock without rewriting and a valid explicit supersession repairs provenance', async () => {
  const f = await fixture({ through: 6, scope: 'ALL_CASE_LEVELS' });
  try {
    await completeReviews(f);
    const bad = await adjudication(f, ids[0], 'CONCORDANT_CONFIRMED', 'EXCLUDE', 'NEITHER');
    await adjudication(f, ids[1], 'CONCORDANT_CONFIRMED', 'INCLUDE', 'BOTH_REVIEWERS');
    const before = (
      await f.db.query(
        "select * from public.adjudications where mode='FORMAL' order by adjudication_id",
      )
    ).rows;
    await f.db.exec(await readFile(FROZEN_MIGRATION, 'utf8'));
    await assert.rejects(f.lock(), /Adjudication semantics/);
    assert.equal((await f.db.query('select * from public.reference_locks')).rows.length, 0);
    assert.deepEqual(
      (
        await f.db.query(
          "select * from public.adjudications where mode='FORMAL' order by adjudication_id",
        )
      ).rows,
      before,
    );
    const corrected = await adjudication(
      f,
      ids[0],
      'CONCORDANT_CONFIRMED',
      'INCLUDE',
      'BOTH_REVIEWERS',
      { supersedes: bad },
    );
    await f.lock();
    assert.equal(
      await rpc<string>(
        f.db,
        'investigator',
        'select adjudication_id from public.v_adjudicated_reference_v4 where case_id=$1',
        [ids[0]],
      ),
      `ADJ4-${corrected.replaceAll('-', '')}`,
    );
  } finally {
    await f.db.close();
  }
});

test('tied adjudication timestamps select the blinded supersession leaf and later revisions preserve it', async () => {
  const f = await fixture({ through: 6, scope: 'ALL_CASE_LEVELS' });
  try {
    await completeReviews(f);
    const first = await adjudicationPayload(
      f,
      ids[0],
      'CONCORDANT_CONFIRMED',
      'EXCLUDE',
      'NEITHER',
    );
    const second = await adjudicationPayload(
      f,
      ids[0],
      'CONCORDANT_CONFIRMED',
      'INCLUDE',
      'BOTH_REVIEWERS',
    );
    const corrected = await rpc<string>(
      f.db,
      'adjudicator',
      "with first as (select public.rpc_record_adjudication_v3($1) as id) select public.rpc_record_adjudication_v3($2::jsonb || jsonb_build_object('supersedes',id)) from first",
      [j(first), j(second)],
    );
    assert.equal(
      (
        await f.db.query<{ n: number }>(
          'select count(distinct decided_at)::integer as n from public.adjudications where case_id=$1',
          [ids[0]],
        )
      ).rows[0].n,
      1,
    );
    await f.db.exec(await readFile(FROZEN_MIGRATION, 'utf8'));
    await adjudication(f, ids[1], 'UNRESOLVED_ESCALATED', null, 'NONE');
    await f.lock();
    assert.equal(
      await rpc<null>(
        f.db,
        'investigator',
        'select adjudicated_decision from public.v_adjudicated_reference_v4 where case_id=$1',
        [ids[1]],
      ),
      null,
    );
    const primary = () =>
      rpc<string>(
        f.db,
        'investigator',
        'select adjudication_id from public.v_adjudicated_reference_v4 where case_id=$1',
        [ids[0]],
      );
    assert.equal(await primary(), `ADJ4-${corrected.replaceAll('-', '')}`);
    await adjudication(f, ids[0], 'CONCORDANT_REVISED', 'EXCLUDE', 'NEITHER', {
      supersedes: corrected,
    });
    assert.equal(await primary(), `ADJ4-${corrected.replaceAll('-', '')}`);
    assert.equal(
      await rpc<boolean>(
        f.db,
        'investigator',
        'select post_unblinding_revision_exists from public.v_adjudicated_reference_v4 where case_id=$1',
        [ids[0]],
      ),
      true,
    );
  } finally {
    await f.db.close();
  }
});

test('multiple legacy primary adjudication leaves fail closed instead of exporting duplicate references', async () => {
  const f = await fixture({ through: 6, scope: 'ALL_CASE_LEVELS' });
  try {
    await completeReviews(f);
    await adjudication(f, ids[0], 'CONCORDANT_CONFIRMED', 'INCLUDE', 'BOTH_REVIEWERS');
    await adjudication(f, ids[1], 'CONCORDANT_CONFIRMED', 'INCLUDE', 'BOTH_REVIEWERS');
    // Deliberate owner-level corruption fixture models a legacy concurrent fork.
    // Only this injection disables the supersession checker; ordinary RPC fixtures never do.
    await f.db.exec('alter table public.adjudications disable trigger adjudications_before_insert');
    try {
      await adjudication(f, ids[0], 'CONCORDANT_REVISED', 'EXCLUDE', 'NEITHER');
    } finally {
      await f.db.exec(
        'alter table public.adjudications enable trigger adjudications_before_insert',
      );
    }
    await f.db.exec(await readFile(FROZEN_MIGRATION, 'utf8'));
    await assert.rejects(f.lock(), /multiple primary adjudication leaves/);
    assert.equal((await f.db.query('select * from public.reference_locks')).rows.length, 0);
  } finally {
    await f.db.close();
  }
});

for (const partial of [false, true])
  test(`Module B lock rejects frozen units with zero responses (${partial ? 'partial' : 'entirely empty'} module)`, async () => {
    const f = await fixture();
    try {
      const mb = await prepareModuleB(f, ['MB4-ROW-TESTFX_EMPTY']);
      if (partial) await mb.submit();
      await f.investigator('select public.rpc_mb_phase_v4($1,$2)', ['MB_CLOSED', ATT]);
      await assert.rejects(
        f.investigator('select public.rpc_lock_mb_reference_v4($1)', [ATT]),
        /frozen Module B units have no independent response/,
      );
      assert.equal((await f.db.query('select * from public.mb_reference_lock_v4')).rows.length, 0);
    } finally {
      await f.db.close();
    }
  });

test('Module B single-response unit can lock after its required independent adjudication', async () => {
  const f = await fixture();
  try {
    const mb = await prepareModuleB(f);
    await mb.submit();
    await f.investigator('select public.rpc_mb_phase_v4($1,$2)', ['MB_CLOSED', ATT]);
    await assert.rejects(
      f.investigator('select public.rpc_lock_mb_reference_v4($1)', [ATT]),
      /need adjudication/,
    );
    await rpc(f.db, 'adjudicator', 'select public.rpc_record_mb_adjudication_v4($1)', [
      j({
        mb_unit_id: mb.unit,
        decision: 'COMPATIBLE',
        status: 'SINGLE_REVIEW_ADJUDICATED',
        basis: 'REVIEWER_1',
        rationale: 'Synthetic single-response adjudication.',
      }),
    ]);
    await f.investigator('select public.rpc_lock_mb_reference_v4($1)', [ATT]);
    assert.equal(
      (await f.db.query<{ n_units: number }>('select n_units from public.mb_reference_lock_v4'))
        .rows[0].n_units,
      1,
    );
  } finally {
    await f.db.close();
  }
});

test('held-out packet versions are configurable before freeze and immutable afterward even with the same version set', async () => {
  const f = await fixture({ freeze: false });
  try {
    const add = () =>
      f.investigator('select public.rpc_add_case_version($1,$2,$3,true,false,false,$4)', [
        ids[0],
        j(caseInput(ids[0], 'FORMAL').packet),
        '1.0.0+R-TEST',
        'Synthetic pre-freeze packet correction.',
      ]);
    await add();
    assert.equal(
      (
        await f.db.query<{ n: number }>(
          'select count(*)::integer as n from public.case_versions where case_id=$1',
          [ids[0]],
        )
      ).rows[0].n,
      2,
    );
    await f.freeze();
    const before = (
      await f.db.query('select * from public.case_versions where case_id=$1 order by version', [
        ids[0],
      ])
    ).rows;
    await assert.rejects(add(), /Frozen held-out evidence packets cannot be versioned/);
    await assert.rejects(
      f.db.query(
        "insert into public.case_versions(case_id,mode,version,version_set_id,l1_applicable,l2_applicable,l3_applicable,packet,packet_sha256,change_reason,created_by) select case_id,mode,version,version_set_id,l1_applicable,l2_applicable,l3_applicable,packet,packet_sha256,'Synthetic direct insert regression',created_by from public.case_versions where case_id=$1 order by version desc limit 1",
        [ids[0]],
      ),
      /Frozen held-out evidence packets cannot be versioned/,
    );
    assert.deepEqual(
      (
        await f.db.query('select * from public.case_versions where case_id=$1 order by version', [
          ids[0],
        ])
      ).rows,
      before,
    );
  } finally {
    await f.db.close();
  }
});

async function extension(f: Fixture, id: string, amendment: string) {
  await f.investigator('select public.rpc_import_case($1)', [j(caseInput(id, 'FORMAL'))]);
  await f.investigator('select public.rpc_set_case_design_v3($1)', [
    j({
      case_id: id,
      mode: 'FORMAL',
      review_module: 'ONTOLOGY_AREA',
      analysis_set: 'VALIDATION_HELDOUT',
      selection_stratum: 'SYN-EXTENSION',
      variance_stratum: 'SYN-EXTENSION',
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
  await f.investigator('select public.rpc_record_heldout_case_v4($1)', [
    j({
      case_id: id,
      record_category: 'HELDOUT_EXTENSION_APPROVED',
      frame_unit_id: `SYN-FRAME-${id}`,
      provenance_audit_result: 'NO_DEVELOPMENT_FLAG',
      amendment_id: amendment,
    }),
  ]);
  await f.investigator('select public.rpc_import_frozen_predictions_v4($1)', [
    j([
      {
        prediction_set_id: 'SYN-PREDICTION-REF',
        case_id: id,
        determination_level: 'DESCRIPTOR_LEVEL',
        tier0_binary: 'INCLUDE',
        tier1_version: 'v1.1',
        tier1_status_raw: 'INCLUDE',
        tier1_binary: 'INCLUDE',
      },
    ]),
  ]);
}
async function extensionAmendments(f: Fixture) {
  for (const amendment_id of ['AMD4-TESTFX-EXT-A', 'AMD4-TESTFX-EXT-B'])
    await f.investigator('select public.rpc_register_amendment_v4($1)', [
      j({
        amendment_id,
        purpose: 'ADOPT_EXTENSION_30',
        description: 'Synthetic extension authorization for regression only.',
      }),
    ]);
}

test('extension freeze rejects missing or unrelated authorization and accepts the matching amendment', async () => {
  const f = await fixture({ freeze: false });
  try {
    await extensionAmendments(f);
    await extension(f, 'HO4R-TESTFX-EXT1', 'AMD4-TESTFX-EXT-A');
    await assert.rejects(f.freeze(), /extension amendment must match/);
    await assert.rejects(
      f.investigator('select public.rpc_freeze_v4($1)', [
        j({ ...freezePayload, extension_amendment_id: 'AMD4-TESTFX-EXT-B' }),
      ]),
      /extension amendment must match/,
    );
    assert.equal((await f.db.query('select * from public.freeze_manifests_v4')).rows.length, 0);
    await f.investigator('select public.rpc_freeze_v4($1)', [
      j({ ...freezePayload, extension_amendment_id: 'AMD4-TESTFX-EXT-A' }),
    ]);
    assert.equal(
      (
        await f.db.query<{ extension_amendment_id: string }>(
          'select extension_amendment_id from public.freeze_manifests_v4',
        )
      ).rows[0].extension_amendment_id,
      'AMD4-TESTFX-EXT-A',
    );
  } finally {
    await f.db.close();
  }
});

test('mixed extension authorizations cannot form one freeze and non-extension samples require null', async () => {
  for (const mixed of [true, false]) {
    const f = await fixture({ freeze: false });
    try {
      await extensionAmendments(f);
      if (mixed) {
        await extension(f, 'HO4R-TESTFX-EXT1', 'AMD4-TESTFX-EXT-A');
        await extension(f, 'HO4R-TESTFX-EXT2', 'AMD4-TESTFX-EXT-B');
      }
      await assert.rejects(
        f.freeze({ extension_amendment_id: 'AMD4-TESTFX-EXT-A' }),
        /extension amendment must match/,
      );
      assert.equal((await f.db.query('select * from public.freeze_manifests_v4')).rows.length, 0);
      if (!mixed) await f.investigator('select public.rpc_freeze_v4($1)', [j(freezePayload)]);
    } finally {
      await f.db.close();
    }
  }
});

test('persistent 0006 database receives 0007 once and preserves existing synthetic packets', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'verify-frozen-upgrade-'));
  try {
    const db = await migratedDb(true, dir, 6);
    await db.query(
      "insert into public.verify_cases(id,kind,packet) values('SYN-901','DESCRIPTOR',$1)",
      [j({ title: 'Fictional preserved packet' })],
    );
    const before = (await db.query('select * from public.verify_cases')).rows;
    await db.close();
    const script = `import {getDb} from './src/server/db.ts'; const db=await getDb(); console.log(JSON.stringify({versions:(await db.query("select count(*)::integer as n from public.app_schema_version where version='4.0.4-frozen-contract'")).rows[0].n,cases:(await db.query('select * from public.verify_cases')).rows})); await db.close();`;
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

for (const unresolved of [false, true])
  test(`0007 refuses an already locked formal reference without changing records or exports (${unresolved ? 'unresolved' : 'confirmed'})`, async () => {
    const f = await fixture({ through: 6, scope: 'ALL_CASE_LEVELS' });
    try {
      await completeReviews(f);
      await adjudication(
        f,
        ids[0],
        unresolved ? 'UNRESOLVED_ESCALATED' : 'CONCORDANT_CONFIRMED',
        unresolved ? null : 'INCLUDE',
        unresolved ? 'NONE' : 'BOTH_REVIEWERS',
      );
      await adjudication(f, ids[1], 'CONCORDANT_CONFIRMED', 'INCLUDE', 'BOTH_REVIEWERS');
      await f.lock();
      const before = {
        schema: (await f.db.query('select * from public.app_schema_version order by version')).rows,
        view: await rpc(
          f.db,
          'investigator',
          'select jsonb_agg(to_jsonb(v) order by v.case_id) from public.v_adjudicated_reference_v4 v',
        ),
        lock: (await f.db.query('select * from public.reference_locks')).rows,
        responses: (await f.db.query('select * from public.adjudications order by adjudication_id'))
          .rows,
        definition: (
          await f.db.query(
            "select pg_get_viewdef('public.v_adjudicated_reference_v4'::regclass) as text",
          )
        ).rows,
      };
      await assert.rejects(
        f.db.exec(await readFile(FROZEN_MIGRATION, 'utf8')),
        /Existing locked formal reference requires explicit investigator migration review/,
      );
      await f.db.exec('rollback');
      const after = {
        schema: (await f.db.query('select * from public.app_schema_version order by version')).rows,
        view: await rpc(
          f.db,
          'investigator',
          'select jsonb_agg(to_jsonb(v) order by v.case_id) from public.v_adjudicated_reference_v4 v',
        ),
        lock: (await f.db.query('select * from public.reference_locks')).rows,
        responses: (await f.db.query('select * from public.adjudications order by adjudication_id'))
          .rows,
        definition: (
          await f.db.query(
            "select pg_get_viewdef('public.v_adjudicated_reference_v4'::regclass) as text",
          )
        ).rows,
      };
      assert.deepEqual(after, before);
    } finally {
      await f.db.close();
    }
  });

test('0007 upgrades a completed locked synthetic pilot without changing recorded responses', async () => {
  const f = await fixture({ through: 6 });
  try {
    await f.db.query(
      "insert into public.verify_cases(id,kind,packet) values('SYN-901','DESCRIPTOR',$1)",
      [j({ title: 'Fictional local pilot migration case' })],
    );
    await f.db.query(
      "insert into public.verify_assignments(case_id,reviewer_id,position) values('SYN-901',$1,1),('SYN-901',$2,1)",
      [ACTORS.reviewerA, ACTORS.reviewerB],
    );
    const response = {
      decision: 'INCLUDE',
      rationale: 'Synthetic pilot upgrade judgment.',
      uncertain: false,
      packetProblem: false,
      context: '',
    };
    for (const actor of ['reviewerA', 'reviewerB'] as const)
      await rpc(f.db, actor, "select public.rpc_verify_submit('SYN-901','DESCRIPTOR_LEVEL',$1)", [
        j(response),
      ]);
    for (const action of ['CLOSE_REVIEW', 'AUTHORIZE_ADJUDICATION'])
      await f.investigator('select public.rpc_verify_admin($1)', [j({ action, attestation: ATT })]);
    await rpc(
      f.db,
      'adjudicator',
      "select public.rpc_verify_adjudicate('SYN-901','DESCRIPTOR_LEVEL',$1)",
      [
        j({
          ...response,
          status: 'RESOLVED',
          basis: 'Both fictional reviewers.',
          reasonCode: 'OTHER',
        }),
      ],
    );
    await f.investigator('select public.rpc_verify_admin($1)', [
      j({ action: 'LOCK_REFERENCE', attestation: ATT }),
    ]);
    const before = await rpc<Record<string, unknown>>(
      f.db,
      'investigator',
      'select public.rpc_verify_export()',
    );
    await f.db.exec(await readFile(FROZEN_MIGRATION, 'utf8'));
    const after = await rpc<Record<string, unknown>>(
      f.db,
      'investigator',
      'select public.rpc_verify_export()',
    );
    assert.equal(after.schemaVersion, '4.0.4-frozen-contract');
    assert.deepEqual({ ...after, schemaVersion: before.schemaVersion }, before);
  } finally {
    await f.db.close();
  }
});

test('0007 preflight rejects stale-snapshot transaction isolation without applying changes', async () => {
  const db = await migratedDb(true, undefined, 6);
  try {
    const before = (await db.query('select * from public.app_schema_version order by version'))
      .rows;
    await db.exec("set default_transaction_isolation = 'repeatable read'");
    await assert.rejects(
      db.exec(await readFile(FROZEN_MIGRATION, 'utf8')),
      /Frozen-contract migration requires READ COMMITTED isolation/,
    );
    await db.exec('rollback');
    await db.exec("set default_transaction_isolation = 'read committed'");
    assert.deepEqual(
      (await db.query('select * from public.app_schema_version order by version')).rows,
      before,
    );
    assert.equal(
      (
        await db.query<{ definition: string | null }>(
          "select to_regprocedure('private.assert_adjudication_semantics_v4(text,text,text,text,text,text)')::text as definition",
        )
      ).rows[0].definition,
      null,
    );
  } finally {
    await db.close();
  }
});

test('0008 enforces two-step TRIAL_AREA design, requires Step-2 trial_context_packets before freeze, and blocks post-freeze Step-2 packet mutations', async () => {
  const f = await fixture({ freeze: false });
  try {
    const trialId = 'HO4-TESTFX-TRIAL1';
    const baseInput = caseInput(trialId, 'FORMAL');
    const trialCase = {
      ...baseInput,
      unit_type: 'TRIAL_AREA',
      packet: {
        ...baseInput.packet,
        unit: { unit_type: 'TRIAL_AREA', unit_id: `SYN-${trialId}::infectious` },
        trial: { nct_id: 'SYN-NCT-0101', brief_title: 'Fictional trial Step 1' },
      },
      design: {
        ...baseInput.design,
        nct_id: 'SYN-NCT-0101',
      },
    };
    await f.investigator('select public.rpc_import_case($1)', [j(trialCase)]);
    await f.investigator('select public.rpc_record_heldout_case_v4($1)', [
      j({
        case_id: trialId,
        record_category: 'HELDOUT_FORMAL',
        frame_unit_id: `SYN-FRAME-${trialId}`,
        impact_tier: 'LOW',
        policy_governed_neoplasm_gen06: false,
        provenance_audit_result: 'NO_DEVELOPMENT_FLAG',
      }),
    ]);

    // Before rpc_set_case_design_v3 is called, TRIAL_AREA must still require two-step levels and reject DESCRIPTOR_LEVEL.
    await assert.rejects(
      f.investigator('select public.rpc_import_frozen_predictions_v4($1)', [
        j([
          {
            prediction_set_id: 'SYN-PREDICTION-REF',
            case_id: trialId,
            determination_level: 'DESCRIPTOR_LEVEL',
            tier0_binary: 'INCLUDE',
            tier1_version: 'v1.1',
            tier1_status_raw: 'RETAINED',
            tier1_binary: 'INCLUDE',
          },
        ]),
      ]),
      /determination level DESCRIPTOR_LEVEL does not apply to case/,
    );

    // rpc_set_case_design_v3 must reject two_step_required = false for TRIAL_AREA.
    await assert.rejects(
      f.investigator('select public.rpc_set_case_design_v3($1)', [
        j({
          case_id: trialId,
          mode: 'FORMAL',
          review_module: 'ONTOLOGY_AREA',
          analysis_set: 'VALIDATION_HELDOUT',
          selection_stratum: 'SYN-STRATUM',
          variance_stratum: 'SYN-VARIANCE',
          variance_stratum_size: 20,
          selection_probability: 0.5,
          comparison_cell_v11: 'OPOS_CPOS',
          original_binary: 'INCLUDE',
          curated_v11_status_raw: 'CONTEXT_DEPENDENT',
          curated_v11_binary: 'INCLUDE',
          two_step_required: false,
          sampling_design_version: 'SYN-REF-TEST',
        }),
      ]),
      /FORMAL TRIAL_AREA cases require two_step_required = true/,
    );

    await f.investigator('select public.rpc_set_case_design_v3($1)', [
      j({
        case_id: trialId,
        mode: 'FORMAL',
        review_module: 'ONTOLOGY_AREA',
        analysis_set: 'VALIDATION_HELDOUT',
        selection_stratum: 'SYN-STRATUM',
        variance_stratum: 'SYN-VARIANCE',
        variance_stratum_size: 20,
        selection_probability: 0.5,
        comparison_cell_v11: 'OPOS_CPOS',
        original_binary: 'INCLUDE',
        curated_v11_status_raw: 'CONTEXT_DEPENDENT',
        curated_v11_binary: 'INCLUDE',
        two_step_required: true,
        sampling_design_version: 'SYN-REF-TEST',
      }),
    ]);

    await f.investigator('select public.rpc_import_frozen_predictions_v4($1)', [
      j([
        {
          prediction_set_id: 'SYN-PREDICTION-REF',
          case_id: trialId,
          determination_level: 'DESCRIPTOR_LEVEL_IN_TRIAL_CASE',
          tier0_binary: 'INCLUDE',
          tier1_version: 'v1.1',
          tier1_status_raw: 'CONTEXT_DEPENDENT',
          tier1_binary: 'INCLUDE',
        },
        {
          prediction_set_id: 'SYN-PREDICTION-REF',
          case_id: trialId,
          determination_level: 'TRIAL_LEVEL',
          tier0_binary: 'INCLUDE',
          tier1_version: 'v1.1',
          tier1_status_raw: 'CONTEXT_DEPENDENT',
          tier1_binary: 'EXCLUDE',
          stage_c_trial_status: 'EXCLUDE',
        },
      ]),
    ]);

    await f.investigator('select public.rpc_freeze_sample_manifest($1)', [
      j({
        review_module: 'ONTOLOGY_AREA',
        sampling_design_version: 'SYN-REF-TEST',
        manifest_file_sha256: '3'.repeat(64),
        decision_file_v11_sha256: '4'.repeat(64),
        sampling_seed: 123,
        attestation: ATT,
      }),
    ]);

    // Freezing before a Step-2 trial_context_packets row exists must fail.
    await assert.rejects(
      f.investigator('select public.rpc_freeze_v4($1)', [j(freezePayload)]),
      /active held-out trial cases lack two-step design or a frozen trial-context packet/,
    );

    const trialPacket = {
      schema_version: '1.0',
      trial: {
        nct_id: 'SYN-NCT-0101',
        brief_title: 'Fictional Step 2 trial context',
        conditions: ['Fictional condition'],
        summary: 'Synthetic Step-2 context packet.',
      },
      notices: ['SYNTHETIC ENGINEERING ONLY'],
    };
    await f.investigator('select public.rpc_add_trial_context_packet($1,$2)', [
      trialId,
      j(trialPacket),
    ]);

    await f.investigator('select public.rpc_freeze_v4($1)', [j(freezePayload)]);

    // After freeze, adding, updating, or deleting a Step-2 trial_context_packets row is forbidden.
    await assert.rejects(
      f.investigator('select public.rpc_add_trial_context_packet($1,$2)', [
        trialId,
        j(trialPacket),
      ]),
      /Frozen held-out trial context packets cannot be added or modified/,
    );
    await assert.rejects(
      f.db.query(
        "update public.trial_context_packets set packet_sha256 = repeat('f', 64) where case_id = $1",
        [trialId],
      ),
      /trial_context_packets is append-only/,
    );
    await assert.rejects(
      f.db.query('delete from public.trial_context_packets where case_id = $1', [trialId]),
      /trial_context_packets is append-only/,
    );
  } finally {
    await f.db.close();
  }
});

test('0008 enforces READ COMMITTED isolation on rpc_snapshot_judgments_v4 and validates Module B adjudication basis semantics', async () => {
  const f = await fixture();
  try {
    for (const id of ids) {
      for (const role of ['reviewerA', 'reviewerB'] as const) {
        await f.submit(role, id, 'INCLUDE');
      }
    }
    await f.investigator('select public.rpc_close_formal_review($1,$2)', [true, ATT]);

    await assert.rejects(
      f.db.transaction(async (tx) => {
        await tx.exec('set transaction isolation level repeatable read');
        await tx.exec('set local role authenticated');
        await tx.query("select set_config('request.jwt.claims',$1,true)", [
          j({ sub: ACTORS.investigator, aal: 'aal2' }),
        ]);
        return tx.query('select public.rpc_snapshot_judgments_v4()');
      }),
      /Judgment snapshotting requires READ COMMITTED isolation/,
    );

    // Module B basis semantics validation
    const mb = await prepareModuleB(f);
    await mb.submit(); // reviewerA (slot 1) submitted COMPATIBLE; reviewerB (slot 2) did not submit
    await f.investigator('select public.rpc_mb_phase_v4($1,$2)', ['MB_CLOSED', ATT]);

    await assert.rejects(
      rpc(f.db, 'adjudicator', 'select public.rpc_record_mb_adjudication_v4($1)', [
        j({
          mb_unit_id: mb.unit,
          decision: 'COMPATIBLE',
          status: 'SINGLE_REVIEW_ADJUDICATED',
          basis: 'REVIEWER_2',
          rationale: 'Cannot attribute to missing reviewer 2.',
        }),
      ]),
      /Module B adjudication semantics: REVIEWER_2 basis must adopt reviewer 2/,
    );

    await assert.rejects(
      rpc(f.db, 'adjudicator', 'select public.rpc_record_mb_adjudication_v4($1)', [
        j({
          mb_unit_id: mb.unit,
          decision: 'COMPATIBLE',
          status: 'SINGLE_REVIEW_ADJUDICATED',
          basis: 'NEITHER',
          rationale: 'Cannot claim NEITHER when decision equals reviewer 1.',
        }),
      ]),
      /Module B adjudication semantics: NEITHER basis must differ from all submitted answers/,
    );

    await rpc(f.db, 'adjudicator', 'select public.rpc_record_mb_adjudication_v4($1)', [
      j({
        mb_unit_id: mb.unit,
        decision: 'COMPATIBLE',
        status: 'SINGLE_REVIEW_ADJUDICATED',
        basis: 'REVIEWER_1',
        rationale: 'Adopts reviewer 1 single-reviewed answer.',
      }),
    ]);
    await f.investigator('select public.rpc_lock_mb_reference_v4($1)', [ATT]);
  } finally {
    await f.db.close();
  }
});

test('0008 upgrade is idempotent and refuses already locked formal references', async () => {
  const f = await fixture({ through: 7, scope: 'ALL_CASE_LEVELS' });
  try {
    await completeReviews(f);
    await adjudication(f, ids[0], 'CONCORDANT_CONFIRMED', 'INCLUDE', 'BOTH_REVIEWERS');
    await adjudication(f, ids[1], 'CONCORDANT_CONFIRMED', 'INCLUDE', 'BOTH_REVIEWERS');
    await f.lock();

    await assert.rejects(
      f.db.exec(await readFile(TRIAL_CONCURRENCY_MIGRATION, 'utf8')),
      /Existing locked formal reference requires explicit investigator migration review/,
    );
    await f.db.exec('rollback');
  } finally {
    await f.db.close();
  }

  const f2 = await fixture({ through: 8 });
  try {
    await f2.db.exec(await readFile(TRIAL_CONCURRENCY_MIGRATION, 'utf8'));
    const versions = (
      await f2.db.query<{ version: string }>(
        "select version from public.app_schema_version where version = '4.0.5-trial-packet-concurrency-guards'",
      )
    ).rows;
    assert.equal(versions.length, 1);
  } finally {
    await f2.db.close();
  }
});

test('persistent database created from original 0008 upgrades through getDb() loader to 0009, preserves existing records, and enforces new canonical packet and lock-state guards', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'verify-0008-to-0009-upgrade-'));
  try {
    // 1. Create a persisted database at original 0008 (072bfa0) before 0009 is applied
    const db = await migratedDb(true, dir, 8);
    for (const [role, id] of [
      ['INVESTIGATOR', '00000000-0000-4000-8000-000000000001'],
      ['REVIEWER', '00000000-0000-4000-8000-000000000002'],
      ['REVIEWER', '00000000-0000-4000-8000-000000000003'],
      ['ADJUDICATOR', '00000000-0000-4000-8000-000000000004'],
    ] as const) {
      const email = `upgrade-${id.slice(-1)}@example.invalid`;
      await db.query('insert into auth.users(id,email) values($1,$2)', [id, email]);
      await db.query(
        'insert into public.users(user_id,auth_uid,email,display_name,role,is_pilot_test_account) values($1,$1,$2,$3,$4,$5)',
        [id, email, `Synthetic ${role}`, role, false],
      );
    }
    await db.query(
      "insert into public.verify_cases(id,kind,packet) values('SYN-901','DESCRIPTOR',$1)",
      [j({ title: 'Fictional preserved 0008 case', area: 'Fictional construct' })],
    );
    await db.query(
      "insert into public.verify_assignments(case_id,reviewer_id,position) values('SYN-901','00000000-0000-4000-8000-000000000002',1),('SYN-901','00000000-0000-4000-8000-000000000003',1)",
    );

    // Under original 0008 (072bfa0), rpc_verify_author_case allowed a minimal packet with rubricPrompt
    await db.transaction(async (tx) => {
      await tx.exec('set local role authenticated');
      await tx.query("select set_config('request.jwt.claims',$1,true)", [
        j({ sub: '00000000-0000-4000-8000-000000000001', aal: 'aal2' }),
      ]);
      await tx.query('select public.rpc_verify_author_case($1)', [
        j({
          id: 'SYN-902',
          kind: 'DESCRIPTOR',
          packet: {
            title: 'Legacy 0008 authored case',
            area: 'Fictional area',
            rubricPrompt: 'Legacy prompt field allowed only before 0009',
          },
        }),
      ]);
    });

    // Submit a reviewer response in the 0008 database to verify response preservation across upgrade
    await db.transaction(async (tx) => {
      await tx.exec('set local role authenticated');
      await tx.query("select set_config('request.jwt.claims',$1,true)", [
        j({ sub: '00000000-0000-4000-8000-000000000002', aal: 'aal2' }),
      ]);
      await tx.query("select public.rpc_verify_submit('SYN-901','DESCRIPTOR_LEVEL',$1)", [
        j({
          decision: 'INCLUDE',
          rationale: 'Preserved reviewer judgment recorded under 0008.',
          uncertain: false,
          packetProblem: false,
          context: '',
        }),
      ]);
    });

    const beforeCases = JSON.parse(
      JSON.stringify((await db.query('select * from public.verify_cases order by id')).rows),
    );
    const beforeResponses = JSON.parse(
      JSON.stringify(
        (await db.query('select * from public.verify_responses order by sequence')).rows,
      ),
    );
    assert.equal(beforeCases.length, 2);
    assert.equal(beforeResponses.length, 1);
    await db.close();

    // 2. Upgrade through the actual application loader (getDb in src/server/db.ts) across two restarts
    const upgradeScript = `
      import { getDb, withActor } from './src/server/db.ts';
      const db = await getDb();
      const v0008 = (await db.query("select count(*)::integer as n from public.app_schema_version where version='4.0.5-trial-packet-concurrency-guards'")).rows[0].n;
      const v0009 = (await db.query("select count(*)::integer as n from public.app_schema_version where version='4.0.6-canonical-packet-lock-state'")).rows[0].n;
      const lockState = (await db.query("select singleton, frozen, reference_locked from private.v4_lock_state")).rows;
      const cases = (await db.query('select * from public.verify_cases order by id')).rows;
      const responses = (await db.query('select * from public.verify_responses order by sequence')).rows;

      let onlyDescriptorIdRejected = false;
      try {
        await withActor({ id: '00000000-0000-4000-8000-000000000001', role: 'INVESTIGATOR', displayName: 'Inv' }, (tx) =>
          tx.query('select public.rpc_verify_author_case($1)', [JSON.stringify({
            id: 'SYN-903',
            kind: 'DESCRIPTOR',
            packet: { descriptorId: 'TESTFX-D0903' },
          })])
        );
      } catch (err) {
        onlyDescriptorIdRejected = /canonical EvidencePacket structure/.test(String(err));
      }

      let rubricPromptRejected = false;
      try {
        await withActor({ id: '00000000-0000-4000-8000-000000000001', role: 'INVESTIGATOR', displayName: 'Inv' }, (tx) =>
          tx.query('select public.rpc_verify_author_case($1)', [JSON.stringify({
            id: 'SYN-904',
            kind: 'DESCRIPTOR',
            packet: { title: 'Bad', area: 'Bad', rubricPrompt: 'Disallowed in 0009' },
          })])
        );
      } catch (err) {
        rubricPromptRejected = /Packet key "rubricPrompt" is not allowed/.test(String(err));
      }

      console.log(JSON.stringify({
        v0008,
        v0009,
        lockState,
        cases,
        responses,
        onlyDescriptorIdRejected,
        rubricPromptRejected,
      }));
      await db.close();
    `;

    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await promisify(execFile)(
        process.execPath,
        ['--import', 'tsx', '--input-type=module', '-e', upgradeScript],
        { cwd: process.cwd(), env: { ...process.env, VERIFY_DB_DIR: dir } },
      );
      assert.deepEqual(JSON.parse(result.stdout.trim()), {
        v0008: 1,
        v0009: 1,
        lockState: [{ singleton: true, frozen: false, reference_locked: false }],
        cases: beforeCases,
        responses: beforeResponses,
        onlyDescriptorIdRejected: true,
        rubricPromptRejected: true,
      });
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('0009 refuses an already locked formal reference without changing records or exports, and upgrades a locked synthetic pilot cleanly', async () => {
  const f = await fixture({ through: 8, scope: 'ALL_CASE_LEVELS' });
  try {
    await completeReviews(f);
    await adjudication(f, ids[0], 'CONCORDANT_CONFIRMED', 'INCLUDE', 'BOTH_REVIEWERS');
    await adjudication(f, ids[1], 'CONCORDANT_CONFIRMED', 'INCLUDE', 'BOTH_REVIEWERS');
    await f.lock();
    const beforeSchema = (
      await f.db.query('select * from public.app_schema_version order by version')
    ).rows;

    await assert.rejects(
      f.db.exec(await readFile(CANONICAL_LOCK_STATE_MIGRATION, 'utf8')),
      /Existing locked formal reference requires explicit investigator migration review/,
    );
    await f.db.exec('rollback');
    assert.deepEqual(
      (await f.db.query('select * from public.app_schema_version order by version')).rows,
      beforeSchema,
    );
  } finally {
    await f.db.close();
  }

  const pilot = await fixture({ through: 8 });
  try {
    await pilot.db.query(
      "insert into public.verify_cases(id,kind,packet) values('SYN-901','DESCRIPTOR',$1)",
      [j({ title: 'Fictional local pilot 0008->0009 case' })],
    );
    await pilot.db.query(
      "insert into public.verify_assignments(case_id,reviewer_id,position) values('SYN-901',$1,1),('SYN-901',$2,1)",
      [ACTORS.reviewerA, ACTORS.reviewerB],
    );
    const response = {
      decision: 'INCLUDE',
      rationale: 'Synthetic pilot upgrade judgment.',
      uncertain: false,
      packetProblem: false,
      context: '',
    };
    for (const actor of ['reviewerA', 'reviewerB'] as const) {
      await rpc(
        pilot.db,
        actor,
        "select public.rpc_verify_submit('SYN-901','DESCRIPTOR_LEVEL',$1)",
        [j(response)],
      );
    }
    for (const action of ['CLOSE_REVIEW', 'AUTHORIZE_ADJUDICATION']) {
      await pilot.investigator('select public.rpc_verify_admin($1)', [
        j({ action, attestation: ATT }),
      ]);
    }
    await rpc(
      pilot.db,
      'adjudicator',
      "select public.rpc_verify_adjudicate('SYN-901','DESCRIPTOR_LEVEL',$1)",
      [
        j({
          ...response,
          status: 'RESOLVED',
          basis: 'Both fictional reviewers.',
          reasonCode: 'OTHER',
        }),
      ],
    );
    await pilot.investigator('select public.rpc_verify_admin($1)', [
      j({ action: 'LOCK_REFERENCE', attestation: ATT }),
    ]);
    const beforeExport = await rpc<Record<string, unknown>>(
      pilot.db,
      'investigator',
      'select public.rpc_verify_export()',
    );
    assert.equal(beforeExport.schemaVersion, '4.0.5-trial-packet-concurrency-guards');

    await pilot.db.exec(await readFile(CANONICAL_LOCK_STATE_MIGRATION, 'utf8'));
    const afterExport = await rpc<Record<string, unknown>>(
      pilot.db,
      'investigator',
      'select public.rpc_verify_export()',
    );
    assert.equal(afterExport.schemaVersion, '4.0.6-canonical-packet-lock-state');
    assert.deepEqual({ ...afterExport, schemaVersion: beforeExport.schemaVersion }, beforeExport);
  } finally {
    await pilot.db.close();
  }
});

async function frozenUpgradeState(db: PGlite) {
  const records: Record<string, unknown> = {};
  for (const table of [
    'cases',
    'case_versions',
    'case_design_v3',
    'case_records_v4',
    'sample_manifests',
    'sample_manifest_cases',
    'freeze_manifests_v4',
    'frozen_predictions_v4',
    'trial_context_packets',
    'assignments',
    'reviews',
    'trial_step1_records',
    'verify_cases',
  ]) {
    records[table] = (
      await db.query(
        `select to_jsonb(t) as record from public.${table} t order by to_jsonb(t)::text`,
      )
    ).rows;
  }
  records.levels = (
    await db.query(
      'select case_id, private.case_levels_v4(case_id) as level from public.case_records_v4 order by case_id, level',
    )
  ).rows;
  return JSON.parse(JSON.stringify(records));
}

for (const existingVersion of [7, 8, 9]) {
  test(`loader refuses incompatible frozen one-step trials at 000${existingVersion} without changing study records or schema`, async () => {
    const dir = await mkdtemp(join(tmpdir(), `verify-frozen-trial-000${existingVersion}-`));
    try {
      const f = await fixture({ through: 7, dataDir: dir, trialDesign: 'one-step' });
      await f.submit('reviewerA', ids[0]);
      // Reproduce databases already changed by older application binaries too.
      if (existingVersion >= 8)
        await f.db.exec(await readFile(TRIAL_CONCURRENCY_MIGRATION, 'utf8'));
      if (existingVersion >= 9)
        await f.db.exec(await readFile(CANONICAL_LOCK_STATE_MIGRATION, 'utf8'));
      const before = await frozenUpgradeState(f.db);
      const beforeVersions = (
        await f.db.query('select version from public.app_schema_version order by version')
      ).rows;
      const beforeFunction = (
        await f.db.query(
          "select pg_get_functiondef('private.case_levels_v4(text)'::regprocedure) as body",
        )
      ).rows;
      await f.db.close();

      const script = `import {getDb} from './src/server/db.ts';
        try { const db = await getDb(); await db.close(); console.log(JSON.stringify({rejected:false})); }
        catch (error) { console.log(JSON.stringify({rejected:true,message:error.message})); }`;
      for (let attempt = 0; attempt < 2; attempt++) {
        const result = await promisify(execFile)(
          process.execPath,
          ['--import', 'tsx', '--input-type=module', '-e', script],
          { cwd: process.cwd(), env: { ...process.env, VERIFY_DB_DIR: dir } },
        );
        assert.deepEqual(JSON.parse(result.stdout.trim()), {
          rejected: true,
          message:
            'Frozen trial contract is incompatible with the current schema; explicit investigator migration review is required',
        });
        const persisted = new PGlite({ dataDir: dir, extensions: { pgcrypto } });
        try {
          await persisted.waitReady;
          assert.deepEqual(await frozenUpgradeState(persisted), before);
          assert.deepEqual(
            (
              await persisted.query(
                'select version from public.app_schema_version order by version',
              )
            ).rows,
            beforeVersions,
          );
          assert.deepEqual(
            (
              await persisted.query(
                "select pg_get_functiondef('private.case_levels_v4(text)'::regprocedure) as body",
              )
            ).rows,
            beforeFunction,
          );
        } finally {
          await persisted.close();
        }
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
}

for (const trialDesign of [undefined, 'two-step'] as const) {
  test(`loader upgrades compatible frozen ${trialDesign ?? 'descriptor'} cases without reinterpreting the manifest or evidence`, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'verify-compatible-frozen-upgrade-'));
    try {
      const f = await fixture({ through: 7, dataDir: dir, trialDesign });
      // Prevent the local pilot auto-seed from obscuring the upgrade comparison.
      await f.db.query(
        "insert into public.verify_cases(id,kind,packet) values('SYN-901','DESCRIPTOR',$1)",
        [j({ title: 'Preserved synthetic pilot packet', area: 'Fictional construct' })],
      );
      const before = await frozenUpgradeState(f.db);
      await f.db.close();
      const script = `import {getDb} from './src/server/db.ts'; const db=await getDb();
        console.log(JSON.stringify((await db.query("select version from public.app_schema_version where version in ('4.0.5-trial-packet-concurrency-guards','4.0.6-canonical-packet-lock-state') order by version")).rows)); await db.close();`;
      for (let attempt = 0; attempt < 2; attempt++) {
        const result = await promisify(execFile)(
          process.execPath,
          ['--import', 'tsx', '--input-type=module', '-e', script],
          { cwd: process.cwd(), env: { ...process.env, VERIFY_DB_DIR: dir } },
        );
        assert.deepEqual(JSON.parse(result.stdout.trim()), [
          { version: '4.0.5-trial-packet-concurrency-guards' },
          { version: '4.0.6-canonical-packet-lock-state' },
        ]);
        const persisted = new PGlite({ dataDir: dir, extensions: { pgcrypto } });
        try {
          await persisted.waitReady;
          assert.deepEqual(await frozenUpgradeState(persisted), before);
        } finally {
          await persisted.close();
        }
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
}

const INVESTIGATOR_BOUNDARY_MIGRATION = 'migrations/0010_investigator_judgment_boundary.sql';

test('0010 denies investigator judgments through RPC and direct insert, including spoofed adjudicators, while preserving independent paths', async () => {
  const f = await fixture({ scope: 'ALL_CASE_LEVELS' });
  try {
    await completeReviews(f);
    const mb = await prepareModuleB(f);
    await mb.submit();
    await f.investigator('select public.rpc_mb_phase_v4($1,$2)', ['MB_CLOSED', ATT]);
    const preserved = async () =>
      (
        await f.db.query(`select jsonb_build_object(
      'adjudications',(select jsonb_agg(to_jsonb(a) order by adjudication_id) from public.adjudications a),
      'audit',(select jsonb_agg(to_jsonb(a) order by audit_id) from public.audit_log a),
      'snapshots',(select jsonb_agg(to_jsonb(s)) from public.judgment_snapshots_v4 s)) as state`)
      ).rows;
    const before = await preserved();
    await f.db.exec(await readFile(INVESTIGATOR_BOUNDARY_MIGRATION, 'utf8'));
    assert.deepEqual(await preserved(), before);
    const formal = await adjudicationPayload(
      f,
      ids[0],
      'CONCORDANT_CONFIRMED',
      'INCLUDE',
      'BOTH_REVIEWERS',
    );
    const denied = /An active ADJUDICATOR must record their own adjudication/;
    await assert.rejects(
      f.investigator('select public.rpc_record_adjudication_v3($1)', [j(formal)]),
      denied,
    );
    await assert.rejects(
      f.investigator('select public.rpc_record_adjudication_v3($1)', [
        j({ ...formal, case_id: 'SYN-001' }),
      ]),
      denied,
    );
    await assert.rejects(
      f.investigator(
        "select public.rpc_record_adjudication($1,'clinical_classification','INCLUDE',null,'CONCORDANT_CONFIRMED','BOTH_REVIEWERS','Synthetic denied adjudication',null,'{}'::uuid[],null,null,false)",
        ['SYN-001'],
      ),
      denied,
    );
    const mbPayload = {
      mb_unit_id: mb.unit,
      decision: 'COMPATIBLE',
      status: 'SINGLE_REVIEW_ADJUDICATED',
      basis: 'REVIEWER_1',
      rationale: 'Synthetic independent decision.',
    };
    await assert.rejects(
      f.investigator('select public.rpc_record_mb_adjudication_v4($1)', [j(mbPayload)]),
      denied,
    );
    for (const table of ['adjudications', 'mb_adjudications_v4']) {
      // Real authenticated callers lack direct INSERT privileges independently of the trigger.
      await assert.rejects(
        rpc(f.db, 'investigator', `insert into public.${table}(decided_by) values($1)`, [
          ACTORS.adjudicator,
        ]),
        /permission denied/,
      );
      // Owner-level probes exercise the trigger itself with the real caller JWT; no guard is disabled.
      for (const actor of ['investigator', 'reviewerA', 'adjudicator'] as const) {
        for (const decider of actor === 'adjudicator'
          ? [ACTORS.investigator]
          : [ACTORS.investigator, ACTORS.adjudicator]) {
          await assert.rejects(
            f.db.transaction(async (tx) => {
              await tx.query("select set_config('request.jwt.claims',$1,true)", [
                j({ sub: ACTORS[actor], aal: 'aal2' }),
              ]);
              return tx.query(`insert into public.${table}(decided_by) values($1)`, [decider]);
            }),
            denied,
          );
        }
      }
      await assert.rejects(
        f.db.query(`insert into public.${table}(decided_by) values($1)`, [ACTORS.adjudicator]),
        denied,
      );
    }
    assert.deepEqual(
      await preserved(),
      before,
      'Rejected writes must not change historical rows, audit hashes or snapshots',
    );
    await rpc(f.db, 'adjudicator', 'select public.rpc_record_adjudication_v3($1)', [j(formal)]);
    await adjudication(f, ids[1], 'CONCORDANT_CONFIRMED', 'INCLUDE', 'BOTH_REVIEWERS');
    await rpc(f.db, 'adjudicator', 'select public.rpc_record_mb_adjudication_v4($1)', [
      j(mbPayload),
    ]);
    await f.lock();
    await f.investigator('select public.rpc_lock_mb_reference_v4($1)', [ATT]);
    assert.equal(await f.verify(), true);
    assert.equal(
      (
        await f.db.query(
          "select * from public.adjudications where mode='FORMAL' and adjudicator_role='ADJUDICATOR' and not adjudicator_exposed_to_index_labels",
        )
      ).rows.length,
      2,
    );
    assert.equal(
      (
        await f.db.query(
          "select * from public.mb_adjudications_v4 where adjudicator_role='ADJUDICATOR' and not adjudicator_exposed_to_pipeline_status",
        )
      ).rows.length,
      1,
    );
  } finally {
    await f.db.close();
  }
});

test('0010 loader upgrade preserves existing locked references and historical pilot judgments across restarts', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'verify-investigator-boundary-upgrade-'));
  try {
    const f = await fixture({ dataDir: dir, scope: 'ALL_CASE_LEVELS' });
    await completeReviews(f);
    for (const id of ids)
      await adjudication(f, id, 'CONCORDANT_CONFIRMED', 'INCLUDE', 'BOTH_REVIEWERS');
    await f.lock();
    // Suppress automatic pilot fixture seeding so the upgrade comparison is exact.
    await f.db.query(
      "insert into public.verify_cases(id,kind,packet) values('SYN-901','DESCRIPTOR',$1)",
      [j({ title: 'Preserved fictional packet' })],
    );
    // Every pre-existing audit row must be unchanged. The only rows a later migration may add are
    // its own audited records (0028 specifies two study-decision gates; 0032 adds four requirement
    // versions); they are checked below.
    const query = `select jsonb_build_object(
      'judgments',(select jsonb_agg(to_jsonb(a) order by adjudication_id) from public.adjudications a),
      'audit',(select jsonb_agg(to_jsonb(a) order by audit_id) from public.audit_log a where a.entity_table <> 'mu7_gate_requirements'),
      'migrationAudit',(select jsonb_agg(a.entity_id order by a.entity_id) from public.audit_log a where a.entity_table = 'mu7_gate_requirements'),
      'locks',(select jsonb_agg(to_jsonb(l)) from public.reference_locks l),
      'snapshots',(select jsonb_agg(to_jsonb(s)) from public.judgment_snapshots_v4 s)) as state`;
    const before = (await f.db.query(query)).rows;
    await f.db.close();
    const script = `import {getDb} from './src/server/db.ts'; const db=await getDb(); console.log(JSON.stringify({versions:(await db.query("select count(*)::integer as n from public.app_schema_version where version='4.0.7-investigator-judgment-boundary'")).rows[0].n,records:(await db.query(${j(query)})).rows})); await db.close();`;
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await promisify(execFile)(
        process.execPath,
        ['--import', 'tsx', '--input-type=module', '-e', script],
        { cwd: process.cwd(), env: { ...process.env, VERIFY_DB_DIR: dir } },
      );
      const after = JSON.parse(result.stdout.trim());
      // The requirement records of 0028 (two) and 0032 (four) are the only additions to the audit log.
      const expected = before.map((r) => ({
        state: {
          ...(r as { state: Record<string, unknown> }).state,
          migrationAudit: ['G-EST-01', 'G-MH-V53', 'G-OQ-03', 'G-OQ-04', 'G-PAIN-01', 'G-PAIN-01'],
        },
      }));
      assert.deepEqual(after, { versions: 1, records: expected });
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
