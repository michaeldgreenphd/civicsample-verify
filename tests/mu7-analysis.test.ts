// SYNTHETIC ENGINEERING ONLY. Database -> application export -> analysis for review design v7.
// A disposable database runs the supplied suite's FORMAL scenario (tests/handoff/v7.mjs, db1: the
// same eight NCT99-placeholder units, the same answers, revisions, close, snapshot and tie-breaks).
// Its study-decision gates are specified and approved SYNTHETICALLY in that database only (the
// application never does this; migration 0026 keeps the formal review closed everywhere else). The
// application's own bundle writer (src/server/mu7-core.ts readMu7Bundle) exports it, and the
// vendored analysis (analysis/v7) reads it with the suite's expected results. A PILOT bundle is
// refused by the analysis. Bundles are written to a temporary folder outside the repository.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { Mu7Bundle } from '../src/lib/mu7-types';
import { mu7RegistrationPayload } from '../src/lib/mu7-export';
import { MU7_PILOT_PLANTED } from '../src/lib/mu7-synthetic';
import { readMu7Bundle } from '../src/server/mu7-core';
import { mu7SqlData } from '../src/server/mu7';
import {
  adjudicateSql,
  as,
  assignmentOf,
  ATT,
  formalOpen,
  FORMAL_QUEUE_1,
  FORMAL_QUEUE_2,
  FORMAL_UNITS,
  one,
  phase,
  signedOffPilot,
  submitSql,
  type FixtureDb,
} from './mu7-fixture';

const python = process.env.VERIFY_ANALYSIS_PYTHON;
const SHA = 'd'.repeat(40);
const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
const F = Object.fromEntries(FORMAL_UNITS.map((u, i) => [`F${i + 1}`, u.uid]));
const key = (uid: string) => Object.keys(F).find((k) => F[k] === uid)!;
// The supplied suite's FORMAL answers (tests/handoff/v7.mjs, FA1 and FA2).
const FA1: Record<string, Record<string, unknown>> = {
  F1: { answer: 'AGREE' },
  F2: { answer: 'AGREE' },
  F3: { answer: 'AGREE', uncertain: true },
  F4: {
    answer: 'DISAGREE',
    reason_code: 'NOT_THE_CONDITION_STUDIED',
    note: 'Synthetic note: not the condition studied.',
  },
  F5: { answer: 'CANNOT_TELL', uncertain: true },
  F6: { answer: 'AGREE' },
  F7: { answer: 'AGREE' },
  F8: {
    answer: 'DISAGREE',
    reason_code: 'BENIGN_NEOPLASM',
    note: 'Synthetic note: a benign tumour.',
  },
};
const FA2: Record<string, Record<string, unknown>> = {
  F1: { answer: 'AGREE' },
  F2: { answer: 'CANNOT_TELL' },
  F3: {
    answer: 'DISAGREE',
    reason_code: 'ORGAN_OF_ORIGIN_ONLY',
    note: 'Synthetic note: organ of origin only.',
  },
  F4: {
    answer: 'DISAGREE',
    reason_code: 'MESH_PLACEMENT_MISLEADING',
    note: 'Synthetic note: MeSH placement only.',
  },
  F5: { answer: 'CANNOT_TELL' },
  F6: {
    answer: 'DISAGREE',
    reason_code: 'NOT_THE_CONDITION_STUDIED',
    note: 'Synthetic note: first reading.',
  },
  F7: { answer: 'AGREE' },
  F8: { answer: 'AGREE' },
};

function writeBundle(bundle: Mu7Bundle, dir: string) {
  mkdirSync(dir, { recursive: true });
  for (const f of bundle.files) writeFileSync(join(dir, f.name), f.content);
  writeFileSync(join(dir, 'manifest.json'), bundle.manifestText);
}
const investigatorData = (db: FixtureDb) => ({
  read: <T>(fn: (d: ReturnType<typeof mu7SqlData>) => Promise<T>) =>
    as(db, 'inv', () => fn(mu7SqlData({ query: (sql, params) => db.query(sql, params) }))),
});

async function formalBundle(): Promise<{ bundle: Mu7Bundle; registered: unknown }> {
  const f = await formalOpen();
  try {
    const submit = async (who: 'r1' | 'r2', unit: string, answer: Record<string, unknown>) =>
      one(f.db, who, submitSql(await assignmentOf(f.db, who === 'r1' ? f.R1 : f.R2, unit), answer));
    for (const u of FORMAL_QUEUE_1) await submit('r1', u, FA1[key(u)]);
    for (const u of FORMAL_QUEUE_2.slice(0, 6)) await submit('r2', u, FA2[key(u)]);
    await submit('r2', F.F7, FA2.F7);
    await submit('r1', F.F1, { answer: 'AGREE', uncertain: true });
    await submit('r2', F.F6, { answer: 'AGREE', note: 'Synthetic note: second reading.' });
    await submit('r2', F.F8, FA2.F8);
    await one(f.db, 'inv', phase('FORMAL_CLOSED_COMPLETE'));
    await one(f.db, 'inv', 'select public.rpc_mu7_snapshot()');
    await one(
      f.db,
      'adj',
      adjudicateSql({
        unit_id: F.F2,
        decision: 'AGREE',
        status: 'DISCORDANT_RESOLVED',
        basis: 'REVIEWER_1',
        rationale: 'Synthetic: supported.',
      }),
    );
    await one(
      f.db,
      'adj',
      adjudicateSql({
        unit_id: F.F3,
        decision: 'DISAGREE',
        reason_code: 'ORGAN_OF_ORIGIN_ONLY',
        status: 'DISCORDANT_RESOLVED',
        basis: 'REVIEWER_2',
        disagreement_reason_code: 'POLICY_RULE_INTERPRETATION',
        rationale: 'Synthetic: neoplasm policy.',
      }),
    );
    await one(
      f.db,
      'adj',
      adjudicateSql({
        unit_id: F.F8,
        status: 'UNRESOLVED_ESCALATED',
        basis: 'NONE',
        rationale: 'Synthetic: unresolved.',
      }),
    );
    await one(f.db, 'inv', `select public.rpc_mu7_lock_reference('FORMAL', '${ATT}')`);
    const io = investigatorData(f.db);
    const bundle = await io.read((d) => readMu7Bundle(d, 'FORMAL', SHA, true));
    const registered = await io.read((d) =>
      d.rpc(
        'rpc_mu7_register_export',
        { p: mu7RegistrationPayload(bundle, SHA, 'Synthetic analysis round trip.') },
        'value',
      ),
    );
    return { bundle, registered };
  } finally {
    await f.db.close();
  }
}

async function pilotBundle(): Promise<Mu7Bundle> {
  const { db } = await signedOffPilot({ stopAfter: 'pilotLock' });
  try {
    return await investigatorData(db).read((d) => readMu7Bundle(d, 'PILOT', SHA, true));
  } finally {
    await db.close();
  }
}

test('the application writes the FORMAL bundle 7.0 of the synthetic scenario and registers it', async () => {
  const { bundle, registered } = await formalBundle();
  assert.match(String(registered), /^[0-9a-f-]{36}$/);
  assert.equal(bundle.manifest.mode, 'FORMAL');
  assert.match(String(bundle.manifest.status), /^SYNTHETIC/);
  const files = bundle.manifest.files as Record<string, string>;
  for (const f of bundle.files) assert.equal(files[f.name], sha256(f.content));
  assert.deepEqual(bundle.manifest.row_counts, {
    'units.csv': 8,
    'unit_design.csv': 8,
    'independent_judgments.csv': 16,
    'final_reference.csv': 8,
  });
  const freeze = bundle.manifest.freeze as Record<string, unknown>;
  assert.equal(freeze.n_units, 8);
  assert.equal((bundle.manifest.snapshot as Record<string, unknown>).n_rows, 18);
  const final = bundle.files.find((f) => f.role === 'final_reference')!.content;
  for (const [k, expected] of Object.entries({
    F1: 'CONCORDANT',
    F2: 'ADJUDICATED',
    F3: 'ADJUDICATED',
    F4: 'CONCORDANT',
    F5: 'CANNOT_TELL_BY_RULE',
    F6: 'CONCORDANT',
    F7: 'CONCORDANT',
    F8: 'UNRESOLVED',
  }))
    assert.match(final, new RegExp(`^${F[k]},.*,${expected},`, 'm'), k);
  assert.equal(Object.keys(MU7_PILOT_PLANTED).length, 12);
});

test(
  'the vendored v7 analysis reads the application-written FORMAL bundle and refuses a PILOT bundle',
  {
    skip: python
      ? false
      : 'BLOCKED: set VERIFY_ANALYSIS_PYTHON to a Python with analysis/requirements.txt',
  },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'verify-mu7-analysis-'));
    try {
      const { bundle } = await formalBundle();
      writeBundle(bundle, join(dir, 'formal'));
      // The supplied end-to-end test, unchanged, on this bundle (it must run, never skip).
      const pytest = spawnSync(
        python!,
        [
          '-m',
          'pytest',
          '-q',
          'analysis/v7/tests/test_performance_analysis_v7.py',
          '-k',
          'database_written_bundle_end_to_end',
          '-p',
          'no:cacheprovider',
        ],
        {
          encoding: 'utf8',
          env: { ...process.env, MU7_DB_BUNDLE: join(dir, 'formal'), MU7_ALLOW_NO_DB_BUNDLE: '' },
        },
      );
      assert.equal(pytest.status, 0, pytest.stdout + pytest.stderr);
      assert.match(pytest.stdout, /1 passed/);
      assert.doesNotMatch(pytest.stdout, /skipped/);
      // The analysis itself: synthetic, so --allow-synthetic is required; outputs in a new folder.
      const out = join(dir, 'analysis-out');
      const refused = spawnSync(
        python!,
        ['analysis/v7/performance_analysis_v7.py', '--bundle', join(dir, 'formal'), '--out', out],
        {
          encoding: 'utf8',
        },
      );
      assert.equal(refused.status, 3);
      assert.match(refused.stderr, /REFUSED: a SYNTHETIC bundle needs --allow-synthetic/);
      execFileSync(
        python!,
        [
          'analysis/v7/performance_analysis_v7.py',
          '--bundle',
          join(dir, 'formal'),
          '--out',
          out,
          '--allow-synthetic',
          '--bootstrap-reps',
          '200',
        ],
        { encoding: 'utf8' },
      );
      const summary = readFileSync(join(out, 'results_summary_v7.md'), 'utf8');
      assert.match(summary, /clinician confirmation of displayed assignments/);
      assert.match(summary, /SYNTHETIC/);
      // The pilot bundle is synthetic and outside every statistic: the analysis refuses it.
      writeBundle(await pilotBundle(), join(dir, 'pilot'));
      const pilot = spawnSync(
        python!,
        [
          'analysis/v7/performance_analysis_v7.py',
          '--bundle',
          join(dir, 'pilot'),
          '--out',
          join(dir, 'pilot-out'),
          '--allow-synthetic',
        ],
        { encoding: 'utf8' },
      );
      assert.equal(pilot.status, 3);
      assert.match(pilot.stderr, /REFUSED: mode 'PILOT': only a FORMAL bundle is analysed/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
