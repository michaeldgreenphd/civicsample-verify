// Native PostgreSQL only. Every run creates its own disposable database; never use a study DB.
import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from 'pg';
import { withDisposableHandoffDatabase } from '../scripts/test-handoff-postgres-helpers.mjs';
import { completionPilot, completeAnswers } from './mu84-fixture';
import { P, one, assignmentOf, type FixtureDb } from './mu7-fixture';
const baseUrl = process.env.VERIFY_PG_TEST_URL;
const opts = {
  skip:
    !baseUrl && process.env.VERIFY_PG_REQUIRE !== '1'
      ? 'BLOCKED: native PostgreSQL 16 test server unavailable'
      : false,
  timeout: 120000,
};
const wrap = (c: Client): FixtureDb => ({
  exec: (sql) => c.query(sql),
  query: async <T>(sql: string, params: unknown[] = []) => ({
    rows: (await c.query(sql, params)).rows as T[],
  }),
});
async function waitForLock(owner: Client, pid: number) {
  for (let i = 0; i < 150; i++) {
    const { rows } = await owner.query(
      'select wait_event_type from pg_stat_activity where pid=$1',
      [pid],
    );
    if (rows[0]?.wait_event_type === 'Lock') return true;
    await delay(20);
  }
  return false;
}
for (const order of ['finish-first', 'revision-first'] as const)
  test(`native PostgreSQL: reviewer completion serializes ${order}`, opts, async () => {
    assert.ok(baseUrl, 'VERIFY_PG_TEST_URL is required');
    await withDisposableHandoffDatabase(baseUrl, async (url: string) => {
      const owner = new Client({ connectionString: url });
      const first = new Client({ connectionString: url });
      const second = new Client({ connectionString: url });
      try {
        for (const c of [owner, first, second]) {
          await c.connect();
          await c.query("set statement_timeout='12s'");
        }
        const f = await completionPilot(wrap(owner));
        await completeAnswers(f, 'pt1');
        const summary = async () =>
          (await one(f.db, 'pt1', "select public.rpc_mu84_my_completion('PILOT')")) as Record<
            string,
            unknown
          >;
        const before = await summary();
        const assignment = await assignmentOf(f.db, f.PT1, f.order[1]);
        for (const c of [first, second]) {
          await c.query('begin');
          await c.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify(P.pt1)]);
          await c.query('set local role authenticated');
        }
        const finish = (c: Client) =>
          c.query("select public.rpc_mu84_finish_review('PILOT',$1)", [before.answers_sha256]);
        const revise = (c: Client) =>
          c.query('select public.rpc_mu7_submit($1,$2::jsonb)', [
            assignment,
            JSON.stringify({ answer: 'AGREE', note: 'Synthetic concurrent revision.' }),
          ]);
        await (order === 'finish-first' ? finish(first) : revise(first));
        const pid = (await second.query('select pg_backend_pid() as pid')).rows[0].pid as number;
        const pending = (order === 'finish-first' ? revise(second) : finish(second)).then(
          () => 'ACCEPTED',
          (e: Error) => e.message,
        );
        const waited = await waitForLock(owner, pid);
        await first.query('commit');
        const result = await pending;
        await second.query('rollback');
        assert.equal(waited, true, 'the second operation must wait on the first transaction');
        assert.match(result, order === 'finish-first' ? /MU84-G10/ : /MU84-G07/);
        const after = await summary();
        if (order === 'finish-first') {
          assert.equal(after.answers_sha256, before.answers_sha256);
          assert.ok(after.finished_at);
        } else {
          assert.notEqual(after.answers_sha256, before.answers_sha256);
          assert.equal(after.finished_at, null);
          await one(f.db, 'pt1', "select public.rpc_mu84_finish_review('PILOT',$1)", [
            after.answers_sha256,
          ]);
          assert.ok((await summary()).finished_at);
        }
        assert.equal(
          (await owner.query('select count(*)::int as n from public.mu7_review_completions_v84'))
            .rows[0].n,
          1,
        );
      } finally {
        await Promise.allSettled([first, second].map((c) => c.query('rollback')));
        await Promise.allSettled([owner, first, second].map((c) => c.end()));
      }
    });
  });
