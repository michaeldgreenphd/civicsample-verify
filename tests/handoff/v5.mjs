// SYNTHETIC ENGINEERING ONLY. Preserved supplied regression logic; see docs/HANDOFF_TESTS.md.
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const [shimPath, schemaPath, m0002Path, m0003Path, m0004Path, outPath, sqlOutPath] =
  process.argv.slice(2);
const MIGRATIONS = [shimPath, schemaPath, m0002Path, m0003Path, m0004Path];
async function newDb() {
  const d = await PGlite.create({ extensions: { pgcrypto } });
  for (const f of MIGRATIONS) await d.exec(fs.readFileSync(f, 'utf8'));
  return d;
}
const db1 = await newDb();
let db = db1;
let dbLabel = 'db1';

// ---- identities (synthetic) ---------------------------------------------------------------
const P = {
  inv: {
    sub: '00000000-0000-4000-8000-0000000000a1',
    email: 'investigator@example.test',
    aal: 'aal2',
  },
  inv1: {
    sub: '00000000-0000-4000-8000-0000000000a1',
    email: 'investigator@example.test',
    aal: 'aal1',
  }, // same account, no MFA
  pt1: { sub: '00000000-0000-4000-8000-0000000000b1', email: 'pilot1@example.test', aal: 'aal1' },
  pt2: { sub: '00000000-0000-4000-8000-0000000000b2', email: 'pilot2@example.test', aal: 'aal1' },
  r1: { sub: '00000000-0000-4000-8000-0000000000c1', email: 'reviewer1@example.test', aal: 'aal1' },
  r2: { sub: '00000000-0000-4000-8000-0000000000c2', email: 'reviewer2@example.test', aal: 'aal1' },
  adj: {
    sub: '00000000-0000-4000-8000-0000000000e1',
    email: 'adjudicator@example.test',
    aal: 'aal1',
  },
  out: { sub: '00000000-0000-4000-8000-0000000000d1', email: 'outsider@example.test', aal: 'aal1' },
};
const ATT = 'Synthetic attestation for testing only.';
const results = [];
const sqlLog = [];

async function asWho(who) {
  await db.exec('reset role;');
  if (who === 'owner') return;
  if (who === 'anon') {
    await db.query("select set_config('request.jwt.claims', '', false)");
    await db.exec('set role anon;');
    return;
  }
  await db.query("select set_config('request.jwt.claims', $1, false)", [JSON.stringify(P[who])]);
  await db.exec('set role authenticated;');
}

// expect: {rows: n} exact row count | {minRows: n} | {error: regex} | {ok: true} | {value: v} (first column of first row)
async function step(id, area, desc, who, sql, expect, params = []) {
  const s = typeof sql === 'function' ? sql() : sql;
  sqlLog.push(
    `-- ${id} [${area}] (${dbLabel}) as ${who}: ${desc}\n-- expect: ${JSON.stringify(expect, (k, v) => (v instanceof RegExp ? v.source : v))}\n${s};\n`,
  );
  let actual,
    pass,
    rows = null;
  try {
    await asWho(who);
    const r = await db.query(s, params);
    rows = r.rows;
    if (expect.error) {
      pass = false;
      actual = `no error; ${rows.length} rows`;
    } else if (expect.rows !== undefined) {
      pass = rows.length === expect.rows;
      actual = `${rows.length} rows`;
    } else if (expect.minRows !== undefined) {
      pass = rows.length >= expect.minRows;
      actual = `${rows.length} rows`;
    } else if (expect.value !== undefined) {
      const v = rows.length ? Object.values(rows[0])[0] : undefined;
      pass = JSON.stringify(v) === JSON.stringify(expect.value);
      actual = `value ${JSON.stringify(v)}`;
    } else {
      pass = true;
      actual = `ok; ${rows.length} rows`;
    }
  } catch (e) {
    if (expect.error) {
      pass = expect.error.test(e.message);
      actual = `error: ${e.message}`;
    } else {
      pass = false;
      actual = `error: ${e.message}`;
    }
  }
  await db.exec('reset role;');
  results.push({
    id,
    area,
    desc,
    who,
    db: dbLabel,
    expect: JSON.stringify(expect, (k, v) => (v instanceof RegExp ? v.source : v)),
    actual: actual.slice(0, 400),
    pass,
  });
  return rows;
}
const q = async (sql, params = []) => {
  await db.exec('reset role;');
  return (await db.query(sql, params)).rows;
};
const sha256 = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
const J = (o) => JSON.stringify(o);
const arr = (ids) => `array[${ids.map((x) => `'${x}'`).join(',')}]`;

async function setupAccounts() {
  for (const k of Object.keys(P)) {
    await db.query('insert into auth.users (id, email) values ($1, $2) on conflict do nothing', [
      P[k].sub,
      P[k].email,
    ]);
  }
  await db.query(
    "insert into public.users (email, display_name, role) values ($1, 'Test Investigator', 'INVESTIGATOR')",
    [P.inv.email],
  );
}

// ---- synthetic content ------------------------------------------------------------------------
const AREAS = [
  'ONCOLOGY',
  'CARDIOVASCULAR',
  'MENTAL_HEALTH',
  'INFECTIOUS',
  'METABOLIC',
  'NEUROLOGICAL',
  'RESPIRATORY',
];
const ROWS = ['CAN_ALL', 'DIAB', 'DEP', 'OBE', 'AST', 'COPD', 'COV', 'SCZ', 'HTN', 'PAIN'];
const packet = (n, trialExtra = {}, topExtra = {}) =>
  Object.assign(
    {
      schema_version: '5.0',
      case_title: `Synthetic trial ${n}`,
      trial: Object.assign(
        {
          brief_title: `Synthetic trial ${n} of a fictional therapy`,
          official_title: `A synthetic study ${n} for application testing only`,
          conditions_registered: ['Synthetic condition A'],
          condition_mesh_headings: ['Synthetic heading A'],
          brief_summary: 'SYNTHETIC TEXT FOR APP TESTING ONLY.',
          interventions: [
            { intervention_type: 'DRUG', name: 'Synthetic drug', description: 'fictional' },
          ],
          eligibility_age_range: { minimum_age: '18 Years', maximum_age: 'N/A' },
        },
        trialExtra,
      ),
      notices: ['SYNTHETIC CASE: excluded from all statistics'],
    },
    topExtra,
  );
const design = (nct, extra = {}) =>
  Object.assign(
    {
      nct_id: nct,
      frame: 'SYN_FRAME',
      stratum: 'SYN_P01',
      variance_stratum: 'SYN_P01',
      frame_stratum_size: 20,
      n_sampled_in_stratum: 10,
      selection_probability: 0.5,
      sampling_seed: 1,
      prn: 0.5,
      design_version: 'SYN-5',
      in_mixed_sex_cohort: true,
      figure2_rows: '',
      dev_linked: false,
      tier1_eligible: true,
    },
    extra,
  );
const caseJson = (id, mode, n, d = undefined, pk = undefined) =>
  J({ case_id: id, mode, packet: pk ?? packet(n), ...(d ? { design: d } : {}) });

function labelSet(set, caseId, o = {}) {
  const t0 = o.areas ?? [],
    v12 = o.v12 ?? t0,
    v11 = o.v11 ?? t0,
    rows = o.rows ?? [];
  const L = AREAS.map((a) => ({
    label_set_id: set,
    case_id: caseId,
    item_code: `AREA_${a}`,
    label_primary: t0.includes(a) ? 'YES' : 'NO',
    label_secondary: v12.includes(a) ? 'YES' : 'NO',
    label_informational: v11.includes(a) ? 'YES' : 'NO',
    dev_linked_area: !!o.dev,
  }));
  for (const r of ROWS)
    L.push({
      label_set_id: set,
      case_id: caseId,
      item_code: `FIG2_ROW_${r}`,
      label_primary: rows.includes(r) ? 'YES' : 'NO',
    });
  if (o.ruleD)
    L.push({ label_set_id: set, case_id: caseId, item_code: 'RULE_D', label_primary: o.ruleD });
  if (o.ruleK)
    L.push({ label_set_id: set, case_id: caseId, item_code: 'RULE_K', label_primary: o.ruleK });
  return L.filter((x) => !(o.drop ?? []).includes(x.item_code));
}
// The hash procedure of scripts/03_draw_sample_v5.py: row_sha256 = SHA-256 of
// label_set_id|case_id|item_code|label_primary|label_secondary|label_informational; set hash = SHA-256 of the
// row hashes joined by line feeds, rows ordered by case_id then item_code (code-point order).
const rowText = (x) =>
  [
    x.label_set_id,
    x.case_id,
    x.item_code,
    x.label_primary,
    x.label_secondary ?? '',
    x.label_informational ?? '',
  ].join('|');
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const labelSetSha = (rows) =>
  sha256(
    [...rows]
      .sort((a, b) => cmp(a.case_id, b.case_id) || cmp(a.item_code, b.item_code))
      .map((x) => sha256(rowText(x)))
      .join('\n'),
  );

// One submission: the 17 area and row items, plus each subgroup item whose row the reviewer answers YES.
function answers(o = {}) {
  const yesA = o.areas ?? [],
    yesR = o.rows ?? [];
  const it = AREAS.map((a) => ({
    item_code: `AREA_${a}`,
    answer: (o.areaAns ?? {})[a] ?? (yesA.includes(a) ? 'YES' : 'NO'),
  }));
  for (const r of ROWS)
    it.push({
      item_code: `FIG2_ROW_${r}`,
      answer: (o.rowAns ?? {})[r] ?? (yesR.includes(r) ? 'YES' : 'NO'),
    });
  const yes = (r) => it.find((x) => x.item_code === `FIG2_ROW_${r}`).answer === 'YES';
  if (yes('DIAB') && o.sgD !== null)
    it.push(
      Object.assign(
        { item_code: 'SG_DIABETES_TYPE', answer: o.sgD ?? 'TYPE_2' },
        o.sgDdetail ? { detail_code: o.sgDdetail } : {},
      ),
    );
  if (yes('CAN_ALL') && o.sgK !== null)
    it.push(
      Object.assign(
        { item_code: 'SG_NEOPLASM_MALIGNANCY', answer: o.sgK ?? 'MALIGNANT' },
        o.sgKdetail ? { detail_code: o.sgKdetail } : {},
      ),
    );
  let out = it.filter((x) => !(o.drop ?? []).includes(x.item_code)).concat(o.extra ?? []);
  if (o.note)
    out = out.map((x) =>
      x.item_code === o.note.item
        ? Object.assign({}, x, { note: o.note.text, uncertain: true })
        : x,
    );
  return Object.assign({ items: out }, o.header ?? {});
}

const uid = async (email) =>
  (await q('select user_id from public.users where email=$1', [email]))[0].user_id;
const pid = async (k) =>
  (
    await q(
      'select r.reviewer_pseudo_id from public.reviewers r join public.users u using (user_id) where u.email=$1',
      [P[k].email],
    )
  )[0].reviewer_pseudo_id;
const asg5 = async (p, c) =>
  (
    await q(
      'select assignment_id from public.tlv5_assignments where reviewer_pseudo_id=$1 and case_id=$2',
      [p, c],
    )
  )[0].assignment_id;
async function submit(id, area, desc, who, pseudo, caseId, payload, expect) {
  return step(
    id,
    area,
    desc,
    who,
    `select public.rpc_tlv5_submit('${await asg5(pseudo, caseId)}', '${J(payload)}'::jsonb) as sid`,
    expect,
  );
}
const adjud = (o) => `select public.rpc_tlv5_record_adjudication('${J(o)}'::jsonb) as jid`;

await setupAccounts();

// =============================================================================
// S. Setup: accounts and pilot reviewers (the v2 enrolment path for PILOT accounts, unchanged)
// =============================================================================
await step(
  'S-AUTH',
  'setup',
  'investigator claims the bootstrapped account',
  'inv',
  'select public.rpc_claim_account() as uid',
  { minRows: 1 },
);
await step(
  'V5-SCHEMA-01',
  'v5-setup',
  'schema version 5.0.0 is recorded after 1.0.0, 3.0.0 and 4.0.0',
  'inv',
  "select string_agg(version, ',' order by version) as v from public.app_schema_version",
  { value: '1.0.0,3.0.0,4.0.0,5.0.0' },
);
await step(
  'V5-SCHEMA-02',
  'v5-setup',
  'design v5 is not active after the migration alone (activation is a separate, attested act)',
  'owner',
  'select count(*)::int as n from public.tlv5_activation',
  { value: 0 },
);
await step(
  'V5-SCHEMA-03',
  'v5-setup',
  'the migration does not activate design v4 either',
  'owner',
  'select count(*)::int as n from public.design_activation_v4',
  { value: 0 },
);
for (const [k, pilot] of [
  ['pt1', true],
  ['pt2', true],
  ['r1', false],
  ['r2', false],
]) {
  await step(
    `S-USER-${k}`,
    'setup',
    `investigator registers ${k}`,
    'inv',
    `select public.rpc_register_user('${P[k].email}', 'Synthetic ${k}', 'REVIEWER', ${pilot})`,
    { minRows: 1 },
  );
}
await step(
  'S-USER-adj',
  'setup',
  'investigator registers the ADJUDICATOR',
  'inv',
  `select public.rpc_register_user('${P.adj.email}', 'Synthetic adjudicator', 'ADJUDICATOR', false)`,
  { minRows: 1 },
);
for (const k of ['pt1', 'pt2', 'r1', 'r2', 'adj'])
  await step(
    `S-CLAIM-${k}`,
    'setup',
    `${k} claims account`,
    k,
    'select public.rpc_claim_account()',
    { minRows: 1 },
  );
for (const k of ['pt1', 'pt2']) {
  await step(
    `S-ENROLL-${k}`,
    'setup',
    `enroll ${k} as PILOT reviewer (v2 path, unchanged)`,
    'inv',
    `select public.rpc_enroll_reviewer('${await uid(P[k].email)}', 'PILOT', 'synthetic pilot test account')`,
    { minRows: 1 },
  );
}
const PT1 = await pid('pt1'),
  PT2 = await pid('pt2');

// =============================================================================
// P. The v5 pilot: 10 SYN- cases, one planted disagreement, adjudication, lock, export, sign-off
// =============================================================================
const pilotIds = Array.from({ length: 10 }, (_, i) => `SYN-TLV5-${String(i + 1).padStart(3, '0')}`);
const pilotPlan = {
  'SYN-TLV5-001': {
    lab: { areas: ['METABOLIC'], rows: ['DIAB'], ruleD: 'D1_KEEP_TYPE2' },
    a1: { areas: ['METABOLIC'], rows: ['DIAB'] },
    a2: { areas: ['METABOLIC'], rows: ['DIAB'] },
  },
  'SYN-TLV5-002': {
    lab: { areas: ['ONCOLOGY'], rows: ['CAN_ALL'], ruleK: 'K_KEEP_MALIGNANT_COMPATIBLE' },
    a1: { areas: ['ONCOLOGY'], rows: ['CAN_ALL'] },
    a2: { areas: ['ONCOLOGY'], rows: ['CAN_ALL'] },
  },
  'SYN-TLV5-003': {
    lab: { areas: ['CARDIOVASCULAR'], rows: ['HTN'] },
    a1: { areas: ['CARDIOVASCULAR'], rows: ['HTN'] },
    a2: { areas: [], rows: ['HTN'] },
  },
};
for (const id of pilotIds.slice(3))
  pilotPlan[id] = {
    lab: { areas: ['MENTAL_HEALTH'], rows: ['DEP'] },
    a1: { areas: ['MENTAL_HEALTH'], rows: ['DEP'] },
    a2: { areas: ['MENTAL_HEALTH'], rows: ['DEP'] },
  };

await step(
  'V5-P-00',
  'v5-roles',
  'a pilot reviewer cannot import a case',
  'pt1',
  `select public.rpc_tlv5_import_case('${caseJson('SYN-TLV5-099', 'PILOT', 99, design('SYN-NCT-0099'))}'::jsonb)`,
  { error: /investigator role/ },
);
for (const [i, id] of pilotIds.entries()) {
  await step(
    `V5-P-01-${id}`,
    'v5-setup',
    `import pilot case ${id} with its design row`,
    'inv',
    `select public.rpc_tlv5_import_case('${caseJson(id, 'PILOT', i + 1, design(`SYN-NCT-${String(i + 1).padStart(4, '0')}`))}'::jsonb)`,
    { value: id },
  );
}
const pilotLabels = pilotIds.flatMap((id) => labelSet('LBL5-SYN-PILOT', id, pilotPlan[id].lab));
await step(
  'V5-P-02',
  'v5-setup',
  `import the pilot frozen labels (${pilotLabels.length} rows)`,
  'inv',
  `select public.rpc_tlv5_import_frozen_labels('${J(pilotLabels)}'::jsonb)`,
  { value: pilotLabels.length },
);
await step(
  'V5-P-03',
  'v5-setup',
  'assign the pilot cases to slot 1',
  'inv',
  `select public.rpc_tlv5_assign('PILOT','${PT1}',1,${arr(pilotIds)},20261022)`,
  { value: 10 },
);
await step(
  'V5-P-04',
  'v5-setup',
  'assign the pilot cases to slot 2',
  'inv',
  `select public.rpc_tlv5_assign('PILOT','${PT2}',2,${arr(pilotIds)},20261022)`,
  { value: 10 },
);
await step(
  'V5-P-05',
  'v5-blinding',
  'pt1 reads its 10 assigned pilot cases',
  'pt1',
  'select case_id from public.tlv5_cases',
  { rows: 10 },
);
await step(
  'V5-P-06',
  'v5-blinding',
  'pt1 reads no design row',
  'pt1',
  'select * from public.tlv5_case_design',
  { rows: 0 },
);
await step(
  'V5-P-07',
  'v5-blinding',
  'pt1 reads no frozen label',
  'pt1',
  'select * from public.tlv5_frozen_labels',
  { rows: 0 },
);
await step(
  'V5-P-08',
  'v5-blinding',
  'pt1 reads only its own 10 assignments',
  'pt1',
  'select * from public.tlv5_assignments',
  { rows: 10 },
);
await step(
  'V5-P-09',
  'v5-blinding',
  'the pilot packet reaches the reviewer without any design field',
  'pt1',
  `select count(*)::int as n from public.tlv5_cases c where c.packet::text ~* '"[a-z_]*(stratum|weight|label|nct|tier|enrol|sex)[a-z_]*":'`,
  { value: 0 },
);
for (const id of pilotIds) {
  await submit(
    `V5-P-10-${id}`,
    'v5-setup',
    `pt1 submits ${id}`,
    'pt1',
    PT1,
    id,
    answers(pilotPlan[id].a1),
    { minRows: 1 },
  );
}
await step(
  'V5-P-11',
  'v5-gate',
  'the pilot sign-off is refused while the second reviewer has not submitted',
  'inv',
  `select public.rpc_tlv5_phase('PILOT_SIGNED_OFF', '${J({ checklist_version: 'PAC-5', checklist_sha256: '1'.repeat(64), app_git_sha: 'abc123', pilot_export_id: '00000000-0000-4000-8000-00000000ffff', attestation: ATT })}'::jsonb)`,
  { error: /v5 pilot incomplete/ },
);
await step(
  'V5-P-12',
  'v5-blinding',
  'pt2 reads none of the pt1 submissions',
  'pt2',
  'select * from public.tlv5_submissions',
  { rows: 0 },
);
for (const id of pilotIds) {
  await submit(
    `V5-P-13-${id}`,
    'v5-setup',
    `pt2 submits ${id}${id === 'SYN-TLV5-003' ? ' (planted disagreement on AREA_CARDIOVASCULAR)' : ''}`,
    'pt2',
    PT2,
    id,
    answers(pilotPlan[id].a2),
    { minRows: 1 },
  );
}
await submit(
  'V5-P-14',
  'v5-workflow',
  'pt1 revises SYN-TLV5-004 (adds a note); the revision number becomes 2',
  'pt1',
  PT1,
  'SYN-TLV5-004',
  answers(
    Object.assign({}, pilotPlan['SYN-TLV5-004'].a1, {
      note: { item: 'AREA_MENTAL_HEALTH', text: 'synthetic note' },
    }),
  ),
  { minRows: 1 },
);
await step(
  'V5-P-15',
  'v5-workflow',
  'the revision is stored as revision 2 of the same assignment',
  'inv',
  `select max(revision_number)::int as n from public.tlv5_submissions where case_id='SYN-TLV5-004' and reviewer_pseudo_id='${PT1}'`,
  { value: 2 },
);
await step(
  'V5-P-16',
  'v5-gate',
  'the pilot sign-off is refused before the pilot reference is locked',
  'inv',
  `select public.rpc_tlv5_phase('PILOT_SIGNED_OFF', '${J({ checklist_version: 'PAC-5', checklist_sha256: '1'.repeat(64), app_git_sha: 'abc123', pilot_export_id: '00000000-0000-4000-8000-00000000ffff', attestation: ATT })}'::jsonb)`,
  { error: /lock the pilot reference/ },
);
await step(
  'V5-P-17',
  'v5-gate',
  'the pilot lock is refused while the planted disagreement has no adjudication',
  'inv',
  `select public.rpc_tlv5_lock_reference('PILOT', '${ATT}')`,
  { error: /1 items that the adjudication scope requires/ },
);
await step(
  'V5-P-18',
  'v5-roles',
  'a pilot reviewer cannot adjudicate',
  'pt1',
  adjud({
    case_id: 'SYN-TLV5-003',
    item_code: 'AREA_CARDIOVASCULAR',
    decision: 'YES',
    status: 'DISCORDANT_RESOLVED',
    basis: 'REVIEWER_1',
    rationale: 'synthetic',
    disagreement_reason_code: 'CONSTRUCT_BOUNDARY',
  }),
  { error: /ADJUDICATOR role is needed/ },
);
await step(
  'V5-P-19',
  'v5-scope',
  'a concordant pilot item enters by rule and cannot be adjudicated (DISAGREEMENTS_ONLY)',
  'adj',
  adjud({
    case_id: 'SYN-TLV5-001',
    item_code: 'AREA_METABOLIC',
    decision: 'YES',
    status: 'CONCORDANT_CONFIRMED',
    basis: 'BOTH_REVIEWERS',
    rationale: 'synthetic',
  }),
  { error: /concordant items enter the reference by rule/ },
);
await step(
  'V5-P-20',
  'v5-scope',
  'a discordant item needs a disagreement reason code',
  'adj',
  adjud({
    case_id: 'SYN-TLV5-003',
    item_code: 'AREA_CARDIOVASCULAR',
    decision: 'YES',
    status: 'DISCORDANT_RESOLVED',
    basis: 'REVIEWER_1',
    rationale: 'synthetic',
  }),
  { error: /needs a disagreement reason code/ },
);
await step(
  'V5-P-21',
  'v5-blinding',
  'the adjudicator reads both pilot answers on the planted disagreement and no label',
  'adj',
  "select concat_ws('|', reviewer_1_answer, reviewer_2_answer, needs_adjudication::text) as v from public.v_tlv5_adjudication_queue where case_id='SYN-TLV5-003' and item_code='AREA_CARDIOVASCULAR'",
  { value: 'YES|NO|true' },
);
await step(
  'V5-P-22',
  'v5-blinding',
  'the adjudicator reads no frozen pilot label',
  'adj',
  'select * from public.tlv5_frozen_labels',
  { rows: 0 },
);
await step(
  'V5-P-23',
  'v5-workflow',
  'the adjudicator resolves the planted disagreement',
  'adj',
  adjud({
    case_id: 'SYN-TLV5-003',
    item_code: 'AREA_CARDIOVASCULAR',
    decision: 'YES',
    status: 'DISCORDANT_RESOLVED',
    basis: 'REVIEWER_1',
    rationale: 'synthetic',
    disagreement_reason_code: 'CONSTRUCT_BOUNDARY',
  }),
  { minRows: 1 },
);
await step(
  'V5-P-24',
  'v5-roles',
  'a pilot reviewer cannot lock the pilot reference',
  'pt1',
  `select public.rpc_tlv5_lock_reference('PILOT', '${ATT}')`,
  { error: /investigator role/ },
);
await step(
  'V5-P-25',
  'v5-setup',
  'investigator locks the pilot reference',
  'inv',
  `select public.rpc_tlv5_lock_reference('PILOT', '${ATT}')`,
  { minRows: 1 },
);
await submit(
  'V5-P-26',
  'v5-gate',
  'a pilot submission after the pilot lock is refused',
  'pt2',
  PT2,
  'SYN-TLV5-005',
  answers(pilotPlan['SYN-TLV5-005'].a2),
  { error: /pilot reference is locked/ },
);
await step(
  'V5-P-27',
  'v5-export',
  'pilot independent judgments: 10 cases x 19 items x 2 reviewers',
  'inv',
  "select * from public.v_tlv5_independent_judgments where mode='PILOT'",
  { rows: 380 },
);
await step(
  'V5-P-28',
  'v5-export',
  'pilot adjudicated reference: 10 cases x 19 items',
  'inv',
  "select * from public.v_tlv5_adjudicated_reference where mode='PILOT'",
  { rows: 190 },
);
await step(
  'V5-P-29',
  'v5-export',
  'pilot reference status counts (171 by rule, 1 resolved, 18 not applicable)',
  'inv',
  "select string_agg(s || ':' || n, ',' order by s) as v from (select adjudication_status s, count(*) n from public.v_tlv5_adjudicated_reference where mode='PILOT' group by 1) x",
  { value: 'CONCORDANT_ADOPTED_BY_RULE:171,DISCORDANT_RESOLVED:1,NOT_APPLICABLE_BY_RULE:18' },
);
await step(
  'V5-P-30',
  'v5-export',
  'pilot frozen labels with design: 10 x 17 + 1 rule D + 1 rule K',
  'inv',
  "select * from public.v_tlv5_frozen_labels where mode='PILOT'",
  { rows: 172 },
);
await step(
  'V5-P-31',
  'v5-export',
  'a concordant subgroup item enters by rule',
  'inv',
  "select concat_ws('|', reference_answer, adjudication_status) as v from public.v_tlv5_adjudicated_reference where case_id='SYN-TLV5-001' and item_code='SG_DIABETES_TYPE'",
  { value: 'TYPE_2|CONCORDANT_ADOPTED_BY_RULE' },
);
await step(
  'V5-P-32',
  'v5-export',
  'a subgroup item no reviewer was shown is NOT_APPLICABLE by rule (never blank)',
  'inv',
  "select concat_ws('|', reference_answer, adjudication_status) as v from public.v_tlv5_adjudicated_reference where case_id='SYN-TLV5-003' and item_code='SG_DIABETES_TYPE'",
  { value: 'NOT_APPLICABLE|NOT_APPLICABLE_BY_RULE' },
);
await step(
  'V5-P-33',
  'v5-export',
  'the resolved pilot disagreement carries the adjudicator decision and role',
  'inv',
  "select concat_ws('|', reference_answer, adjudication_status, adjudicator_role, adjudication_blinded::text) as v from public.v_tlv5_adjudicated_reference where case_id='SYN-TLV5-003' and item_code='AREA_CARDIOVASCULAR'",
  { value: 'YES|DISCORDANT_RESOLVED|ADJUDICATOR|true' },
);
await step(
  'V5-P-34',
  'v5-export',
  'the revised pilot judgment reports one revision',
  'inv',
  `select n_revisions_preclose::int as n from public.v_tlv5_independent_judgments where case_id='SYN-TLV5-004' and item_code='AREA_MENTAL_HEALTH' and reviewer_pseudo_id='${PT1}'`,
  { value: 1 },
);
await step(
  'V5-P-35',
  'v5-export',
  'a hidden subgroup item is exported as NOT_APPLICABLE for each reviewer',
  'inv',
  "select string_agg(answer_effective_preclose, ',' order by reviewer_slot) as v from public.v_tlv5_independent_judgments where case_id='SYN-TLV5-003' and item_code='SG_NEOPLASM_MALIGNANCY'",
  { value: 'NOT_APPLICABLE,NOT_APPLICABLE' },
);
await step(
  'V5-P-36',
  'v5-gate',
  'a FORMAL export cannot be registered before the FORMAL reference is locked',
  'inv',
  `select public.rpc_tlv5_register_export('${J({ mode: 'FORMAL', bundle_format_version: '5.0', row_counts: {}, file_sha256: {}, manifest_sha256: '3'.repeat(64), app_git_sha: 'abc123' })}'::jsonb)`,
  { error: /registered only after that reference is locked/ },
);
await step(
  'V5-P-37',
  'v5-export',
  'an export bundle of another format version is refused',
  'inv',
  `select public.rpc_tlv5_register_export('${J({ mode: 'PILOT', bundle_format_version: '4.0', row_counts: {}, file_sha256: {}, manifest_sha256: '3'.repeat(64), app_git_sha: 'abc123' })}'::jsonb)`,
  { error: /check constraint|violates/ },
);
const pex = await step(
  'V5-P-38',
  'v5-setup',
  'register the v5 PILOT export (bundle format 5.0)',
  'inv',
  `select public.rpc_tlv5_register_export('${J({ mode: 'PILOT', bundle_format_version: '5.0', row_counts: { independent_judgments: 380, adjudicated_reference: 190, frozen_labels: 172 }, file_sha256: { 'independent_judgments_v5.csv': '2'.repeat(64) }, manifest_sha256: '3'.repeat(64), app_git_sha: 'abc123' })}'::jsonb) as eid`,
  { minRows: 1 },
);
const PEX = pex && pex[0] ? pex[0].eid : '00000000-0000-4000-8000-00000000fffe';
const signoff = (o = {}) =>
  `select public.rpc_tlv5_phase('PILOT_SIGNED_OFF', '${J(Object.assign({ checklist_version: 'PAC-5', checklist_sha256: '1'.repeat(64), app_git_sha: 'abc123', pilot_export_id: PEX, attestation: ATT }, o))}'::jsonb)`;
await step(
  'V5-P-39',
  'v5-gate',
  'design v5 cannot be activated before the v5 pilot sign-off',
  'inv',
  `select public.rpc_tlv5_activate('SYN-5', 'DISAGREEMENTS_ONLY', '${ATT}')`,
  { error: /sign off the v5 pilot/ },
);
await step(
  'V5-P-40',
  'v5-gate',
  'FORMAL v5 reviewers cannot be enrolled before the v5 pilot sign-off',
  'inv',
  `select public.rpc_tlv5_enroll_reviewer('${await uid(P.r1.email)}', 'synthetic qualifications')`,
  { error: /only after the v5 pilot sign-off/ },
);
await step(
  'V5-P-41',
  'v5-gate',
  'a FORMAL case cannot be imported before activation',
  'inv',
  `select public.rpc_tlv5_import_case('${caseJson('TLV5-TESTFX-0009', 'FORMAL', 9, design('SYN-NCT-0909'))}'::jsonb)`,
  { error: /activate design v5 before importing FORMAL cases/ },
);
await step(
  'V5-P-42',
  'v5-gate',
  'a calibration case cannot be imported before activation',
  'inv',
  `select public.rpc_tlv5_import_case('${caseJson('CAL5-TESTFX-09', 'CALIBRATION', 9)}'::jsonb)`,
  { error: /activate design v5 before importing CALIBRATION cases/ },
);
await step(
  'V5-P-43',
  'v5-gate',
  'the sign-off needs a checklist hash',
  'inv',
  signoff({ checklist_sha256: null }),
  { error: /check constraint|violates/ },
);
await step(
  'V5-P-44',
  'v5-gate',
  'the sign-off needs a registered v5 PILOT export',
  'inv',
  signoff({ pilot_export_id: '00000000-0000-4000-8000-00000000fffd' }),
  { error: /must reference a registered v5 PILOT export/ },
);
await step('V5-P-45', 'v5-roles', 'a reviewer cannot sign off the pilot', 'pt1', signoff(), {
  error: /investigator role/,
});
await step(
  'V5-P-46',
  'v5-roles',
  'an investigator session without multi-factor cannot sign off',
  'inv1',
  signoff(),
  { error: /investigator role/ },
);
await step('V5-P-47', 'v5-setup', 'investigator signs off the v5 pilot', 'inv', signoff(), {
  minRows: 1,
});
await step('V5-P-48', 'v5-gate', 'a second pilot sign-off is refused', 'inv', signoff(), {
  error: /already signed off/,
});

// =============================================================================
// A. Activation and mutual exclusion
// =============================================================================
const invId = await uid(P.inv.email);
await step(
  'V5-ACT-01',
  'v5-setup',
  'owner-role insert of an active FORMAL case in the v2/v3/v4 case table (reaches the trigger without the v2 pilot path)',
  'owner',
  `insert into public.cases (case_id, mode, unit_type, created_by) values ('REV-X01', 'FORMAL', 'DESCRIPTOR_AREA', '${invId}')`,
  { ok: true },
);
await step(
  'V5-ACT-02',
  'v5-gate',
  'activation is refused while an active FORMAL v2/v3/v4 case exists',
  'inv',
  `select public.rpc_tlv5_activate('SYN-5', 'DISAGREEMENTS_ONLY', '${ATT}')`,
  { error: /withdraw them before activating design v5/ },
);
await step(
  'V5-ACT-03',
  'v5-setup',
  'withdraw that case (the single permitted change on cases)',
  'owner',
  "update public.cases set withdrawn_at = now(), withdrawn_reason = 'synthetic' where case_id = 'REV-X01'",
  { ok: true },
);
await step(
  'V5-ACT-04',
  'v5-gate',
  'an unknown adjudication scope is refused',
  'inv',
  `select public.rpc_tlv5_activate('SYN-5', 'EVERY_ITEM', '${ATT}')`,
  { error: /check constraint|violates/ },
);
await step(
  'V5-ACT-05',
  'v5-roles',
  'a reviewer cannot activate design v5',
  'r1',
  `select public.rpc_tlv5_activate('SYN-5', 'DISAGREEMENTS_ONLY', '${ATT}')`,
  { error: /investigator role/ },
);
await step(
  'V5-ACT-06',
  'v5-roles',
  'an investigator session without multi-factor cannot activate',
  'inv1',
  `select public.rpc_tlv5_activate('SYN-5', 'DISAGREEMENTS_ONLY', '${ATT}')`,
  { error: /investigator role/ },
);
await step(
  'V5-ACT-07',
  'v5-setup',
  'investigator activates design v5 (adjudication scope DISAGREEMENTS_ONLY)',
  'inv',
  `select public.rpc_tlv5_activate('SYN-5', 'DISAGREEMENTS_ONLY', '${ATT}')`,
  { minRows: 1 },
);
await step(
  'V5-ACT-08',
  'v5-gate',
  'a second activation is refused',
  'inv',
  `select public.rpc_tlv5_activate('SYN-5', 'ALL_ITEMS', '${ATT}')`,
  { error: /duplicate key|already/ },
);
await step(
  'V5-ACT-09',
  'v5-immutability',
  'the activation row cannot be updated (owner role)',
  'owner',
  "update public.tlv5_activation set adjudication_scope = 'ALL_ITEMS'",
  { error: /append-only/ },
);
for (const who of ['r1', 'adj', 'pt1'])
  await step(
    `V5-ACT-10-${who}`,
    'v5-blinding',
    `${who} reads no activation row`,
    who,
    'select * from public.tlv5_activation',
    { rows: 0 },
  );
await step(
  'V5-MX-01',
  'v5-exclusion',
  'design v4 cannot be activated once design v5 is active',
  'inv',
  `select public.rpc_activate_design_v4('SYN-4', 'DISAGREEMENTS_ONLY', '${ATT}')`,
  { error: /design v5 is active; design v4 cannot be activated/ },
);
await step(
  'V5-MX-02',
  'v5-exclusion',
  'no FORMAL case can be created in the v2/v3/v4 case table once v5 is active (owner role)',
  'owner',
  `insert into public.cases (case_id, mode, unit_type, created_by) values ('REV-X02', 'FORMAL', 'DESCRIPTOR_AREA', '${invId}')`,
  { error: /design v5 is active; FORMAL cases are imported with rpc_tlv5_import_case/ },
);
await step(
  'V5-MX-03',
  'v5-exclusion',
  'a PILOT case of the earlier designs is unaffected by the guard (owner role)',
  'owner',
  `insert into public.cases (case_id, mode, unit_type, created_by) values ('SYN-V2X-01', 'PILOT', 'DESCRIPTOR_AREA', '${invId}')`,
  { ok: true },
);

// =============================================================================
// E. FORMAL reviewer enrolment and role separation
// =============================================================================
await step(
  'V5-ENR-01',
  'v5-roles',
  'the v2 enrolment path is unchanged: it still requires the v2 unlock',
  'inv',
  `select public.rpc_enroll_reviewer('${await uid(P.r1.email)}', 'FORMAL', 'synthetic')`,
  { error: /only after the pilot sign-off unlocks the formal review/ },
);
await step(
  'V5-ENR-02',
  'v5-roles',
  'the ADJUDICATOR account cannot also be a reviewer',
  'inv',
  `select public.rpc_tlv5_enroll_reviewer('${await uid(P.adj.email)}', 'synthetic')`,
  { error: /reviewer rows require a REVIEWER user/ },
);
await step(
  'V5-ENR-03',
  'v5-roles',
  'the investigator account cannot also be a reviewer',
  'inv',
  `select public.rpc_tlv5_enroll_reviewer('${invId}', 'synthetic')`,
  { error: /reviewer rows require a REVIEWER user/ },
);
await step(
  'V5-ENR-04',
  'v5-roles',
  'a pilot test account cannot become a FORMAL reviewer',
  'inv',
  `select public.rpc_tlv5_enroll_reviewer('${await uid(P.pt1.email)}', 'synthetic')`,
  { error: /duplicate key|pilot test accounts/ },
);
await step(
  'V5-ENR-05',
  'v5-roles',
  'a reviewer cannot enrol reviewers',
  'r1',
  `select public.rpc_tlv5_enroll_reviewer('${await uid(P.r2.email)}', 'synthetic')`,
  { error: /investigator role/ },
);
for (const k of ['r1', 'r2']) {
  await step(
    `V5-ENR-06-${k}`,
    'v5-setup',
    `enrol ${k} as a FORMAL v5 reviewer (pseudonym R-XXXX)`,
    'inv',
    `select public.rpc_tlv5_enroll_reviewer('${await uid(P[k].email)}', 'synthetic qualifications') ~ '^R-[A-Z0-9]{4}$' as ok`,
    { value: true },
  );
}
const R1 = await pid('r1'),
  R2 = await pid('r2');
await step(
  'V5-ENR-07',
  'v5-categories',
  'a FORMAL reviewer cannot take a PILOT case (mode contamination)',
  'inv',
  `select public.rpc_tlv5_assign('PILOT','${R1}',1,${arr(['SYN-TLV5-001'])},1)`,
  { error: /mode contamination blocked/ },
);

// =============================================================================
// C. Rubric calibration (CAL5-; before the freeze; never exported or analysed)
// =============================================================================
const calIds = ['CAL5-TESTFX-01', 'CAL5-TESTFX-02'];
for (const [i, id] of calIds.entries()) {
  await step(
    `V5-CAL-01-${id}`,
    'v5-setup',
    `import calibration case ${id}`,
    'inv',
    `select public.rpc_tlv5_import_case('${caseJson(id, 'CALIBRATION', 50 + i)}'::jsonb)`,
    { value: id },
  );
}
await step(
  'V5-CAL-02',
  'v5-setup',
  'assign the calibration cases to R1 (slot 1)',
  'inv',
  `select public.rpc_tlv5_assign('CALIBRATION','${R1}',1,${arr(calIds)},7)`,
  { value: 2 },
);
await step(
  'V5-CAL-03',
  'v5-setup',
  'assign the calibration cases to R2 (slot 2)',
  'inv',
  `select public.rpc_tlv5_assign('CALIBRATION','${R2}',2,${arr(calIds)},7)`,
  { value: 2 },
);
await step(
  'V5-CAL-04',
  'v5-categories',
  'a pilot account cannot take a calibration case',
  'inv',
  `select public.rpc_tlv5_assign('CALIBRATION','${PT1}',1,${arr(['CAL5-TESTFX-01'])},7)`,
  { error: /mode contamination blocked/ },
);
await submit(
  'V5-CAL-05',
  'v5-workflow',
  'r1 answers calibration case CAL5-TESTFX-01',
  'r1',
  R1,
  'CAL5-TESTFX-01',
  answers({ areas: ['INFECTIOUS'], rows: ['COV'] }),
  { minRows: 1 },
);
await submit(
  'V5-CAL-06',
  'v5-workflow',
  'r2 answers calibration case CAL5-TESTFX-01',
  'r2',
  R2,
  'CAL5-TESTFX-01',
  answers({ areas: ['INFECTIOUS', 'RESPIRATORY'], rows: ['COV'] }),
  { minRows: 1 },
);
await step(
  'V5-CAL-07',
  'v5-calibration',
  'the investigator reads calibration answers (rubric feedback)',
  'inv',
  "select * from public.tlv5_submissions where mode='CALIBRATION'",
  { rows: 2 },
);
await step(
  'V5-CAL-08',
  'v5-blinding',
  'the adjudicator reads no calibration answer',
  'adj',
  "select * from public.tlv5_submissions where mode='CALIBRATION'",
  { rows: 0 },
);
await step(
  'V5-CAL-09',
  'v5-blinding',
  'the adjudicator reads no calibration case',
  'adj',
  "select * from public.tlv5_cases where mode='CALIBRATION'",
  { rows: 0 },
);
await step(
  'V5-CAL-10',
  'v5-blinding',
  'r2 reads only its own calibration submission',
  'r2',
  'select * from public.tlv5_submissions',
  { rows: 1 },
);

// =============================================================================
// I. FORMAL imports: prefixes, packet allow list, design rows, frozen labels
// =============================================================================
const F = (n) => `TLV5-TESTFX-000${n}`;
await step(
  'V5-ID-01',
  'v5-categories',
  'a SYN- ID cannot be a FORMAL case',
  'inv',
  `select public.rpc_tlv5_import_case('${caseJson('SYN-TLV5-777', 'FORMAL', 77, design('SYN-NCT-0777'))}'::jsonb)`,
  { error: /check constraint|violates/ },
);
await step(
  'V5-ID-02',
  'v5-categories',
  'a TLV5- ID cannot be a PILOT case',
  'inv',
  `select public.rpc_tlv5_import_case('${caseJson('TLV5-TESTFX-0777', 'PILOT', 77, design('SYN-NCT-0777'))}'::jsonb)`,
  { error: /check constraint|violates/ },
);
await step(
  'V5-ID-03',
  'v5-categories',
  'a CAL5- ID cannot be a FORMAL case',
  'inv',
  `select public.rpc_tlv5_import_case('${caseJson('CAL5-TESTFX-77', 'FORMAL', 77, design('SYN-NCT-0777'))}'::jsonb)`,
  { error: /check constraint|violates/ },
);
await step(
  'V5-ID-04',
  'v5-categories',
  'a v4 held-out ID (HO4-) cannot be a v5 FORMAL case',
  'inv',
  `select public.rpc_tlv5_import_case('${caseJson('HO4-TESTFX-077', 'FORMAL', 77, design('SYN-NCT-0777'))}'::jsonb)`,
  { error: /check constraint|violates/ },
);
await step(
  'V5-ID-05',
  'v5-categories',
  'a FORMAL case cannot be imported without its design row',
  'inv',
  `select public.rpc_tlv5_import_case('${caseJson(F(7), 'FORMAL', 77)}'::jsonb)`,
  { error: /need a design row/ },
);
await step(
  'V5-PKT-01',
  'v5-blinding',
  'a packet with a labels key is refused',
  'inv',
  `select public.rpc_tlv5_import_case('${caseJson(F(7), 'FORMAL', 77, design('SYN-NCT-0777'), packet(77, {}, { labels: { AREA_ONCOLOGY: 'YES' } }))}'::jsonb)`,
  { error: /top-level key "labels"/ },
);
await step(
  'V5-PKT-02',
  'v5-blinding',
  'a packet with an enrollment field is refused',
  'inv',
  `select public.rpc_tlv5_import_case('${caseJson(F(7), 'FORMAL', 77, design('SYN-NCT-0777'), packet(77, { enrollment: 120 }))}'::jsonb)`,
  { error: /trial packet key "enrollment"/ },
);
await step(
  'V5-PKT-03',
  'v5-blinding',
  'a packet with an eligibility sex field is refused',
  'inv',
  `select public.rpc_tlv5_import_case('${caseJson(F(7), 'FORMAL', 77, design('SYN-NCT-0777'), packet(77, { eligibility_sex: 'ALL' }))}'::jsonb)`,
  { error: /trial packet key "eligibility_sex"/ },
);
await step(
  'V5-PKT-04',
  'v5-blinding',
  'a packet with MeSH tree numbers is refused',
  'inv',
  `select public.rpc_tlv5_import_case('${caseJson(F(7), 'FORMAL', 77, design('SYN-NCT-0777'), packet(77, { condition_mesh_headings: [{ name: 'Synthetic heading', tree_numbers: ['C04.999'] }] }))}'::jsonb)`,
  { error: /trial packet key "tree_numbers"/ },
);
const fakeId = ['NCT99', '000001'].join(''); // placeholder-format registry identifier (NCT99 prefix: never a real record)
await step(
  'V5-PKT-05',
  'v5-blinding',
  'a packet whose text carries a registry identifier is refused (identifier passed as a parameter)',
  'inv',
  'select public.rpc_tlv5_import_case($1::jsonb)',
  { error: /carry no NCT identifier/ },
  [
    caseJson(
      F(7),
      'FORMAL',
      77,
      design('SYN-NCT-0777'),
      packet(77, { brief_summary: `See ${fakeId}.` }),
    ),
  ],
);
await step(
  'V5-PKT-06',
  'v5-blinding',
  'the identifier check is case-insensitive',
  'inv',
  'select public.rpc_tlv5_import_case($1::jsonb)',
  { error: /carry no NCT identifier/ },
  [
    caseJson(
      F(7),
      'FORMAL',
      77,
      design('SYN-NCT-0777'),
      packet(77, { brief_summary: `see ${fakeId.toLowerCase()}` }),
    ),
  ],
);
await step(
  'V5-PKT-07',
  'v5-blinding',
  'a packet whose text carries a registry address is refused',
  'inv',
  'select public.rpc_tlv5_import_case($1::jsonb)',
  { error: /registry address/ },
  [
    caseJson(
      F(7),
      'FORMAL',
      77,
      design('SYN-NCT-0777'),
      packet(77, { brief_summary: 'see clinicaltrials.gov for the record' }),
    ),
  ],
);
await step(
  'V5-PKT-08',
  'v5-blinding',
  'a packet with a nested sampling key is refused',
  'inv',
  `select public.rpc_tlv5_import_case('${caseJson(F(7), 'FORMAL', 77, design('SYN-NCT-0777'), packet(77, { interventions: [{ name: 'x', sampling_weight: 3 }] }))}'::jsonb)`,
  { error: /trial packet key "sampling_weight"/ },
);
await step(
  'V5-DES-01',
  'v5-integrity',
  'a design row whose selection probability is not n/N is refused',
  'inv',
  `select public.rpc_tlv5_import_case('${caseJson(F(7), 'FORMAL', 77, design('SYN-NCT-0777', { frame_stratum_size: 20, n_sampled_in_stratum: 2, selection_probability: 0.3 }))}'::jsonb)`,
  { error: /check constraint|violates/ },
);
await step(
  'V5-DES-02',
  'v5-integrity',
  'a development-linked trial cannot be Tier 1 eligible',
  'inv',
  `select public.rpc_tlv5_import_case('${caseJson(F(7), 'FORMAL', 77, design('SYN-NCT-0777', { dev_linked: true, tier1_eligible: true }))}'::jsonb)`,
  { error: /check constraint|violates/ },
);
await step(
  'V5-DES-03',
  'v5-integrity',
  'a malformed trial identifier is refused',
  'inv',
  `select public.rpc_tlv5_import_case('${caseJson(F(7), 'FORMAL', 77, design('TRIAL-77'))}'::jsonb)`,
  { error: /check constraint|violates/ },
);
await step(
  'V5-DES-04',
  'v5-integrity',
  'nothing of a refused import is left behind (statement atomicity)',
  'owner',
  `select count(*)::int as n from public.tlv5_cases where case_id='${F(7)}'`,
  { value: 0 },
);

const formalPlan = {
  [F(1)]: {
    d: design('SYN-NCT-1001', {
      stratum: 'SYN_T01',
      variance_stratum: 'SYN_T01',
      frame_stratum_size: 20,
      n_sampled_in_stratum: 2,
      selection_probability: 0.1,
      figure2_rows: 'DIAB',
    }),
    lab: { areas: ['METABOLIC'], rows: ['DIAB'], ruleD: 'D1_KEEP_TYPE2' },
  },
  [F(2)]: {
    d: design('SYN-NCT-1002', {
      stratum: 'SYN_T01',
      variance_stratum: 'SYN_T01',
      frame_stratum_size: 20,
      n_sampled_in_stratum: 2,
      selection_probability: 0.1,
      figure2_rows: 'CAN_ALL',
      dev_linked: true,
      tier1_eligible: false,
    }),
    lab: {
      areas: ['ONCOLOGY', 'CARDIOVASCULAR'],
      v12: ['ONCOLOGY'],
      rows: ['CAN_ALL'],
      ruleK: 'K_KEEP_MALIGNANT_COMPATIBLE',
      dev: true,
    },
  },
  [F(3)]: {
    d: design('SYN-NCT-1003', {
      stratum: 'SYN_T02',
      variance_stratum: 'SYN_T02',
      frame_stratum_size: 10,
      n_sampled_in_stratum: 2,
      selection_probability: 0.2,
      figure2_rows: 'DIAB',
    }),
    lab: { areas: ['METABOLIC'], rows: ['DIAB'], ruleD: 'D4A_KEEP_UNRESOLVED_PARENT_ONLY' },
  },
  [F(4)]: {
    d: design('SYN-NCT-1004', {
      stratum: 'SYN_T02',
      variance_stratum: 'SYN_T02',
      frame_stratum_size: 10,
      n_sampled_in_stratum: 2,
      selection_probability: 0.2,
      figure2_rows: 'CAN_ALL',
      dev_linked: true,
      tier1_eligible: false,
    }),
    lab: {
      areas: ['ONCOLOGY', 'RESPIRATORY'],
      rows: ['CAN_ALL'],
      ruleK: 'K_KEEP_HEURISTIC_NONMALIGNANT_CLASS',
      dev: true,
    },
  },
};
const formalIds = Object.keys(formalPlan);
for (const [i, id] of formalIds.entries()) {
  await step(
    `V5-IMP-01-${id}`,
    'v5-setup',
    `import formal case ${id} with its design row`,
    'inv',
    `select public.rpc_tlv5_import_case('${caseJson(id, 'FORMAL', 101 + i, formalPlan[id].d)}'::jsonb)`,
    { value: id },
  );
}
const SET = 'LBL5-TESTFX';
const formalLabels = formalIds.flatMap((id) => labelSet(SET, id, formalPlan[id].lab));
const withoutPain4 = formalLabels.filter(
  (x) => !(x.case_id === F(4) && x.item_code === 'FIG2_ROW_PAIN'),
);
await step(
  'V5-LBL-00',
  'v5-roles',
  'a reviewer cannot import frozen labels',
  'r1',
  `select public.rpc_tlv5_import_frozen_labels('${J(withoutPain4.slice(0, 1))}'::jsonb)`,
  { error: /investigator role/ },
);
await step(
  'V5-LBL-01',
  'v5-setup',
  `import the formal frozen labels except one row (${withoutPain4.length} rows)`,
  'inv',
  `select public.rpc_tlv5_import_frozen_labels('${J(withoutPain4)}'::jsonb)`,
  { value: withoutPain4.length },
);
const one = (o) =>
  J([
    Object.assign(
      {
        label_set_id: SET,
        case_id: F(1),
        item_code: 'RULE_K',
        label_primary: 'K_KEEP_MALIGNANT_COMPATIBLE',
      },
      o,
    ),
  ]);
await step(
  'V5-LBL-02',
  'v5-predictions',
  'a label for an unknown case is refused',
  'inv',
  `select public.rpc_tlv5_import_frozen_labels('${one({ case_id: 'TLV5-TESTFX-0999' })}'::jsonb)`,
  { error: /rows matched a v5 case/ },
);
await step(
  'V5-LBL-03',
  'v5-predictions',
  'an area label needs the secondary (curated v1.2) label',
  'inv',
  `select public.rpc_tlv5_import_frozen_labels('${one({ case_id: F(4), item_code: 'AREA_ONCOLOGY', label_primary: 'YES', dev_linked_area: true })}'::jsonb)`,
  { error: /violates check constraint "tlv5_frozen_labels_check"/ },
);
await step(
  'V5-LBL-03b',
  'v5-predictions',
  'a condition-row label carries no secondary label',
  'inv',
  `select public.rpc_tlv5_import_frozen_labels('${one({ case_id: F(4), item_code: 'FIG2_ROW_PAIN', label_primary: 'NO', label_secondary: 'NO' })}'::jsonb)`,
  { error: /violates check constraint "tlv5_frozen_labels_check"/ },
);
await step(
  'V5-LBL-04',
  'v5-predictions',
  'a condition-row label carries no development flag',
  'inv',
  `select public.rpc_tlv5_import_frozen_labels('${one({ case_id: F(4), item_code: 'FIG2_ROW_PAIN', label_primary: 'NO', dev_linked_area: true })}'::jsonb)`,
  { error: /check constraint|violates/ },
);
await step(
  'V5-LBL-05',
  'v5-predictions',
  'an unknown rule D outcome is refused',
  'inv',
  `select public.rpc_tlv5_import_frozen_labels('${one({ case_id: F(2), item_code: 'RULE_D', label_primary: 'D9_UNKNOWN' })}'::jsonb)`,
  { error: /check constraint|violates/ },
);
await step(
  'V5-LBL-06',
  'v5-predictions',
  'one label set per mode',
  'inv',
  `select public.rpc_tlv5_import_frozen_labels('${one({ label_set_id: 'LBL5-OTHER', case_id: F(4), item_code: 'FIG2_ROW_PAIN', label_primary: 'NO' })}'::jsonb)`,
  { error: /one label set per mode/ },
);
await step(
  'V5-LBL-07',
  'v5-predictions',
  'a second label for the same case and item is refused',
  'inv',
  `select public.rpc_tlv5_import_frozen_labels('${one({ case_id: F(1), item_code: 'FIG2_ROW_DIAB', label_primary: 'NO' })}'::jsonb)`,
  { error: /duplicate key/ },
);
await step(
  'V5-LBL-08',
  'v5-predictions',
  'subgroup items are reviewer items, never frozen labels',
  'inv',
  `select public.rpc_tlv5_import_frozen_labels('${one({ case_id: F(1), item_code: 'SG_DIABETES_TYPE', label_primary: 'TYPE_2' })}'::jsonb)`,
  { error: /check constraint|violates/ },
);
await step(
  'V5-LBL-08b',
  'v5-predictions',
  'an unknown item code is refused as a frozen label',
  'inv',
  `select public.rpc_tlv5_import_frozen_labels('${one({ case_id: F(4), item_code: 'AREA_DERMATOLOGY', label_primary: 'NO', label_secondary: 'NO', dev_linked_area: false })}'::jsonb)`,
  { error: /violates check constraint/ },
);
await step(
  'V5-LBL-09',
  'v5-predictions',
  'the stored row hash follows the documented procedure',
  'inv',
  `select row_sha256 as v from public.tlv5_frozen_labels where case_id='${F(2)}' and item_code='AREA_CARDIOVASCULAR'`,
  {
    value: sha256(
      rowText(
        formalLabels.find((x) => x.case_id === F(2) && x.item_code === 'AREA_CARDIOVASCULAR'),
      ),
    ),
  },
);
for (const who of ['r1', 'r2', 'adj', 'out', 'pt1']) {
  await step(
    `V5-LBL-10-${who}`,
    'v5-blinding',
    `${who} reads no frozen label`,
    who,
    'select * from public.tlv5_frozen_labels',
    { rows: 0 },
  );
  await step(
    `V5-LBL-11-${who}`,
    'v5-blinding',
    `${who} reads no design row`,
    who,
    'select * from public.tlv5_case_design',
    { rows: 0 },
  );
}
await step(
  'V5-LBL-12',
  'v5-blinding',
  'r1 reads no FORMAL case before assignment',
  'r1',
  "select * from public.tlv5_cases where mode='FORMAL'",
  { rows: 0 },
);
await step(
  'V5-LBL-13',
  'v5-blinding',
  'anon cannot read frozen labels',
  'anon',
  'select * from public.tlv5_frozen_labels',
  { error: /permission denied/ },
);

// =============================================================================
// F. Freeze (once; case-list and label-set hashes)
// =============================================================================
await step(
  'V5-GATE-01',
  'v5-gate',
  'FORMAL assignments are refused before the freeze',
  'inv',
  `select public.rpc_tlv5_assign('FORMAL','${R1}',1,${arr([F(1)])},11)`,
  { error: /only after rpc_tlv5_freeze/ },
);
await step(
  'V5-GATE-02',
  'v5-gate',
  'the formal phase cannot open before the freeze',
  'inv',
  `select public.rpc_tlv5_phase('FORMAL_OPENED', '${J({ attestation: ATT })}'::jsonb)`,
  { error: /freeze the v5 sample and labels/ },
);
const freeze = (o = {}) =>
  `select public.rpc_tlv5_freeze('${J(Object.assign({ label_file_sha256: '4'.repeat(64), frozen_items: { 'REVIEW_RUBRIC_v5.md': '5'.repeat(64), 'REVIEW_SAMPLE_v5.csv': '6'.repeat(64) }, attestation: ATT }, o))}'::jsonb)`;
await step('V5-FRZ-00', 'v5-roles', 'a reviewer cannot freeze', 'r1', freeze(), {
  error: /investigator role/,
});
await step(
  'V5-FRZ-01',
  'v5-gate',
  'the freeze is refused while a required label is missing',
  'inv',
  freeze(),
  { error: /1 required area or row labels are missing/ },
);
await step(
  'V5-FRZ-02',
  'v5-setup',
  'import the missing label',
  'inv',
  `select public.rpc_tlv5_import_frozen_labels('${J(formalLabels.filter((x) => x.case_id === F(4) && x.item_code === 'FIG2_ROW_PAIN'))}'::jsonb)`,
  { value: 1 },
);
await step(
  'V5-FRZ-03',
  'v5-freeze',
  'frozen items must be SHA-256 values',
  'inv',
  freeze({ frozen_items: { 'REVIEW_RUBRIC_v5.md': 'not-a-hash' } }),
  { error: /is not a SHA-256 value/ },
);
await step(
  'V5-FRZ-04',
  'v5-setup',
  'investigator freezes the sample and the labels',
  'inv',
  freeze(),
  { minRows: 1 },
);
await step(
  'V5-FRZ-05',
  'v5-freeze',
  'the freeze records 4 cases and 72 label rows',
  'inv',
  "select n_cases || '|' || n_label_rows as v from public.tlv5_freeze",
  { value: '4|72' },
);
await step(
  'V5-FRZ-06',
  'v5-freeze',
  'the case-list hash equals SHA-256 of the sorted case IDs joined by line feeds',
  'inv',
  'select case_list_sha256 as v from public.tlv5_freeze',
  { value: sha256([...formalIds].sort().join('\n')) },
);
await step(
  'V5-FRZ-07',
  'v5-freeze',
  'the label-set hash equals the procedure of scripts/03_draw_sample_v5.py',
  'inv',
  'select label_rows_sha256 as v from public.tlv5_freeze',
  { value: labelSetSha(formalLabels) },
);
await step(
  'V5-FRZ-08',
  'v5-freeze',
  'the frozen labels verify against the freeze record',
  'inv',
  'select matches from public.rpc_tlv5_verify_frozen_labels()',
  { value: true },
);
await step('V5-FRZ-09', 'v5-gate', 'a second freeze is refused', 'inv', freeze(), {
  error: /already happened/,
});
await step(
  'V5-FRZ-10',
  'v5-integrity',
  'no FORMAL case can be added after the freeze',
  'inv',
  `select public.rpc_tlv5_import_case('${caseJson(F(5), 'FORMAL', 105, design('SYN-NCT-1005', { stratum: 'SYN_T02', variance_stratum: 'SYN_T02', frame_stratum_size: 10, n_sampled_in_stratum: 2, selection_probability: 0.2 }))}'::jsonb)`,
  { error: /the v5 sample is frozen/ },
);
await step(
  'V5-FRZ-11',
  'v5-integrity',
  'no label can be added after the freeze',
  'inv',
  `select public.rpc_tlv5_import_frozen_labels('${one({})}'::jsonb)`,
  { error: /labels are frozen/ },
);
await step(
  'V5-FRZ-12',
  'v5-integrity',
  'no calibration case can be added after the freeze',
  'inv',
  `select public.rpc_tlv5_import_case('${caseJson('CAL5-TESTFX-03', 'CALIBRATION', 53)}'::jsonb)`,
  { error: /the v5 sample is frozen/ },
);
await step(
  'V5-FRZ-13',
  'v5-calibration',
  'calibration assignments close at the freeze',
  'inv',
  `select public.rpc_tlv5_assign('CALIBRATION','${R1}',1,${arr(['CAL5-TESTFX-02'])},8)`,
  { error: /duplicate key|calibration closes at the freeze/ },
);
await submit(
  'V5-FRZ-14',
  'v5-calibration',
  'calibration submissions close at the freeze',
  'r1',
  R1,
  'CAL5-TESTFX-02',
  answers({ areas: ['INFECTIOUS'], rows: ['COV'] }),
  { error: /calibration closed at the freeze/ },
);
await step(
  'V5-FRZ-15',
  'v5-immutability',
  'the freeze row cannot be deleted (owner role)',
  'owner',
  'delete from public.tlv5_freeze',
  { error: /append-only/ },
);
for (const who of ['r1', 'adj'])
  await step(
    `V5-FRZ-16-${who}`,
    'v5-blinding',
    `${who} reads no freeze row`,
    who,
    'select * from public.tlv5_freeze',
    { rows: 0 },
  );

// =============================================================================
// W. Formal phase: open, assignments, submissions, refusals, no interim look, close
// =============================================================================
await step(
  'V5-GATE-03',
  'v5-gate',
  'FORMAL assignments are refused after the freeze while the phase is not open',
  'inv',
  `select public.rpc_tlv5_assign('FORMAL','${R1}',1,${arr([F(1)])},11)`,
  { error: /need the formal phase open/ },
);
await step(
  'V5-PH-01',
  'v5-roles',
  'a reviewer cannot open the formal phase',
  'r1',
  `select public.rpc_tlv5_phase('FORMAL_OPENED', '${J({ attestation: ATT })}'::jsonb)`,
  { error: /investigator role/ },
);
await step(
  'V5-PH-02',
  'v5-setup',
  'investigator opens the formal phase',
  'inv',
  `select public.rpc_tlv5_phase('FORMAL_OPENED', '${J({ attestation: ATT })}'::jsonb)`,
  { minRows: 1 },
);
await step(
  'V5-PH-03',
  'v5-gate',
  'the formal phase opens once',
  'inv',
  `select public.rpc_tlv5_phase('FORMAL_OPENED', '${J({ attestation: ATT })}'::jsonb)`,
  { error: /opens once/ },
);
await step(
  'V5-ASG-01',
  'v5-categories',
  'a pilot account cannot take a FORMAL case',
  'inv',
  `select public.rpc_tlv5_assign('FORMAL','${PT1}',1,${arr([F(1)])},11)`,
  { error: /mode contamination blocked/ },
);
await step(
  'V5-ASG-02',
  'v5-setup',
  'assign three formal cases to R1 (slot 1)',
  'inv',
  `select public.rpc_tlv5_assign('FORMAL','${R1}',1,${arr(formalIds.slice(0, 3))},11)`,
  { value: 3 },
);
await step(
  'V5-ASG-03',
  'v5-setup',
  'assign four formal cases to R2 (slot 2)',
  'inv',
  `select public.rpc_tlv5_assign('FORMAL','${R2}',2,${arr(formalIds)},12)`,
  { value: 4 },
);
await step(
  'V5-ASG-04',
  'v5-integrity',
  'a reviewer keeps one slot for all cases of a mode',
  'inv',
  `select public.rpc_tlv5_assign('FORMAL','${R1}',2,${arr([F(4)])},11)`,
  { error: /already holds slot 1/ },
);
await step(
  'V5-ASG-05',
  'v5-setup',
  'assign the fourth formal case to R1 (slot 1)',
  'inv',
  `select public.rpc_tlv5_assign('FORMAL','${R1}',1,${arr([F(4)])},11)`,
  { value: 1 },
);
await step(
  'V5-ASG-06',
  'v5-workflow',
  'r1 sees 4 FORMAL queue positions, all distinct',
  'r1',
  "select count(distinct queue_position)::int as n from public.v_tlv5_my_queue where mode='FORMAL'",
  { value: 4 },
);
await step(
  'V5-ASG-07',
  'v5-blinding',
  'r1 reads its 4 FORMAL cases',
  'r1',
  "select * from public.tlv5_cases where mode='FORMAL'",
  { rows: 4 },
);
await step(
  'V5-ASG-08',
  'v5-blinding',
  'r1 still reads no design row and no label',
  'r1',
  'select ((select count(*) from public.tlv5_case_design) + (select count(*) from public.tlv5_frozen_labels))::int as n',
  { value: 0 },
);

// submissions
const A = {
  r1_1a: answers({ areas: ['METABOLIC', 'CARDIOVASCULAR'], rows: ['DIAB'] }),
  r1_1b: answers({ areas: ['METABOLIC'], rows: ['DIAB'] }),
  r2_1: answers({ areas: ['METABOLIC'], rows: ['DIAB'] }),
  r1_2: answers({ areas: ['ONCOLOGY', 'CARDIOVASCULAR'], rows: ['CAN_ALL'], sgK: 'MALIGNANT' }),
  r2_2: answers({
    areas: ['ONCOLOGY'],
    rows: ['CAN_ALL'],
    sgK: 'NON_MALIGNANT',
    sgKdetail: 'PRECANCEROUS',
  }),
  r1_3: answers({ areas: ['METABOLIC'], rows: ['DIAB'], sgD: 'TYPE_2' }),
  r2_3: answers({
    areaAns: { METABOLIC: 'INSUFFICIENT_INFORMATION' },
    rows: [],
    note: { item: 'AREA_METABOLIC', text: 'synthetic note' },
  }),
  r1_4: answers({ areas: ['ONCOLOGY'], rows: ['CAN_ALL'], sgK: 'MALIGNANT' }),
};
await submit(
  'V5-SUB-01',
  'v5-workflow',
  `r1 submits ${F(1)} (first version)`,
  'r1',
  R1,
  F(1),
  A.r1_1a,
  { minRows: 1 },
);
await submit(
  'V5-SUB-02',
  'v5-workflow',
  `r1 revises ${F(1)} before the close`,
  'r1',
  R1,
  F(1),
  A.r1_1b,
  { minRows: 1 },
);
await submit('V5-SUB-03', 'v5-workflow', `r1 submits ${F(2)}`, 'r1', R1, F(2), A.r1_2, {
  minRows: 1,
});
await submit(
  'V5-SUB-04',
  'v5-workflow',
  `r1 submits ${F(3)} (diabetes row YES with a type)`,
  'r1',
  R1,
  F(3),
  A.r1_3,
  { minRows: 1 },
);
await submit('V5-SUB-05', 'v5-workflow', `r1 submits ${F(4)}`, 'r1', R1, F(4), A.r1_4, {
  minRows: 1,
});
await submit('V5-SUB-06', 'v5-workflow', `r2 submits ${F(1)}`, 'r2', R2, F(1), A.r2_1, {
  minRows: 1,
});
await submit(
  'V5-SUB-07',
  'v5-workflow',
  `r2 submits ${F(2)} (malignancy NON_MALIGNANT, detail PRECANCEROUS)`,
  'r2',
  R2,
  F(2),
  A.r2_2,
  { minRows: 1 },
);
await submit(
  'V5-SUB-08',
  'v5-workflow',
  `r2 submits ${F(3)} (diabetes row NO, so no type item; metabolic INSUFFICIENT_INFORMATION)`,
  'r2',
  R2,
  F(3),
  A.r2_3,
  { minRows: 1 },
);
// refused submissions (on the r2 assignment for case 4, which r2 never completes)
const base4 = { areas: ['ONCOLOGY'], rows: ['CAN_ALL'] };
await submit(
  'V5-SUB-10',
  'v5-refusal',
  'a submission missing an area item is refused',
  'r2',
  R2,
  F(4),
  answers(Object.assign({ drop: ['AREA_RESPIRATORY'] }, base4)),
  { error: /answers all 7 area items/ },
);
await submit(
  'V5-SUB-11',
  'v5-refusal',
  'a submission missing a condition-row item is refused',
  'r2',
  R2,
  F(4),
  answers(Object.assign({ drop: ['FIG2_ROW_PAIN'] }, base4)),
  { error: /all 10 condition-row items/ },
);
await submit(
  'V5-SUB-12',
  'v5-refusal',
  'a diabetes-type answer is refused when the reviewer answers the diabetes row NO',
  'r2',
  R2,
  F(4),
  answers(Object.assign({ extra: [{ item_code: 'SG_DIABETES_TYPE', answer: 'TYPE_2' }] }, base4)),
  { error: /shown only when the reviewer answers FIG2_ROW_DIAB YES/ },
);
await submit(
  'V5-SUB-13',
  'v5-refusal',
  'the malignancy item is required when the reviewer answers the neoplasms row YES',
  'r2',
  R2,
  F(4),
  answers(Object.assign({ sgK: null }, base4)),
  { error: /subgroup items: answer/ },
);
await submit(
  'V5-SUB-14',
  'v5-refusal',
  'an answer outside the item scale is refused',
  'r2',
  R2,
  F(4),
  answers(Object.assign({ areaAns: { ONCOLOGY: 'MAYBE' } }, base4)),
  { error: /check constraint|violates/ },
);
await submit(
  'V5-SUB-15',
  'v5-refusal',
  'a condition-row answer of CONTEXT_DEPENDENT is refused (rows take YES, NO or INSUFFICIENT_INFORMATION)',
  'r2',
  R2,
  F(4),
  answers(Object.assign({ rowAns: { HTN: 'CONTEXT_DEPENDENT' } }, base4)),
  { error: /check constraint|violates/ },
);
await submit(
  'V5-SUB-16',
  'v5-refusal',
  'a detail code that does not fit the answer is refused',
  'r2',
  R2,
  F(4),
  answers(Object.assign({ sgK: 'MALIGNANT', sgKdetail: 'PRECANCEROUS' }, base4)),
  { error: /check constraint|violates/ },
);
await submit(
  'V5-SUB-16b',
  'v5-refusal',
  'a diabetes type of OTHER needs a detail code',
  'r2',
  R2,
  F(4),
  answers({ areas: ['ONCOLOGY'], rows: ['CAN_ALL', 'DIAB'], sgD: 'OTHER' }),
  { error: /violates check constraint "tlv5_submission_items_check1"/ },
);
await submit(
  'V5-SUB-16c',
  'v5-refusal',
  'detail OTHER_SPECIFIED needs a note',
  'r2',
  R2,
  F(4),
  answers({
    areas: ['ONCOLOGY'],
    rows: ['CAN_ALL', 'DIAB'],
    sgD: 'OTHER',
    sgDdetail: 'OTHER_SPECIFIED',
  }),
  { error: /OTHER_SPECIFIED needs a note/ },
);
await submit(
  'V5-SUB-17',
  'v5-refusal',
  'an unknown item is refused',
  'r2',
  R2,
  F(4),
  answers(Object.assign({ extra: [{ item_code: 'AREA_DERMATOLOGY', answer: 'NO' }] }, base4)),
  { error: /check constraint|violates/ },
);
await submit(
  'V5-SUB-18',
  'v5-refusal',
  'a duplicated item is refused',
  'r2',
  R2,
  F(4),
  answers(Object.assign({ extra: [{ item_code: 'AREA_ONCOLOGY', answer: 'YES' }] }, base4)),
  { error: /duplicate key/ },
);
await submit(
  'V5-SUB-19',
  'v5-refusal',
  'a packet issue flag needs a note',
  'r2',
  R2,
  F(4),
  answers(Object.assign({ header: { packet_issue_flag: true } }, base4)),
  { error: /check constraint|violates/ },
);
await step(
  'V5-SUB-20',
  'v5-roles',
  'r1 cannot submit on an r2 assignment',
  'r1',
  `select public.rpc_tlv5_submit('${await asg5(R2, F(4))}', '${J(answers(base4))}'::jsonb)`,
  { error: /not your v5 assignment/ },
);
for (const who of ['inv', 'adj']) {
  await step(
    `V5-SUB-21-${who}`,
    'v5-roles',
    `${who} cannot submit a reviewer judgment`,
    who,
    `select public.rpc_tlv5_submit('${await asg5(R2, F(4))}', '${J(answers(base4))}'::jsonb)`,
    { error: /not your v5 assignment/ },
  );
}
await step(
  'V5-SUB-22',
  'v5-refusal',
  'refused submissions leave no row behind (r2 has 3 FORMAL submissions)',
  'owner',
  `select count(*)::int as n from public.tlv5_submissions where reviewer_pseudo_id='${R2}' and mode='FORMAL'`,
  { value: 3 },
);
await step(
  'V5-SUB-23',
  'v5-integrity',
  'direct inserts into the submission table are refused (writes go through the RPC)',
  'r1',
  `insert into public.tlv5_submissions (assignment_id, case_id, mode, reviewer_pseudo_id, revision_number, content_sha256) values ('${await asg5(R1, F(1))}', '${F(1)}', 'FORMAL', '${R1}', 9, '${'0'.repeat(64)}')`,
  { error: /permission denied/ },
);

// no interim look while the formal phase is open
await step(
  'V5-INT-01',
  'v5-interim',
  'the investigator reads no FORMAL submission while the phase is open',
  'inv',
  "select * from public.tlv5_submissions where mode='FORMAL'",
  { rows: 0 },
);
await step(
  'V5-INT-02',
  'v5-interim',
  'the investigator reads no FORMAL submission item while the phase is open',
  'inv',
  "select i.* from public.tlv5_submission_items i join public.tlv5_cases c on true where false or i.submission_id in (select submission_id from public.tlv5_submissions where mode='FORMAL')",
  { rows: 0 },
);
await step(
  'V5-INT-03',
  'v5-interim',
  'the FORMAL independent judgments are empty while the phase is open',
  'inv',
  "select * from public.v_tlv5_independent_judgments where mode='FORMAL'",
  { rows: 0 },
);
await step(
  'V5-INT-04',
  'v5-interim',
  'the FORMAL adjudication queue is empty while the phase is open',
  'inv',
  "select * from public.v_tlv5_adjudication_queue where mode='FORMAL'",
  { rows: 0 },
);
await step(
  'V5-INT-05',
  'v5-interim',
  'the adjudicator reads no FORMAL case while the phase is open',
  'adj',
  "select * from public.tlv5_cases where mode='FORMAL'",
  { rows: 0 },
);
await step(
  'V5-INT-06',
  'v5-interim',
  'the adjudicator reads no FORMAL submission while the phase is open',
  'adj',
  "select * from public.tlv5_submissions where mode='FORMAL'",
  { rows: 0 },
);
await step(
  'V5-INT-07',
  'v5-blinding',
  'r2 reads none of the r1 submissions',
  'r2',
  `select * from public.tlv5_submissions where reviewer_pseudo_id='${R1}'`,
  { rows: 0 },
);
await step(
  'V5-INT-08',
  'v5-interim',
  'no audit row exposes a v5 answer, item code or note',
  'inv',
  "select audit_id from public.audit_log where entity_table = 'tlv5_submission_items' and (details ? 'answer' or details ? 'item_code' or details ? 'note' or details ? 'detail_code' or details ? 'uncertain')",
  { rows: 0 },
);
await step(
  'V5-INT-09',
  'v5-interim',
  'no audit row exposes a submission comment',
  'inv',
  "select audit_id from public.audit_log where entity_table = 'tlv5_submissions' and (details ? 'overall_comment' or details ? 'packet_issue_note')",
  { rows: 0 },
);
await step(
  'V5-INT-10',
  'v5-interim',
  'the 8 FORMAL submissions are in the audit log as identifiers and a hash',
  'inv',
  "select count(*)::int as n from public.audit_log where entity_table = 'tlv5_submissions' and mode = 'FORMAL' and details ? 'content_sha256'",
  { value: 8 },
);
await step(
  'V5-INT-11',
  'v5-interim',
  'completion counts while open (no answer content): R1 4 of 4, R2 3 of 4',
  'inv',
  "select string_agg(n_submitted || '/' || n_assigned, ',' order by reviewer_slot) as v from public.rpc_tlv5_completion_summary('FORMAL')",
  { value: '4/4,3/4' },
);
await step(
  'V5-INT-12',
  'v5-roles',
  'a reviewer cannot read completion counts',
  'r1',
  "select * from public.rpc_tlv5_completion_summary('FORMAL')",
  { error: /investigator role/ },
);
await step(
  'V5-INT-13',
  'v5-gate',
  'FORMAL adjudication is refused while the phase is open',
  'adj',
  adjud({
    case_id: F(2),
    item_code: 'AREA_CARDIOVASCULAR',
    decision: 'NO',
    status: 'DISCORDANT_RESOLVED',
    basis: 'REVIEWER_2',
    rationale: 'synthetic',
    disagreement_reason_code: 'TRIAL_CONTEXT',
  }),
  { error: /only after the v5 formal phase closes/ },
);
await step(
  'V5-INT-14',
  'v5-gate',
  'the snapshot is refused while the phase is open',
  'inv',
  'select public.rpc_tlv5_snapshot()',
  { error: /after the formal phase closes/ },
);
await step(
  'V5-INT-15',
  'v5-gate',
  'the FORMAL lock is refused while the phase is open',
  'inv',
  `select public.rpc_tlv5_lock_reference('FORMAL', '${ATT}')`,
  { error: /only after the close and the snapshot/ },
);

// close
await step(
  'V5-CLOSE-01',
  'v5-gate',
  'a COMPLETE close is refused while an assignment has no submission',
  'inv',
  `select public.rpc_tlv5_phase('FORMAL_CLOSED_COMPLETE', '${J({ attestation: ATT })}'::jsonb)`,
  { error: /1 FORMAL assignments have no submission/ },
);
await step(
  'V5-CLOSE-02',
  'v5-setup',
  'investigator closes the formal phase as INCOMPLETE',
  'inv',
  `select public.rpc_tlv5_phase('FORMAL_CLOSED_INCOMPLETE', '${J({ attestation: ATT })}'::jsonb)`,
  { minRows: 1 },
);
await step(
  'V5-CLOSE-03',
  'v5-gate',
  'a second close is refused',
  'inv',
  `select public.rpc_tlv5_phase('FORMAL_CLOSED_COMPLETE', '${J({ attestation: ATT })}'::jsonb)`,
  { error: /is not open/ },
);
await submit(
  'V5-CLOSE-04',
  'v5-gate',
  'no submission after the close',
  'r2',
  R2,
  F(4),
  answers(base4),
  { error: /not open for submissions/ },
);
await step(
  'V5-CLOSE-05',
  'v5-gate',
  'no assignment after the close',
  'inv',
  `select public.rpc_tlv5_assign('FORMAL','${R2}',2,${arr([F(4)])},12)`,
  { error: /duplicate key|need the formal phase open/ },
);

// =============================================================================
// N. Snapshot of the independent judgments (after the close, before any FORMAL adjudication)
// =============================================================================
await step(
  'V5-SNAP-01',
  'v5-gate',
  'FORMAL adjudication is refused before the snapshot',
  'adj',
  adjud({
    case_id: F(2),
    item_code: 'AREA_CARDIOVASCULAR',
    decision: 'NO',
    status: 'DISCORDANT_RESOLVED',
    basis: 'REVIEWER_2',
    rationale: 'synthetic',
    disagreement_reason_code: 'TRIAL_CONTEXT',
  }),
  { error: /take the independent-judgment snapshot/ },
);
await step(
  'V5-SNAP-02',
  'v5-blinding',
  'the adjudicator reads no FORMAL submission before the snapshot',
  'adj',
  "select * from public.tlv5_submissions where mode='FORMAL'",
  { rows: 0 },
);
await step(
  'V5-SNAP-03',
  'v5-export',
  'after the close the investigator reads the FORMAL judgments: (4 + 3) assignments x 19 items',
  'inv',
  "select * from public.v_tlv5_independent_judgments where mode='FORMAL'",
  { rows: 133 },
);
await step(
  'V5-SNAP-04',
  'v5-roles',
  'a reviewer cannot take the snapshot',
  'r1',
  'select public.rpc_tlv5_snapshot()',
  { error: /investigator role/ },
);
await step(
  'V5-SNAP-05',
  'v5-setup',
  'investigator takes the snapshot',
  'inv',
  'select public.rpc_tlv5_snapshot()',
  { minRows: 1 },
);
await step(
  'V5-SNAP-06',
  'v5-snapshot',
  'the snapshot holds 133 judgment rows',
  'inv',
  'select n_rows::int as n from public.tlv5_snapshot',
  { value: 133 },
);
await step(
  'V5-SNAP-07',
  'v5-snapshot',
  'the snapshot verifies',
  'inv',
  'select matches from public.rpc_tlv5_verify_snapshot()',
  { value: true },
);
await step(
  'V5-SNAP-08',
  'v5-snapshot',
  'a second snapshot is refused',
  'inv',
  'select public.rpc_tlv5_snapshot()',
  { error: /duplicate key|already/ },
);

// =============================================================================
// J. Blinded adjudication (ADJUDICATOR only; DISAGREEMENTS_ONLY)
// =============================================================================
await step(
  'V5-ADJ-01',
  'v5-roles',
  'the investigator can never enter a FORMAL adjudication',
  'inv',
  adjud({
    case_id: F(2),
    item_code: 'AREA_CARDIOVASCULAR',
    decision: 'NO',
    status: 'DISCORDANT_RESOLVED',
    basis: 'REVIEWER_2',
    rationale: 'synthetic',
    disagreement_reason_code: 'TRIAL_CONTEXT',
  }),
  { error: /only the ADJUDICATOR role adjudicates FORMAL v5 items/ },
);
await step(
  'V5-ADJ-02',
  'v5-roles',
  'a reviewer cannot adjudicate',
  'r1',
  adjud({
    case_id: F(2),
    item_code: 'AREA_CARDIOVASCULAR',
    decision: 'NO',
    status: 'DISCORDANT_RESOLVED',
    basis: 'REVIEWER_2',
    rationale: 'synthetic',
    disagreement_reason_code: 'TRIAL_CONTEXT',
  }),
  { error: /ADJUDICATOR role is needed/ },
);
await step(
  'V5-ADJ-03',
  'v5-blinding',
  'the adjudicator now reads the 4 FORMAL cases',
  'adj',
  "select * from public.tlv5_cases where mode='FORMAL'",
  { rows: 4 },
);
for (const [t, label] of [
  ['tlv5_frozen_labels', 'frozen label'],
  ['tlv5_case_design', 'design row'],
  ['tlv5_freeze', 'freeze row'],
  ['v_tlv5_frozen_labels', 'frozen-label export row'],
  ['v_tlv5_independent_judgments', 'judgment export row'],
  ['v_tlv5_adjudicated_reference', 'reference export row'],
  ['tlv5_snapshot', 'snapshot row'],
]) {
  await step(
    `V5-ADJ-04-${t}`,
    'v5-blinding',
    `the adjudicator reads no ${label}`,
    'adj',
    `select * from public.${t}`,
    { rows: 0 },
  );
}
await step(
  'V5-ADJ-05',
  'v5-blinding',
  'the adjudication queue lists every answered FORMAL item (4 cases x 18)',
  'adj',
  "select * from public.v_tlv5_adjudication_queue where mode='FORMAL'",
  { rows: 72 },
);
await step(
  'V5-ADJ-06',
  'v5-blinding',
  '23 FORMAL items need adjudication (2 + 3 discordant or single, 18 on the single-reviewed case)',
  'adj',
  "select count(*)::int as n from public.v_tlv5_adjudication_queue where mode='FORMAL' and needs_adjudication",
  { value: 23 },
);
await step(
  'V5-ADJ-07',
  'v5-scope',
  'a concordant FORMAL item cannot be adjudicated (it enters by rule)',
  'adj',
  adjud({
    case_id: F(1),
    item_code: 'AREA_METABOLIC',
    decision: 'YES',
    status: 'CONCORDANT_CONFIRMED',
    basis: 'BOTH_REVIEWERS',
    rationale: 'synthetic',
  }),
  { error: /concordant items enter the reference by rule/ },
);
await step(
  'V5-ADJ-08',
  'v5-scope',
  'a discordant item cannot be SINGLE_REVIEW_ADJUDICATED',
  'adj',
  adjud({
    case_id: F(2),
    item_code: 'AREA_CARDIOVASCULAR',
    decision: 'NO',
    status: 'SINGLE_REVIEW_ADJUDICATED',
    basis: 'REVIEWER_2',
    rationale: 'synthetic',
    disagreement_reason_code: 'TRIAL_CONTEXT',
  }),
  { error: /reviewers disagree/ },
);
await step(
  'V5-ADJ-09',
  'v5-scope',
  'a single-answer item cannot be DISCORDANT_RESOLVED',
  'adj',
  adjud({
    case_id: F(3),
    item_code: 'SG_DIABETES_TYPE',
    decision: 'TYPE_2',
    status: 'DISCORDANT_RESOLVED',
    basis: 'REVIEWER_1',
    rationale: 'synthetic',
    disagreement_reason_code: 'OTHER',
  }),
  { error: /single-reviewed item/ },
);
await step(
  'V5-ADJ-10',
  'v5-scope',
  'a decision outside the item scale is refused',
  'adj',
  adjud({
    case_id: F(2),
    item_code: 'AREA_CARDIOVASCULAR',
    decision: 'MALIGNANT',
    status: 'DISCORDANT_RESOLVED',
    basis: 'REVIEWER_2',
    rationale: 'synthetic',
    disagreement_reason_code: 'TRIAL_CONTEXT',
  }),
  { error: /check constraint|violates/ },
);
await step(
  'V5-ADJ-11',
  'v5-scope',
  'a reason code outside the v3 list is refused',
  'adj',
  adjud({
    case_id: F(2),
    item_code: 'AREA_CARDIOVASCULAR',
    decision: 'NO',
    status: 'DISCORDANT_RESOLVED',
    basis: 'REVIEWER_2',
    rationale: 'synthetic',
    disagreement_reason_code: 'REVIEWER_TIRED',
  }),
  { error: /check constraint|violates/ },
);
await step(
  'V5-ADJ-12',
  'v5-scope',
  'an unanswered subgroup item cannot be adjudicated',
  'adj',
  adjud({
    case_id: F(1),
    item_code: 'SG_NEOPLASM_MALIGNANCY',
    decision: 'MALIGNANT',
    status: 'SINGLE_REVIEW_ADJUDICATED',
    basis: 'NEITHER',
    rationale: 'synthetic',
  }),
  { error: /has no reviewer answer/ },
);
await step(
  'V5-ADJ-13',
  'v5-workflow',
  `adjudicate ${F(2)} AREA_CARDIOVASCULAR`,
  'adj',
  adjud({
    case_id: F(2),
    item_code: 'AREA_CARDIOVASCULAR',
    decision: 'NO',
    status: 'DISCORDANT_RESOLVED',
    basis: 'REVIEWER_2',
    rationale: 'synthetic',
    disagreement_reason_code: 'TRIAL_CONTEXT',
  }),
  { minRows: 1 },
);
await step(
  'V5-ADJ-14',
  'v5-workflow',
  `adjudicate ${F(2)} SG_NEOPLASM_MALIGNANCY (non-malignant, precancerous)`,
  'adj',
  adjud({
    case_id: F(2),
    item_code: 'SG_NEOPLASM_MALIGNANCY',
    decision: 'NON_MALIGNANT',
    detail_code: 'PRECANCEROUS',
    status: 'DISCORDANT_RESOLVED',
    basis: 'REVIEWER_2',
    rationale: 'synthetic',
    disagreement_reason_code: 'CONSTRUCT_BOUNDARY',
  }),
  { minRows: 1 },
);
await step(
  'V5-ADJ-15',
  'v5-workflow',
  `adjudicate ${F(3)} FIG2_ROW_DIAB`,
  'adj',
  adjud({
    case_id: F(3),
    item_code: 'FIG2_ROW_DIAB',
    decision: 'YES',
    status: 'DISCORDANT_RESOLVED',
    basis: 'REVIEWER_1',
    rationale: 'synthetic',
    disagreement_reason_code: 'PACKET_INSUFFICIENT',
  }),
  { minRows: 1 },
);
await step(
  'V5-ADJ-16',
  'v5-workflow',
  `adjudicate ${F(3)} AREA_METABOLIC`,
  'adj',
  adjud({
    case_id: F(3),
    item_code: 'AREA_METABOLIC',
    decision: 'YES',
    status: 'DISCORDANT_RESOLVED',
    basis: 'REVIEWER_1',
    rationale: 'synthetic',
    disagreement_reason_code: 'PACKET_INSUFFICIENT',
  }),
  { minRows: 1 },
);
await step(
  'V5-ADJ-17',
  'v5-gate',
  'the FORMAL lock is refused while 19 required items lack an adjudication',
  'inv',
  `select public.rpc_tlv5_lock_reference('FORMAL', '${ATT}')`,
  { error: /19 items that the adjudication scope requires/ },
);
await step(
  'V5-ADJ-18',
  'v5-workflow',
  `adjudicate ${F(3)} SG_DIABETES_TYPE (single answer)`,
  'adj',
  adjud({
    case_id: F(3),
    item_code: 'SG_DIABETES_TYPE',
    decision: 'TYPE_2',
    status: 'SINGLE_REVIEW_ADJUDICATED',
    basis: 'REVIEWER_1',
    rationale: 'synthetic',
  }),
  { minRows: 1 },
);
for (const it of A.r1_4.items) {
  const unresolved = it.item_code === 'SG_NEOPLASM_MALIGNANCY';
  await step(
    `V5-ADJ-19-${it.item_code}`,
    'v5-workflow',
    `adjudicate single-reviewed ${F(4)} ${it.item_code}${unresolved ? ' (UNRESOLVED_ESCALATED)' : ''}`,
    'adj',
    adjud(
      unresolved
        ? {
            case_id: F(4),
            item_code: it.item_code,
            decision: null,
            status: 'UNRESOLVED_ESCALATED',
            basis: 'NONE',
            rationale: 'synthetic',
          }
        : {
            case_id: F(4),
            item_code: it.item_code,
            decision: it.answer,
            status: 'SINGLE_REVIEW_ADJUDICATED',
            basis: 'REVIEWER_1',
            rationale: 'synthetic',
          },
    ),
    { minRows: 1 },
  );
}
await step(
  'V5-ADJ-20',
  'v5-blinding',
  'the adjudicator reads its own 23 FORMAL adjudications',
  'adj',
  "select * from public.tlv5_adjudications where mode='FORMAL'",
  { rows: 23 },
);

// =============================================================================
// L. Reference lock and the export views
// =============================================================================
await step(
  'V5-LOCK-01',
  'v5-roles',
  'a reviewer cannot lock the FORMAL reference',
  'r1',
  `select public.rpc_tlv5_lock_reference('FORMAL', '${ATT}')`,
  { error: /investigator role/ },
);
await step(
  'V5-LOCK-02',
  'v5-roles',
  'the adjudicator cannot lock the FORMAL reference',
  'adj',
  `select public.rpc_tlv5_lock_reference('FORMAL', '${ATT}')`,
  { error: /investigator role/ },
);
await step(
  'V5-LOCK-03',
  'v5-setup',
  'investigator locks the FORMAL reference',
  'inv',
  `select public.rpc_tlv5_lock_reference('FORMAL', '${ATT}')`,
  { minRows: 1 },
);
await step(
  'V5-LOCK-04',
  'v5-gate',
  'a second FORMAL lock is refused',
  'inv',
  `select public.rpc_tlv5_lock_reference('FORMAL', '${ATT}')`,
  { error: /duplicate key|already/ },
);
await step(
  'V5-LOCK-05',
  'v5-export',
  'the lock covers the 72 answered items',
  'inv',
  "select n_items_locked::int as n from public.tlv5_reference_locks where mode='FORMAL'",
  { value: 72 },
);
await step(
  'V5-EXP-01',
  'v5-export',
  'FORMAL adjudicated reference: 4 cases x 19 items',
  'inv',
  "select * from public.v_tlv5_adjudicated_reference where mode='FORMAL'",
  { rows: 76 },
);
await step(
  'V5-EXP-02',
  'v5-export',
  'FORMAL reference status counts',
  'inv',
  "select string_agg(s || ':' || n, ',' order by s) as v from (select adjudication_status s, count(*) n from public.v_tlv5_adjudicated_reference where mode='FORMAL' group by 1) x",
  {
    value:
      'CONCORDANT_ADOPTED_BY_RULE:49,DISCORDANT_RESOLVED:4,NOT_APPLICABLE_BY_RULE:4,SINGLE_REVIEW_ADJUDICATED:18,UNRESOLVED_ESCALATED:1',
  },
);
const refv = (c, i, cols) =>
  `select concat_ws('|', ${cols}) as v from public.v_tlv5_adjudicated_reference where case_id='${c}' and item_code='${i}'`;
await step(
  'V5-EXP-03',
  'v5-export',
  'a concordant item enters by rule with basis BOTH_REVIEWERS',
  'inv',
  refv(
    F(1),
    'AREA_METABOLIC',
    'reference_answer, adjudication_status, adjudication_basis, adjudicator_role',
  ),
  { value: 'YES|CONCORDANT_ADOPTED_BY_RULE|BOTH_REVIEWERS|RULE' },
);
await step(
  'V5-EXP-04',
  'v5-export',
  'a concordant subgroup item enters by rule',
  'inv',
  refv(F(1), 'SG_DIABETES_TYPE', 'reference_answer, adjudication_status'),
  { value: 'TYPE_2|CONCORDANT_ADOPTED_BY_RULE' },
);
await step(
  'V5-EXP-05',
  'v5-export',
  'a subgroup item no reviewer was shown is NOT_APPLICABLE by rule',
  'inv',
  refv(F(1), 'SG_NEOPLASM_MALIGNANCY', 'reference_answer, adjudication_status'),
  { value: 'NOT_APPLICABLE|NOT_APPLICABLE_BY_RULE' },
);
await step(
  'V5-EXP-06',
  'v5-export',
  'a resolved disagreement carries decision, basis, reason, role and blinding',
  'inv',
  refv(
    F(2),
    'AREA_CARDIOVASCULAR',
    'reference_answer, adjudication_status, adjudication_basis, disagreement_reason_code, adjudicator_role, adjudication_blinded::text',
  ),
  { value: 'NO|DISCORDANT_RESOLVED|REVIEWER_2|TRIAL_CONTEXT|ADJUDICATOR|true' },
);
await step(
  'V5-EXP-07',
  'v5-export',
  'a resolved subgroup item carries its detail code',
  'inv',
  refv(F(2), 'SG_NEOPLASM_MALIGNANCY', 'reference_answer, reference_detail, adjudication_status'),
  { value: 'NON_MALIGNANT|PRECANCEROUS|DISCORDANT_RESOLVED' },
);
await step(
  'V5-EXP-08',
  'v5-export',
  'an unresolved item has no reference answer (three states kept apart)',
  'inv',
  refv(F(4), 'SG_NEOPLASM_MALIGNANCY', "coalesce(reference_answer, 'NULL'), adjudication_status"),
  { value: 'NULL|UNRESOLVED_ESCALATED' },
);
await step(
  'V5-EXP-09',
  'v5-export',
  'a single-reviewed item carries the adjudicator decision',
  'inv',
  refv(F(4), 'AREA_ONCOLOGY', 'reference_answer, adjudication_status, n_reviewers_submitted::text'),
  { value: 'YES|SINGLE_REVIEW_ADJUDICATED|1' },
);
await step(
  'V5-EXP-10',
  'v5-export',
  'adjudicated rows carry a pseudonym, never an account identifier',
  'inv',
  "select count(*)::int as n from public.v_tlv5_adjudicated_reference where mode='FORMAL' and adjudicator_role='ADJUDICATOR' and adjudicator_pseudo_id !~ '^A-[0-9A-F]{6}$'",
  { value: 0 },
);
await step(
  'V5-EXP-11',
  'v5-export',
  'no reference row lacks a status',
  'inv',
  'select count(*)::int as n from public.v_tlv5_adjudicated_reference where adjudication_status is null',
  { value: 0 },
);
const ijv = (c, i, slot, cols) =>
  `select concat_ws('|', ${cols}) as v from public.v_tlv5_independent_judgments where case_id='${c}' and item_code='${i}' and reviewer_slot=${slot}`;
await step(
  'V5-EXP-12',
  'v5-export',
  'the revised judgment keeps the initial and the effective answer',
  'inv',
  ijv(
    F(1),
    'AREA_CARDIOVASCULAR',
    1,
    'answer_initial, answer_effective_preclose, n_revisions_preclose::text',
  ),
  { value: 'YES|NO|1' },
);
await step(
  'V5-EXP-13',
  'v5-export',
  'a hidden subgroup item is NOT_APPLICABLE in the judgments',
  'inv',
  ijv(F(3), 'SG_DIABETES_TYPE', 2, 'answer_initial, answer_effective_preclose'),
  { value: 'NOT_APPLICABLE|NOT_APPLICABLE' },
);
await step(
  'V5-EXP-14',
  'v5-export',
  'an explicit INSUFFICIENT_INFORMATION answer is kept with its uncertainty flag',
  'inv',
  ijv(F(3), 'AREA_METABOLIC', 2, 'answer_effective_preclose, uncertain::text'),
  { value: 'INSUFFICIENT_INFORMATION|true' },
);
await step(
  'V5-EXP-15',
  'v5-export',
  'a subgroup detail code reaches the judgments',
  'inv',
  ijv(F(2), 'SG_NEOPLASM_MALIGNANCY', 2, 'answer_effective_preclose, detail_effective'),
  { value: 'NON_MALIGNANT|PRECANCEROUS' },
);
await step(
  'V5-EXP-16',
  'v5-export',
  'the FORMAL judgments carry the trial identifier for the investigator',
  'inv',
  ijv(F(1), 'AREA_ONCOLOGY', 2, 'nct_id'),
  { value: 'SYN-NCT-1001' },
);
await step(
  'V5-EXP-17',
  'v5-export',
  'FORMAL frozen labels with design: 4 x 17 + 2 rule D + 2 rule K',
  'inv',
  "select * from public.v_tlv5_frozen_labels where mode='FORMAL'",
  { rows: 72 },
);
await step(
  'V5-EXP-18',
  'v5-export',
  'the sampling weight is 1 / selection probability',
  'inv',
  `select round(sampling_weight)::int as n from public.v_tlv5_frozen_labels where case_id='${F(1)}' and item_code='AREA_METABOLIC'`,
  { value: 10 },
);
await step(
  'V5-EXP-19',
  'v5-export',
  'design flags reach the label export',
  'inv',
  `select concat_ws('|', label_primary, label_secondary, dev_linked_area::text, dev_linked::text, tier1_eligible::text) as v from public.v_tlv5_frozen_labels where case_id='${F(2)}' and item_code='AREA_CARDIOVASCULAR'`,
  { value: 'YES|NO|true|true|false' },
);
await step(
  'V5-EXP-20',
  'v5-integrity',
  'no calibration or pilot ID reaches a FORMAL export row',
  'inv',
  `select x.id from (select case_id as id from public.v_tlv5_independent_judgments where mode='FORMAL' union all select case_id from public.v_tlv5_adjudicated_reference where mode='FORMAL'
     union all select case_id from public.v_tlv5_frozen_labels where mode='FORMAL') x where x.id !~ '^TLV5-'`,
  { rows: 0 },
);
await step(
  'V5-EXP-21',
  'v5-integrity',
  'calibration cases never appear in any export view',
  'inv',
  `select x.id from (select case_id as id from public.v_tlv5_independent_judgments union all select case_id from public.v_tlv5_adjudicated_reference
     union all select case_id from public.v_tlv5_frozen_labels) x where x.id like 'CAL5-%'`,
  { rows: 0 },
);
for (const who of ['r1', 'r2', 'adj', 'out']) {
  await step(
    `V5-EXP-22-${who}`,
    'v5-blinding',
    `${who} reads no export row`,
    who,
    'select ((select count(*) from public.v_tlv5_independent_judgments) + (select count(*) from public.v_tlv5_adjudicated_reference) + (select count(*) from public.v_tlv5_frozen_labels))::int as n',
    { value: 0 },
  );
}
await step(
  'V5-EXP-23',
  'v5-setup',
  'register the FORMAL export (bundle format 5.0)',
  'inv',
  `select public.rpc_tlv5_register_export('${J({ mode: 'FORMAL', bundle_format_version: '5.0', row_counts: { independent_judgments: 133, adjudicated_reference: 76, frozen_labels: 72 }, file_sha256: { 'independent_judgments_v5.csv': '7'.repeat(64) }, manifest_sha256: '8'.repeat(64), app_git_sha: 'abc123' })}'::jsonb)`,
  { minRows: 1 },
);

// post-unblinding revision: recorded, flagged, never part of the blinded reference
await step(
  'V5-POST-01',
  'v5-provenance',
  'a post-lock adjudication of a concordant item is recorded as post-unblinding',
  'adj',
  adjud({
    case_id: F(1),
    item_code: 'AREA_ONCOLOGY',
    decision: 'YES',
    status: 'CONCORDANT_REVISED',
    basis: 'NEITHER',
    rationale: 'synthetic post-unblinding revision',
  }),
  { minRows: 1 },
);
await step(
  'V5-POST-02',
  'v5-provenance',
  'the revision is flagged post_unblinding',
  'inv',
  `select post_unblinding::text as v from public.tlv5_adjudications where case_id='${F(1)}' and item_code='AREA_ONCOLOGY'`,
  { value: 'true' },
);
await step(
  'V5-POST-03',
  'v5-provenance',
  'the blinded reference keeps the rule answer and flags the revision',
  'inv',
  refv(
    F(1),
    'AREA_ONCOLOGY',
    'reference_answer, adjudication_status, post_unblinding_revision_exists::text',
  ),
  { value: 'NO|CONCORDANT_ADOPTED_BY_RULE|true' },
);
await step(
  'V5-POST-04',
  'v5-snapshot',
  'the snapshot still verifies after the lock and the revision',
  'inv',
  'select matches from public.rpc_tlv5_verify_snapshot()',
  { value: true },
);
await step(
  'V5-POST-05',
  'v5-freeze',
  'the frozen labels still verify after the lock',
  'inv',
  'select matches from public.rpc_tlv5_verify_frozen_labels()',
  { value: true },
);

// =============================================================================
// M. Append-only tables, grants, outsiders
// =============================================================================
for (const [t, sql] of [
  ['tlv5_submission_items', "update public.tlv5_submission_items set answer = 'YES'"],
  ['tlv5_submissions', 'delete from public.tlv5_submissions'],
  ['tlv5_frozen_labels', "update public.tlv5_frozen_labels set label_primary = 'NO'"],
  ['tlv5_case_design', 'update public.tlv5_case_design set selection_probability = 1'],
  ['tlv5_snapshot', "update public.tlv5_snapshot set content_sha256 = repeat('0', 64)"],
  ['tlv5_adjudications', 'delete from public.tlv5_adjudications'],
  ['tlv5_reference_locks', 'delete from public.tlv5_reference_locks'],
  ['tlv5_assignments', 'delete from public.tlv5_assignments'],
  ['tlv5_phase_events', 'delete from public.tlv5_phase_events'],
  ['tlv5_cases', 'truncate public.tlv5_cases cascade'],
  ['tlv5_exports', 'delete from public.tlv5_exports'],
]) {
  await step(`V5-IMM-${t}`, 'v5-immutability', `${t} is append-only (owner role)`, 'owner', sql, {
    error: /append-only/,
  });
}
await step(
  'V5-GRANT-01',
  'v5-integrity',
  'a reviewer cannot update a frozen label directly',
  'r1',
  "update public.tlv5_frozen_labels set label_primary = 'NO'",
  { error: /permission denied/ },
);
await step(
  'V5-GRANT-02',
  'v5-integrity',
  'anon cannot read v5 cases',
  'anon',
  'select * from public.tlv5_cases',
  { error: /permission denied/ },
);
await step(
  'V5-GRANT-03',
  'v5-integrity',
  'anon cannot call the v5 submission RPC',
  'anon',
  `select public.rpc_tlv5_submit('${await asg5(R1, F(1))}', '{}'::jsonb)`,
  { error: /permission denied/ },
);
await step(
  'V5-GRANT-04',
  'v5-blinding',
  'an authenticated outsider reads no v5 case',
  'out',
  'select * from public.tlv5_cases',
  { rows: 0 },
);
await step(
  'V5-GRANT-05',
  'v5-roles',
  'an authenticated outsider cannot freeze or activate',
  'out',
  `select public.rpc_tlv5_activate('SYN-5', 'DISAGREEMENTS_ONLY', '${ATT}')`,
  { error: /investigator role/ },
);
for (const [t, label] of [
  ['tlv5_adjudications', 'adjudication'],
  ['tlv5_reference_locks', 'lock row'],
  ['tlv5_phase_events', 'phase event'],
  ['tlv5_exports', 'export record'],
  ['tlv5_snapshot', 'snapshot row'],
]) {
  await step(
    `V5-GRANT-06-${t}`,
    'v5-blinding',
    `a reviewer reads no ${label}`,
    'r1',
    `select * from public.${t}`,
    { rows: 0 },
  );
}
await step(
  'V5-GRANT-07',
  'v5-blinding',
  'a pilot account reads no FORMAL case',
  'pt1',
  "select * from public.tlv5_cases where mode='FORMAL'",
  { rows: 0 },
);
await step(
  'V5-GRANT-08',
  'v5-blinding',
  'a reviewer still reads only its own FORMAL submissions after the lock',
  'r2',
  `select * from public.tlv5_submissions where reviewer_pseudo_id <> '${R2}'`,
  { rows: 0 },
);

// =============================================================================
// K. Audit chain (v2 mechanism extended to every v5 table)
// =============================================================================
await step(
  'V5-AUDIT-01',
  'audit',
  'every v5 table writes audit rows (13 tables)',
  'owner',
  "select count(distinct entity_table)::int as n from public.audit_log where entity_table like 'tlv5\\_%'",
  { value: 13 },
);
await step(
  'V5-AUDIT-02',
  'audit',
  'audit log has a hash on every row',
  'owner',
  'select count(*)::int as n from public.audit_log where row_hash is null',
  { value: 0 },
);
await step(
  'V5-AUDIT-03',
  'audit',
  'each prev_hash equals the previous row hash',
  'owner',
  'select count(*)::int as n from (select prev_hash, lag(row_hash) over (order by audit_id) as lag_hash, audit_id from public.audit_log) s where audit_id > (select min(audit_id) from public.audit_log) and prev_hash is distinct from lag_hash',
  { value: 0 },
);
await step(
  'V5-AUDIT-04',
  'audit',
  'calibration audit rows carry no mode (the audit mode column takes PILOT or FORMAL only)',
  'owner',
  "select count(*)::int as n from public.audit_log where entity_table = 'tlv5_submissions' and mode is null",
  { value: 2 },
);

// =============================================================================
// V. Export view column contracts (EXPORT_TO_PERFORMANCE_SPEC_v5.md; validation/performance_analysis_v5.py)
// =============================================================================
const VIEW_COLUMNS = {
  v_tlv5_independent_judgments: [
    'record_category',
    'case_id',
    'mode',
    'nct_id',
    'item_family',
    'item_code',
    'reviewer_slot',
    'reviewer_pseudo_id',
    'answer_initial',
    'answer_effective_preclose',
    'detail_initial',
    'detail_effective',
    'n_revisions_preclose',
    'uncertain',
    'packet_issue_flag',
    'first_submitted_at',
    'last_submitted_at',
  ],
  v_tlv5_adjudicated_reference: [
    'record_category',
    'case_id',
    'mode',
    'item_family',
    'item_code',
    'adjudication_id',
    'reference_answer',
    'reference_detail',
    'adjudication_status',
    'adjudication_basis',
    'n_reviewers_submitted',
    'n_reviewer_answers',
    'disagreement_reason_code',
    'adjudicator_pseudo_id',
    'adjudicator_role',
    'adjudication_blinded',
    'post_unblinding_revision_exists',
    'adjudicated_at',
    'reference_lock_id',
  ],
  v_tlv5_frozen_labels: [
    'label_set_id',
    'record_category',
    'case_id',
    'mode',
    'nct_id',
    'item_family',
    'item_code',
    'label_primary',
    'label_secondary',
    'label_informational',
    'dev_linked_area',
    'label_frozen_at',
    'frame',
    'stratum',
    'variance_stratum',
    'frame_stratum_size',
    'n_sampled_in_stratum',
    'selection_probability',
    'sampling_weight',
    'dev_linked',
    'tier1_eligible',
    'design_version',
  ],
};
const viewColumns = {};
for (const [v, cols] of Object.entries(VIEW_COLUMNS)) {
  await step(
    `V5-COLS-${v}`,
    'v5-export',
    `${v} has exactly the contract columns, in order`,
    'owner',
    `select string_agg(column_name, ',' order by ordinal_position) as v from information_schema.columns where table_schema = 'public' and table_name = '${v}'`,
    { value: cols.join(',') },
  );
  viewColumns[v] = (
    await q(
      "select column_name || ':' || data_type as c from information_schema.columns where table_schema = 'public' and table_name = $1 order by ordinal_position",
      [v],
    )
  ).map((r) => r.c);
}
fs.writeFileSync(
  path.join(path.dirname(path.resolve(outPath)), 'view_columns_v5.json'),
  JSON.stringify(viewColumns, null, 1),
);

// =============================================================================
// X. Mutual exclusion in a second database: design v4 first, then v5 is refused
// =============================================================================
const db2 = await newDb();
db = db2;
dbLabel = 'db2';
await setupAccounts();
await step(
  'V5-MX-10',
  'v5-exclusion',
  'second database: investigator claims the bootstrapped account',
  'inv',
  'select public.rpc_claim_account() as uid',
  { minRows: 1 },
);
await step(
  'V5-MX-11',
  'v5-exclusion',
  'second database: design v4 is activated first',
  'inv',
  `select public.rpc_activate_design_v4('SYN-4', 'DISAGREEMENTS_ONLY', '${ATT}')`,
  { minRows: 1 },
);
await step(
  'V5-MX-12',
  'v5-exclusion',
  'second database: design v5 cannot be activated once design v4 is active',
  'inv',
  `select public.rpc_tlv5_activate('SYN-5', 'DISAGREEMENTS_ONLY', '${ATT}')`,
  { error: /design v4 is active; design v5 cannot be activated/ },
);
await step(
  'V5-MX-13',
  'v5-exclusion',
  'second database: no v5 activation row exists',
  'owner',
  'select count(*)::int as n from public.tlv5_activation',
  { value: 0 },
);

// =============================================================================
// Y. Third database: the ALL_ITEMS adjudication scope end to end (and a COMPLETE close)
// =============================================================================
const db3 = await newDb();
db = db3;
dbLabel = 'db3';
await setupAccounts();
await step(
  'V5-AI-00',
  'v5-allitems',
  'third database: investigator claims the bootstrapped account',
  'inv',
  'select public.rpc_claim_account() as uid',
  { minRows: 1 },
);
for (const [k, role, pilot] of [
  ['pt1', 'REVIEWER', true],
  ['pt2', 'REVIEWER', true],
  ['r1', 'REVIEWER', false],
  ['r2', 'REVIEWER', false],
  ['adj', 'ADJUDICATOR', false],
]) {
  await step(
    `V5-AI-USER-${k}`,
    'v5-allitems-setup',
    `register ${k}`,
    'inv',
    `select public.rpc_register_user('${P[k].email}', 'Synthetic ${k}', '${role}', ${pilot})`,
    { minRows: 1 },
  );
  await step(
    `V5-AI-CLAIM-${k}`,
    'v5-allitems-setup',
    `${k} claims account`,
    k,
    'select public.rpc_claim_account()',
    { minRows: 1 },
  );
}
for (const k of ['pt1', 'pt2']) {
  await step(
    `V5-AI-ENROLL-${k}`,
    'v5-allitems-setup',
    `enrol ${k} as PILOT reviewer`,
    'inv',
    `select public.rpc_enroll_reviewer('${await uid(P[k].email)}', 'PILOT', 'synthetic')`,
    { minRows: 1 },
  );
}
const PT1c = await pid('pt1'),
  PT2c = await pid('pt2');
const plan3 = {
  lab: { areas: ['MENTAL_HEALTH'], rows: ['DEP'] },
  a: { areas: ['MENTAL_HEALTH'], rows: ['DEP'] },
};
// the formal case of db3: both reviewers answer the diabetes row YES and the type OTHER, with DIFFERENT detail codes
const aiA1 = answers({
  areas: ['MENTAL_HEALTH'],
  rows: ['DEP', 'DIAB'],
  sgD: 'OTHER',
  sgDdetail: 'PREDIABETES',
});
const aiA2 = answers({
  areas: ['MENTAL_HEALTH'],
  rows: ['DEP', 'DIAB'],
  sgD: 'OTHER',
  sgDdetail: 'GESTATIONAL',
});
for (const [i, id] of pilotIds.entries()) {
  await step(
    `V5-AI-PCASE-${id}`,
    'v5-allitems-setup',
    `import pilot case ${id}`,
    'inv',
    `select public.rpc_tlv5_import_case('${caseJson(id, 'PILOT', i + 1, design(`SYN-NCT-${String(i + 1).padStart(4, '0')}`))}'::jsonb)`,
    { value: id },
  );
}
await step(
  'V5-AI-PLAB',
  'v5-allitems-setup',
  'import pilot labels',
  'inv',
  `select public.rpc_tlv5_import_frozen_labels('${J(pilotIds.flatMap((id) => labelSet('LBL5-SYN-PILOT', id, plan3.lab)))}'::jsonb)`,
  { value: 170 },
);
await step(
  'V5-AI-PASG-1',
  'v5-allitems-setup',
  'assign pilot slot 1',
  'inv',
  `select public.rpc_tlv5_assign('PILOT','${PT1c}',1,${arr(pilotIds)},3)`,
  { value: 10 },
);
await step(
  'V5-AI-PASG-2',
  'v5-allitems-setup',
  'assign pilot slot 2',
  'inv',
  `select public.rpc_tlv5_assign('PILOT','${PT2c}',2,${arr(pilotIds)},3)`,
  { value: 10 },
);
for (const [k, p] of [
  ['pt1', PT1c],
  ['pt2', PT2c],
]) {
  for (const id of pilotIds)
    await submit(
      `V5-AI-PSUB-${k}-${id}`,
      'v5-allitems-setup',
      `${k} submits ${id}`,
      k,
      p,
      id,
      answers(plan3.a),
      { minRows: 1 },
    );
}
await step(
  'V5-AI-PLOCK',
  'v5-allitems',
  'a pilot without disagreements locks without any adjudication',
  'inv',
  `select public.rpc_tlv5_lock_reference('PILOT', '${ATT}')`,
  { minRows: 1 },
);
const pex3 = await step(
  'V5-AI-PEXP',
  'v5-allitems-setup',
  'register the pilot export',
  'inv',
  `select public.rpc_tlv5_register_export('${J({ mode: 'PILOT', bundle_format_version: '5.0', row_counts: {}, file_sha256: {}, manifest_sha256: '3'.repeat(64), app_git_sha: 'abc123' })}'::jsonb) as eid`,
  { minRows: 1 },
);
await step(
  'V5-AI-SIGN',
  'v5-allitems-setup',
  'sign off the pilot',
  'inv',
  `select public.rpc_tlv5_phase('PILOT_SIGNED_OFF', '${J({ checklist_version: 'PAC-5', checklist_sha256: '1'.repeat(64), app_git_sha: 'abc123', pilot_export_id: pex3[0].eid, attestation: ATT })}'::jsonb)`,
  { minRows: 1 },
);
await step(
  'V5-AI-ACT',
  'v5-allitems',
  'activate design v5 with the ALL_ITEMS scope',
  'inv',
  `select public.rpc_tlv5_activate('SYN-5', 'ALL_ITEMS', '${ATT}')`,
  { minRows: 1 },
);
for (const k of ['r1', 'r2']) {
  await step(
    `V5-AI-ENR-${k}`,
    'v5-allitems-setup',
    `enrol ${k} as FORMAL v5 reviewer`,
    'inv',
    `select public.rpc_tlv5_enroll_reviewer('${await uid(P[k].email)}', 'synthetic')`,
    { minRows: 1 },
  );
}
const R1c = await pid('r1'),
  R2c = await pid('r2');
const G = 'TLV5-TESTFX-0101';
await step(
  'V5-AI-CASE',
  'v5-allitems-setup',
  `import ${G}`,
  'inv',
  `select public.rpc_tlv5_import_case('${caseJson(G, 'FORMAL', 201, design('SYN-NCT-2001', { frame_stratum_size: 5, n_sampled_in_stratum: 1, selection_probability: 0.2 }))}'::jsonb)`,
  { value: G },
);
await step(
  'V5-AI-LAB',
  'v5-allitems-setup',
  `import the labels of ${G}`,
  'inv',
  `select public.rpc_tlv5_import_frozen_labels('${J(labelSet('LBL5-TESTFX-AI', G, plan3.lab))}'::jsonb)`,
  { value: 17 },
);
await step('V5-AI-FRZ', 'v5-allitems-setup', 'freeze', 'inv', freeze(), { minRows: 1 });
await step(
  'V5-AI-OPEN',
  'v5-allitems-setup',
  'open the formal phase',
  'inv',
  `select public.rpc_tlv5_phase('FORMAL_OPENED', '${J({ attestation: ATT })}'::jsonb)`,
  { minRows: 1 },
);
await step(
  'V5-AI-ASG-1',
  'v5-allitems-setup',
  'assign slot 1',
  'inv',
  `select public.rpc_tlv5_assign('FORMAL','${R1c}',1,${arr([G])},5)`,
  { value: 1 },
);
await step(
  'V5-AI-ASG-2',
  'v5-allitems-setup',
  'assign slot 2',
  'inv',
  `select public.rpc_tlv5_assign('FORMAL','${R2c}',2,${arr([G])},5)`,
  { value: 1 },
);
await submit(
  'V5-AI-SUB-1',
  'v5-allitems-setup',
  'r1 submits (diabetes type OTHER, detail PREDIABETES)',
  'r1',
  R1c,
  G,
  aiA1,
  { minRows: 1 },
);
await submit(
  'V5-AI-SUB-2',
  'v5-allitems-setup',
  'r2 submits (diabetes type OTHER, detail GESTATIONAL)',
  'r2',
  R2c,
  G,
  aiA2,
  { minRows: 1 },
);
await step(
  'V5-AI-CLOSE',
  'v5-allitems',
  'a COMPLETE close succeeds when every assignment has a submission',
  'inv',
  `select public.rpc_tlv5_phase('FORMAL_CLOSED_COMPLETE', '${J({ attestation: ATT })}'::jsonb)`,
  { minRows: 1 },
);
await step(
  'V5-AI-SNAP',
  'v5-allitems-setup',
  'snapshot',
  'inv',
  'select public.rpc_tlv5_snapshot()',
  { minRows: 1 },
);
await step(
  'V5-AI-LOCK-1',
  'v5-allitems',
  'under ALL_ITEMS the lock needs an adjudication of every answered item (18)',
  'inv',
  `select public.rpc_tlv5_lock_reference('FORMAL', '${ATT}')`,
  { error: /18 items that the adjudication scope requires/ },
);
await step(
  'V5-AI-Q-1',
  'v5-allitems',
  'the same answer with different detail codes needs adjudication',
  'adj',
  `select concat_ws('|', reviewer_1_answer, reviewer_1_detail, reviewer_2_answer, reviewer_2_detail, needs_adjudication::text) as v from public.v_tlv5_adjudication_queue where case_id='${G}' and item_code='SG_DIABETES_TYPE'`,
  { value: 'OTHER|PREDIABETES|OTHER|GESTATIONAL|true' },
);
await step(
  'V5-AI-ADJ-SG0',
  'v5-allitems',
  'the same answer with different detail codes cannot be CONCORDANT_CONFIRMED',
  'adj',
  adjud({
    case_id: G,
    item_code: 'SG_DIABETES_TYPE',
    decision: 'OTHER',
    detail_code: 'PREDIABETES',
    status: 'CONCORDANT_CONFIRMED',
    basis: 'BOTH_REVIEWERS',
    rationale: 'synthetic',
  }),
  { error: /reviewers disagree/ },
);
await step(
  'V5-AI-ADJ-0',
  'v5-allitems',
  'a concordant item cannot be DISCORDANT_RESOLVED',
  'adj',
  adjud({
    case_id: G,
    item_code: 'AREA_ONCOLOGY',
    decision: 'NO',
    status: 'DISCORDANT_RESOLVED',
    basis: 'REVIEWER_1',
    rationale: 'synthetic',
    disagreement_reason_code: 'OTHER',
  }),
  { error: /reviewers agree/ },
);
for (const it of aiA1.items) {
  const revise = it.item_code === 'AREA_MENTAL_HEALTH';
  const sg = it.item_code === 'SG_DIABETES_TYPE';
  await step(
    `V5-AI-ADJ-${it.item_code}`,
    'v5-allitems',
    `under ALL_ITEMS the adjudicator ${sg ? 'resolves' : revise ? 'revises' : 'confirms'} item ${it.item_code}`,
    'adj',
    adjud(
      sg
        ? {
            case_id: G,
            item_code: it.item_code,
            decision: 'OTHER',
            detail_code: 'PREDIABETES',
            status: 'DISCORDANT_RESOLVED',
            basis: 'REVIEWER_1',
            rationale: 'synthetic',
            disagreement_reason_code: 'CONSTRUCT_BOUNDARY',
          }
        : {
            case_id: G,
            item_code: it.item_code,
            decision: revise ? 'CONTEXT_DEPENDENT' : it.answer,
            status: revise ? 'CONCORDANT_REVISED' : 'CONCORDANT_CONFIRMED',
            basis: revise ? 'NEITHER' : 'BOTH_REVIEWERS',
            rationale: 'synthetic',
          },
    ),
    { minRows: 1 },
  );
}
await step(
  'V5-AI-LOCK-2',
  'v5-allitems',
  'the lock succeeds once every answered item is adjudicated',
  'inv',
  `select public.rpc_tlv5_lock_reference('FORMAL', '${ATT}')`,
  { minRows: 1 },
);
await step(
  'V5-AI-EXP-1',
  'v5-allitems',
  'ALL_ITEMS reference status counts',
  'inv',
  "select string_agg(s || ':' || n, ',' order by s) as v from (select adjudication_status s, count(*) n from public.v_tlv5_adjudicated_reference where mode='FORMAL' group by 1) x",
  {
    value:
      'CONCORDANT_CONFIRMED:16,CONCORDANT_REVISED:1,DISCORDANT_RESOLVED:1,NOT_APPLICABLE_BY_RULE:1',
  },
);
await step(
  'V5-AI-EXP-3',
  'v5-allitems',
  'the resolved subgroup item carries the adjudicated detail code',
  'inv',
  `select concat_ws('|', reference_answer, reference_detail, adjudication_status) as v from public.v_tlv5_adjudicated_reference where case_id='${G}' and item_code='SG_DIABETES_TYPE'`,
  { value: 'OTHER|PREDIABETES|DISCORDANT_RESOLVED' },
);
await step(
  'V5-AI-EXP-2',
  'v5-allitems',
  'a revised concordant item takes the adjudicator answer, not the rule answer',
  'inv',
  `select concat_ws('|', reference_answer, adjudication_status, adjudication_basis) as v from public.v_tlv5_adjudicated_reference where case_id='${G}' and item_code='AREA_MENTAL_HEALTH'`,
  { value: 'CONTEXT_DEPENDENT|CONCORDANT_REVISED|NEITHER' },
);

const summary = {
  engine: (await q('select version() as v'))[0].v,
  n: results.length,
  pass: results.filter((r) => r.pass).length,
  fail: results.filter((r) => !r.pass).length,
};
fs.writeFileSync(outPath, JSON.stringify({ summary, results }, null, 1));
fs.writeFileSync(
  sqlOutPath,
  '-- Generated by rls_tests_v5.mjs: the statements each test runs, in order, with the identity and expectation.\n' +
    "-- Identity switch used before each statement: reset role; select set_config('request.jwt.claims', <claims json>, false); set role authenticated;\n" +
    '-- Statements marked (db2) run in a second, fresh database (mutual exclusion of designs v4 and v5).\n\n' +
    sqlLog.join('\n'),
);
console.log(JSON.stringify(summary));
for (const r of results.filter((r) => !r.pass)) console.log('FAIL', r.id, r.desc, '|', r.actual);
await db1.close();
await db2.close();
await db3.close();
