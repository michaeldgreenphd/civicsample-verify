// Exercise the real 0031 -> 0032 upgrade with an existing approval and pilot history.
// All records are synthetic and all databases are disposable; no staging connection is used.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { Client } from 'pg';
import { withDisposableHandoffDatabase } from '../scripts/test-handoff-postgres-helpers.mjs';
import {
  ATT,
  formalOpen,
  freezeSql,
  one,
  rows,
  specifyAndApproveGates,
  type FixtureDb,
} from './mu7-fixture';

const migration = 'migrations/0032_v7_freeze_gates_v8_4.sql';
const oldRecord = 'investigator decisions 2026-10-23, addendum 8, item 40';
const currentRecord = `${oldRecord}, and addendum 11, item 60, with rubric 7.1 (SHA-256 9ab8d6a9aa146b648358c7f3993068a8963146861a5d0b04ae5d6e1bda60cf46)`;
const approve = (record: string) =>
  `select public.rpc_mu7_approve_gate('G-PAIN-01', '${ATT}', '${record}')`;

async function verifyUpgrade(existing?: FixtureDb) {
  const f = await formalOpen({
    existing,
    without: [migration],
    gates: [],
    stopAfter: 'formalImport',
  });
  try {
    await one(f.db, 'inv', approve(oldRecord));
    const preserved = async () => ({
      units: await rows(f.db, 'owner', 'select * from public.mu7_units order by unit_id'),
      judgments: await rows(
        f.db,
        'owner',
        'select to_jsonb(j) as record from public.mu7_judgments j order by to_jsonb(j)::text',
      ),
      adjudications: await rows(
        f.db,
        'owner',
        'select to_jsonb(a) as record from public.mu7_adjudications a order by to_jsonb(a)::text',
      ),
      design: await rows(f.db, 'owner', 'select * from public.mu7_unit_design order by unit_id'),
      approvals: await rows(
        f.db,
        'owner',
        'select * from public.mu7_gate_approval_versions order by gate_id, requirement_version',
      ),
      hashes: await rows(
        f.db,
        'inv',
        'select quantity, recomputed from public.rpc_mu7_verify_freeze() order by quantity',
      ),
    });
    const before = await preserved();
    assert.ok(before.units.length > 0);
    assert.ok(before.judgments.length > 0);
    assert.ok(before.adjudications.length > 0);
    assert.equal(before.approvals.length, 1);
    await f.db.exec(readFileSync(migration, 'utf8'));
    assert.deepEqual(
      await preserved(),
      before,
      'upgrade preserves stored units, design, prior approval and hashes',
    );
    const status = await rows<{ requirement_version: number; satisfied: boolean }>(
      f.db,
      'inv',
      "select requirement_version, satisfied from public.rpc_mu7_gate_status() where gate_id = 'G-PAIN-01'",
    );
    assert.deepEqual(status, [{ requirement_version: 3, satisfied: false }]);
    await assert.rejects(one(f.db, 'inv', freezeSql()), /MU7X-G10/);
    await assert.rejects(one(f.db, 'inv', approve(oldRecord)), /MU7X-G09/);
    for (const who of ['r1', 'r2', 'pt1', 'adj', 'out', 'inv1'] as const) {
      await assert.rejects(
        one(f.db, who, approve(currentRecord)),
        /investigator role \(with multi-factor session when required\) is needed for this action/,
        `${who} cannot approve the new requirement`,
      );
    }
    await one(f.db, 'inv', approve(currentRecord));
    await assert.rejects(one(f.db, 'inv', freezeSql()), /MU7X-G06/);
    await specifyAndApproveGates(f.db, [
      'G-EST-01',
      'G-MH-V53',
      'G-OQ-03',
      'G-OQ-04',
      'G-OVERLAP-01',
      'G-PROV-01',
      'G-TEXT-01',
    ]);
    await one(f.db, 'inv', freezeSql());
    assert.equal(await one(f.db, 'owner', 'select count(*)::int from public.mu7_freeze'), 1);
    assert.deepEqual((await preserved()).hashes, before.hashes);
    assert.equal(
      await one(
        f.db,
        'owner',
        "select count(*)::int from public.mu7_gate_approval_versions where gate_id = 'G-PAIN-01'",
      ),
      2,
      'both old and current approvals remain in the immutable history',
    );
  } finally {
    await f.db.close();
  }
}

test('0032 upgrades existing pilot data and invalidates the old Pain approval without rewriting it', async () => {
  await verifyUpgrade();
});

test(
  'native PostgreSQL 16: 0032 upgrade preserves records and enforces current approvals and roles',
  {
    skip:
      !process.env.VERIFY_PG_TEST_URL && process.env.VERIFY_PG_REQUIRE !== '1'
        ? 'BLOCKED: native PostgreSQL 16 test server unavailable'
        : false,
    timeout: 120_000,
  },
  async () => {
    assert.ok(process.env.VERIFY_PG_TEST_URL, 'VERIFY_PG_TEST_URL is required');
    await withDisposableHandoffDatabase(process.env.VERIFY_PG_TEST_URL, async (url: string) => {
      const client = new Client({ connectionString: url });
      try {
        await client.connect();
        await verifyUpgrade({
          exec: (sql) => client.query(sql),
          query: async <T>(sql: string, params: unknown[] = []) => ({
            rows: (await client.query(sql, params)).rows as T[],
          }),
        });
      } finally {
        await client.end();
      }
    });
  },
);
