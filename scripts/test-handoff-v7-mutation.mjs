// Mutation testing of migration 0024 (the supplied v7 migration) on THIS repository's own chain.
//
// Same method and verdicts as the vendored harness (tests/handoff/v7-mutation.mjs, kept verbatim for
// the package's reference stack): run the supplied suite (tests/handoff/v7.mjs) unmodified, then once
// per guard block of 0024 with that block removed (MU7_MUTATION) and once per named constraint with
// it dropped (MU7_DROP_CONSTRAINT). A mutation is KILLED when every step tagged with it fails.
//
// The one difference: on this chain the unmodified suite has a documented, untagged baseline
// difference (MU7-SCHEMA-01, the schema-version list, which sees this repository's own markers).
// The vendored harness refuses any baseline failure, so it can never start here. This runner allows
// exactly the steps in ALLOWED_BASELINE, and only when they carry no guard or constraint tag, so the
// tolerance can never hide a mutation verdict. Every other baseline failure stops the run.
//
//   node scripts/test-handoff-v7-mutation.mjs [out_dir] [--parallel N]
// Writes <out_dir>/mutation_results_v7.json and .csv to a NEW folder; nothing is overwritten.
import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  copyFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ALLOWED_BASELINE = ['MU7-SCHEMA-01'];
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const pi = argv.indexOf('--parallel');
const parallel = pi >= 0 ? Number(argv[pi + 1]) : 4;
const positional = argv.filter((_, i) => pi < 0 || (i !== pi && i !== pi + 1));
const outDir = resolve(
  positional[0] ?? `test-results/v7-mutation-${new Date().toISOString().replace(/[:.]/g, '')}`,
);
if (existsSync(outDir)) throw new Error(`refusing to overwrite ${outDir}`);
const chain = {
  appThrough0011: [
    'migrations/0004_synthetic_verify_workflow.sql',
    'migrations/0005_review_integrity_fixes.sql',
    'migrations/0006_reference_integrity.sql',
    'migrations/0007_frozen_contract_guards.sql',
    'migrations/0008_trial_packet_and_concurrency_guards.sql',
    'migrations/0009_canonical_packet_and_lock_state_guards.sql',
    'migrations/0010_investigator_judgment_boundary.sql',
    'migrations/0011_v5_trial_label_verification.sql',
  ],
  tail: [
    'migrations/0013_v5_independent_finality_guards.sql',
    'migrations/0014_legacy_pilot_and_packet_guards.sql',
    'migrations/0015_v5_review_fixes.sql',
    'migrations/0016_mapping_confirmation.sql',
    'migrations/0017_v5_rubric_binding.sql',
    'migrations/0018_mapping_confirmation_review_fixes.sql',
    'migrations/0019_v5_rubric_binding_reconciliation.sql',
    'migrations/0020_mapping_confirmation_completeness_and_serialization.sql',
    'migrations/0021_account_locks.sql',
    'migrations/0022_service_role_admin_grants.sql',
    'migrations/0023_service_role_truncate_revoke.sql',
  ],
};
const MIGRATION = 'migrations/0024_v7_mapping_units.sql';

/** Guard blocks and named constraints of 0024, parsed as the vendored harness does. */
export function mutationTargets(text) {
  const guards = [
    ...new Set([...text.matchAll(/-- GUARD (MU7-G[0-9]{2}) BEGIN/g)].map((m) => m[1])),
  ].sort();
  const constraints = [];
  let table = null;
  for (const line of text.split('\n')) {
    const t = line.match(/^create table public\.(mu7_[a-z_]+) \(/);
    if (t) table = t[1];
    if (/^\);/.test(line)) table = null;
    for (const m of line.matchAll(/constraint (mu7_[a-z0-9_]+_ck)/g))
      if (table) constraints.push(`${table}:${m[1]}`);
  }
  return { guards, constraints };
}

/** The baseline is acceptable when its only failures are allowed and untagged. */
export function checkBaseline(out) {
  if (!out) return 'the unmodified suite produced no results';
  const failed = out.results.filter((r) => r.pass !== true);
  const bad = failed.filter((r) => !ALLOWED_BASELINE.includes(r.id) || r.tag);
  if (bad.length) return `unexpected baseline failures: ${bad.map((r) => r.id).join(', ')}`;
  return null;
}

/** Verdicts identical to the vendored harness. */
export function verdicts(base, jobs, runsByLabel) {
  const tagged = {};
  for (const r of base.results) if (r.tag) (tagged[r.tag] = tagged[r.tag] || []).push(r.id);
  const rows = [];
  for (const j of jobs) {
    const ids = tagged[j.target] || [];
    if (!ids.length) {
      rows.push({
        kind: j.kind,
        target: j.target,
        tagged_steps: 0,
        failed_tagged_steps: 0,
        verdict: 'UNTESTED',
        collateral_failures: '',
        note: '',
      });
      continue;
    }
    const r = runsByLabel[j.label];
    if (!r?.out) {
      rows.push({
        kind: j.kind,
        target: j.target,
        tagged_steps: ids.length,
        failed_tagged_steps: 0,
        verdict: 'RUN_CRASHED',
        collateral_failures: '',
        note: (r?.err ?? '').replace(/\s+/g, ' '),
      });
      continue;
    }
    const res = Object.fromEntries(r.out.results.map((x) => [x.id, x]));
    const failedTagged = ids.filter((id) => res[id] && !res[id].pass);
    const notReached = ids.filter((id) => !res[id]);
    const collateral = r.out.results.filter(
      (x) => !x.pass && x.tag !== j.target && !ALLOWED_BASELINE.includes(x.id),
    ).length;
    rows.push({
      kind: j.kind,
      target: j.target,
      tagged_steps: ids.length,
      failed_tagged_steps: failedTagged.length,
      verdict: notReached.length
        ? 'NOT_REACHED'
        : failedTagged.length === ids.length
          ? 'KILLED'
          : 'SURVIVED',
      collateral_failures: collateral,
      note: notReached.length ? `not reached: ${notReached.join(' ')}` : '',
    });
  }
  return rows;
}

/** Summary whose totals add up; a clean run has killed === total and nothing else. */
export function summarize(base, guards, constraints, rows) {
  const count = (v) => rows.filter((r) => r.verdict === v).length;
  return {
    chain: 'application (schema, 0002, 0003, repo 0004-0010, 0011, 0012, repo 0013-0023, 0024)',
    allowed_baseline_differences: ALLOWED_BASELINE,
    suite_steps_unmodified: base.summary.n,
    suite_pass_unmodified: base.summary.pass,
    guards: guards.length,
    constraints: constraints.length,
    total: guards.length + constraints.length,
    killed: count('KILLED'),
    survived: count('SURVIVED'),
    untested: count('UNTESTED'),
    not_reached_or_crashed: count('NOT_REACHED') + count('RUN_CRASHED'),
  };
}
export const clean = (s) =>
  s.killed === s.total && !s.survived && !s.untested && !s.not_reached_or_crashed;

async function main() {
  const scratch = mkdtempSync(join(tmpdir(), 'verify-v7-mutation-'));
  try {
    const concat = (name, files) => {
      const p = join(scratch, name);
      writeFileSync(p, files.map((f) => readFileSync(join(root, f), 'utf8')).join(''));
      return p;
    };
    copyFileSync(join(root, 'tests/handoff/v7.mjs'), join(scratch, 'rls_tests_v7.mjs'));
    symlinkSync(join(root, 'node_modules'), join(scratch, 'node_modules'), 'dir');
    const abs = (p) => join(root, p);
    const suiteArgs = [
      abs('supabase_test_shim/auth_shim.sql'),
      abs('schema.sql'),
      abs('migrations/0002_v3_review_design.sql'),
      abs('migrations/0003_v4_record_categories_module_b.sql'),
      concat('chain_app_0004_to_0011.sql', chain.appThrough0011),
      abs('migrations/0012_v5_training_examples.sql'),
      concat('chain_app_0013_to_0023.sql', chain.tail),
      abs(MIGRATION),
      abs('tests/handoff/fixtures/v7/SYNTHETIC_PILOT_UNITS_v7.json'),
      abs('tests/handoff/fixtures/v7/VOCABULARY_CONTRACT_v7.json'),
    ];
    mkdirSync(join(outDir, 'runs'), { recursive: true });
    const run = (label, env) =>
      new Promise((resolvePromise) => {
        const res = join(outDir, 'runs', `${label}.json`);
        const sql = join(outDir, 'runs', `${label}.sql`);
        const p = spawn(
          process.execPath,
          [join(scratch, 'rls_tests_v7.mjs'), ...suiteArgs, res, sql],
          {
            cwd: scratch,
            env: { ...process.env, ...env },
          },
        );
        let err = '';
        p.stderr.on('data', (d) => (err += d));
        p.stdout.on('data', () => {});
        p.on('close', () => {
          let out = null;
          try {
            out = JSON.parse(readFileSync(res, 'utf8'));
          } catch {
            /* crashed before writing results */
          }
          resolvePromise({ label, err: err.slice(-400), out });
        });
      });
    const pool = async (jobs) => {
      const results = [];
      let i = 0;
      const worker = async () => {
        while (i < jobs.length) {
          const j = jobs[i++];
          results.push(await run(j.label, j.env));
        }
      };
      await Promise.all(Array.from({ length: parallel }, worker));
      return results;
    };
    const { guards, constraints } = mutationTargets(readFileSync(abs(MIGRATION), 'utf8'));
    const base = await run('unmodified', { MU7_MUTATION: '', MU7_DROP_CONSTRAINT: '' });
    const problem = checkBaseline(base.out);
    if (problem) throw new Error(`${problem} ${base.err}`);
    const jobs = [
      ...guards.map((g) => ({
        label: g,
        kind: 'guard',
        target: g,
        env: { MU7_MUTATION: g, MU7_DROP_CONSTRAINT: '' },
      })),
      ...constraints.map((c) => ({
        label: c.replace(':', '__'),
        kind: 'constraint',
        target: c,
        env: { MU7_MUTATION: '', MU7_DROP_CONSTRAINT: c },
      })),
    ];
    const tagged = new Set(base.out.results.map((r) => r.tag).filter(Boolean));
    const runs = await pool(jobs.filter((j) => tagged.has(j.target)));
    const rows = verdicts(base.out, jobs, Object.fromEntries(runs.map((r) => [r.label, r])));
    const summary = summarize(base.out, guards, constraints, rows);
    writeFileSync(
      join(outDir, 'mutation_results_v7.json'),
      JSON.stringify({ summary, rows }, null, 1),
    );
    const cols = [
      'kind',
      'target',
      'tagged_steps',
      'failed_tagged_steps',
      'verdict',
      'collateral_failures',
      'note',
    ];
    writeFileSync(
      join(outDir, 'mutation_results_v7.csv'),
      [
        cols.join(','),
        ...rows.map((r) => cols.map((c) => `"${String(r[c]).replace(/"/g, '""')}"`).join(',')),
      ].join('\n') + '\n',
    );
    console.log(
      `v7 mutation harness on the app chain: ${JSON.stringify(summary)} (results in ${outDir})`,
    );
    for (const r of rows.filter((x) => x.verdict !== 'KILLED'))
      console.log(r.verdict, r.target, r.note);
    if (!clean(summary)) process.exitCode = 1;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

// Started without top-level await so the pure functions above can be imported by the unit tests.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
