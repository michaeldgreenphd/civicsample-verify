// Engineering message v8.1 on the full chain (migration 0028): G-PAIN-01 and G-MH-V53 are specified
// with their decision records; nothing is approved. Only an investigator with a second factor may
// approve, and only naming the specified record. MU7-G29 holds the four Pain units at the freeze
// until G-PAIN-01 is approved, and a Pain (or Mental health) approval alone never opens the freeze
// or the formal phase while the other gates are pending. Synthetic data only; every approval below
// is made in a disposable test database, and the synthetic specifications of the other gates exist
// only there.
//
// These tests pin the chain through migration 0031, before 0032 re-specifies G-PAIN-01 (version 3)
// and moves G-OQ-03, G-OQ-04 and G-EST-01 to the freeze: 0032 is left out (PRE_0032; the fixture
// also leaves it out with 0029 or 0030). tests/mu7-gates-v8-4.test.ts covers the chain with 0032.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ATT,
  formalOpen,
  freezeSql,
  one,
  phase,
  rows,
  specifyAndApproveGates,
  type FixtureDb,
} from './mu7-fixture';

const PRE_0032 = ['migrations/0032_v7_freeze_gates_v8_4.sql'];
const PAIN_RECORD = 'investigator decisions 2026-10-23, addendum 8, item 40';
const MH_RECORD =
  'investigator decision 37 with the G-MH-V53 check of 2026-10-23, run 2 (SHA-256 7c66e1b098c5cfde2f322f443c3412fd7e766d00e87c83f674e5eed1cc1fd46e)';
const approve = (gate: string, evidence: string) =>
  `select public.rpc_mu7_approve_gate('${gate}', '${ATT}', '${evidence.replace(/'/g, "''")}') as g`;
async function attempt(db: FixtureDb, who: Parameters<typeof one>[1], sql: string) {
  try {
    return { ok: true as const, value: await one(db, who, sql) };
  } catch (e) {
    return { ok: false as const, error: (e as Error).message };
  }
}

test('0028 specifies G-PAIN-01 and G-MH-V53 with their records, approves nothing, and leaves the other gates pending', async () => {
  const f = await formalOpen({ gates: [], stopAfter: 'formalImport', without: PRE_0032 });
  try {
    const status = await rows<{
      gate_id: string;
      requirement_status: string;
      decision_reference: string | null;
      satisfied: boolean;
    }>(
      f.db,
      'inv',
      'select gate_id, requirement_status, decision_reference, satisfied from public.rpc_mu7_gate_status()',
    );
    const by = Object.fromEntries(status.map((g) => [g.gate_id, g]));
    assert.equal(by['G-PAIN-01'].requirement_status, 'SPECIFIED');
    assert.equal(by['G-PAIN-01'].decision_reference, PAIN_RECORD);
    assert.equal(by['G-MH-V53'].requirement_status, 'SPECIFIED');
    assert.equal(by['G-MH-V53'].decision_reference, MH_RECORD);
    for (const g of ['G-PROV-01', 'G-OVERLAP-01', 'G-TEXT-01', 'G-OQ-03', 'G-OQ-04', 'G-EST-01'])
      assert.equal(by[g].requirement_status, 'PENDING_SPECIFICATION', g);
    assert.ok(status.every((g) => !g.satisfied));
    assert.equal(
      await one(f.db, 'owner', 'select count(*)::int from public.mu7_gate_approvals'),
      0,
    );
  } finally {
    await f.db.close();
  }
});

test('only the investigator, with a second factor and naming the specified record, can approve a gate', async () => {
  const f = await formalOpen({ gates: [], stopAfter: 'formalImport', without: PRE_0032 });
  try {
    for (const who of ['r1', 'r2', 'pt1', 'adj', 'out'] as const) {
      const r = await attempt(f.db, who, approve('G-PAIN-01', PAIN_RECORD));
      assert.ok(!r.ok, `${who} refused`);
      assert.match(r.error, /investigator role/);
    }
    const aal1 = await attempt(f.db, 'inv1', approve('G-PAIN-01', PAIN_RECORD));
    assert.ok(!aal1.ok, 'an investigator session without a second factor is refused');
    const wrong = await attempt(f.db, 'inv', approve('G-PAIN-01', 'addendum 8'));
    assert.ok(!wrong.ok);
    assert.match(
      wrong.error,
      /MU7X-G08: an approval of gate G-PAIN-01 names its specified decision record/,
    );
    const pending = await attempt(f.db, 'inv', approve('G-OVERLAP-01', 'any record'));
    assert.ok(!pending.ok);
    assert.match(
      pending.error,
      /MU7X-G08: gate G-OVERLAP-01 cannot be approved while its requirement is pending/,
    );
    // Application roles cannot write requirements or approvals directly.
    for (const sql of [
      `insert into public.mu7_gate_approvals (gate_id, attestation, evidence_reference, approved_by) values ('G-PAIN-01', '${ATT}', '${PAIN_RECORD}', (select user_id from public.users where role = 'INVESTIGATOR'))`,
      "insert into public.mu7_gate_requirements (gate_id, requirement_version, blocks, requirement_status, question, decision_reference, source) values ('G-EST-01', 9, '{}', 'SPECIFIED', 'An application role cannot specify.', 'x-y-z', 'app')",
    ]) {
      const r = await attempt(f.db, 'inv', sql);
      assert.ok(!r.ok);
      assert.match(r.error, /permission denied/);
    }
    assert.equal(
      await one(f.db, 'owner', 'select count(*)::int from public.mu7_gate_approvals'),
      0,
    );
  } finally {
    await f.db.close();
  }
});

test('MU7-G29 holds the Pain units until G-PAIN-01 is approved; Pain approval alone does not open the freeze or the formal phase', async () => {
  const f = await formalOpen({ gates: [], stopAfter: 'formalImport', without: PRE_0032 });
  try {
    const before = await attempt(f.db, 'inv', freezeSql());
    assert.ok(!before.ok);
    assert.match(
      before.error,
      /MU7-G29: units are blocked from the freeze until their gate is approved/,
    );
    assert.match(before.error, /PAIN/);
    assert.ok((await attempt(f.db, 'inv', approve('G-PAIN-01', PAIN_RECORD))).ok);
    // MU7-G29 is satisfied now; the freeze is still held by the remaining freeze gates.
    const afterPain = await attempt(f.db, 'inv', freezeSql());
    assert.ok(!afterPain.ok);
    assert.doesNotMatch(afterPain.error, /MU7-G29/);
    assert.match(afterPain.error, /MU7X-G06/);
    assert.match(afterPain.error, /G-MH-V53 \(not approved\)/);
    for (const g of ['G-OVERLAP-01', 'G-PROV-01', 'G-TEXT-01'])
      assert.ok(afterPain.error.includes(`${g} (requirement pending specification)`), g);
    assert.ok(!afterPain.error.includes('G-PAIN-01'));
    // The Mental health check is evidence; its approval is a separate investigator act, and with
    // it the freeze is still held by the three pending gates.
    assert.ok((await attempt(f.db, 'inv', approve('G-MH-V53', MH_RECORD))).ok);
    const afterMh = await attempt(f.db, 'inv', freezeSql());
    assert.ok(!afterMh.ok);
    assert.match(afterMh.error, /MU7X-G06/);
    assert.ok(!afterMh.error.includes('G-MH-V53'));
    // The formal opening cannot happen without the freeze, and its own gates are still open.
    const open = await attempt(f.db, 'inv', phase('FORMAL_OPENED'));
    assert.ok(!open.ok);
    const unsatisfied = (
      await rows<{ gate_id: string }>(
        f.db,
        'inv',
        "select gate_id from public.rpc_mu7_gate_status() where not satisfied and 'FORMAL_OPEN' = any (blocks) order by gate_id",
      )
    ).map((r) => r.gate_id);
    assert.deepEqual(unsatisfied, [
      'G-EST-01',
      'G-OQ-03',
      'G-OQ-04',
      'G-OVERLAP-01',
      'G-PROV-01',
      'G-TEXT-01',
    ]);
  } finally {
    await f.db.close();
  }
});

test('in a disposable database where the other freeze gates are satisfied synthetically, the Pain approval is what lets MU7-G29 pass', async () => {
  // Synthetic specifications and approvals of G-PROV-01, G-OVERLAP-01 and G-TEXT-01 exist only in
  // this test database; with them in place, only the Pain approval stands between the Pain units
  // and the freeze, as v8.1 describes for MU7-G29.
  const f = await formalOpen({ gates: [], stopAfter: 'formalImport', without: PRE_0032 });
  try {
    await specifyAndApproveGates(f.db, ['G-PROV-01', 'G-OVERLAP-01', 'G-TEXT-01']);
    assert.ok((await attempt(f.db, 'inv', approve('G-MH-V53', MH_RECORD))).ok);
    const held = await attempt(f.db, 'inv', freezeSql());
    assert.ok(!held.ok);
    assert.match(held.error, /MU7-G29/);
    assert.ok((await attempt(f.db, 'inv', approve('G-PAIN-01', PAIN_RECORD))).ok);
    assert.ok(
      (await attempt(f.db, 'inv', freezeSql())).ok,
      'the freeze passes once G-PAIN-01 is approved',
    );
    // The formal opening still waits for G-OQ-03, G-OQ-04 and G-EST-01.
    const open = await attempt(f.db, 'inv', phase('FORMAL_OPENED'));
    assert.ok(!open.ok);
  } finally {
    await f.db.close();
  }
});

// ---- Codex review of PR #11: approvals keyed to requirement versions (migration 0029) ---------
async function reSpecifyPain(db: FixtureDb, record: string) {
  // A later reviewed migration re-specifying G-PAIN-01 (version 3), stood in for by the owner.
  await db.query(
    `insert into public.mu7_gate_requirements (gate_id, requirement_version, blocks, requirement_status, question, decision_reference, source)
     values ('G-PAIN-01', 3, array['FORMAL_OPEN'], 'SPECIFIED', 'Synthetic re-specification for the regression.', $1, 'SYNTHETIC test')`,
    [record],
  );
}
const painSatisfied = async (db: FixtureDb) =>
  (await one(
    db,
    'inv',
    "select satisfied from public.rpc_mu7_gate_status() where gate_id = 'G-PAIN-01'",
  )) === true;

test('without 0029 a re-specified gate can never be approved again (reproduced)', async () => {
  const f = await formalOpen({
    gates: [],
    stopAfter: 'formalImport',
    without: ['migrations/0029_v7_versioned_gate_approvals.sql'],
  });
  try {
    assert.ok((await attempt(f.db, 'inv', approve('G-PAIN-01', PAIN_RECORD))).ok);
    assert.equal(await painSatisfied(f.db), true);
    await reSpecifyPain(f.db, 'SYNTHETIC-TEST-RECORD-PAIN-V3');
    assert.equal(await painSatisfied(f.db), false);
    const again = await attempt(f.db, 'inv', approve('G-PAIN-01', 'SYNTHETIC-TEST-RECORD-PAIN-V3'));
    assert.ok(!again.ok, 'reproduced: the investigator cannot approve the new version');
    assert.equal(await painSatisfied(f.db), false);
  } finally {
    await f.db.close();
  }
});

test('with 0029 the investigator re-approves a re-specified gate citing its new record; history is kept', async () => {
  const f = await formalOpen({ gates: [], stopAfter: 'formalImport', without: PRE_0032 });
  try {
    assert.ok((await attempt(f.db, 'inv', approve('G-PAIN-01', PAIN_RECORD))).ok);
    assert.equal(await painSatisfied(f.db), true);
    // Approving the same version again is refused.
    assert.ok(!(await attempt(f.db, 'inv', approve('G-PAIN-01', PAIN_RECORD))).ok);
    await reSpecifyPain(f.db, 'SYNTHETIC-TEST-RECORD-PAIN-V3');
    assert.equal(
      await painSatisfied(f.db),
      false,
      'the earlier approval does not cover the new version',
    );
    // Citing the old record, or a non-investigator, is refused.
    const stale = await attempt(f.db, 'inv', approve('G-PAIN-01', PAIN_RECORD));
    assert.ok(!stale.ok);
    assert.match(stale.error, /MU7X-G09: an approval names the latest specified requirement/);
    for (const who of ['r1', 'adj'] as const)
      assert.ok(
        !(await attempt(f.db, who, approve('G-PAIN-01', 'SYNTHETIC-TEST-RECORD-PAIN-V3'))).ok,
        `${who} is refused`,
      );
    assert.ok(
      (await attempt(f.db, 'inv', approve('G-PAIN-01', 'SYNTHETIC-TEST-RECORD-PAIN-V3'))).ok,
    );
    assert.equal(await painSatisfied(f.db), true);
    const history = await rows<{ requirement_version: number; evidence_reference: string }>(
      f.db,
      'inv',
      "select requirement_version, evidence_reference from public.mu7_gate_approval_versions where gate_id = 'G-PAIN-01' order by requirement_version",
    );
    assert.deepEqual(history, [
      { requirement_version: 2, evidence_reference: PAIN_RECORD },
      { requirement_version: 3, evidence_reference: 'SYNTHETIC-TEST-RECORD-PAIN-V3' },
    ]);
    // The approval rows are append-only, even for the owner.
    assert.ok(!(await attempt(f.db, 'owner', 'delete from public.mu7_gate_approval_versions')).ok);
    assert.equal(
      await one(f.db, 'owner', 'select count(*)::int from public.mu7_gate_approvals'),
      1,
    );
  } finally {
    await f.db.close();
  }
});

// ---- Independent review of PR #11 (3d414f9): the per-unit freeze gate follows the current version
async function supersededPainFreeze(withFix: boolean) {
  const f = await formalOpen({
    gates: [],
    stopAfter: 'formalImport',
    without: withFix ? PRE_0032 : ['migrations/0030_v7_current_unit_freeze_gates.sql'],
  });
  try {
    // The other freeze gates satisfied synthetically (this disposable database only).
    await specifyAndApproveGates(f.db, ['G-PROV-01', 'G-OVERLAP-01', 'G-TEXT-01']);
    assert.ok((await attempt(f.db, 'inv', approve('G-MH-V53', MH_RECORD))).ok);
    assert.ok((await attempt(f.db, 'inv', approve('G-PAIN-01', PAIN_RECORD))).ok);
    await reSpecifyPain(f.db, 'SYNTHETIC-TEST-RECORD-PAIN-V3');
    assert.equal(await painSatisfied(f.db), false, 'the Pain approval is superseded');
    const freeze = await attempt(f.db, 'inv', freezeSql());
    let afterReapproval: Awaited<ReturnType<typeof attempt>> | null = null;
    if (!freeze.ok) {
      assert.ok(
        (await attempt(f.db, 'inv', approve('G-PAIN-01', 'SYNTHETIC-TEST-RECORD-PAIN-V3'))).ok,
      );
      afterReapproval = await attempt(f.db, 'inv', freezeSql());
    }
    return { freeze, afterReapproval };
  } finally {
    await f.db.close();
  }
}

test('without 0030 a superseded Pain approval still lets the Pain units be frozen (reproduced)', async () => {
  const r = await supersededPainFreeze(false);
  assert.ok(r.freeze.ok, 'reproduced: the freeze succeeds although G-PAIN-01 v3 is not approved');
});

test('with 0030 the Pain units wait for an approval of the current requirement version', async () => {
  const r = await supersededPainFreeze(true);
  assert.ok(!r.freeze.ok);
  assert.match(
    r.freeze.error,
    /MU7X-G10: units wait for an approval of the current requirement of their gate: G-PAIN-01/,
  );
  assert.ok(r.afterReapproval?.ok, 'the freeze passes once the investigator approves version 3');
});
