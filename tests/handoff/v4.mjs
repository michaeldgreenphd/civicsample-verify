// SYNTHETIC ENGINEERING ONLY. Preserved supplied regression logic; see docs/HANDOFF_TESTS.md.
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import crypto from 'crypto';
import fs from 'fs';

const [shimPath, schemaPath, m0002Path, m0003Path, outPath, sqlOutPath] = process.argv.slice(2);
const db = await PGlite.create({ extensions: { pgcrypto } });

// ---- identities (synthetic) ---------------------------------------------------------------
const P = {
  inv: {
    sub: '00000000-0000-4000-8000-0000000000a1',
    email: 'investigator@example.test',
    aal: 'aal2',
  },
  pt1: { sub: '00000000-0000-4000-8000-0000000000b1', email: 'pilot1@example.test', aal: 'aal1' },
  pt2: { sub: '00000000-0000-4000-8000-0000000000b2', email: 'pilot2@example.test', aal: 'aal1' },
  r1: { sub: '00000000-0000-4000-8000-0000000000c1', email: 'reviewer1@example.test', aal: 'aal1' },
  r2: { sub: '00000000-0000-4000-8000-0000000000c2', email: 'reviewer2@example.test', aal: 'aal1' },
  out: { sub: '00000000-0000-4000-8000-0000000000d1', email: 'outsider@example.test', aal: 'aal1' },
  adj: {
    sub: '00000000-0000-4000-8000-0000000000e1',
    email: 'adjudicator@example.test',
    aal: 'aal1',
  },
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
    `-- ${id} [${area}] as ${who}: ${desc}\n-- expect: ${JSON.stringify(expect, (k, v) => (v instanceof RegExp ? v.source : v))}\n${s};\n`,
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

async function setup() {
  await db.exec(fs.readFileSync(shimPath, 'utf8'));
  await db.exec(fs.readFileSync(schemaPath, 'utf8'));
  await db.exec(fs.readFileSync(m0002Path, 'utf8'));
  await db.exec(fs.readFileSync(m0003Path, 'utf8'));
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

// ---- synthetic packets and design rows ------------------------------------------------------
const descPacket = (tag, area) => ({
  schema_version: '1.0',
  case_title: `Synthetic condition ${tag} in a synthetic area`,
  question: 'Does the descriptor belong to the area?',
  unit: { unit_type: 'DESCRIPTOR_AREA', unit_id: `SYN-D${tag}::${area}` },
  descriptor: { descriptor_ui: `SYN-D${tag}`, name: `Synthetic condition ${tag} (fictional)` },
  mesh: { scope_note: 'SYNTHETIC TEXT FOR APP TESTING ONLY.', tree_numbers: ['C01.999'] },
  area: { key: area, label: area },
  notices: ['SYNTHETIC CASE: excluded from all statistics'],
});
const design2 = (tag, area, extra = {}) =>
  Object.assign(
    {
      unit_id: `SYN-D${tag}::${area}`,
      descriptor_ui: `SYN-D${tag}`,
      descriptor_name: `Synthetic ${tag}`,
      area,
      primary_stratum: 'SYN_STRATUM',
      selection_probability: 0.5,
      frame_stratum_size: 20,
      sampling_design_version: 'SYN-4',
      sampling_seed: 1,
      trial_frequency_weight: 3,
      n_trials_primary: 3,
      original_l1_decision: 'INCLUDE',
      source_file: 'synthetic',
      source_row_sha256: 'a'.repeat(64),
    },
    extra,
  );
const VS = '1.0.0+R-TEST';
const caseJson = (id, mode, tag, area = 'infectious') =>
  J({
    case_id: id,
    mode,
    unit_type: 'DESCRIPTOR_AREA',
    version_set_id: VS,
    l1_applicable: true,
    l2_applicable: false,
    l3_applicable: false,
    packet: descPacket(tag, area),
    change_reason: 'initial import',
    design: design2(tag, area),
  });
const trialPacket = {
  schema_version: '1.0',
  case_title: 'Synthetic condition T5 in a synthetic trial',
  question: 'Step 1: does the descriptor belong to the area?',
  unit: { unit_type: 'TRIAL_AREA', unit_id: 'SYN-DT5::neurological' },
  descriptor: { descriptor_ui: 'SYN-DT5', name: 'Synthetic condition T5 (fictional)' },
  mesh: { scope_note: 'SYNTHETIC TEXT FOR APP TESTING ONLY.', tree_numbers: ['C10.999'] },
  area: { key: 'neurological', label: 'Neurological' },
  notices: ['SYNTHETIC CASE: excluded from all statistics'],
};
const trialCaseJson = (id) =>
  J({
    case_id: id,
    mode: 'FORMAL',
    unit_type: 'TRIAL_AREA',
    version_set_id: VS,
    l1_applicable: true,
    l2_applicable: false,
    l3_applicable: false,
    packet: trialPacket,
    change_reason: 'initial import',
    design: design2('T5', 'neurological', {
      nct_id: 'SYN-NCT-0005',
      selection_probability: 0.5,
      frame_stratum_size: 2,
      trial_frequency_weight: 1,
    }),
  });
const d3 = (id, extra = {}) =>
  J(
    Object.assign(
      {
        case_id: id,
        mode: 'FORMAL',
        review_module: 'ONTOLOGY_AREA',
        analysis_set: 'VALIDATION_HELDOUT',
        selection_stratum: 'SYN_V_STRATUM',
        variance_stratum: 'SYN_V',
        variance_stratum_size: 20,
        selection_probability: 0.25,
        comparison_cell_v11: 'OPOS_CNEG',
        original_binary: 'INCLUDE',
        curated_v11_status_raw: 'EXCLUDE',
        curated_v11_binary: 'EXCLUDE',
        two_step_required: false,
        sampling_design_version: 'SYN-4',
      },
      extra,
    ),
  );
const rec = (id, unit, extra = {}) =>
  J(
    Object.assign(
      {
        case_id: id,
        record_category: 'HELDOUT_FORMAL',
        frame_unit_id: unit,
        provenance_audit_result: 'NO_DEVELOPMENT_FLAG',
        impact_tier: 'STANDARD',
      },
      extra,
    ),
  );
const pred = (id, lvl, t0, st, t1, sc = null, ver = 'v1.1') => ({
  prediction_set_id: 'PRED4-TESTFX',
  case_id: id,
  determination_level: lvl,
  tier0_binary: t0,
  tier1_version: ver,
  tier1_status_raw: st,
  tier1_binary: t1,
  stage_c_trial_status: sc,
});
const H = (n) => `HO4-TESTFX-00${n}`;

await setup();

// =============================================================================
// S. Setup: accounts, a complete synthetic pilot, formal unlock (the v2/v3 path, unchanged)
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
  'V4-SCHEMA-01',
  'v4-setup',
  'schema version 4.0.0 is recorded after 1.0.0 and 3.0.0',
  'inv',
  "select string_agg(version, ',' order by version) as v from public.app_schema_version",
  { value: '1.0.0,3.0.0,4.0.0' },
);
await step(
  'V4-SCHEMA-02',
  'v4-setup',
  'design v4 is not active after the migration alone (activation is a separate, attested act)',
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
const uid = async (email) =>
  (await q('select user_id from public.users where email=$1', [email]))[0].user_id;
for (const k of ['pt1', 'pt2']) {
  await step(
    `S-ENROLL-${k}`,
    'setup',
    `enroll ${k} as PILOT reviewer`,
    'inv',
    `select public.rpc_enroll_reviewer('${await uid(P[k].email)}', 'PILOT', 'synthetic pilot test account')`,
    { minRows: 1 },
  );
}
await step(
  'S-VERSION',
  'setup',
  'register a synthetic version set',
  'inv',
  `select public.rpc_register_ontology_version('${J({
    ontology_version: '1.0.0',
    rule_version: '1.0.0',
    rubric_version: 'R-TEST',
    classification_schema_version: '1.0.0',
    protocol_version: 'P-TEST',
    sampling_design_version: 'SYN-4',
    ontology_sha256: 'b'.repeat(64),
    classification_schema_sha256: 'c'.repeat(64),
    rubric_sha256: 'd'.repeat(64),
    frozen_at: '2026-10-20T00:00:00Z',
    notes: 'synthetic',
  })}'::jsonb)`,
  { value: VS },
);
const pilotIds = Array.from({ length: 10 }, (_, i) => `SYN-0${String(i + 1).padStart(2, '0')}`);
for (const [i, id] of pilotIds.entries()) {
  await step(
    `S-PCASE-${id}`,
    'setup',
    `import pilot case ${id}`,
    'inv',
    `select public.rpc_import_case('${caseJson(id, 'PILOT', `P${i + 1}`)}'::jsonb)`,
    { value: id },
  );
}
const pid = async (k) =>
  (
    await q(
      'select r.reviewer_pseudo_id from public.reviewers r join public.users u using (user_id) where u.email=$1',
      [P[k].email],
    )
  )[0].reviewer_pseudo_id;
const PT1 = await pid('pt1'),
  PT2 = await pid('pt2');
const arr = (ids) => `array[${ids.map((x) => `'${x}'`).join(',')}]`;
await step(
  'S-PASSIGN-1',
  'setup',
  'assign the pilot cases to slot 1',
  'inv',
  `select public.rpc_assign_cases('PILOT','${PT1}',1,${arr(pilotIds)},20261020)`,
  { value: 10 },
);
await step(
  'S-PASSIGN-2',
  'setup',
  'assign the pilot cases to slot 2',
  'inv',
  `select public.rpc_assign_cases('PILOT','${PT2}',2,${arr(pilotIds)},20261020)`,
  { value: 10 },
);
const asg = async (p, c) =>
  (
    await q(
      'select assignment_id from public.assignments a where a.reviewer_pseudo_id=$1 and a.case_id=$2 and a.withdrawn_at is null',
      [p, c],
    )
  )[0].assignment_id;
for (const k of ['pt1', 'pt2'])
  await step(
    `S-CLAIM-${k}`,
    'setup',
    `${k} claims account`,
    k,
    'select public.rpc_claim_account()',
    { minRows: 1 },
  );
for (const [k, p] of [
  ['pt1', PT1],
  ['pt2', PT2],
]) {
  for (const c of pilotIds) {
    await step(
      `S-PREV-${k}-${c}`,
      'setup',
      `${k} submits ${c}`,
      k,
      `select public.rpc_submit_review('${await asg(p, c)}', '{"l1_decision":"INCLUDE"}'::jsonb)`,
      { minRows: 1 },
    );
  }
}
for (const c of pilotIds) {
  await step(
    `S-PADJ-${c}`,
    'setup',
    `investigator adjudicates pilot case ${c}`,
    'inv',
    `select public.rpc_record_adjudication('${c}','clinical_classification','INCLUDE',null,'CONCORDANT_CONFIRMED','BOTH_REVIEWERS','synthetic adjudication',null,array(select review_id from public.v_effective_reviews where case_id='${c}'),null,null,false)`,
    { minRows: 1 },
  );
}
const ex = await step(
  'S-PEXPORT',
  'setup',
  'register the PILOT export',
  'inv',
  `select public.rpc_register_export('${J({
    mode: 'PILOT',
    export_type: 'ANALYSIS',
    export_format_version: '1',
    version_set_id: VS,
    ontology_version: '1.0.0',
    rule_version: '1.0.0',
    rubric_version: 'R-TEST',
    classification_schema_version: '1.0.0',
    sampling_design_version: 'SYN-4',
    app_git_sha: 'abc123',
    row_counts: { rows: 10 },
    file_sha256: { 'x.csv': '2'.repeat(64) },
  })}'::jsonb) as eid`,
  { minRows: 1 },
);
await step(
  'S-UNLOCK',
  'setup',
  'investigator unlocks the formal review after the complete pilot',
  'inv',
  `select public.rpc_unlock_formal_review('PAC-4','${'1'.repeat(64)}','abc123','${ex[0].eid}','${ATT}')`,
  { minRows: 1 },
);
for (const k of ['r1', 'r2']) {
  await step(
    `S-ENROLL-${k}`,
    'setup',
    `enroll ${k} as FORMAL reviewer`,
    'inv',
    `select public.rpc_enroll_reviewer('${await uid(P[k].email)}', 'FORMAL', 'synthetic qualifications')`,
    { minRows: 1 },
  );
}
for (const k of ['r1', 'r2', 'adj'])
  await step(
    `S-CLAIM-${k}`,
    'setup',
    `${k} claims account`,
    k,
    'select public.rpc_claim_account()',
    { minRows: 1 },
  );
const R1 = await pid('r1'),
  R2 = await pid('r2');

// =============================================================================
// V4-A. Activation (irreversible)
// =============================================================================
await step(
  'V4-ACT-00',
  'v4-roles',
  'a reviewer cannot activate design v4',
  'r1',
  `select public.rpc_activate_design_v4('SYN-4', 'DISAGREEMENTS_ONLY', '${ATT}')`,
  { error: /investigator role/ },
);
await step(
  'V4-ACT-01a',
  'v4-setup',
  'before activation a FORMAL case may carry a legacy ID (v3 behaviour)',
  'inv',
  `select public.rpc_import_case('${caseJson('REV-L01', 'FORMAL', 'L1')}'::jsonb)`,
  { value: 'REV-L01' },
);
await step(
  'V4-ACT-01b',
  'v4-gate',
  'activation is refused while an active FORMAL case lacks a held-out ID',
  'inv',
  `select public.rpc_activate_design_v4('SYN-4', 'DISAGREEMENTS_ONLY', '${ATT}')`,
  { error: /withdraw them before activating/ },
);
await step(
  'V4-ACT-01c',
  'v4-setup',
  'withdraw the legacy case',
  'inv',
  "select public.rpc_withdraw_case('REV-L01', 'synthetic legacy case')",
  { ok: true },
);
await step(
  'V4-ACT-02',
  'v4-gate',
  'an unknown adjudication scope is refused',
  'inv',
  `select public.rpc_activate_design_v4('SYN-4', 'EVERY_CASE', '${ATT}')`,
  { error: /check constraint|violates/ },
);
await step(
  'V4-ACT-03',
  'v4-setup',
  'investigator activates design v4 with the D2 scope (disagreements only)',
  'inv',
  `select public.rpc_activate_design_v4('SYN-4', 'DISAGREEMENTS_ONLY', '${ATT}')`,
  { minRows: 1 },
);
await step(
  'V4-ACT-04',
  'v4-gate',
  'a second activation is refused',
  'inv',
  `select public.rpc_activate_design_v4('SYN-4', 'ALL_CASE_LEVELS', '${ATT}')`,
  { error: /already active/ },
);
await step(
  'V4-ACT-05',
  'v4-immutability',
  'the activation row cannot be updated (owner role)',
  'owner',
  "update public.design_activation_v4 set adjudication_scope = 'ALL_CASE_LEVELS'",
  { error: /append-only/ },
);
for (const who of ['r1', 'adj']) {
  await step(
    `V4-ACT-06-${who}`,
    'v4-blinding',
    `${who} reads no activation row`,
    who,
    'select * from public.design_activation_v4',
    { rows: 0 },
  );
}

// =============================================================================
// V4-B. Record categories and identifier prefixes
// =============================================================================
await step(
  'V4-ID-01',
  'v4-categories',
  'a FORMAL case with a legacy REV- ID is refused after activation',
  'inv',
  `select public.rpc_import_case('${caseJson('REV-T10', 'FORMAL', 'X1')}'::jsonb)`,
  { error: /not a held-out case ID/ },
);
await step(
  'V4-ID-02',
  'v4-categories',
  'a development ID (DEV4-) can never be a FORMAL case',
  'inv',
  `select public.rpc_import_case('${caseJson('DEV4-TESTFX-0009', 'FORMAL', 'X2')}'::jsonb)`,
  { error: /not a held-out case ID/ },
);
await step(
  'V4-ID-03',
  'v4-categories',
  'a calibration ID (CAL4-) can never be a FORMAL case',
  'inv',
  `select public.rpc_import_case('${caseJson('CAL4-TESTFX-09', 'FORMAL', 'X3')}'::jsonb)`,
  { error: /not a held-out case ID/ },
);
await step(
  'V4-ID-04',
  'v4-categories',
  'a synthetic pilot ID (SYN-) can never be a FORMAL case',
  'inv',
  `select public.rpc_import_case('${caseJson('SYN-777', 'FORMAL', 'X4')}'::jsonb)`,
  { error: /not a held-out case ID/ },
);
await step(
  'V4-ID-05',
  'v4-categories',
  'a held-out ID cannot be a PILOT case (PILOT IDs are SYN-)',
  'inv',
  `select public.rpc_import_case('${caseJson('HO4-TESTFX-099', 'PILOT', 'X5')}'::jsonb)`,
  { error: /check constraint|violates/ },
);
await step(
  'V4-ID-06',
  'v4-categories',
  'a Module B ID cannot be a FORMAL Module A case',
  'inv',
  `select public.rpc_import_case('${caseJson('MB4-ROW-TESTFX_Z', 'FORMAL', 'X6')}'::jsonb)`,
  { error: /not a held-out case ID/ },
);

const devUnits = [
  {
    dev_case_id: 'DEV4-TESTFX-0001',
    frame_unit_id: 'FX-U-DEV-01',
    unit_type: 'DESCRIPTOR_AREA',
    primary_exclusion_reason: 'E02_STAGE_A_V3_CORE',
  },
  {
    dev_case_id: 'DEV4-TESTFX-0002',
    frame_unit_id: 'FX-U-DEV-02',
    unit_type: 'TRIAL_AREA',
    primary_exclusion_reason: 'E10_QA_ROUND2',
  },
];
await step(
  'V4-DEV-00',
  'v4-roles',
  'a reviewer cannot register development units',
  'r1',
  `select public.rpc_register_development_units_v4('${J(devUnits)}'::jsonb)`,
  { error: /investigator role/ },
);
await step(
  'V4-DEV-01',
  'v4-setup',
  'investigator registers two development units (DEV4-)',
  'inv',
  `select public.rpc_register_development_units_v4('${J(devUnits)}'::jsonb)`,
  { value: 2 },
);
await step(
  'V4-DEV-02',
  'v4-categories',
  'a development ID without the DEV4- prefix is refused',
  'inv',
  `select public.rpc_register_development_units_v4('${J([{ dev_case_id: 'DEV-0003', frame_unit_id: 'FX-U-DEV-03', unit_type: 'DESCRIPTOR_AREA', primary_exclusion_reason: 'E02_X' }])}'::jsonb)`,
  { error: /check constraint|violates/ },
);
for (const who of ['r1', 'adj', 'out']) {
  await step(
    `V4-DEV-03-${who}`,
    'v4-blinding',
    `${who} reads no development unit`,
    who,
    'select * from public.development_registry_v4',
    { rows: 0 },
  );
}

for (const n of [1, 2, 3, 4]) {
  await step(
    `V4-CASE-${n}`,
    'v4-setup',
    `import held-out descriptor case ${H(n)}`,
    'inv',
    `select public.rpc_import_case('${caseJson(H(n), 'FORMAL', `H${n}`)}'::jsonb)`,
    { value: H(n) },
  );
}
await step(
  'V4-CASE-5',
  'v4-setup',
  `import held-out two-step trial case ${H(5)}`,
  'inv',
  `select public.rpc_import_case('${trialCaseJson(H(5))}'::jsonb)`,
  { value: H(5) },
);
for (const n of [6, 7]) {
  await step(
    `V4-CASE-${n}`,
    'v4-setup',
    `import held-out descriptor case ${H(n)} (used for refusal tests)`,
    'inv',
    `select public.rpc_import_case('${caseJson(H(n), 'FORMAL', `H${n}`)}'::jsonb)`,
    { value: H(n) },
  );
}
await step(
  'V4-CASE-R1',
  'v4-setup',
  'import an HO4R- case (extension prefix; recorded only under an amendment)',
  'inv',
  `select public.rpc_import_case('${caseJson('HO4R-TESTFX-001', 'FORMAL', 'R1')}'::jsonb)`,
  { value: 'HO4R-TESTFX-001' },
);

await step(
  'V4-CAT-00',
  'v4-roles',
  'a reviewer cannot record a held-out case',
  'r1',
  `select public.rpc_record_heldout_case_v4('${rec(H(1), 'FX-U-001')}'::jsonb)`,
  { error: /investigator role/ },
);
for (const n of [1, 2, 3, 4, 5]) {
  await step(
    `V4-CAT-0${n}`,
    'v4-setup',
    `record ${H(n)} as HELDOUT_FORMAL with provenance NO_DEVELOPMENT_FLAG`,
    'inv',
    `select public.rpc_record_heldout_case_v4('${rec(H(n), `FX-U-00${n}`, n === 4 ? { impact_tier: 'HIGH' } : {})}'::jsonb)`,
    { value: H(n) },
  );
}
await step(
  'V4-CAT-06',
  'v4-integrity',
  'a frame unit in the development registry can never be a held-out case',
  'inv',
  `select public.rpc_record_heldout_case_v4('${rec(H(6), 'FX-U-DEV-01')}'::jsonb)`,
  { error: /development unit and can never be a held-out case/ },
);
await step(
  'V4-CAT-07',
  'v4-integrity',
  'a case whose provenance audit flags development use cannot be recorded',
  'inv',
  `select public.rpc_record_heldout_case_v4('${rec(H(6), 'FX-U-006', { provenance_audit_result: 'DEVELOPMENT_FLAG' })}'::jsonb)`,
  { error: /check constraint|violates/ },
);
await step(
  'V4-CAT-08',
  'v4-categories',
  'an HO4R- case cannot be recorded as HELDOUT_FORMAL',
  'inv',
  `select public.rpc_record_heldout_case_v4('${rec('HO4R-TESTFX-001', 'FX-U-R01')}'::jsonb)`,
  { error: /check constraint|violates/ },
);
await step(
  'V4-CAT-09',
  'v4-categories',
  'an HO4R- case needs an amendment ID',
  'inv',
  `select public.rpc_record_heldout_case_v4('${rec('HO4R-TESTFX-001', 'FX-U-R01', { record_category: 'HELDOUT_EXTENSION_APPROVED' })}'::jsonb)`,
  { error: /check constraint|violates|ADOPT_EXTENSION_30/ },
);
await step(
  'V4-CAT-10a',
  'v4-setup',
  'register an amendment whose purpose is not the extension',
  'inv',
  `select public.rpc_register_amendment_v4('${J({ amendment_id: 'AMD4-TESTFX-OTHER', purpose: 'OTHER', description: 'Synthetic amendment for testing only.' })}'::jsonb)`,
  { value: 'AMD4-TESTFX-OTHER' },
);
await step(
  'V4-CAT-10b',
  'v4-categories',
  'an HO4R- case needs an ADOPT_EXTENSION_30 amendment, not any amendment',
  'inv',
  `select public.rpc_record_heldout_case_v4('${rec('HO4R-TESTFX-001', 'FX-U-R01', { record_category: 'HELDOUT_EXTENSION_APPROVED', amendment_id: 'AMD4-TESTFX-OTHER' })}'::jsonb)`,
  { error: /ADOPT_EXTENSION_30/ },
);
await step(
  'V4-CAT-10c',
  'v4-categories',
  'an amendment ID without the AMD4- prefix is refused',
  'inv',
  `select public.rpc_register_amendment_v4('${J({ amendment_id: 'AMD-1', purpose: 'OTHER', description: 'Synthetic amendment for testing only.' })}'::jsonb)`,
  { error: /check constraint|violates/ },
);
await step(
  'V4-CAT-11',
  'v4-integrity',
  'one frame unit cannot be two held-out cases',
  'inv',
  `select public.rpc_record_heldout_case_v4('${rec(H(6), 'FX-U-001')}'::jsonb)`,
  { error: /duplicate|unique/ },
);
await step(
  'V4-CAT-12',
  'v4-integrity',
  'a held-out frame unit cannot later be registered as a development unit',
  'inv',
  `select public.rpc_register_development_units_v4('${J([{ dev_case_id: 'DEV4-TESTFX-0003', frame_unit_id: 'FX-U-001', unit_type: 'DESCRIPTOR_AREA', primary_exclusion_reason: 'E02_X' }])}'::jsonb)`,
  { error: /already a held-out case/ },
);
await step(
  'V4-CAT-13',
  'v4-categories',
  'a held-out case record for a PILOT case is refused',
  'inv',
  `select public.rpc_record_heldout_case_v4('${rec('SYN-001', 'FX-U-P01')}'::jsonb)`,
  { error: /check constraint|violates|foreign key/ },
);
for (const who of ['r1', 'adj', 'out', 'pt1']) {
  await step(
    `V4-CAT-14-${who}`,
    'v4-blinding',
    `${who} reads no held-out case record`,
    who,
    'select * from public.case_records_v4',
    { rows: 0 },
  );
}
await step(
  'V4-CAT-15',
  'v4-immutability',
  'a held-out case record cannot be updated (owner role)',
  'owner',
  "update public.case_records_v4 set impact_tier = 'X'",
  { error: /append-only/ },
);
await step(
  'V4-CAT-16',
  'v4-blinding',
  'anon cannot read held-out case records',
  'anon',
  'select * from public.case_records_v4',
  { error: /permission denied/ },
);

for (const n of [1, 2, 3, 4]) {
  await step(
    `V4-V3-0${n}`,
    'v4-setup',
    `v3 design row for ${H(n)}`,
    'inv',
    `select public.rpc_set_case_design_v3('${d3(H(n))}'::jsonb)`,
    { value: H(n) },
  );
}
await step(
  'V4-V3-05',
  'v4-setup',
  `v3 design row for ${H(5)} (two-step)`,
  'inv',
  `select public.rpc_set_case_design_v3('${d3(H(5), { two_step_required: true, comparison_cell_v11: 'T_DISC_LOSS', curated_v11_status_raw: 'CONTEXT_DEPENDENT', curated_v11_binary: 'INCLUDE', selection_probability: 0.5, variance_stratum: 'SYN_T', variance_stratum_size: 2 })}'::jsonb)`,
  { value: H(5) },
);
await step(
  'V4-V3-06',
  'v4-integrity',
  'after activation a FORMAL case cannot be put in a development analysis set',
  'inv',
  `select public.rpc_set_case_design_v3('${d3(H(6), { analysis_set: 'DEVELOPMENT_KNOWN_ISSUE', development_basis: 'synthetic' })}'::jsonb)`,
  { error: /every FORMAL case is held out/ },
);
await step(
  'V4-V3-07',
  'v4-setup',
  `v3 design row for ${H(7)} (it will lack a held-out record)`,
  'inv',
  `select public.rpc_set_case_design_v3('${d3(H(7))}'::jsonb)`,
  { value: H(7) },
);
await step(
  'V4-TPKT',
  'v4-setup',
  'registration-fields-only trial packet for the trial case',
  'inv',
  `select public.rpc_add_trial_context_packet('${H(5)}', '{"schema_version":"1.0","trial":{"brief_title":"Synthetic trial (fictional)","conditions":["Synthetic condition T5"],"eligibility_criteria":"SYNTHETIC TEXT","primary_purpose":"TREATMENT","phase":"PHASE2"},"notices":["SYNTHETIC CASE"]}'::jsonb)`,
  { minRows: 1 },
);
for (const c of [H(6), 'HO4R-TESTFX-001']) {
  await step(
    `V4-WD-${c}`,
    'v4-setup',
    `withdraw ${c} (no held-out record; not adopted)`,
    'inv',
    `select public.rpc_withdraw_case('${c}', 'synthetic test case')`,
    { ok: true },
  );
}

// =============================================================================
// V4-C. Rubric calibration (own tables; before the freeze only)
// =============================================================================
const calPacket = descPacket('C1', 'infectious');
await step(
  'V4-CAL-00',
  'v4-roles',
  'a reviewer cannot create a calibration case',
  'r1',
  `select public.rpc_import_calibration_case_v4('${J({ cal_case_id: 'CAL4-TESTFX-01', source_dev_case_id: 'DEV4-TESTFX-0001', unit_type: 'DESCRIPTOR_AREA', packet: calPacket })}'::jsonb)`,
  { error: /investigator role/ },
);
await step(
  'V4-CAL-01',
  'v4-setup',
  'investigator creates a calibration case from a development unit',
  'inv',
  `select public.rpc_import_calibration_case_v4('${J({ cal_case_id: 'CAL4-TESTFX-01', source_dev_case_id: 'DEV4-TESTFX-0001', unit_type: 'DESCRIPTOR_AREA', packet: calPacket })}'::jsonb)`,
  { value: 'CAL4-TESTFX-01' },
);
await step(
  'V4-CAL-02',
  'v4-categories',
  'a calibration case cannot carry a held-out ID',
  'inv',
  `select public.rpc_import_calibration_case_v4('${J({ cal_case_id: 'HO4-TESTFX-050', source_dev_case_id: 'DEV4-TESTFX-0002', unit_type: 'TRIAL_AREA', packet: calPacket })}'::jsonb)`,
  { error: /check constraint|violates/ },
);
await step(
  'V4-CAL-03',
  'v4-integrity',
  'a calibration case must come from a registered development unit',
  'inv',
  `select public.rpc_import_calibration_case_v4('${J({ cal_case_id: 'CAL4-TESTFX-02', source_dev_case_id: 'DEV4-TESTFX-0099', unit_type: 'DESCRIPTOR_AREA', packet: calPacket })}'::jsonb)`,
  { error: /foreign key|violates/ },
);
await step(
  'V4-CAL-04',
  'v4-blinding',
  'a calibration packet with a nested AI status key is refused',
  'inv',
  `select public.rpc_import_calibration_case_v4('${J({ cal_case_id: 'CAL4-TESTFX-03', source_dev_case_id: 'DEV4-TESTFX-0002', unit_type: 'TRIAL_AREA', packet: Object.assign({}, calPacket, { descriptor: { name: 'x', ai_status: 'INCLUDE' } }) })}'::jsonb)`,
  { error: /blinded content/ },
);
await step(
  'V4-CAL-05',
  'v4-integrity',
  'one development unit gives at most one calibration case',
  'inv',
  `select public.rpc_import_calibration_case_v4('${J({ cal_case_id: 'CAL4-TESTFX-04', source_dev_case_id: 'DEV4-TESTFX-0001', unit_type: 'DESCRIPTOR_AREA', packet: calPacket })}'::jsonb)`,
  { error: /duplicate|unique/ },
);
await step(
  'V4-CAL-06a',
  'v4-setup',
  'assign the calibration case to r1',
  'inv',
  `select public.rpc_assign_calibration_v4('CAL4-TESTFX-01', '${R1}')`,
  { minRows: 1 },
);
await step(
  'V4-CAL-06b',
  'v4-setup',
  'assign the calibration case to r2',
  'inv',
  `select public.rpc_assign_calibration_v4('CAL4-TESTFX-01', '${R2}')`,
  { minRows: 1 },
);
await step(
  'V4-CAL-07',
  'v4-roles',
  'calibration cannot go to a pilot test account',
  'inv',
  `select public.rpc_assign_calibration_v4('CAL4-TESTFX-01', '${PT1}')`,
  { error: /active FORMAL reviewers only/ },
);
await step(
  'V4-CAL-08a',
  'v4-blinding',
  'r1 reads the assigned calibration case',
  'r1',
  'select * from public.calibration_cases_v4',
  { rows: 1 },
);
await step(
  'V4-CAL-08b',
  'v4-blinding',
  'a pilot account reads no calibration case',
  'pt1',
  'select * from public.calibration_cases_v4',
  { rows: 0 },
);
const casg = async (p) =>
  (
    await q(
      'select cal_assignment_id from public.calibration_assignments_v4 where reviewer_pseudo_id=$1',
      [p],
    )
  )[0].cal_assignment_id;
await step(
  'V4-CAL-09a',
  'v4-workflow',
  'r1 submits a calibration response',
  'r1',
  `select public.rpc_submit_calibration_v4('${await casg(R1)}', '{"decision":"INCLUDE","rationale":"synthetic","uncertain":false}'::jsonb)`,
  { minRows: 1 },
);
await step(
  'V4-CAL-09b',
  'v4-roles',
  'r2 cannot respond on the r1 calibration assignment',
  'r2',
  `select public.rpc_submit_calibration_v4('${await casg(R1)}', '{"decision":"EXCLUDE","uncertain":false}'::jsonb)`,
  { error: /not your calibration assignment/ },
);
await step(
  'V4-CAL-09c',
  'v4-workflow',
  'r2 submits a calibration response',
  'r2',
  `select public.rpc_submit_calibration_v4('${await casg(R2)}', '{"decision":"EXCLUDE","rationale":"synthetic","uncertain":true}'::jsonb)`,
  { minRows: 1 },
);
await step(
  'V4-CAL-10',
  'v4-blinding',
  'r2 reads only their own calibration response',
  'r2',
  'select * from public.calibration_responses_v4',
  { rows: 1 },
);
await step(
  'V4-CAL-11',
  'v4-blinding',
  'the adjudicator reads no calibration response',
  'adj',
  'select * from public.calibration_responses_v4',
  { rows: 0 },
);
await step(
  'V4-CAL-12',
  'v4-immutability',
  'a calibration response cannot be updated (owner role)',
  'owner',
  "update public.calibration_responses_v4 set decision = 'INCLUDE'",
  { error: /append-only/ },
);

// =============================================================================
// V4-D. Frozen predictions (investigator only; write-once; mapping policy)
// =============================================================================
const batch1 = [
  pred(H(1), 'DESCRIPTOR_LEVEL', 'INCLUDE', 'EXCLUDE', 'EXCLUDE'),
  pred(H(2), 'DESCRIPTOR_LEVEL', 'INCLUDE', 'INCLUDE', 'INCLUDE'),
  pred(H(3), 'DESCRIPTOR_LEVEL', 'EXCLUDE', 'NOT_IN_DECISION_FILE', 'EXCLUDE'),
];
await step(
  'V4-PRED-00',
  'v4-roles',
  'a reviewer cannot import predictions',
  'r1',
  `select public.rpc_import_frozen_predictions_v4('${J(batch1)}'::jsonb)`,
  { error: /investigator role/ },
);
await step(
  'V4-PRED-01',
  'v4-setup',
  'import three descriptor-level predictions (Tier 1 v1.1)',
  'inv',
  `select public.rpc_import_frozen_predictions_v4('${J(batch1)}'::jsonb)`,
  { value: 3 },
);
await step(
  'V4-PRED-02',
  'v4-predictions',
  'a descriptor-level Tier 1 binary that breaks the mapping policy is refused (INCLUDE status, EXCLUDE binary)',
  'inv',
  `select public.rpc_import_frozen_predictions_v4('${J([pred(H(4), 'DESCRIPTOR_LEVEL', 'EXCLUDE', 'INCLUDE', 'EXCLUDE')])}'::jsonb)`,
  { error: /check constraint|violates/ },
);
await step(
  'V4-PRED-03',
  'v4-predictions',
  'CONTEXT_DEPENDENT must map to the Tier 0 binary at descriptor level',
  'inv',
  `select public.rpc_import_frozen_predictions_v4('${J([pred(H(5), 'DESCRIPTOR_LEVEL_IN_TRIAL_CASE', 'INCLUDE', 'CONTEXT_DEPENDENT', 'EXCLUDE')])}'::jsonb)`,
  { error: /check constraint|violates/ },
);
await step(
  'V4-PRED-04',
  'v4-predictions',
  'a trial-level Tier 1 binary that disagrees with Stage C is refused',
  'inv',
  `select public.rpc_import_frozen_predictions_v4('${J([pred(H(5), 'TRIAL_LEVEL', 'INCLUDE', 'CONTEXT_DEPENDENT', 'INCLUDE', 'EXCLUDE')])}'::jsonb)`,
  { error: /check constraint|violates/ },
);
await step(
  'V4-PRED-05',
  'v4-predictions',
  'a determination level that does not apply to the case is refused',
  'inv',
  `select public.rpc_import_frozen_predictions_v4('${J([pred(H(4), 'TRIAL_LEVEL', 'EXCLUDE', 'INCLUDE', 'INCLUDE', 'INCLUDE')])}'::jsonb)`,
  { error: /does not apply/ },
);
await step(
  'V4-PRED-06',
  'v4-predictions',
  'a second Tier 1 version in the prediction set is refused',
  'inv',
  `select public.rpc_import_frozen_predictions_v4('${J([pred(H(4), 'DESCRIPTOR_LEVEL', 'EXCLUDE', 'INCLUDE', 'INCLUDE', null, 'v1.2')])}'::jsonb)`,
  { error: /one Tier 1 version/ },
);
await step(
  'V4-PRED-07',
  'v4-integrity',
  'a prediction for a case without a held-out record is refused',
  'inv',
  `select public.rpc_import_frozen_predictions_v4('${J([pred(H(7), 'DESCRIPTOR_LEVEL', 'EXCLUDE', 'EXCLUDE', 'EXCLUDE')])}'::jsonb)`,
  { error: /foreign key|violates/ },
);
await step(
  'V4-PRED-08',
  'v4-predictions',
  'a second prediction for the same case level is refused',
  'inv',
  `select public.rpc_import_frozen_predictions_v4('${J([pred(H(1), 'DESCRIPTOR_LEVEL', 'INCLUDE', 'EXCLUDE', 'EXCLUDE')])}'::jsonb)`,
  { error: /duplicate|unique/ },
);
await step(
  'V4-PRED-09',
  'v4-setup',
  'import the remaining descriptor-level predictions',
  'inv',
  `select public.rpc_import_frozen_predictions_v4('${J([pred(H(4), 'DESCRIPTOR_LEVEL', 'EXCLUDE', 'INCLUDE', 'INCLUDE'), pred(H(5), 'DESCRIPTOR_LEVEL_IN_TRIAL_CASE', 'INCLUDE', 'CONTEXT_DEPENDENT', 'INCLUDE')])}'::jsonb)`,
  { value: 2 },
);
const canon = [
  'PRED4-TESTFX',
  H(2),
  'DESCRIPTOR_LEVEL',
  'INCLUDE',
  'v1.1',
  'INCLUDE',
  'INCLUDE',
  '',
].join('|');
await step(
  'V4-PRED-10',
  'v4-predictions',
  'the database row hash equals SHA-256 of the canonical row text (computed independently in JavaScript)',
  'inv',
  `select row_sha256 = '${sha256(canon)}' as v from public.frozen_predictions_v4 where case_id = '${H(2)}'`,
  { value: true },
);
for (const who of ['r1', 'adj', 'out']) {
  await step(
    `V4-PRED-11-${who}`,
    'v4-blinding',
    `${who} reads no frozen prediction`,
    who,
    'select * from public.frozen_predictions_v4',
    { rows: 0 },
  );
}
await step(
  'V4-PRED-12',
  'v4-blinding',
  'anon cannot read frozen predictions',
  'anon',
  'select * from public.frozen_predictions_v4',
  { error: /permission denied/ },
);
await step(
  'V4-PRED-13',
  'v4-roles',
  'a reviewer cannot insert a prediction directly',
  'r1',
  `insert into public.frozen_predictions_v4 (prediction_set_id, case_id, determination_level, tier0_binary, tier1_version, tier1_status_raw, tier1_binary, row_sha256, imported_by) values ('X', '${H(4)}', 'DESCRIPTOR_LEVEL', 'INCLUDE', 'v1.1', 'INCLUDE', 'INCLUDE', '${'0'.repeat(64)}', '${P.r1.sub}')`,
  { error: /permission denied/ },
);

// =============================================================================
// V4-E. The freeze
// =============================================================================
const frozenItems = {
  tier0_mapping: 'a'.repeat(64),
  tier1_decision_file: 'b'.repeat(64),
  ontology: 'c'.repeat(64),
  rubric: 'd'.repeat(64),
  provenance_audit: 'e'.repeat(64),
  case_list: 'f'.repeat(64),
};
const freezeJson = (extra = {}) =>
  J(
    Object.assign(
      {
        tier1_version: 'v1.1',
        prediction_file_sha256: '9'.repeat(64),
        frozen_items: frozenItems,
        attestation: ATT,
      },
      extra,
    ),
  );
await step(
  'V4-FRZ-00',
  'v4-gate',
  'the v4 freeze is refused before the v3 sample manifest is frozen',
  'inv',
  `select public.rpc_freeze_v4('${freezeJson()}'::jsonb)`,
  { error: /v3 sample manifest/ },
);
await step(
  'V4-FRZ-01',
  'v4-setup',
  'freeze the v3 sample manifest',
  'inv',
  `select public.rpc_freeze_sample_manifest('${J({ review_module: 'ONTOLOGY_AREA', sampling_design_version: 'SYN-4', manifest_file_sha256: '3'.repeat(64), decision_file_v11_sha256: '4'.repeat(64), sampling_seed: 2026102001, attestation: ATT })}'::jsonb)`,
  { minRows: 1 },
);
await step(
  'V4-FRZ-02',
  'v4-integrity',
  'the freeze is refused while a manifest case lacks a held-out record',
  'inv',
  `select public.rpc_freeze_v4('${freezeJson()}'::jsonb)`,
  { error: /lack a held-out case record/ },
);
await step(
  'V4-FRZ-02b',
  'v4-setup',
  `withdraw ${H(7)}`,
  'inv',
  `select public.rpc_withdraw_case('${H(7)}', 'synthetic test case')`,
  { ok: true },
);
await step(
  'V4-FRZ-03',
  'v4-integrity',
  'the freeze is refused while a required case level has no prediction',
  'inv',
  `select public.rpc_freeze_v4('${freezeJson()}'::jsonb)`,
  { error: /have no frozen prediction/ },
);
await step(
  'V4-FRZ-03b',
  'v4-setup',
  'import the trial-level prediction',
  'inv',
  `select public.rpc_import_frozen_predictions_v4('${J([pred(H(5), 'TRIAL_LEVEL', 'INCLUDE', 'CONTEXT_DEPENDENT', 'EXCLUDE', 'EXCLUDE')])}'::jsonb)`,
  { value: 1 },
);
await step(
  'V4-FRZ-04',
  'v4-integrity',
  'the freeze is refused when the declared Tier 1 version differs from the predictions',
  'inv',
  `select public.rpc_freeze_v4('${freezeJson({ tier1_version: 'v1.2' })}'::jsonb)`,
  { error: /Tier 1 version other than/ },
);
await step(
  'V4-FRZ-05',
  'v4-integrity',
  'the freeze is refused when a frozen item is not a SHA-256 value',
  'inv',
  `select public.rpc_freeze_v4('${freezeJson({ frozen_items: { rubric: 'not-a-hash' } })}'::jsonb)`,
  { error: /not a SHA-256 value/ },
);
await step(
  'V4-FRZ-06',
  'v4-roles',
  'a reviewer cannot freeze',
  'r1',
  `select public.rpc_freeze_v4('${freezeJson()}'::jsonb)`,
  { error: /investigator role/ },
);
await step(
  'V4-ASG-00',
  'v4-gate',
  'a FORMAL assignment is refused before the v4 freeze',
  'inv',
  `select public.rpc_assign_cases('FORMAL','${R1}',1,${arr([H(1)])},7)`,
  { error: /open only after rpc_freeze_v4/ },
);
await step(
  'V4-FRZ-07',
  'v4-gate',
  'investigator records the single freeze event',
  'inv',
  `select public.rpc_freeze_v4('${freezeJson()}'::jsonb) as fid`,
  { minRows: 1 },
);
const caseList = [1, 2, 3, 4, 5].map(H).sort().join('\n');
await step(
  'V4-FRZ-08',
  'v4-freeze',
  'the recorded case-list hash equals SHA-256 of the sorted, LF-joined held-out IDs (JavaScript)',
  'inv',
  `select case_list_sha256 = '${sha256(caseList)}' as v from public.freeze_manifests_v4`,
  { value: true },
);
await step(
  'V4-FRZ-09',
  'v4-freeze',
  'the freeze counts 5 cases and 6 prediction rows, Tier 1 v1.1, scope DISAGREEMENTS_ONLY',
  'inv',
  "select concat_ws('|', n_cases, n_prediction_rows, tier1_version, adjudication_scope) as v from public.freeze_manifests_v4",
  { value: '5|6|v1.1|DISAGREEMENTS_ONLY' },
);
await step(
  'V4-FRZ-10',
  'v4-gate',
  'a second freeze is refused',
  'inv',
  `select public.rpc_freeze_v4('${freezeJson()}'::jsonb)`,
  { error: /already happened/ },
);
await step(
  'V4-FRZ-11',
  'v4-predictions',
  'a prediction import after the freeze is refused',
  'inv',
  `select public.rpc_import_frozen_predictions_v4('${J([pred(H(4), 'DESCRIPTOR_LEVEL', 'INCLUDE', 'INCLUDE', 'INCLUDE')])}'::jsonb)`,
  { error: /predictions are frozen/ },
);
await step(
  'V4-FRZ-12a',
  'v4-immutability',
  'UPDATE of a frozen prediction is rejected (owner role)',
  'owner',
  "update public.frozen_predictions_v4 set tier1_binary = 'INCLUDE'",
  { error: /append-only/ },
);
await step(
  'V4-FRZ-12b',
  'v4-immutability',
  'DELETE of a frozen prediction is rejected (owner role)',
  'owner',
  'delete from public.frozen_predictions_v4',
  { error: /append-only/ },
);
await step(
  'V4-FRZ-12c',
  'v4-immutability',
  'TRUNCATE of the frozen predictions is rejected (owner role)',
  'owner',
  'truncate public.frozen_predictions_v4',
  { error: /append-only/ },
);
await step(
  'V4-FRZ-12d',
  'v4-immutability',
  'UPDATE of the freeze manifest is rejected (owner role)',
  'owner',
  "update public.freeze_manifests_v4 set tier1_version = 'v1.2'",
  { error: /append-only/ },
);
await step(
  'V4-FRZ-13',
  'v4-integrity',
  'no FORMAL case can be imported after the freeze',
  'inv',
  `select public.rpc_import_case('${caseJson('HO4-TESTFX-008', 'FORMAL', 'H8')}'::jsonb)`,
  { error: /frozen/ },
);
await step(
  'V4-FRZ-14',
  'v4-integrity',
  'the development registry cannot change after the freeze',
  'inv',
  `select public.rpc_register_development_units_v4('${J([{ dev_case_id: 'DEV4-TESTFX-0004', frame_unit_id: 'FX-U-DEV-04', unit_type: 'DESCRIPTOR_AREA', primary_exclusion_reason: 'E02_X' }])}'::jsonb)`,
  { error: /cannot change/ },
);
await step(
  'V4-FRZ-15a',
  'v4-integrity',
  'no calibration case can be added after the freeze',
  'inv',
  `select public.rpc_import_calibration_case_v4('${J({ cal_case_id: 'CAL4-TESTFX-05', source_dev_case_id: 'DEV4-TESTFX-0002', unit_type: 'TRIAL_AREA', packet: calPacket })}'::jsonb)`,
  { error: /closes at the freeze/ },
);
await step(
  'V4-FRZ-15b',
  'v4-integrity',
  'no calibration response can be added after the freeze',
  'r1',
  `select public.rpc_submit_calibration_v4('${await casg(R1)}', '{"decision":"EXCLUDE","rationale":"synthetic","uncertain":false}'::jsonb)`,
  { error: /closes at the freeze/ },
);
await step(
  'V4-FRZ-16',
  'v4-integrity',
  'the extension cannot be adopted by an amendment after the freeze',
  'inv',
  `select public.rpc_register_amendment_v4('${J({ amendment_id: 'AMD4-TESTFX-EXT', purpose: 'ADOPT_EXTENSION_30', description: 'Synthetic amendment for testing only.' })}'::jsonb)`,
  { error: /approved before the freeze/ },
);
await step(
  'V4-FRZ-17',
  'v4-integrity',
  'no held-out case record can be added after the freeze',
  'inv',
  `select public.rpc_record_heldout_case_v4('${rec(H(7), 'FX-U-007')}'::jsonb)`,
  { error: /frozen/ },
);
await step(
  'V4-FRZ-17b',
  'v4-integrity',
  'a frozen held-out case cannot be withdrawn (the case list is fixed at the freeze)',
  'inv',
  `select public.rpc_withdraw_case('${H(1)}', 'synthetic test')`,
  { error: /frozen held-out case and cannot be withdrawn/ },
);
await step(
  'V4-FRZ-18',
  'v4-predictions',
  'the prediction-row hash recomputed now equals the hash recorded at the freeze',
  'inv',
  'select matches from public.rpc_verify_frozen_predictions_v4()',
  { value: true },
);
await step(
  'V4-FRZ-19',
  'v4-roles',
  'a reviewer cannot run the prediction verification',
  'r1',
  'select * from public.rpc_verify_frozen_predictions_v4()',
  { error: /investigator role/ },
);
for (const who of ['r1', 'adj']) {
  await step(
    `V4-FRZ-20-${who}`,
    'v4-blinding',
    `${who} reads no freeze manifest`,
    who,
    'select * from public.freeze_manifests_v4',
    { rows: 0 },
  );
}
await step(
  'V4-FRZ-21',
  'v4-blinding',
  'the calibration window closes at the freeze: r1 reads no calibration record afterwards',
  'r1',
  'select ((select count(*) from public.calibration_cases_v4) + (select count(*) from public.calibration_assignments_v4) + (select count(*) from public.calibration_responses_v4))::int as n',
  { value: 0 },
);
await step(
  'V4-FRZ-22',
  'v4-roles',
  'the investigator still reads the calibration records after the freeze',
  'inv',
  'select count(*)::int as n from public.calibration_responses_v4',
  { value: 2 },
);
const ontJson = (ver) =>
  J({
    ontology_version: ver,
    rule_version: '1.0.0',
    rubric_version: 'R-TEST',
    classification_schema_version: '1.0.0',
    protocol_version: 'P-TEST',
    sampling_design_version: 'SYN-4',
    ontology_sha256: '7'.repeat(64),
    classification_schema_sha256: 'c'.repeat(64),
    rubric_sha256: 'd'.repeat(64),
    frozen_at: '2026-10-21T00:00:00Z',
    notes: 'synthetic',
  });
await step(
  'V4-ONT-01',
  'v4-ontology',
  'after the freeze a new ontology version without the -DVF suffix is refused',
  'inv',
  `select public.rpc_register_ontology_version('${ontJson('1.3.0')}'::jsonb)`,
  { error: /must end in -DVF/ },
);
await step(
  'V4-ONT-02',
  'v4-ontology',
  'a -DVF (development from validation feedback) version can be registered',
  'inv',
  `select public.rpc_register_ontology_version('${ontJson('1.3.0-DVF')}'::jsonb)`,
  { value: '1.3.0-DVF+R-TEST' },
);
await step(
  'V4-ONT-03',
  'v4-ontology',
  'a FORMAL case version cannot use the post-freeze version set',
  'inv',
  `select public.rpc_add_case_version('${H(1)}', '${J(descPacket('H1', 'infectious'))}'::jsonb, '1.3.0-DVF+R-TEST', true, false, false, 'synthetic test')`,
  { error: /registered after the freeze/ },
);
await step(
  'V4-ONT-04',
  'v4-ontology',
  'the frozen predictions are unchanged by the new ontology version (hash still matches)',
  'inv',
  'select matches from public.rpc_verify_frozen_predictions_v4()',
  { value: true },
);

// =============================================================================
// V4-F. Assignments and independent reviews
// =============================================================================
const five = [1, 2, 3, 4, 5].map(H);
await step(
  'V4-ASG-01',
  'v4-setup',
  'assign the 5 frozen held-out cases to r1 (slot 1)',
  'inv',
  `select public.rpc_assign_cases('FORMAL','${R1}',1,${arr(five)},7)`,
  { value: 5 },
);
await step(
  'V4-ASG-02',
  'v4-setup',
  'assign the 5 frozen held-out cases to r2 (slot 2)',
  'inv',
  `select public.rpc_assign_cases('FORMAL','${R2}',2,${arr(five)},7)`,
  { value: 5 },
);
await step(
  'V4-ASG-03',
  'v4-integrity',
  'a withdrawn case without a held-out record cannot be assigned',
  'inv',
  `select public.rpc_assign_cases('FORMAL','${R1}',1,${arr([H(7)])},7)`,
  { error: /withdrawn|not a frozen held-out case|frozen sample manifest/ },
);
// one review submission (a second call on the same assignment before the close is a revision)
async function subm(who, p, c, body, idSuffix = '') {
  const a = await asg(p, c);
  return step(
    `V4-REV-${who}-${c}${idSuffix}`,
    'v4-workflow',
    `${who} submits ${c}${idSuffix ? ' (revision before close)' : ''}`,
    who,
    `select public.rpc_submit_review('${a}', '${body}'::jsonb)`,
    { minRows: 1 },
  );
}
await subm('r1', R1, H(1), '{"l1_decision":"EXCLUDE","l1_rationale":"synthetic"}');
await subm('r2', R2, H(1), '{"l1_decision":"INCLUDE","l1_rationale":"synthetic"}');
await subm('r1', R1, H(2), '{"l1_decision":"INCLUDE"}');
await subm('r2', R2, H(2), '{"l1_decision":"INCLUDE"}');
await subm('r1', R1, H(3), '{"l1_decision":"INCLUDE"}');
await subm(
  'r1',
  R1,
  H(3),
  '{"l1_decision":"EXCLUDE","l1_rationale":"synthetic revision"}',
  '-rev2',
);
await subm('r2', R2, H(3), '{"l1_decision":"EXCLUDE"}');
await subm('r1', R1, H(4), '{"l1_decision":"INCLUDE"}');
for (const [who, p, s1, tl, role] of [
  ['r1', R1, 'EXCLUDE', 'EXCLUDE', 'OUTCOME_ONLY'],
  ['r2', R2, 'EXCLUDE', 'INCLUDE', 'DISEASE_STUDIED'],
]) {
  await step(
    `V4-STEP1-${who}`,
    'v4-workflow',
    `${who} records Step 1 on the trial case`,
    who,
    `select public.rpc_record_trial_step1('${await asg(p, H(5))}', '{"step1_decision":"${s1}","step1_uncertain":false}'::jsonb)`,
    { minRows: 1 },
  );
  await subm(who, p, H(5), `{"l1_decision":"${tl}","l1_trial_role":"${role}"}`);
}
await step(
  'V4-BLIND-01',
  'v4-blinding',
  "r2 cannot read r1's held-out reviews",
  'r2',
  `select * from public.reviews where reviewer_pseudo_id <> '${R2}'`,
  { rows: 0 },
);
for (const t of [
  'design_activation_v4',
  'protocol_amendments_v4',
  'development_registry_v4',
  'case_records_v4',
  'frozen_predictions_v4',
  'freeze_manifests_v4',
  'judgment_snapshots_v4',
  'v_independent_judgments_v4',
  'v_adjudicated_reference_v4',
  'v_frozen_predictions_v4',
  'v_module_b_export_v4',
  'mb_unit_design_v4',
  'mb_manifest_v4',
]) {
  await step(
    `V4-BLIND-02-${t}`,
    'v4-blinding',
    `a formal reviewer reads ${t}: zero rows`,
    'r1',
    `select * from public.${t}`,
    { rows: 0 },
  );
}
await step(
  'V4-BLIND-03',
  'v4-blinding',
  'the reviewer queue shows the 5 held-out cases and no development or calibration ID',
  'r1',
  "select count(*)::int as n from public.v_my_queue where case_id ~ '^HO4-'",
  { value: 5 },
);
await step(
  'V4-BLIND-04',
  'v4-blinding',
  'no packet a reviewer can read carries a prediction, tier, provenance or design key (text scan)',
  'r1',
  'select case_id from public.case_versions where packet::text ~* \'"(tier[0-9a-z_]*|prediction[a-z_]*|provenance[a-z_]*|impact_tier|frame_unit_id|record_category|comparison_cell[a-z_0-9]*|selection_probability|sampling_weight|stratum)"\'',
  { rows: 0 },
);
await step(
  'V4-AUDIT-LEAK-01',
  'v4-interim',
  'the audit log holds the 2 FORMAL Step 1 records as identifiers and hashes only (FINDING-V4-01 fix)',
  'inv',
  "select count(*)::int as n from public.audit_log where entity_table = 'trial_step1_records' and mode = 'FORMAL' and details ? 'content_sha256' and not details ? 'step1_decision'",
  { value: 2 },
);
await step(
  'V4-AUDIT-LEAK-02',
  'v4-interim',
  'no audit row exposes a Step 1 decision or rationale while the formal phase is open',
  'inv',
  "select audit_id from public.audit_log where entity_table = 'trial_step1_records' and (details ? 'step1_decision' or details ? 'step1_rationale')",
  { rows: 0 },
);
await step(
  'V4-INT-01',
  'v4-interim',
  'the investigator reads no independent judgment while the formal phase is open',
  'inv',
  'select * from public.v_independent_judgments_v4',
  { rows: 0 },
);
await step(
  'V4-INT-02',
  'v4-interim',
  'the snapshot is refused while the formal phase is open',
  'inv',
  'select public.rpc_snapshot_judgments_v4()',
  { error: /after the formal phase closes/ },
);
await step(
  'V4-INT-03',
  'v4-interim',
  'the v4 lock is refused while the formal phase is open',
  'inv',
  `select public.rpc_lock_reference_v4('${ATT}')`,
  { error: /only after the formal phase is closed/ },
);

// =============================================================================
// V4-G. Close, snapshot, independent-judgment export
// =============================================================================
await step(
  'V4-CLOSE',
  'v4-setup',
  'close the formal phase as incomplete (one case has a single review)',
  'inv',
  `select public.rpc_close_formal_review(false, '${ATT}')`,
  { minRows: 1 },
);
await step(
  'V4-CLOSE-02',
  'v4-workflow',
  'no submission after the close',
  'r2',
  `select public.rpc_submit_review('${await asg(R2, H(4))}', '{"l1_decision":"INCLUDE"}'::jsonb)`,
  { error: /closed/ },
);
const rvIds = async (c) =>
  (
    await q(
      'select array_agg(review_id::text) as a from public.v_effective_reviews where case_id=$1',
      [c],
    )
  )[0].a || [];
const s1Ids = async (c) =>
  (
    await q(
      'select array_agg(step1_id::text) as a from public.trial_step1_records where case_id=$1',
      [c],
    )
  )[0].a || [];
const adjJson = (o) =>
  J(
    Object.assign(
      { status: 'DISCORDANT_RESOLVED', basis: 'REVIEWER_1', rationale: 'synthetic adjudication' },
      o,
    ),
  );
await step(
  'V4-ADJ-00',
  'v4-gate',
  'FORMAL adjudication is refused before the judgment snapshot',
  'adj',
  `select public.rpc_record_adjudication_v3('${adjJson({ case_id: H(1), decision: 'INCLUDE', basis: 'REVIEWER_2', considered_ids: await rvIds(H(1)), reason_code: 'CONSTRUCT_BOUNDARY' })}'::jsonb)`,
  { error: /snapshot/ },
);
await step(
  'V4-SNAP-00',
  'v4-roles',
  'a reviewer cannot take the snapshot',
  'r1',
  'select public.rpc_snapshot_judgments_v4()',
  { error: /investigator role/ },
);
await step(
  'V4-SNAP-01',
  'v4-snapshot',
  'investigator snapshots the independent judgments',
  'inv',
  'select public.rpc_snapshot_judgments_v4() as sid',
  { minRows: 1 },
);
await step(
  'V4-SNAP-02',
  'v4-snapshot',
  'a second snapshot is refused',
  'inv',
  'select public.rpc_snapshot_judgments_v4()',
  { error: /duplicate|unique/ },
);
await step(
  'V4-SNAP-03',
  'v4-snapshot',
  'the snapshot holds 11 judgment rows (4 descriptor cases: 7 rows; trial case: 2 Step 1 and 2 trial-level rows)',
  'inv',
  'select n_rows from public.judgment_snapshots_v4',
  { value: 11 },
);
await step(
  'V4-SNAP-04',
  'v4-snapshot',
  'the snapshot hash verifies against the current judgments',
  'inv',
  'select matches from public.rpc_verify_judgment_snapshot_v4()',
  { value: true },
);
await step(
  'V4-SNAP-04b',
  'v4-snapshot',
  'the formal phase cannot reopen after the snapshot',
  'inv',
  `select public.rpc_reopen_formal_review('AMD-SYN-1', '${ATT}')`,
  { error: /cannot reopen/ },
);
await step(
  'V4-SNAP-05',
  'v4-immutability',
  'the snapshot cannot be updated (owner role)',
  'owner',
  'update public.judgment_snapshots_v4 set n_rows = 0',
  { error: /append-only/ },
);
await step(
  'V4-JUDG-01',
  'v4-export',
  'after the close the investigator reads 11 independent judgments',
  'inv',
  'select * from public.v_independent_judgments_v4',
  { rows: 11 },
);
await step(
  'V4-JUDG-02',
  'v4-export',
  'the revised review keeps its initial answer: INCLUDE first, EXCLUDE effective, one revision',
  'inv',
  `select concat_ws('>', decision_initial, decision_effective_preclose, n_revisions_preclose) as v from public.v_independent_judgments_v4 where case_id='${H(3)}' and reviewer_slot=1`,
  { value: 'INCLUDE>EXCLUDE>1' },
);
await step(
  'V4-JUDG-03',
  'v4-export',
  'the judgment export carries no tier, prediction, design or adjudication column',
  'inv',
  "select column_name from information_schema.columns where table_schema='public' and table_name='v_independent_judgments_v4' and column_name ~* '(tier|predict|stratum|weight|probabil|adjudic|cell|provenance|frame_unit)'",
  { rows: 0 },
);
await step(
  'V4-JUDG-04',
  'v4-export',
  'the judgment view columns follow the export contract (JUDGMENT_COLUMNS without export_id)',
  'inv',
  "select string_agg(column_name, ',' order by ordinal_position) as v from information_schema.columns where table_schema='public' and table_name='v_independent_judgments_v4'",
  {
    value:
      'record_category,case_id,case_version,review_module,unit_type,unit_id,nct_id,descriptor_ui,descriptor_name,area,determination_level,reviewer_slot,reviewer_pseudo_id,decision_initial,decision_effective_preclose,n_revisions_preclose,uncertain,packet_issue_flag,first_submitted_at,last_submitted_at',
  },
);
await step(
  'V4-JUDG-05',
  'v4-integrity',
  'the judgment export holds held-out IDs only (no SYN-, DEV4-, CAL4-, withdrawn or legacy case)',
  'inv',
  `select case_id from public.v_independent_judgments_v4 where case_id !~ '^HO4R?-' or case_id in ('${H(6)}', '${H(7)}', 'HO4R-TESTFX-001')`,
  { rows: 0 },
);

// =============================================================================
// V4-H. Blinded adjudication under the DISAGREEMENTS_ONLY scope; the v4 lock
// =============================================================================
await step(
  'V4-ADJ-01',
  'v4-scope',
  'a concordant case level cannot be adjudicated under DISAGREEMENTS_ONLY (it enters by rule)',
  'adj',
  `select public.rpc_record_adjudication_v3('${adjJson({ case_id: H(2), decision: 'INCLUDE', status: 'CONCORDANT_CONFIRMED', basis: 'BOTH_REVIEWERS', considered_ids: await rvIds(H(2)) })}'::jsonb)`,
  { error: /DISAGREEMENTS_ONLY/ },
);
await step(
  'V4-ADJ-02',
  'v4-scope',
  'a discordant case level cannot take a concordant status',
  'adj',
  `select public.rpc_record_adjudication_v3('${adjJson({ case_id: H(1), decision: 'INCLUDE', status: 'CONCORDANT_CONFIRMED', basis: 'BOTH_REVIEWERS', considered_ids: await rvIds(H(1)) })}'::jsonb)`,
  { error: /disagree/ },
);
await step(
  'V4-ADJ-03',
  'v4-scope',
  'a discordant case level needs a disagreement reason code',
  'adj',
  `select public.rpc_record_adjudication_v3('${adjJson({ case_id: H(1), decision: 'INCLUDE', basis: 'REVIEWER_2', considered_ids: await rvIds(H(1)) })}'::jsonb)`,
  { error: /reason code/ },
);
await step(
  'V4-ADJ-04',
  'v4-scope',
  'the adjudicator resolves the discordant descriptor case',
  'adj',
  `select public.rpc_record_adjudication_v3('${adjJson({ case_id: H(1), decision: 'INCLUDE', basis: 'REVIEWER_2', considered_ids: await rvIds(H(1)), reason_code: 'CONSTRUCT_BOUNDARY' })}'::jsonb)`,
  { minRows: 1 },
);
await step(
  'V4-ADJ-05',
  'v4-scope',
  'a single-reviewed case level cannot be DISCORDANT_RESOLVED',
  'adj',
  `select public.rpc_record_adjudication_v3('${adjJson({ case_id: H(4), decision: 'INCLUDE', considered_ids: await rvIds(H(4)), reason_code: 'CONSTRUCT_BOUNDARY' })}'::jsonb)`,
  { error: /single-reviewed/ },
);
await step(
  'V4-ADJ-06',
  'v4-scope',
  'the adjudicator records SINGLE_REVIEW_ADJUDICATED for the single-reviewed case',
  'adj',
  `select public.rpc_record_adjudication_v3('${adjJson({ case_id: H(4), decision: 'INCLUDE', status: 'SINGLE_REVIEW_ADJUDICATED', considered_ids: await rvIds(H(4)) })}'::jsonb)`,
  { minRows: 1 },
);
await step(
  'V4-ADJ-07',
  'v4-scope',
  'the concordant Step 1 level of the trial case cannot be adjudicated (by rule)',
  'adj',
  `select public.rpc_record_adjudication_v3('${adjJson({ case_id: H(5), determination_level: 'DESCRIPTOR_LEVEL_IN_TRIAL_CASE', decision: 'EXCLUDE', status: 'CONCORDANT_CONFIRMED', basis: 'BOTH_REVIEWERS', considered_ids: await s1Ids(H(5)) })}'::jsonb)`,
  { error: /DISAGREEMENTS_ONLY/ },
);
await step(
  'V4-LOCK-00',
  'v4-scope',
  'the v4 lock is refused while a discordant level lacks an adjudication',
  'inv',
  `select public.rpc_lock_reference_v4('${ATT}')`,
  { error: /have no adjudication/ },
);
await step(
  'V4-ADJ-08',
  'v4-scope',
  'the adjudicator resolves the discordant trial level',
  'adj',
  `select public.rpc_record_adjudication_v3('${adjJson({ case_id: H(5), determination_level: 'TRIAL_LEVEL', decision: 'INCLUDE', basis: 'REVIEWER_2', considered_ids: await rvIds(H(5)), reason_code: 'TRIAL_CONTEXT' })}'::jsonb)`,
  { minRows: 1 },
);
for (const t of [
  'frozen_predictions_v4',
  'case_records_v4',
  'development_registry_v4',
  'freeze_manifests_v4',
  'judgment_snapshots_v4',
  'v_frozen_predictions_v4',
  'v_independent_judgments_v4',
  'v_adjudicated_reference_v4',
  'calibration_cases_v4',
]) {
  await step(
    `V4-ADJ-BLIND-${t}`,
    'v4-blinding',
    `the adjudicator reads ${t}: zero rows`,
    'adj',
    `select * from public.${t}`,
    { rows: 0 },
  );
}
await step(
  'V4-ADJ-09',
  'v4-provenance',
  'every FORMAL adjudication is by the ADJUDICATOR, blinded, not exposed to index labels',
  'inv',
  "select bool_and(adjudication_blinded and not adjudicator_exposed_to_index_labels and adjudicator_role = 'ADJUDICATOR') as v from public.adjudications where mode='FORMAL'",
  { value: true },
);
await step(
  'V4-LOCK-01',
  'v4-gate',
  'the v3 lock is refused for Module A once v4 is active',
  'inv',
  `select public.rpc_lock_reference('ONTOLOGY_AREA', '${ATT}')`,
  { error: /rpc_lock_reference_v4/ },
);
await step(
  'V4-LOCK-02',
  'v4-roles',
  'a reviewer cannot lock the v4 reference',
  'r1',
  `select public.rpc_lock_reference_v4('${ATT}')`,
  { error: /investigator role/ },
);
await step(
  'V4-LOCK-03',
  'v4-roles',
  'the adjudicator cannot lock the v4 reference',
  'adj',
  `select public.rpc_lock_reference_v4('${ATT}')`,
  { error: /investigator role/ },
);
await step(
  'V4-EXP-00',
  'v4-gate',
  'before the lock the reference and prediction views are empty, even for the investigator',
  'inv',
  'select ((select count(*) from public.v_adjudicated_reference_v4) + (select count(*) from public.v_frozen_predictions_v4))::int as n',
  { value: 0 },
);
await step(
  'V4-LOCK-04',
  'v4-gate',
  'investigator locks the Module A reference (v4)',
  'inv',
  `select public.rpc_lock_reference_v4('${ATT}') as lid`,
  { minRows: 1 },
);
await step(
  'V4-LOCK-05',
  'v4-gate',
  'the lock counts the 6 answered case levels',
  'inv',
  "select n_case_levels_locked from public.reference_locks where review_module='ONTOLOGY_AREA'",
  { value: 6 },
);
await step(
  'V4-LOCK-06',
  'v4-gate',
  'a second v4 lock is refused',
  'inv',
  `select public.rpc_lock_reference_v4('${ATT}')`,
  { error: /duplicate|unique/ },
);

// =============================================================================
// V4-I. Export views after the lock
// =============================================================================
await step(
  'V4-EXP-01',
  'v4-export',
  'the adjudicated reference has one row per answered case level (6)',
  'inv',
  'select * from public.v_adjudicated_reference_v4',
  { rows: 6 },
);
await step(
  'V4-EXP-02',
  'v4-export',
  'the concordant descriptor case enters by rule (RULE, CONCORDANCE_RULE, shared answer, BOTH_REVIEWERS)',
  'inv',
  `select concat_ws('|', adjudication_status, adjudicator_pseudo_id, adjudicator_role, adjudicated_decision, adjudication_basis) as v from public.v_adjudicated_reference_v4 where case_id='${H(2)}'`,
  { value: 'CONCORDANT_ADOPTED_BY_RULE|RULE|CONCORDANCE_RULE|INCLUDE|BOTH_REVIEWERS' },
);
await step(
  'V4-EXP-03',
  'v4-export',
  'the concordant Step 1 level enters by rule with the shared EXCLUDE',
  'inv',
  `select concat_ws('|', adjudication_status, adjudicated_decision) as v from public.v_adjudicated_reference_v4 where case_id='${H(5)}' and determination_level='DESCRIPTOR_LEVEL_IN_TRIAL_CASE'`,
  { value: 'CONCORDANT_ADOPTED_BY_RULE|EXCLUDE' },
);
await step(
  'V4-EXP-04',
  'v4-export',
  'an adjudicated level carries an ADJ4- reference, an A- pseudonym, role ADJUDICATOR and the blinding flags',
  'inv',
  `select (adjudication_id like 'ADJ4-%' and adjudicator_pseudo_id like 'A-%' and adjudicator_role = 'ADJUDICATOR' and adjudication_blinded and not adjudicator_exposed_to_index_labels) as v from public.v_adjudicated_reference_v4 where case_id='${H(1)}'`,
  { value: true },
);
await step(
  'V4-EXP-05',
  'v4-export',
  'the single-reviewed case carries SINGLE_REVIEW_ADJUDICATED',
  'inv',
  `select adjudication_status from public.v_adjudicated_reference_v4 where case_id='${H(4)}'`,
  { value: 'SINGLE_REVIEW_ADJUDICATED' },
);
await step(
  'V4-EXP-06',
  'v4-export',
  'every reference row falls between the close and the lock (rule rows carry the lock time)',
  'inv',
  `select bool_and(r.adjudicated_at >= (select max(e.occurred_at) from public.review_phase_events e) and r.adjudicated_at <= l.locked_at) as v
   from public.v_adjudicated_reference_v4 r join public.reference_locks l on l.lock_id = r.reference_lock_id`,
  { value: true },
);
await step(
  'V4-EXP-07',
  'v4-export',
  'the prediction view has 6 rows, all NO_DEVELOPMENT_FLAG, weight x probability = 1',
  'inv',
  "select (count(*) = 6 and bool_and(provenance_audit_result = 'NO_DEVELOPMENT_FLAG') and bool_and(abs(sampling_weight * selection_probability - 1) < 1e-9)) as v from public.v_frozen_predictions_v4",
  { value: true },
);
await step(
  'V4-EXP-08',
  'v4-export',
  'every prediction was recorded before the freeze',
  'inv',
  'select bool_and(p.prediction_frozen_at <= f.frozen_at) as v from public.v_frozen_predictions_v4 p cross join public.freeze_manifests_v4 f',
  { value: true },
);
await step(
  'V4-EXP-09',
  'v4-integrity',
  'no export view holds a non-held-out, withdrawn, calibration or Module B ID',
  'inv',
  `select x.case_id from (select case_id from public.v_independent_judgments_v4 union all select case_id from public.v_adjudicated_reference_v4
     union all select case_id from public.v_frozen_predictions_v4) x where x.case_id !~ '^HO4R?-' or x.case_id in ('${H(6)}', '${H(7)}', 'HO4R-TESTFX-001')`,
  { rows: 0 },
);
await step(
  'V4-EXP-10',
  'v4-export',
  'the three views hold the same case x level pairs',
  'inv',
  `with a as (select distinct case_id, determination_level from public.v_independent_judgments_v4),
        b as (select case_id, determination_level from public.v_adjudicated_reference_v4),
        c as (select case_id, determination_level from public.v_frozen_predictions_v4)
   select ((select count(*) from (select * from a except select * from b) s) + (select count(*) from (select * from b except select * from a) s)
         + (select count(*) from (select * from b except select * from c) s) + (select count(*) from (select * from c except select * from b) s))::int as n`,
  { value: 0 },
);
await step(
  'V4-EXP-11',
  'v4-export',
  'the prediction view columns follow the export contract (PREDICTION_COLUMNS)',
  'inv',
  "select string_agg(column_name, ',' order by ordinal_position) as v from information_schema.columns where table_schema='public' and table_name='v_frozen_predictions_v4'",
  {
    value:
      'prediction_set_id,record_category,case_id,frame_unit_id,unit_type,unit_id,nct_id,descriptor_ui,area,determination_level,tier0_binary,tier1_version,tier1_status_raw,tier1_binary,stage_c_trial_status,prediction_frozen_at,selection_stratum,variance_stratum,variance_stratum_size,selection_probability,sampling_weight,comparison_cell,impact_tier,policy_governed_neoplasm_GEN06,provenance_audit_result',
  },
);
await step(
  'V4-EXP-12',
  'v4-export',
  'the reference view columns follow the export contract (ADJUDICATION_COLUMNS without export_id)',
  'inv',
  "select string_agg(column_name, ',' order by ordinal_position) as v from information_schema.columns where table_schema='public' and table_name='v_adjudicated_reference_v4'",
  {
    value:
      'case_id,record_category,determination_level,adjudication_id,adjudicated_decision,adjudication_status,adjudication_basis,disagreement_reason_code,adjudicator_pseudo_id,adjudicator_role,adjudication_blinded,adjudicator_exposed_to_index_labels,post_unblinding_revision_exists,adjudicated_at,reference_lock_id',
  },
);
for (const who of ['r1', 'adj']) {
  await step(
    `V4-EXP-13-${who}`,
    'v4-blinding',
    `${who} reads no export view row after the lock`,
    who,
    'select ((select count(*) from public.v_independent_judgments_v4) + (select count(*) from public.v_adjudicated_reference_v4) + (select count(*) from public.v_frozen_predictions_v4))::int as n',
    { value: 0 },
  );
}
const curAdj = async (c) =>
  (
    await q(
      "select adjudication_id from public.v_effective_adjudications where case_id=$1 and determination_level='DESCRIPTOR_LEVEL'",
      [c],
    )
  )[0].adjudication_id;
await step(
  'V4-POST-01',
  'v4-provenance',
  'a post-lock adjudication on the discordant case is stored as a post-unblinding revision',
  'inv',
  `select public.rpc_record_adjudication_v3('${adjJson({ case_id: H(1), decision: 'EXCLUDE', basis: 'REVIEWER_1', considered_ids: await rvIds(H(1)), reason_code: 'CONSTRUCT_BOUNDARY', supersedes: await curAdj(H(1)) })}'::jsonb)`,
  { minRows: 1 },
);
await step(
  'V4-POST-02',
  'v4-provenance',
  'the primary reference keeps the blinded pre-lock decision and flags the revision',
  'inv',
  `select concat_ws('|', adjudicated_decision, post_unblinding_revision_exists::text) as v from public.v_adjudicated_reference_v4 where case_id='${H(1)}'`,
  { value: 'INCLUDE|true' },
);
await step(
  'V4-POST-03',
  'v4-provenance',
  'after the lock a concordant level may take a post-unblinding revision; the reference stays by rule',
  'inv',
  `select public.rpc_record_adjudication_v3('${adjJson({ case_id: H(2), decision: 'EXCLUDE', status: 'CONCORDANT_REVISED', basis: 'NEITHER', considered_ids: await rvIds(H(2)) })}'::jsonb)`,
  { minRows: 1 },
);
await step(
  'V4-POST-04',
  'v4-provenance',
  'the concordant case reference is unchanged and flags the post-unblinding revision',
  'inv',
  `select concat_ws('|', adjudication_status, adjudicated_decision, post_unblinding_revision_exists::text) as v from public.v_adjudicated_reference_v4 where case_id='${H(2)}'`,
  { value: 'CONCORDANT_ADOPTED_BY_RULE|INCLUDE|true' },
);
await step(
  'V4-POST-05',
  'v4-snapshot',
  'the judgment snapshot still verifies after adjudication and the lock',
  'inv',
  'select matches from public.rpc_verify_judgment_snapshot_v4()',
  { value: true },
);
await step(
  'V4-POST-06',
  'v4-predictions',
  'the frozen predictions still verify at export time',
  'inv',
  'select matches from public.rpc_verify_frozen_predictions_v4()',
  { value: true },
);

// =============================================================================
// V4-J. Module B (own tables, phase, adjudication, lock, export)
// =============================================================================
const rowPacket = (id) => ({
  schema_version: '1.0',
  unit: { unit_type: 'CONDITION_ROW_BENCHMARK', unit_id: id },
  question: 'Is the benchmark population compatible with the condition row?',
  row: { condition_row: 'Synthetic condition row A', area: 'infectious' },
  benchmark_definition: {
    source: 'Synthetic registry (fictional)',
    population: 'Synthetic adults',
    case_definition: 'SYNTHETIC TEXT',
    calendar_period: '2015 to 2019',
    age_range: '18 and older',
    age_strata: ['18 to 44', '45 to 64', '65 and older'],
  },
  notices: ['SYNTHETIC UNIT: excluded from all statistics'],
});
const trialMbPacket = (id) => ({
  schema_version: '1.0',
  unit: { unit_type: 'TRIAL_ELIGIBILITY', unit_id: id },
  question: 'Does the trial belong to the condition row?',
  row: { condition_row: 'Synthetic condition row A' },
  trial: {
    brief_title: 'Synthetic trial (fictional)',
    conditions: ['Synthetic condition'],
    eligibility_criteria: 'SYNTHETIC TEXT',
    primary_purpose: 'TREATMENT',
    phase: 'PHASE3',
    countries: ['Synthetic country'],
  },
  notices: ['SYNTHETIC UNIT'],
});
const mbDesign = (row, stratum, extra = {}) =>
  Object.assign(
    {
      row_id: row,
      stratum,
      frame_n: 10,
      selection_probability: 0.5,
      pipeline_status_provisional: 'RULE_C',
      benchmark_id: 'SYN-BM-A',
    },
    extra,
  );
const mbJson = (id, type, packet, design) => J({ mb_unit_id: id, unit_type: type, packet, design });
const MBR = 'MB4-ROW-TESTFX_A',
  MBT1 = 'MB4-T-TESTFX-001',
  MBT2 = 'MB4-T-TESTFX-002';
await step(
  'V4-MB-00',
  'mb-roles',
  'a reviewer cannot import a Module B unit',
  'r1',
  `select public.rpc_import_mb_unit_v4('${mbJson(MBR, 'CONDITION_ROW_BENCHMARK', rowPacket(MBR), mbDesign('SYN_ROW_A', 'ROW_C', { selection_probability: 1 }))}'::jsonb)`,
  { error: /investigator role/ },
);
await step(
  'V4-MB-01',
  'mb-setup',
  'import a condition-row benchmark unit',
  'inv',
  `select public.rpc_import_mb_unit_v4('${mbJson(MBR, 'CONDITION_ROW_BENCHMARK', rowPacket(MBR), mbDesign('SYN_ROW_A', 'ROW_C', { selection_probability: 1 }))}'::jsonb)`,
  { value: MBR },
);
await step(
  'V4-MB-02',
  'mb-blinding',
  'a packet carrying a benchmark value is refused',
  'inv',
  `select public.rpc_import_mb_unit_v4('${mbJson('MB4-ROW-TESTFX_B', 'CONDITION_ROW_BENCHMARK', Object.assign(rowPacket('MB4-ROW-TESTFX_B'), { benchmark_definition: { source: 'x', value: 0.52 } }), mbDesign('SYN_ROW_B', 'ROW_C'))}'::jsonb)`,
  { error: /could carry blinded content/ },
);
await step(
  'V4-MB-03',
  'mb-blinding',
  'a packet carrying a participant count is refused',
  'inv',
  `select public.rpc_import_mb_unit_v4('${mbJson('MB4-T-TESTFX-009', 'TRIAL_ELIGIBILITY', Object.assign(trialMbPacket('MB4-T-TESTFX-009'), { trial: { brief_title: 'x', enrollment: 120 } }), mbDesign('SYN_ROW_A', 'TRIAL_S', { nct_id: 'SYN-NCT-0009' }))}'::jsonb)`,
  { error: /could carry blinded content/ },
);
await step(
  'V4-MB-04',
  'mb-blinding',
  'a packet carrying a female share is refused',
  'inv',
  `select public.rpc_import_mb_unit_v4('${mbJson('MB4-T-TESTFX-008', 'TRIAL_ELIGIBILITY', Object.assign(trialMbPacket('MB4-T-TESTFX-008'), { trial: { brief_title: 'x', female_share: 0.4 } }), mbDesign('SYN_ROW_A', 'TRIAL_S', { nct_id: 'SYN-NCT-0008' }))}'::jsonb)`,
  { error: /could carry blinded content/ },
);
await step(
  'V4-MB-05',
  'mb-blinding',
  'a packet with a top-level key off the allow list is refused',
  'inv',
  `select public.rpc_import_mb_unit_v4('${mbJson('MB4-ROW-TESTFX_C', 'CONDITION_ROW_BENCHMARK', Object.assign(rowPacket('MB4-ROW-TESTFX_C'), { benchmark: { source: 'x' } }), mbDesign('SYN_ROW_C', 'ROW_C'))}'::jsonb)`,
  { error: /allow list/ },
);
await step(
  'V4-MB-06',
  'mb-blinding',
  'a packet carrying the pipeline status is refused',
  'inv',
  `select public.rpc_import_mb_unit_v4('${mbJson('MB4-ROW-TESTFX_D', 'CONDITION_ROW_BENCHMARK', Object.assign(rowPacket('MB4-ROW-TESTFX_D'), { row: { condition_row: 'x', pipeline_status: 'RULE_C' } }), mbDesign('SYN_ROW_D', 'ROW_C'))}'::jsonb)`,
  { error: /could carry blinded content/ },
);
await step(
  'V4-MB-07',
  'mb-categories',
  'a row ID with a trial unit type is refused',
  'inv',
  `select public.rpc_import_mb_unit_v4('${mbJson('MB4-ROW-TESTFX_E', 'TRIAL_ELIGIBILITY', trialMbPacket('MB4-ROW-TESTFX_E'), mbDesign('SYN_ROW_E', 'ROW_C'))}'::jsonb)`,
  { error: /check constraint|violates/ },
);
await step(
  'V4-MB-08',
  'mb-categories',
  'a Module B unit ID without the MB4- prefix is refused',
  'inv',
  `select public.rpc_import_mb_unit_v4('${mbJson('HO4-TESTFX-MB', 'TRIAL_ELIGIBILITY', trialMbPacket('HO4-TESTFX-MB'), mbDesign('SYN_ROW_A', 'TRIAL_S'))}'::jsonb)`,
  { error: /check constraint|violates/ },
);
await step(
  'V4-MB-09',
  'mb-setup',
  'import trial-eligibility unit 1 (registration fields, including countries, are allowed)',
  'inv',
  `select public.rpc_import_mb_unit_v4('${mbJson(MBT1, 'TRIAL_ELIGIBILITY', trialMbPacket(MBT1), mbDesign('SYN_ROW_A', 'TRIAL_S', { nct_id: 'SYN-NCT-0101' }))}'::jsonb)`,
  { value: MBT1 },
);
await step(
  'V4-MB-10',
  'mb-setup',
  'import trial-eligibility unit 2',
  'inv',
  `select public.rpc_import_mb_unit_v4('${mbJson(MBT2, 'TRIAL_ELIGIBILITY', trialMbPacket(MBT2), mbDesign('SYN_ROW_A', 'TRIAL_S', { nct_id: 'SYN-NCT-0102' }))}'::jsonb)`,
  { value: MBT2 },
);
await step(
  'V4-MB-11',
  'mb-gate',
  'Module B assignment is refused before its sample is frozen',
  'inv',
  `select public.rpc_assign_mb_units_v4('${R1}', 1, ${arr([MBR])}, 5)`,
  { error: /freeze the Module B sample/ },
);
await step(
  'V4-MB-12',
  'mb-gate',
  'Module B cannot open before its sample is frozen',
  'inv',
  `select public.rpc_mb_phase_v4('MB_OPENED', '${ATT}')`,
  { error: /after its sample is frozen/ },
);
await step(
  'V4-MB-13',
  'mb-setup',
  'freeze the Module B sample',
  'inv',
  `select public.rpc_freeze_mb_manifest_v4('${ATT}')`,
  { minRows: 1 },
);
await step(
  'V4-MB-14',
  'mb-gate',
  'no Module B unit can be added after its freeze',
  'inv',
  `select public.rpc_import_mb_unit_v4('${mbJson('MB4-T-TESTFX-003', 'TRIAL_ELIGIBILITY', trialMbPacket('MB4-T-TESTFX-003'), mbDesign('SYN_ROW_A', 'TRIAL_S', { nct_id: 'SYN-NCT-0103' }))}'::jsonb)`,
  { error: /Module B sample is frozen/ },
);
await step(
  'V4-MB-15',
  'mb-freeze',
  'the Module B unit-list hash equals SHA-256 of the sorted, LF-joined unit IDs',
  'inv',
  `select unit_list_sha256 = '${sha256([MBR, MBT1, MBT2].sort().join('\n'))}' as v from public.mb_manifest_v4`,
  { value: true },
);
await step(
  'V4-MB-16',
  'mb-gate',
  'Module B assignment is refused before the Module B phase opens',
  'inv',
  `select public.rpc_assign_mb_units_v4('${R1}', 1, ${arr([MBR])}, 5)`,
  { error: /phase open/ },
);
await step(
  'V4-MB-17',
  'mb-setup',
  'open the Module B phase',
  'inv',
  `select public.rpc_mb_phase_v4('MB_OPENED', '${ATT}')`,
  { minRows: 1 },
);
await step(
  'V4-MB-18',
  'mb-roles',
  'Module B units cannot go to a pilot test account',
  'inv',
  `select public.rpc_assign_mb_units_v4('${PT1}', 1, ${arr([MBR])}, 5)`,
  { error: /active FORMAL reviewers only/ },
);
await step(
  'V4-MB-19',
  'mb-setup',
  'assign the 3 Module B units to r1 (slot 1)',
  'inv',
  `select public.rpc_assign_mb_units_v4('${R1}', 1, ${arr([MBR, MBT1, MBT2])}, 5)`,
  { value: 3 },
);
await step(
  'V4-MB-20',
  'mb-setup',
  'assign 2 Module B units to r2 (slot 2)',
  'inv',
  `select public.rpc_assign_mb_units_v4('${R2}', 2, ${arr([MBR, MBT1])}, 5)`,
  { value: 2 },
);
await step(
  'V4-MB-21a',
  'mb-blinding',
  'r1 reads its 3 assigned units',
  'r1',
  'select * from public.mb_units_v4',
  { rows: 3 },
);
await step(
  'V4-MB-21b',
  'mb-blinding',
  'r2 reads its 2 assigned units',
  'r2',
  'select * from public.mb_units_v4',
  { rows: 2 },
);
await step(
  'V4-MB-21c',
  'mb-blinding',
  'the adjudicator reads no unit while Module B is open',
  'adj',
  'select * from public.mb_units_v4',
  { rows: 0 },
);
await step(
  'V4-MB-21d',
  'mb-blinding',
  'a pilot account reads no Module B unit',
  'pt1',
  'select * from public.mb_units_v4',
  { rows: 0 },
);
await step(
  'V4-MB-22',
  'mb-blinding',
  'a reviewer reads no Module B design row (no weight or pipeline status)',
  'r1',
  'select * from public.mb_unit_design_v4',
  { rows: 0 },
);
const mbasg = async (p, u) =>
  (
    await q(
      'select mb_assignment_id from public.mb_assignments_v4 where reviewer_pseudo_id=$1 and mb_unit_id=$2',
      [p, u],
    )
  )[0].mb_assignment_id;
const mbsub = async (id, who, p, u, body, expect) =>
  step(
    id,
    'mb-workflow',
    `${who} answers ${u}: ${body}`,
    who,
    `select public.rpc_submit_mb_response_v4('${await mbasg(p, u)}', '${body}'::jsonb)`,
    expect,
  );
await mbsub('V4-MB-23', 'r1', R1, MBT1, '{"eligibility":"EXCLUDE","rationale":"synthetic"}', {
  error: /check constraint|violates/,
});
await mbsub(
  'V4-MB-24',
  'r1',
  R1,
  MBT1,
  '{"eligibility":"INCLUDE","exclusion_reason":"WRONG_CONDITION"}',
  { error: /check constraint|violates/ },
);
await mbsub(
  'V4-MB-25',
  'r1',
  R1,
  MBR,
  '{"compatibility":"COMPATIBLE_WITH_CAVEAT","rationale":"synthetic"}',
  { error: /check constraint|violates/ },
);
await mbsub('V4-MB-26', 'r1', R1, MBT1, '{"compatibility":"COMPATIBLE"}', {
  error: /row units take a compatibility answer/,
});
await mbsub('V4-MB-27', 'r1', R1, MBR, '{"compatibility":"NOT_ESTIMABLE"}', {
  error: /check constraint|violates/,
});
await mbsub(
  'V4-MB-28',
  'r2',
  R2,
  MBR,
  '{"compatibility":"COMPATIBLE","caveat_codes":["NOT_A_CODE"]}',
  { error: /check constraint|violates/ },
);
await mbsub('V4-MB-29a', 'r1', R1, MBR, '{"compatibility":"COMPATIBLE"}', { minRows: 1 });
await mbsub('V4-MB-29b', 'r2', R2, MBR, '{"compatibility":"COMPATIBLE"}', { minRows: 1 });
await mbsub('V4-MB-29c', 'r1', R1, MBT1, '{"eligibility":"INCLUDE"}', { minRows: 1 });
await mbsub(
  'V4-MB-29d',
  'r2',
  R2,
  MBT1,
  '{"eligibility":"EXCLUDE","exclusion_reason":"WRONG_SUBTYPE","rationale":"synthetic"}',
  { minRows: 1 },
);
await mbsub(
  'V4-MB-29e',
  'r1',
  R1,
  MBT2,
  '{"eligibility":"UNRESOLVED","rationale":"synthetic","uncertain":true}',
  { minRows: 1 },
);
await step(
  'V4-MB-30',
  'mb-roles',
  'r2 cannot answer on an r1 Module B assignment',
  'r2',
  `select public.rpc_submit_mb_response_v4('${await mbasg(R1, MBT2)}', '{"eligibility":"INCLUDE"}'::jsonb)`,
  { error: /not your Module B assignment/ },
);
await step(
  'V4-MB-31',
  'mb-blinding',
  'r2 reads only their own 2 Module B responses',
  'r2',
  'select * from public.mb_responses_v4',
  { rows: 2 },
);
await step(
  'V4-AUDIT-LEAK-03',
  'mb-interim',
  'no audit row exposes a Module B answer while Module B is open',
  'inv',
  "select audit_id from public.audit_log where entity_table = 'mb_responses_v4' and (details ? 'compatibility' or details ? 'eligibility' or details ? 'rationale' or details ? 'exclusion_reason')",
  { rows: 0 },
);
await step(
  'V4-AUDIT-LEAK-04',
  'mb-interim',
  'the 5 Module B responses are in the audit log as identifiers and hashes',
  'inv',
  "select count(*)::int as n from public.audit_log where entity_table = 'mb_responses_v4' and details ? 'content_sha256'",
  { value: 5 },
);
await step(
  'V4-MB-32',
  'mb-interim',
  'the investigator reads no Module B response while Module B is open',
  'inv',
  'select * from public.mb_responses_v4',
  { rows: 0 },
);
await step(
  'V4-MB-33',
  'mb-gate',
  'Module B adjudication is refused while Module B is open',
  'adj',
  `select public.rpc_record_mb_adjudication_v4('${J({ mb_unit_id: MBT1, decision: 'INCLUDE', status: 'DISCORDANT_RESOLVED', basis: 'REVIEWER_1', rationale: 'synthetic' })}'::jsonb)`,
  { error: /only after the Module B phase closes/ },
);
await step(
  'V4-MB-34',
  'mb-setup',
  'close the Module B phase',
  'inv',
  `select public.rpc_mb_phase_v4('MB_CLOSED', '${ATT}')`,
  { minRows: 1 },
);
await mbsub('V4-MB-35', 'r2', R2, MBT1, '{"eligibility":"INCLUDE"}', {
  error: /not open for responses/,
});
await step(
  'V4-MB-36',
  'mb-scope',
  'a concordant Module B unit enters by rule and cannot be adjudicated',
  'adj',
  `select public.rpc_record_mb_adjudication_v4('${J({ mb_unit_id: MBR, decision: 'COMPATIBLE', status: 'DISCORDANT_RESOLVED', basis: 'REVIEWER_1', rationale: 'synthetic' })}'::jsonb)`,
  { error: /enters the Module B reference by rule/ },
);
await step(
  'V4-MB-37',
  'mb-scope',
  'a twice-reviewed unit cannot be SINGLE_REVIEW_ADJUDICATED',
  'adj',
  `select public.rpc_record_mb_adjudication_v4('${J({ mb_unit_id: MBT1, decision: 'INCLUDE', status: 'SINGLE_REVIEW_ADJUDICATED', basis: 'REVIEWER_1', rationale: 'synthetic' })}'::jsonb)`,
  { error: /reviewed twice/ },
);
await step(
  'V4-MB-38',
  'mb-scope',
  'a trial unit cannot take a compatibility decision',
  'adj',
  `select public.rpc_record_mb_adjudication_v4('${J({ mb_unit_id: MBT1, decision: 'COMPATIBLE', status: 'DISCORDANT_RESOLVED', basis: 'REVIEWER_1', rationale: 'synthetic' })}'::jsonb)`,
  { error: /does not fit/ },
);
await step(
  'V4-MB-39',
  'mb-roles',
  'a reviewer cannot adjudicate Module B',
  'r1',
  `select public.rpc_record_mb_adjudication_v4('${J({ mb_unit_id: MBT1, decision: 'INCLUDE', status: 'DISCORDANT_RESOLVED', basis: 'REVIEWER_1', rationale: 'synthetic' })}'::jsonb)`,
  { error: /ADJUDICATOR role is needed/ },
);
await step(
  'V4-MB-40',
  'mb-workflow',
  'the adjudicator resolves the discordant trial unit',
  'adj',
  `select public.rpc_record_mb_adjudication_v4('${J({ mb_unit_id: MBT1, decision: 'INCLUDE', status: 'DISCORDANT_RESOLVED', basis: 'REVIEWER_1', rationale: 'synthetic' })}'::jsonb)`,
  { minRows: 1 },
);
await step(
  'V4-MB-41',
  'mb-gate',
  'the Module B lock is refused while the single-reviewed unit lacks an adjudication',
  'inv',
  `select public.rpc_lock_mb_reference_v4('${ATT}')`,
  { error: /need adjudication have none/ },
);
await step(
  'V4-MB-42',
  'mb-workflow',
  'the adjudicator records the single-reviewed unit',
  'adj',
  `select public.rpc_record_mb_adjudication_v4('${J({ mb_unit_id: MBT2, decision: 'EXCLUDE', status: 'SINGLE_REVIEW_ADJUDICATED', basis: 'NEITHER', rationale: 'synthetic' })}'::jsonb)`,
  { minRows: 1 },
);
await step(
  'V4-MB-43',
  'mb-roles',
  'a reviewer cannot lock the Module B reference',
  'r1',
  `select public.rpc_lock_mb_reference_v4('${ATT}')`,
  { error: /investigator role/ },
);
await step(
  'V4-MB-44',
  'mb-gate',
  'investigator locks the Module B reference',
  'inv',
  `select public.rpc_lock_mb_reference_v4('${ATT}')`,
  { minRows: 1 },
);
await step(
  'V4-MB-45',
  'mb-gate',
  'Module B adjudication after the lock is refused',
  'adj',
  `select public.rpc_record_mb_adjudication_v4('${J({ mb_unit_id: MBR, decision: 'COMPATIBLE', status: 'UNRESOLVED_ESCALATED', basis: 'NONE', rationale: 'synthetic' })}'::jsonb)`,
  { error: /reference is locked|check constraint|violates/ },
);
await step(
  'V4-MB-46',
  'mb-export',
  'the Module B export has one row per unit (3)',
  'inv',
  'select * from public.v_module_b_export_v4',
  { rows: 3 },
);
await step(
  'V4-MB-47',
  'mb-export',
  'the concordant row unit enters by rule',
  'inv',
  `select concat_ws('|', reference_answer, reference_status) as v from public.v_module_b_export_v4 where mb_unit_id='${MBR}'`,
  { value: 'COMPATIBLE|CONCORDANT_ADOPTED_BY_RULE' },
);
await step(
  'V4-MB-48',
  'mb-export',
  'the adjudicated trial unit carries the adjudicator decision, role and no pipeline exposure',
  'inv',
  `select concat_ws('|', reference_answer, reference_status, adjudicator_role, adjudicator_exposed_to_pipeline_status::text) as v from public.v_module_b_export_v4 where mb_unit_id='${MBT1}'`,
  { value: 'INCLUDE|DISCORDANT_RESOLVED|ADJUDICATOR|false' },
);
for (const who of ['r1', 'adj']) {
  await step(
    `V4-MB-49-${who}`,
    'mb-blinding',
    `${who} reads no Module B export row`,
    who,
    'select * from public.v_module_b_export_v4',
    { rows: 0 },
  );
}
await step(
  'V4-MB-50',
  'mb-integrity',
  'no Module B ID appears in any Module A table or export',
  'inv',
  `select x.id from (select case_id as id from public.cases union all select case_id from public.v_independent_judgments_v4
     union all select case_id from public.v_adjudicated_reference_v4 union all select case_id from public.v_frozen_predictions_v4) x where x.id like 'MB4-%'`,
  { rows: 0 },
);
await step(
  'V4-MB-51',
  'mb-immutability',
  'a Module B response cannot be updated (owner role)',
  'owner',
  "update public.mb_responses_v4 set eligibility = 'INCLUDE'",
  { error: /append-only/ },
);
await step(
  'V4-MB-52',
  'mb-immutability',
  'a Module B adjudication cannot be deleted (owner role)',
  'owner',
  'delete from public.mb_adjudications_v4',
  { error: /append-only/ },
);

// =============================================================================
// K. Audit chain (v2 mechanism extended to every v4 table)
// =============================================================================
await step(
  'V4-AUDIT-01',
  'audit',
  'every v4 table writes audit rows (activation, records, predictions, freeze, snapshot, Module B)',
  'owner',
  "select count(distinct entity_table)::int as n from public.audit_log where entity_table in ('design_activation_v4','case_records_v4','frozen_predictions_v4','freeze_manifests_v4','judgment_snapshots_v4','mb_responses_v4','mb_reference_lock_v4')",
  { value: 7 },
);
await step(
  'V4-AUDIT-02',
  'audit',
  'audit log has a hash on every row',
  'owner',
  'select count(*)::int as n from public.audit_log where row_hash is null',
  { value: 0 },
);
await step(
  'V4-AUDIT-03',
  'audit',
  'each prev_hash equals the previous row hash',
  'owner',
  'select count(*)::int as n from (select prev_hash, lag(row_hash) over (order by audit_id) as lag_hash, audit_id from public.audit_log) s where audit_id > (select min(audit_id) from public.audit_log) and prev_hash is distinct from lag_hash',
  { value: 0 },
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
  '-- Generated by rls_tests_v4.mjs: the statements each test runs, in order, with the identity and expectation.\n' +
    "-- Identity switch used before each statement: reset role; select set_config('request.jwt.claims', <claims json>, false); set role authenticated;\n\n" +
    sqlLog.join('\n'),
);
console.log(JSON.stringify(summary));
for (const r of results.filter((r) => !r.pass)) console.log('FAIL', r.id, r.desc, '|', r.actual);
await db.close();
