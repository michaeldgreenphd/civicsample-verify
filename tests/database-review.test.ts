import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { DEMO_ACTORS, getDb, withActor } from '../src/server/db';
import { buildPilotExport, canonicalJson } from '../src/lib/export';
import type { Actor, JudgmentInput } from '../src/lib/types';
import {
  adminAction,
  adjudicate,
  getCase,
  getExportData,
  getWorkspace,
  saveDraft,
  submitReview,
  submitStep1,
  ServiceError,
} from '../src/server/service';

process.env.VERIFY_DB_DIR = 'memory';
const [investigator, reviewer, otherReviewer, adjudicator] = DEMO_ACTORS;
const migration = 'migrations/0005_review_integrity_fixes.sql';
const context = JSON.stringify({
  clinicalContext: 'Fictional context for a synthetic regression.',
  inclusionConditions: 'A fictional primary indication.',
  exclusionConditions: 'An unrelated fictional indication.',
});
const input: JudgmentInput = {
  decision: 'CONTEXT_DEPENDENT',
  rationale: 'Synthetic review regression rationale.',
  uncertain: true,
  context,
  packetProblem: false,
};
const attestation = 'Synthetic engineering regression attestation only.';
const locked = /Pre-context Step 1 is permanently locked after submission/;

after(async () => {
  await (await getDb()).close();
});

async function asActor<T>(
  db: PGlite,
  actor: Actor,
  operation: (tx: Parameters<Parameters<PGlite['transaction']>[0]>[0]) => Promise<T>,
) {
  return db.transaction(async (tx) => {
    await tx.exec('set local role authenticated');
    await tx.query("select set_config('request.jwt.claims',$1,true)", [
      JSON.stringify({ sub: actor.id, aal: 'aal2' }),
    ]);
    return operation(tx);
  });
}

async function legacyDb(dataDir?: string) {
  const db = new PGlite({ dataDir, extensions: { pgcrypto } });
  await db.waitReady;
  for (const file of [
    'supabase_test_shim/auth_shim.sql',
    'schema.sql',
    'migrations/0002_v3_review_design.sql',
    'migrations/0003_v4_record_categories_module_b.sql',
    'migrations/0004_synthetic_verify_workflow.sql',
  ]) {
    await db.exec(await readFile(file, 'utf8'));
  }
  for (const actor of DEMO_ACTORS) {
    const email = `regression-${actor.id.slice(-1)}@example.invalid`;
    await db.query('insert into auth.users(id,email) values($1,$2)', [actor.id, email]);
    await db.query(
      'insert into public.users(user_id,auth_uid,email,display_name,role,is_pilot_test_account) values($1,$1,$2,$3,$4,$5)',
      [actor.id, email, actor.displayName, actor.role, actor.role === 'REVIEWER'],
    );
  }
  await db.query(
    "insert into public.verify_cases(id,kind,packet,trial_packet) values('SYN-901','TWO_STEP',$1,$2)",
    [
      JSON.stringify({ title: 'Fictional legacy descriptor' }),
      JSON.stringify({ title: 'Fictional legacy trial' }),
    ],
  );
  await db.query(
    "insert into public.verify_assignments(case_id,reviewer_id,position) values('SYN-901',$1,1),('SYN-901',$2,1)",
    [reviewer.id, otherReviewer.id],
  );
  await asActor(db, reviewer, (tx) =>
    tx.query("select public.rpc_verify_submit('SYN-901','DESCRIPTOR_LEVEL_IN_TRIAL_CASE',$1)", [
      JSON.stringify(input),
    ]),
  );
  await asActor(db, investigator, (tx) =>
    tx.query('select public.rpc_verify_admin($1)', [
      JSON.stringify({
        action: 'AUTHORIZE_AMENDMENT',
        caseId: 'SYN-901',
        reviewerId: reviewer.id,
        level: 'DESCRIPTOR_LEVEL_IN_TRIAL_CASE',
        reason: 'Fictional pre-upgrade authorization.',
        attestation,
      }),
    ]),
  );
  const amendment = (await db.query<{ id: string }>('select id from public.verify_amendments'))
    .rows[0].id;
  return { db, amendment };
}

async function formalCases(db: PGlite) {
  await asActor(db, investigator, (tx) =>
    tx.query('select public.rpc_activate_design_v4($1,$2,$3)', [
      'SYN-REVIEW-REGRESSION',
      'ALL_CASE_LEVELS',
      attestation,
    ]),
  );
  for (const id of ['HO4-TESTFX-R1', 'HO4-TESTFX-R2', 'HO4-TESTFX-R3']) {
    await db.query(
      "insert into public.cases(case_id,mode,unit_type,created_by) values($1,'FORMAL','DESCRIPTOR_AREA',$2)",
      [id, investigator.id],
    );
    await asActor(db, investigator, (tx) =>
      tx.query('select public.rpc_record_heldout_case_v4($1)', [
        JSON.stringify({
          case_id: id,
          record_category: 'HELDOUT_FORMAL',
          frame_unit_id: `SYN-FRAME-${id}`,
          provenance_audit_result: 'NO_DEVELOPMENT_FLAG',
        }),
      ]),
    );
  }
}
function prediction(caseId: string, setId = 'SYN-PREDICTION-SET-A') {
  return {
    prediction_set_id: setId,
    case_id: caseId,
    determination_level: 'DESCRIPTOR_LEVEL',
    tier0_binary: 'INCLUDE',
    tier1_version: 'v1.1',
    tier1_status_raw: 'INCLUDE',
    tier1_binary: 'INCLUDE',
  };
}
async function importPredictions(db: PGlite, rows: ReturnType<typeof prediction>[]) {
  return asActor(db, investigator, (tx) =>
    tx.query('select public.rpc_import_frozen_predictions_v4($1)', [JSON.stringify(rows)]),
  );
}

test('separate context survives review and adjudication; repeated locked archives are byte-identical while access remains audited', async () => {
  const db = await getDb();
  const submitted = await submitReview(reviewer, 'SYN-001', input);
  assert.equal(submitted.submission?.context, context);
  assert.equal(submitted.submission?.packetProblem, false);
  assert.equal(submitted.submission?.packetProblemNote, undefined);
  await submitReview(reviewer, 'SYN-002', {
    ...input,
    packetProblem: true,
    packetProblemNote: 'Explicit fictional packet defect.',
  });
  for (const actor of [reviewer, otherReviewer]) {
    for (const item of (await getWorkspace(actor)).queue) {
      const detail = await getCase(actor, item.caseId);
      if (detail.submission) continue;
      if (detail.step1Required) await submitStep1(actor, item.caseId, input);
      await submitReview(
        actor,
        item.caseId,
        detail.step1Required ? { ...input, descriptorRole: 'DISEASE_STUDIED' } : input,
      );
    }
  }
  await assert.rejects(
    adminAction(investigator, {
      action: 'authorize-amendment',
      caseId: 'SYN-009',
      reviewerId: reviewer.id,
      level: 'DESCRIPTOR_LEVEL_IN_TRIAL_CASE',
      reason: 'Forbidden contextual rewrite.',
      attestation,
    }),
    (error: unknown) => error instanceof ServiceError && error.status === 409,
  );
  await assert.rejects(
    withActor(investigator, (tx) =>
      tx.query('select public.rpc_verify_admin($1)', [
        JSON.stringify({
          action: 'AUTHORIZE_AMENDMENT',
          caseId: 'SYN-009',
          reviewerId: reviewer.id,
          level: 'DESCRIPTOR_LEVEL_IN_TRIAL_CASE',
          reason: 'Forbidden contextual rewrite.',
          attestation,
        }),
      ]),
    ),
    locked,
  );
  // Trial-level amendments remain available; the restriction is only pre-context Step 1.
  await adminAction(investigator, {
    action: 'authorize-amendment',
    caseId: 'SYN-009',
    reviewerId: reviewer.id,
    level: 'TRIAL_LEVEL',
    reason: 'Fictional trial rationale correction.',
    attestation,
  });
  const trialAmendment = (await getCase(reviewer, 'SYN-009')).availableAmendments?.[0];
  assert.ok(trialAmendment);
  await saveDraft(reviewer, 'SYN-009', {
    ...input,
    level: 'TRIAL_LEVEL',
    descriptorRole: 'DISEASE_STUDIED',
    amendmentId: trialAmendment.id,
  });
  await submitReview(reviewer, 'SYN-009', {
    ...input,
    descriptorRole: 'DISEASE_STUDIED',
    amendmentId: trialAmendment.id,
  });
  await adminAction(investigator, { action: 'close', attestation });
  await adminAction(investigator, { action: 'authorize-adjudication', attestation });
  const adjudicatorCase = await getCase(adjudicator, 'SYN-001');
  assert.equal(adjudicatorCase.humanReviews?.length, 2);
  for (const review of adjudicatorCase.humanReviews ?? []) {
    assert.equal(review.context, context);
    assert.equal(review.packetProblem, false);
    assert.equal(review.packetProblemNote, undefined);
  }
  for (const item of (await getWorkspace(adjudicator)).queue) {
    for (const level of item.unitType === 'TRIAL_AREA'
      ? ['DESCRIPTOR_LEVEL_IN_TRIAL_CASE', 'TRIAL_LEVEL']
      : ['DESCRIPTOR_LEVEL']) {
      await adjudicate(adjudicator, item.caseId, {
        ...input,
        level,
        status: 'RESOLVED',
        basis: 'Independent fictional judgments and evidence.',
        reasonCode: 'OTHER',
      });
    }
  }
  await adminAction(investigator, { action: 'lock', attestation });
  const first = await getExportData(investigator);
  const firstBytes = canonicalJson(buildPilotExport(first));
  assert.equal(canonicalJson(buildPilotExport(await getExportData(investigator))), firstBytes);
  assert.equal(canonicalJson(buildPilotExport(await getExportData(investigator))), firstBytes);
  assert.equal(
    (
      await db.query<{ n: number }>(
        "select count(*)::integer as n from public.verify_audit where action='EXPORT_REQUESTED'",
      )
    ).rows[0].n,
    3,
  );
  assert.equal(JSON.stringify(first.provenance).includes('EXPORT_REQUESTED'), false);
  const archived = first.judgments.find((row) => row.caseId === 'SYN-001');
  assert.equal(archived?.context, context);
  assert.equal(archived?.packetProblemNote, undefined);
  assert.equal(
    first.judgments.find((row) => row.caseId === 'SYN-002' && row.reviewerSlot === 'A')
      ?.packetProblemNote,
    'Explicit fictional packet defect.',
  );
});

test('additive upgrade preserves originals and blocks pre-existing Step 1 authorizations at draft and submission', async () => {
  const { db, amendment } = await legacyDb();
  try {
    await asActor(db, reviewer, (tx) =>
      tx.query("select public.rpc_verify_draft('SYN-901','DESCRIPTOR_LEVEL_IN_TRIAL_CASE',$1)", [
        JSON.stringify({ ...input, amendmentId: amendment }),
      ]),
    );
    const before = (await db.query('select * from public.verify_responses')).rows;
    await db.exec(await readFile(migration, 'utf8'));
    assert.deepEqual((await db.query('select * from public.verify_responses')).rows, before);
    assert.equal((await db.query('select * from public.verify_amendments')).rows.length, 1);
    assert.equal((await db.query('select * from public.verify_drafts')).rows.length, 1);
    for (const rpc of ['rpc_verify_draft', 'rpc_verify_submit']) {
      await assert.rejects(
        asActor(db, reviewer, (tx) =>
          tx.query(`select public.${rpc}('SYN-901','DESCRIPTOR_LEVEL_IN_TRIAL_CASE',$1)`, [
            JSON.stringify({ ...input, amendmentId: amendment }),
          ]),
        ),
        locked,
      );
    }
    assert.deepEqual((await db.query('select * from public.verify_responses')).rows, before);
    await assert.rejects(
      db.exec('update public.verify_responses set packet_problem_note=null'),
      /append.only|immutable|not allowed|cannot/i,
    );
  } finally {
    await db.close();
  }
});

test('legacy submitted Step 1 amendments remain recorded but block reference use after upgrade', async () => {
  const { db, amendment } = await legacyDb();
  try {
    await asActor(db, reviewer, (tx) =>
      tx.query("select public.rpc_verify_submit('SYN-901','DESCRIPTOR_LEVEL_IN_TRIAL_CASE',$1)", [
        JSON.stringify({ ...input, decision: 'EXCLUDE', amendmentId: amendment }),
      ]),
    );
    const before = (await db.query('select * from public.verify_responses order by sequence')).rows;
    // Model an already locked pre-upgrade campaign: post-upgrade export must fail too.
    await db.exec(
      "update public.verify_state set phase='LOCKED',snapshot_hash=private.verify_snapshot()",
    );
    await db.exec(await readFile(migration, 'utf8'));
    const integrity = /Pre-context Step 1 integrity requires investigator review/;
    await assert.rejects(
      asActor(db, investigator, (tx) => tx.query('select public.rpc_verify_export()')),
      integrity,
    );
    await assert.rejects(
      asActor(db, adjudicator, (tx) => tx.query("select public.rpc_verify_case('SYN-901')")),
      integrity,
    );
    await assert.rejects(db.exec("update public.verify_state set phase='CLOSED'"), integrity);
    assert.deepEqual(
      (await db.query('select * from public.verify_responses order by sequence')).rows,
      before,
    );
  } finally {
    await db.close();
  }
});

test('prediction imports reject mixed run identifiers atomically and preserve one matching set', async () => {
  const db = await getDb();
  await formalCases(db);
  await assert.rejects(
    importPredictions(db, [
      prediction('HO4-TESTFX-R1'),
      prediction('HO4-TESTFX-R2', 'SYN-PREDICTION-SET-B'),
    ]),
    /one prediction-set identifier/,
  );
  assert.equal((await db.query('select * from public.frozen_predictions_v4')).rows.length, 0);
  await importPredictions(db, [prediction('HO4-TESTFX-R1')]);
  await assert.rejects(
    importPredictions(db, [prediction('HO4-TESTFX-R2', 'SYN-PREDICTION-SET-B')]),
    /one prediction-set identifier/,
  );
  await importPredictions(db, [prediction('HO4-TESTFX-R2')]);
  await assert.rejects(
    db.query(
      "insert into public.frozen_predictions_v4(prediction_set_id,case_id,determination_level,tier0_binary,tier1_version,tier1_status_raw,tier1_binary,row_sha256,imported_by) values('SYN-PREDICTION-SET-B','HO4-TESTFX-R3','DESCRIPTOR_LEVEL','INCLUDE','v1.1','INCLUDE','INCLUDE',$1,$2)",
      ['0'.repeat(64), investigator.id],
    ),
    /one prediction-set identifier/,
  );
  assert.equal((await db.query('select * from public.frozen_predictions_v4')).rows.length, 2);
});

test('pre-upgrade mixed predictions remain untouched and cannot be frozen after upgrade', async () => {
  const { db } = await legacyDb();
  try {
    await formalCases(db);
    await importPredictions(db, [
      prediction('HO4-TESTFX-R1'),
      prediction('HO4-TESTFX-R2', 'SYN-PREDICTION-SET-B'),
    ]);
    const before = (await db.query('select * from public.frozen_predictions_v4 order by case_id'))
      .rows;
    await db.exec(await readFile(migration, 'utf8'));
    await assert.rejects(
      asActor(db, investigator, (tx) =>
        tx.query('select public.rpc_freeze_v4($1)', [
          JSON.stringify({ tier1_version: 'v1.1', attestation }),
        ]),
      ),
      /exactly one prediction-set identifier/,
    );
    assert.equal((await db.query('select * from public.freeze_manifests_v4')).rows.length, 0);
    assert.deepEqual(
      (await db.query('select * from public.frozen_predictions_v4 order by case_id')).rows,
      before,
    );
  } finally {
    await db.close();
  }
});

test('existing persistent pilots apply the additive migration once on restart without replacing judgments', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  const directory = await mkdtemp(join(tmpdir(), 'verify-upgrade-regression-'));
  try {
    const { db } = await legacyDb(directory);
    const before = (await db.query('select * from public.verify_responses order by sequence')).rows;
    await db.close();
    const script = `import {getDb} from './src/server/db.ts'; const db=await getDb(); console.log(JSON.stringify({versions:(await db.query("select count(*)::integer as n from public.app_schema_version where version='4.0.2-review-integrity'")).rows[0].n,responses:(await db.query('select * from public.verify_responses order by sequence')).rows})); await db.close();`;
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await run(
        process.execPath,
        ['--import', 'tsx', '--input-type=module', '-e', script],
        { cwd: process.cwd(), env: { ...process.env, VERIFY_DB_DIR: directory } },
      );
      assert.deepEqual(JSON.parse(result.stdout.trim()), {
        versions: 1,
        responses: JSON.parse(JSON.stringify(before)),
      });
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('prediction import and freeze reject a stale-snapshot transaction isolation level', async () => {
  const db = await getDb();
  for (const sql of [
    'select public.rpc_import_frozen_predictions_v4($1)',
    'select public.rpc_freeze_v4($1)',
  ]) {
    await assert.rejects(
      db.transaction(async (tx) => {
        await tx.exec('set transaction isolation level repeatable read');
        await tx.exec('set local role authenticated');
        await tx.query("select set_config('request.jwt.claims',$1,true)", [
          JSON.stringify({ sub: investigator.id, aal: 'aal2' }),
        ]);
        return tx.query(sql, [
          JSON.stringify(
            sql.includes('import')
              ? [prediction('HO4-TESTFX-R3')]
              : { tier1_version: 'v1.1', attestation },
          ),
        ]);
      }),
      /require READ COMMITTED isolation/,
    );
  }
});
