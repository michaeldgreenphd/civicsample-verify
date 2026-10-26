import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, realpathSync, chmodSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from 'pg';
import { withDisposableHandoffDatabase } from '../scripts/test-handoff-postgres-helpers.mjs';
import { syntheticIntake, emptyIntakeDatabase } from './formal-intake-fixture';
import { ATT, P, one, rows, type FixtureDb } from './mu7-fixture';
import { formalIntakeSchema, type FormalIntake } from '../src/lib/formal-intake';
import {
  readFormalIntakeFile,
  formalIntakePlan,
  stageFormalSample,
} from '../src/server/formal-intake';
import type { Mu7Context } from '../src/server/mu7-core';
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
let cached: Promise<FormalIntake>;
const sample = () => (cached ??= syntheticIntake());
const intake = (db: FixtureDb, p: unknown, who: Parameters<typeof one>[1] = 'inv') =>
  one(db, who, 'select public.rpc_mu81_stage_sample($1::jsonb,$2)', [JSON.stringify(p), ATT]);

async function exercise(db: FixtureDb) {
  const p = await sample();
  for (const who of ['r1', 'r2', 'pt1', 'pt2', 'adj', 'out', 'inv1'] as const)
    await assert.rejects(intake(db, p, who), /investigator role/);
  for (const mutate of [
    (v: FormalIntake) => {
      v.expected.packet_inventory_sha256 = '0'.repeat(64);
    },
    (v: FormalIntake) => {
      v.expected.probability_binding_sha256 = '0'.repeat(64);
    },
    (v: FormalIntake) => {
      v.queue[199] = v.queue[198];
    },
    (v: FormalIntake) => {
      v.units.pop();
    },
    (v: FormalIntake) => {
      v.units[99].packet = { ai_reason: 'SYNTHETIC_PRIVATE_CANARY' };
    },
    (v: FormalIntake) => {
      v.reviewer_profile.rubric_sha256 = '0'.repeat(64);
    },
  ]) {
    const bad = structuredClone(p);
    mutate(bad);
    await assert.rejects(intake(db, bad));
    assert.equal(await one(db, 'owner', 'select count(*)::int from public.mu7_design'), 0);
    assert.equal(await one(db, 'owner', 'select count(*)::int from public.mu7_units'), 0);
    assert.equal(
      await one(db, 'owner', 'select count(*)::int from public.mu7_sample_intake_v81'),
      0,
    );
  }
  assert.deepEqual(await intake(db, p), {
    state: 'RECORDED',
    mappings: 100,
    queue_positions_checked: 200,
  });
  const before = await rows(db, 'owner', 'select * from public.mu7_sample_intake_v81');
  assert.deepEqual(await intake(db, p), {
    state: 'ALREADY_RECORDED',
    mappings: 100,
    queue_positions_checked: 200,
  });
  assert.deepEqual(await rows(db, 'owner', 'select * from public.mu7_sample_intake_v81'), before);
  const changed = structuredClone(p);
  changed.source_import_sha256 = '0'.repeat(64);
  await assert.rejects(intake(db, changed), /MU81-I03/);
  for (const who of ['r1', 'r2', 'adj'] as const) {
    assert.deepEqual(await rows(db, who, 'select * from public.mu7_units'), []);
    assert.deepEqual(await rows(db, who, 'select * from public.mu7_queue'), []);
    await assert.rejects(
      rows(db, who, 'select * from public.mu7_sample_intake_v81'),
      /permission denied/,
    );
  }
  for (const table of [
    'mu7_gate_approvals',
    'mu7_freeze',
    'mu7_queue',
    'mu7_phase_events',
    'mu7_judgments',
    'mu7_adjudications',
    'mu7_exports',
  ])
    assert.equal(await one(db, 'owner', `select count(*)::int from public.${table}`), 0, table);
  const { unit_list_sha256, assignment_set_sha256, design_rows_sha256, queue_sha256 } = p.expected;
  await assert.rejects(
    one(db, 'inv', 'select public.rpc_mu7_freeze($1::jsonb)', [
      JSON.stringify({
        unit_list_sha256,
        assignment_set_sha256,
        design_rows_sha256,
        queue_sha256,
        attestation: ATT,
      }),
    ]),
    /MU7-G29|MU7X-G06|pilot.*sign/i,
  );
  for (const role of ['anon', 'service_role']) {
    await db.exec(`begin; set local role ${role}`);
    try {
      await assert.rejects(
        db.query('select public.rpc_mu81_stage_sample($1::jsonb,$2)', [JSON.stringify(p), ATT]),
        /permission denied/,
      );
    } finally {
      await db.exec('rollback');
    }
  }
  await assert.rejects(
    db.exec('delete from public.mu7_sample_intake_v81'),
    /immutable|append|permitted|forbidden|mutation/i,
  );
}
test('intake is atomic, private, retryable and leaves clinical review closed', async () => {
  const db = await emptyIntakeDatabase();
  try {
    await exercise(db);
  } finally {
    await db.close();
  }
});
test('intake refuses an existing practice design without changing it', async () => {
  const db = await emptyIntakeDatabase();
  try {
    const p = await sample();
    await one(db, 'inv', 'select public.rpc_mu7_record_design($1::jsonb)', [
      JSON.stringify({
        ...p.design,
        design_version: 'SYN-8-1-EXISTING-PRACTICE',
        attestation: ATT,
      }),
    ]);
    const before = await rows(db, 'owner', 'select * from public.mu7_design');
    await assert.rejects(intake(db, p), /MU81-I03/);
    assert.deepEqual(await rows(db, 'owner', 'select * from public.mu7_design'), before);
    assert.deepEqual(await one(db, 'inv', 'select public.rpc_mu81_intake_status()'), {
      state: 'OCCUPIED',
    });
  } finally {
    await db.close();
  }
});
test('private intake file and server boundary refuse leakage, tampering and stale confirmation', async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'verify-intake-'))),
    file = join(dir, 'intake.json');
  const old = {
    file: process.env.VERIFY_FORMAL_INTAKE_FILE,
    sha: process.env.VERIFY_FORMAL_INTAKE_SHA256,
  };
  try {
    const p = await sample(),
      text = JSON.stringify(p);
    writeFileSync(file, text, { mode: 0o600 });
    process.env.VERIFY_FORMAL_INTAKE_FILE = file;
    process.env.VERIFY_FORMAL_INTAKE_SHA256 = sha(text);
    assert.equal((await readFormalIntakeFile(file, sha(text))).units.length, 100);
    assert.throws(() => formalIntakeSchema.parse({ ...p, ai_answers: ['SYNTHETIC_CANARY'] }));
    chmodSync(file, 0o644);
    await assert.rejects(readFormalIntakeFile(file, sha(text)), /integrity/);
    chmodSync(file, 0o600);
    symlinkSync(file, join(dir, 'alias.json'));
    await assert.rejects(readFormalIntakeFile(join(dir, 'alias.json'), sha(text)), /integrity/);
    await assert.rejects(readFormalIntakeFile(file, '0'.repeat(64)), /integrity/);
    const ctx = {
      role: 'REVIEWER',
      withData: () => {
        throw new Error('Private request must not run');
      },
    } as unknown as Mu7Context;
    await assert.rejects(formalIntakePlan(ctx), /investigator/);
    await assert.rejects(stageFormalSample(ctx, {}), /investigator/);
    ctx.role = 'INVESTIGATOR';
    await assert.rejects(
      stageFormalSample(ctx, { packageSha256: '0'.repeat(64), attestation: ATT }),
      /changed/,
    );
    ctx.withData = async (op) =>
      op({
        select: async () => [],
        rpc: async () => {
          throw new Error('SYNTHETIC_PRIVATE_CANARY');
        },
      });
    await assert.rejects(
      stageFormalSample(ctx, { packageSha256: sha(text), attestation: ATT }),
      (e: unknown) => e instanceof Error && !e.message.includes('CANARY'),
    );
  } finally {
    for (const [key, value] of [
      ['VERIFY_FORMAL_INTAKE_FILE', old.file],
      ['VERIFY_FORMAL_INTAKE_SHA256', old.sha],
    ]) {
      if (value === undefined) delete process.env[key!];
      else process.env[key!] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
test(
  'native PostgreSQL intake transaction and retry',
  { skip: !process.env.VERIFY_PG_TEST_URL },
  async () => {
    await withDisposableHandoffDatabase(process.env.VERIFY_PG_TEST_URL!, async (url: string) => {
      const c = new Client({ connectionString: url });
      await c.connect();
      const db = {
        query: <T>(sql: string, params?: unknown[]) =>
          c.query(sql, params) as unknown as Promise<{ rows: T[] }>,
        exec: (sql: string) => c.query(sql),
      };
      try {
        await emptyIntakeDatabase(db);
        await exercise(db);
      } finally {
        await c.end();
      }
    });
  },
);
test(
  'native PostgreSQL concurrent identical intakes create one receipt',
  { skip: !process.env.VERIFY_PG_TEST_URL },
  async () => {
    await withDisposableHandoffDatabase(process.env.VERIFY_PG_TEST_URL!, async (url: string) => {
      const first = new Client({ connectionString: url }),
        second = new Client({ connectionString: url });
      await first.connect();
      await second.connect();
      const db = {
        query: <T>(sql: string, params?: unknown[]) =>
          first.query(sql, params) as unknown as Promise<{ rows: T[] }>,
        exec: (sql: string) => first.query(sql),
      };
      try {
        await emptyIntakeDatabase(db);
        const p = await sample();
        const run = async (c: Client) => {
          await c.query('begin');
          try {
            await c.query("select set_config('request.jwt.claims',$1,true)", [
              JSON.stringify(P.inv),
            ]);
            await c.query('set local role authenticated');
            const result = await c.query('select public.rpc_mu81_stage_sample($1::jsonb,$2) as v', [
              JSON.stringify(p),
              ATT,
            ]);
            await c.query('commit');
            return result.rows[0].v.state;
          } catch (e) {
            await c.query('rollback');
            throw e;
          }
        };
        assert.deepEqual((await Promise.all([run(first), run(second)])).sort(), [
          'ALREADY_RECORDED',
          'RECORDED',
        ]);
        assert.equal(
          (await first.query('select count(*)::int as n from public.mu7_sample_intake_v81')).rows[0]
            .n,
          1,
        );
        assert.equal(
          (await first.query('select count(*)::int as n from public.mu7_units')).rows[0].n,
          100,
        );
      } finally {
        await first.end();
        await second.end();
      }
    });
  },
);
