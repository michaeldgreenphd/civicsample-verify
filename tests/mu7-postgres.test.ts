// Review finding 2 on migration 0024, as a real race on native PostgreSQL 16 (disposable databases
// only; the auth shim never runs on Supabase). A reviewer's submission is in flight when the
// investigator closes the formal phase and takes the snapshot. Without 0025 the close and the
// snapshot commit first and the late judgment then commits, so the snapshot never matches again
// and every FORMAL export is refused. With 0025 the close waits for the submission to commit.
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
async function waitForLock(observer: Client, pid: number) {
  for (let n = 0; n < 150; n++) {
    const r = await observer.query('select wait_event_type from pg_stat_activity where pid = $1', [
      pid,
    ]);
    if (r.rows[0]?.wait_event_type === 'Lock') return true;
    await delay(20);
  }
  return false;
}

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
      // r1 answers every FORMAL unit but one; the last answer is the one in flight.
      const assignments = (
        await owner.query(
          'select assignment_id, unit_id from public.mu7_queue where reviewer_pseudo_id = $1',
          [f.R1],
        )
      ).rows as Array<{ assignment_id: string; unit_id: string }>;
      const byUnit = new Map(assignments.map((a) => [a.unit_id, a.assignment_id]));
      await identify(reviewer, 'r1', false);
      for (const u of FORMAL_QUEUE_1.slice(0, -2))
        await reviewer.query('select public.rpc_mu7_submit($1, \'{"answer":"AGREE"}\'::jsonb)', [
          byUnit.get(u),
        ]);
      await reviewer.query('reset role');
      // The in-flight primary-unit submission (position 6 of 8; subgroups need every primary first).
      await reviewer.query('begin');
      await identify(reviewer, 'r1', true);
      await reviewer.query('select public.rpc_mu7_submit($1, \'{"answer":"AGREE"}\'::jsonb)', [
        byUnit.get(FORMAL_QUEUE_1[5]),
      ]);
      // The investigator closes (incomplete) while it is in flight.
      await identify(investigator, 'inv', false);
      const pid = (await investigator.query('select pg_backend_pid() as pid')).rows[0]
        .pid as number;
      const close = investigator.query('select public.rpc_mu7_phase($1, $2::jsonb)', [
        'FORMAL_CLOSED_INCOMPLETE',
        JSON.stringify({ attestation: ATT }),
      ]);
      const closeWaited = await Promise.race([waitForLock(owner, pid), close.then(() => false)]);
      if (!fixed) {
        await close; // committed while the submission is still open
        await investigator.query('select public.rpc_mu7_snapshot()');
      }
      await reviewer.query('commit');
      if (fixed) await close;
      if (fixed) await investigator.query('select public.rpc_mu7_snapshot()');
      const verify = (
        await investigator.query('select matches from public.rpc_mu7_verify_snapshot()')
      ).rows[0].matches as boolean;
      const late = Number(
        (
          await owner.query(
            `select count(*)::int as n from public.mu7_judgments j
              where j.mode = 'FORMAL' and j.submitted_at > (select occurred_at from public.mu7_phase_events where event_type like 'FORMAL_CLOSED%')`,
          )
        ).rows[0].n,
      );
      return { closeWaited, snapshotMatches: verify, lateJudgments: late };
    } finally {
      await Promise.allSettled([owner, reviewer, investigator].map((c) => c.end()));
    }
  });
}

test(
  'native v7: without 0025 a submission in flight at the close breaks the snapshot for good',
  options,
  async () => {
    const r = await race(false);
    assert.equal(r.closeWaited, false, 'the close did not wait for the in-flight submission');
    assert.equal(
      r.snapshotMatches,
      false,
      'reproduced: the snapshot no longer matches the judgments',
    );
  },
);

test(
  'native v7: with 0025 the close waits for the submission, and the snapshot matches',
  options,
  async () => {
    const r = await race(true);
    assert.equal(r.closeWaited, true, 'the close waited on the v7 serialization lock');
    assert.equal(r.snapshotMatches, true);
    assert.equal(r.lateJudgments, 0, 'no FORMAL judgment is dated after the close');
  },
);
