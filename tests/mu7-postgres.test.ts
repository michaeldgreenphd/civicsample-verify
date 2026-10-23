// Review finding 2 on migration 0024, as a real race on native PostgreSQL 16 (disposable databases
// only; the auth shim never runs on Supabase).
//
// The reachable interleaving: the investigator's close is in flight (inserted, not yet committed)
// when a reviewer submits. 0024's judgment guard reads the phase without a lock, still sees OPEN,
// and accepts the answer; the reviewer's audit write then waits on the audit-chain lock the close
// holds, so the judgment commits after the close. A snapshot taken before that commit computes its
// content without the late judgment, so it never matches again and every FORMAL export is refused.
// (The opposite order, submission first and close second, is already serialized by the audit
// chain lock of schema.sql, so it is not the defect.) With 0025 the submission waits on the v7
// serialization lock until the close commits, then 0024's guard sees CLOSED and refuses it.
import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from 'pg';
import { withDisposableHandoffDatabase } from '../scripts/test-handoff-postgres-helpers.mjs';
import { readFileSync } from 'node:fs';
import {
  FORMAL_QUEUE_1,
  P,
  formalOpen,
  signedOffPilot,
  type FixtureDb,
  type Who,
} from './mu7-fixture';

const baseUrl = process.env.VERIFY_PG_TEST_URL;
const required = process.env.VERIFY_PG_REQUIRE === '1';
const options = {
  skip: !baseUrl && !required ? 'BLOCKED: native PostgreSQL 16 test server unavailable' : false,
  // A regression must fail, never hang the CI job.
  timeout: 120_000,
};
const ATT = 'Synthetic attestation for testing only.';

const wrap = (c: Client): FixtureDb => ({
  exec: (sql) => c.query(sql),
  query: async <T>(sql: string, params: unknown[] = []) => ({
    rows: (await c.query(sql, params)).rows as T[],
  }),
});
async function identify(c: Client, who: Exclude<Who, 'owner'>, local: boolean) {
  await c.query("select set_config('request.jwt.claims', $1, $2)", [JSON.stringify(P[who]), local]);
  await c.query(local ? 'set local role authenticated' : 'set role authenticated');
}
async function waitsOnLock(observer: Client, pid: number) {
  for (let n = 0; n < 150; n++) {
    const r = await observer.query('select wait_event_type from pg_stat_activity where pid = $1', [
      pid,
    ]);
    if (r.rows[0]?.wait_event_type === 'Lock') return true;
    await delay(20);
  }
  return false;
}
const pidOf = async (c: Client) =>
  (await c.query('select pg_backend_pid() as pid')).rows[0].pid as number;

async function race(fixed: boolean) {
  assert.ok(baseUrl, 'BLOCKED: VERIFY_PG_TEST_URL is required');
  return withDisposableHandoffDatabase(baseUrl, async (url: string) => {
    const [owner, reviewer, investigator] = [0, 1, 2].map(
      () => new Client({ connectionString: url }),
    );
    try {
      for (const c of [owner, reviewer, investigator]) await c.connect();
      const f = await formalOpen({
        existing: wrap(owner),
        // 0026 builds on 0025, so it leaves with it.
        without: fixed
          ? []
          : ['migrations/0025_v7_review_fixes.sql', 'migrations/0026_v7_lifecycle_and_gates.sql'],
      });
      const assignment = (
        await owner.query(
          'select assignment_id from public.mu7_queue where reviewer_pseudo_id = $1 and unit_id = $2',
          [f.R1, FORMAL_QUEUE_1[0]],
        )
      ).rows[0].assignment_id as string;

      // 1. The close is in flight: inserted, not committed.
      await investigator.query('begin');
      await identify(investigator, 'inv', true);
      await investigator.query('select public.rpc_mu7_phase($1, $2::jsonb)', [
        'FORMAL_CLOSED_INCOMPLETE',
        JSON.stringify({ attestation: ATT }),
      ]);
      // 2. The reviewer submits meanwhile (in its own transaction).
      await reviewer.query('begin');
      await identify(reviewer, 'r1', true);
      const reviewerPid = await pidOf(reviewer);
      const submit = reviewer
        .query('select public.rpc_mu7_submit($1, \'{"answer":"AGREE"}\'::jsonb)', [assignment])
        .then(
          () => 'ACCEPTED',
          (e: Error) => `REFUSED: ${e.message.slice(0, 120)}`,
        );
      const submitWaited = await waitsOnLock(owner, reviewerPid);
      // 3. The close commits; the submission resumes.
      await investigator.query('commit');
      const outcome = await submit;
      // 4. The snapshot is taken while the reviewer's transaction is still open.
      await identify(investigator, 'inv', false);
      const investigatorPid = await pidOf(investigator);
      const snapshot = investigator.query('select public.rpc_mu7_snapshot()');
      const snapshotWaited = await Promise.race([
        waitsOnLock(owner, investigatorPid),
        snapshot.then(() => false),
      ]);
      // 5. The reviewer's transaction ends (commit if accepted, rollback if refused).
      await reviewer.query(outcome === 'ACCEPTED' ? 'commit' : 'rollback');
      await snapshot;
      const matches = (
        await investigator.query('select matches from public.rpc_mu7_verify_snapshot()')
      ).rows[0].matches as boolean;
      const late = Number(
        (
          await owner.query(
            `select count(*)::int as n from public.mu7_judgments j where j.mode = 'FORMAL'
               and j.submitted_at > (select occurred_at from public.mu7_phase_events where event_type like 'FORMAL_CLOSED%')`,
          )
        ).rows[0].n,
      );
      return { submitWaited, outcome, snapshotWaited, matches, late };
    } finally {
      await Promise.allSettled([owner, reviewer, investigator].map((c) => c.end()));
    }
  });
}

test(
  'native v7: without 0025 a submission racing the close is accepted after it and breaks the snapshot',
  options,
  async () => {
    const r = await race(false);
    assert.equal(r.outcome, 'ACCEPTED', `submission outcome: ${r.outcome}`);
    assert.equal(r.late, 1, 'a FORMAL judgment committed after the close');
    assert.equal(r.matches, false, 'reproduced: the snapshot no longer matches the judgments');
  },
);

test(
  'native v7: with 0025 the submission waits for the close and is refused; the snapshot matches',
  options,
  async () => {
    const r = await race(true);
    assert.equal(r.submitWaited, true, 'the submission waited on the v7 serialization lock');
    assert.match(r.outcome, /^REFUSED: .*MU7-G34/, `submission outcome: ${r.outcome}`);
    assert.equal(r.late, 0);
    assert.equal(r.matches, true);
  },
);

// ---- Second review round (migration 0026) ---------------------------------------------------
const FIX26 = 'migrations/0026_v7_lifecycle_and_gates.sql';
const UNIT = 'SYN7-ROW-DIAB-001'; // routed in the synthetic pilot: slot 1 AGREE, slot 2 DISAGREE
const outcomeOf = (p: Promise<unknown>) =>
  p.then(
    () => 'ACCEPTED',
    (e: Error) => `REFUSED: ${e.message.slice(0, 160)}`,
  );

/**
 * A pilot revision that resolves the disagreement races the first adjudication of the same unit.
 * 'revision-first': the revision is in flight when the adjudication starts; 'adjudication-first':
 * the reverse. Without 0026 both commit in either order, leaving a tie-break on a concordant unit.
 */
async function revisionRace(fixed: boolean, order: 'revision-first' | 'adjudication-first') {
  assert.ok(baseUrl, 'BLOCKED: VERIFY_PG_TEST_URL is required');
  return withDisposableHandoffDatabase(baseUrl, async (url: string) => {
    const [owner, reviewer, adjudicator] = [0, 1, 2].map(
      () => new Client({ connectionString: url }),
    );
    try {
      for (const c of [owner, reviewer, adjudicator]) await c.connect();
      const { PT2 } = await signedOffPilot({
        existing: wrap(owner),
        without: fixed ? [] : [FIX26],
        stopAfter: 'pilotAnswers',
      });
      const assignment = (
        await owner.query(
          'select assignment_id from public.mu7_queue where reviewer_pseudo_id = $1 and unit_id = $2',
          [PT2, UNIT],
        )
      ).rows[0].assignment_id as string;
      const revise = () =>
        reviewer.query('select public.rpc_mu7_submit($1, \'{"answer":"AGREE"}\'::jsonb)', [
          assignment,
        ]);
      const adjudicate = () =>
        adjudicator.query('select public.rpc_mu7_record_adjudication($1::jsonb)', [
          JSON.stringify({
            unit_id: UNIT,
            decision: 'AGREE',
            status: 'DISCORDANT_RESOLVED',
            basis: 'REVIEWER_1',
            rationale: 'Synthetic: diabetes is studied.',
          }),
        ]);
      for (const [c, who] of [
        [reviewer, 'pt2'],
        [adjudicator, 'adj'],
      ] as const) {
        await c.query('begin');
        await identify(c, who, true);
      }
      const [first, second, firstRun, secondRun] =
        order === 'revision-first'
          ? [reviewer, adjudicator, revise, adjudicate]
          : [adjudicator, reviewer, adjudicate, revise];
      await firstRun(); // in flight: inserted, not committed
      const secondPid = await pidOf(second);
      const pending = outcomeOf(secondRun());
      const waited = await waitsOnLock(owner, secondPid);
      await first.query('commit');
      const outcome = await pending;
      await second.query(outcome === 'ACCEPTED' ? 'commit' : 'rollback');
      const state = (
        await owner.query(
          `select private.mu7_routing(private.mu7_effective_answer($1, 1), private.mu7_effective_answer($1, 2)) as routing,
                  (select count(*)::int from public.mu7_adjudications where unit_id = $1) as adjudications`,
          [UNIT],
        )
      ).rows[0] as { routing: string; adjudications: number };
      return { waited, outcome, ...state };
    } finally {
      await Promise.allSettled([owner, reviewer, adjudicator].map((c) => c.end()));
    }
  });
}

for (const order of ['revision-first', 'adjudication-first'] as const) {
  test(
    `native v7 (${order}): without 0026 a revision and the first adjudication both commit (stale tie-break)`,
    options,
    async () => {
      const r = await revisionRace(false, order);
      assert.equal(r.outcome, 'ACCEPTED', `second transaction: ${r.outcome}`);
      assert.equal(r.routing, 'CONCORDANT_AGREE');
      assert.equal(
        r.adjudications,
        1,
        'reproduced: an adjudication stands on a unit that is no longer routed',
      );
    },
  );
  test(
    `native v7 (${order}): with 0026 the second transaction waits and is refused`,
    options,
    async () => {
      const r = await revisionRace(true, order);
      assert.equal(r.waited, true, 'the second transaction waited on the v7 serialization lock');
      assert.match(
        r.outcome,
        order === 'revision-first' ? /^REFUSED: .*MU7-G39/ : /^REFUSED: .*MU7X-G01/,
        `second transaction: ${r.outcome}`,
      );
      if (order === 'revision-first') {
        assert.equal(r.routing, 'CONCORDANT_AGREE');
        assert.equal(r.adjudications, 0);
      } else {
        assert.equal(r.routing, 'ROUTED');
        assert.equal(r.adjudications, 1);
      }
    },
  );
}

const PILOT_FILE = JSON.parse(
  readFileSync('tests/handoff/fixtures/v7/SYNTHETIC_PILOT_UNITS_v7.json', 'utf8'),
) as { units: Array<{ import: Record<string, unknown> & { unit_id: string } }> };
function extraPilotUnit() {
  const u = JSON.parse(JSON.stringify(PILOT_FILE.units[0].import));
  u.unit_id = u.unit_id.replace(/-001$/, '-002');
  u.packet.unit.unit_id = u.unit_id;
  return u;
}

/** A pilot import races the pilot reference lock, in either order. */
async function importLockRace(fixed: boolean, order: 'lock-first' | 'import-first') {
  assert.ok(baseUrl, 'BLOCKED: VERIFY_PG_TEST_URL is required');
  return withDisposableHandoffDatabase(baseUrl, async (url: string) => {
    const [owner, locker, importer] = [0, 1, 2].map(() => new Client({ connectionString: url }));
    try {
      for (const c of [owner, locker, importer]) await c.connect();
      await signedOffPilot({
        existing: wrap(owner),
        without: fixed ? [] : [FIX26],
        stopAfter: 'pilotAdjudication',
      });
      for (const c of [locker, importer]) {
        await c.query('begin');
        await identify(c, 'inv', true);
      }
      const lock = () =>
        locker.query('select public.rpc_mu7_lock_reference($1, $2)', ['PILOT', ATT]);
      const imp = () =>
        importer.query('select public.rpc_mu7_import_unit($1::jsonb)', [
          JSON.stringify(extraPilotUnit()),
        ]);
      const [first, second, firstRun, secondRun] =
        order === 'lock-first' ? [locker, importer, lock, imp] : [importer, locker, imp, lock];
      await firstRun();
      const secondPid = await pidOf(second);
      const pending = outcomeOf(secondRun());
      const waited = await waitsOnLock(owner, secondPid);
      await first.query('commit');
      const outcome = await pending;
      await second.query(outcome === 'ACCEPTED' ? 'commit' : 'rollback');
      const state = (
        await owner.query(
          `select (select count(*)::int from public.mu7_units where mode = 'PILOT') as units,
                  (select n_units_locked from public.mu7_reference_locks where mode = 'PILOT') as locked`,
        )
      ).rows[0] as { units: number; locked: number | null };
      return { waited, outcome, ...state };
    } finally {
      await Promise.allSettled([owner, locker, importer].map((c) => c.end()));
    }
  });
}

test(
  'native v7 (lock-first): without 0026 a pilot import racing the lock lands outside the locked inventory',
  options,
  async () => {
    const r = await importLockRace(false, 'lock-first');
    assert.equal(r.outcome, 'ACCEPTED', `import: ${r.outcome}`);
    assert.deepEqual([r.units, r.locked], [13, 12], 'reproduced: 13 pilot units, 12 locked');
  },
);
test(
  'native v7 (lock-first): with 0026 the import waits for the lock and is refused',
  options,
  async () => {
    const r = await importLockRace(true, 'lock-first');
    assert.equal(r.waited, true);
    assert.match(r.outcome, /^REFUSED: .*MU7X-G05/, `import: ${r.outcome}`);
    assert.deepEqual([r.units, r.locked], [12, 12]);
  },
);
test(
  'native v7 (import-first): with 0026 the lock waits for the import and refuses the unanswered unit',
  options,
  async () => {
    const r = await importLockRace(true, 'import-first');
    assert.equal(r.waited, true);
    assert.match(r.outcome, /^REFUSED: .*MU7-G48/, `lock: ${r.outcome}`);
    assert.deepEqual([r.units, r.locked], [13, null]);
  },
);
