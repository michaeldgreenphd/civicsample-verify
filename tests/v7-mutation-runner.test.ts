// The app-chain v7 mutation runner (scripts/test-handoff-v7-mutation.mjs), review threads on PR #8:
// it may start on this chain's one documented, untagged baseline difference and nothing else, and
// a clean run is one whose verdicts all add up to KILLED. Pure functions; no database.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  checkBaseline,
  clean,
  mutationTargets,
  summarize,
  verdicts,
} from '../scripts/test-handoff-v7-mutation.mjs';

type Row = { id: string; pass: boolean; tag?: string };
const out = (results: Row[]) => ({
  results,
  summary: { n: results.length, pass: results.filter((r) => r.pass).length },
});

test('the baseline tolerates only an untagged MU7-SCHEMA-01 failure', () => {
  assert.equal(checkBaseline(out([{ id: 'MU7-SCHEMA-01', pass: false }])), null);
  assert.match(
    checkBaseline(out([{ id: 'MU7-SCHEMA-01', pass: false, tag: 'MU7-G01' }])) ?? '',
    /unexpected baseline failures: MU7-SCHEMA-01/,
    'a tagged step is never tolerated, so the allowance cannot hide a mutation verdict',
  );
  assert.match(
    checkBaseline(out([{ id: 'MU7-PL-02', pass: false }])) ?? '',
    /unexpected baseline failures: MU7-PL-02/,
  );
  assert.match(checkBaseline(null) ?? '', /no results/);
});

test('verdicts and totals add up; only all-killed is clean', () => {
  const base = out([
    { id: 'S1', pass: true, tag: 'MU7-G01' },
    { id: 'S2', pass: true, tag: 'MU7-G02' },
    { id: 'S3', pass: true, tag: 'mu7_units:mu7_units_role_ck' },
    { id: 'MU7-SCHEMA-01', pass: false },
  ]);
  const jobs = [
    { label: 'MU7-G01', kind: 'guard', target: 'MU7-G01' },
    { label: 'MU7-G02', kind: 'guard', target: 'MU7-G02' },
    { label: 'MU7-G03', kind: 'guard', target: 'MU7-G03' },
    {
      label: 'mu7_units__mu7_units_role_ck',
      kind: 'constraint',
      target: 'mu7_units:mu7_units_role_ck',
    },
  ];
  const killedRun = (id: string) => ({
    out: out([
      { id, pass: false },
      { id: 'MU7-SCHEMA-01', pass: false },
    ]),
  });
  const rows = verdicts(base, jobs, {
    'MU7-G01': killedRun('S1'),
    'MU7-G02': { out: out([{ id: 'S2', pass: true }]) },
    mu7_units__mu7_units_role_ck: killedRun('S3'),
  });
  assert.deepEqual(
    rows.map((r: { verdict: string }) => r.verdict),
    ['KILLED', 'SURVIVED', 'UNTESTED', 'KILLED'],
  );
  const s = summarize(
    base,
    ['MU7-G01', 'MU7-G02', 'MU7-G03'],
    ['mu7_units:mu7_units_role_ck'],
    rows,
  );
  assert.equal(s.total, 4);
  assert.equal(s.killed + s.survived + s.untested + s.not_reached_or_crashed, s.total);
  assert.equal(clean(s), false);
  assert.equal(clean({ ...s, killed: 4, survived: 0, untested: 0 }), true);
});

test('the targets are the 60 guard blocks and 24 named constraints of the supplied 0024', () => {
  const { guards, constraints } = mutationTargets(
    readFileSync('migrations/0024_v7_mapping_units.sql', 'utf8'),
  );
  assert.equal(guards.length, 60);
  assert.equal(constraints.length, 24);
});
