// Real PostgreSQL 16, disposable databases only. The auth shim never runs on Supabase.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from 'pg';
import { withDisposableHandoffDatabase } from '../scripts/test-handoff-postgres-helpers.mjs';
import { setTimeout as delay } from 'node:timers/promises';
import { guardActor, guardSession, type GuardDb } from './tlv5-guard-fixture';
import {
  MC_GUARD_ATT,
  MC_GUARD_CASE,
  MC_GUARD_RUBRIC_SHA,
  MC_GUARD_SHA,
  mcGuardAdjudication,
  mcGuardCase,
  mcGuardSubmit,
  seedMcGuardDatabase,
} from './mapconf-guard-fixture';

const baseUrl = process.env.VERIFY_PG_TEST_URL;
async function waitForBlocked(observer: Client, pid: number) {
  for (let n = 0; n < 100; n++) {
    const r = await observer.query('select wait_event_type from pg_stat_activity where pid=$1', [
      pid,
    ]);
    if (r.rows[0]?.wait_event_type === 'Lock') return;
    await delay(20);
  }
  assert.fail('Expected the second connection to wait for the campaign lock');
}
const required = process.env.VERIFY_PG_REQUIRE === '1';
const options = {
  skip: !baseUrl && !required ? 'BLOCKED: native PostgreSQL 16 test server unavailable' : false,
};
function session(client: Client): GuardDb {
  return {
    exec: async (sql) => {
      await client.query(sql);
    },
    query: async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => ({
      rows: (await client.query(sql, params)).rows as T[],
    }),
  };
}
async function withClients(operation: (owner: Client, one: Client, two: Client) => Promise<void>) {
  assert.ok(baseUrl, 'BLOCKED: VERIFY_PG_TEST_URL is required');
  await withDisposableHandoffDatabase(baseUrl, async (url: string) => {
    const clients = [
      new Client({ connectionString: url }),
      new Client({ connectionString: url }),
      new Client({ connectionString: url }),
    ];
    try {
      for (const c of clients) await c.connect();
      await seedMcGuardDatabase(session(clients[0]));
      await operation(clients[0], clients[1], clients[2]);
    } finally {
      await Promise.allSettled(clients.map((c) => c.end()));
    }
  });
}

test(
  'native mapping confirmation: isolation, finality, adjudication timing and typed export',
  options,
  async () => {
    await withClients(async (owner) => {
      const db = session(owner);
      await mcGuardSubmit(db, 'a', 'YES');
      for (const who of ['b', 'adjudicator', 'investigator'] as const)
        await guardActor(db, who, async () => {
          assert.equal((await db.query('select * from public.mc_responses')).rows.length, 0, who);
        });
      await assert.rejects(mcGuardSubmit(db, 'a', 'NO', 'x'), /final mapping response is locked/);
      await mcGuardSubmit(db, 'b', 'NO', 'Synthetic disagreement.');
      const phase = (type: string) =>
        guardActor(db, 'investigator', () =>
          db.query('select public.rpc_mc_phase($1, $2, $3)', [type, MC_GUARD_ATT, MC_GUARD_SHA]),
        );
      await assert.rejects(
        guardActor(db, 'adjudicator', () =>
          db.query('select public.rpc_mc_adjudicate($1::jsonb)', [
            JSON.stringify(mcGuardAdjudication),
          ]),
        ),
        /mapping adjudication opens only after/,
      );
      await phase('CLOSED');
      await phase('ADJUDICATION_AUTHORIZED');
      await assert.rejects(
        guardActor(db, 'investigator', () =>
          db.query('select public.rpc_mc_adjudicate($1::jsonb)', [
            JSON.stringify(mcGuardAdjudication),
          ]),
        ),
        /ADJUDICATOR role is needed/,
      );
      await assert.rejects(phase('LOCKED'), /disagreeing .*mappings have no adjudication/);
      await guardActor(db, 'adjudicator', () =>
        db.query('select public.rpc_mc_adjudicate($1::jsonb)', [
          JSON.stringify(mcGuardAdjudication),
        ]),
      );
      await phase('LOCKED');
      await guardActor(db, 'investigator', async () => {
        const rows = await db.query<Record<string, unknown>>(
          'select * from public.v_mc_export order by reviewer_slot',
        );
        assert.equal(rows.rows.length, 2);
        assert.equal(rows.rows[0].review_mode, 'MAPPING_CONFIRMATION');
        assert.equal(rows.rows[1].answer, 'NO');
        assert.equal(rows.rows[0].rubric_sha256, MC_GUARD_RUBRIC_SHA);
      });
    });
  },
);

test(
  'native mapping confirmation: concurrent final submissions commit only one response',
  options,
  async () => {
    await withClients(async (owner, one, two) => {
      const a = session(one);
      const b = session(two);
      await guardSession(a, 'a');
      const assignment = (
        await a.query<{ assignment_id: string }>(
          'select assignment_id from public.mc_assignments where case_id = $1',
          [MC_GUARD_CASE],
        )
      ).rows[0].assignment_id;
      const c = (
        await a.query<{ assignment_sha256: string; evidence_sha256: string }>(
          'select assignment_sha256, evidence_sha256 from public.mc_cases where case_id = $1',
          [MC_GUARD_CASE],
        )
      ).rows[0];
      const payload = (answer: string) =>
        JSON.stringify({
          answer,
          annotation: answer === 'YES' ? null : 'Synthetic.',
          displayed_assignment_sha256: c.assignment_sha256,
          displayed_evidence_sha256: c.evidence_sha256,
          displayed_evidence_version: 1,
          rubric_version: 'GUARD-RUBRIC',
          rubric_sha256: MC_GUARD_RUBRIC_SHA,
          app_git_sha: MC_GUARD_SHA,
        });
      await a.query('select public.rpc_mc_submit($1,$2::jsonb)', [assignment, payload('YES')]);
      await guardSession(b, 'a');
      const pending = b.query('select public.rpc_mc_submit($1,$2::jsonb)', [
        assignment,
        payload('NO'),
      ]);
      const rejected = assert.rejects(pending, /final mapping response is locked|duplicate key/);
      await a.exec('commit');
      await rejected;
      await b.exec('rollback');
      const db = session(owner);
      await guardActor(db, 'a', async () => {
        const rows = await db.query<{ answer: string }>('select answer from public.mc_responses');
        assert.deepEqual(
          rows.rows.map((r) => r.answer),
          ['YES'],
        );
      });
    });
  },
);

test(
  'native mapping confirmation: an in-flight import blocks the close until it commits, then the close rechecks completeness',
  options,
  async () => {
    await withClients(async (owner, one, two) => {
      const a = session(one);
      const b = session(two);
      const db = session(owner);
      await mcGuardSubmit(db, 'a', 'YES');
      await mcGuardSubmit(db, 'b', 'YES');
      // Transaction A: the investigator imports a new mapping and does not commit.
      await guardSession(a, 'investigator');
      await a.query('select public.rpc_mc_import_case($1::jsonb)', [
        JSON.stringify(mcGuardCase('MC-SYN-INFLIGHT', 'SYN-NCT-9994')),
      ]);
      // Transaction B: the close must wait for A (campaign row lock), not proceed on stale state.
      await guardSession(b, 'investigator');
      const pid = (await two.query('select pg_backend_pid() as pid')).rows[0].pid;
      const pending = b.query('select public.rpc_mc_phase($1, $2, $3)', [
        'CLOSED',
        MC_GUARD_ATT,
        MC_GUARD_SHA,
      ]);
      const rejected = assert.rejects(
        pending,
        /lack a second reviewer assignment; the campaign cannot be closed/,
      );
      await waitForBlocked(owner, pid);
      await a.exec('commit');
      await rejected;
      await b.exec('rollback');
      await guardActor(db, 'investigator', async () => {
        assert.equal(
          (await db.query<{ phase: string }>('select phase from public.mc_campaign')).rows[0].phase,
          'OPEN',
        );
        assert.equal(
          (await db.query("select * from public.mc_cases where case_id = 'MC-SYN-INFLIGHT'")).rows
            .length,
          1,
        );
      });
    });
  },
);

test(
  'native mapping confirmation: a response that waited on a close is refused once the close commits',
  options,
  async () => {
    await withClients(async (owner, one, two) => {
      const a = session(one);
      const b = session(two);
      const db = session(owner);
      await mcGuardSubmit(db, 'a', 'YES');
      // Transaction B: the investigator closes the campaign and holds the transaction open.
      await guardSession(b, 'investigator');
      await b.query('select public.rpc_mc_phase($1, $2, $3)', [
        'CLOSED',
        MC_GUARD_ATT,
        MC_GUARD_SHA,
      ]);
      // Transaction A: reviewer b's final response passed no stale check; it waits for the lock.
      await guardSession(a, 'b');
      const pid = (await one.query('select pg_backend_pid() as pid')).rows[0].pid;
      const assignment = (
        await a.query<{ assignment_id: string }>(
          'select assignment_id from public.mc_assignments where case_id = $1',
          [MC_GUARD_CASE],
        )
      ).rows[0].assignment_id;
      const c = (
        await a.query<{ assignment_sha256: string; evidence_sha256: string }>(
          'select assignment_sha256, evidence_sha256 from public.mc_cases where case_id = $1',
          [MC_GUARD_CASE],
        )
      ).rows[0];
      const pending = a.query('select public.rpc_mc_submit($1, $2::jsonb)', [
        assignment,
        JSON.stringify({
          answer: 'NO',
          annotation: 'Synthetic late response.',
          displayed_assignment_sha256: c.assignment_sha256,
          displayed_evidence_sha256: c.evidence_sha256,
          displayed_evidence_version: 1,
          rubric_version: 'GUARD-RUBRIC',
          rubric_sha256: MC_GUARD_RUBRIC_SHA,
          app_git_sha: MC_GUARD_SHA,
        }),
      ]);
      const rejected = assert.rejects(pending, /campaign is closed; mapping responses are final/);
      await waitForBlocked(owner, pid);
      await b.exec('commit');
      await rejected;
      await a.exec('rollback');
      await guardActor(db, 'investigator', async () => {
        assert.equal(
          (await db.query('select * from public.mc_responses')).rows.length,
          1,
          'only the pre-close response exists',
        );
      });
    });
  },
);
