// =============================================================================
// rls_tests_v7.mjs : pre-build schema, row-level security and behaviour tests for migration NNNN_v7_mapping_units.sql
// (review design v7, the mapping-unit design), on top of the unchanged reference stack of the v6 handoff
// (auth_shim.sql, schema.sql, 0002 to 0006).
//
// Databases (all in memory, all synthetic):
//   base  the reference stack WITHOUT NNNN: the additive checks compare every earlier function, constraint, view,
//         trigger and grant against it (NNNN must leave all of them unchanged).
//   db1   design v7 with overlap ALLOW, end to end: design record, exclusion of the earlier designs, packet guards,
//         vocabulary contract, the synthetic pilot (SYNTHETIC_PILOT_UNITS_v7.json, planted answers, every routing case),
//         adjudication, pilot lock, export 7.0, sign-off, formal enrolment, FORMAL fixture units (NCT99 placeholder
//         identifiers, never real records), gate approval, freeze, queue, formal phase, no interim look, close,
//         snapshot, adjudication, lock, export, immutability, audit.
//   db2   design v7 with overlap ONE_PER_TRIAL and the ordering gates that db1 passes in order.
//   db3   an earlier design exists (a v5 activation seeded with triggers off): design v7 cannot be recorded.
// Every guard of NNNN raises a message that starts with its tag (MU7-Gnn:); each guard's tests expect that tag. Each
// named constraint's tests expect the constraint name. Steps carry the tag in `tag`, and mutation_harness_v7.mjs uses
// it: with MU7_MUTATION=MU7-Gnn the suite removes that guard block from NNNN before loading it; with
// MU7_DROP_CONSTRAINT=table:constraint it drops that constraint after loading. The tagged steps must then fail.
//
// Runs on PGlite (PostgreSQL 17 in WebAssembly). It is NOT Supabase and NOT live PostgreSQL 16; those tests remain
// REQUIRED before any formal reviewer is invited.
// Usage: node rls_tests_v7.mjs <auth_shim.sql> <schema.sql> <0002> <0003> <0004> <0005> <0006> <NNNN> \
//          <SYNTHETIC_PILOT_UNITS_v7.json> <VOCABULARY_CONTRACT_v7.json> <results.json> <steps.sql> [<bundle_dir>]
// =============================================================================
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const A = process.argv.slice(2);
if (A.length < 12) { console.error('usage: see header'); process.exit(2); }
const [shimPath, schemaPath, m2, m3, m4, m5, m6, mNNNN, pilotPath, vocabPath, outPath, sqlOutPath, bundleDir] = A;
for (const f of [outPath, sqlOutPath]) if (fs.existsSync(f)) { console.error(`refusing to overwrite ${f}`); process.exit(2); }
if (bundleDir && fs.existsSync(bundleDir)) { console.error(`refusing to overwrite ${bundleDir}`); process.exit(2); }
const MUTATION = process.env.MU7_MUTATION || '';
const DROP = process.env.MU7_DROP_CONSTRAINT || '';
const PILOT = JSON.parse(fs.readFileSync(pilotPath, 'utf8'));
const VOC = JSON.parse(fs.readFileSync(vocabPath, 'utf8'));

// ---- the migration under test (optionally with one guard block removed) -------------------------------------------
let NNNN = fs.readFileSync(mNNNN, 'utf8');
if (MUTATION) {
  const lines = NNNN.split('\n');
  const out = [];
  let inside = false, removed = 0;
  for (const l of lines) {
    if (l.includes(`-- GUARD ${MUTATION} BEGIN`)) { inside = true; removed += 1; out.push(l); continue; }
    if (l.includes(`-- GUARD ${MUTATION} END`)) { inside = false; out.push(l); continue; }
    if (!inside) out.push(l);
  }
  if (removed === 0) { console.error(`no guard block ${MUTATION}`); process.exit(3); }
  NNNN = out.join('\n');
}
const BASE = [shimPath, schemaPath, m2, m3, m4, m5, m6];
async function newDb(withNNNN = true) {
  const d = await PGlite.create({ extensions: { pgcrypto } });
  for (const f of BASE) await d.exec(fs.readFileSync(f, 'utf8'));
  if (withNNNN) {
    await d.exec(NNNN);
    if (DROP) { const [t, c] = DROP.split(':'); await d.exec(`alter table public.${t} drop constraint ${c};`); }
  }
  return d;
}

// ---- identities (synthetic) ---------------------------------------------------------------------------------------
const P = {
  inv:  { sub: '00000000-0000-4000-8000-0000000000a1', email: 'investigator@example.test', aal: 'aal2' },
  inv1: { sub: '00000000-0000-4000-8000-0000000000a1', email: 'investigator@example.test', aal: 'aal1' },
  pt1:  { sub: '00000000-0000-4000-8000-0000000000b1', email: 'pilot1@example.test', aal: 'aal1' },
  pt2:  { sub: '00000000-0000-4000-8000-0000000000b2', email: 'pilot2@example.test', aal: 'aal1' },
  r1:   { sub: '00000000-0000-4000-8000-0000000000c1', email: 'reviewer1@example.test', aal: 'aal1' },
  r2:   { sub: '00000000-0000-4000-8000-0000000000c2', email: 'reviewer2@example.test', aal: 'aal1' },
  adj:  { sub: '00000000-0000-4000-8000-0000000000e1', email: 'adjudicator@example.test', aal: 'aal1' },
  out:  { sub: '00000000-0000-4000-8000-0000000000d1', email: 'outsider@example.test', aal: 'aal1' },
};
const ATT = 'Synthetic attestation for testing only.';
const results = [];
const sqlLog = [];
let db, dbLabel;

async function asWho(who) {
  await db.exec('reset role;');
  if (who === 'owner') return;
  if (who === 'anon') { await db.query("select set_config('request.jwt.claims', '', false)"); await db.exec('set role anon;'); return; }
  await db.query("select set_config('request.jwt.claims', $1, false)", [JSON.stringify(P[who])]);
  await db.exec('set role authenticated;');
}
const show = (e) => JSON.stringify(e, (k, v) => (v instanceof RegExp ? v.source : v));
// expect: {rows: n} | {minRows: n} | {error: regex} | {ok: true} | {value: v}
async function step(id, area, desc, who, sql, expect, params = [], tag = '') {
  const s = typeof sql === 'function' ? sql() : sql;
  sqlLog.push(`-- ${id} [${area}] (${dbLabel}) as ${who}${tag ? ' tag ' + tag : ''}: ${desc}\n-- expect: ${show(expect)}\n${s};\n`);
  let actual, pass, rows = null;
  try {
    await asWho(who);
    const r = await db.query(s, params);
    rows = r.rows;
    if (expect.error) { pass = false; actual = `no error; ${rows.length} rows`; }
    else if (expect.rows !== undefined) { pass = rows.length === expect.rows; actual = `${rows.length} rows`; }
    else if (expect.minRows !== undefined) { pass = rows.length >= expect.minRows; actual = `${rows.length} rows`; }
    else if (expect.value !== undefined) {
      const v = rows.length ? Object.values(rows[0])[0] : undefined;
      pass = JSON.stringify(v) === JSON.stringify(expect.value); actual = `value ${JSON.stringify(v)}`;
    } else { pass = true; actual = `ok; ${rows.length} rows`; }
  } catch (e) {
    if (expect.error) { pass = expect.error.test(e.message); actual = `error: ${e.message}`; }
    else { pass = false; actual = `error: ${e.message}`; }
  }
  await db.exec('reset role;');
  results.push({ id, area, desc, who, db: dbLabel, tag, expect: show(expect), actual: String(actual).slice(0, 400), pass });
  return rows;
}
const q = async (sql, params = []) => { await db.exec('reset role;'); return (await db.query(sql, params)).rows; };
const q1 = async (sql, params = []) => { const r = await q(sql, params); return r.length ? Object.values(r[0])[0] : null; };
const sha256 = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
const J = (o) => JSON.stringify(o);
const lit = (o) => `'${J(o).replace(/'/g, "''")}'::jsonb`;
const clone = (o) => JSON.parse(J(o));
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const G = (n) => new RegExp(`MU7-G${n}:`);
const CK = (name) => new RegExp(name);
const replica = (sql) => `do $do$ begin perform set_config('session_replication_role', 'replica', true); ${sql}; end $do$`;

async function setupAccounts() {
  for (const k of Object.keys(P)) await db.query('insert into auth.users (id, email) values ($1, $2) on conflict do nothing', [P[k].sub, P[k].email]);
  await db.query("insert into public.users (email, display_name, role) values ($1, 'Test Investigator', 'INVESTIGATOR')", [P.inv.email]);
}
const uid = async (k) => q1('select user_id from public.users where email=$1', [P[k].email]);
const pid = async (k) => q1('select r.reviewer_pseudo_id from public.reviewers r join public.users u using (user_id) where u.email=$1 and r.withdrawn_at is null', [P[k].email]);
const asg = async (pseudo, unit) => q1('select assignment_id from public.mu7_queue where reviewer_pseudo_id=$1 and unit_id=$2', [pseudo, unit]);
async function setupPeople(prefix) {
  await step(`${prefix}-S-AUTH`, 'setup', 'investigator claims the bootstrapped account', 'inv', 'select public.rpc_claim_account() as uid', { minRows: 1 });
  for (const [k, pilot] of [['pt1', true], ['pt2', true], ['r1', false], ['r2', false]]) {
    await step(`${prefix}-S-USER-${k}`, 'setup', `investigator registers ${k}`, 'inv', `select public.rpc_register_user('${P[k].email}', 'Synthetic ${k}', 'REVIEWER', ${pilot})`, { minRows: 1 });
  }
  await step(`${prefix}-S-USER-adj`, 'setup', 'investigator registers the adjudicator', 'inv', `select public.rpc_register_user('${P.adj.email}', 'Synthetic adjudicator', 'ADJUDICATOR', false)`, { minRows: 1 });
  for (const k of ['pt1', 'pt2', 'r1', 'r2', 'adj']) await step(`${prefix}-S-CLAIM-${k}`, 'setup', `${k} claims the account`, k, 'select public.rpc_claim_account()', { minRows: 1 });
  for (const k of ['pt1', 'pt2']) {
    await step(`${prefix}-S-ENROLL-${k}`, 'setup', `enrol ${k} as a PILOT reviewer (v2 path, unchanged)`, 'inv', `select public.rpc_enroll_reviewer('${await uid(k)}', 'PILOT', 'synthetic pilot account')`, { minRows: 1 });
  }
}

// ---- synthetic FORMAL fixture (NCT99 placeholder identifiers: the NCT99 prefix is never a real record) ------------
const SET = 'SYN7-ASSIGN-TESTFX-01';
const DESIGN_VERSION = 'SYN-7-TESTFX';
const FX = [
  { uid: 'MU7-AREA-ONCOLOGY-001', fam: 'AREA', cat: 'ONCOLOGY', code: 'IN_AREA', nct: 'NCT99000101', N: 80, n: 1 },
  { uid: 'MU7-AREA-MENTAL_HEALTH-001', fam: 'AREA', cat: 'MENTAL_HEALTH', code: 'IN_AREA', nct: 'NCT99000102', N: 40, n: 1, note: true },
  { uid: 'MU7-AREA-RESPIRATORY-001', fam: 'AREA', cat: 'RESPIRATORY', code: 'IN_AREA', nct: 'NCT99000103', N: 30, n: 1 },
  { uid: 'MU7-ROW-CAN_ALL-001', fam: 'ROW', cat: 'CAN_ALL', code: 'IN_ROW', nct: 'NCT99000101', N: 60, n: 1 },
  { uid: 'MU7-ROW-DIAB-001', fam: 'ROW', cat: 'DIAB', code: 'IN_ROW', nct: 'NCT99000104', N: 20, n: 1 },
  { uid: 'MU7-ROW-PAIN-001', fam: 'ROW', cat: 'PAIN', code: 'IN_ROW', nct: 'NCT99000105', N: 16, n: 1, gate: 'G-PAIN-01' },
  { uid: 'MU7-SG-RULE_D_REMOVED-001', fam: 'SG', cat: 'RULE_D_REMOVED', code: 'D2_REMOVE_OTHER_TYPE', nct: 'NCT99000106', N: 10, n: 1 },
  { uid: 'MU7-SG-RULE_K_KEPT-001', fam: 'SG', cat: 'RULE_K_KEPT', code: 'K_KEEP_MALIGNANT_COMPATIBLE', nct: 'NCT99000107', N: 50, n: 1 },
];
const F = Object.fromEntries(FX.map((x, i) => [`F${i + 1}`, x]));
const mappingCode = (fam, cat) => (fam === 'AREA' ? `AREA_${cat}` : fam === 'ROW' ? `FIG2_ROW_${cat}` : cat.startsWith('RULE_D') ? 'RULE_D' : 'RULE_K');
const parentRow = (fam, cat) => (fam !== 'SG' ? null : cat.startsWith('RULE_D') ? 'FIG2_ROW_DIAB' : 'FIG2_ROW_CAN_ALL');
const displayKey = (fam, code) => (fam === 'SG' ? `SG|${code}` : `${fam}|${code}`);
function unitBlock(x, mode = 'FORMAL') {
  const u = { unit_id: x.uid, mode, family: x.fam, category: x.cat, unit_role: x.fam === 'SG' ? 'SUBGROUP' : 'PRIMARY',
              mapping_code: mappingCode(x.fam, x.cat), mapping_label: VOC.mapping_labels[`${x.fam}|${x.cat}`],
              assignment_code: x.code, assignment_status: x.status ?? 'ASSIGNED',
              display_text: VOC.display_texts[displayKey(x.fam, x.code)] ?? 'in this area' };
  if (x.fam === 'SG') {
    const pr = parentRow(x.fam, x.cat);
    Object.assign(u, { display_decision: VOC.display_decisions[x.cat], parent_row_code: pr, parent_row_label: VOC.row_labels[pr.replace('FIG2_ROW_', '')] });
  }
  if (x.note) u.display_note = VOC.mental_health_note;
  return u;
}
function trialBlock(nct, n, extra = {}) {
  const t = Object.assign({ nct_id: nct }, /^NCT[0-9]{8}$/.test(nct) ? { registry_url: `https://clinicaltrials.gov/study/${nct}` } : {}, {
    brief_title: `Synthetic trial ${n} of a fictional therapy`, official_title: `A synthetic study ${n} for application testing only`,
    conditions_registered: ['Synthetic condition A'], condition_mesh_headings: ['Synthetic heading A'],
    brief_summary: 'SYNTHETIC TEXT FOR APP TESTING ONLY.',
    interventions: [{ intervention_type: 'DRUG', name: 'Synthetic drug', description: 'fictional' }],
    eligibility_age_range: { minimum_age: '18 Years', maximum_age: 'N/A' } }, extra);
  return t;
}
const packet = (x, mode = 'FORMAL', trialExtra = {}, top = {}) => Object.assign({ schema_version: '7.0', unit: unitBlock(x, mode), trial: trialBlock(x.nct, 1, trialExtra), notices: mode === 'PILOT' ? ['SYNTHETIC UNIT: excluded from every statistic'] : [] }, top);
const prn = (x) => sha256(`1|${x.fam}-${x.cat}|${x.nct}`);
const designRow = (x, o = {}) => Object.assign({ nct_id: x.nct, frame_id: 'SYN_FRAME', stratum: `${x.fam}-${x.cat}`, frame_stratum_size: x.N,
  n_sampled_in_stratum: x.n, selection_probability: x.n / x.N, sampling_seed: 1, prn_key: prn(x), allocation_option: 'A',
  overlap_setting: o.overlap ?? 'ALLOW', design_version: DESIGN_VERSION, freeze_status: x.gate ? 'BLOCKED_PENDING_GATE' : 'READY',
  freeze_gate: x.gate ?? null }, o.d ?? {});
const asgText = (x) => [SET, x.uid, mappingCode(x.fam, x.cat), x.code, 'ASSIGNED'].join('|');
const asgRow = (x) => ({ assignment_set_id: SET, mapping_code: mappingCode(x.fam, x.cat), assignment_code: x.code, assignment_status: 'ASSIGNED', row_sha256: sha256(asgText(x)) });
const designText = (x, d) => [x.uid, d.nct_id, d.frame_id, d.stratum, String(d.frame_stratum_size), String(d.n_sampled_in_stratum), d.allocation_option,
  d.overlap_setting, String(d.sampling_seed), d.prn_key].join('|');
function importObj(x, o = {}) {
  const m = o.mode ?? 'FORMAL';
  const obj = { unit_id: x.uid, mode: m, record_category: m === 'PILOT' ? 'SYNTHETIC_PILOT' : 'MAPPING_UNIT_FORMAL', family: x.fam, category: x.cat,
                unit_role: x.fam === 'SG' ? 'SUBGROUP' : 'PRIMARY', mapping_code: mappingCode(x.fam, x.cat), assignment_code: x.code,
                assignment_status: x.status ?? 'ASSIGNED', parent_row_code: parentRow(x.fam, x.cat), packet: o.packet ?? packet(x, m),
                design: designRow(x, o) };
  if (m === 'FORMAL') obj.assignment = o.assignment ?? asgRow(x);
  return Object.assign(obj, o.top ?? {});
}
const imp = (o) => `select public.rpc_mu7_import_unit(${lit(o)}) as u`;
const recordDesign = (o = {}) => `select public.rpc_mu7_record_design(${lit(Object.assign({ design_version: DESIGN_VERSION, assignment_set_id: SET,
  overlap_setting: 'ALLOW', n_primary_planned: 6, n_subgroup_planned: 2, attestation: ATT }, o))}) as d`;
const hashes = (units, queue) => ({
  unit_list_sha256: sha256(units.map((x) => x.uid).sort(cmp).join('\n')),
  assignment_set_sha256: sha256([...units].sort((a, b) => cmp(a.uid, b.uid)).map((x) => sha256(asgText(x))).join('\n')),
  design_rows_sha256: sha256([...units].sort((a, b) => cmp(a.uid, b.uid)).map((x) => sha256(designText(x, designRow(x)))).join('\n')),
  queue_sha256: sha256(queue.flatMap(([slot, ids]) => ids.map((u, i) => `${slot}|${i + 1}|${u}`)).join('\n')),
});
const submit = async (who, pseudo, unit, a) => `select public.rpc_mu7_submit('${await asg(pseudo, unit)}', ${lit(a)}) as j`;
const adjud = (o) => `select public.rpc_mu7_record_adjudication(${lit(o)}) as a`;
const phase = (t, o = {}) => `select public.rpc_mu7_phase('${t}', ${lit(Object.assign({ attestation: ATT }, o))}) as e`;

// =============================================================================
// base: the reference stack without NNNN (catalogue fingerprint for the additive checks)
// =============================================================================
const FP = {
  functions: `select p.oid::regprocedure::text as k, md5(pg_get_functiondef(p.oid)) as v from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname in ('public', 'private', 'auth') and p.prokind = 'f'`,
  constraints: `select conrelid::regclass::text || '.' || conname as k, md5(pg_get_constraintdef(oid)) as v from pg_constraint
                where connamespace in ('public'::regnamespace, 'private'::regnamespace)`,
  views: `select schemaname || '.' || viewname as k, md5(definition) as v from pg_views where schemaname = 'public'`,
  triggers: `select tgrelid::regclass::text || '.' || tgname as k, md5(pg_get_triggerdef(oid)) as v from pg_trigger where not tgisinternal`,
  grants: `select p.oid::regprocedure::text as k, coalesce(p.proacl::text, '') as v from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname in ('public', 'private') and p.prokind = 'f'`,
  tablegrants: `select c.oid::regclass::text as k, coalesce(c.relacl::text, '') || '|' || c.relrowsecurity::text as v from pg_class c
                join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind in ('r', 'v')`,
};
db = await newDb(false); dbLabel = 'base';
const baseFP = {};
for (const [k, s] of Object.entries(FP)) baseFP[k] = Object.fromEntries((await q(s)).map((r) => [r.k, r.v]));
await db.close();

// =============================================================================
// db1: design v7, overlap ALLOW, end to end
// =============================================================================
db = await newDb(); const db1 = db; dbLabel = 'db1';
await setupAccounts();
await setupPeople('MU7');
const PT1 = await pid('pt1'), PT2 = await pid('pt2');

// ---- S. Schema and the additive rule --------------------------------------------------------------------------------
await step('MU7-SCHEMA-01', 'schema', 'schema versions 1.0.0 to 6.0.0 and 7.0.0 are recorded', 'owner',
  "select string_agg(version, ',' order by version) as v from public.app_schema_version", { value: '1.0.0,3.0.0,4.0.0,5.0.0,5.1.0,6.0.0,7.0.0' });
await step('MU7-SCHEMA-02', 'schema', 'no v7 design is recorded by the migration alone', 'owner', 'select count(*)::int as n from public.mu7_design', { value: 0 });
const MU7_TABLES = ['mu7_design', 'mu7_phase_events', 'mu7_units', 'mu7_unit_design', 'mu7_frozen_assignments', 'mu7_gate_approvals', 'mu7_freeze',
  'mu7_queue', 'mu7_judgments', 'mu7_snapshot', 'mu7_adjudications', 'mu7_reference_locks', 'mu7_exports', 'mu7_training_units', 'mu7_training_acknowledgments'];
const tl = MU7_TABLES.map((t) => `'${t}'`).join(',');
await step('MU7-SCHEMA-03', 'schema', 'all 15 v7 tables have row-level security on', 'owner',
  `select count(*)::int as n from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relname in (${tl}) and c.relrowsecurity`, { value: 15 });
await step('MU7-SCHEMA-04', 'grants', 'authenticated holds no INSERT, UPDATE, DELETE or TRUNCATE privilege on any v7 table', 'owner',
  `select count(*)::int as n from information_schema.role_table_grants where grantee = 'authenticated' and table_name in (${tl}) and privilege_type <> 'SELECT'`, { value: 0 });
await step('MU7-SCHEMA-05', 'grants', 'anon holds no privilege on any v7 table or view', 'owner',
  "select count(*)::int as n from information_schema.role_table_grants where grantee = 'anon' and table_name like '%mu7%'", { value: 0 });
await step('MU7-SCHEMA-06', 'grants', 'authenticated may execute exactly four private v7 helpers (booleans about the caller, the unit role, the routing class)', 'owner',
  `select string_agg(p.proname, ',' order by p.proname) as v from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'private' and (p.proname like '%mu7%') and has_function_privilege('authenticated', p.oid, 'EXECUTE')`,
  { value: 'mu7_can_read_judgments,mu7_reviewer_can_read_unit,mu7_routing,mu7_unit_role' });
await step('MU7-SCHEMA-07', 'blinding', 'a reviewer cannot call the progress helper (it would reveal the other reviewer)', 'pt1', `select private.mu7_primary_done('${PT2}', 'PILOT')`, { error: /permission denied/ });
await step('MU7-SCHEMA-08', 'blinding', 'a reviewer cannot call the answer helper', 'pt1', "select private.mu7_effective_answer('SYN7-AREA-ONCOLOGY-001', 2)", { error: /permission denied/ });
await step('MU7-SCHEMA-09', 'grants', 'every v7 RPC is SECURITY DEFINER with an empty search_path', 'owner',
  `select count(*)::int as n from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname like 'rpc_mu7_%'
   and not (p.prosecdef and array_to_string(p.proconfig, ',') = 'search_path=""')`, { value: 0 });
await step('MU7-SCHEMA-10', 'schema', 'the six v7 views are security_invoker', 'owner',
  "select count(*)::int as n from pg_class c where c.relname like 'v_mu7_%' and c.relkind = 'v' and 'security_invoker=true' = any (c.reloptions)", { value: 6 });
await step('MU7-SCHEMA-11', 'immutability', 'each v7 table has its append-only, no-truncate and audit triggers (45)', 'owner',
  `select count(*)::int as n from pg_trigger t join pg_class c on c.oid = t.tgrelid where c.relname in (${tl}) and not t.tgisinternal
   and (t.tgname like '%_append_only' or t.tgname like '%_no_truncate' or t.tgname like '%_audit')`, { value: 45 });
const cmpFP = async (k) => {
  const now = Object.fromEntries((await q(FP[k])).map((r) => [r.k, r.v]));
  const changed = Object.keys(baseFP[k]).filter((x) => now[x] !== baseFP[k][x]);
  const added = Object.keys(now).filter((x) => !(x in baseFP[k]));
  return { changed, added };
};
for (const [id, k, desc] of [['MU7-ADD-01', 'functions', 'every function of schema.sql and 0002 to 0006 keeps its exact definition'],
                             ['MU7-ADD-02', 'constraints', 'every earlier constraint keeps its exact definition'],
                             ['MU7-ADD-03', 'views', 'every earlier view keeps its exact definition'],
                             ['MU7-ADD-04', 'triggers', 'every earlier trigger keeps its exact definition'],
                             ['MU7-ADD-05', 'grants', 'every earlier function keeps its exact grants'],
                             ['MU7-ADD-06', 'tablegrants', 'every earlier table and view keeps its grants and row-level security setting']]) {
  const r = await cmpFP(k);
  await step(id, 'additive', desc, 'owner', `select ${r.changed.length}::int as n`, { value: 0 });
  if (r.changed.length) results[results.length - 1].actual += ` changed: ${r.changed.slice(0, 5).join(' ')}`;
}
const trg = await cmpFP('triggers');
await step('MU7-ADD-07', 'additive', 'the only new triggers on earlier tables are the four refusing a00_mu7_old_design_guard triggers', 'owner',
  'select $1::text as v', { value: 'cases.a00_mu7_old_design_guard,design_activation_v4.a00_mu7_old_design_guard,tlv5_activation.a00_mu7_old_design_guard,tlv5_cases.a00_mu7_old_design_guard' },
  [trg.added.filter((x) => !x.startsWith('mu7_') && !x.includes('.mu7_')).sort().join(',')]);
await step('MU7-ADD-08', 'additive', 'FINDING-V6-01 helpers keep their 0006 definitions (private.tlv5_item_answers, private.tlv5_n_reviewed)', 'owner',
  `select (md5(pg_get_functiondef('private.tlv5_item_answers(text,text)'::regprocedure)) = '${baseFP.functions['private.tlv5_item_answers(text,text)']}'
      and md5(pg_get_functiondef('private.tlv5_n_reviewed(text)'::regprocedure)) = '${baseFP.functions['private.tlv5_n_reviewed(text)']}')::text as v`, { value: 'true' });

// ---- V. Vocabulary contract: the SQL texts and reason lists equal the review_design_v7 constants --------------------
const fc = Object.keys(VOC.mapping_labels).map((k) => k.split('|'));
let mism = 0;
for (const [fam, cat] of fc) if ((await q1('select private.mu7_mapping_label($1, $2)', [fam, cat])) !== VOC.mapping_labels[`${fam}|${cat}`]) mism += 1;
await step('MU7-VOC-01', 'vocabulary', `the 21 mapping labels equal the design constants (${fc.length} checked)`, 'owner', `select ${mism}::int as n`, { value: 0 });
mism = 0;
for (const [k, v] of Object.entries(VOC.display_texts)) { const [fam, code] = k.split('|'); if ((await q1('select private.mu7_display_text($1, $2)', [fam, code])) !== v) mism += 1; }
await step('MU7-VOC-02', 'vocabulary', 'every displayed assignment text equals the design constants', 'owner', `select ${mism}::int as n`, { value: 0 });
mism = 0;
for (const [k, v] of Object.entries(VOC.display_decisions)) if ((await q1('select private.mu7_display_decision($1)', [k])) !== v) mism += 1;
await step('MU7-VOC-03', 'vocabulary', 'the four KEEP and REMOVE decision texts equal the design constants', 'owner', `select ${mism}::int as n`, { value: 0 });
await step('MU7-VOC-04', 'vocabulary', 'the Mental health note for D003863-only units equals the design constant', 'owner', 'select private.mu7_mh_note() as v', { value: VOC.mental_health_note });
mism = 0; let nPairs = 0;
for (const [k, list] of Object.entries(VOC.reasons)) {
  const [fam, code] = k.split('|');
  for (const rc of VOC.all_reason_codes) { nPairs += 1; if ((await q1('select private.mu7_reason_ok($1, $2, $3)', [fam, code, rc])) !== list.includes(rc)) mism += 1; }
}
await step('MU7-VOC-05', 'vocabulary', `reason codes: accepted exactly for the assignments the rubric lists (${nPairs} pairs)`, 'owner', `select ${mism}::int as n`, { value: 0 });
mism = 0;
for (const [r, lab] of Object.entries(VOC.row_labels)) if ((await q1('select private.mu7_row_label($1)', [r])) !== lab) mism += 1;
await step('MU7-VOC-06', 'vocabulary', 'the ten Figure 2 row labels equal the design constants', 'owner', `select ${mism}::int as n`, { value: 0 });

// ---- D. The design record --------------------------------------------------------------------------------------------
await step('MU7-UNIT-00', 'gate', 'a unit before the design record is refused', 'inv', imp(importObj(F.F1)), { error: G(10) }, [], 'MU7-G10');
await step('MU7-DES-01', 'roles', 'a reviewer cannot record the design', 'pt1', recordDesign(), { error: /investigator role/ });
await step('MU7-DES-02', 'roles', 'an investigator session without multi-factor cannot record it', 'inv1', recordDesign(), { error: /investigator role/ });
await step('MU7-DES-03', 'refusal', 'an unknown key in the design record is refused', 'inv', recordDesign({ planted: 1 }), { error: G('07') }, [], 'MU7-G07');
await step('MU7-DES-04', 'refusal', 'an unknown overlap setting is refused', 'inv', recordDesign({ overlap_setting: 'SOMETIMES' }), { error: CK('mu7_design_overlap_ck') }, [], 'mu7_design:mu7_design_overlap_ck');
await step('MU7-DES-05', 'refusal', 'a short attestation is refused', 'inv', recordDesign({ attestation: 'too short' }), { error: CK('mu7_design_attestation_ck') }, [], 'mu7_design:mu7_design_attestation_ck');
await step('MU7-DES-06', 'refusal', 'an assignment set ID outside the MU7-/SYN7-ASSIGN- format is refused', 'inv', recordDesign({ assignment_set_id: 'SET-1' }), { error: CK('mu7_design_assignment_set_ck') }, [], 'mu7_design:mu7_design_assignment_set_ck');
await step('MU7-DES-07', 'setup', 'the investigator records design v7 (overlap ALLOW, 6 primary and 2 subgroup FORMAL units)', 'inv', recordDesign(), { minRows: 1 });
await step('MU7-DES-08', 'refusal', 'the design is recorded once', 'inv', recordDesign(), { error: /duplicate key/ });
await step('MU7-DES-09', 'roles', 'a design row naming a non-investigator is refused even for the owner', 'owner',
  `insert into public.mu7_design (design_version, assignment_set_id, overlap_setting, n_primary_planned, n_subgroup_planned, attestation, recorded_by)
   values ('X-7', '${SET}', 'ALLOW', 1, 0, '${ATT}', '${await uid('pt1')}')`, { error: G('01') }, [], 'MU7-G01');
await step('MU7-DES-10', 'immutability', 'the design record cannot be changed (owner role)', 'owner', "update public.mu7_design set overlap_setting = 'ONE_PER_TRIAL'", { error: /append-only/ });
await step('MU7-DES-11', 'visibility', 'a reviewer reads the design record (design version and overlap setting)', 'pt1', 'select overlap_setting from public.mu7_design', { value: 'ALLOW' });
await step('MU7-DES-12', 'blinding', 'an authenticated outsider reads no design record', 'out', 'select * from public.mu7_design', { rows: 0 });
await step('MU7-DES-13', 'blinding', 'anon cannot read the design record', 'anon', 'select * from public.mu7_design', { error: /permission denied/ });

// ---- X. Exclusion of the earlier designs once v7 is recorded -----------------------------------------------------------
const invId = await uid('inv');
await step('MU7-X-01', 'exclusion', 'a new v5/v6 FORMAL case is refused', 'owner',
  `insert into public.tlv5_cases (case_id, mode, record_category, packet, packet_sha256, created_by) values ('TLV5-TESTFX-01', 'FORMAL', 'LABEL_VERIFICATION_FORMAL', '{}', '${'0'.repeat(64)}', '${invId}')`,
  { error: G('04') }, [], 'MU7-G04');
await step('MU7-X-02', 'exclusion', 'a new v5/v6 TRAINING case is refused', 'owner',
  `insert into public.tlv5_cases (case_id, mode, record_category, packet, packet_sha256, created_by) values ('EX6-09', 'TRAINING', 'TRAINING_EXAMPLE', '{}', '${'0'.repeat(64)}', '${invId}')`,
  { error: G('04') }, [], 'MU7-G04');
await step('MU7-X-03', 'exclusion', 'activating design v5 is refused', 'owner',
  `insert into public.tlv5_activation (design_version, adjudication_scope, attestation, activated_by) values ('SYN-5', 'DISAGREEMENTS_ONLY', '${ATT}', '${invId}')`,
  { error: G('05') }, [], 'MU7-G05');
await step('MU7-X-04', 'exclusion', 'activating design v4 is refused', 'owner',
  `insert into public.design_activation_v4 (design_version, adjudication_scope, attestation, activated_by) values ('SYN-4', 'DISAGREEMENTS_ONLY', '${ATT}', '${invId}')`,
  { error: G('05') }, [], 'MU7-G05');
await step('MU7-X-05', 'exclusion', 'a new FORMAL case of the v2/v3 path is refused', 'owner',
  `insert into public.cases (case_id, mode, unit_type, created_by) values ('TESTFX-V2-01', 'FORMAL', 'TRIAL_AREA', '${invId}')`,
  { error: G('06') }, [], 'MU7-G06');

// ---- K. Packet guards (called directly on synthetic packets; nothing is imported) ------------------------------------
const pg = (x, m = 'FORMAL') => `select private.assert_mu7_packet($1::jsonb, '${x.uid}', '${m}', '${x.fam}', '${x.cat}', '${x.fam === 'SG' ? 'SUBGROUP' : 'PRIMARY'}', '${mappingCode(x.fam, x.cat)}', '${x.code}', 'ASSIGNED', ${parentRow(x.fam, x.cat) ? `'${parentRow(x.fam, x.cat)}'` : 'null'}) as v`;
const okP = (id, desc, x, pk, m = 'FORMAL', tag = '') => step(id, 'packet', desc, 'owner', pg(x, m), { value: pk.trial.nct_id }, [J(pk)], tag);
const badP = (id, desc, x, pk, rx, tag, m = 'FORMAL') => step(id, 'packet', desc, 'owner', pg(x, m), { error: rx }, [J(pk)], tag);
const mut = (pk, f) => { const p = clone(pk); f(p); return p; };
const P1 = packet(F.F1), P2 = packet(F.F2), P7 = packet(F.F7);
const SX = { uid: 'SYN7-AREA-ONCOLOGY-001', fam: 'AREA', cat: 'ONCOLOGY', code: 'IN_AREA', nct: 'SYN-NCT-9101' };
const PS = packet(SX, 'PILOT');
await okP('MU7-PK-01', 'a FORMAL packet with the allowed keys passes', F.F1, P1);
await okP('MU7-PK-R2a', 'relaxed R2: a FORMAL packet carries the NCT ID and the link to its own registry record', F.F1, P1);
await badP('MU7-PK-02', 'a top-level labels block (the v6 design) is refused', F.F1, mut(P1, (p) => { p.labels = {}; }), G(14), 'MU7-G14');
await badP('MU7-PK-03', 'schema_version 6.0 is refused', F.F1, mut(P1, (p) => { p.schema_version = '6.0'; }), G(14), 'MU7-G14');
await badP('MU7-PK-04', 'a curated label key in the unit block is refused', F.F1, mut(P1, (p) => { p.unit.curated_label = 'YES'; }), G(14), 'MU7-G14');
await badP('MU7-PK-05', 'an AI output key in the trial block is refused', F.F1, mut(P1, (p) => { p.trial.stage_c_label = 'YES'; }), G(15), 'MU7-G15');
await badP('MU7-PK-06', 'an extra key inside an intervention is refused', F.F1, mut(P1, (p) => { p.trial.interventions[0].ai_class = 'x'; }), G(15), 'MU7-G15');
await badP('MU7-PK-07', 'a packet without a trial block is refused', F.F1, mut(P1, (p) => { delete p.trial; }), G(15), 'MU7-G15');
await badP('MU7-PK-08', 'a FORMAL packet without its registry link is refused', F.F1, mut(P1, (p) => { delete p.trial.registry_url; }), G(16), 'MU7-G16');
await badP('MU7-PK-09', 'a FORMAL packet linking another record is refused', F.F1, mut(P1, (p) => { p.trial.registry_url = 'https://clinicaltrials.gov/study/NCT99000999'; }), G(16), 'MU7-G16');
await badP('MU7-PK-10', 'a FORMAL packet with a synthetic identifier is refused', F.F1, mut(P1, (p) => { p.trial.nct_id = 'SYN-NCT-0001'; delete p.trial.registry_url; }), G(16), 'MU7-G16');
await badP('MU7-PK-R2b', 'a PILOT packet with a registry link is refused', SX, mut(PS, (p) => { p.trial.registry_url = 'https://clinicaltrials.gov/study/SYN-NCT-9101'; }), G(16), 'MU7-G16', 'PILOT');
await badP('MU7-PK-11', 'a unit block whose assignment differs from the unit row is refused', F.F1, mut(P1, (p) => { p.unit.assignment_code = 'NOT_IN_AREA'; }), G(17), 'MU7-G17');
await badP('MU7-PK-12', 'a unit block naming another unit is refused', F.F1, mut(P1, (p) => { p.unit.unit_id = 'MU7-AREA-ONCOLOGY-002'; }), G(17), 'MU7-G17');
await badP('MU7-PK-13', 'an edited mapping label is refused', F.F1, mut(P1, (p) => { p.unit.mapping_label = 'Therapeutic area: Oncology'; }), G(18), 'MU7-G18');
await badP('MU7-PK-14', 'an edited assignment text is refused', F.F1, mut(P1, (p) => { p.unit.display_text = 'not in this area'; }), G(18), 'MU7-G18');
await badP('MU7-PK-15', 'a subgroup unit with an edited KEEP or REMOVE decision is refused', F.F7, mut(P7, (p) => { p.unit.display_decision = 'KEEP: kept in the Diabetes Mellitus row'; }), G(18), 'MU7-G18');
await badP('MU7-PK-16', 'a subgroup unit with another parent row label is refused', F.F7, mut(P7, (p) => { p.unit.parent_row_label = 'Neoplasms'; }), G(18), 'MU7-G18');
await badP('MU7-PK-17', 'an area unit carrying a display decision is refused', F.F1, mut(P1, (p) => { p.unit.display_decision = 'KEEP: kept'; }), G(18), 'MU7-G18');
await okP('MU7-PK-18', 'a Mental health unit with the canonical D003863 note passes', F.F2, P2);
await badP('MU7-PK-19', 'an edited Mental health note is refused', F.F2, mut(P2, (p) => { p.unit.display_note = 'Depression is a mental disorder.'; }), G(18), 'MU7-G18');
await badP('MU7-PK-20', 'the Mental health note on another area is refused', F.F1, mut(P1, (p) => { p.unit.display_note = VOC.mental_health_note; }), G(18), 'MU7-G18');
await badP('MU7-PK-21', 'a PILOT packet without the synthetic notice is refused', SX, mut(PS, (p) => { p.notices = []; }), G(19), 'MU7-G19', 'PILOT');
await badP('MU7-PK-22', 'a FORMAL packet with a notice is refused', F.F1, mut(P1, (p) => { p.notices = ['note']; }), G(19), 'MU7-G19');
await okP('MU7-PK-R1', 'relaxed R1: registry text naming another trial and ClinicalTrials.gov is accepted as registered', F.F1,
  mut(P1, (p) => { p.trial.brief_summary = 'Follow-on of NCT99000777; see clinicaltrials.gov for the earlier record.'; }));
await okP('MU7-PK-23', 'a registry detailed description passes', F.F1, mut(P1, (p) => { p.trial.detailed_description = 'SYNTHETIC DETAILED DESCRIPTION.'; }));
await okP('MU7-PK-24', 'a synthetic PILOT packet passes', SX, PS, 'PILOT');

// ---- T. Training units (read-only worked examples) ----------------------------------------------------------------------
const trainPacket = (id, nct, o = {}) => ({ schema_version: '7.0',
  unit: Object.assign({ unit_id: id, mode: 'TRAINING', family: 'AREA', category: 'METABOLIC', unit_role: 'PRIMARY', mapping_code: 'AREA_METABOLIC',
    mapping_label: VOC.mapping_labels['AREA|METABOLIC'], assignment_code: 'IN_AREA', assignment_status: 'ASSIGNED', display_text: 'in this area',
    mapping_basis: { heading: 'Synthetic heading', descriptor_ui: 'D000000', tree_numbers_in_area: ['C18.000'], area_root: 'C18' } }, o.unit ?? {}),
  trial: trialBlock(nct, 9, o.trial ?? {}),
  worked_example: { outcome_summary: 'both AGREE', teaching_point: 'synthetic', worked_answers: [{ reviewer_slot: 1, answer: 'AGREE', reason_code: null, note: 'x', uncertain: false }],
                    reference: { final_answer: 'AGREE', status: 'CONCORDANT_ADOPTED_BY_RULE', basis: 'BOTH_REVIEWERS', rationale: null } },
  notices: ['TRAINING EXAMPLE, READ ONLY'] });
const impT = (id, pk) => `select public.rpc_mu7_import_training_unit(${lit({ training_unit_id: id, packet: pk })}) as t`;
await step('MU7-TR-01', 'setup', 'a synthetic worked example is imported', 'inv', impT('EX7-01', trainPacket('EX7-01', 'SYN-NCT-9201')), { value: 'EX7-01' });
await step('MU7-TR-R3', 'training', 'relaxed R3: a worked example carries a registered-format NCT ID and its own registry link', 'inv', impT('EX7-02', trainPacket('EX7-02', 'NCT99000201')), { value: 'EX7-02' });
await step('MU7-TR-02', 'packet', 'a training packet with a labels block is refused', 'inv', impT('EX7-03', Object.assign(trainPacket('EX7-03', 'SYN-NCT-9203'), { labels: {} })), { error: G(40) }, [], 'MU7-G40');
await step('MU7-TR-03', 'packet', 'a training unit in FORMAL mode is refused', 'inv', impT('EX7-03', trainPacket('EX7-03', 'SYN-NCT-9203', { unit: { mode: 'FORMAL' } })), { error: G(40) }, [], 'MU7-G40');
await step('MU7-TR-04', 'packet', 'a training unit with an edited assignment text is refused', 'inv', impT('EX7-03', trainPacket('EX7-03', 'SYN-NCT-9203', { unit: { display_text: 'in this row' } })), { error: G(40) }, [], 'MU7-G40');
await step('MU7-TR-05', 'packet', 'a registered-format worked example without its registry link is refused', 'inv',
  impT('EX7-03', (() => { const p = trainPacket('EX7-03', 'NCT99000203'); delete p.trial.registry_url; return p; })()), { error: G(16) }, [], 'MU7-G16');
await step('MU7-TR-06', 'refusal', 'a training identifier outside EX7-nn is refused', 'inv', impT('EX6-03', trainPacket('EX6-03', 'SYN-NCT-9203')), { error: CK('mu7_training_id_ck') }, [], 'mu7_training_units:mu7_training_id_ck');
await step('MU7-TR-07', 'visibility', 'a pilot reviewer reads the two worked examples', 'pt1', 'select training_unit_id from public.mu7_training_units', { rows: 2 });
await step('MU7-TR-08', 'blinding', 'an outsider reads no worked example', 'out', 'select * from public.mu7_training_units', { rows: 0 });
await step('MU7-TR-09', 'training', 'no table records an answer to a worked example (only the training table and the optional acknowledgment exist)', 'owner',
  "select count(*)::int as n from information_schema.columns where table_schema = 'public' and table_name like 'mu7_%' and column_name = 'training_unit_id'", { value: 1 });
await step('MU7-TR-10', 'refusal', 'a FORMAL unit on a worked-example trial is refused', 'inv',
  imp(importObj({ uid: 'MU7-AREA-METABOLIC-001', fam: 'AREA', cat: 'METABOLIC', code: 'IN_AREA', nct: 'NCT99000201', N: 10, n: 1 })), { error: G(21) }, [], 'MU7-G21');
await step('MU7-TR-ACK-01', 'training', 'a pilot reviewer acknowledges the worked examples (an optional timestamp)', 'pt1', 'select public.rpc_mu7_acknowledge_training() is not null as v', { value: true });
await step('MU7-TR-ACK-02', 'training', 'a second acknowledgment keeps the first timestamp (one row)', 'pt1', "select (public.rpc_mu7_acknowledge_training() = (select acknowledged_at from public.mu7_training_acknowledgments)) as v", { value: true });
await step('MU7-TR-ACK-03', 'roles', 'a user who is not an enrolled reviewer cannot acknowledge', 'adj', 'select public.rpc_mu7_acknowledge_training()', { error: G(59) }, [], 'MU7-G59');
await step('MU7-TR-ACK-04', 'visibility', 'the investigator sees the acknowledgment; another reviewer does not', 'pt2', 'select * from public.mu7_training_acknowledgments', { rows: 0 });

// ---- P. The synthetic pilot (SYNTHETIC_PILOT_UNITS_v7.json) ----------------------------------------------------------------
const PU = PILOT.units;
for (const [i, u] of PU.entries()) await step(`MU7-PIL-IMP-${String(i + 1).padStart(2, '0')}`, 'setup', `import pilot unit ${u.import.unit_id}`, 'inv', imp(u.import), { value: u.import.unit_id });
const P0 = PU[0].import;
const pi = (f) => { const o = clone(P0); f(o); return o; };
const pilotX = (uidv, fam, cat, code) => ({ uid: uidv, fam, cat, code, nct: 'SYN-NCT-9190' });
await step('MU7-UNIT-01', 'refusal', 'an UNASSIGNED unit is refused (the review is assigned-only)', 'inv',
  imp(importObj(Object.assign(pilotX('SYN7-AREA-INFECTIOUS-001', 'AREA', 'INFECTIOUS', 'NOT_IN_AREA'), { status: 'UNASSIGNED' }), { mode: 'PILOT' })), { error: G(12) }, [], 'MU7-G12');
await step('MU7-UNIT-02', 'refusal', 'a unit ID that does not spell its family and category is refused', 'inv',
  imp(importObj(pilotX('SYN7-AREA-ONCOLOGY-009', 'AREA', 'INFECTIOUS', 'IN_AREA'), { mode: 'PILOT' })), { error: CK('mu7_units_id_ck') }, [], 'mu7_units:mu7_units_id_ck');
await step('MU7-UNIT-03', 'refusal', 'an unknown category is refused', 'owner',
  replica(`insert into public.mu7_units (unit_id, mode, record_category, family, category, unit_role, mapping_code, assignment_code, assignment_status, packet, packet_sha256, created_by)
           values ('SYN7-AREA-RENAL-001', 'PILOT', 'SYNTHETIC_PILOT', 'AREA', 'RENAL', 'PRIMARY', 'AREA_RENAL', 'IN_AREA', 'ASSIGNED', '{}', '${'0'.repeat(64)}', '${invId}')`),
  { error: CK('mu7_units_category_ck') }, [], 'mu7_units:mu7_units_category_ck');
const sgAsPrimary = pilotX('SYN7-SG-RULE_K_REMOVED-009', 'SG', 'RULE_K_REMOVED', 'K_REMOVE_VERIFIED_NONMALIGNANT');
await step('MU7-UNIT-03b', 'refusal', 'a record category that does not match the mode is refused by the table itself', 'owner',
  replica(`insert into public.mu7_units (unit_id, mode, record_category, family, category, unit_role, mapping_code, assignment_code, assignment_status, packet, packet_sha256, created_by)
           values ('SYN7-AREA-ONCOLOGY-776', 'PILOT', 'MAPPING_UNIT_FORMAL', 'AREA', 'ONCOLOGY', 'PRIMARY', 'AREA_ONCOLOGY', 'IN_AREA', 'ASSIGNED', '{}', '${'0'.repeat(64)}', '${invId}')`),
  { error: CK('mu7_units_record_category_ck') }, [], 'mu7_units:mu7_units_record_category_ck');
await step('MU7-UNIT-04', 'refusal', 'a subgroup unit imported as PRIMARY is refused', 'inv',
  imp(Object.assign(importObj(sgAsPrimary, { mode: 'PILOT', packet: mut(packet(sgAsPrimary, 'PILOT'), (p) => { p.unit.unit_role = 'PRIMARY'; }) }), { unit_role: 'PRIMARY' })),
  { error: CK('mu7_units_role_ck') }, [], 'mu7_units:mu7_units_role_ck');
const wrongMap = pilotX('SYN7-AREA-INFECTIOUS-009', 'AREA', 'INFECTIOUS', 'IN_AREA');
await step('MU7-UNIT-05', 'refusal', 'a mapping code that does not match the family and category is refused', 'inv',
  imp(Object.assign(importObj(wrongMap, { mode: 'PILOT', packet: mut(packet(wrongMap, 'PILOT'), (p) => { p.unit.mapping_code = 'AREA_ONCOLOGY'; }) }), { mapping_code: 'AREA_ONCOLOGY' })),
  { error: CK('mu7_units_mapping_ck') }, [], 'mu7_units:mu7_units_mapping_ck');
const wrongCode = pilotX('SYN7-SG-RULE_D_KEPT-009', 'SG', 'RULE_D_KEPT', 'D2_REMOVE_OTHER_TYPE');
await step('MU7-UNIT-06', 'refusal', 'a REMOVE outcome in a KEPT stratum is refused', 'inv', imp(importObj(wrongCode, { mode: 'PILOT' })), { error: CK('mu7_units_assignment_ck') }, [], 'mu7_units:mu7_units_assignment_ck');
const wrongParent = pilotX('SYN7-SG-RULE_D_KEPT-008', 'SG', 'RULE_D_KEPT', 'D1_KEEP_TYPE2');
await step('MU7-UNIT-07', 'refusal', 'a rule D unit restating the Neoplasms row is refused', 'inv',
  imp(Object.assign(importObj(wrongParent, { mode: 'PILOT', packet: mut(packet(wrongParent, 'PILOT'), (p) => { p.unit.parent_row_code = 'FIG2_ROW_CAN_ALL'; p.unit.parent_row_label = 'Neoplasms'; }) }), { parent_row_code: 'FIG2_ROW_CAN_ALL' })),
  { error: CK('mu7_units_parent_row_ck') }, [], 'mu7_units:mu7_units_parent_row_ck');
await step('MU7-UNIT-08', 'refusal', 'a record category that does not match the mode is refused', 'inv', imp(pi((o) => { o.unit_id = 'SYN7-AREA-ONCOLOGY-008'; o.packet.unit.unit_id = o.unit_id; o.record_category = 'MAPPING_UNIT_FORMAL'; })), { error: G(13) }, [], 'MU7-G13');
await step('MU7-UNIT-09', 'refusal', 'a unit without its design row is refused', 'inv', imp(pi((o) => { o.unit_id = 'SYN7-AREA-ONCOLOGY-008'; o.packet.unit.unit_id = o.unit_id; delete o.design; })), { error: G(13) }, [], 'MU7-G13');
await step('MU7-UNIT-10', 'refusal', 'a PILOT unit with a frozen assignment is refused', 'inv', imp(pi((o) => { o.unit_id = 'SYN7-AREA-ONCOLOGY-008'; o.packet.unit.unit_id = o.unit_id; o.assignment = asgRow(F.F1); })), { error: G(13) }, [], 'MU7-G13');
await step('MU7-UNIT-11', 'refusal', 'planted walkthrough answers in an import are refused (unknown key)', 'inv', imp(pi((o) => { o.unit_id = 'SYN7-AREA-ONCOLOGY-008'; o.packet.unit.unit_id = o.unit_id; o.planted_answers = []; })), { error: G('07') }, [], 'MU7-G07');
await step('MU7-UNIT-12', 'refusal', 'a design row naming another trial than the packet is refused', 'inv', imp(pi((o) => { o.unit_id = 'SYN7-AREA-ONCOLOGY-008'; o.packet.unit.unit_id = o.unit_id; o.design.nct_id = 'SYN-NCT-9999'; })), { error: G(20) }, [], 'MU7-G20');
await step('MU7-UNIT-13', 'refusal', 'a selection probability other than n over N is refused', 'inv', imp(pi((o) => { o.unit_id = 'SYN7-AREA-ONCOLOGY-008'; o.packet.unit.unit_id = o.unit_id; o.design.selection_probability = 0.2; })), { error: G(20) }, [], 'MU7-G20');
await step('MU7-UNIT-14', 'refusal', 'a FORMAL design row with another design version is refused', 'inv', imp(importObj(F.F1, { d: { design_version: 'OTHER' } })), { error: G(20) }, [], 'MU7-G20');
await step('MU7-UNIT-15', 'refusal', 'a design row with more sampled units than the stratum holds is refused', 'owner',
  replica(`insert into public.mu7_unit_design (unit_id, mode, nct_id, frame_id, stratum, frame_stratum_size, n_sampled_in_stratum, selection_probability, sampling_seed, prn_key, allocation_option, overlap_setting, design_version, freeze_status, design_row_sha256, imported_by)
           values ('SYN7-AREA-ONCOLOGY-777', 'PILOT', 'SYN-NCT-9101', 'SYN_FRAME', 'AREA-ONCOLOGY', 4, 5, 0.5, 1, '${'1'.repeat(64)}', 'A', 'ALLOW', 'SYN-7', 'READY', '${'0'.repeat(64)}', '${invId}')`),
  { error: CK('mu7_unit_design_n_ck') }, [], 'mu7_unit_design:mu7_unit_design_n_ck');
await step('MU7-UNIT-16', 'refusal', 'a blocked design row without its gate is refused', 'inv', imp(pi((o) => { o.unit_id = 'SYN7-AREA-ONCOLOGY-008'; o.packet.unit.unit_id = o.unit_id; o.design.freeze_status = 'BLOCKED_PENDING_GATE'; })), { error: CK('mu7_unit_design_gate_ck') }, [], 'mu7_unit_design:mu7_unit_design_gate_ck');
await step('MU7-UNIT-17', 'refusal', 'a design row with an NCT ID of the wrong form for its mode is refused', 'owner',
  replica(`insert into public.mu7_unit_design (unit_id, mode, nct_id, frame_id, stratum, frame_stratum_size, n_sampled_in_stratum, selection_probability, sampling_seed, prn_key, allocation_option, overlap_setting, design_version, freeze_status, design_row_sha256, imported_by)
           values ('SYN7-AREA-ONCOLOGY-777', 'PILOT', 'NCT99000101', 'SYN_FRAME', 'AREA-ONCOLOGY', 4, 1, 0.25, 1, '${'1'.repeat(64)}', 'A', 'ALLOW', 'SYN-7', 'READY', '${'0'.repeat(64)}', '${invId}')`),
  { error: CK('mu7_unit_design_nct_ck') }, [], 'mu7_unit_design:mu7_unit_design_nct_ck');
await step('MU7-UNIT-18', 'integrity', 'every refused import left nothing behind (no unit, design row or assignment)', 'owner',
  "select ((select count(*) from public.mu7_units where unit_id like '%-008' or unit_id like '%-009' or mode = 'FORMAL') + (select count(*) from public.mu7_unit_design where mode = 'FORMAL'))::int as n", { value: 0 });
await step('MU7-UNIT-19', 'roles', 'a reviewer cannot import a unit', 'pt1', imp(importObj(F.F1)), { error: /investigator role/ });

// pilot queue
const SLOT1 = [...PU.filter((u) => u.import.unit_role === 'PRIMARY'), ...PU.filter((u) => u.import.unit_role === 'SUBGROUP')].map((u) => u.import.unit_id);
const prim = PU.filter((u) => u.import.unit_role === 'PRIMARY').map((u) => u.import.unit_id);
const sg = PU.filter((u) => u.import.unit_role === 'SUBGROUP').map((u) => u.import.unit_id);
const SLOT2 = [...[...prim].reverse(), ...[...sg].reverse()];
const queue = (mode, s1, s2, p1 = PT1, p2 = PT2) => `select public.rpc_mu7_assign_queue('${mode}', ${lit({ slots: [{ reviewer_slot: 1, reviewer_pseudo_id: p1, unit_ids: s1 }, ...(s2 ? [{ reviewer_slot: 2, reviewer_pseudo_id: p2, unit_ids: s2 }] : [])] })}) as n`;
await step('MU7-PQ-01', 'roles', 'a reviewer cannot assign the queue', 'pt1', queue('PILOT', SLOT1, SLOT2), { error: /investigator role/ });
await step('MU7-PQ-02', 'refusal', 'a queue for one slot only is refused (both slots, every unit, one call)', 'inv', queue('PILOT', SLOT1, null), { error: G(60) }, [], 'MU7-G60');
await step('MU7-PQ-03', 'refusal', 'a queue missing one unit is refused', 'inv', queue('PILOT', SLOT1.slice(1), SLOT2), { error: G(60) }, [], 'MU7-G60');
await step('MU7-PQ-04', 'refusal', 'a subgroup unit among the primary positions is refused', 'inv', queue('PILOT', [...sg.slice(0, 1), ...prim, ...sg.slice(1)], SLOT2), { error: G(61) }, [], 'MU7-G61');
await step('MU7-PQ-05', 'refusal', 'one reviewer in both slots is refused', 'inv', queue('PILOT', SLOT1, SLOT2, PT1, PT1), { error: G(32) }, [], 'MU7-G32');
await step('MU7-PQ-06', 'setup', 'the pilot queue: both reviewers, every unit, primary units first', 'inv', queue('PILOT', SLOT1, SLOT2), { value: 24 });
await step('MU7-PQ-07', 'refusal', 'the pilot queue is assigned once', 'inv', queue('PILOT', SLOT1, SLOT2), { error: /duplicate key/ });
await step('MU7-PQ-08', 'visibility', 'pt1 sees its own 12 queue rows only', 'pt1', 'select * from public.mu7_queue', { rows: 12 });
await step('MU7-PQ-09', 'blinding', 'an outsider sees no queue row', 'out', 'select * from public.mu7_queue', { rows: 0 });
await step('MU7-PQ-10', 'visibility', 'pt1 queue view: 8 primary units available, 4 subgroup units not yet', 'pt1',
  "select string_agg(unit_role || ':' || available::text, ',' order by queue_position) filter (where queue_position in (1, 9)) as v from public.v_mu7_my_queue", { value: 'PRIMARY:true,SUBGROUP:false' });

// pilot answers
const W = Object.fromEntries(PU.map((u) => [u.import.unit_id, u.walkthrough]));
const ans = (w, slot) => { const a = w.planted_answers.find((x) => x.reviewer_slot === slot); const o = { answer: a.answer, uncertain: a.uncertain }; if (a.reason_code) o.reason_code = a.reason_code; if (a.note) o.note = a.note; return o; };
const sgFirst = sg[0];
await step('MU7-PR-01', 'visibility', 'pt1 opens a primary unit (packet, position, role)', 'pt1', `select public.rpc_mu7_get_unit('${await asg(PT1, prim[0])}') -> 'packet' -> 'unit' ->> 'unit_id' as v`, { value: prim[0] });
await step('MU7-PR-02', 'gate', 'pt1 cannot open a subgroup unit before every primary unit is answered', 'pt1', `select public.rpc_mu7_get_unit('${await asg(PT1, sgFirst)}')`, { error: G(56) }, [], 'MU7-G56');
await step('MU7-PR-03', 'blinding', 'pt1 cannot read a subgroup packet directly before every primary unit is answered', 'pt1', `select * from public.mu7_units where unit_id = '${sgFirst}'`, { rows: 0 }, [], 'MU7-G53');
await step('MU7-PR-04', 'roles', 'pt2 cannot open an assignment of pt1', 'pt2', `select public.rpc_mu7_get_unit('${await asg(PT1, prim[0])}')`, { error: G(54) }, [], 'MU7-G54');
await step('MU7-PR-05', 'roles', 'pt2 cannot answer an assignment of pt1', 'pt2', await submit('pt2', PT1, prim[0], { answer: 'AGREE' }), { error: G(57) }, [], 'MU7-G57');
await step('MU7-PR-06', 'gate', 'pt1 cannot answer a subgroup unit before every primary unit', 'pt1', await submit('pt1', PT1, sgFirst, { answer: 'AGREE' }), { error: G(33) }, [], 'MU7-G33');
await step('MU7-PR-07', 'refusal', 'DISAGREE without a note is refused', 'pt1', await submit('pt1', PT1, prim[0], { answer: 'DISAGREE', reason_code: 'NOT_THE_CONDITION_STUDIED' }), { error: G(36) }, [], 'MU7-G36');
await step('MU7-PR-08', 'refusal', 'a reason code that does not fit the unit is refused', 'pt1', await submit('pt1', PT1, prim[0], { answer: 'DISAGREE', reason_code: 'TYPE_1_ONLY', note: 'synthetic' }), { error: G(35) }, [], 'MU7-G35');
await step('MU7-PR-09', 'refusal', 'DISAGREE without a reason code is refused', 'pt1', await submit('pt1', PT1, prim[0], { answer: 'DISAGREE', note: 'synthetic' }), { error: CK('mu7_judgments_reason_ck') }, [], 'mu7_judgments:mu7_judgments_reason_ck');
await step('MU7-PR-10', 'refusal', 'CANNOT_TELL with a reason code is refused', 'pt1', await submit('pt1', PT1, prim[0], { answer: 'CANNOT_TELL', reason_code: 'OTHER_SPECIFIED', note: 'x' }), { error: CK('mu7_judgments_reason_ck') }, [], 'mu7_judgments:mu7_judgments_reason_ck');
await step('MU7-PR-11', 'refusal', 'an answer outside AGREE, DISAGREE, CANNOT_TELL is refused', 'pt1', await submit('pt1', PT1, prim[0], { answer: 'YES' }), { error: CK('mu7_judgments_answer_ck') }, [], 'mu7_judgments:mu7_judgments_answer_ck');
await step('MU7-PR-12', 'refusal', 'an unknown key in a submission is refused', 'pt1', await submit('pt1', PT1, prim[0], { answer: 'AGREE', item_code: 'AREA_ONCOLOGY' }), { error: G('07') }, [], 'MU7-G07');
for (const [k, pseudo, order] of [['pt1', PT1, SLOT1], ['pt2', PT2, SLOT2]]) {
  for (const u of order) {
    const slot = k === 'pt1' ? 1 : 2;
    await step(`MU7-PR-${k}-${u}`, 'workflow', `${k} answers ${u} (planted)`, k, await submit(k, pseudo, u, ans(W[u], slot)), { minRows: 1 });
  }
}
await step('MU7-PR-13', 'workflow', 'pt1 revises one answer (a new row, revision 2)', 'pt1', await submit('pt1', PT1, prim[0], { answer: 'AGREE', uncertain: true, note: 'synthetic revision' }), { minRows: 1 });
await step('MU7-PR-14', 'visibility', 'pt1 opens a subgroup unit once every primary unit is answered', 'pt1', `select public.rpc_mu7_get_unit('${await asg(PT1, sgFirst)}') ->> 'unit_role' as v`, { value: 'SUBGROUP' });
await step('MU7-PR-15', 'visibility', 'pt1 reads its own 13 judgment rows only', 'pt1', 'select * from public.mu7_judgments', { rows: 13 });
await step('MU7-PR-16', 'blinding', 'pt2 reads no answer of pt1 through the export view', 'pt2', 'select * from public.v_mu7_independent_judgments', { rows: 0 });
await step('MU7-PR-17', 'visibility', 'the investigator reads every PILOT judgment row (25)', 'inv', "select * from public.mu7_judgments where mode = 'PILOT'", { rows: 25 });
const routeMap = { BOTH_AGREE: 'CONCORDANT_AGREE', BOTH_DISAGREE: 'CONCORDANT_DISAGREE', BOTH_CANNOT_TELL: 'BOTH_CANNOT_TELL', AGREE_VS_DISAGREE: 'ROUTED', ONE_CANNOT_TELL: 'ROUTED' };
const expRoute = PU.map((u) => `${u.import.unit_id}:${routeMap[u.walkthrough.expected_routing]}`).sort(cmp).join(',');
await step('MU7-PR-18', 'workflow', 'routing of every pilot unit equals the planted routing case', 'inv',
  "select string_agg(unit_id || ':' || routing, ',' order by unit_id collate \"C\") as v from public.v_mu7_final_reference where mode = 'PILOT'", { value: expRoute });

// pilot adjudication
const routed = PU.filter((u) => routeMap[u.walkthrough.expected_routing] === 'ROUTED').map((u) => u.import.unit_id);
const conc = PU.find((u) => u.walkthrough.expected_routing === 'BOTH_AGREE').import.unit_id;
const bothCT = PU.find((u) => u.walkthrough.expected_routing === 'BOTH_CANNOT_TELL').import.unit_id;
const resp = 'SYN7-AREA-RESPIRATORY-001';
await step('MU7-PA-01', 'roles', 'a reviewer cannot adjudicate', 'pt1', adjud({ unit_id: resp, decision: 'AGREE', status: 'DISCORDANT_RESOLVED', basis: 'REVIEWER_1', rationale: 'synthetic' }), { error: G(58) }, [], 'MU7-G58');
await step('MU7-PA-02', 'roles', 'the investigator is not the tie-breaker', 'inv', adjud({ unit_id: resp, decision: 'AGREE', status: 'DISCORDANT_RESOLVED', basis: 'REVIEWER_1', rationale: 'synthetic' }), { error: G(58) }, [], 'MU7-G58');
await step('MU7-PA-03', 'refusal', 'a concordant unit is not adjudicated', 'adj', adjud({ unit_id: conc, decision: 'AGREE', status: 'DISCORDANT_RESOLVED', basis: 'REVIEWER_1', rationale: 'synthetic' }), { error: G(39) }, [], 'MU7-G39');
await step('MU7-PA-04', 'refusal', 'two CANNOT_TELL answers are not adjudicated (final CANNOT_TELL by rule)', 'adj', adjud({ unit_id: bothCT, decision: 'AGREE', status: 'DISCORDANT_RESOLVED', basis: 'NEITHER', rationale: 'synthetic' }), { error: G(39) }, [], 'MU7-G39');
await step('MU7-PA-05', 'refusal', 'a basis that names a reviewer whose answer differs is refused', 'adj', adjud({ unit_id: resp, decision: 'AGREE', status: 'DISCORDANT_RESOLVED', basis: 'REVIEWER_2', rationale: 'synthetic' }), { error: G(47) }, [], 'MU7-G47');
await step('MU7-PA-06', 'refusal', 'an adjudicated DISAGREE with a reason that does not fit is refused', 'adj', adjud({ unit_id: resp, decision: 'DISAGREE', reason_code: 'TYPE_1_ONLY', status: 'DISCORDANT_RESOLVED', basis: 'REVIEWER_2', rationale: 'synthetic' }), { error: G(47) }, [], 'MU7-G47');
await step('MU7-PA-07', 'refusal', 'an unresolved escalation with a decision is refused', 'adj', adjud({ unit_id: resp, decision: 'AGREE', status: 'UNRESOLVED_ESCALATED', basis: 'NONE', rationale: 'synthetic' }), { error: CK('mu7_adj_status_ck') }, [], 'mu7_adjudications:mu7_adj_status_ck');
await step('MU7-PA-08', 'refusal', 'an unresolved escalation with a basis is refused', 'adj', adjud({ unit_id: resp, status: 'UNRESOLVED_ESCALATED', basis: 'NEITHER', rationale: 'synthetic' }), { error: CK('mu7_adj_basis_ck') }, [], 'mu7_adjudications:mu7_adj_basis_ck');
await step('MU7-PA-09', 'refusal', 'an adjudicated DISAGREE without a reason is refused', 'adj', adjud({ unit_id: resp, decision: 'DISAGREE', status: 'DISCORDANT_RESOLVED', basis: 'REVIEWER_2', rationale: 'synthetic' }), { error: CK('mu7_adj_reason_ck') }, [], 'mu7_adjudications:mu7_adj_reason_ck');
await step('MU7-PA-10', 'refusal', 'an adjudication decision outside AGREE and DISAGREE is refused', 'adj', adjud({ unit_id: resp, decision: 'CANNOT_TELL', status: 'DISCORDANT_RESOLVED', basis: 'NEITHER', rationale: 'synthetic' }), { error: CK('mu7_adj_decision_ck') }, [], 'mu7_adjudications:mu7_adj_decision_ck');
await step('MU7-PA-13', 'roles', 'an adjudication row naming a non-adjudicator is refused even for the owner', 'owner',
  `insert into public.mu7_adjudications (unit_id, mode, decision, status, basis, rationale, decided_by) values ('${resp}', 'PILOT', 'AGREE', 'DISCORDANT_RESOLVED', 'REVIEWER_1', 'synthetic', '${invId}')`,
  { error: G(37) }, [], 'MU7-G37');
await step('MU7-PA-11', 'visibility', 'the adjudication queue holds the 5 routed pilot units with both answers and notes', 'adj', "select * from public.v_mu7_adjudication_queue where mode = 'PILOT'", { rows: routed.length });
const PADJ = {
  'SYN7-AREA-RESPIRATORY-001': { decision: 'DISAGREE', reason_code: 'ORGAN_OF_ORIGIN_ONLY', status: 'DISCORDANT_RESOLVED', basis: 'REVIEWER_2', disagreement_reason_code: 'POLICY_RULE_INTERPRETATION', rationale: 'Synthetic: the neoplasm policy applies.' },
  'SYN7-AREA-MENTAL_HEALTH-001': { decision: 'AGREE', status: 'DISCORDANT_RESOLVED', basis: 'REVIEWER_2', rationale: 'Synthetic: the evidence supports the area.' },
  'SYN7-ROW-DIAB-001': { decision: 'AGREE', status: 'DISCORDANT_RESOLVED', basis: 'REVIEWER_1', rationale: 'Synthetic: diabetes is studied.' },
  'SYN7-SG-RULE_D_REMOVED-001': { decision: 'DISAGREE', reason_code: 'TYPE_2_STUDIED', status: 'DISCORDANT_RESOLVED', basis: 'REVIEWER_1', rationale: 'Synthetic: type 2 is stated.' },
  'SYN7-SG-RULE_K_KEPT-001': { status: 'UNRESOLVED_ESCALATED', basis: 'NONE', rationale: 'Synthetic: cannot be resolved from the registry.' },
};
const routedSorted = Object.keys(PADJ);
for (const u of routedSorted.slice(0, 4)) await step(`MU7-PA-${u}`, 'adjudication', `the adjudicator resolves ${u}`, 'adj', adjud(Object.assign({ unit_id: u }, PADJ[u])), { minRows: 1 });
await step('MU7-PL-01', 'gate', 'the pilot reference cannot lock while a routed unit is not adjudicated', 'inv', `select public.rpc_mu7_lock_reference('PILOT', '${ATT}')`, { error: G(48) }, [], 'MU7-G48');
await step('MU7-PX-01', 'gate', 'a pilot export before the pilot lock is refused', 'inv', `select public.rpc_mu7_register_export(${lit({ mode: 'PILOT', bundle_format_version: '7.0', row_counts: {}, file_sha256: {}, manifest_sha256: '3'.repeat(64), app_git_sha: 'abc123' })})`, { error: G(49) }, [], 'MU7-G49');
const lastU = routedSorted[4];
await step(`MU7-PA-${lastU}`, 'adjudication', `the adjudicator escalates ${lastU} as unresolved`, 'adj', adjud(Object.assign({ unit_id: lastU }, PADJ[lastU])), { minRows: 1 });
await step('MU7-PA-12', 'refusal', 'a unit is adjudicated once', 'adj', adjud(Object.assign({ unit_id: lastU }, PADJ[lastU])), { error: /duplicate key/ });
await step('MU7-PL-02', 'setup', 'the investigator locks the pilot reference', 'inv', `select public.rpc_mu7_lock_reference('PILOT', '${ATT}')`, { minRows: 1 });
await step('MU7-PL-03', 'gate', 'no pilot answer after the pilot lock', 'pt1', await submit('pt1', PT1, prim[1], { answer: 'AGREE' }), { error: G(34) }, [], 'MU7-G34');
await step('MU7-PL-04', 'gate', 'no pilot adjudication after the pilot lock', 'adj', adjud({ unit_id: conc, decision: 'AGREE', status: 'DISCORDANT_RESOLVED', basis: 'REVIEWER_1', rationale: 'synthetic' }), { error: G(38) }, [], 'MU7-G38');
// expected pilot final states from the planted file and the adjudications above (computed independently of the view)
const expFinal = PU.map((u) => u.import.unit_id).sort(cmp).map((id) => {
  const r = routeMap[W[id].expected_routing];
  if (r === 'CONCORDANT_AGREE') return 'CONCORDANT:AGREE';
  if (r === 'CONCORDANT_DISAGREE') return 'CONCORDANT:DISAGREE';
  if (r === 'BOTH_CANNOT_TELL') return 'CANNOT_TELL_BY_RULE:CANNOT_TELL';
  const a = PADJ[id]; return a.status === 'UNRESOLVED_ESCALATED' ? 'UNRESOLVED:-' : `ADJUDICATED:${a.decision}`;
}).join(',');
await step('MU7-PL-05', 'export', 'pilot final reference: concordant, adjudicated, cannot-tell-by-rule and unresolved states', 'inv',
  "select string_agg(final_status || ':' || coalesce(final_answer, '-'), ',' order by unit_id collate \"C\") as v from public.v_mu7_final_reference where mode = 'PILOT'",
  { value: expFinal });
await step('MU7-PX-02', 'refusal', 'a bundle in format 6.0 is refused', 'inv', `select public.rpc_mu7_register_export(${lit({ mode: 'PILOT', bundle_format_version: '6.0', row_counts: {}, file_sha256: {}, manifest_sha256: '3'.repeat(64), app_git_sha: 'abc123' })})`, { error: CK('mu7_exports_format_ck') }, [], 'mu7_exports:mu7_exports_format_ck');
const PEX = (await step('MU7-PX-03', 'setup', 'the pilot export (bundle 7.0) is registered', 'inv', `select public.rpc_mu7_register_export(${lit({ mode: 'PILOT', bundle_format_version: '7.0', row_counts: { units: 12 }, file_sha256: {}, manifest_sha256: '3'.repeat(64), app_git_sha: 'abc123' })}) as x`, { minRows: 1 }))?.[0]?.x;
const signoff = (o = {}) => phase('PILOT_SIGNED_OFF', Object.assign({ checklist_version: 'PAC-7', checklist_sha256: '1'.repeat(64), app_git_sha: 'abc123', pilot_export_id: PEX }, o));
await step('MU7-ENR-00', 'gate', 'FORMAL v7 reviewers cannot be enrolled before the v7 pilot sign-off', 'inv', `select public.rpc_mu7_enroll_reviewer('${await uid('r1')}', 'synthetic')`, { error: G('08') }, [], 'MU7-G08');
await step('MU7-PS-01', 'gate', 'a sign-off naming an export that does not exist is refused', 'inv', signoff({ pilot_export_id: '00000000-0000-4000-8000-000000000999' }), { error: G(43) }, [], 'MU7-G43');
await step('MU7-PS-02', 'refusal', 'a sign-off without the checklist hash is refused', 'inv', phase('PILOT_SIGNED_OFF', { checklist_version: 'PAC-7', app_git_sha: 'abc123', pilot_export_id: PEX }), { error: CK('mu7_phase_signoff_fields_ck') }, [], 'mu7_phase_events:mu7_phase_signoff_fields_ck');
await step('MU7-PS-03', 'roles', 'a reviewer cannot sign off', 'pt1', signoff(), { error: /investigator role/ });
await step('MU7-PS-04', 'roles', 'a phase event naming a non-investigator actor is refused even for the owner', 'owner',
  `insert into public.mu7_phase_events (event_type, checklist_version, checklist_sha256, app_git_sha, pilot_export_id, attestation, actor) values ('PILOT_SIGNED_OFF', 'PAC-7', '${'1'.repeat(64)}', 'abc', '${PEX}', '${ATT}', '${await uid('pt1')}')`,
  { error: G(42) }, [], 'MU7-G42');
await step('MU7-PS-05', 'refusal', 'an unknown phase event is refused', 'inv', phase('FORMAL_REOPENED'), { error: CK('mu7_phase_event_type_ck') }, [], 'mu7_phase_events:mu7_phase_event_type_ck');
await step('MU7-PS-06', 'setup', 'the investigator signs off the v7 pilot', 'inv', signoff(), { minRows: 1 });
await step('MU7-PS-07', 'gate', 'the sign-off is recorded once', 'inv', signoff(), { error: G(42) }, [], 'MU7-G42');
await step('MU7-PS-08', 'gate', 'no PILOT unit after the sign-off', 'inv', imp(pi((o) => { o.unit_id = 'SYN7-AREA-ONCOLOGY-007'; o.packet.unit.unit_id = o.unit_id; })), { error: G(11) }, [], 'MU7-G11');
await step('MU7-PS-09', 'gate', 'the formal phase cannot open before the freeze', 'inv', phase('FORMAL_OPENED'), { error: G(44) }, [], 'MU7-G44');
for (const k of ['r1', 'r2']) await step(`MU7-ENR-${k}`, 'setup', `enrol ${k} as a FORMAL v7 reviewer`, 'inv', `select public.rpc_mu7_enroll_reviewer('${await uid(k)}', 'synthetic qualifications') ~ '^R-[A-Z0-9]{4}$' as ok`, { value: true });
await step('MU7-ENR-03', 'roles', 'the adjudicator account cannot also be a reviewer', 'inv', `select public.rpc_mu7_enroll_reviewer('${await uid('adj')}', 'synthetic')`, { error: /reviewer rows require a REVIEWER user/ });
const R1 = await pid('r1'), R2 = await pid('r2');

// ---- F. FORMAL fixture: import, gate approval, freeze, queue ----------------------------------------------------------------
for (const [k, x] of Object.entries(F).slice(0, 7)) await step(`MU7-FIMP-${k}`, 'setup', `import FORMAL unit ${x.uid}`, 'inv', imp(importObj(x)), { value: x.uid });
await step('MU7-FIMP-09', 'refusal', 'a frozen assignment with a wrong row hash is refused', 'inv', imp(importObj(F.F8, { assignment: Object.assign(asgRow(F.F8), { row_sha256: '2'.repeat(64) }) })), { error: G(23) }, [], 'MU7-G23');
await step('MU7-FIMP-10', 'refusal', 'a frozen assignment that differs from the displayed one is refused', 'inv', imp(importObj(F.F8, { assignment: Object.assign(asgRow(F.F8), { assignment_code: 'K_KEEP_HEURISTIC_NONMALIGNANT_CLASS' }) })), { error: G(23) }, [], 'MU7-G23');
await step('MU7-FIMP-11', 'refusal', 'a frozen assignment in another assignment set is refused', 'inv', imp(importObj(F.F8, { assignment: Object.assign(asgRow(F.F8), { assignment_set_id: 'SYN7-ASSIGN-OTHER' }) })), { error: G(23) }, [], 'MU7-G23');
const QF1 = ['F1', 'F2', 'F4', 'F3', 'F5', 'F6', 'F7', 'F8'].map((k) => F[k].uid);
const QF2 = ['F3', 'F1', 'F5', 'F4', 'F6', 'F2', 'F8', 'F7'].map((k) => F[k].uid);
const H = hashes(FX, [[1, QF1], [2, QF2]]);
const freeze = (o = {}) => `select public.rpc_mu7_freeze(${lit(Object.assign({}, H, { attestation: ATT }, o))}) as f`;
await step('MU7-FZ-01', 'gate', 'the freeze needs every planned FORMAL unit (7 of 8 imported)', 'inv', freeze(), { error: G(26) }, [], 'MU7-G26');
await step('MU7-FIMP-F8', 'setup', `import FORMAL unit ${F.F8.uid}`, 'inv', imp(importObj(F.F8)), { value: F.F8.uid });
await step('MU7-FZ-02', 'refusal', 'a freeze with a unit list hash that does not match is refused', 'inv', freeze({ unit_list_sha256: '4'.repeat(64) }), { error: G(28) }, [], 'MU7-G28');
await step('MU7-FZ-03', 'refusal', 'a freeze with a design-row hash that does not match is refused', 'inv', freeze({ design_rows_sha256: '4'.repeat(64) }), { error: G(28) }, [], 'MU7-G28');
await step('MU7-FZ-04', 'gate', 'the freeze is refused while the Pain unit waits for gate G-PAIN-01', 'inv', freeze(), { error: G(29) }, [], 'MU7-G29');
await step('MU7-GATE-01', 'roles', 'a reviewer cannot approve a gate', 'r1', `select public.rpc_mu7_approve_gate('G-PAIN-01', '${ATT}')`, { error: /investigator role/ });
await step('MU7-GATE-02', 'refusal', 'a gate ID outside the G- format is refused', 'inv', `select public.rpc_mu7_approve_gate('PAIN', '${ATT}')`, { error: CK('mu7_gate_id_ck') }, [], 'mu7_gate_approvals:mu7_gate_id_ck');
await step('MU7-GATE-03', 'setup', 'the investigator approves gate G-PAIN-01 (synthetic)', 'inv', `select public.rpc_mu7_approve_gate('G-PAIN-01', '${ATT}', 'synthetic decision record')`, { value: 'G-PAIN-01' });
await step('MU7-FZ-05', 'roles', 'a reviewer cannot freeze', 'r1', freeze(), { error: /investigator role/ });
await step('MU7-FZ-06', 'setup', 'the investigator freezes the FORMAL sample (hashes of the manifest)', 'inv', freeze(), { minRows: 1 });
await step('MU7-FZ-07', 'refusal', 'the sample is frozen once', 'inv', freeze(), { error: /duplicate key/ });
await step('MU7-FZ-08', 'gate', 'no FORMAL unit after the freeze', 'inv', imp(importObj({ uid: 'MU7-AREA-INFECTIOUS-001', fam: 'AREA', cat: 'INFECTIOUS', code: 'IN_AREA', nct: 'NCT99000108', N: 9, n: 1 })), { error: G(11) }, [], 'MU7-G11');
await step('MU7-FZ-09', 'freeze', 'the frozen unit list, assignments, design rows and packets verify (the queue follows)', 'inv',
  "select string_agg(quantity || ':' || matches::text, ',' order by quantity) as v from public.rpc_mu7_verify_freeze()",
  { value: 'assignment_set_sha256:true,design_rows_sha256:true,packets_sha256:true,queue_sha256:false,unit_list_sha256:true' });
await step('MU7-TR-11', 'refusal', 'a worked example on a FORMAL trial is refused', 'inv', impT('EX7-04', trainPacket('EX7-04', F.F3.nct)), { error: G(22) }, [], 'MU7-G22');
const fq = (s1, s2, a = R1, b = R2) => queue('FORMAL', s1, s2, a, b);
await step('MU7-FQ-01', 'refusal', 'two units of one trial adjacent in a queue are refused', 'inv', fq(['F1', 'F4', 'F2', 'F3', 'F5', 'F6', 'F7', 'F8'].map((k) => F[k].uid), QF2), { error: G(62) }, [], 'MU7-G62');
await step('MU7-FQ-02', 'refusal', 'a valid queue that differs from the frozen queue is refused', 'inv', fq(QF2, QF1), { error: G(63) }, [], 'MU7-G63');
await step('MU7-FQ-03', 'refusal', 'a PILOT reviewer on a FORMAL unit is refused', 'inv', fq(QF1, QF2, PT1, R2), { error: G(30) }, [], 'MU7-G30');
await step('MU7-FQ-04', 'setup', 'the FORMAL queue equals the frozen queue (16 assignments)', 'inv', fq(QF1, QF2), { value: 16 });
await step('MU7-FQ-05', 'freeze', 'all five frozen hashes verify', 'inv', "select count(*) filter (where matches)::int as n from public.rpc_mu7_verify_freeze()", { value: 5 });
await step('MU7-FQ-06', 'blinding', 'a FORMAL reviewer reads no design row (strata, probabilities)', 'r1', 'select * from public.mu7_unit_design', { rows: 0 });
await step('MU7-FQ-07', 'blinding', 'a FORMAL reviewer reads no frozen assignment row', 'r1', 'select * from public.mu7_frozen_assignments', { rows: 0 });

// ---- O. Formal phase ----------------------------------------------------------------------------------------------------------
await step('MU7-FP-01', 'gate', 'a FORMAL unit does not open before the formal phase', 'r1', `select public.rpc_mu7_get_unit('${await asg(R1, F.F1.uid)}')`, { error: G(55) }, [], 'MU7-G55');
await step('MU7-FP-02', 'blinding', 'a FORMAL packet is not readable directly before the formal phase', 'r1', `select * from public.mu7_units where unit_id = '${F.F1.uid}'`, { rows: 0 }, [], 'MU7-G52');
await step('MU7-FP-03', 'gate', 'no FORMAL answer before the formal phase', 'r1', await submit('r1', R1, F.F1.uid, { answer: 'AGREE' }), { error: G(34) }, [], 'MU7-G34');
await step('MU7-FP-04', 'setup', 'the investigator opens the formal phase', 'inv', phase('FORMAL_OPENED'), { minRows: 1 });
await step('MU7-FP-05', 'gate', 'the formal phase opens once', 'inv', phase('FORMAL_OPENED'), { error: G(42) }, [], 'MU7-G42');
await step('MU7-FP-06', 'gate', 'no worked example after the formal opening', 'inv', impT('EX7-05', trainPacket('EX7-05', 'SYN-NCT-9205')), { error: G(41) }, [], 'MU7-G41');
await step('MU7-FP-07', 'visibility', 'r1 opens its first FORMAL unit after the opening', 'r1', `select public.rpc_mu7_get_unit('${await asg(R1, F.F1.uid)}') -> 'packet' -> 'trial' ->> 'registry_url' as v`, { value: `https://clinicaltrials.gov/study/${F.F1.nct}` });
const FA1 = { F1: { answer: 'AGREE' }, F2: { answer: 'AGREE' }, F3: { answer: 'AGREE', uncertain: true },
  F4: { answer: 'DISAGREE', reason_code: 'NOT_THE_CONDITION_STUDIED', note: 'Synthetic note: not the condition studied.' }, F5: { answer: 'CANNOT_TELL', uncertain: true },
  F6: { answer: 'AGREE' }, F7: { answer: 'AGREE' }, F8: { answer: 'DISAGREE', reason_code: 'BENIGN_NEOPLASM', note: 'Synthetic note: a benign tumour.' } };
const FA2 = { F1: { answer: 'AGREE' }, F2: { answer: 'CANNOT_TELL' }, F3: { answer: 'DISAGREE', reason_code: 'ORGAN_OF_ORIGIN_ONLY', note: 'Synthetic note: organ of origin only.' },
  F4: { answer: 'DISAGREE', reason_code: 'MESH_PLACEMENT_MISLEADING', note: 'Synthetic note: MeSH placement only.' }, F5: { answer: 'CANNOT_TELL' },
  F6: { answer: 'DISAGREE', reason_code: 'NOT_THE_CONDITION_STUDIED', note: 'Synthetic note: first reading.' }, F7: { answer: 'AGREE' }, F8: { answer: 'AGREE' } };
const key = (u) => Object.keys(F).find((k) => F[k].uid === u);
for (const u of QF1) await step(`MU7-FS-r1-${key(u)}`, 'workflow', `r1 answers ${u}`, 'r1', await submit('r1', R1, u, FA1[key(u)]), { minRows: 1 });
for (const u of QF2.slice(0, 6)) await step(`MU7-FS-r2-${key(u)}`, 'workflow', `r2 answers ${u}`, 'r2', await submit('r2', R2, u, FA2[key(u)]), { minRows: 1 });
await step('MU7-FS-r2-F7', 'workflow', `r2 answers ${F.F7.uid} (its first subgroup unit, second to last)`, 'r2', await submit('r2', R2, F.F7.uid, FA2.F7), { minRows: 1 });
await step('MU7-FS-REV-01', 'workflow', 'r1 revises F1 (uncertain added; the initial answer stays revision 1)', 'r1', await submit('r1', R1, F.F1.uid, { answer: 'AGREE', uncertain: true }), { minRows: 1 });
await step('MU7-FS-REV-02', 'workflow', 'r2 revises F6 from DISAGREE to AGREE (initial and effective answers differ)', 'r2', await submit('r2', R2, F.F6.uid, { answer: 'AGREE', note: 'Synthetic note: second reading.' }), { minRows: 1 });
await step('MU7-INT-01', 'interim', 'no interim look: the investigator reads no FORMAL judgment while the phase is open', 'inv', "select * from public.mu7_judgments where mode = 'FORMAL'", { rows: 0 }, [], 'MU7-G50');
await step('MU7-INT-02', 'interim', 'no interim look through the export view', 'inv', "select * from public.v_mu7_independent_judgments where mode = 'FORMAL'", { rows: 0 }, [], 'MU7-G50');
await step('MU7-INT-03', 'interim', 'no interim look through the final reference view', 'inv', "select * from public.v_mu7_final_reference where mode = 'FORMAL'", { rows: 0 }, [], 'MU7-G50');
await step('MU7-INT-04', 'interim', 'the investigator reads progress counts only', 'inv', "select string_agg(n_answered || '/' || n_assigned, ',' order by reviewer_slot) as v from public.rpc_mu7_completion_summary('FORMAL')", { value: '8/8,7/8' });
await step('MU7-INT-05', 'interim', 'the audit log holds no answer content for v7 judgments', 'inv',
  "select count(*)::int as n from public.audit_log where entity_table = 'mu7_judgments' and (details ? 'answer' or details ? 'note' or details ? 'reason_code')", { value: 0 });
await step('MU7-INT-06', 'interim', 'the adjudicator reads no FORMAL judgment while the phase is open', 'adj', "select * from public.mu7_judgments where mode = 'FORMAL'", { rows: 0 }, [], 'MU7-G51');
await step('MU7-INT-07', 'blinding', 'r2 reads no judgment of r1', 'r2', `select * from public.mu7_judgments where reviewer_pseudo_id = '${R1}'`, { rows: 0 });
await step('MU7-INT-08', 'visibility', 'r1 reads its own 9 FORMAL judgment rows', 'r1', 'select * from public.mu7_judgments', { rows: 9 });
await step('MU7-INT-09', 'blinding', 'the adjudication queue is empty for the adjudicator while the phase is open', 'adj', "select * from public.v_mu7_adjudication_queue where mode = 'FORMAL'", { rows: 0 }, [], 'MU7-G51');
await step('MU7-FC-01', 'gate', 'FORMAL_CLOSED_COMPLETE needs every assignment answered (15 of 16)', 'inv', phase('FORMAL_CLOSED_COMPLETE'), { error: G(45) }, [], 'MU7-G45');
await step('MU7-FS-r2-F8', 'workflow', `r2 answers ${F.F8.uid}`, 'r2', await submit('r2', R2, F.F8.uid, FA2.F8), { minRows: 1 });
await step('MU7-SN-00', 'gate', 'the snapshot is refused while the phase is open', 'inv', 'select public.rpc_mu7_snapshot()', { error: G(46) }, [], 'MU7-G46');
await step('MU7-FC-02', 'setup', 'the investigator closes the formal phase (complete)', 'inv', phase('FORMAL_CLOSED_COMPLETE'), { minRows: 1 });
await step('MU7-FC-03', 'gate', 'no FORMAL answer after the close', 'r1', await submit('r1', R1, F.F2.uid, { answer: 'AGREE' }), { error: G(34) }, [], 'MU7-G34');
await step('MU7-FC-04', 'gate', 'the phase closes once', 'inv', phase('FORMAL_CLOSED_INCOMPLETE'), { error: G(42) }, [], 'MU7-G42');
await step('MU7-FC-05', 'gate', 'FORMAL adjudication waits for the snapshot', 'adj', adjud({ unit_id: F.F2.uid, decision: 'AGREE', status: 'DISCORDANT_RESOLVED', basis: 'REVIEWER_1', rationale: 'synthetic' }), { error: G(38) }, [], 'MU7-G38');
await step('MU7-FC-06', 'blinding', 'the adjudicator reads no FORMAL judgment before the snapshot', 'adj', "select * from public.mu7_judgments where mode = 'FORMAL'", { rows: 0 }, [], 'MU7-G51');
await step('MU7-FC-07', 'visibility', 'after the close the investigator reads every FORMAL judgment row (18)', 'inv', "select * from public.mu7_judgments where mode = 'FORMAL'", { rows: 18 });
await step('MU7-FL-00', 'gate', 'the FORMAL reference cannot lock before the snapshot', 'inv', `select public.rpc_mu7_lock_reference('FORMAL', '${ATT}')`, { error: G(48) }, [], 'MU7-G48');
await step('MU7-SN-01', 'roles', 'a reviewer cannot take the snapshot', 'r1', 'select public.rpc_mu7_snapshot()', { error: /investigator role/ });
await step('MU7-SN-02', 'setup', 'the investigator takes the snapshot of the independent judgments', 'inv', 'select public.rpc_mu7_snapshot() as s', { minRows: 1 });
await step('MU7-SN-03', 'refusal', 'the snapshot is taken once', 'inv', 'select public.rpc_mu7_snapshot()', { error: /duplicate key/ });
await step('MU7-SN-04', 'snapshot', 'the snapshot verifies (18 rows, same hash)', 'inv', "select matches::text || ':' || n_rows_now as v from public.rpc_mu7_verify_snapshot()", { value: 'true:18' });
await step('MU7-ADJ-01', 'visibility', 'the FORMAL adjudication queue holds the 3 routed units (F2, F3, F8) with both answers and notes', 'adj',
  "select string_agg(unit_id, ',' order by unit_id collate \"C\") as v from public.v_mu7_adjudication_queue where mode = 'FORMAL'",
  { value: [F.F2.uid, F.F3.uid, F.F8.uid].sort(cmp).join(',') });
await step('MU7-ADJ-02', 'refusal', 'F6 is concordant on the effective answers (initial DISAGREE revised) and is not adjudicated', 'adj',
  adjud({ unit_id: F.F6.uid, decision: 'AGREE', status: 'DISCORDANT_RESOLVED', basis: 'REVIEWER_1', rationale: 'synthetic' }), { error: G(39) }, [], 'MU7-G39');
await step('MU7-ADJ-F2', 'adjudication', 'F2 (AGREE against CANNOT_TELL) resolved AGREE on reviewer 1', 'adj', adjud({ unit_id: F.F2.uid, decision: 'AGREE', status: 'DISCORDANT_RESOLVED', basis: 'REVIEWER_1', rationale: 'Synthetic: supported.' }), { minRows: 1 });
await step('MU7-ADJ-F3', 'adjudication', 'F3 (AGREE against DISAGREE) resolved DISAGREE on reviewer 2', 'adj', adjud({ unit_id: F.F3.uid, decision: 'DISAGREE', reason_code: 'ORGAN_OF_ORIGIN_ONLY', status: 'DISCORDANT_RESOLVED', basis: 'REVIEWER_2', disagreement_reason_code: 'POLICY_RULE_INTERPRETATION', rationale: 'Synthetic: neoplasm policy.' }), { minRows: 1 });
await step('MU7-FL-01', 'gate', 'the FORMAL reference cannot lock while F8 is not adjudicated', 'inv', `select public.rpc_mu7_lock_reference('FORMAL', '${ATT}')`, { error: G(48) }, [], 'MU7-G48');
await step('MU7-ADJ-F8', 'adjudication', 'F8 escalated as unresolved', 'adj', adjud({ unit_id: F.F8.uid, status: 'UNRESOLVED_ESCALATED', basis: 'NONE', rationale: 'Synthetic: unresolved.' }), { minRows: 1 });
await step('MU7-FL-02', 'setup', 'the investigator locks the FORMAL reference', 'inv', `select public.rpc_mu7_lock_reference('FORMAL', '${ATT}')`, { minRows: 1 });
const expF = { F1: 'CONCORDANT:AGREE', F2: 'ADJUDICATED:AGREE', F3: 'ADJUDICATED:DISAGREE', F4: 'CONCORDANT:DISAGREE', F5: 'CANNOT_TELL_BY_RULE:CANNOT_TELL', F6: 'CONCORDANT:AGREE', F7: 'CONCORDANT:AGREE', F8: 'UNRESOLVED:-' };
await step('MU7-EXP-01', 'export', 'FORMAL final reference: every unit has its final state (three-state coding, never blank)', 'inv',
  "select string_agg(unit_id || '=' || final_status || ':' || coalesce(final_answer, '-'), ',' order by unit_id collate \"C\") as v from public.v_mu7_final_reference where mode = 'FORMAL'",
  { value: Object.entries(expF).map(([k, v]) => `${F[k].uid}=${v}`).sort(cmp).join(',') });
await step('MU7-EXP-02', 'export', 'initial and effective answers: F6 reviewer 2 initial DISAGREE, effective AGREE, one revision', 'inv',
  `select answer_initial || '>' || answer_effective || ':' || n_revisions as v from public.v_mu7_independent_judgments where unit_id = '${F.F6.uid}' and reviewer_slot = 2`, { value: 'DISAGREE>AGREE:1' });
await step('MU7-EXP-03', 'export', 'the independent-judgment export has one row per assignment (16), all answered', 'inv',
  "select count(*) filter (where judgment_status = 'ANSWERED')::int as n from public.v_mu7_independent_judgments where mode = 'FORMAL'", { value: 16 });
const COLS = { v_mu7_independent_judgments: 'unit_id,mode,reviewer_slot,reviewer_pseudo_id,queue_position,judgment_status,answer_initial,reason_initial,note_initial,uncertain_initial,answer_effective,reason_effective,note_effective,uncertain_effective,n_revisions,first_submitted_at,last_submitted_at',
  v_mu7_final_reference: 'unit_id,mode,family,category,unit_role,mapping_code,assignment_code,assignment_status,answer_initial_slot1,answer_initial_slot2,answer_effective_slot1,answer_effective_slot2,routing,final_answer,final_status,adjudication_reason_code,adjudication_status,adjudication_basis,adjudication_disagreement_reason_code',
  v_mu7_export_units: 'unit_id,mode,record_category,family,category,unit_role,mapping_code,assignment_code,assignment_status,parent_row_code,packet_sha256,created_at',
  v_mu7_export_unit_design: 'unit_id,mode,nct_id,frame_id,stratum,frame_stratum_size,n_sampled_in_stratum,selection_probability,sampling_seed,prn_key,allocation_option,overlap_setting,design_version,freeze_status,freeze_gate,design_row_sha256,assignment_set_id,assignment_row_sha256' };
for (const [v, cols] of Object.entries(COLS)) await step(`MU7-EXP-COL-${v}`, 'export', `${v}: column contract of bundle 7.0`, 'owner',
  `select string_agg(column_name, ',' order by ordinal_position) as v from information_schema.columns where table_schema = 'public' and table_name = '${v}'`, { value: cols });
await step('MU7-EXP-04', 'blinding', 'a FORMAL reviewer reads no export row', 'r1', 'select ((select count(*) from public.v_mu7_final_reference) + (select count(*) from public.v_mu7_export_unit_design) + (select count(*) from public.v_mu7_export_units))::int as n', { value: 0 });
await step('MU7-FX-01', 'setup', 'the FORMAL export (bundle 7.0) is registered after the lock', 'inv', `select public.rpc_mu7_register_export(${lit({ mode: 'FORMAL', bundle_format_version: '7.0', row_counts: { units: 8 }, file_sha256: {}, manifest_sha256: '5'.repeat(64), app_git_sha: 'abc123' })})`, { minRows: 1 });
// optional: write the synthetic bundle 7.0 that the analysis tests read (DB -> export -> analysis)
if (bundleDir) {
  fs.mkdirSync(bundleDir, { recursive: true });
  await asWho('inv');
  const csv = (rows) => { if (!rows.length) return ''; const cols = Object.keys(rows[0]); const esc = (v) => { if (v === null || v === undefined) return ''; const s = v instanceof Date ? v.toISOString() : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }; return [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n') + '\n'; };
  const files = {
    'units.csv': (await db.query("select * from public.v_mu7_export_units where mode = 'FORMAL' order by unit_id collate \"C\"")).rows,
    'unit_design.csv': (await db.query("select * from public.v_mu7_export_unit_design where mode = 'FORMAL' order by unit_id collate \"C\"")).rows,
    'independent_judgments.csv': (await db.query("select * from public.v_mu7_independent_judgments where mode = 'FORMAL' order by unit_id collate \"C\", reviewer_slot")).rows,
    'final_reference.csv': (await db.query("select * from public.v_mu7_final_reference where mode = 'FORMAL' order by unit_id collate \"C\"")).rows,
  };
  const freezeRow = (await db.query('select n_units, n_primary, n_subgroup, unit_list_sha256, assignment_set_sha256, design_rows_sha256, queue_sha256, packets_sha256 from public.mu7_freeze')).rows[0];
  const snapRow = (await db.query('select n_rows, content_sha256 from public.mu7_snapshot')).rows[0];
  const designRec = (await db.query('select design_version, assignment_set_id, overlap_setting, n_primary_planned, n_subgroup_planned from public.mu7_design')).rows[0];
  await db.exec('reset role;');
  const man = { bundle_format_version: '7.0', mode: 'FORMAL', status: 'SYNTHETIC: written by rls_tests_v7.mjs from db1 (NCT99 placeholder trials)', design: designRec, freeze: freezeRow, snapshot: snapRow, files: {}, row_counts: {} };
  for (const [name, rows] of Object.entries(files)) { const t = csv(rows); fs.writeFileSync(path.join(bundleDir, name), t); man.files[name] = sha256(t); man.row_counts[name] = rows.length; }
  fs.writeFileSync(path.join(bundleDir, 'manifest.json'), JSON.stringify(man, null, 1) + '\n');
}
await step('MU7-FX-02', 'gate', 'an export is refused when the judgments no longer match the snapshot (a row inserted with triggers off)', 'owner',
  `${replica(`insert into public.mu7_judgments (assignment_id, unit_id, mode, reviewer_pseudo_id, reviewer_slot, revision_number, answer, content_sha256)
     select assignment_id, unit_id, mode, reviewer_pseudo_id, reviewer_slot, 9, 'AGREE', '${'6'.repeat(64)}' from public.mu7_queue where unit_id = '${F.F1.uid}' and reviewer_slot = 1`)}`, { ok: true });
await step('MU7-FX-03', 'gate', 'the export after the tampering is refused (snapshot mismatch)', 'inv', `select public.rpc_mu7_register_export(${lit({ mode: 'FORMAL', bundle_format_version: '7.0', row_counts: {}, file_sha256: {}, manifest_sha256: '5'.repeat(64), app_git_sha: 'abc123' })})`, { error: G(49) }, [], 'MU7-G49');
await step('MU7-FX-04', 'snapshot', 'the snapshot verification reports the mismatch', 'inv', 'select matches::text as v from public.rpc_mu7_verify_snapshot()', { value: 'false' });

// ---- I. Immutability and audit ----------------------------------------------------------------------------------------------
for (const [id, s] of [['MU7-IMM-01', `update public.mu7_judgments set answer = 'DISAGREE' where unit_id = '${F.F1.uid}'`],
                       ['MU7-IMM-02', `delete from public.mu7_units where unit_id = '${F.F1.uid}'`],
                       ['MU7-IMM-03', `update public.mu7_adjudications set decision = 'AGREE' where unit_id = '${F.F3.uid}'`],
                       ['MU7-IMM-04', 'truncate public.mu7_queue cascade'],
                       ['MU7-IMM-05', "update public.mu7_freeze set queue_sha256 = repeat('7', 64)"]]) {
  await step(id, 'immutability', `append-only: ${s.split(' ').slice(0, 3).join(' ')} is refused (owner role)`, 'owner', s, { error: /append-only/ });
}
await step('MU7-AUD-01', 'audit', 'every v7 table that received rows wrote audit rows', 'owner',
  `select count(distinct entity_table)::int as n from public.audit_log where entity_table in (${tl})`, { value: 15 });
await step('MU7-AUD-02', 'audit', 'the audit hash chain is intact (each prev_hash is the previous row_hash)', 'owner',
  'select count(*)::int as n from (select prev_hash, lag(row_hash) over (order by audit_id) as lag_hash, audit_id from public.audit_log) x where x.audit_id > (select min(audit_id) from public.audit_log) and x.prev_hash is distinct from x.lag_hash', { value: 0 });
await step('MU7-AUD-03', 'audit', 'adjudications are audited as a content hash only', 'owner',
  "select count(*)::int as n from public.audit_log where entity_table = 'mu7_adjudications' and (details ? 'decision' or details ? 'rationale')", { value: 0 });
await step('MU7-AUD-04', 'audit', 'unit rows are audited without their packet', 'owner', "select count(*)::int as n from public.audit_log where entity_table = 'mu7_units' and details ? 'packet'", { value: 0 });

// =============================================================================
// db2: overlap ONE_PER_TRIAL and the ordering gates
// =============================================================================
db = await newDb(); const db2 = db; dbLabel = 'db2';
await setupAccounts();
await setupPeople('MU7-D2');
const D2PT1 = await pid('pt1'), D2PT2 = await pid('pt2');
await step('MU7-D2-01', 'setup', 'design v7 with overlap ONE_PER_TRIAL (2 primary, 1 subgroup)', 'inv', recordDesign({ overlap_setting: 'ONE_PER_TRIAL', n_primary_planned: 2, n_subgroup_planned: 1 }), { minRows: 1 });
const OA = { uid: 'MU7-AREA-ONCOLOGY-001', fam: 'AREA', cat: 'ONCOLOGY', code: 'IN_AREA', nct: 'NCT99000301', N: 50, n: 1 };
const OB = { uid: 'MU7-ROW-CAN_ALL-001', fam: 'ROW', cat: 'CAN_ALL', code: 'IN_ROW', nct: 'NCT99000301', N: 40, n: 1 };
const OC = { uid: 'MU7-ROW-COPD-001', fam: 'ROW', cat: 'COPD', code: 'IN_ROW', nct: 'NCT99000302', N: 30, n: 1 };
const O1 = { overlap: 'ONE_PER_TRIAL' };
await step('MU7-D2-02', 'setup', 'first unit of trial NCT99000301 imported', 'inv', imp(importObj(OA, O1)), { value: OA.uid });
await step('MU7-D2-03', 'overlap', 'ONE_PER_TRIAL: a second unit of the same trial is refused', 'inv', imp(importObj(OB, O1)), { error: G(24) }, [], 'MU7-G24');
await step('MU7-D2-04', 'overlap', 'ONE_PER_TRIAL: a unit of another trial is accepted', 'inv', imp(importObj(OC, O1)), { value: OC.uid });
await step('MU7-D2-05', 'refusal', 'a FORMAL design row with another overlap setting than the design is refused', 'inv', imp(importObj({ uid: 'MU7-ROW-AST-001', fam: 'ROW', cat: 'AST', code: 'IN_ROW', nct: 'NCT99000303', N: 9, n: 1 }, { overlap: 'ALLOW' })), { error: G(20) }, [], 'MU7-G20');
await step('MU7-D2-06', 'gate', 'the freeze needs the planned subgroup unit', 'inv', `select public.rpc_mu7_freeze(${lit({ unit_list_sha256: '1'.repeat(64), assignment_set_sha256: '1'.repeat(64), design_rows_sha256: '1'.repeat(64), queue_sha256: '1'.repeat(64), attestation: ATT })})`, { error: G(26) }, [], 'MU7-G26');
await step('MU7-D2-07', 'setup', 'a subgroup unit row without design row or assignment (inserted with triggers off)', 'owner',
  replica(`insert into public.mu7_units (unit_id, mode, record_category, family, category, unit_role, mapping_code, assignment_code, assignment_status, parent_row_code, packet, packet_sha256, created_by)
           values ('MU7-SG-RULE_K_REMOVED-001', 'FORMAL', 'MAPPING_UNIT_FORMAL', 'SG', 'RULE_K_REMOVED', 'SUBGROUP', 'RULE_K', 'K_REMOVE_VERIFIED_NONMALIGNANT', 'ASSIGNED', 'FIG2_ROW_CAN_ALL', '{}', '${'0'.repeat(64)}', '${await uid('inv')}')`), { ok: true });
await step('MU7-D2-08', 'gate', 'the freeze needs a design row and a frozen assignment for every FORMAL unit', 'inv', `select public.rpc_mu7_freeze(${lit({ unit_list_sha256: '1'.repeat(64), assignment_set_sha256: '1'.repeat(64), design_rows_sha256: '1'.repeat(64), queue_sha256: '1'.repeat(64), attestation: ATT })})`, { error: G(27) }, [], 'MU7-G27');
await step('MU7-D2-09', 'gate', 'the snapshot is refused before any close', 'inv', 'select public.rpc_mu7_snapshot()', { error: G(46) }, [], 'MU7-G46');
await step('MU7-D2-10', 'gate', 'the formal phase cannot close while it is not open', 'inv', phase('FORMAL_CLOSED_INCOMPLETE'), { error: G(45) }, [], 'MU7-G45');
await step('MU7-D2-11', 'gate', 'the formal phase cannot open before the sign-off', 'inv', phase('FORMAL_OPENED'), { error: G(44) }, [], 'MU7-G44');
await step('MU7-D2-12', 'setup', 'a FORMAL reviewer row for r1 inserted with triggers off (to reach the queue gate)', 'owner',
  replica(`insert into public.reviewers (reviewer_pseudo_id, user_id, mode_scope, qualifications_summary, enrolled_by) values ('R-TST1', '${await uid('r1')}', 'FORMAL', 'synthetic', '${await uid('inv')}')`), { ok: true });
await step('MU7-D2-13', 'gate', 'the FORMAL queue is refused before the sign-off and the freeze', 'inv', queue('FORMAL', [OA.uid, OC.uid], null, 'R-TST1'), { error: G(31) }, [], 'MU7-G31');
// a one-unit pilot to reach the incomplete-pilot lock gate
const PX = { uid: 'SYN7-AREA-ONCOLOGY-001', fam: 'AREA', cat: 'ONCOLOGY', code: 'IN_AREA', nct: 'SYN-NCT-9301', N: 40, n: 4 };
await step('MU7-D2-14', 'setup', 'a pilot unit', 'inv', imp(importObj(PX, { mode: 'PILOT' })), { value: PX.uid });
await step('MU7-D2-15', 'setup', 'its pilot queue', 'inv', queue('PILOT', [PX.uid], [PX.uid], D2PT1, D2PT2), { value: 2 });
await step('MU7-D2-16', 'gate', 'the pilot reference cannot lock while a pilot unit lacks an answer', 'inv', `select public.rpc_mu7_lock_reference('PILOT', '${ATT}')`, { error: G(48) }, [], 'MU7-G48');
await step('MU7-D2-17', 'workflow', 'pt1 answers the pilot unit', 'pt1', await submit('pt1', D2PT1, PX.uid, { answer: 'AGREE' }), { minRows: 1 });
await step('MU7-D2-18', 'gate', 'a unit answered by one reviewer is not adjudicated (routing INCOMPLETE)', 'adj', adjud({ unit_id: PX.uid, decision: 'AGREE', status: 'DISCORDANT_RESOLVED', basis: 'REVIEWER_1', rationale: 'synthetic' }), { error: G(39) }, [], 'MU7-G39');

// =============================================================================
// db3: an earlier design exists, so design v7 cannot be recorded
// =============================================================================
db = await newDb(); const db3 = db; dbLabel = 'db3';
await setupAccounts();
await step('MU7-D3-00', 'setup', 'investigator claims the bootstrapped account', 'inv', 'select public.rpc_claim_account() as uid', { minRows: 1 });
await step('MU7-D3-01', 'setup', 'a v5 activation seeded with triggers off (stands for a database that started the v5 or v6 review)', 'owner',
  replica(`insert into public.tlv5_activation (design_version, adjudication_scope, attestation, activated_by) values ('SYN-5', 'DISAGREEMENTS_ONLY', '${ATT}', '${await uid('inv')}')`), { ok: true });
await step('MU7-D3-02', 'exclusion', 'design v7 cannot be recorded in a database that holds an earlier formal design', 'inv', recordDesign(), { error: G('02') }, [], 'MU7-G02');

// ---- summary ---------------------------------------------------------------------------------------------------------------------
const engine = await q1('select version() as v');
const by = (k) => results.reduce((m, r) => { m[r[k]] = m[r[k]] || { n: 0, pass: 0 }; m[r[k]].n += 1; m[r[k]].pass += r.pass ? 1 : 0; return m; }, {});
const tags = [...new Set(results.filter((r) => r.tag).map((r) => r.tag))].sort();
const summary = { engine, mutation: MUTATION || null, drop_constraint: DROP || null, n: results.length, pass: results.filter((r) => r.pass).length,
  fail: results.filter((r) => !r.pass).length, by_area: by('area'), by_db: by('db'), by_identity: by('who'), tags_tested: tags,
  migration_sha256: sha256(fs.readFileSync(mNNNN, 'utf8')) };
fs.writeFileSync(outPath, JSON.stringify({ summary, results }, null, 1));
fs.writeFileSync(sqlOutPath, '-- Generated by rls_tests_v7.mjs: every statement the suite runs, in order, with identity, tag and expectation.\n' +
  "-- Identity switch before each statement: reset role; select set_config('request.jwt.claims', <claims json>, false); set role authenticated;\n\n" + sqlLog.join('\n'));
console.log(JSON.stringify({ n: summary.n, pass: summary.pass, fail: summary.fail, mutation: summary.mutation, drop_constraint: summary.drop_constraint }));
for (const r of results.filter((r) => !r.pass)) console.log('FAIL', r.db, r.id, r.desc, '|', r.actual);
await db1.close(); await db2.close(); await db3.close();
