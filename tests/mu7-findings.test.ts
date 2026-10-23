// Review findings on migration 0024 (review design v7), reproduced on this repository's full chain
// and closed by migration 0025. Each check runs twice: WITHOUT 0025 it must still show the defect
// (so the test cannot pass trivially), and WITH 0025 the defect must be gone. Synthetic data only.
// The submission/close race needs two connections and runs on native PostgreSQL 16 in
// tests/mu7-postgres.test.ts; here the serialization is checked structurally.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  answerAll,
  as,
  assignmentOf,
  formalOpen,
  FORMAL_QUEUE_1,
  one,
  phase,
  rows,
  signedOffPilot,
  submitSql,
  type FormalOpen,
} from './mu7-fixture';

const FIX = 'migrations/0025_v7_review_fixes.sql';
// 0026 builds on 0025 (it replaces 0025's adjudication trigger), so it leaves with it.
const WITHOUT_FIX = [FIX, 'migrations/0026_v7_lifecycle_and_gates.sql'];
const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
const MU7_TABLES = [
  'mu7_design',
  'mu7_phase_events',
  'mu7_units',
  'mu7_unit_design',
  'mu7_frozen_assignments',
  'mu7_gate_approvals',
  'mu7_freeze',
  'mu7_queue',
  'mu7_judgments',
  'mu7_snapshot',
  'mu7_adjudications',
  'mu7_reference_locks',
  'mu7_exports',
  'mu7_training_units',
  'mu7_training_acknowledgments',
];

/** Brute-forces the unsalted 0024 judgment hash from what the investigator can read mid-phase. */
async function investigatorRecoversAnswer(fixed: boolean): Promise<string | null> {
  const f = await formalOpen({ without: fixed ? [] : WITHOUT_FIX });
  try {
    const unit = FORMAL_QUEUE_1[0];
    const assignment = await assignmentOf(f.db, f.R1, unit);
    await as(f.db, 'r1', () =>
      f.db.query(submitSql(assignment, { answer: 'CANNOT_TELL', uncertain: true })),
    );
    assert.equal(
      (await rows(f.db, 'inv', "select 1 from public.mu7_judgments where mode = 'FORMAL'")).length,
      0,
      'precondition: the judgment table itself hides FORMAL answers while the phase is open',
    );
    const audit = await rows<{ details: Record<string, string> }>(
      f.db,
      'inv',
      "select details from public.audit_log where entity_table = 'mu7_judgments' and mode = 'FORMAL'",
    );
    assert.equal(
      audit.length,
      1,
      'the FORMAL judgment insert is audited and visible to the investigator',
    );
    const visible = await rows<{ assignment_id: string; unit_id: string }>(
      f.db,
      'inv',
      "select assignment_id, unit_id from public.mu7_queue where mode = 'FORMAL'",
    );
    const candidates = Object.values(audit[0].details).filter((v) =>
      /^[0-9a-f]{64}$/.test(String(v)),
    );
    for (const logged of candidates)
      for (const a of visible.filter((x) => x.unit_id === unit))
        for (const answer of ['AGREE', 'CANNOT_TELL'])
          for (const uncertain of ['true', 'false'])
            for (const seconds of ['', ...Array.from({ length: 3600 }, (_, i) => String(i))])
              if (
                sha256([a.assignment_id, '1', answer, '', '', uncertain, seconds].join('|')) ===
                logged
              )
                return `${answer}/${uncertain}`;
    if (fixed) {
      // Tamper evidence is kept for the key holder: the owner recomputes the keyed digest.
      const ok = await one(
        f.db,
        'owner',
        `select (select private.mu7_audit_digest(j.content_sha256) from public.mu7_judgments j where j.mode = 'FORMAL') = $1 as ok`,
        [audit[0].details.content_hmac_sha256],
      );
      assert.equal(ok, true, 'the owner can verify the keyed digest against the row');
      assert.equal(
        audit[0].details.content_sha256,
        undefined,
        'the unsalted hash is no longer written to the audit log',
      );
    }
    return null;
  } finally {
    await f.db.close();
  }
}

test('finding 1 (blocker): FORMAL answers are recoverable from the audit log without 0025, not with it', async () => {
  assert.equal(
    await investigatorRecoversAnswer(false),
    'CANNOT_TELL/true',
    'reproduced without 0025',
  );
  assert.equal(await investigatorRecoversAnswer(true), null, 'closed by 0025');
  // The investigator cannot read the key or call the digest function.
  const f = await formalOpen();
  try {
    await assert.rejects(
      rows(f.db, 'inv', 'select * from private.mu7_audit_key'),
      /permission denied/,
    );
    await assert.rejects(
      one(f.db, 'inv', "select private.mu7_audit_digest('x')"),
      /permission denied/,
    );
  } finally {
    await f.db.close();
  }
});

/** Closes and snapshots the formal phase after both reviewers answered, so the adjudicator may read. */
async function closedAndSnapshotted(fixed: boolean): Promise<FormalOpen> {
  const f = await formalOpen({ without: fixed ? [] : WITHOUT_FIX });
  await answerAll(f, 'r1', () => ({ answer: 'AGREE' }));
  await answerAll(f, 'r2', (u) =>
    u === FORMAL_QUEUE_1[0]
      ? { answer: 'DISAGREE', reason_code: 'OTHER_SPECIFIED', note: 'Synthetic note.' }
      : { answer: 'AGREE' },
  );
  await one(f.db, 'inv', phase('FORMAL_CLOSED_COMPLETE'));
  await one(f.db, 'inv', 'select public.rpc_mu7_snapshot()');
  return f;
}
const ADJ_READS = [
  ['v_mu7_independent_judgments', 'select * from public.v_mu7_independent_judgments'],
  ['v_mu7_final_reference', 'select * from public.v_mu7_final_reference'],
  ['v_mu7_adjudication_queue', 'select * from public.v_mu7_adjudication_queue'],
  ['mu7_judgments', 'select * from public.mu7_judgments'],
  ['mu7_units', 'select * from public.mu7_units'],
  ['mu7_queue', 'select * from public.mu7_queue'],
  ['mu7_adjudications', 'select * from public.mu7_adjudications'],
] as const;
async function adjudicatorReads(f: FormalOpen) {
  const out: Record<string, number> = {};
  for (const [label, sql] of ADJ_READS) out[label] = (await rows(f.db, 'adj', sql)).length;
  out['private.mu7_can_read_judgments(FORMAL)'] =
    (await one(f.db, 'adj', "select private.mu7_can_read_judgments('FORMAL')")) === true ? 1 : 0;
  return out;
}
async function lockAdjudicator(f: FormalOpen) {
  // As the privileged tooling does (0021: locks are written by the service role only).
  await f.db.query(
    "insert into public.account_locks (user_id, locked_by, reason) select user_id, 'synthetic-test', 'Synthetic lock for testing only.' from public.users where email = 'adjudicator@example.test'",
  );
}

test('finding 9 (blocker): a locked adjudicator keeps v7 access through an issued token without 0025, not with it', async () => {
  // Without 0025: reproduce.
  {
    const f = await closedAndSnapshotted(false);
    try {
      await lockAdjudicator(f);
      const reads = await adjudicatorReads(f);
      assert.ok(
        Object.values(reads).some((n) => n > 0),
        `precondition: the defect reproduces without 0025 (${JSON.stringify(reads)})`,
      );
    } finally {
      await f.db.close();
    }
  }
  // With 0025: every read path is empty, the tie-break RPC refuses, and the release restores access.
  const f = await closedAndSnapshotted(true);
  try {
    const before = await adjudicatorReads(f);
    assert.ok(
      before.mu7_judgments > 0 && before.v_mu7_adjudication_queue > 0,
      'unlocked adjudicator reads',
    );
    await lockAdjudicator(f);
    const locked = await adjudicatorReads(f);
    assert.deepEqual(
      Object.entries(locked).filter(([, n]) => n > 0),
      [],
      `a locked adjudicator reads: ${JSON.stringify(locked)}`,
    );
    await assert.rejects(
      one(
        f.db,
        'adj',
        `select public.rpc_mu7_record_adjudication('${JSON.stringify({ unit_id: FORMAL_QUEUE_1[0], decision: 'AGREE', status: 'DISCORDANT_RESOLVED', basis: 'REVIEWER_1', rationale: 'Synthetic.' })}'::jsonb)`,
      ),
      /MU7-G58/,
    );
    await f.db.query(
      "update public.account_locks set released_at = now(), released_by = 'synthetic-test' where released_at is null",
    );
    assert.deepEqual(await adjudicatorReads(f), before, 'releasing the lock restores access');
  } finally {
    await f.db.close();
  }
});

async function serializingTriggers(fixed: boolean) {
  const f = await signedOffPilot({ without: fixed ? [] : WITHOUT_FIX });
  try {
    return await rows<{ tbl: string; fn: string; first: boolean }>(
      f.db,
      'owner',
      `select c.relname as tbl, p.proname as fn,
              t.tgname < all (select g.tgname from pg_trigger g where g.tgrelid = c.oid and not g.tgisinternal and g.tgname like 'mu7_%') as first
         from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_proc p on p.oid = t.tgfoid
        where t.tgname = 'a00_mu7_serialize' order by c.relname`,
    );
  } finally {
    await f.db.close();
  }
}

test('finding 2 (blocker): every v7 write and transition is serialized, before 0024 reads the state', async () => {
  assert.deepEqual(
    await serializingTriggers(false),
    [],
    'reproduced: no serialization without 0025',
  );
  const triggers = await serializingTriggers(true);
  // On the full chain 0026 moves mu7_adjudications from the shared to the exclusive lock (a revision
  // and the first adjudication of a unit must not both commit; tests/mu7-lifecycle.test.ts).
  // 0029 adds the per-version gate approvals, serialized like every other v7 write.
  const expectWrite = [
    'mu7_frozen_assignments',
    'mu7_gate_approval_versions',
    'mu7_gate_approvals',
    'mu7_judgments',
    'mu7_queue',
    'mu7_training_units',
    'mu7_unit_design',
    'mu7_units',
  ];
  const expectTransition = [
    'mu7_adjudications',
    'mu7_exports',
    'mu7_freeze',
    'mu7_phase_events',
    'mu7_reference_locks',
    'mu7_snapshot',
  ];
  assert.deepEqual(
    triggers.filter((t) => t.fn === 'mu7_serialize_write').map((t) => t.tbl),
    expectWrite,
  );
  assert.deepEqual(
    triggers.filter((t) => t.fn === 'mu7_serialize_transition').map((t) => t.tbl),
    expectTransition,
  );
  assert.ok(
    triggers.every((t) => t.first),
    'the lock trigger fires before every 0024 trigger',
  );
});

test('finding 4: each phase event is recorded once, structurally, even past the trigger', async () => {
  for (const fixed of [false, true]) {
    const f = await formalOpen({ without: fixed ? [] : WITHOUT_FIX });
    try {
      // The owner inserts a second FORMAL_OPENED with triggers off (standing in for a racing call).
      const second = f.db.query(
        `do $$ begin perform set_config('session_replication_role', 'replica', true);
           insert into public.mu7_phase_events (event_type, attestation, actor)
           select 'FORMAL_OPENED', 'Synthetic attestation for testing only.', user_id from public.users where role = 'INVESTIGATOR' limit 1; end $$`,
      );
      if (fixed) await assert.rejects(second, /mu7_phase_events_once/);
      else await second;
    } finally {
      await f.db.close();
    }
  }
});

test('finding 5: an adjudicated PILOT unit takes no further answer', async () => {
  for (const fixed of [false, true]) {
    const { db, PT1 } = await signedOffPilot({
      without: fixed ? [] : WITHOUT_FIX,
      stopAfterPilotAdjudication: true,
    });
    try {
      const unit = 'SYN7-AREA-RESPIRATORY-001'; // routed and adjudicated by the fixture
      const revise = as(db, 'pt1', async () =>
        db.query(
          submitSql(await assignmentOf(db, PT1, unit), {
            answer: 'AGREE',
            note: 'Synthetic revision.',
          }),
        ),
      );
      if (fixed) await assert.rejects(revise, /MU7X-G01/);
      else await revise; // reproduced: the stale adjudication survives a changed pair
    } finally {
      await db.close();
    }
  }
});

test('finding 7: service_role holds no write privilege on any v7 table', async () => {
  for (const fixed of [false, true]) {
    const { db } = await signedOffPilot({
      without: fixed ? [] : WITHOUT_FIX,
      stopAfterPilotAdjudication: true,
    });
    try {
      const writable = await rows<{ t: string }>(
        db,
        'owner',
        `select t from unnest($1::text[]) t
          where has_table_privilege('service_role', 'public.' || t, 'INSERT')
             or has_table_privilege('service_role', 'public.' || t, 'UPDATE')
             or has_table_privilege('service_role', 'public.' || t, 'DELETE')`,
        [MU7_TABLES],
      );
      if (fixed) assert.deepEqual(writable, []);
      // Without 0025 the outcome depends on the project's default privileges; recorded, not asserted.
    } finally {
      await db.close();
    }
  }
});

test('finding 3 (characterization, no fix yet): what coexists with a recorded v7 design today', async () => {
  const { db } = await signedOffPilot(); // the v7 design is recorded and its pilot signed off
  try {
    // Reachable: a mapping-confirmation (0016) campaign can still be created next to v7, and
    // synthetic mappings imported into it. Nothing of it enters a statistic (0018 is synthetic-only).
    assert.equal(
      await one(
        db,
        'inv',
        `select public.rpc_mc_create_campaign('{"condition_set_id":"CONDSET-SYN","condition_set_status":"PROPOSED","rubric_version":"RUBRIC-SYN","rubric_sha256":"${'a'.repeat(64)}"}'::jsonb)`,
      ),
      true,
    );
    // Not reachable today: an EVALUATION mapping (refused by 0018 in this build).
    await assert.rejects(
      one(
        db,
        'inv',
        `select public.rpc_mc_import_case('{"case_id":"MC-EVL-001","record_category":"EVALUATION","trial_ref":"SYN-NCT-1001","condition_code":"OBE","condition_set_id":"CONDSET-SYN"}'::jsonb)`,
      ),
      /evaluation import is disabled pending scientific approval/,
    );
    // Not reachable without a completed v2 synthetic pilot: the v2 FORMAL unlock, and with it the
    // v2 FORMAL reviewer enrolment that bypasses rpc_mu7_enroll_reviewer (guard MU7-G08).
    await assert.rejects(
      one(
        db,
        'inv',
        `select public.rpc_unlock_formal_review('PAC-1', '${'1'.repeat(64)}', 'abc', gen_random_uuid(), 'Synthetic attestation for testing only.')`,
      ),
      /pilot incomplete/,
    );
    await assert.rejects(
      one(
        db,
        'inv',
        "select public.rpc_enroll_reviewer((select user_id from public.users where email = 'reviewer1@example.test'), 'FORMAL', 'x')",
      ),
      /only after the pilot sign-off unlocks the formal review/,
    );
  } finally {
    await db.close();
  }
});

test(
  'finding 3 (proposed guard): v7 and the other formal paths exclude each other without touching synthetic pilots',
  {
    todo: 'prepared, not applied: migrations/proposed/v7_cross_design_coexistence.sql, tested by tests/mu7-coexistence-proposal.test.ts; awaits the investigator',
  },
  () => {},
);
