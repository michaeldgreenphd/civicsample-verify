/* eslint-disable */
// SYNTHETIC ENGINEERING ONLY. Preserved supplied regression logic; see docs/HANDOFF_TESTS.md.
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import fs from 'fs';

const [shimPath, schemaPath, outPath, sqlOutPath] = process.argv.slice(2);
const db = await PGlite.create({ extensions: { pgcrypto } });

// ---- identities (synthetic) ---------------------------------------------------------------
const P = {
  inv:  { sub: '00000000-0000-4000-8000-0000000000a1', email: 'investigator@example.test', aal: 'aal2' },
  inv1: { sub: '00000000-0000-4000-8000-0000000000a1', email: 'investigator@example.test', aal: 'aal1' },
  pt1:  { sub: '00000000-0000-4000-8000-0000000000b1', email: 'pilot1@example.test', aal: 'aal1' },
  pt2:  { sub: '00000000-0000-4000-8000-0000000000b2', email: 'pilot2@example.test', aal: 'aal1' },
  r1:   { sub: '00000000-0000-4000-8000-0000000000c1', email: 'reviewer1@example.test', aal: 'aal1' },
  r2:   { sub: '00000000-0000-4000-8000-0000000000c2', email: 'reviewer2@example.test', aal: 'aal1' },
  out:  { sub: '00000000-0000-4000-8000-0000000000d1', email: 'outsider@example.test', aal: 'aal1' },
};
const results = [];
const sqlLog = [];
let ctx = {};          // ids captured during the run (assignment ids, review ids, export id)

async function asWho(who) {
  await db.exec('reset role;');
  if (who === 'owner') return;
  if (who === 'anon') {
    await db.query("select set_config('request.jwt.claims', '', false)");
    await db.exec('set role anon;');
    return;
  }
  const c = JSON.stringify(P[who]);
  await db.query("select set_config('request.jwt.claims', $1, false)", [c]);
  await db.exec('set role authenticated;');
}

// expect: {rows: n} exact row count | {minRows: n} | {error: regex} | {ok: true} | {value: v} (first column of first row)
async function step(id, area, desc, who, sql, expect, params = []) {
  const s = typeof sql === 'function' ? sql() : sql;
  sqlLog.push(`-- ${id} [${area}] as ${who}: ${desc}\n-- expect: ${JSON.stringify(expect, (k, v) => v instanceof RegExp ? v.source : v)}\n${s};\n`);
  let actual, pass, err = null, rows = null;
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
    }
    else { pass = true; actual = `ok; ${rows.length} rows` + (rows.length ? `; first value ${JSON.stringify(Object.values(rows[0])[0])}` : ''); }
  } catch (e) {
    err = e.message;
    if (expect.error) { pass = expect.error.test(err); actual = `error: ${err}`; }
    else { pass = false; actual = `error: ${err}`; }
  }
  await db.exec('reset role;');
  results.push({ id, area, desc, who, expect: JSON.stringify(expect, (k, v) => v instanceof RegExp ? v.source : v),
                 actual: actual.slice(0, 400), pass });
  return rows;
}

async function setup() {
  await db.exec(fs.readFileSync(shimPath, 'utf8'));
  await db.exec(fs.readFileSync(schemaPath, 'utf8'));
  // bootstrap (what scripts/bootstrap_investigator.py does with the service role)
  for (const k of ['inv', 'pt1', 'pt2', 'r1', 'r2', 'out']) {
    await db.query('insert into auth.users (id, email) values ($1, $2) on conflict do nothing', [P[k].sub, P[k].email]);
  }
  await db.query("insert into public.users (email, display_name, role) values ($1, 'Test Investigator', 'INVESTIGATOR')", [P.inv.email]);
}

function packet(i, withL2) {
  const p = { schema_version: '1.0', case_title: `Synthetic condition ${i} in a synthetic area`,
              question: 'Does the descriptor belong to the area?',
              unit: { unit_type: 'DESCRIPTOR_AREA', unit_id: `SYN-D00${i}::infectious` },
              descriptor: { descriptor_ui: `SYN-D00${i}`, name: `Synthetic condition ${i} (fictional)` },
              mesh: { scope_note: 'SYNTHETIC TEXT FOR APP TESTING ONLY.', tree_numbers: ['C01.999'] },
              area: { key: 'infectious', label: 'Infectious' },
              notices: ['SYNTHETIC CASE: excluded from all statistics'] };
  if (withL2) { p.ppr_rows = [{ condition_row: 'Synthetic row', benchmark_id: 'SYN-BM' }];
                p.benchmark = { value: 0.5, source: 'synthetic' }; }
  return p;
}
function design(i, mode) {
  return { unit_id: `SYN-D00${i}::infectious`, descriptor_ui: `SYN-D00${i}`, descriptor_name: `Synthetic ${i}`,
           area: 'infectious', primary_stratum: 'SYN_STRATUM', selection_probability: 0.5, frame_stratum_size: 20,
           sampling_design_version: 'SYN-1', sampling_seed: 1, trial_frequency_weight: 3, n_trials_primary: 3,
           original_l1_decision: 'INCLUDE', source_file: 'synthetic', source_row_sha256: 'a'.repeat(64) };
}

await setup();
const VS = '1.0.0+R-TEST';
const caseJson = (id, mode, i, l2) => JSON.stringify({ case_id: id, mode, unit_type: 'DESCRIPTOR_AREA', version_set_id: VS,
  l1_applicable: true, l2_applicable: !!l2, l3_applicable: !!l2, packet: packet(i, l2), change_reason: 'initial import',
  design: design(i, mode) });

// ---------------- A. accounts, MFA, roles ----------------
await step('AUTH-01', 'auth', 'investigator claims the bootstrapped account', 'inv', 'select public.rpc_claim_account() as uid', { minRows: 1 });
await step('AUTH-02', 'auth', 'investigator session with aal2 is an investigator session', 'inv',
  'select investigator_session_ok from public.rpc_whoami()', { value: true });
await step('AUTH-03', 'auth', 'investigator without a second factor (aal1) is refused investigator actions', 'inv1',
  "select public.rpc_register_user('x@example.test','X','REVIEWER',false)", { error: /investigator role/ });
await step('AUTH-04', 'auth', 'outsider without an invitation cannot claim an account', 'out',
  'select public.rpc_claim_account()', { error: /no active invitation/ });
await step('AUTH-05', 'auth', 'anon role cannot read any table', 'anon', 'select * from public.cases', { error: /permission denied/ });
for (const [k, pilot] of [['pt1', true], ['pt2', true], ['r1', false], ['r2', false]]) {
  await step(`SETUP-USER-${k}`, 'setup', `investigator registers ${k}`, 'inv',
    `select public.rpc_register_user('${P[k].email}', 'Synthetic ${k}', 'REVIEWER', ${pilot})`, { minRows: 1 });
}
const uid = async (email) => (await db.query('select user_id from public.users where email=$1', [email])).rows[0].user_id;
for (const k of ['pt1', 'pt2']) {
  await step(`SETUP-ENROLL-${k}`, 'setup', `enroll ${k} as PILOT reviewer`, 'inv',
    `select public.rpc_enroll_reviewer('${await uid(P[k].email)}', 'PILOT', 'synthetic pilot test account')`, { minRows: 1 });
}
await step('GATE-01', 'gate', 'FORMAL reviewer cannot be enrolled before the pilot sign-off', 'inv',
  `select public.rpc_enroll_reviewer('${await uid(P.r1.email)}', 'FORMAL', null)`, { error: /only after the pilot sign-off/ });
await step('SETUP-VERSION', 'setup', 'register a synthetic version set', 'inv',
  `select public.rpc_register_ontology_version('${JSON.stringify({ ontology_version: '1.0.0', rule_version: '1.0.0', rubric_version: 'R-TEST',
     classification_schema_version: '1.0.0', protocol_version: 'P-TEST', sampling_design_version: 'SYN-1',
     ontology_sha256: 'b'.repeat(64), classification_schema_sha256: 'c'.repeat(64), rubric_sha256: 'd'.repeat(64),
     frozen_at: '2026-10-13T00:00:00Z', notes: 'synthetic' })}'::jsonb)`, { value: VS });

// ---------------- B. imports and packet blinding ----------------
for (let i = 1; i <= 10; i++) {
  const id = `SYN-0${String(i).padStart(2, '0')}`;
  await step(`SETUP-CASE-${id}`, 'setup', `import pilot case ${id}`, 'inv', `select public.rpc_import_case('${caseJson(id, 'PILOT', i, i <= 3)}'::jsonb)`, { value: id });
  await step(`SETUP-AI-${id}`, 'setup', `import a synthetic AI record for ${id}`, 'inv',
    `select public.rpc_import_ai_classification('${JSON.stringify({ case_id: id, mode: 'PILOT', stage: 'A', layer: 'clinical_classification',
      source_record_id: `A:SYN:${id}`, ai_status_raw: 'INCLUDE', ai_status_mapped: 'INCLUDE', confidence: 'HIGH',
      rationale: 'synthetic AI rationale', rule_ids: ['GEN-03'], source_file: 'synthetic', source_line_sha256: 'e'.repeat(64) })}'::jsonb)`, { minRows: 1 });
}
await step('SETUP-STRATUM', 'setup', 'import a synthetic sampling stratum', 'inv',
  `select public.rpc_import_sampling_stratum('${JSON.stringify({ sampling_design_version: 'SYN-1', primary_stratum: 'SYN_STRATUM', mode: 'PILOT',
     frame_stratum_size: 20, n_sampled: 10, selection_probability: 0.5 })}'::jsonb)`, { ok: true });
const badPacket = (k, v) => JSON.stringify({ case_id: 'SYN-099', mode: 'PILOT', unit_type: 'DESCRIPTOR_AREA', version_set_id: VS,
  l1_applicable: true, l2_applicable: false, l3_applicable: false, packet: Object.assign(packet(99, false), k), design: design(99, 'PILOT') });
await step('BLIND-01', 'blinding', 'packet with a nested AI status key is rejected at import', 'inv',
  `select public.rpc_import_case('${badPacket({ descriptor: { name: 'x', ai_status: 'INCLUDE' } })}'::jsonb)`, { error: /looks like blinded content/ });
await step('BLIND-02', 'blinding', 'packet with a sampling weight key is rejected at import', 'inv',
  `select public.rpc_import_case('${badPacket({ unit: { sampling_weight: 8.4 } })}'::jsonb)`, { error: /looks like blinded content/ });
await step('BLIND-03', 'blinding', 'packet with a reviewer-invisible top-level key is rejected at import', 'inv',
  `select public.rpc_import_case('${badPacket({ provisional_status: 'INCLUDE' })}'::jsonb)`, { error: /allow list/ });
await step('BLIND-04', 'blinding', 'packet with a rationale-bearing confidence key is rejected at import', 'inv',
  `select public.rpc_import_case('${badPacket({ mesh: { confidence: 'HIGH' } })}'::jsonb)`, { error: /looks like blinded content/ });
await step('GATE-02', 'gate', 'FORMAL case cannot be imported before the pilot sign-off', 'inv',
  `select public.rpc_import_case('${caseJson('REV-T01', 'FORMAL', 1, false)}'::jsonb)`, { error: /only after the pilot sign-off/ });
await step('MODE-01', 'mode', 'a PILOT case id without the SYN- prefix is rejected', 'inv',
  `select public.rpc_import_case('${caseJson('REV-T02', 'PILOT', 2, false)}'::jsonb)`, { error: /check constraint|violates/ });

// ---------------- C. assignments ----------------
const pid = async (k) => (await db.query('select r.reviewer_pseudo_id from public.reviewers r join public.users u using (user_id) where u.email=$1', [P[k].email])).rows[0].reviewer_pseudo_id;
const PT1 = await pid('pt1'), PT2 = await pid('pt2');
const pilotIds = Array.from({ length: 10 }, (_, i) => `'SYN-0${String(i + 1).padStart(2, '0')}'`).join(',');
await step('SETUP-ASSIGN-1', 'setup', 'assign all pilot cases to slot 1', 'inv', `select public.rpc_assign_cases('PILOT','${PT1}',1,array[${pilotIds}],20261013)`, { value: 10 });
await step('SETUP-ASSIGN-2', 'setup', 'assign all pilot cases to slot 2', 'inv', `select public.rpc_assign_cases('PILOT','${PT2}',2,array[${pilotIds}],20261013)`, { value: 10 });
await step('ASSIGN-01', 'roles', 'a reviewer cannot assign cases', 'pt1', `select public.rpc_assign_cases('PILOT','${PT1}',1,array['SYN-001'],1)`, { error: /investigator role/ });
const asg = async (k, c) => (await db.query('select assignment_id from public.assignments a where a.reviewer_pseudo_id=$1 and a.case_id=$2', [k, c])).rows[0].assignment_id;

// ---------------- D. reviewer reads (blinding by RLS, before any submission) ----------------
await step('SETUP-CLAIM-pt1', 'setup', 'pt1 claims account', 'pt1', 'select public.rpc_claim_account()', { minRows: 1 });
await step('SETUP-CLAIM-pt2', 'setup', 'pt2 claims account', 'pt2', 'select public.rpc_claim_account()', { minRows: 1 });
const blindedTables = ['ai_classifications', 'sampling_strata', 'case_design', 'adjudications', 'exports', 'audit_log',
                       'review_phase_events', 'app_settings'];
for (const t of blindedTables) {
  await step(`RLS-R-${t}`, 'blinding', `reviewer reads ${t}: zero rows`, 'pt1', `select * from public.${t}`, { rows: 0 });
}
await step('RLS-R-ai-columns', 'blinding', 'reviewer cannot read AI confidence or rationale columns (zero rows)', 'pt1',
  'select confidence, rationale, rule_ids, model_id from public.ai_classifications', { rows: 0 });
await step('RLS-R-users', 'blinding', 'reviewer sees only their own users row', 'pt1', 'select * from public.users', { rows: 1 });
await step('RLS-R-reviewers', 'blinding', 'reviewer sees only their own reviewers row', 'pt1', 'select * from public.reviewers', { rows: 1 });
await step('RLS-R-cases', 'blinding', 'reviewer sees only assigned cases', 'pt1', 'select * from public.cases', { rows: 10 });
await step('RLS-R-assignments', 'blinding', 'reviewer sees only own assignments (not slot 2)', 'pt1', 'select * from public.assignments', { rows: 10 });
await step('RLS-R-queue', 'blinding', 'v_my_queue returns own queue only', 'pt1', 'select * from public.v_my_queue', { rows: 10 });
await step('RLS-R-queue-cols', 'blinding', 'v_my_queue exposes no decision, AI, stratum or weight column', 'pt1',
  "select column_name from information_schema.columns where table_schema='public' and table_name='v_my_queue' and column_name ~* '(decision|ai_|stratum|weight|confidence|rationale|adjudic|selection)'", { rows: 0 });
await step('RLS-R-packets', 'blinding', 'no assigned packet carries a blinded key (text scan)', 'pt1',
  "select case_id from public.case_versions where packet::text ~* '\"(ai_[a-z_]*|stratum|selection_probability|sampling_weight|confidence|rationale|decision|adjudication|original_technical_membership)\"'", { rows: 0 });
await step('RLS-R-analysis', 'blinding', 'reviewer reads v_analysis_export: zero rows', 'pt1', 'select * from public.v_analysis_export', { rows: 0 });
await step('RLS-R-adjview', 'blinding', 'reviewer reads v_effective_adjudications: zero rows', 'pt1', 'select * from public.v_effective_adjudications', { rows: 0 });
await step('RLS-R-insert', 'roles', 'reviewer cannot INSERT into reviews directly', 'pt1',
  `insert into public.reviews (assignment_id) values ('${await asg(PT1, 'SYN-001')}')`, { error: /permission denied/ });
await step('RLS-R-update', 'roles', 'reviewer cannot UPDATE cases directly', 'pt1', "update public.cases set withdrawn_reason='x'", { error: /permission denied/ });
await step('RLS-R-delete', 'roles', 'reviewer cannot DELETE assignments directly', 'pt1', 'delete from public.assignments', { error: /permission denied/ });
await step('RPC-R-import', 'roles', 'reviewer cannot import cases', 'pt1', `select public.rpc_import_case('${caseJson('SYN-050', 'PILOT', 50, false)}'::jsonb)`, { error: /investigator role/ });
await step('RPC-R-ai', 'roles', 'reviewer cannot import AI records', 'pt1',
  `select public.rpc_import_ai_classification('{"case_id":"SYN-001","mode":"PILOT","stage":"B","layer":"clinical_classification","source_record_id":"x","ai_status_raw":"INCLUDE","source_file":"x","source_line_sha256":"${'f'.repeat(64)}"}'::jsonb)`, { error: /investigator role/ });
await step('RPC-R-summary', 'roles', 'reviewer cannot call the completion summary', 'pt1', "select * from public.rpc_completion_summary('PILOT')", { error: /investigator role/ });
await step('RPC-R-private', 'roles', 'reviewer cannot call a private writer function', 'pt1', "select private.write_audit('X','x',null,null,'{}'::jsonb)", { error: /permission denied/ });

// ---------------- E. drafts, submissions, cross-reviewer isolation ----------------
await step('DRAFT-01', 'workflow', 'pt1 saves a draft on own assignment', 'pt1', `select public.rpc_save_draft('${await asg(PT1, 'SYN-001')}', '{"l1_decision":"INCLUDE"}'::jsonb)`, { minRows: 1 });
await step('DRAFT-02', 'blinding', 'pt2 cannot read pt1 drafts', 'pt2', 'select * from public.review_drafts', { rows: 0 });
await step('DRAFT-03', 'blinding', 'investigator cannot read reviewer drafts', 'inv', 'select * from public.review_drafts', { rows: 0 });
await step('DRAFT-04', 'roles', 'pt2 cannot save a draft on pt1 assignment', 'pt2', `select public.rpc_save_draft('${await asg(PT1, 'SYN-001')}', '{}'::jsonb)`, { error: /not your active assignment/ });
await step('SUBMIT-01', 'workflow', 'pt1 submits a review (layer 1 only case)', 'pt1',
  `select public.rpc_submit_review('${await asg(PT1, 'SYN-004')}', '{"l1_decision":"INCLUDE","l1_rationale":"synthetic"}'::jsonb)`, { minRows: 1 });
await step('SUBMIT-02', 'roles', 'pt2 cannot submit on pt1 assignment', 'pt2',
  `select public.rpc_submit_review('${await asg(PT1, 'SYN-005')}', '{"l1_decision":"INCLUDE"}'::jsonb)`, { error: /not your active assignment/ });
await step('XREV-01', 'blinding', "pt2 cannot read pt1's submitted review", 'pt2', 'select * from public.reviews', { rows: 0 });
await step('XREV-02', 'blinding', "pt2 cannot see pt1's review through v_effective_reviews", 'pt2', 'select * from public.v_effective_reviews', { rows: 0 });
await step('XREV-03', 'blinding', "pt2's queue shows no status derived from pt1's work", 'pt2',
  "select * from public.v_my_queue where case_id='SYN-004' and queue_status <> 'NOT_STARTED'", { rows: 0 });
await step('THREE-01', 'three-state', 'missing decision on an applicable layer is rejected', 'pt1',
  `select public.rpc_submit_review('${await asg(PT1, 'SYN-005')}', '{"l1_rationale":"no decision"}'::jsonb)`, { error: /each applicable layer needs a decision/ });
const rid = (rows) => (rows && rows[0]) ? Object.values(rows[0])[0] : '00000000-0000-4000-8000-000000000000';
const t2 = await step('THREE-02a', 'three-state', 'submit a layer 2 answer on a layer-1-only case', 'pt1',
  `select public.rpc_submit_review('${await asg(PT1, 'SYN-006')}', '{"l1_decision":"EXCLUDE","l2_decision":"COMPATIBLE"}'::jsonb) as rid`, { minRows: 1 });
await step('THREE-02b', 'three-state', 'the non-applicable layers are stored as NULL (state 3)', 'pt1',
  `select (l2_decision is null and l3_decision is null) as ok from public.reviews where review_id = '${rid(t2)}'`, { value: true });
const t3 = await step('THREE-03a', 'three-state', 'submit INSUFFICIENT_INFORMATION on layer 1', 'pt1',
  `select public.rpc_submit_review('${await asg(PT1, 'SYN-007')}', '{"l1_decision":"INSUFFICIENT_INFORMATION"}'::jsonb) as rid`, { minRows: 1 });
await step('THREE-03b', 'three-state', 'INSUFFICIENT_INFORMATION is stored as a decision, distinct from NULL (state 2)', 'pt1',
  `select l1_decision from public.reviews where review_id = '${rid(t3)}'`, { value: 'INSUFFICIENT_INFORMATION' });
await step('DEP-01', 'dependency', 'benchmark INCOMPATIBLE with PPR VALID is rejected', 'pt1',
  `select public.rpc_submit_review('${await asg(PT1, 'SYN-001')}', '{"l1_decision":"INCLUDE","l2_decision":"INCOMPATIBLE","l3_decision":"VALID"}'::jsonb)`, { error: /fixes the PPR decision at INVALID/ });
const d2 = await step('DEP-02a', 'dependency', 'submit benchmark INCOMPATIBLE without a PPR answer', 'pt1',
  `select public.rpc_submit_review('${await asg(PT1, 'SYN-001')}', '{"l1_decision":"INCLUDE","l2_decision":"INCOMPATIBLE"}'::jsonb) as rid`, { minRows: 1 });
await step('DEP-02b', 'dependency', 'benchmark INCOMPATIBLE derives PPR INVALID (flagged as derived)', 'pt1',
  `select l3_decision || ':' || l3_derived_from_l2::text from public.reviews where review_id = '${rid(d2)}'`, { value: 'INVALID:true' });
await step('APPEND-01', 'immutability', 'UPDATE of a review is rejected even for the owner role', 'owner', "update public.reviews set l1_rationale='edited'", { error: /append-only/ });
await step('APPEND-02', 'immutability', 'DELETE of a review is rejected even for the owner role', 'owner', 'delete from public.reviews', { error: /append-only/ });
await step('APPEND-03', 'immutability', 'TRUNCATE of the audit log is rejected', 'owner', 'truncate public.audit_log', { error: /append-only/ });
await step('INV-PILOT-READ', 'roles', 'investigator may read PILOT reviews (by design)', 'inv', "select * from public.reviews where mode='PILOT'", { minRows: 1 });
await step('ADJ-01', 'adjudication', 'PILOT adjudication needs both reviewer slots', 'inv',
  `select public.rpc_record_adjudication('SYN-004','clinical_classification','INCLUDE',null,'CONCORDANT_CONFIRMED','REVIEWER_1','synthetic',null,array[(select review_id from public.reviews where case_id='SYN-004' limit 1)],null,null,false)`, { error: /both pilot reviewer slots/ });

// complete the pilot: both slots review all 10 cases, the investigator adjudicates each
for (const [k, P_] of [['pt1', PT1], ['pt2', PT2]]) {
  for (let i = 1; i <= 10; i++) {
    const c = `SYN-0${String(i).padStart(2, '0')}`;
    const has = (await db.query('select 1 from public.reviews r join public.assignments a using (assignment_id) where a.reviewer_pseudo_id=$1 and r.case_id=$2', [P_, c])).rows.length;
    if (has) continue;
    const body = i <= 3 ? '{"l1_decision":"INCLUDE","l2_decision":"COMPATIBLE","l2_caveat":true,"l2_caveat_text":"synthetic","l3_decision":"VALID"}' : '{"l1_decision":"INCLUDE"}';
    await step(`PILOT-${k}-${c}`, 'setup', `${k} submits ${c}`, k, `select public.rpc_submit_review('${await asg(P_, c)}', '${body}'::jsonb)`, { minRows: 1 });
  }
}
await step('ADJ-02', 'adjudication', 'a reviewer cannot adjudicate', 'pt1',
  `select public.rpc_record_adjudication('SYN-008','clinical_classification','INCLUDE',null,'CONCORDANT_CONFIRMED','BOTH_REVIEWERS','synthetic',null,array[]::uuid[],null,null,false)`, { error: /investigator role/ });
for (let i = 1; i <= 10; i++) {
  const c = `SYN-0${String(i).padStart(2, '0')}`;
  await step(`PILOT-ADJ-${c}`, 'setup', `investigator adjudicates ${c} layer 1`, 'inv',
    `select public.rpc_record_adjudication('${c}','clinical_classification','INCLUDE',null,'CONCORDANT_CONFIRMED','BOTH_REVIEWERS','synthetic adjudication',null,array(select review_id from public.v_effective_reviews where case_id='${c}'),null,null,false)`, { minRows: 1 });
}
await step('ADJ-03', 'blinding', 'reviewer still cannot read adjudications after they exist', 'pt2', 'select * from public.adjudications', { rows: 0 });
await step('ADJ-04', 'adjudication', 'a second adjudication must supersede the current one', 'inv',
  "select public.rpc_record_adjudication('SYN-001','clinical_classification','EXCLUDE',null,'CONCORDANT_REVISED','NEITHER','synthetic',null,array(select review_id from public.v_effective_reviews where case_id='SYN-001'),null,null,false)", { error: /must supersede the current one/ });
await step('LOCK-01', 'workflow', 'adjudicated PILOT case is closed to further submissions', 'pt1',
  `select public.rpc_submit_review('${await asg(PT1, 'SYN-002')}', '{"l1_decision":"EXCLUDE","l2_decision":"COMPATIBLE","l3_decision":"VALID"}'::jsonb)`, { error: /closed/ });

// ---------------- F. pilot-before-formal gate ----------------
await step('GATE-03', 'gate', 'unlock refused without a PILOT export', 'inv',
  `select public.rpc_unlock_formal_review('PAC-1','${'1'.repeat(64)}','abc123','00000000-0000-4000-8000-000000000999','Synthetic attestation for testing only.')`, { error: /PILOT export|foreign key/ });
const ex = await step('SETUP-EXPORT', 'setup', 'register a PILOT export', 'inv',
  `select public.rpc_register_export('${JSON.stringify({ mode: 'PILOT', export_type: 'ANALYSIS', export_format_version: '1', version_set_id: VS,
     ontology_version: '1.0.0', rule_version: '1.0.0', rubric_version: 'R-TEST', classification_schema_version: '1.0.0', sampling_design_version: 'SYN-1',
     app_git_sha: 'abc123', row_counts: { rows: 10 }, file_sha256: { 'x.csv': '2'.repeat(64) } })}'::jsonb) as eid`, { minRows: 1 });
const exportId = ex && ex[0] ? ex[0].eid : null;
await step('GATE-04', 'gate', 'reviewer cannot unlock the formal review', 'pt1',
  `select public.rpc_unlock_formal_review('PAC-1','${'1'.repeat(64)}','abc123','${exportId}','Synthetic attestation for testing only.')`, { error: /investigator role/ });
await step('GATE-05', 'gate', 'investigator unlocks after a complete pilot and a PILOT export', 'inv',
  `select public.rpc_unlock_formal_review('PAC-1','${'1'.repeat(64)}','abc123','${exportId}','Synthetic attestation for testing only.')`, { minRows: 1 });
await step('GATE-06', 'gate', 'a second unlock is refused', 'inv',
  `select public.rpc_unlock_formal_review('PAC-1','${'1'.repeat(64)}','abc123','${exportId}','Synthetic attestation for testing only.')`, { error: /already unlocked/ });

// ---------------- G. FORMAL phase: mode separation, no interim looks ----------------
for (const k of ['r1', 'r2']) {
  await step(`SETUP-ENROLL-${k}`, 'setup', `enroll ${k} as FORMAL reviewer`, 'inv', `select public.rpc_enroll_reviewer('${await uid(P[k].email)}', 'FORMAL', 'synthetic qualifications')`, { minRows: 1 });
}
await step('MODE-02', 'mode', 'a pilot test account cannot hold a FORMAL reviewer row', 'inv',
  `select public.rpc_enroll_reviewer('${await uid(P.pt1.email)}', 'FORMAL', null)`, { error: /pilot test accounts|unique|duplicate/ });
for (const c of ['REV-T01', 'REV-T02', 'REV-T03']) {
  await step(`SETUP-FCASE-${c}`, 'setup', `import synthetic FORMAL test case ${c}`, 'inv', `select public.rpc_import_case('${caseJson(c, 'FORMAL', 7, false)}'::jsonb)`, { value: c });
}
const R1 = await pid('r1'), R2 = await pid('r2');
await step('MODE-03', 'mode', 'a FORMAL case cannot be assigned to a PILOT reviewer', 'inv', `select public.rpc_assign_cases('FORMAL','${PT1}',1,array['REV-T01'],7)`, { error: /mode contamination|slot|foreign key/ });
await step('MODE-04', 'mode', 'a PILOT case cannot be assigned to a FORMAL reviewer', 'inv', `select public.rpc_assign_cases('PILOT','${R1}',1,array['SYN-001'],7)`, { error: /mode contamination|violates/ });
await step('SETUP-FASSIGN-1', 'setup', 'assign FORMAL cases to r1 slot 1', 'inv', `select public.rpc_assign_cases('FORMAL','${R1}',1,array['REV-T01','REV-T02','REV-T03'],7)`, { value: 3 });
await step('SETUP-FASSIGN-2', 'setup', 'assign FORMAL cases to r2 slot 2', 'inv', `select public.rpc_assign_cases('FORMAL','${R2}',2,array['REV-T01','REV-T02','REV-T03'],7)`, { value: 3 });
await step('SETUP-CLAIM-r1', 'setup', 'r1 claims account', 'r1', 'select public.rpc_claim_account()', { minRows: 1 });
await step('SETUP-CLAIM-r2', 'setup', 'r2 claims account', 'r2', 'select public.rpc_claim_account()', { minRows: 1 });
await step('FORMAL-R-pilot', 'mode', 'a FORMAL reviewer sees no PILOT case', 'r1', "select * from public.cases where mode='PILOT'", { rows: 0 });
await step('FORMAL-SUBMIT', 'workflow', 'r1 submits a FORMAL review', 'r1', `select public.rpc_submit_review('${await asg(R1, 'REV-T01')}', '{"l1_decision":"EXCLUDE"}'::jsonb)`, { minRows: 1 });
await step('FORMAL-XREV', 'blinding', "r2 cannot read r1's FORMAL review", 'r2', 'select * from public.reviews', { rows: 0 });
await step('FORMAL-NOLOOK-1', 'interim', 'investigator cannot read FORMAL reviews while the phase is open', 'inv', "select * from public.reviews where mode='FORMAL'", { rows: 0 });
await step('FORMAL-NOLOOK-2', 'interim', 'FORMAL analysis view carries no reviewer decision while open', 'inv',
  "select * from public.v_analysis_export where mode='FORMAL' and (reviewer_1_decision is not null or reviewer_2_decision is not null)", { rows: 0 });
await step('FORMAL-MONITOR', 'interim', 'completion summary gives counts only', 'inv', "select * from public.rpc_completion_summary('FORMAL')", { rows: 2 });
await step('FORMAL-ADJ-OPEN', 'adjudication', 'FORMAL adjudication is refused while the phase is open', 'inv',
  "select public.rpc_record_adjudication('REV-T01','clinical_classification','EXCLUDE',null,'CONCORDANT_CONFIRMED','REVIEWER_1','synthetic',null,array[]::uuid[],null,null,false)", { error: /only after the formal phase is closed/ });
await step('FORMAL-CLOSE-COMPLETE', 'gate', 'close as complete is refused while assignments are open', 'inv',
  "select public.rpc_close_formal_review(true, 'Synthetic attestation for testing only.')", { error: /active FORMAL assignments have no review/ });
await step('FORMAL-CLOSE', 'gate', 'close as incomplete with an attestation', 'inv', "select public.rpc_close_formal_review(false, 'Synthetic attestation for testing only.')", { minRows: 1 });
await step('FORMAL-READ-AFTER', 'interim', 'investigator reads FORMAL reviews after close', 'inv', "select * from public.reviews where mode='FORMAL'", { minRows: 1 });
await step('FORMAL-XREV-AFTER', 'blinding', "r2 still cannot read r1's review after close", 'r2', 'select * from public.reviews', { rows: 0 });
await step('FORMAL-ADJ-R', 'adjudication', 'a FORMAL reviewer cannot adjudicate after close', 'r1',
  "select public.rpc_record_adjudication('REV-T01','clinical_classification','EXCLUDE',null,'CONCORDANT_CONFIRMED','REVIEWER_1','synthetic',null,array[]::uuid[],null,null,false)", { error: /investigator role/ });
await step('FORMAL-LOCK', 'workflow', 'no FORMAL submission after close', 'r2', `select public.rpc_submit_review('${await asg(R2, 'REV-T02')}', '{"l1_decision":"INCLUDE"}'::jsonb)`, { error: /closed/ });
await step('OUT-01', 'blinding', 'an authenticated outsider with no users row reads zero cases', 'out', 'select * from public.cases', { rows: 0 });
await step('OUT-02', 'blinding', 'an authenticated outsider reads zero AI records', 'out', 'select * from public.ai_classifications', { rows: 0 });

// ---------------- G2. more role checks ----------------
await step('RPC-R-issues', 'roles', 'reviewer cannot read packet-issue notes', 'r1', "select * from public.rpc_packet_issues('FORMAL')", { error: /investigator role/ });
await step('RPC-R-export', 'roles', 'reviewer cannot register an export', 'r1', `select public.rpc_register_export('{"mode":"FORMAL"}'::jsonb)`, { error: /investigator role/ });
await step('RPC-R-close', 'roles', 'reviewer cannot close or reopen the formal phase', 'r1', "select public.rpc_reopen_formal_review('AMD-1','Synthetic attestation for testing only.')", { error: /investigator role/ });
await step('RPC-R-enroll', 'roles', 'reviewer cannot enroll reviewers', 'r1', `select public.rpc_enroll_reviewer('${await uid(P.r2.email)}', 'FORMAL', null)`, { error: /investigator role/ });
await step('RPC-R-setting', 'roles', 'reviewer cannot switch off the investigator MFA requirement', 'r1', "select public.rpc_set_setting('require_investigator_mfa','false')", { error: /investigator role/ });
// ---------------- G3. findings: helper functions callable by any signed-in user ----------------
// These document behaviour; they are reported as findings for docs/OPEN_QUESTIONS.md, not as passes.
await step('FINDING-01', 'finding', 'private.case_is_locked() answers for a case the caller is not assigned to', 'pt1', "select private.case_is_locked('REV-T01') as v", { ok: true });
await step('FINDING-02', 'finding', 'private.latest_case_version_id() returns an id for a case the caller is not assigned to', 'pt1', "select private.latest_case_version_id('REV-T01') is not null as v", { ok: true });
await step('FINDING-03', 'finding', 'private.is_assigned() can be probed for any case id', 'pt1', "select private.is_assigned('REV-T01') as v", { ok: true });

// ---------------- H. audit chain ----------------
await step('AUDIT-01', 'audit', 'audit log has rows and a hash on every row', 'owner', 'select count(*)::int as n from public.audit_log where row_hash is null', { value: 0 });
await step('AUDIT-02', 'audit', 'each prev_hash equals the previous row hash', 'owner',
  'select count(*)::int as n from (select prev_hash, lag(row_hash) over (order by audit_id) as lag_hash, audit_id from public.audit_log) s where audit_id > (select min(audit_id) from public.audit_log) and prev_hash is distinct from lag_hash', { value: 0 });

const summary = { engine: (await db.query('select version() as v')).rows[0].v, n: results.length,
                  pass: results.filter(r => r.pass).length, fail: results.filter(r => !r.pass).length };
fs.writeFileSync(outPath, JSON.stringify({ summary, results }, null, 1));
fs.writeFileSync(sqlOutPath, '-- Generated by rls_tests.mjs: the statements each test runs, in order, with the identity and expectation.\n' +
  '-- Identity switch used before each statement: reset role; select set_config(\'request.jwt.claims\', <claims json>, false); set role authenticated;\n\n' + sqlLog.join('\n'));
console.log(JSON.stringify(summary));
for (const r of results.filter(r => !r.pass)) console.log('FAIL', r.id, r.desc, '|', r.actual);
await db.close();
