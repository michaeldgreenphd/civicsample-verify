// Second review round on migration 0024 (review design v7): the independent review of PR #8 and the
// automated review of PR #9, reproduced on this repository's full chain and closed by migration
// 0026. Each check runs WITHOUT 0026 (the defect must show, so the test cannot pass trivially) and
// WITH it (the defect must be gone). The races need two connections and run on native PostgreSQL
// 16 in tests/mu7-postgres.test.ts. Synthetic data only; every gate specification and approval
// below is a SYNTHETIC record in a disposable test database, never a study decision.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  ATT,
  formalOpen,
  freezeSql,
  newDatabase,
  one,
  phase,
  rows,
  signedOffPilot,
  syntheticDecision,
  type FixtureDb,
} from './mu7-fixture';

const FIX = 'migrations/0026_v7_lifecycle_and_gates.sql';
const without = (fixed: boolean) => (fixed ? [] : [FIX]);
const lit = (o: unknown) => `'${JSON.stringify(o).replace(/'/g, "''")}'::jsonb`;
const lockPilot = `select public.rpc_mu7_lock_reference('PILOT', '${ATT}') as l`;
const exportPilot = (rowCounts: Record<string, unknown>) =>
  `select public.rpc_mu7_register_export(${lit({ mode: 'PILOT', bundle_format_version: '7.0', row_counts: rowCounts, file_sha256: {}, manifest_sha256: '3'.repeat(64), app_git_sha: 'abc123' })}) as x`;
const signoff = (exportId: unknown) =>
  phase('PILOT_SIGNED_OFF', {
    checklist_version: 'PAC-7',
    checklist_sha256: '1'.repeat(64),
    app_git_sha: 'abc123',
    pilot_export_id: exportId,
  });
/** Runs one statement as the investigator; returns its value or the refusal message. */
async function attempt(db: FixtureDb, sql: string, who: 'inv' | 'r1' | 'owner' = 'inv') {
  try {
    return { ok: true as const, value: await one(db, who, sql) };
  } catch (e) {
    return { ok: false as const, error: (e as Error).message };
  }
}
const PILOT_FILE = JSON.parse(
  readFileSync('tests/handoff/fixtures/v7/SYNTHETIC_PILOT_UNITS_v7.json', 'utf8'),
) as { units: Array<{ import: Record<string, unknown> & { unit_id: string } }> };
/** A thirteenth synthetic pilot unit: a copy of the first with the next unit number. */
function extraPilotUnit() {
  const u = JSON.parse(JSON.stringify(PILOT_FILE.units[0].import));
  const id = u.unit_id.replace(/-001$/, '-002');
  u.unit_id = id;
  u.packet.unit.unit_id = id;
  return u;
}
const pilotUnitCount = async (db: FixtureDb) =>
  Number(await one(db, 'owner', "select count(*) from public.mu7_units where mode = 'PILOT'"));

// ---- Finding 1: an empty pilot can be locked, exported and signed off -------------------------
async function emptyPilot(fixed: boolean) {
  const { db } = await signedOffPilot({ without: without(fixed), stopAfter: 'design' });
  try {
    const lock = await attempt(db, lockPilot);
    const locked = await one(
      db,
      'owner',
      "select n_units_locked from public.mu7_reference_locks where mode = 'PILOT'",
    );
    const exp = lock.ok ? await attempt(db, exportPilot({ units: 0 })) : null;
    const signed = exp?.ok ? await attempt(db, signoff(exp.value)) : null;
    return { lock, locked, exp, signed, units: await pilotUnitCount(db) };
  } finally {
    await db.close();
  }
}

test('finding 1 reproduced without 0026: a pilot with no units is locked, exported and signed off', async () => {
  const r = await emptyPilot(false);
  assert.equal(r.units, 0);
  assert.ok(r.lock.ok, 'the empty pilot reference locks');
  assert.equal(r.locked, 0);
  assert.ok(r.exp?.ok, 'an export of zero units is registered');
  assert.ok(r.signed?.ok, 'reproduced: the pilot is signed off without a single pilot unit');
});

test('finding 1 fixed with 0026: the empty pilot reference cannot lock', async () => {
  const r = await emptyPilot(true);
  assert.ok(!r.lock.ok);
  assert.match(r.lock.error, /MU7X-G02: the PILOT reference cannot lock an empty pilot \(0 units/);
  assert.equal(r.locked, null);
});

async function subgroupOnlyPilot(fixed: boolean) {
  const { db, PT1, PT2 } = await signedOffPilot({ without: without(fixed), stopAfter: 'design' });
  try {
    const sg = PILOT_FILE.units.find((u) => u.import.unit_role === 'SUBGROUP')!.import;
    await one(db, 'inv', `select public.rpc_mu7_import_unit(${lit(sg)})`);
    await one(
      db,
      'inv',
      `select public.rpc_mu7_assign_queue('PILOT', ${lit({
        slots: [
          { reviewer_slot: 1, reviewer_pseudo_id: PT1, unit_ids: [sg.unit_id] },
          { reviewer_slot: 2, reviewer_pseudo_id: PT2, unit_ids: [sg.unit_id] },
        ],
      })})`,
    );
    for (const [who, pseudo] of [
      ['pt1', PT1],
      ['pt2', PT2],
    ] as const) {
      const a = await one(
        db,
        'owner',
        'select assignment_id from public.mu7_queue where reviewer_pseudo_id = $1',
        [pseudo],
      );
      await one(db, who, `select public.rpc_mu7_submit('${a}', '{"answer":"AGREE"}'::jsonb)`);
    }
    return await attempt(db, lockPilot);
  } finally {
    await db.close();
  }
}

test('finding 1 variant: a pilot of subgroup units only locks without 0026 and is refused with it', async () => {
  assert.ok(
    (await subgroupOnlyPilot(false)).ok,
    'reproduced: no primary unit, yet the pilot locks',
  );
  const r = await subgroupOnlyPilot(true);
  assert.ok(!r.ok);
  assert.match(r.error, /MU7X-G02: .*\(1 units, 0 primary\)/);
});

async function pilotExportMisstated(fixed: boolean) {
  const { db } = await signedOffPilot({ without: without(fixed), stopAfter: 'pilotLock' });
  try {
    const empty = await attempt(db, exportPilot({}));
    const zero = await attempt(db, exportPilot({ units: 0 }));
    const signed = zero.ok ? await attempt(db, signoff(zero.value)) : null;
    return { empty, zero, signed };
  } finally {
    await db.close();
  }
}

test('finding 1 reproduced without 0026: the sign-off accepts an export that misstates the locked inventory', async () => {
  const r = await pilotExportMisstated(false);
  assert.ok(r.empty.ok && r.zero.ok, 'exports stating no units or zero units are registered');
  assert.ok(
    r.signed?.ok,
    'reproduced: the sign-off names an export of zero units for a 12-unit pilot',
  );
});

test('finding 1 fixed with 0026: a PILOT export states the locked unit count, and the sign-off is bound to it', async () => {
  const r = await pilotExportMisstated(true);
  for (const x of [r.empty, r.zero]) {
    assert.ok(!x.ok);
    assert.match(x.error, /MU7X-G03: a PILOT export states the 12 locked pilot units/);
  }
  // The correct export and sign-off still pass (the fixture's normal path, checked end to end).
  const { db } = await signedOffPilot();
  try {
    assert.equal(
      await one(
        db,
        'owner',
        "select count(*)::int from public.mu7_phase_events where event_type = 'PILOT_SIGNED_OFF'",
      ),
      1,
    );
  } finally {
    await db.close();
  }
});

// ---- Finding 2: pilot units can be imported after the pilot reference is locked --------------
async function importAfterLock(fixed: boolean) {
  const { db } = await signedOffPilot({ without: without(fixed), stopAfter: 'pilotLock' });
  try {
    const imp = await attempt(
      db,
      `select public.rpc_mu7_import_unit(${lit(extraPilotUnit())}) as u`,
    );
    const exp = await attempt(db, exportPilot({ units: 12 }));
    const signed = exp.ok ? await attempt(db, signoff(exp.value)) : null;
    const locked = Number(
      await one(
        db,
        'owner',
        "select n_units_locked from public.mu7_reference_locks where mode = 'PILOT'",
      ),
    );
    return { imp, exp, signed, locked, units: await pilotUnitCount(db) };
  } finally {
    await db.close();
  }
}

test('finding 2 reproduced without 0026: a pilot unit is imported after the lock and the sign-off ignores it', async () => {
  const r = await importAfterLock(false);
  assert.ok(r.imp.ok, 'the thirteenth pilot unit is accepted after the lock');
  assert.equal(r.locked, 12);
  assert.equal(r.units, 13);
  assert.ok(
    r.signed?.ok,
    'reproduced: the pilot is signed off with a unit outside the locked inventory',
  );
});

test('finding 2 fixed with 0026: no pilot unit after the pilot lock; the attested inventory is the locked one', async () => {
  const r = await importAfterLock(true);
  assert.ok(!r.imp.ok);
  assert.match(
    r.imp.error,
    /MU7X-G05: the PILOT reference is locked; pilot unit SYN7-.*-002 cannot be added/,
  );
  assert.equal(r.units, 12);
  assert.ok(r.signed?.ok, 'the sign-off of the intact 12-unit inventory still passes');
});

// ---- Finding 3: formal review opens without the required scientific approvals ----------------
test('finding 3 reproduced without 0026: the formal phase opens with G-PAIN-01 as the only approval', async () => {
  const f = await formalOpen({ without: [FIX] });
  try {
    assert.deepEqual(
      (await rows(f.db, 'owner', 'select gate_id from public.mu7_gate_approvals')).map(
        (r) => r.gate_id,
      ),
      ['G-PAIN-01'],
    );
    assert.equal(
      await one(
        f.db,
        'owner',
        "select count(*)::int from public.mu7_phase_events where event_type = 'FORMAL_OPENED'",
      ),
      1,
      'reproduced: FORMAL_OPENED is recorded while nine of ten documented gates are unapproved',
    );
  } finally {
    await f.db.close();
  }
});

const FREEZE_GATES = ['G-MH-V53', 'G-OVERLAP-01', 'G-PROV-01', 'G-TEXT-01'];
const OPEN_ONLY_GATES = ['G-EST-01', 'G-OQ-03', 'G-OQ-04', 'G-PAIN-01'];

test('finding 3 with 0026: every documented gate is recorded as pending, with no approval and nothing satisfied', async () => {
  const { db } = await signedOffPilot({ stopAfter: 'design' });
  try {
    const req = await rows<{
      gate_id: string;
      requirement_status: string;
      blocks: string[];
      decision_reference: string | null;
    }>(
      db,
      'owner',
      'select gate_id, requirement_status, blocks, decision_reference from public.mu7_gate_requirements order by gate_id',
    );
    assert.deepEqual(
      req.map((r) => r.gate_id),
      [
        'G-EST-01',
        'G-MH-V53',
        'G-OQ-03',
        'G-OQ-04',
        'G-OVERLAP-01',
        'G-PAIN-01',
        'G-PROV-01',
        'G-PROV-02',
        'G-PROV-03',
        'G-TEXT-01',
      ],
    );
    assert.ok(
      req.every(
        (r) => r.requirement_status === 'PENDING_SPECIFICATION' && r.decision_reference === null,
      ),
    );
    const blocking = (op: string) => req.filter((r) => r.blocks.includes(op)).map((r) => r.gate_id);
    assert.deepEqual(blocking('FREEZE'), FREEZE_GATES);
    assert.deepEqual(blocking('FORMAL_OPEN').sort(), [...FREEZE_GATES, ...OPEN_ONLY_GATES].sort());
    assert.equal(await one(db, 'owner', 'select count(*)::int from public.mu7_gate_approvals'), 0);
    assert.equal(
      await one(
        db,
        'inv',
        'select count(*)::int from public.rpc_mu7_gate_status() where satisfied',
      ),
      0,
    );
    assert.equal(
      await one(
        db,
        'inv',
        "select count(*)::int from public.rpc_mu7_gate_status() where requirement_status = 'PENDING_SPECIFICATION'",
      ),
      10,
    );
  } finally {
    await db.close();
  }
});

test('finding 3 fixed with 0026: a pending gate cannot be approved and the FORMAL freeze stays disabled', async () => {
  const f = await formalOpen({ gates: [], stopAfter: 'formalImport' });
  try {
    const approve = await attempt(
      f.db,
      `select public.rpc_mu7_approve_gate('G-PAIN-01', '${ATT}', 'synthetic decision record')`,
    );
    assert.ok(!approve.ok);
    assert.match(
      approve.error,
      /MU7X-G08: gate G-PAIN-01 cannot be approved while its requirement is pending/,
    );
    const freeze = await attempt(f.db, freezeSql());
    assert.ok(!freeze.ok);
    // 0024's own G29 (the Pain units wait for G-PAIN-01) fires first, before 0026's gate check.
    assert.match(freeze.error, /MU7-G29/);
    // With the Pain gate specified and approved synthetically, 0026 names every pending freeze gate.
    const g = await formalOpen({ gates: ['G-PAIN-01'], stopAfter: 'formalImport' });
    try {
      const again = await attempt(g.db, freezeSql());
      assert.ok(!again.ok);
      assert.match(again.error, /MU7X-G06: the FORMAL freeze is disabled until/);
      for (const gate of FREEZE_GATES)
        assert.ok(again.error.includes(`${gate} (requirement pending specification)`), gate);
      assert.ok(!again.error.includes('G-PAIN-01'), 'the specified and approved gate is satisfied');
    } finally {
      await g.db.close();
    }
  } finally {
    await f.db.close();
  }
});

test('finding 3 fixed with 0026: the formal phase stays closed until every opening gate is specified and approved', async () => {
  const f = await formalOpen({ gates: ['G-PAIN-01', ...FREEZE_GATES], stopAfter: 'freeze' });
  try {
    const open = await attempt(f.db, phase('FORMAL_OPENED'));
    assert.ok(!open.ok);
    assert.match(open.error, /MU7X-G07: the formal phase stays closed until/);
    for (const gate of ['G-EST-01', 'G-OQ-03', 'G-OQ-04'])
      assert.ok(open.error.includes(`${gate} (requirement pending specification)`), gate);
    for (const gate of ['G-PAIN-01', ...FREEZE_GATES]) assert.ok(!open.error.includes(gate), gate);
  } finally {
    await f.db.close();
  }
  // Positive control: every gate specified and approved (synthetically) opens the phase.
  const all = await formalOpen();
  try {
    assert.equal(
      await one(
        all.db,
        'owner',
        "select count(*)::int from public.mu7_phase_events where event_type = 'FORMAL_OPENED'",
      ),
      1,
    );
  } finally {
    await all.db.close();
  }
});

test('finding 3 fixed with 0026: an approval counts only for the specified decision record it names, recorded after it', async () => {
  const f = await formalOpen({ gates: ['G-PAIN-01', ...FREEZE_GATES], stopAfter: 'freeze' });
  try {
    // Specified, but the approval names another record: refused (an approval cannot be replaced).
    await f.db.query(
      `insert into public.mu7_gate_requirements (gate_id, requirement_version, blocks, requirement_status, question, decision_reference, source)
       values ('G-EST-01', 2, array['FORMAL_OPEN'], 'SPECIFIED', 'Synthetic estimator question.', $1, 'SYNTHETIC test')`,
      [syntheticDecision('G-EST-01')],
    );
    const wrong = await attempt(
      f.db,
      `select public.rpc_mu7_approve_gate('G-EST-01', '${ATT}', 'another synthetic record')`,
    );
    assert.ok(!wrong.ok);
    assert.match(
      wrong.error,
      /MU7X-G08: an approval of gate G-EST-01 names its specified decision record/,
    );
    const missing = await attempt(f.db, `select public.rpc_mu7_approve_gate('G-EST-01', '${ATT}')`);
    assert.ok(!missing.ok, 'an approval without evidence is refused once the gate is specified');
    // A later re-specification makes an earlier approval stale for that gate.
    const reSpecified = await formalOpen({ stopAfter: 'freeze' });
    try {
      await reSpecified.db.query(
        `insert into public.mu7_gate_requirements (gate_id, requirement_version, blocks, requirement_status, question, decision_reference, source)
         values ('G-OQ-03', 3, array['FORMAL_OPEN'], 'SPECIFIED', 'Synthetic re-specified question.', 'SYNTHETIC-TEST-DECISION-G-OQ-03-B', 'SYNTHETIC test')`,
      );
      const open = await attempt(reSpecified.db, phase('FORMAL_OPENED'));
      assert.ok(!open.ok);
      assert.match(open.error, /G-OQ-03 \(approval does not name the specified decision record\)/);
    } finally {
      await reSpecified.db.close();
    }
  } finally {
    await f.db.close();
  }
});

test('0026 gate requirements: investigator-readable, reviewer-invisible, append-only and written by migrations only', async () => {
  const db = await newDatabase();
  try {
    const { db: pilotDb } = await signedOffPilot({ existing: undefined, stopAfter: 'design' });
    try {
      assert.equal(
        (await rows(pilotDb, 'inv', 'select gate_id from public.mu7_gate_requirements')).length,
        10,
      );
      assert.equal(
        (await rows(pilotDb, 'r1', 'select gate_id from public.mu7_gate_requirements')).length,
        0,
      );
      const status = await attempt(
        pilotDb,
        'select count(*) from public.rpc_mu7_gate_status()',
        'r1',
      );
      assert.ok(!status.ok, 'a reviewer cannot read the gate status');
      const insert = await attempt(
        pilotDb,
        "insert into public.mu7_gate_requirements (gate_id, requirement_version, blocks, requirement_status, question, decision_reference, source) values ('G-EST-01', 9, '{}', 'SPECIFIED', 'An investigator cannot specify.', 'x-x-x', 'app') returning gate_id",
      );
      assert.ok(!insert.ok);
      assert.match(insert.error, /permission denied/);
    } finally {
      await pilotDb.close();
    }
    for (const sql of [
      "update public.mu7_gate_requirements set requirement_status = 'SPECIFIED', decision_reference = 'x-x-x'",
      'delete from public.mu7_gate_requirements',
      'truncate public.mu7_gate_requirements',
    ]) {
      const r = await attempt(db, sql, 'owner');
      assert.ok(!r.ok, `owner ${sql.split(' ')[0]} is refused`);
    }
    await db.exec('set role service_role');
    try {
      await assert.rejects(
        db.query(
          "insert into public.mu7_gate_requirements (gate_id, requirement_version, blocks, requirement_status, question, source) values ('G-EST-01', 9, '{}', 'PENDING_SPECIFICATION', 'service role cannot write.', 'x-x')",
        ),
        /permission denied/,
      );
    } finally {
      await db.exec('reset role');
    }
    // A specified requirement names its decision record, and a pending one names none.
    await assert.rejects(
      db.query(
        "insert into public.mu7_gate_requirements (gate_id, requirement_version, blocks, requirement_status, question, source) values ('G-EST-01', 9, '{}', 'SPECIFIED', 'Specified without a record.', 'x-x')",
      ),
      /check constraint/,
    );
  } finally {
    await db.close();
  }
});

// ---- PR #9 review: a revision and the first adjudication of the same unit ---------------------
test('0026: adjudications take the exclusive v7 serialization lock (native race in tests/mu7-postgres.test.ts)', async () => {
  for (const fixed of [false, true]) {
    const db = await newDatabase(without(fixed));
    try {
      const fn = await one(
        db,
        'owner',
        "select p.proname from pg_trigger t join pg_proc p on p.oid = t.tgfoid where t.tgrelid = 'public.mu7_adjudications'::regclass and t.tgname = 'a00_mu7_serialize'",
      );
      assert.equal(fn, fixed ? 'mu7_serialize_transition' : 'mu7_serialize_write');
    } finally {
      await db.close();
    }
  }
});
