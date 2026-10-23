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
import { FORMAL_QUEUE_1, P, formalOpen, type FixtureDb } from './mu7-fixture';

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
async function identify(c: Client, who: 'inv' | 'r1', local: boolean) {
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
        without: fixed ? [] : ['migrations/0025_v7_review_fixes.sql'],
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
