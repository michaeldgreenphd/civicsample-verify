// =============================================================================
// mutation_harness_v7.mjs : proves that every guard and every named constraint of NNNN_v7_mapping_units.sql is
// exercised by a test that fails without it (reviewer finding: a guard test must test that guard's own error).
//
// 1. Lists every guard block ("-- GUARD MU7-Gnn BEGIN/END") and every named constraint (mu7_*_ck) in NNNN.
// 2. Runs rls_tests_v7.mjs once unmodified (every step must pass) and reads which steps carry which tag.
// 3. For each guard: reruns the suite with MU7_MUTATION=<guard> (the block removed from NNNN before loading); for each
//    constraint: reruns with MU7_DROP_CONSTRAINT=<table:constraint>. The mutation is KILLED when every step tagged with
//    it fails, and SURVIVES otherwise. A guard or constraint without any tagged step is reported UNTESTED.
// Usage: node mutation_harness_v7.mjs <out_dir> <suite args 1..10 as for rls_tests_v7.mjs> [--parallel N]
// Writes <out_dir>/mutation_results_v7.json and <out_dir>/mutation_results_v7.csv; refuses to overwrite.
// =============================================================================
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

const argv = process.argv.slice(2);
const pi = argv.indexOf('--parallel');
const PAR = pi >= 0 ? Number(argv[pi + 1]) : 4;
const args = pi >= 0 ? argv.filter((_, i) => i !== pi && i !== pi + 1) : argv;
const [outDir, ...suiteArgs] = args;
if (suiteArgs.length !== 10) { console.error('need out_dir and the 10 input paths of rls_tests_v7.mjs'); process.exit(2); }
if (fs.existsSync(outDir)) { console.error(`refusing to overwrite ${outDir}`); process.exit(2); }
fs.mkdirSync(path.join(outDir, 'runs'), { recursive: true });
const here = path.dirname(new URL(import.meta.url).pathname);
const suite = path.join(here, 'rls_tests_v7.mjs');
const nnnn = fs.readFileSync(suiteArgs[7], 'utf8');

const guards = [...new Set([...nnnn.matchAll(/-- GUARD (MU7-G[0-9]{2}) BEGIN/g)].map((m) => m[1]))].sort();
const constraints = [];
let table = null;
for (const line of nnnn.split('\n')) {
  const t = line.match(/^create table public\.(mu7_[a-z_]+) \(/);
  if (t) table = t[1];
  if (/^\);/.test(line)) table = null;
  for (const m of line.matchAll(/constraint (mu7_[a-z0-9_]+_ck)/g)) if (table) constraints.push(`${table}:${m[1]}`);
}

function run(label, env) {
  return new Promise((resolve) => {
    const res = path.join(outDir, 'runs', `${label}.json`);
    const sql = path.join(outDir, 'runs', `${label}.sql`);
    const p = spawn(process.execPath, [suite, ...suiteArgs, res, sql], { cwd: here, env: Object.assign({}, process.env, env) });
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    p.stdout.on('data', () => {});
    p.on('close', (code) => {
      let out = null;
      try { out = JSON.parse(fs.readFileSync(res, 'utf8')); } catch (e) { /* the run crashed before writing results */ }
      resolve({ label, code, err: err.slice(-400), out });
    });
  });
}
async function pool(jobs) {
  const results = [];
  let i = 0;
  async function worker() { while (i < jobs.length) { const j = jobs[i++]; results.push(await run(j.label, j.env)); } }
  await Promise.all(Array.from({ length: PAR }, worker));
  return results;
}

const base = (await pool([{ label: 'unmodified', env: { MU7_MUTATION: '', MU7_DROP_CONSTRAINT: '' } }]))[0];
if (!base.out || base.out.summary.fail !== 0) { console.error('the unmodified suite must pass every step first', base.err); process.exit(1); }
const tagged = {};
for (const r of base.out.results) if (r.tag) (tagged[r.tag] = tagged[r.tag] || []).push(r.id);
const jobs = [...guards.map((g) => ({ label: g, kind: 'guard', target: g, env: { MU7_MUTATION: g, MU7_DROP_CONSTRAINT: '' } })),
              ...constraints.map((c) => ({ label: c.replace(':', '__'), kind: 'constraint', target: c, env: { MU7_MUTATION: '', MU7_DROP_CONSTRAINT: c } }))];
const runs = await pool(jobs.filter((j) => tagged[j.target]));
const byLabel = Object.fromEntries(runs.map((r) => [r.label, r]));
const rows = [];
for (const j of jobs) {
  const ids = tagged[j.target] || [];
  if (!ids.length) { rows.push({ kind: j.kind, target: j.target, tagged_steps: 0, failed_tagged_steps: 0, verdict: 'UNTESTED', collateral_failures: '', note: '' }); continue; }
  const r = byLabel[j.label];
  if (!r.out) { rows.push({ kind: j.kind, target: j.target, tagged_steps: ids.length, failed_tagged_steps: 0, verdict: 'RUN_CRASHED', collateral_failures: '', note: r.err.replace(/\s+/g, ' ') }); continue; }
  const res = Object.fromEntries(r.out.results.map((x) => [x.id, x]));
  const failedTagged = ids.filter((id) => res[id] && !res[id].pass);
  const notReached = ids.filter((id) => !res[id]);
  const collateral = r.out.results.filter((x) => !x.pass && x.tag !== j.target).length;
  rows.push({ kind: j.kind, target: j.target, tagged_steps: ids.length, failed_tagged_steps: failedTagged.length,
              verdict: notReached.length ? 'NOT_REACHED' : failedTagged.length === ids.length ? 'KILLED' : 'SURVIVED',
              collateral_failures: collateral, note: notReached.length ? `not reached: ${notReached.join(' ')}` : '' });
}
const summary = { suite_steps_unmodified: base.out.summary.n, suite_pass_unmodified: base.out.summary.pass, guards: guards.length,
  constraints: constraints.length, killed: rows.filter((r) => r.verdict === 'KILLED').length,
  survived: rows.filter((r) => r.verdict === 'SURVIVED').length, untested: rows.filter((r) => r.verdict === 'UNTESTED').length,
  not_reached_or_crashed: rows.filter((r) => r.verdict === 'NOT_REACHED' || r.verdict === 'RUN_CRASHED').length,
  migration_sha256: base.out.summary.migration_sha256 };
fs.writeFileSync(path.join(outDir, 'mutation_results_v7.json'), JSON.stringify({ summary, rows }, null, 1));
const cols = ['kind', 'target', 'tagged_steps', 'failed_tagged_steps', 'verdict', 'collateral_failures', 'note'];
fs.writeFileSync(path.join(outDir, 'mutation_results_v7.csv'), [cols.join(','), ...rows.map((r) => cols.map((c) => `"${String(r[c]).replace(/"/g, '""')}"`).join(','))].join('\n') + '\n');
console.log(JSON.stringify(summary));
for (const r of rows.filter((x) => x.verdict !== 'KILLED')) console.log(r.verdict, r.target, r.note);
