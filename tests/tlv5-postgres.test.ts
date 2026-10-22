// Real PostgreSQL 16, disposable databases only. The auth shim never runs on Supabase.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { Client } from 'pg';
import { setTimeout as delay } from 'node:timers/promises';
import { withDisposableHandoffDatabase } from '../scripts/test-handoff-postgres-helpers.mjs';
import { exerciseLegacyPilot } from './legacy-pilot-fixture';
import {
  GUARD_ATT,
  guardFreezeInput,
  guardImportCase,
  prepareGuardFreeze,
  GUARD_CASE,
  guardActor,
  guardAdjudication,
  guardPayload,
  guardSession,
  guardSubmit,
  seedGuardDatabase,
  type GuardDb,
} from './tlv5-guard-fixture';

const baseUrl = process.env.VERIFY_PG_TEST_URL;
const required = process.env.VERIFY_PG_REQUIRE === '1';
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
      await seedGuardDatabase(session(clients[0]));
      for (const file of [
        'migrations/0014_legacy_pilot_and_packet_guards.sql',
        'migrations/0015_v5_review_fixes.sql',
        'migrations/0017_v5_rubric_binding.sql',
        'migrations/0019_v5_rubric_binding_reconciliation.sql',
      ])
        await clients[0].query(await readFile(file, 'utf8'));
      await operation(clients[0], clients[1], clients[2]);
    } finally {
      await Promise.allSettled(clients.map((c) => c.end()));
    }
  });
}
async function waitForBlocked(observer: Client, pid: number) {
  for (let n = 0; n < 100; n++) {
    const r = await observer.query('select wait_event_type from pg_stat_activity where pid=$1', [
      pid,
    ]);
    if (r.rows[0]?.wait_event_type === 'Lock') return;
    await delay(20);
  }
  assert.fail('Expected the second connection to wait for the lifecycle lock');
}
const options = {
  skip: !baseUrl && !required ? 'BLOCKED: native PostgreSQL 16 test server unavailable' : false,
};

test(
  'native fresh legacy pilot reaches independent adjudication and sign-off',
  options,
  async () => {
    await withClients(async (owner) => exerciseLegacyPilot(session(owner)));
  },
);

test('native v5 rejects investigator judgment and helper leakage', options, async () => {
  await withClients(async (owner) => {
    const db = session(owner);
    await guardSubmit(db, 'a', 'YES');
    for (const role of ['b', 'adjudicator'] as const)
      await guardActor(db, role, async () => {
        assert.equal((await db.query('select * from public.tlv5_submissions')).rows.length, 0);
        assert.equal(
          (
            await db.query('select * from private.tlv5_item_answers($1,$2)', [
              GUARD_CASE,
              'AREA_ONCOLOGY',
            ])
          ).rows.length,
          0,
        );
      });
    await guardSubmit(db, 'b');
    await assert.rejects(
      guardActor(db, 'investigator', () =>
        db.query('select public.rpc_tlv5_record_adjudication($1::jsonb)', [
          JSON.stringify(guardAdjudication),
        ]),
      ),
      /active ADJUDICATOR/,
    );
    await guardActor(db, 'adjudicator', () =>
      db.query('select public.rpc_tlv5_record_adjudication($1::jsonb)', [
        JSON.stringify(guardAdjudication),
      ]),
    );
  });
});

test('native v5 concurrent final submissions commit only one response', options, async () => {
  await withClients(async (owner, one, two) => {
    const a = session(one),
      b = session(two);
    await guardSession(a, 'a');
    const assignment = (
      await a.query<{ assignment_id: string }>('select assignment_id from public.tlv5_assignments')
    ).rows[0].assignment_id;
    await a.query('select public.rpc_tlv5_submit($1,$2::jsonb)', [
      assignment,
      JSON.stringify(guardPayload('YES')),
    ]);
    await guardSession(b, 'a');
    const pid = (await two.query('select pg_backend_pid() as pid')).rows[0].pid;
    const pending = b.query('select public.rpc_tlv5_submit($1,$2::jsonb)', [
      assignment,
      JSON.stringify(guardPayload()),
    ]);
    const rejected = assert.rejects(pending, /Final v5 submission is locked|duplicate key/);
    try {
      await waitForBlocked(owner, pid);
      await a.exec('commit');
      await rejected;
    } finally {
      await a.exec('rollback');
      await b.exec('rollback');
    }
    assert.equal(
      (await owner.query('select count(*)::int n from public.tlv5_submissions')).rows[0].n,
      1,
    );
  });
});

test('native v5 reference lock blocks a waiting adjudication after commit', options, async () => {
  await withClients(async (owner, one, two) => {
    await guardSubmit(session(owner), 'a');
    await guardSubmit(session(owner), 'b');
    const a = session(one),
      b = session(two);
    await guardSession(a, 'investigator');
    await a.query("select public.rpc_tlv5_lock_reference('PILOT',$1)", [GUARD_ATT]);
    await guardSession(b, 'adjudicator');
    const pid = (await two.query('select pg_backend_pid() as pid')).rows[0].pid;
    const pending = b.query('select public.rpc_tlv5_record_adjudication($1::jsonb)', [
      JSON.stringify({ ...guardAdjudication, status: 'CONCORDANT_REVISED' }),
    ]);
    const rejected = assert.rejects(pending, /reference is locked/);
    try {
      await waitForBlocked(owner, pid);
      await a.exec('commit');
      await rejected;
    } finally {
      await a.exec('rollback');
      await b.exec('rollback');
    }
    assert.equal(
      (await owner.query('select count(*)::int n from public.tlv5_adjudications')).rows[0].n,
      0,
    );
  });
});

test(
  'native v5 lock waits for an in-flight final and rechecks its disagreement',
  options,
  async () => {
    await withClients(async (owner, one, two) => {
      await guardSubmit(session(owner), 'a', 'YES');
      const a = session(one),
        b = session(two);
      await guardSession(a, 'b');
      const assignment = (
        await a.query<{ assignment_id: string }>(
          'select assignment_id from public.tlv5_assignments',
        )
      ).rows[0].assignment_id;
      await a.query('select public.rpc_tlv5_submit($1,$2::jsonb)', [
        assignment,
        JSON.stringify(guardPayload()),
      ]);
      await guardSession(b, 'investigator');
      const pid = (await two.query('select pg_backend_pid() as pid')).rows[0].pid;
      const pending = b.query("select public.rpc_tlv5_lock_reference('PILOT',$1)", [GUARD_ATT]);
      const rejected = assert.rejects(pending, /no adjudication/);
      try {
        await waitForBlocked(owner, pid);
        await a.exec('commit');
        await rejected;
      } finally {
        await a.exec('rollback');
        await b.exec('rollback');
      }
      assert.equal(
        (await owner.query('select count(*)::int n from public.tlv5_reference_locks')).rows[0].n,
        0,
      );
    });
  },
);

test('native v5 freeze waits for import before calculating manifest hashes', options, async () => {
  await withClients(async (owner, one, two) => {
    await prepareGuardFreeze(session(owner));
    const a = session(one),
      b = session(two);
    await guardSession(a, 'investigator');
    await guardImportCase(a, 'TLV5-TESTFX-GUARD2', 'SYN-NCT-9902', 'FORMAL');
    await guardSession(b, 'investigator');
    const pid = (await two.query('select pg_backend_pid() as pid')).rows[0].pid;
    const pending = b.query('select public.rpc_tlv5_freeze($1::jsonb)', [
      JSON.stringify(guardFreezeInput),
    ]);
    // Attach a rejection handler immediately while still retaining the failure.
    const observed = pending.then(
      (value) => ({ value, error: null }),
      (error) => ({ value: null, error }),
    );
    try {
      await waitForBlocked(owner, pid);
      await a.exec('commit');
      const result = await observed;
      if (result.error) throw result.error;
      await b.exec('commit');
    } finally {
      await a.exec('rollback');
      await b.exec('rollback');
    }
    const freeze = (
      await owner.query(
        'select n_cases,n_label_rows,case_list_sha256,label_rows_sha256 from public.tlv5_freeze',
      )
    ).rows[0];
    assert.equal(freeze.n_cases, 2);
    assert.equal(freeze.n_label_rows, 34);
    const current = (
      await owner.query(
        "select private.sha256_hex(string_agg(case_id,E'\\n' order by case_id collate \"C\")) as h from public.tlv5_cases where mode='FORMAL'",
      )
    ).rows[0];
    assert.equal(freeze.case_list_sha256, current.h);
    await guardActor(session(owner), 'investigator', async () => {
      assert.equal(
        (await owner.query('select matches from public.rpc_tlv5_verify_frozen_labels()')).rows[0]
          .matches,
        true,
      );
    });
  });
});

test('native v5 concurrent adjudications commit only one final item', options, async () => {
  await withClients(async (owner, one, two) => {
    await guardSubmit(session(owner), 'a', 'YES');
    await guardSubmit(session(owner), 'b');
    const a = session(one),
      b = session(two);
    await guardSession(a, 'adjudicator');
    await a.query('select public.rpc_tlv5_record_adjudication($1::jsonb)', [
      JSON.stringify(guardAdjudication),
    ]);
    await guardSession(b, 'adjudicator');
    const pid = (await two.query('select pg_backend_pid() as pid')).rows[0].pid;
    const pending = b.query('select public.rpc_tlv5_record_adjudication($1::jsonb)', [
      JSON.stringify({ ...guardAdjudication, decision: 'YES' }),
    ]);
    const rejected = assert.rejects(pending, /Final v5 adjudication is locked|duplicate key/);
    try {
      await waitForBlocked(owner, pid);
      await a.exec('commit');
      await rejected;
    } finally {
      await a.exec('rollback');
      await b.exec('rollback');
    }
    assert.equal(
      (await owner.query('select count(*)::int n from public.tlv5_adjudications')).rows[0].n,
      1,
    );
  });
});

test(
  'native v5 review fixes: basis consistency and rubric binding behave on PostgreSQL 16',
  options,
  async () => {
    await withClients(async (owner) => {
      const db = session(owner);
      await guardSubmit(db, 'a', 'YES');
      await guardSubmit(db, 'b', 'NO');
      await assert.rejects(
        guardActor(db, 'adjudicator', () =>
          db.query('select public.rpc_tlv5_record_adjudication($1::jsonb)', [
            JSON.stringify({ ...guardAdjudication, decision: 'NO', basis: 'REVIEWER_1' }),
          ]),
        ),
        /basis REVIEWER_1 does not match/,
      );
      await guardActor(db, 'adjudicator', () =>
        db.query('select public.rpc_tlv5_record_adjudication($1::jsonb)', [
          JSON.stringify(guardAdjudication),
        ]),
      );
      const bind = (sha: string) =>
        guardActor(
          db,
          'a',
          async () =>
            (
              await db.query<{ r: string }>(
                "select public.rpc_tlv5_bind_rubric('PILOT', 'R-ONE', $1) as r",
                [sha],
              )
            ).rows[0].r,
        );
      assert.equal(await bind('a'.repeat(64)), 'BOUND');
      assert.equal(await bind('a'.repeat(64)), 'VERIFIED');
      // 0019: a reviewer without a FORMAL assignment cannot create that mode's binding natively,
      // and an already-bound mode cannot be reconciled.
      await assert.rejects(
        guardActor(db, 'b', () =>
          db.query("select public.rpc_tlv5_bind_rubric('FORMAL', 'R-X', $1)", ['d'.repeat(64)]),
        ),
        /only an investigator or a reviewer assigned in FORMAL review/,
      );
      await assert.rejects(
        guardActor(db, 'investigator', () =>
          db.query("select public.rpc_tlv5_reconcile_rubric('PILOT', 'R-HIST', $1, $2)", [
            'c'.repeat(64),
            GUARD_ATT,
          ]),
        ),
        /already bound to R-ONE/,
      );
      await assert.rejects(bind('b'.repeat(64)), /differs from the rubric bound to PILOT/);
      await guardActor(db, 'a', async () => {
        const row = await db.query<{ frozen: boolean; scope: string }>(
          'select private.tlv5_frozen() as frozen, private.tlv5_scope() as scope',
        );
        assert.deepEqual(row.rows[0], { frozen: false, scope: 'DISAGREEMENTS_ONLY' });
      });
    });
  },
);
