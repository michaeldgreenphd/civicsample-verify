import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { Client } from 'pg';
import { readMu7Bundle } from '../src/server/mu7-core';
import { mu7SqlData } from '../src/server/mu7';
import { MU7_SYNTHETIC_TRAINING } from '../src/lib/mu7-synthetic';
import { withDisposableHandoffDatabase } from '../scripts/test-handoff-postgres-helpers.mjs';
import {
  ATT,
  answerAll,
  as,
  phase,
  formalOpen,
  freezeSql,
  one,
  rows,
  signedOffPilot,
  specifyAndApproveGates,
  type FixtureDb,
} from './mu7-fixture';

const migration = 'migrations/0033_v8_design_foundation.sql';
const version = 'SYN-8-FOUNDATION-TEST';
const gates = ['G-ALLOC-01', 'G-AREA-01', 'G-TEXT-02', 'G-RUBRIC-01'];
const fixture = JSON.parse(
  readFileSync('tests/handoff/fixtures/v7/SYNTHETIC_PILOT_UNITS_v7.json', 'utf8'),
).units[0].import;
const literal = (v: unknown) => `'${JSON.stringify(v).replace(/'/g, "''")}'::jsonb`;
async function areaUnit(db: FixtureDb, category: string, n: number) {
  const u = structuredClone(fixture);
  u.unit_id = `SYN7-AREA-${category}-${n}`;
  u.category = category;
  u.mapping_code = `AREA_${category}`;
  Object.assign(u.packet.unit, {
    unit_id: u.unit_id,
    category,
    mapping_code: u.mapping_code,
    mapping_label:
      (await one(db, 'owner', `select private.mu7_area_label('${category}')`)) ?? 'Unknown area',
  });
  u.design.stratum = `AREA-${category}`;
  u.design.design_version = version;
  return u;
}
const importSql = (u: unknown) => `select public.rpc_mu7_import_unit(${literal(u)})`;

async function checkFoundation(existing?: FixtureDb) {
  const f = await signedOffPilot({ existing, designVersion: version, stopAfter: 'design' });
  try {
    const status = await rows<{
      gate_id: string;
      requirement_status: string;
      blocks: string[];
      satisfied: boolean;
    }>(f.db, 'inv', 'select * from public.rpc_mu7_gate_status()');
    for (const gate of [...gates, 'G-PAIN-01', 'G-MH-V53', 'G-OQ-03', 'G-OQ-04', 'G-EST-01']) {
      const row = status.find((r) => r.gate_id === gate)!;
      assert.equal(row.requirement_status, 'PENDING_SPECIFICATION', gate);
      assert.equal(row.satisfied, false, gate);
      if (gate !== 'G-PAIN-01') assert.ok(row.blocks.includes('FREEZE'), gate);
      await assert.rejects(
        one(
          f.db,
          'inv',
          `select public.rpc_mu7_approve_gate('${gate}', '${ATT}', 'synthetic record')`,
        ),
        /MU7X-G0[89]/,
      );
    }
    assert.deepEqual(status.find((r) => r.gate_id === 'G-PROV-04')!.blocks, []);
    for (const who of ['pt1', 'pt2', 'r1', 'r2', 'adj', 'out', 'inv1'] as const) {
      await assert.rejects(
        one(f.db, who, 'select * from public.rpc_mu7_gate_status()'),
        /investigator role/,
      );
      await assert.rejects(
        one(
          f.db,
          who,
          `select public.rpc_mu7_approve_gate('G-AREA-01', '${ATT}', 'synthetic record')`,
        ),
        /investigator role/,
      );
    }
    for (const [i, cat] of ['PATHOLOGICAL', 'IMMUNE', 'UROGENITAL', 'ONCOLOGY'].entries()) {
      const u = await areaUnit(f.db, cat, 901 + i);
      await one(f.db, 'inv', importSql(u));
    }
    const unknown = await areaUnit(f.db, 'UNKNOWN', 999);
    await assert.rejects(one(f.db, 'inv', importSql(unknown)), /MU7|constraint/);
    const alternate = {
      design_version: version,
      assignment_set_id: 'SYN7-ASSIGN-OTHER-TEST',
      overlap_setting: 'ONE_PER_TRIAL',
      n_primary_planned: 96,
      n_subgroup_planned: 4,
      attestation: ATT,
    };
    await assert.rejects(
      one(f.db, 'inv', `select public.rpc_mu7_record_design(${literal(alternate)})`),
      /duplicate key|unique constraint/,
    );
    assert.equal(await one(f.db, 'owner', 'select count(*)::int from public.mu7_design'), 1);
    assert.equal(
      await one(f.db, 'owner', 'select count(*)::int from public.mu7_gate_approval_versions'),
      0,
    );
  } finally {
    await f.db.close();
  }
}
test('v8 new areas and pending requirements are design scoped; roles and single-design boundary hold', async () =>
  checkFoundation());

test('0033 preserves an active v7 practice and rejects v8 areas in its review and training', async () => {
  const f = await signedOffPilot({ without: [migration], stopAfter: 'pilotAnswers' });
  try {
    const tables = [
      'mu7_design',
      'mu7_units',
      'mu7_unit_design',
      'mu7_judgments',
      'mu7_gate_requirements',
      'mu7_gate_approval_versions',
    ];
    const snapshot = async () =>
      Promise.all(
        tables.map((t) =>
          rows(
            f.db,
            'owner',
            `select to_jsonb(t) as data from public.${t} t order by to_jsonb(t)::text`,
          ),
        ),
      );
    const before = await snapshot();
    const labels = await rows(
      f.db,
      'owner',
      "select private.mu7_area_label(x) as label from unnest(array['ONCOLOGY','CARDIOVASCULAR','MENTAL_HEALTH','INFECTIOUS','METABOLIC','NEUROLOGICAL','RESPIRATORY']) x",
    );
    await f.db.exec(readFileSync(migration, 'utf8'));
    assert.deepEqual(await snapshot(), before);
    assert.deepEqual(
      await rows(
        f.db,
        'owner',
        "select private.mu7_area_label(x) as label from unnest(array['ONCOLOGY','CARDIOVASCULAR','MENTAL_HEALTH','INFECTIOUS','METABOLIC','NEUROLOGICAL','RESPIRATORY']) x",
      ),
      labels,
    );
    const u = await areaUnit(f.db, 'IMMUNE', 901);
    await assert.rejects(one(f.db, 'inv', importSql(u)), /MU8-G03/);
    const training = structuredClone(MU7_SYNTHETIC_TRAINING[0]);
    Object.assign(training.packet.unit as Record<string, unknown>, {
      category: 'IMMUNE',
      mapping_code: 'AREA_IMMUNE',
      mapping_label: await one(f.db, 'owner', "select private.mu7_area_label('IMMUNE')"),
    });
    await assert.rejects(
      one(f.db, 'inv', `select public.rpc_mu7_import_training_unit(${literal(training)})`),
      /MU8-G03/,
    );
    assert.equal(
      await one(
        f.db,
        'owner',
        "select count(*)::int from public.mu7_gate_requirements where gate_id='G-ALLOC-01'",
      ),
      0,
    );
  } finally {
    await f.db.close();
  }
});

for (const gate of gates)
  test(`v8 freeze is refused by pending ${gate} even when every other gate is satisfied`, async () => {
    const f = await formalOpen({ designVersion: version, gates: [], stopAfter: 'formalImport' });
    try {
      const all = await rows<{ gate_id: string }>(
        f.db,
        'owner',
        'select distinct gate_id from public.mu7_gate_requirements',
      );
      await specifyAndApproveGates(
        f.db,
        all.map((r) => r.gate_id).filter((g) => g !== gate),
      );
      const hashes = await rows(
        f.db,
        'inv',
        'select quantity,recomputed from public.rpc_mu7_verify_freeze() order by quantity',
      );
      await assert.rejects(one(f.db, 'inv', freezeSql()), new RegExp(`MU7X-G06:.*${gate}`));
      await specifyAndApproveGates(f.db, [gate]);
      await one(f.db, 'inv', freezeSql());
      assert.deepEqual(
        await rows(
          f.db,
          'inv',
          'select quantity,recomputed from public.rpc_mu7_verify_freeze() order by quantity',
        ),
        hashes,
      );
    } finally {
      await f.db.close();
    }
  });

test('an unreconciled existing v8 design is refused atomically by the upgrade', async () => {
  const f = await signedOffPilot({
    without: [migration],
    designVersion: version,
    stopAfter: 'design',
  });
  try {
    await assert.rejects(f.db.exec(readFileSync(migration, 'utf8')), /MU8-G01/);
    await f.db.exec('rollback');
    assert.equal(
      await one(
        f.db,
        'owner',
        "select count(*)::int from public.app_schema_version where version='8.0.0-v8-design-foundation'",
      ),
      0,
    );
  } finally {
    await f.db.close();
  }
});

test(
  'native PostgreSQL 16: v8 pending gates, categories, roles and one-design boundary',
  {
    skip:
      !process.env.VERIFY_PG_TEST_URL && process.env.VERIFY_PG_REQUIRE !== '1'
        ? 'BLOCKED: native PostgreSQL 16 test server unavailable'
        : false,
    timeout: 120_000,
  },
  async () => {
    assert.ok(process.env.VERIFY_PG_TEST_URL);
    await withDisposableHandoffDatabase(process.env.VERIFY_PG_TEST_URL, async (url: string) => {
      const client = new Client({ connectionString: url });
      try {
        await client.connect();
        await checkFoundation({
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

// A small engineering fixture verifies export version propagation; this is not the
// 100-unit acceptance run or the pending Python/database integration gate.
test('application export preserves the v8 database design version and two independent slots', async () => {
  const f = await formalOpen({ designVersion: version });
  try {
    await answerAll(f, 'r1', () => ({ answer: 'AGREE' }));
    await answerAll(f, 'r2', () => ({ answer: 'AGREE' }));
    await one(f.db, 'inv', phase('FORMAL_CLOSED_COMPLETE'));
    await one(f.db, 'inv', 'select public.rpc_mu7_snapshot()');
    await one(f.db, 'inv', `select public.rpc_mu7_lock_reference('FORMAL', '${ATT}')`);
    const bundle = await as(f.db, 'inv', () =>
      readMu7Bundle(
        mu7SqlData({ query: (sql, params) => f.db.query(sql, params) }),
        'FORMAL',
        'f'.repeat(40),
        true,
      ),
    );
    const manifest = JSON.parse(bundle.manifestText);
    assert.equal(manifest.design.design_version, version);
    assert.equal(manifest.bundle_format_version, '7.0');
    assert.match(manifest.status, /SYNTHETIC/);
    assert.equal(manifest.row_counts['units.csv'], 8);
    assert.equal(manifest.row_counts['independent_judgments.csv'], 16);
  } finally {
    await f.db.close();
  }
});

// These are design metadata only: no real units or gate approvals are inserted.
test('real-version v8 metadata requires 96 primary and 4 subgroup mappings and a supported version', async () => {
  const f = await signedOffPilot({ stopAfter: 'accounts' });
  try {
    const plan = {
      design_version: 'review-design-v8.0.0',
      assignment_set_id: 'SYN7-ASSIGN-V8-METADATA-TEST',
      overlap_setting: 'ALLOW',
      n_primary_planned: 96,
      n_subgroup_planned: 4,
      attestation: ATT,
    };
    for (const changes of [
      { n_primary_planned: 95 },
      { n_subgroup_planned: 5 },
      { design_version: 'review-design-v8.0.1' },
    ]) {
      await assert.rejects(
        one(
          f.db,
          'inv',
          `select public.rpc_mu7_record_design(${literal({ ...plan, ...changes })})`,
        ),
        /MU8-G02/,
      );
      assert.equal(await one(f.db, 'owner', 'select count(*)::int from public.mu7_design'), 0);
    }
    await one(f.db, 'inv', `select public.rpc_mu7_record_design(${literal(plan)})`);
    assert.equal(await one(f.db, 'owner', 'select count(*)::int from public.mu7_units'), 0);
    assert.equal(
      await one(f.db, 'owner', 'select count(*)::int from public.mu7_gate_approval_versions'),
      0,
    );
    const status = await rows<{ requirement_status: string; satisfied: boolean }>(
      f.db,
      'inv',
      "select * from public.rpc_mu7_gate_status() where gate_id='G-ALLOC-01'",
    );
    assert.equal(status[0].requirement_status, 'PENDING_SPECIFICATION');
    assert.equal(status[0].satisfied, false);
  } finally {
    await f.db.close();
  }
});
