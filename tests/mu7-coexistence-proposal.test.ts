// The PROPOSED cross-design coexistence guard (migrations/proposed/v7_cross_design_coexistence.sql),
// prepared for the investigator's review and NOT applied anywhere: it is outside the hosted chain
// and the local loader. These tests apply it to disposable copies of the full chain to show what it
// would refuse and that it preserves the synthetic mapping-confirmation pilot. Synthetic data only.
// Where a test needs a state today's chain cannot reach (an EVALUATION mapping, a v2 FORMAL
// unlock), the database owner writes that row with triggers off, standing in for a later migration
// that lifts today's refusal; that is labelled at each use.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { HOSTED_SCHEMA_FILES } from '../scripts/supabase-identity-tools.mjs';
import { mcGuardCase } from './mapconf-guard-fixture';
import { ATT, one, recordDesignSql, signedOffPilot, type FixtureDb } from './mu7-fixture';

const PROPOSAL = 'migrations/proposed/v7_cross_design_coexistence.sql';
const applyProposal = async (db: FixtureDb) => db.exec(readFileSync(PROPOSAL, 'utf8'));
const lit = (o: unknown) => `'${JSON.stringify(o).replace(/'/g, "''")}'::jsonb`;
const createCampaign = `select public.rpc_mc_create_campaign(${lit({ condition_set_id: 'CONDSET-GUARD', condition_set_status: 'PROPOSED', rubric_version: 'GUARD-RUBRIC', rubric_sha256: 'b'.repeat(64) })})`;
const importMc = (c: Record<string, unknown>) => `select public.rpc_mc_import_case(${lit(c)})`;
async function attempt(db: FixtureDb, sql: string) {
  try {
    return { ok: true as const, value: await one(db, 'inv', sql) };
  } catch (e) {
    return { ok: false as const, error: (e as Error).message };
  }
}
const count = async (db: FixtureDb, sql: string) => Number(await one(db, 'owner', sql));
/** Owner write with triggers off: stands in for a later migration lifting today's refusal. */
async function ownerBypass(db: FixtureDb, sql: string) {
  await db.exec(`begin; set local session_replication_role = replica; ${sql}; commit;`);
}

test('the proposal is outside every applied chain', () => {
  assert.ok(!(HOSTED_SCHEMA_FILES as string[]).some((f) => f.includes('proposed')));
  assert.ok(!readFileSync('src/server/db.ts', 'utf8').includes('proposed'));
  assert.match(readFileSync(PROPOSAL, 'utf8'), /PROPOSED, NOT APPLIED/);
});

test('proposal: an existing synthetic mapping-confirmation pilot is preserved and v7 can still be recorded', async () => {
  const { db } = await signedOffPilot({ stopAfter: 'accounts' });
  try {
    // The staging situation: a synthetic mapping-confirmation pilot exists before v7.
    await one(db, 'inv', createCampaign);
    await one(db, 'inv', importMc(mcGuardCase('MC-SYN-COEX-1', 'SYN-NCT-9971')));
    await one(db, 'inv', importMc(mcGuardCase('MC-TRN-COEX-1', 'SYN-NCT-9972')));
    const before = await count(db, 'select count(*) from public.mc_cases');
    await applyProposal(db);
    assert.ok((await attempt(db, recordDesignSql())).ok, 'the v7 design is recorded');
    // Synthetic and training mappings stay allowed after v7, as today.
    assert.ok((await attempt(db, importMc(mcGuardCase('MC-SYN-COEX-2', 'SYN-NCT-9973')))).ok);
    assert.equal(await count(db, 'select count(*) from public.mc_cases'), before + 1);
    assert.equal(
      await count(db, "select count(*) from public.mc_cases where record_category = 'EVALUATION'"),
      0,
    );
  } finally {
    await db.close();
  }
});

test('proposal: an EVALUATION mapping is refused next to v7 by the design guard itself, not only by 0018', async () => {
  for (const withProposal of [false, true]) {
    const { db } = await signedOffPilot({ stopAfter: 'design' });
    try {
      await one(db, 'inv', createCampaign);
      if (withProposal) await applyProposal(db);
      const evaluation = {
        ...mcGuardCase('MC-EVAL-COEX-1', 'SYN-NCT-9974'),
        record_category: 'EVALUATION',
      };
      const r = await attempt(db, importMc(evaluation));
      assert.ok(!r.ok);
      assert.match(
        r.error,
        withProposal ? /MU7C-G01/ : /evaluation import is disabled pending scientific approval/,
        'today only the build-wide 0018 refusal stands; with the proposal the v7 guard fires first',
      );
    } finally {
      await db.close();
    }
  }
});

test('proposal: v7 cannot be recorded next to an EVALUATION mapping or an unlocked v2 formal review', async () => {
  const inv = "(select user_id from public.users where role = 'INVESTIGATOR')";
  for (const [label, seed, expected] of [
    [
      'EVALUATION mapping',
      // stands in for a later migration lifting 0018's EVALUATION refusal
      `insert into public.mc_cases (case_id, record_category, trial_ref, condition_code, condition_label, condition_set_id, assignment, assignment_sha256, evidence, evidence_sha256, created_by)
       values ('MC-EVAL-COEX-2', 'EVALUATION', 'SYN-NCT-9975', 'HTN', 'Hypertension', 'CONDSET-GUARD', '{}', '${'0'.repeat(64)}', '{}', '${'0'.repeat(64)}', ${inv})`,
      /MU7C-G03: an EVALUATION mapping-confirmation review exists/,
    ],
    [
      'v2 FORMAL unlock',
      // stands in for a completed v2 synthetic pilot and its sign-off
      `insert into public.review_phase_events (event_type, actor_user_id, pilot_checklist_version, pilot_checklist_sha256, app_git_sha, pilot_export_id, attestation)
       values ('FORMAL_UNLOCKED', ${inv}, 'PAC-1', '${'1'.repeat(64)}', 'abc', gen_random_uuid(), '${ATT}')`,
      /MU7C-G03: the v2 formal review is unlocked/,
    ],
  ] as const) {
    for (const withProposal of [false, true]) {
      const { db } = await signedOffPilot({ stopAfter: 'accounts' });
      try {
        await ownerBypass(db, seed);
        if (withProposal) await applyProposal(db);
        const r = await attempt(db, recordDesignSql());
        if (withProposal) {
          assert.ok(!r.ok, `${label}: refused with the proposal`);
          assert.match(r.error, expected);
        } else assert.ok(r.ok, `${label}: today the v7 design is recorded next to it`);
      } finally {
        await db.close();
      }
    }
  }
});

test('proposal: the v2 formal unlock is refused once v7 is recorded, before the v2 pilot check', async () => {
  for (const withProposal of [false, true]) {
    const { db } = await signedOffPilot({ stopAfter: 'design' });
    try {
      if (withProposal) await applyProposal(db);
      const r = await attempt(
        db,
        `select public.rpc_unlock_formal_review('PAC-1', '${'1'.repeat(64)}', 'abc', gen_random_uuid(), '${ATT}')`,
      );
      assert.ok(!r.ok);
      assert.match(r.error, withProposal ? /MU7C-G02/ : /pilot incomplete/);
    } finally {
      await db.close();
    }
  }
});
