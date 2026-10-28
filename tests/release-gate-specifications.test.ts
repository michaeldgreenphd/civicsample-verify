// Fictional preparation only. The release specification records questions and evidence
// bindings; it must never manufacture investigator approvals or change the sample.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { Client } from 'pg';
import { withDisposableHandoffDatabase } from '../scripts/test-handoff-postgres-helpers.mjs';
import { syntheticIntake, emptyIntakeDatabase } from './formal-intake-fixture';
import { ATT, one, rows, type FixtureDb } from './mu7-fixture';
import { MU84_GUIDE_SHA256, MU84_PROTOCOL_ID } from '../src/lib/mu84-completion';

const FILE = 'migrations/0043_v84_release_gate_specifications.sql';
const gates = [
  'G-ALLOC-01',
  'G-AREA-01',
  'G-MH-V53',
  'G-OQ-03',
  'G-OQ-04',
  'G-OVERLAP-01',
  'G-PAIN-01',
  'G-PROV-01',
  'G-RUBRIC-01',
  'G-TEXT-01',
  'G-TEXT-02',
];
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const evidence = () => ({
  attestation: ATT,
  evidence: gates.map((gate_id) => ({
    gate_id,
    reference: `Synthetic checked record for ${gate_id}`,
    sha256: sha(`Fictional evidence ${gate_id}`),
  })),
});
async function exercise(db: FixtureDb) {
  if (
    !(await one(
      db,
      'owner',
      "select exists(select 1 from public.app_schema_version where version='8.4.3-release-gate-specifications')",
    ))
  )
    await db.exec(readFileSync(FILE, 'utf8'));
  const state = () =>
    one(db, 'inv', 'select public.rpc_mu84_release_status()') as Promise<{ state_sha256: string }>;
  const record = async (p: unknown = evidence(), stateSha?: string) =>
    one(db, 'inv', 'select public.rpc_mu84_record_release_specifications($1,$2::jsonb)', [
      stateSha ?? (await state()).state_sha256,
      JSON.stringify(p),
    ]);
  await assert.rejects(record(), /MU84-L17/);
  const p = await syntheticIntake();
  await one(db, 'inv', 'select public.rpc_mu81_stage_sample($1::jsonb,$2)', [
    JSON.stringify(p),
    ATT,
  ]);
  await assert.rejects(record(), /MU84-L17/);
  const stale = (await state()).state_sha256;
  await one(db, 'inv', 'select public.rpc_mu84_bind_protocol($1::jsonb)', [
    JSON.stringify({
      mode: 'FORMAL',
      protocol_id: MU84_PROTOCOL_ID,
      guide_sha256: MU84_GUIDE_SHA256,
      attestation: ATT,
    }),
  ]);
  await assert.rejects(record(evidence(), stale), /MU84-L14/);
  for (const who of ['r1', 'r2', 'pt1', 'pt2', 'adj', 'out', 'inv1'] as const) {
    await assert.rejects(
      one(db, who, 'select public.rpc_mu84_record_release_specifications($1,$2::jsonb)', [
        (await state()).state_sha256,
        JSON.stringify(evidence()),
      ]),
      /investigator role/,
    );
    assert.equal(
      (await rows(db, who, 'select * from public.mu7_release_specification_v84')).length,
      0,
    );
  }
  for (const role of ['anon', 'service_role']) {
    await db.exec(`begin; set local role ${role}`);
    try {
      await assert.rejects(
        db.query('select public.rpc_mu84_record_release_specifications($1,$2::jsonb)', [
          'a'.repeat(64),
          JSON.stringify(evidence()),
        ]),
        /permission denied/,
      );
    } finally {
      await db.exec('rollback');
    }
  }
  const baseline = await rows<{ gate_id: string; requirement_version: number; blocks: string[] }>(
    db,
    'owner',
    'select distinct on(gate_id) gate_id,requirement_version,blocks from public.mu7_gate_requirements order by gate_id,requirement_version desc',
  );
  const inventory = await one(db, 'owner', 'select private.mu81_intake_inventory()');
  for (const bad of [
    { ...evidence(), attestation: 'short' },
    { ...evidence(), evidence: null },
    { ...evidence(), evidence: evidence().evidence.slice(1) },
    { ...evidence(), evidence: evidence().evidence.map((x) => ({ ...x, gate_id: 'G-EST-01' })) },
    { ...evidence(), evidence: evidence().evidence.map((x) => ({ ...x, sha256: null })) },
    { ...evidence(), evidence: evidence().evidence.map((x) => ({ ...x, reference: '   ' })) },
    { ...evidence(), evidence: [...evidence().evidence.slice(1), evidence().evidence[1]] },
    { ...evidence(), approve: true },
  ])
    await assert.rejects(record(bad), /MU84-L1[58]|MU7-G07/);
  assert.equal(
    await one(db, 'owner', 'select count(*)::integer from public.mu7_release_specification_v84'),
    0,
  );
  const result = (await record()) as {
    specified: number;
    approvals_recorded: number;
    binding_sha256: string;
  };
  assert.equal(result.specified, 11);
  assert.equal(result.approvals_recorded, 0);
  assert.match(result.binding_sha256, /^[a-f0-9]{64}$/);
  assert.equal(
    await one(db, 'owner', 'select count(*)::integer from public.mu7_gate_approvals'),
    0,
  );
  assert.deepEqual(await one(db, 'owner', 'select private.mu81_intake_inventory()'), inventory);
  for (const name of ['mu7_freeze', 'mu7_queue', 'mu7_judgments', 'mu7_phase_events'])
    assert.equal(await one(db, 'owner', `select count(*)::integer from public.${name}`), 0);
  const latest = await rows<{
    gate_id: string;
    requirement_version: number;
    blocks: string[];
    requirement_status: string;
    decision_reference: string;
  }>(
    db,
    'owner',
    'select distinct on(gate_id) * from public.mu7_gate_requirements order by gate_id,requirement_version desc',
  );
  for (const before of baseline) {
    const after = latest.find((r) => r.gate_id === before.gate_id)!;
    assert.deepEqual(after.blocks, before.blocks, 'every operation blocked before remains blocked');
    assert.equal(
      after.requirement_version,
      before.requirement_version + (gates.includes(before.gate_id) ? 1 : 0),
    );
    if (gates.includes(before.gate_id)) {
      assert.equal(after.requirement_status, 'SPECIFIED');
      assert.ok(after.decision_reference.includes(result.binding_sha256));
    }
  }
  const receipt = (
    await rows<{ bindings: Record<string, unknown>; evidence: unknown[] }>(
      db,
      'inv',
      'select bindings,evidence from public.mu7_release_specification_v84',
    )
  )[0];
  assert.deepEqual(receipt.bindings.manifest, p.expected);
  assert.equal(receipt.bindings.guide_sha256, MU84_GUIDE_SHA256);
  assert.equal(receipt.bindings.source_import_sha256, p.source_import_sha256);
  assert.equal(receipt.evidence.length, 11);
  for (const who of ['r1', 'r2', 'pt1', 'pt2', 'adj', 'out', 'inv1'] as const) {
    assert.equal(
      (await rows(db, who, 'select * from public.mu7_release_specification_v84')).length,
      0,
      'recorded evidence is still investigator-with-MFA only',
    );
  }
  await assert.rejects(record(), /MU84-L16/);
  await assert.rejects(
    one(db, 'owner', 'delete from public.mu7_release_specification_v84'),
    /immutable|mutation|append/i,
  );
  await assert.rejects(
    one(
      db,
      'owner',
      "update public.mu7_release_specification_v84 set attestation='Another attestation text for test.'",
    ),
    /immutable|mutation|append/i,
  );
  assert.ok(
    ((await one(db, 'owner', "select private.mu7x_unsatisfied_gates('FREEZE')")) as unknown[])
      .length > 0,
  );
  const status = await rows<{ gate_id: string; satisfied: boolean }>(
    db,
    'inv',
    'select * from public.rpc_mu7_gate_status()',
  );
  assert.equal(status.filter((g) => g.satisfied).length, 0, 'a specification is never an approval');
}

test('release specifications bind current evidence and guides without approving or weakening gates', async () => {
  const db = await emptyIntakeDatabase();
  try {
    await exercise(db);
  } finally {
    await db.close();
  }
});

test('an existing descriptive-plan approval survives recording the other eleven specifications', async () => {
  const db = await emptyIntakeDatabase();
  try {
    if (
      !(await one(
        db,
        'owner',
        "select exists(select 1 from public.app_schema_version where version='8.4.3-release-gate-specifications')",
      ))
    )
      await db.exec(readFileSync(FILE, 'utf8'));
    const p = await syntheticIntake();
    await one(db, 'inv', 'select public.rpc_mu81_stage_sample($1::jsonb,$2)', [
      JSON.stringify(p),
      ATT,
    ]);
    await one(db, 'inv', 'select public.rpc_mu84_bind_protocol($1::jsonb)', [
      JSON.stringify({
        mode: 'FORMAL',
        protocol_id: MU84_PROTOCOL_ID,
        guide_sha256: MU84_GUIDE_SHA256,
        attestation: ATT,
      }),
    ]);
    const status = () =>
      one(db, 'inv', 'select public.rpc_mu84_release_status()') as Promise<{
        state_sha256: string;
      }>;
    await one(db, 'inv', 'select public.rpc_mu84_release_action($1,$2,$3::jsonb)', [
      'record-descriptive-plan',
      (await status()).state_sha256,
      JSON.stringify({ attestation: ATT }),
    ]);
    const reference = await one(
      db,
      'inv',
      "select decision_reference from public.mu7_gate_requirements where gate_id='G-EST-01' order by requirement_version desc limit 1",
    );
    await one(db, 'inv', 'select public.rpc_mu7_approve_gate($1,$2,$3)', [
      'G-EST-01',
      ATT,
      reference,
    ]);
    const before = await rows(db, 'owner', 'select * from public.mu7_gate_approvals');
    const versions = await rows(db, 'owner', 'select * from public.mu7_gate_approval_versions');
    const result = (await one(
      db,
      'inv',
      'select public.rpc_mu84_record_release_specifications($1,$2::jsonb)',
      [(await status()).state_sha256, JSON.stringify(evidence())],
    )) as { specified: number; approvals_recorded: number };
    assert.equal(result.specified, 11);
    assert.equal(result.approvals_recorded, 0);
    assert.equal(before.length, 1);
    assert.deepEqual(await rows(db, 'owner', 'select * from public.mu7_gate_approvals'), before);
    assert.deepEqual(
      await rows(db, 'owner', 'select * from public.mu7_gate_approval_versions'),
      versions,
    );
    assert.equal(
      await one(
        db,
        'inv',
        "select satisfied from public.rpc_mu7_gate_status() where gate_id='G-EST-01'",
      ),
      true,
    );
    assert.equal(
      await one(
        db,
        'inv',
        "select count(*)::integer from public.rpc_mu7_gate_status() where gate_id<>'G-EST-01' and satisfied",
      ),
      0,
    );
  } finally {
    await db.close();
  }
});

test(
  'native PostgreSQL: investigator release specification boundary',
  {
    skip: process.env.VERIFY_PG_TEST_URL
      ? false
      : 'BLOCKED: native PostgreSQL test URL unavailable',
  },
  async () => {
    await withDisposableHandoffDatabase(process.env.VERIFY_PG_TEST_URL!, async (url: string) => {
      const client = new Client({ connectionString: url });
      await client.connect();
      const db: FixtureDb = {
        query: <T>(sql: string, params?: unknown[]) =>
          client.query(sql, params) as unknown as Promise<{ rows: T[] }>,
        exec: (sql) => client.query(sql),
      };
      try {
        await emptyIntakeDatabase(db);
        await exercise(db);
      } finally {
        await client.end();
      }
    });
  },
);
