// Shared synthetic fixture for review design v7 (migration 0024) on THIS repository's full chain.
// It drives the real v7 RPCs, in the order of the supplied suite (tests/handoff/v7.mjs), from the
// design record through the synthetic pilot (tests/handoff/fixtures/v7/SYNTHETIC_PILOT_UNITS_v7.json)
// and the sign-off to an OPEN formal phase with eight synthetic FORMAL units. Every identifier is
// synthetic; the NCT99 placeholders are built at run time so this source carries none.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { HOSTED_SCHEMA_FILES } from '../scripts/supabase-identity-tools.mjs';

/** PGlite or a node-postgres client: both expose exec-like and query with `{ rows }`. */
export type FixtureDb = {
  exec(sql: string): Promise<unknown>;
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
};
export type Who = 'owner' | 'inv' | 'inv1' | 'pt1' | 'pt2' | 'r1' | 'r2' | 'adj' | 'out';
type Claims = { sub: string; email: string; aal: string };
export const P: Record<Exclude<Who, 'owner'>, Claims> = {
  inv: {
    sub: '00000000-0000-4000-8000-0000000000a1',
    email: 'investigator@example.test',
    aal: 'aal2',
  },
  inv1: {
    sub: '00000000-0000-4000-8000-0000000000a1',
    email: 'investigator@example.test',
    aal: 'aal1',
  },
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
export const ATT = 'Synthetic attestation for testing only.';
const VOC = JSON.parse(
  readFileSync('tests/handoff/fixtures/v7/VOCABULARY_CONTRACT_v7.json', 'utf8'),
);
const PILOT = JSON.parse(
  readFileSync('tests/handoff/fixtures/v7/SYNTHETIC_PILOT_UNITS_v7.json', 'utf8'),
);
const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
const lit = (o: unknown) => `'${JSON.stringify(o).replace(/'/g, "''")}'::jsonb`;
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
/** The handoff's synthetic NCT99 placeholder for a three-digit suffix (never a real record). */
export const syntheticNct = (n: number) => `NCT${'99000'}${String(n).padStart(3, '0')}`;

/** Applies the auth shim and every file of the hosted chain, optionally plus extras. */
export type ChainOptions = {
  /** Hosted-chain files to leave out (to reproduce a defect before its fix migration). */
  without?: string[];
  /** Synthetic design version override for v8 compatibility tests; never operational data. */
  designVersion?: string;
  plannedPrimary?: number;
  plannedSubgroup?: number;
  overlap?: 'ALLOW' | 'ONE_PER_TRIAL';
  existing?: FixtureDb;
  /** Stop the pilot after the adjudications, before the pilot lock and sign-off. */
  stopAfterPilotAdjudication?: boolean;
  /** Stop earlier or later than the default end of each builder (see signedOffPilot, formalOpen). */
  stopAfter?:
    | 'accounts'
    | 'design'
    | 'pilotAnswers'
    | 'pilotAdjudication'
    | 'pilotLock'
    | 'formalImport'
    | 'freeze';
  /**
   * Study-decision gates of migration 0026 to specify and approve SYNTHETICALLY in this disposable
   * test database ('all' by default). With [] every gate stays as 0026 records it, pending.
   * Ignored on a chain without 0026, where only G-PAIN-01 is approved, as the supplied suite does.
   */
  gates?: 'all' | string[];
};
/** Migrations that build on another: leaving one out leaves its dependents out too. */
const DEPENDENTS: Record<string, string[]> = {
  'migrations/0033_v8_design_foundation.sql': ['migrations/0034_v8_synthetic_identifiers.sql'],
  'migrations/0032_v7_freeze_gates_v8_4.sql': ['migrations/0033_v8_design_foundation.sql'],
  'migrations/0025_v7_review_fixes.sql': ['migrations/0026_v7_lifecycle_and_gates.sql'],
  'migrations/0026_v7_lifecycle_and_gates.sql': [
    'migrations/0028_v7_gate_specifications_v8_1.sql',
    'migrations/0029_v7_versioned_gate_approvals.sql',
    'migrations/0032_v7_freeze_gates_v8_4.sql',
  ],
  // 0032 adds later requirement versions (G-PAIN-01 version 3 follows 0028's version 2) and relies on
  // the versioned approvals of 0029 and the per-unit check of 0030.
  'migrations/0028_v7_gate_specifications_v8_1.sql': ['migrations/0032_v7_freeze_gates_v8_4.sql'],
  'migrations/0029_v7_versioned_gate_approvals.sql': [
    'migrations/0030_v7_current_unit_freeze_gates.sql',
    'migrations/0032_v7_freeze_gates_v8_4.sql',
  ],
  'migrations/0030_v7_current_unit_freeze_gates.sql': ['migrations/0032_v7_freeze_gates_v8_4.sql'],
};
function withDependents(without: string[]): string[] {
  const out = new Set(without);
  for (let grew = true; grew;) {
    grew = false;
    for (const f of [...out])
      for (const d of DEPENDENTS[f] ?? [])
        if (!out.has(d)) {
          out.add(d);
          grew = true;
        }
  }
  return [...out];
}
export const chainFiles = (without: string[] = []) =>
  (HOSTED_SCHEMA_FILES as string[]).filter((f) => !withDependents(without).includes(f));
export async function seedChain(db: FixtureDb, without: string[] = []) {
  await db.exec(readFileSync('supabase_test_shim/auth_shim.sql', 'utf8'));
  for (const file of chainFiles(without)) await db.exec(readFileSync(file, 'utf8'));
}
export async function newDatabase(without: string[] = []): Promise<PGlite> {
  const db = new PGlite({ extensions: { pgcrypto } });
  await seedChain(db, without);
  return db;
}

export async function as<T>(db: FixtureDb, who: Who, fn: () => Promise<T>): Promise<T> {
  await db.exec('reset role');
  if (who !== 'owner') {
    await db.query("select set_config('request.jwt.claims', $1, false)", [JSON.stringify(P[who])]);
    await db.exec('set role authenticated');
  }
  try {
    return await fn();
  } finally {
    await db.exec('reset role');
  }
}
export const one = async (db: FixtureDb, who: Who, sql: string, params: unknown[] = []) =>
  as(db, who, async () => {
    const r = await db.query<Record<string, unknown>>(sql, params);
    return r.rows.length ? Object.values(r.rows[0])[0] : null;
  });
export const rows = async <T = Record<string, unknown>>(
  db: FixtureDb,
  who: Who,
  sql: string,
  params: unknown[] = [],
) => as(db, who, async () => (await db.query<T>(sql, params)).rows);

// ---- synthetic FORMAL units (same shape as the supplied suite's FX list) ----------------------
export type Unit = {
  uid: string;
  fam: 'AREA' | 'ROW' | 'SG';
  cat: string;
  code: string;
  nct: string;
  N: number;
  n: number;
  note?: boolean;
  gate?: string;
};
const SET = 'SYN7-ASSIGN-TESTFX-01';
const DESIGN_VERSION = 'SYN-7-TESTFX';
export const FORMAL_UNITS: Unit[] = [
  {
    uid: 'MU7-AREA-ONCOLOGY-001',
    fam: 'AREA',
    cat: 'ONCOLOGY',
    code: 'IN_AREA',
    nct: syntheticNct(101),
    N: 80,
    n: 1,
  },
  {
    uid: 'MU7-AREA-MENTAL_HEALTH-001',
    fam: 'AREA',
    cat: 'MENTAL_HEALTH',
    code: 'IN_AREA',
    nct: syntheticNct(102),
    N: 40,
    n: 1,
    note: true,
  },
  {
    uid: 'MU7-AREA-RESPIRATORY-001',
    fam: 'AREA',
    cat: 'RESPIRATORY',
    code: 'IN_AREA',
    nct: syntheticNct(103),
    N: 30,
    n: 1,
  },
  {
    uid: 'MU7-ROW-CAN_ALL-001',
    fam: 'ROW',
    cat: 'CAN_ALL',
    code: 'IN_ROW',
    nct: syntheticNct(101),
    N: 60,
    n: 1,
  },
  {
    uid: 'MU7-ROW-DIAB-001',
    fam: 'ROW',
    cat: 'DIAB',
    code: 'IN_ROW',
    nct: syntheticNct(104),
    N: 20,
    n: 1,
  },
  {
    uid: 'MU7-ROW-PAIN-001',
    fam: 'ROW',
    cat: 'PAIN',
    code: 'IN_ROW',
    nct: syntheticNct(105),
    N: 16,
    n: 1,
    gate: 'G-PAIN-01',
  },
  {
    uid: 'MU7-SG-RULE_D_REMOVED-001',
    fam: 'SG',
    cat: 'RULE_D_REMOVED',
    code: 'D2_REMOVE_OTHER_TYPE',
    nct: syntheticNct(106),
    N: 10,
    n: 1,
  },
  {
    uid: 'MU7-SG-RULE_K_KEPT-001',
    fam: 'SG',
    cat: 'RULE_K_KEPT',
    code: 'K_KEEP_MALIGNANT_COMPATIBLE',
    nct: syntheticNct(107),
    N: 50,
    n: 1,
  },
];
const mappingCode = (u: Unit) =>
  u.fam === 'AREA'
    ? `AREA_${u.cat}`
    : u.fam === 'ROW'
      ? `FIG2_ROW_${u.cat}`
      : u.cat.startsWith('RULE_D')
        ? 'RULE_D'
        : 'RULE_K';
const parentRow = (u: Unit) =>
  u.fam !== 'SG' ? null : u.cat.startsWith('RULE_D') ? 'FIG2_ROW_DIAB' : 'FIG2_ROW_CAN_ALL';
function packet(u: Unit) {
  const unit: Record<string, unknown> = {
    unit_id: u.uid,
    mode: 'FORMAL',
    family: u.fam,
    category: u.cat,
    unit_role: u.fam === 'SG' ? 'SUBGROUP' : 'PRIMARY',
    mapping_code: mappingCode(u),
    mapping_label: VOC.mapping_labels[`${u.fam}|${u.cat}`],
    assignment_code: u.code,
    assignment_status: 'ASSIGNED',
    display_text: VOC.display_texts[`${u.fam}|${u.code}`] ?? 'in this area',
  };
  if (u.fam === 'SG') {
    const pr = parentRow(u) as string;
    Object.assign(unit, {
      display_decision: VOC.display_decisions[u.cat],
      parent_row_code: pr,
      parent_row_label: VOC.row_labels[pr.replace('FIG2_ROW_', '')],
    });
  }
  if (u.note) unit.display_note = VOC.mental_health_note;
  return {
    schema_version: '7.0',
    unit,
    trial: {
      nct_id: u.nct,
      registry_url: `https://clinicaltrials.gov/study/${u.nct}`,
      brief_title: 'Synthetic trial 1 of a fictional therapy',
      official_title: 'A synthetic study 1 for application testing only',
      conditions_registered: ['Synthetic condition A'],
      condition_mesh_headings: ['Synthetic heading A'],
      brief_summary: 'SYNTHETIC TEXT FOR APP TESTING ONLY.',
      interventions: [
        { intervention_type: 'DRUG', name: 'Synthetic drug', description: 'fictional' },
      ],
      eligibility_age_range: { minimum_age: '18 Years', maximum_age: 'N/A' },
    },
    notices: [],
  };
}
const designRow = (u: Unit) => ({
  nct_id: u.nct,
  frame_id: 'SYN_FRAME',
  stratum: `${u.fam}-${u.cat}`,
  frame_stratum_size: u.N,
  n_sampled_in_stratum: u.n,
  selection_probability: u.n / u.N,
  sampling_seed: 1,
  prn_key: sha256(`1|${u.fam}-${u.cat}|${u.nct}`),
  allocation_option: 'A',
  overlap_setting: 'ALLOW',
  design_version: DESIGN_VERSION,
  freeze_status: u.gate ? 'BLOCKED_PENDING_GATE' : 'READY',
  freeze_gate: u.gate ?? null,
});
const asgText = (u: Unit) => [SET, u.uid, mappingCode(u), u.code, 'ASSIGNED'].join('|');
const designText = (u: Unit) => {
  const d = designRow(u);
  return [
    u.uid,
    d.nct_id,
    d.frame_id,
    d.stratum,
    String(d.frame_stratum_size),
    String(d.n_sampled_in_stratum),
    d.allocation_option,
    d.overlap_setting,
    String(d.sampling_seed),
    d.prn_key,
  ].join('|');
};
export const importObj = (u: Unit) => ({
  unit_id: u.uid,
  mode: 'FORMAL',
  record_category: 'MAPPING_UNIT_FORMAL',
  family: u.fam,
  category: u.cat,
  unit_role: u.fam === 'SG' ? 'SUBGROUP' : 'PRIMARY',
  mapping_code: mappingCode(u),
  assignment_code: u.code,
  assignment_status: 'ASSIGNED',
  parent_row_code: parentRow(u),
  packet: packet(u),
  design: designRow(u),
  assignment: {
    assignment_set_id: SET,
    mapping_code: mappingCode(u),
    assignment_code: u.code,
    assignment_status: 'ASSIGNED',
    row_sha256: sha256(asgText(u)),
  },
});
const byKey = (k: number) => FORMAL_UNITS[k - 1].uid;
export const FORMAL_QUEUE_1 = [1, 2, 4, 3, 5, 6, 7, 8].map(byKey);
export const FORMAL_QUEUE_2 = [3, 1, 5, 4, 6, 2, 8, 7].map(byKey);
const sortedUnits = () => [...FORMAL_UNITS].sort((a, b) => cmp(a.uid, b.uid));
const freezeHashes = () => ({
  unit_list_sha256: sha256(
    FORMAL_UNITS.map((u) => u.uid)
      .sort(cmp)
      .join('\n'),
  ),
  assignment_set_sha256: sha256(
    sortedUnits()
      .map((u) => sha256(asgText(u)))
      .join('\n'),
  ),
  design_rows_sha256: sha256(
    sortedUnits()
      .map((u) => sha256(designText(u)))
      .join('\n'),
  ),
  queue_sha256: sha256(
    [
      [1, FORMAL_QUEUE_1],
      [2, FORMAL_QUEUE_2],
    ]
      .flatMap(([slot, ids]) => (ids as string[]).map((u, i) => `${slot}|${i + 1}|${u}`))
      .join('\n'),
  ),
});

async function must(db: FixtureDb, who: Who, sql: string, what: string) {
  try {
    return await one(db, who, sql);
  } catch (e) {
    throw new Error(`fixture step failed (${what}): ${(e as Error).message}`);
  }
}
export const freezeSql = () =>
  `select public.rpc_mu7_freeze(${lit({ ...freezeHashes(), attestation: ATT })}) as f`;

/** True when the chain carries migration 0026's gate requirements. */
export const hasGateRequirements = async (db: FixtureDb) =>
  (await one(db, 'owner', "select to_regclass('public.mu7_gate_requirements') is not null")) ===
  true;
/** The synthetic decision record a test specifies for a gate (never a real study decision). */
export const syntheticDecision = (gate: string) => `SYNTHETIC-TEST-DECISION-${gate}`;
/**
 * In a disposable test database only: records a SPECIFIED synthetic requirement (as the database
 * owner, the only role that can write requirements, standing in for a reviewed migration) for each
 * chosen gate with its blocks unchanged, then approves it through the investigator's RPC naming
 * that synthetic record. Nothing here is a study decision.
 */
export async function specifyAndApproveGates(db: FixtureDb, gates: 'all' | string[]) {
  const chosen =
    gates === 'all'
      ? ((
          await rows<{ gate_id: string }>(
            db,
            'owner',
            'select distinct gate_id from public.mu7_gate_requirements order by gate_id',
          )
        ).map((r) => r.gate_id) as string[])
      : gates;
  for (const gate of chosen) {
    await db.query(
      `insert into public.mu7_gate_requirements (gate_id, requirement_version, blocks, requirement_status, question, decision_reference, source)
       select gate_id, requirement_version + 1, blocks, 'SPECIFIED', question, $2, 'SYNTHETIC test fixture (disposable database)'
       from public.mu7_gate_requirements where gate_id = $1 order by requirement_version desc limit 1`,
      [gate, syntheticDecision(gate)],
    );
    await must(
      db,
      'inv',
      `select public.rpc_mu7_approve_gate('${gate}', '${ATT}', '${syntheticDecision(gate)}')`,
      `approve ${gate}`,
    );
  }
}
/** The design record call of the fixture (for tests that record it themselves). */
export const recordDesignSql = (designVersion = DESIGN_VERSION) =>
  `select public.rpc_mu7_record_design(${lit({ design_version: designVersion, assignment_set_id: SET, overlap_setting: 'ALLOW', n_primary_planned: 6, n_subgroup_planned: 2, attestation: ATT })}) as d`;
export const phase = (t: string, o: Record<string, unknown> = {}) =>
  `select public.rpc_mu7_phase('${t}', ${lit({ attestation: ATT, ...o })}) as e`;
export const assignmentOf = (db: FixtureDb, pseudo: string, unit: string) =>
  one(
    db,
    'owner',
    'select assignment_id from public.mu7_queue where reviewer_pseudo_id=$1 and unit_id=$2',
    [pseudo, unit],
  ) as Promise<string>;
export const submitSql = (assignmentId: string, answer: Record<string, unknown>) =>
  `select public.rpc_mu7_submit('${assignmentId}', ${lit(answer)}) as j`;
export const adjudicateSql = (o: Record<string, unknown>) =>
  `select public.rpc_mu7_record_adjudication(${lit(o)}) as a`;
export const pidOf = (db: FixtureDb, who: Who) =>
  one(
    db,
    'owner',
    'select r.reviewer_pseudo_id from public.reviewers r join public.users u using (user_id) where u.email=$1 and r.withdrawn_at is null',
    [P[who as Exclude<Who, 'owner'>].email],
  ) as Promise<string>;
export const uidOf = (db: FixtureDb, who: Who) =>
  one(db, 'owner', 'select user_id from public.users where email=$1', [
    P[who as Exclude<Who, 'owner'>].email,
  ]) as Promise<string>;

export type FormalOpen = {
  db: FixtureDb & { close(): Promise<void> };
  R1: string;
  R2: string;
  PT1: string;
  PT2: string;
};

/** Accounts, design record, the completed synthetic pilot and its sign-off. */
export async function signedOffPilot(
  options: ChainOptions = {},
): Promise<{ db: FixtureDb & { close(): Promise<void> }; PT1: string; PT2: string }> {
  const { existing, without = [] } = options;
  // An existing connection is closed by its owner; close() is then a no-op here.
  const db: FixtureDb & { close(): Promise<void> } = existing
    ? Object.assign(Object.create(null), {
        exec: (sql: string) => existing.exec(sql),
        query: <T>(sql: string, params?: unknown[]) => existing.query<T>(sql, params),
        close: async () => {},
      })
    : await newDatabase(without);
  if (existing) await seedChain(existing, without);
  for (const k of Object.keys(P) as Exclude<Who, 'owner'>[])
    await db.query('insert into auth.users (id, email) values ($1, $2) on conflict do nothing', [
      P[k].sub,
      P[k].email,
    ]);
  await db.query(
    "insert into public.users (email, display_name, role) values ($1, 'Test Investigator', 'INVESTIGATOR')",
    [P.inv.email],
  );
  await must(db, 'inv', 'select public.rpc_claim_account()', 'claim investigator');
  for (const [k, pilot] of [
    ['pt1', true],
    ['pt2', true],
    ['r1', false],
    ['r2', false],
  ] as const)
    await must(
      db,
      'inv',
      `select public.rpc_register_user('${P[k].email}', 'Synthetic ${k}', 'REVIEWER', ${pilot})`,
      `register ${k}`,
    );
  await must(
    db,
    'inv',
    `select public.rpc_register_user('${P.adj.email}', 'Synthetic adjudicator', 'ADJUDICATOR', false)`,
    'register adj',
  );
  for (const k of ['pt1', 'pt2', 'r1', 'r2', 'adj'] as const)
    await must(db, k, 'select public.rpc_claim_account()', `claim ${k}`);
  for (const k of ['pt1', 'pt2'] as const)
    await must(
      db,
      'inv',
      `select public.rpc_enroll_reviewer('${await uidOf(db, k)}', 'PILOT', 'synthetic pilot account')`,
      `enrol ${k}`,
    );
  const PT1 = await pidOf(db, 'pt1');
  const PT2 = await pidOf(db, 'pt2');
  if (options.stopAfter === 'accounts') return { db, PT1, PT2 };
  await must(
    db,
    'inv',
    `select public.rpc_mu7_record_design(${lit({ design_version: options.designVersion ?? DESIGN_VERSION, assignment_set_id: SET, overlap_setting: options.overlap ?? 'ALLOW', n_primary_planned: options.plannedPrimary ?? 6, n_subgroup_planned: options.plannedSubgroup ?? 2, attestation: ATT })})`,
    'record design',
  );
  if (options.stopAfter === 'design') return { db, PT1, PT2 };
  type PilotUnit = {
    import: { unit_id: string; unit_role: string };
    walkthrough: {
      planted_answers: Array<{
        reviewer_slot: number;
        answer: string;
        reason_code: string | null;
        note: string | null;
        uncertain: boolean;
      }>;
      expected_routing: string;
    };
  };
  const PU = PILOT.units as PilotUnit[];
  for (const u of PU)
    await must(
      db,
      'inv',
      `select public.rpc_mu7_import_unit(${lit(u.import)})`,
      `import ${u.import.unit_id}`,
    );
  const prim = PU.filter((u) => u.import.unit_role === 'PRIMARY').map((u) => u.import.unit_id);
  const sg = PU.filter((u) => u.import.unit_role === 'SUBGROUP').map((u) => u.import.unit_id);
  const SLOT1 = [...prim, ...sg];
  const SLOT2 = [...[...prim].reverse(), ...[...sg].reverse()];
  await must(
    db,
    'inv',
    `select public.rpc_mu7_assign_queue('PILOT', ${lit({
      slots: [
        { reviewer_slot: 1, reviewer_pseudo_id: PT1, unit_ids: SLOT1 },
        { reviewer_slot: 2, reviewer_pseudo_id: PT2, unit_ids: SLOT2 },
      ],
    })})`,
    'pilot queue',
  );
  const W = Object.fromEntries(PU.map((u) => [u.import.unit_id, u.walkthrough]));
  for (const [who, pseudo, order, slot] of [
    ['pt1', PT1, SLOT1, 1],
    ['pt2', PT2, SLOT2, 2],
  ] as const) {
    for (const u of order) {
      const a = W[u].planted_answers.find((x) => x.reviewer_slot === slot)!;
      const o: Record<string, unknown> = { answer: a.answer, uncertain: a.uncertain };
      if (a.reason_code) o.reason_code = a.reason_code;
      if (a.note) o.note = a.note;
      await must(db, who, submitSql(await assignmentOf(db, pseudo, u), o), `${who} answers ${u}`);
    }
  }
  if (options.stopAfter === 'pilotAnswers') return { db, PT1, PT2 };
  const PADJ: Record<string, Record<string, unknown>> = {
    'SYN7-AREA-RESPIRATORY-001': {
      decision: 'DISAGREE',
      reason_code: 'ORGAN_OF_ORIGIN_ONLY',
      status: 'DISCORDANT_RESOLVED',
      basis: 'REVIEWER_2',
      disagreement_reason_code: 'POLICY_RULE_INTERPRETATION',
      rationale: 'Synthetic: the neoplasm policy applies.',
    },
    'SYN7-AREA-MENTAL_HEALTH-001': {
      decision: 'AGREE',
      status: 'DISCORDANT_RESOLVED',
      basis: 'REVIEWER_2',
      rationale: 'Synthetic: the evidence supports the area.',
    },
    'SYN7-ROW-DIAB-001': {
      decision: 'AGREE',
      status: 'DISCORDANT_RESOLVED',
      basis: 'REVIEWER_1',
      rationale: 'Synthetic: diabetes is studied.',
    },
    'SYN7-SG-RULE_D_REMOVED-001': {
      decision: 'DISAGREE',
      reason_code: 'TYPE_2_STUDIED',
      status: 'DISCORDANT_RESOLVED',
      basis: 'REVIEWER_1',
      rationale: 'Synthetic: type 2 is stated.',
    },
    'SYN7-SG-RULE_K_KEPT-001': {
      status: 'UNRESOLVED_ESCALATED',
      basis: 'NONE',
      rationale: 'Synthetic: cannot be resolved from the registry.',
    },
  };
  for (const [unit, o] of Object.entries(PADJ))
    await must(db, 'adj', adjudicateSql({ unit_id: unit, ...o }), `adjudicate ${unit}`);
  if (options.stopAfterPilotAdjudication || options.stopAfter === 'pilotAdjudication')
    return { db, PT1, PT2 };
  await must(db, 'inv', `select public.rpc_mu7_lock_reference('PILOT', '${ATT}')`, 'pilot lock');
  if (options.stopAfter === 'pilotLock') return { db, PT1, PT2 };
  const PEX = await must(
    db,
    'inv',
    `select public.rpc_mu7_register_export(${lit({ mode: 'PILOT', bundle_format_version: '7.0', row_counts: { units: 12 }, file_sha256: {}, manifest_sha256: '3'.repeat(64), app_git_sha: 'abc123' })})`,
    'pilot export',
  );
  await must(
    db,
    'inv',
    phase('PILOT_SIGNED_OFF', {
      checklist_version: 'PAC-7',
      checklist_sha256: '1'.repeat(64),
      app_git_sha: 'abc123',
      pilot_export_id: PEX,
    }),
    'pilot sign-off',
  );
  return { db, PT1, PT2 };
}

/** The signed-off pilot, then the eight FORMAL units frozen and queued, and the formal phase open. */
export async function formalOpen(options: ChainOptions = {}): Promise<FormalOpen> {
  const { db, PT1, PT2 } = await signedOffPilot({
    ...options,
    stopAfterPilotAdjudication: false,
    stopAfter: undefined,
  });
  for (const k of ['r1', 'r2'] as const)
    await must(
      db,
      'inv',
      `select public.rpc_mu7_enroll_reviewer('${await uidOf(db, k)}', 'synthetic qualifications')`,
      `enrol ${k}`,
    );
  const R1 = await pidOf(db, 'r1');
  const R2 = await pidOf(db, 'r2');
  for (const u of FORMAL_UNITS)
    await must(
      db,
      'inv',
      `select public.rpc_mu7_import_unit(${lit({ ...importObj(u), design: { ...designRow(u), design_version: options.designVersion ?? DESIGN_VERSION } })})`,
      `import ${u.uid}`,
    );
  if (await hasGateRequirements(db)) await specifyAndApproveGates(db, options.gates ?? 'all');
  else
    await must(
      db,
      'inv',
      `select public.rpc_mu7_approve_gate('G-PAIN-01', '${ATT}', 'synthetic decision record')`,
      'gate',
    );
  if (options.stopAfter === 'formalImport') return { db, R1, R2, PT1, PT2 };
  await must(db, 'inv', freezeSql(), 'freeze');
  await must(
    db,
    'inv',
    `select public.rpc_mu7_assign_queue('FORMAL', ${lit({
      slots: [
        { reviewer_slot: 1, reviewer_pseudo_id: R1, unit_ids: FORMAL_QUEUE_1 },
        { reviewer_slot: 2, reviewer_pseudo_id: R2, unit_ids: FORMAL_QUEUE_2 },
      ],
    })})`,
    'formal queue',
  );
  if (options.stopAfter === 'freeze') return { db, R1, R2, PT1, PT2 };
  await must(db, 'inv', phase('FORMAL_OPENED'), 'open');
  return { db, R1, R2, PT1, PT2 };
}

/** Answers every FORMAL unit for one reviewer with the given answer per unit (primary units first). */
export async function answerAll(
  f: FormalOpen,
  who: 'r1' | 'r2',
  answerOf: (unit: string) => Record<string, unknown>,
) {
  const pseudo = who === 'r1' ? f.R1 : f.R2;
  const order = who === 'r1' ? FORMAL_QUEUE_1 : FORMAL_QUEUE_2;
  for (const u of order)
    await must(
      f.db,
      who,
      submitSql(await assignmentOf(f.db, pseudo, u), answerOf(u)),
      `${who} answers ${u}`,
    );
}
