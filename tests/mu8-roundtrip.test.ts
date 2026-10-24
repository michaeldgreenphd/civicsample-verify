// Entirely fictional records in disposable databases. No research input or cloud configuration.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { Client } from 'pg';
import { withDisposableHandoffDatabase } from '../scripts/test-handoff-postgres-helpers.mjs';
import { readMu7Bundle } from '../src/server/mu7-core';
import { mu7SqlData } from '../src/server/mu7';
import { MU7_SYNTHETIC_TRAINING } from '../src/lib/mu7-synthetic';
import { mu7RegistrationPayload } from '../src/lib/mu7-export';
import {
  ATT,
  signedOffPilot,
  one,
  rows,
  as,
  uidOf,
  pidOf,
  importObj,
  assignmentOf,
  specifyAndApproveGates,
  submitSql,
  adjudicateSql,
  phase,
  type Unit,
  type FixtureDb,
} from './mu7-fixture';

const python = process.env.VERIFY_ANALYSIS_PYTHON;
const version = 'SYN-8-DATABASE-ROUNDTRIP';
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const lit = (v: unknown) => `'${JSON.stringify(v).replace(/'/g, "''")}'::jsonb`;
const call = (name: string, v: unknown) => `select public.${name}(${lit(v)})`;
const areas = [
  'PATHOLOGICAL',
  'ONCOLOGY',
  'NEUROLOGICAL',
  'IMMUNE',
  'MENTAL_HEALTH',
  'RESPIRATORY',
  'INFECTIOUS',
  'METABOLIC',
  'UROGENITAL',
  'CARDIOVASCULAR',
];
const conditions = ['CAN_ALL', 'DIAB', 'DEP', 'OBE', 'AST', 'COPD', 'COV', 'SCZ', 'HTN', 'PAIN'];
const groups = {
  RULE_D_KEPT: 'D1_KEEP_TYPE2',
  RULE_D_REMOVED: 'D2_REMOVE_OTHER_TYPE',
  RULE_K_KEPT: 'K_KEEP_MALIGNANT_COMPATIBLE',
  RULE_K_REMOVED: 'K_REMOVE_VERIFIED_NONMALIGNANT',
};
const units: Unit[] = [];
for (const [fam, categories] of [
  ['AREA', areas],
  ['ROW', conditions],
  ['SG', Object.keys(groups)],
] as const)
  for (const [rank, cat] of categories.entries()) {
    const n = fam === 'AREA' ? (rank < 6 ? 6 : 5) : fam === 'ROW' ? 4 : 1;
    for (let i = 0; i < n; i++)
      units.push({
        uid: `MU7-${fam}-${cat}-${801 + i}`,
        fam,
        cat,
        code:
          fam === 'AREA'
            ? 'IN_AREA'
            : fam === 'ROW'
              ? 'IN_ROW'
              : groups[cat as keyof typeof groups],
        nct: `SYN-TRIAL-${String(1000 + units.length)}`,
        N: 100,
        n,
        gate: cat === 'PAIN' ? 'G-PAIN-01' : undefined,
      });
  }
const fileWrite = (bundle: Awaited<ReturnType<typeof readMu7Bundle>>, path: string) => {
  mkdirSync(path);
  for (const file of bundle.files) writeFileSync(join(path, file.name), file.content);
  writeFileSync(join(path, 'manifest.json'), bundle.manifestText);
};
async function payload(db: FixtureDb, u: Unit, overlap: 'ALLOW' | 'ONE_PER_TRIAL') {
  const p = importObj(u);
  delete (p.packet.trial as Record<string, unknown>).registry_url;
  p.packet.unit.mapping_label = await one(db, 'owner', 'select private.mu7_mapping_label($1,$2)', [
    u.fam,
    u.cat,
  ]);
  p.design.design_version = version;
  p.design.overlap_setting = overlap;
  return p;
}

async function runScenario(overlap: 'ALLOW' | 'ONE_PER_TRIAL', existing?: FixtureDb) {
  const f = await signedOffPilot({
    existing,
    designVersion: version,
    plannedPrimary: 96,
    plannedSubgroup: 4,
    overlap,
  });
  const db = f.db;
  try {
    for (const training of MU7_SYNTHETIC_TRAINING)
      await one(db, 'inv', call('rpc_mu7_import_training_unit', training));
    for (const who of ['r1', 'r2'] as const)
      await one(
        db,
        'inv',
        `select public.rpc_mu7_enroll_reviewer('${await uidOf(db, who)}','Synthetic qualifications')`,
      );
    const pseudos = [await pidOf(db, 'r1'), await pidOf(db, 'r2')];
    const data = [];
    for (const u of units) {
      const p = await payload(db, u, overlap);
      data.push(p);
      await one(db, 'inv', call('rpc_mu7_import_unit', p));
    }
    // An incorrect design-row version must fail through the existing equality guard.
    const bad = await payload(
      db,
      { ...units[0], uid: 'MU7-AREA-PATHOLOGICAL-900', nct: 'SYN-TRIAL-1900' },
      overlap,
    );
    bad.design.design_version = 'review-design-v8.0.0';
    await assert.rejects(one(db, 'inv', call('rpc_mu7_import_unit', bad)), /MU7-G20/);
    // Links cannot turn a fictional identifier into a public registry reference.
    const linked = await payload(
      db,
      { ...units[0], uid: 'MU7-AREA-PATHOLOGICAL-901', nct: 'SYN-TRIAL-1901' },
      overlap,
    );
    Object.assign(linked.packet.trial, { registry_url: 'https://example.test/fictional' });
    await assert.rejects(one(db, 'inv', call('rpc_mu7_import_unit', linked)), /MU8-G04/);
    await specifyAndApproveGates(db, 'all'); // disposable engineering decisions only
    const queue1 = units.map((u) => u.uid);
    const queue2 = [
      ...units.filter((u) => u.fam !== 'SG').reverse(),
      ...units.filter((u) => u.fam === 'SG').reverse(),
    ].map((u) => u.uid);
    const sorted = [...data].sort((a, b) => (a.unit_id < b.unit_id ? -1 : 1));
    const hashes = {
      unit_list_sha256: sha(sorted.map((u) => u.unit_id).join('\n')),
      assignment_set_sha256: sha(sorted.map((u) => u.assignment.row_sha256).join('\n')),
      design_rows_sha256: sha(
        sorted
          .map((u) => {
            const d = u.design;
            return sha(
              [
                u.unit_id,
                d.nct_id,
                d.frame_id,
                d.stratum,
                d.frame_stratum_size,
                d.n_sampled_in_stratum,
                d.allocation_option,
                d.overlap_setting,
                d.sampling_seed,
                d.prn_key,
              ].join('|'),
            );
          })
          .join('\n'),
      ),
      queue_sha256: sha(
        [queue1, queue2]
          .flatMap((ids, slot) => ids.map((u, i) => `${slot + 1}|${i + 1}|${u}`))
          .join('\n'),
      ),
    };
    await one(db, 'inv', call('rpc_mu7_freeze', { ...hashes, attestation: ATT }));
    await one(
      db,
      'inv',
      `select public.rpc_mu7_assign_queue('FORMAL',${lit({ slots: [queue1, queue2].map((ids, i) => ({ reviewer_slot: i + 1, reviewer_pseudo_id: pseudos[i], unit_ids: ids })) })})`,
    );
    await one(db, 'inv', phase('FORMAL_OPENED'));
    const exporter = () =>
      as(db, 'inv', () =>
        readMu7Bundle(
          mu7SqlData({ query: (sql, params) => db.query(sql, params) }),
          'FORMAL',
          'd'.repeat(40),
          true,
        ),
      );
    await assert.rejects(exporter(), /Lock the FORMAL reference before exporting/); // no export before the reference lock
    for (const [i, who] of (['r1', 'r2'] as const).entries()) {
      for (const uid of [queue1, queue2][i]) {
        const index = queue1.indexOf(uid);
        // Two no-information answers; one resolved discordance; one unresolved discordance;
        // one concordant disagreement. The remaining responses are arbitrary synthetic agrees.
        const answer =
          index === 0
            ? 'CANNOT_TELL'
            : index === 3 || ((index === 1 || index === 2) && i === 1)
              ? 'DISAGREE'
              : 'AGREE';
        await one(
          db,
          who,
          submitSql(await assignmentOf(db, pseudos[i], uid), {
            answer,
            ...(answer === 'DISAGREE'
              ? { reason_code: 'NOT_THE_CONDITION_STUDIED', note: 'Synthetic disagreement only.' }
              : {}),
            uncertain: index === 0,
          }),
        );
      }
      assert.equal(
        await one(db, who, "select count(*)::int from public.mu7_judgments where mode='FORMAL'"),
        100,
      );
    }
    await one(db, 'inv', phase('FORMAL_CLOSED_COMPLETE'));
    await one(db, 'inv', 'select public.rpc_mu7_snapshot()');
    await one(
      db,
      'adj',
      adjudicateSql({
        unit_id: queue1[1],
        decision: 'AGREE',
        status: 'DISCORDANT_RESOLVED',
        basis: 'REVIEWER_1',
        rationale: 'Synthetic evidence supports the assignment.',
      }),
    );
    await one(
      db,
      'adj',
      adjudicateSql({
        unit_id: queue1[2],
        status: 'UNRESOLVED_ESCALATED',
        basis: 'NONE',
        rationale: 'Synthetic unresolved evidence.',
      }),
    );
    await one(db, 'inv', `select public.rpc_mu7_lock_reference('FORMAL','${ATT}')`);
    const bundle = await exporter();
    assert.deepEqual(bundle.manifest.row_counts, {
      'units.csv': 100,
      'unit_design.csv': 100,
      'independent_judgments.csv': 200,
      'final_reference.csv': 100,
    });
    assert.equal((bundle.manifest.snapshot as Record<string, unknown>).n_rows, 200);
    assert.equal(bundle.manifest.n_units_locked, 100);
    for (const [k, v] of Object.entries(hashes))
      assert.equal((bundle.manifest.freeze as Record<string, unknown>)[k], v);
    const counts = await rows<{ family: string; n: number }>(
      db,
      'owner',
      "select family,count(*)::int as n from public.mu7_units where mode='FORMAL' group by family order by family",
    );
    assert.deepEqual(counts, [
      { family: 'AREA', n: 56 },
      { family: 'ROW', n: 40 },
      { family: 'SG', n: 4 },
    ]);
    assert.equal(
      await one(db, 'owner', "select count(*)::int from public.mu7_units where mode='PILOT'"),
      12,
    );
    const final = bundle.files.find((f) => f.role === 'final_reference')!.content;
    for (const status of ['CANNOT_TELL_BY_RULE', 'ADJUDICATED', 'UNRESOLVED', 'CONCORDANT'])
      assert.match(final, new RegExp(status));
    const registered = await as(db, 'inv', () =>
      mu7SqlData({ query: (sql, params) => db.query(sql, params) }).rpc(
        'rpc_mu7_register_export',
        { p: mu7RegistrationPayload(bundle, 'd'.repeat(40), 'Synthetic v8 round trip.') },
        'value',
      ),
    );
    assert.match(String(registered), /^[0-9a-f-]{36}$/);
    assert.equal(await one(db, 'owner', 'select count(*)::int from public.mu7_training_units'), 3);
    const pilot = await as(db, 'inv', () =>
      readMu7Bundle(
        mu7SqlData({ query: (sql, params) => db.query(sql, params) }),
        'PILOT',
        'd'.repeat(40),
        true,
      ),
    );
    return { bundle, pilot };
  } finally {
    await db.close();
  }
}

for (const overlap of ['ALLOW', 'ONE_PER_TRIAL'] as const)
  test(
    `v8 database exports 100 synthetic mappings and 200 judgments: ${overlap}`,
    { timeout: 120_000 },
    async () => {
      const { bundle, pilot } = await runScenario(overlap);
      if (!python) return; // The separately named integration test below explicitly marks Python absent.
      const dir = mkdtempSync(join(tmpdir(), 'verify-v8-roundtrip-'));
      try {
        const path = join(dir, 'bundle');
        fileWrite(bundle, path);
        const probabilities = join(dir, 'synthetic-probabilities.csv');
        writeFileSync(
          probabilities,
          'unit_id,pi_mc_ONE_PER_TRIAL\n' +
            units.map((u) => `${u.uid},${(u.n / u.N) * 0.97}`).join('\n') +
            '\n',
        );
        const extra = overlap === 'ONE_PER_TRIAL' ? ['--probabilities', probabilities] : [];
        const args = [
          'analysis/v8/performance_analysis_v8.py',
          '--bundle',
          path,
          '--out',
          join(dir, 'analysis'),
          '--allow-synthetic',
          '--bootstrap-reps',
          '50',
          ...extra,
        ];
        const r = spawnSync(python, args, { encoding: 'utf8' });
        assert.equal(r.status, 0, r.stdout + r.stderr);
        const output = readFileSync(join(dir, 'analysis', 'results_summary_v8.md'), 'utf8');
        assert.match(output, /SYNTHETIC/);
        assert.match(output, /clinician confirmation of displayed assignments/);
        const py = spawnSync(
          python,
          [
            '-m',
            'pytest',
            '-q',
            'analysis/v8/tests/test_performance_analysis_v8.py',
            '-k',
            'database_written_bundle_end_to_end',
            '-p',
            'no:cacheprovider',
          ],
          {
            encoding: 'utf8',
            env: {
              ...process.env,
              MU8_DB_BUNDLE: path,
              MU8_DB_PROBABILITIES: overlap === 'ONE_PER_TRIAL' ? probabilities : '',
              MU8_ALLOW_NO_DB_BUNDLE: '',
            },
          },
        );
        assert.equal(py.status, 0, py.stdout + py.stderr);
        assert.match(py.stdout, /1 passed/);
        assert.doesNotMatch(py.stdout, /skipped/);
        const refused = spawnSync(
          python,
          args
            .filter((x) => x !== '--allow-synthetic')
            .map((x) => (x === join(dir, 'analysis') ? join(dir, 'refused') : x)),
          { encoding: 'utf8' },
        );
        assert.equal(refused.status, 3);
        assert.match(refused.stderr, /SYNTHETIC/);
        fileWrite(pilot, join(dir, 'pilot'));
        const pilotResult = spawnSync(
          python,
          [
            'analysis/v8/performance_analysis_v8.py',
            '--bundle',
            join(dir, 'pilot'),
            '--out',
            join(dir, 'pilot-refused'),
            '--allow-synthetic',
          ],
          { encoding: 'utf8' },
        );
        assert.equal(pilotResult.status, 3);
        assert.match(pilotResult.stderr, /only a FORMAL bundle/);
        if (overlap === 'ONE_PER_TRIAL') {
          const missing = spawnSync(
            python,
            args
              .slice(0, -2)
              .map((x) => (x === join(dir, 'analysis') ? join(dir, 'missing-probabilities') : x)),
            { encoding: 'utf8' },
          );
          assert.equal(missing.status, 3);
          assert.match(missing.stderr, /needs --probabilities/);
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

test(
  'v8 database-to-Python integration interpreter is available',
  {
    skip: python
      ? false
      : 'BLOCKED: set VERIFY_ANALYSIS_PYTHON to an interpreter with analysis dependencies',
  },
  () => {
    assert.equal(spawnSync(python!, ['-c', 'import pandas, numpy, pytest']).status, 0);
  },
);

test(
  'native PostgreSQL: full v8 synthetic lifecycle and export',
  {
    skip:
      !process.env.VERIFY_PG_TEST_URL && process.env.VERIFY_PG_REQUIRE !== '1'
        ? 'BLOCKED: native PostgreSQL server unavailable'
        : false,
    timeout: 120_000,
  },
  async () => {
    assert.ok(process.env.VERIFY_PG_TEST_URL);
    await withDisposableHandoffDatabase(process.env.VERIFY_PG_TEST_URL, async (url: string) => {
      const c = new Client({ connectionString: url });
      try {
        await c.connect();
        await runScenario('ONE_PER_TRIAL', {
          exec: (sql) => c.query(sql),
          query: async <T>(sql: string, params: unknown[] = []) => ({
            rows: (await c.query(sql, params)).rows as T[],
          }),
        });
      } finally {
        await c.end();
      }
    });
  },
);

test('fictional formal identifiers are refused in v7 and real-version v8 designs', async () => {
  for (const dv of ['SYN-7-TESTFX', 'review-design-v8.0.0']) {
    const f = await signedOffPilot({
      designVersion: dv,
      plannedPrimary: 96,
      plannedSubgroup: 4,
      stopAfter: 'design',
    });
    try {
      const p = await payload(
        f.db,
        { ...units[0], fam: 'AREA', cat: 'ONCOLOGY', uid: 'MU7-AREA-ONCOLOGY-900' },
        'ALLOW',
      );
      await assert.rejects(one(f.db, 'inv', call('rpc_mu7_import_unit', p)), /MU8-G04/);
    } finally {
      await f.db.close();
    }
  }
});

test('0034 preserves existing v7 practice records during upgrade', async () => {
  const file = 'migrations/0034_v8_synthetic_identifiers.sql';
  const f = await signedOffPilot({ without: [file], stopAfter: 'pilotAnswers' });
  const tables = [
    'mu7_design',
    'mu7_units',
    'mu7_unit_design',
    'mu7_queue',
    'mu7_judgments',
    'mu7_gate_requirements',
    'mu7_gate_approval_versions',
  ];
  const snapshot = () =>
    Promise.all(
      tables.map((t) =>
        rows(
          f.db,
          'owner',
          `select to_jsonb(x) as row from public.${t} x order by to_jsonb(x)::text`,
        ),
      ),
    );
  try {
    const before = await snapshot();
    await f.db.exec(readFileSync(file, 'utf8'));
    assert.deepEqual(await snapshot(), before);
    const p = await payload(
      f.db,
      { ...units[0], fam: 'AREA', cat: 'ONCOLOGY', uid: 'MU7-AREA-ONCOLOGY-900' },
      'ALLOW',
    );
    await assert.rejects(one(f.db, 'inv', call('rpc_mu7_import_unit', p)), /MU8-G04/);
  } finally {
    await f.db.close();
  }
});
