// Engineering messages v8.3 and v8.4 and the investigator's instruction of 2026-10-24, on the full
// chain with migration 0032. G-OQ-03, G-OQ-04 and G-EST-01 now hold the FORMAL freeze as well as the
// formal opening, and stay pending specification (their texts and the estimator are not approved).
// G-PAIN-01 version 3 names addendum 8, item 40, addendum 11, item 60 and rubric 7.1. G-PROV-02 and
// G-PROV-03 hold nothing. The migration approves nothing. Synthetic data only: every approval and
// every synthetic specification below is made in a disposable test database (tests/mu7-fixture.ts)
// and is never a study decision. The investigator's private dry run checks the same properties
// against the proposed sample and its recorded hashes, which this public repository does not hold.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ATT,
  FORMAL_QUEUE_1,
  FORMAL_QUEUE_2,
  formalOpen,
  freezeSql,
  one,
  phase,
  rows,
  specifyAndApproveGates,
  syntheticDecision,
  type FixtureDb,
} from './mu7-fixture';

const RUBRIC_7_1_SHA256 = '9ab8d6a9aa146b648358c7f3993068a8963146861a5d0b04ae5d6e1bda60cf46';
const PAIN_RECORD_V3 = `investigator decisions 2026-10-23, addendum 8, item 40, and addendum 11, item 60, with rubric 7.1 (SHA-256 ${RUBRIC_7_1_SHA256})`;
const PAIN_RECORD_V2 = 'investigator decisions 2026-10-23, addendum 8, item 40';
const MH_RECORD =
  'investigator decision 37 with the G-MH-V53 check of 2026-10-23, run 2 (SHA-256 7c66e1b098c5cfde2f322f443c3412fd7e766d00e87c83f674e5eed1cc1fd46e)';

/** The gates that hold the FORMAL freeze after 0032 (sorted as the guard lists them). */
const FREEZE_GATES = [
  'G-EST-01',
  'G-MH-V53',
  'G-OQ-03',
  'G-OQ-04',
  'G-OVERLAP-01',
  'G-PROV-01',
  'G-TEXT-01',
];
const OPENING_GATES = [...FREEZE_GATES, 'G-PAIN-01'].sort();
/** Moved to the freeze by 0032. */
const MOVED = ['G-EST-01', 'G-OQ-03', 'G-OQ-04'];
/** Still pending specification in the migrations; specified synthetically below when a test needs them. */
const OTHER_PENDING = ['G-OVERLAP-01', 'G-PROV-01', 'G-TEXT-01'];
const NON_BLOCKING = ['G-PROV-02', 'G-PROV-03'];

const approve = (gate: string, evidence: string) =>
  `select public.rpc_mu7_approve_gate('${gate}', '${ATT}', '${evidence.replace(/'/g, "''")}') as g`;
async function attempt(db: FixtureDb, who: Parameters<typeof one>[1], sql: string) {
  try {
    return { ok: true as const, value: await one(db, who, sql) };
  } catch (e) {
    return { ok: false as const, error: (e as Error).message };
  }
}
type GateRow = {
  gate_id: string;
  requirement_version: number;
  blocks: string[];
  requirement_status: string;
  decision_reference: string | null;
  satisfied: boolean;
};
const gateStatus = async (db: FixtureDb) =>
  Object.fromEntries(
    (
      await rows<GateRow>(
        db,
        'inv',
        'select gate_id, requirement_version, blocks, requirement_status, decision_reference, satisfied from public.rpc_mu7_gate_status()',
      )
    ).map((g) => [g.gate_id, g]),
  );
/** G-PAIN-01 and G-MH-V53 approved with the records their migrations specify (the investigator's act). */
async function approveSpecifiedGates(db: FixtureDb) {
  assert.ok((await attempt(db, 'inv', approve('G-PAIN-01', PAIN_RECORD_V3))).ok, 'G-PAIN-01');
  assert.ok((await attempt(db, 'inv', approve('G-MH-V53', MH_RECORD))).ok, 'G-MH-V53');
}
/** A later reviewed re-specification, stood in for by the owner in this disposable database. */
async function reSpecify(db: FixtureDb, gate: string, record: string) {
  await db.query(
    `insert into public.mu7_gate_requirements (gate_id, requirement_version, blocks, requirement_status, question, decision_reference, source)
     select gate_id, requirement_version + 1, blocks, 'SPECIFIED', question, $2, 'SYNTHETIC test re-specification'
     from public.mu7_gate_requirements where gate_id = $1 order by requirement_version desc limit 1`,
    [gate, record],
  );
}

test('0032 records the v8.4 gate matrix, keeps the three moved gates pending, and approves nothing', async () => {
  const f = await formalOpen({ gates: [], stopAfter: 'formalImport' });
  try {
    const by = await gateStatus(f.db);
    const holding = (op: string) =>
      Object.values(by)
        .filter((g) => g.blocks.includes(op))
        .map((g) => g.gate_id)
        .sort();
    assert.deepEqual(holding('FREEZE'), FREEZE_GATES);
    assert.deepEqual(holding('FORMAL_OPEN'), OPENING_GATES);
    for (const g of MOVED) {
      assert.equal(by[g].requirement_version, 2, g);
      assert.deepEqual(by[g].blocks, ['FREEZE', 'FORMAL_OPEN'], g);
      assert.equal(by[g].requirement_status, 'PENDING_SPECIFICATION', g);
      assert.equal(by[g].decision_reference, null, g);
    }
    assert.equal(by['G-PAIN-01'].requirement_version, 3);
    assert.equal(by['G-PAIN-01'].requirement_status, 'SPECIFIED');
    assert.equal(by['G-PAIN-01'].decision_reference, PAIN_RECORD_V3);
    assert.ok(by['G-PAIN-01'].decision_reference?.includes(RUBRIC_7_1_SHA256));
    assert.deepEqual(by['G-PAIN-01'].blocks, ['FORMAL_OPEN']);
    for (const g of NON_BLOCKING) {
      assert.deepEqual(by[g].blocks, [], g);
      assert.equal(by[g].requirement_status, 'PENDING_SPECIFICATION', g);
    }
    assert.ok(
      Object.values(by).every((g) => !g.satisfied),
      'nothing is satisfied',
    );
    assert.equal(
      await one(
        f.db,
        'owner',
        'select ((select count(*) from public.mu7_gate_approvals) + (select count(*) from public.mu7_gate_approval_versions))::int',
      ),
      0,
    );
    // Append-only: the earlier versions stay as 0026 and 0028 recorded them.
    const earlier = await rows<{ gate_id: string; blocks: string[]; decision_reference: string }>(
      f.db,
      'owner',
      "select gate_id, blocks, decision_reference from public.mu7_gate_requirements where (gate_id, requirement_version) in (('G-EST-01', 1), ('G-OQ-03', 1), ('G-OQ-04', 1), ('G-PAIN-01', 2)) order by gate_id",
    );
    assert.deepEqual(
      earlier.map((r) => [r.gate_id, r.blocks]),
      [
        ['G-EST-01', ['FORMAL_OPEN']],
        ['G-OQ-03', ['FORMAL_OPEN']],
        ['G-OQ-04', ['FORMAL_OPEN']],
        ['G-PAIN-01', ['FORMAL_OPEN']],
      ],
    );
    assert.equal(
      earlier.find((r) => r.gate_id === 'G-PAIN-01')?.decision_reference,
      PAIN_RECORD_V2,
    );
    assert.equal(
      await one(
        f.db,
        'owner',
        "select count(*)::int from public.app_schema_version where version = '7.0.7-v7-freeze-gates-v8-4'",
      ),
      1,
    );
  } finally {
    await f.db.close();
  }
});

test('G-OQ-03, G-OQ-04 and G-EST-01 cannot be approved while their requirements are pending', async () => {
  const f = await formalOpen({ gates: [], stopAfter: 'formalImport' });
  try {
    for (const g of MOVED) {
      const r = await attempt(f.db, 'inv', approve(g, 'any record'));
      assert.ok(!r.ok, g);
      assert.match(
        r.error,
        new RegExp(`MU7X-G08: gate ${g} cannot be approved while its requirement is pending`),
      );
    }
    assert.equal(
      await one(f.db, 'owner', 'select count(*)::int from public.mu7_gate_approvals'),
      0,
    );
  } finally {
    await f.db.close();
  }
});

test('the freeze is refused while G-OQ-03, G-OQ-04 or G-EST-01 is open, each on its own', async () => {
  for (const open of MOVED) {
    const f = await formalOpen({ gates: [], stopAfter: 'formalImport' });
    try {
      await approveSpecifiedGates(f.db);
      await specifyAndApproveGates(f.db, [...OTHER_PENDING, ...MOVED.filter((g) => g !== open)]);
      const refused = await attempt(f.db, 'inv', freezeSql());
      assert.ok(!refused.ok, `${open} holds the freeze`);
      assert.match(refused.error, /MU7X-G06: the FORMAL freeze is disabled until/);
      assert.ok(refused.error.includes(`${open} (requirement pending specification)`), open);
      for (const g of [...FREEZE_GATES, 'G-PAIN-01'].filter((x) => x !== open))
        assert.ok(!refused.error.includes(g), `${g} is satisfied`);
      assert.equal(
        await one(f.db, 'owner', 'select count(*)::int from public.mu7_freeze'),
        0,
        'nothing was frozen',
      );
      // Positive control: once that gate is specified and approved (synthetically), the freeze passes.
      await specifyAndApproveGates(f.db, [open]);
      assert.ok((await attempt(f.db, 'inv', freezeSql())).ok, `${open}: the freeze passes`);
    } finally {
      await f.db.close();
    }
  }
});

test('the formal opening still checks G-OQ-03, G-OQ-04 and G-EST-01 after the freeze', async () => {
  const f = await formalOpen({ stopAfter: 'freeze' });
  try {
    for (const g of MOVED) {
      // A re-specification after the freeze (a new version, not yet approved) holds the opening.
      await reSpecify(f.db, g, `${syntheticDecision(g)}-AFTER-FREEZE`);
      const refused = await attempt(f.db, 'inv', phase('FORMAL_OPENED'));
      assert.ok(!refused.ok, g);
      assert.match(refused.error, /MU7X-G07: the formal phase stays closed until/);
      assert.ok(refused.error.includes(`${g} (not approved)`), g);
      assert.ok(
        (await attempt(f.db, 'inv', approve(g, `${syntheticDecision(g)}-AFTER-FREEZE`))).ok,
      );
    }
    assert.ok((await attempt(f.db, 'inv', phase('FORMAL_OPENED'))).ok);
    assert.equal(
      await one(
        f.db,
        'owner',
        "select count(*)::int from public.mu7_phase_events where event_type = 'FORMAL_OPENED'",
      ),
      1,
    );
  } finally {
    await f.db.close();
  }
});

test('approving G-PAIN-01 version 3 lifts the unit hold of the Pain units only; the freeze still waits for every open freeze gate', async () => {
  const f = await formalOpen({ gates: [], stopAfter: 'formalImport' });
  try {
    type Design = { unit_id: string; freeze_status: string; freeze_gate: string | null };
    const design = () =>
      rows<Design>(
        f.db,
        'owner',
        "select unit_id, freeze_status, freeze_gate from public.mu7_unit_design where mode = 'FORMAL' order by unit_id",
      );
    const before = await design();
    const held = before.filter((d) => d.freeze_status === 'BLOCKED_PENDING_GATE');
    assert.ok(held.length >= 1);
    for (const d of held) {
      assert.match(d.unit_id, /^MU7-ROW-PAIN-\d{3}$/, 'only Pain units carry a unit-level gate');
      assert.equal(d.freeze_gate, 'G-PAIN-01');
    }
    assert.ok(
      before
        .filter((d) => !held.includes(d))
        .every((d) => d.freeze_status === 'READY' && d.freeze_gate === null),
    );
    const waiting = await attempt(f.db, 'inv', freezeSql());
    assert.ok(!waiting.ok);
    assert.match(
      waiting.error,
      /MU7-G29: units are blocked from the freeze until their gate is approved: G-PAIN-01/,
    );
    // The approval must cite version 3's whole record; item 40 alone (version 2) is refused.
    const stale = await attempt(f.db, 'inv', approve('G-PAIN-01', PAIN_RECORD_V2));
    assert.ok(!stale.ok);
    assert.match(stale.error, /MU7X-G0[89]: an approval/);
    assert.ok((await attempt(f.db, 'inv', approve('G-PAIN-01', PAIN_RECORD_V3))).ok);
    const by = await gateStatus(f.db);
    assert.deepEqual(
      Object.values(by)
        .filter((g) => g.satisfied)
        .map((g) => g.gate_id),
      ['G-PAIN-01'],
      'the approval satisfies G-PAIN-01 and no other gate',
    );
    const after = await attempt(f.db, 'inv', freezeSql());
    assert.ok(!after.ok);
    assert.doesNotMatch(after.error, /MU7-G29|MU7X-G10/);
    assert.match(after.error, /MU7X-G06/);
    for (const g of FREEZE_GATES) assert.ok(after.error.includes(g), g);
    assert.ok(!after.error.includes('G-PAIN-01'));
    // The hold is lifted by the guard, not by editing a design row.
    assert.deepEqual(await design(), before);
  } finally {
    await f.db.close();
  }
});

test('no gate approval changes a freeze-bound hash or a packet hash; the frozen hashes verify', async () => {
  const f = await formalOpen({ gates: [], stopAfter: 'formalImport' });
  try {
    const snapshot = async () => ({
      recomputed: await rows<{ quantity: string; recomputed: string | null }>(
        f.db,
        'inv',
        'select quantity, recomputed from public.rpc_mu7_verify_freeze() order by quantity',
      ),
      packets: await rows(
        f.db,
        'owner',
        "select unit_id, packet_sha256 from public.mu7_units where mode = 'FORMAL' order by unit_id",
      ),
      design: await rows(
        f.db,
        'owner',
        "select unit_id, design_row_sha256, freeze_status, freeze_gate from public.mu7_unit_design where mode = 'FORMAL' order by unit_id",
      ),
      assignments: await rows(
        f.db,
        'owner',
        'select unit_id, row_sha256 from public.mu7_frozen_assignments order by unit_id',
      ),
    });
    const before = await snapshot();
    assert.ok(
      before.packets.some((p) => String(p.unit_id).startsWith('MU7-ROW-PAIN-')),
      'the Pain packet hashes are part of the comparison',
    );
    await approveSpecifiedGates(f.db);
    await specifyAndApproveGates(f.db, [...OTHER_PENDING, ...MOVED]);
    assert.deepEqual(await snapshot(), before, 'approvals change no hash and no design row');
    assert.ok(
      (await attempt(f.db, 'inv', freezeSql())).ok,
      'the freeze passes once every gate is met',
    );
    const frozen = (
      await rows<Record<string, string>>(
        f.db,
        'owner',
        'select unit_list_sha256, assignment_set_sha256, design_rows_sha256, packets_sha256 from public.mu7_freeze',
      )
    )[0];
    for (const q of [
      'unit_list_sha256',
      'assignment_set_sha256',
      'design_rows_sha256',
      'packets_sha256',
    ])
      assert.equal(frozen[q], before.recomputed.find((r) => r.quantity === q)?.recomputed, q);
    // The queues assigned after the freeze match the frozen queue hash; all five quantities verify.
    const slots = JSON.stringify({
      slots: [
        { reviewer_slot: 1, reviewer_pseudo_id: f.R1, unit_ids: FORMAL_QUEUE_1 },
        { reviewer_slot: 2, reviewer_pseudo_id: f.R2, unit_ids: FORMAL_QUEUE_2 },
      ],
    }).replace(/'/g, "''");
    assert.ok(
      (
        await attempt(
          f.db,
          'inv',
          `select public.rpc_mu7_assign_queue('FORMAL', '${slots}'::jsonb)`,
        )
      ).ok,
    );
    const verified = await rows<{ quantity: string; matches: boolean }>(
      f.db,
      'inv',
      'select quantity, matches from public.rpc_mu7_verify_freeze() order by quantity',
    );
    assert.equal(verified.length, 5);
    assert.ok(
      verified.every((v) => v.matches),
      JSON.stringify(verified),
    );
  } finally {
    await f.db.close();
  }
});

test('G-PROV-02 and G-PROV-03 never block: with every other gate met, the freeze and the formal opening pass while both stay pending', async () => {
  const f = await formalOpen({ gates: [...FREEZE_GATES, 'G-PAIN-01'] });
  try {
    assert.equal(
      await one(
        f.db,
        'owner',
        "select count(*)::int from public.mu7_phase_events where event_type = 'FORMAL_OPENED'",
      ),
      1,
    );
    const by = await gateStatus(f.db);
    for (const g of NON_BLOCKING) {
      assert.equal(by[g].requirement_status, 'PENDING_SPECIFICATION', g);
      assert.equal(by[g].satisfied, false, g);
      assert.deepEqual(by[g].blocks, [], g);
    }
  } finally {
    await f.db.close();
  }
});
