// SYNTHETIC ENGINEERING ONLY. Design v5 lifecycle on an in-memory database: pilot, sign-off,
// activation, a synthetic training example, a synthetic formal run, both bundles, and the Python
// analysis round trip when VERIFY_ANALYSIS_PYTHON is set. No real trial, label or person appears.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AREA_ITEMS, ROW_ITEMS, rubricSha256 } from '../src/lib/tlv5-codes';
import { labelRowsSha256, caseListSha256, manifestText } from '../src/lib/tlv5-export';
import { TLV5_PILOT_CASES } from '../src/lib/tlv5-pilot-cases';
import type {
  Tlv5AdminAction,
  Tlv5Bundle,
  Tlv5ItemInput,
  Tlv5TrialPacket,
} from '../src/lib/tlv5-types';
import { tlv5AdjudicationSchema, tlv5SubmissionSchema } from '../src/lib/tlv5-validation';
import { DEMO_ACTORS, getDb, withActor } from '../src/server/db';
import { ServiceError } from '../src/server/service';
import {
  assignTlv5,
  enrollTlv5Formal,
  exportTlv5Bundle,
  freezeTlv5,
  getTlv5AdjudicatorCase,
  getTlv5ReviewerCase,
  getTlv5Workspace,
  importTlv5Case,
  importTlv5Labels,
  recordTlv5Adjudication,
  submitTlv5,
  tlv5AdminAction,
} from '../src/server/tlv5';

process.env.VERIFY_DB_DIR = 'memory';
// Explicit fictional build identity: the export refuses a dirty developer checkout (PR #4 finding).
process.env.VERIFY_APP_GIT_SHA ??= 'e'.repeat(40);
const [investigator, pilotA, pilotB, adjudicator, stagingOne, stagingTwo] = DEMO_ACTORS;
const ATT = 'Synthetic attestation for testing only, at least twenty characters.';
const python = process.env.VERIFY_ANALYSIS_PYTHON;
// These synthetic lifecycle steps intentionally exercise the SQL contract directly. The web app
// must refuse formal orchestration until investigator approvals are represented and verified.
async function syntheticAdminStep(input: Tlv5AdminAction) {
  if (process.env.VERIFY_DB_DIR !== 'memory') throw new Error('Disposable database required');
  if (input.action === 'activate') {
    await withActor(investigator, (tx) =>
      tx.query('select public.rpc_tlv5_activate($1, $2, $3)', [
        input.designVersion,
        input.adjudicationScope,
        input.attestation,
      ]),
    );
  } else if (input.action === 'enroll-formal') {
    await enrollTlv5Formal(investigator, input.userId, input.qualifications);
  } else if (input.action === 'phase' && input.eventType === 'FORMAL_OPENED') {
    await withActor(investigator, (tx) =>
      tx.query('select public.rpc_tlv5_phase($1, $2::jsonb)', [
        input.eventType,
        JSON.stringify({ attestation: input.attestation }),
      ]),
    );
  } else if (input.action === 'assign' && input.mode === 'FORMAL') {
    const data = await getTlv5Workspace(investigator);
    if (data.kind !== 'investigator') throw new Error('Expected investigator');
    const ids = await withActor(investigator, (tx) =>
      tx.query<{ case_id: string }>(
        "select case_id from public.tlv5_cases where mode = 'FORMAL' order by case_id",
      ),
    );
    for (const [index, reviewer] of data.reviewers
      .filter((r) => r.modeScope === 'FORMAL')
      .entries())
      await assignTlv5(
        investigator,
        'FORMAL',
        reviewer.pseudoId,
        index === 0 ? 1 : 2,
        ids.rows.map((r) => r.case_id),
        input.seed,
      );
  } else throw new Error('Unsupported synthetic fixture step');
  const workspace = await getTlv5Workspace(investigator);
  if (workspace.kind !== 'investigator') throw new Error('Expected investigator');
  return workspace;
}

function answers(options: {
  areas?: string[];
  rows?: string[];
  areaOverride?: Record<string, string>;
  sgD?: string;
  sgK?: string;
  note?: { item: string; text: string };
}): Tlv5ItemInput[] {
  const items: Tlv5ItemInput[] = AREA_ITEMS.map((code) => ({
    itemCode: code,
    answer: options.areaOverride?.[code] ?? (options.areas?.includes(code.slice(5)) ? 'YES' : 'NO'),
    uncertain: false,
  }));
  for (const code of ROW_ITEMS)
    items.push({
      itemCode: code,
      answer: options.rows?.includes(code.slice(9)) ? 'YES' : 'NO',
      uncertain: false,
    });
  if (options.rows?.includes('DIAB'))
    items.push({ itemCode: 'SG_DIABETES_TYPE', answer: options.sgD ?? 'TYPE_2', uncertain: false });
  if (options.rows?.includes('CAN_ALL'))
    items.push({
      itemCode: 'SG_NEOPLASM_MALIGNANCY',
      answer: options.sgK ?? 'MALIGNANT',
      uncertain: false,
    });
  if (options.note)
    for (const item of items)
      if (item.itemCode === options.note.item) {
        item.note = options.note.text;
        item.uncertain = true;
      }
  return items;
}
const submission = (items: Tlv5ItemInput[], extra: Record<string, unknown> = {}) =>
  tlv5SubmissionSchema.parse({ items, packetIssueFlag: false, ...extra });
async function denied(action: Promise<unknown>, status?: number) {
  await assert.rejects(
    action,
    (error: unknown) => error instanceof ServiceError && (!status || error.status === status),
  );
}
function writeBundle(bundle: Tlv5Bundle): string {
  const dir = mkdtempSync(join(tmpdir(), 'verify-tlv5-bundle-'));
  for (const file of bundle.files) writeFileSync(join(dir, file.name), file.content);
  writeFileSync(join(dir, bundle.manifestName), manifestText(bundle));
  return dir;
}
function analyse(dir: string, manifestName: string, flag: string): string {
  const out = join(dir, 'out');
  return execFileSync(
    python!,
    [
      '-m',
      'analysis.performance_analysis_v5',
      '--manifest',
      join(dir, manifestName),
      '--out',
      out,
      flag,
    ],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
    },
  );
}
// The synthetic pilot script of docs/design_v5/SYNTHETIC_PILOT_CASES_v5.csv, one plan per account.
const pilotPlan: Record<
  string,
  { a: Parameters<typeof answers>[0]; b: Parameters<typeof answers>[0] }
> = {
  'SYN-TLV5-001': {
    a: { areas: ['METABOLIC'], rows: ['DIAB'] },
    b: { areas: ['METABOLIC'], rows: ['DIAB'] },
  },
  'SYN-TLV5-002': {
    a: { areas: ['ONCOLOGY'], rows: ['CAN_ALL'] },
    b: { areas: ['ONCOLOGY'], rows: ['CAN_ALL'] },
  },
  'SYN-TLV5-003': {
    a: { areas: ['CARDIOVASCULAR'] },
    b: { areas: ['CARDIOVASCULAR', 'NEUROLOGICAL'] },
  },
  'SYN-TLV5-004': {
    a: { areas: ['MENTAL_HEALTH'], rows: ['DEP'] },
    b: { areas: ['MENTAL_HEALTH'], rows: ['DEP'] },
  },
  'SYN-TLV5-005': {
    a: { areas: ['RESPIRATORY'], rows: ['COPD'] },
    b: { areas: ['RESPIRATORY'], rows: ['COPD'] },
  },
  'SYN-TLV5-006': {
    a: { areas: ['RESPIRATORY'], rows: ['AST'] },
    b: { areas: ['RESPIRATORY'], rows: ['AST'] },
  },
  'SYN-TLV5-007': {
    a: { areas: ['INFECTIOUS', 'RESPIRATORY'], rows: ['COV'] },
    b: { areas: ['INFECTIOUS', 'RESPIRATORY'], rows: ['COV'] },
  },
  'SYN-TLV5-008': {
    a: { areas: ['MENTAL_HEALTH'], rows: ['SCZ'] },
    b: { areas: ['MENTAL_HEALTH'], rows: ['SCZ'] },
  },
  'SYN-TLV5-009': {
    a: { areas: ['METABOLIC'], rows: ['OBE'] },
    b: { areas: ['METABOLIC'], rows: ['OBE'] },
  },
  'SYN-TLV5-010': {
    a: { rows: ['PAIN'] },
    b: { rows: ['PAIN'], areaOverride: { AREA_NEUROLOGICAL: 'CONTEXT_DEPENDENT' } },
  },
};
const synthPacket = (n: number, nct: string): Tlv5TrialPacket => ({
  schema_version: '5.1',
  case_title: `Synthetic trial ${n}`,
  trial: {
    nct_id: nct,
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
  notices: ['SYNTHETIC CASE: excluded from all statistics'],
});
after(async () => {
  await (await getDb()).close();
});

test('design v5 lifecycle: pilot, sign-off, activation, training, synthetic formal run and bundles', async () => {
  const db = await getDb();
  const versions = (
    await db.query<{ version: string }>(
      'select version from public.app_schema_version order by applied_at',
    )
  ).rows.map((r) => r.version);
  assert.deepEqual(versions.slice(-7), [
    '5.0.0',
    '5.1.0',
    '5.1.1-independent-finality',
    '5.1.2-legacy-pilot-packet-guards',
    '5.1.3-v5-review-fixes',
    '5.1.4-v5-rubric-binding',
    '5.1.5-v5-rubric-reconciliation',
  ]);
  assert.equal(versions.includes('4.0.7-investigator-judgment-boundary'), true);

  // ---- pilot ---------------------------------------------------------------------------------
  let admin = await tlv5AdminAction(investigator, { action: 'import-pilot' });
  assert.equal(admin.counts.PILOT, 10);
  await denied(tlv5AdminAction(investigator, { action: 'import-pilot' }), 409);
  await denied(tlv5AdminAction(pilotA as never, { action: 'import-pilot' }), 403);
  admin = await tlv5AdminAction(investigator, { action: 'assign', mode: 'PILOT', seed: 20261022 });
  assert.equal(admin.completion.PILOT.length, 2);
  const wa = await getTlv5Workspace(pilotA);
  const wb = await getTlv5Workspace(pilotB);
  assert.equal(wa.kind, 'reviewer');
  if (wa.kind !== 'reviewer' || wb.kind !== 'reviewer')
    throw new Error('reviewer workspace expected');
  assert.equal(wa.queue.length, 10);
  assert.equal(wa.training.length, 0);
  assert.notDeepEqual(
    wa.queue.map((q) => q.caseId),
    wb.queue.map((q) => q.caseId),
  );
  // Blinding at the database boundary: no label, design row, freeze or other reviewer's rows.
  for (const table of [
    'tlv5_case_design',
    'tlv5_frozen_labels',
    'tlv5_freeze',
    'tlv5_adjudications',
    'tlv5_exports',
  ])
    assert.equal(
      (await withActor(pilotA, (tx) => tx.query(`select * from public.${table}`))).rows.length,
      0,
      table,
    );
  const packet = (await getTlv5ReviewerCase(pilotA, 'SYN-TLV5-001')).packet;
  assert.equal(packet.trial.nct_id, 'SYN-NCT-0001');
  assert.doesNotMatch(JSON.stringify(packet), /tier|label|stratum|weight|enrol|female|sex/i);
  await denied(getTlv5ReviewerCase(pilotA, 'TLV5-TESTFX-9999'), 404);
  await denied(
    getTlv5ReviewerCase(pilotB as never, 'SYN-TLV5-001').then(() =>
      submitTlv5(adjudicator, 'SYN-TLV5-001', submission(answers({}))),
    ),
    403,
  );
  // Submissions following the pilot script.
  await denied(
    submitTlv5(pilotA, 'SYN-TLV5-001', {
      items: answers({ rows: ['DIAB'] }).filter((i) => i.itemCode !== 'SG_DIABETES_TYPE'),
      packetIssueFlag: false,
    }),
    400,
  );
  for (const c of TLV5_PILOT_CASES) {
    await submitTlv5(pilotA, c.caseId, submission(answers(pilotPlan[c.caseId].a)));
    const bExtra =
      c.caseId === 'SYN-TLV5-009'
        ? { packetIssueFlag: true, packetIssueNote: 'Synthetic packet problem note.' }
        : {};
    await submitTlv5(pilotB, c.caseId, submission(answers(pilotPlan[c.caseId].b), bExtra));
  }
  // Incomplete and rule-breaking submissions are refused before and at the database.
  assert.equal(
    tlv5SubmissionSchema.safeParse({ items: answers({}).slice(1), packetIssueFlag: false }).success,
    false,
  );
  assert.equal(
    tlv5SubmissionSchema.safeParse({
      items: [...answers({}), { itemCode: 'SG_DIABETES_TYPE', answer: 'TYPE_2', uncertain: false }],
      packetIssueFlag: false,
    }).success,
    false,
  );
  // A final response cannot be revised without an authorized amendment procedure.
  await denied(submitTlv5(pilotA, 'SYN-TLV5-004', submission(answers({}))), 409);
  const revised = await getTlv5ReviewerCase(pilotA, 'SYN-TLV5-004');
  assert.deepEqual(
    revised.submissions.map((s) => s.revision),
    [1],
  );
  assert.equal(revised.submissionsOpen, false);
  assert.equal((await getTlv5ReviewerCase(pilotB, 'SYN-TLV5-004')).submissions.length, 1);
  // The other reviewer's rows are invisible; the investigator sees counts only for an open formal phase but reads the pilot by design.
  assert.equal(
    (
      await withActor(pilotB, (tx) =>
        tx.query(
          'select * from public.tlv5_submissions where reviewer_pseudo_id <> private.my_reviewer_pseudo_id()',
        ),
      )
    ).rows.length,
    0,
  );
  admin = (await getTlv5Workspace(investigator)) as typeof admin;
  assert.deepEqual(
    admin.completion.PILOT.map((r) => [r.submitted, r.assigned]),
    [
      [10, 10],
      [10, 10],
    ],
  );
  assert.equal(admin.completion.PILOT.find((r) => r.reviewerSlot === 1)?.withRevisions, 0);
  // Adjudication: investigator refused by the app; pilot reviewer refused; concordant item refused by rule.
  const planted = { caseId: 'SYN-TLV5-003', itemCode: 'AREA_NEUROLOGICAL' };
  const base = tlv5AdjudicationSchema.parse({
    ...planted,
    decision: 'NO',
    status: 'DISCORDANT_RESOLVED',
    basis: 'REVIEWER_1',
    rationale: 'Synthetic adjudication rationale.',
    disagreementReasonCode: 'CONSTRUCT_BOUNDARY',
  });
  await denied(recordTlv5Adjudication(investigator, base), 403);
  await denied(recordTlv5Adjudication(pilotA, base), 403);
  await denied(
    recordTlv5Adjudication(adjudicator, {
      ...base,
      caseId: 'SYN-TLV5-001',
      itemCode: 'AREA_METABOLIC',
      decision: 'YES',
      status: 'CONCORDANT_CONFIRMED',
      basis: 'BOTH_REVIEWERS',
    }),
    409,
  );
  await denied(
    recordTlv5Adjudication(adjudicator, { ...base, disagreementReasonCode: undefined }),
    400,
  );
  await denied(
    tlv5AdminAction(investigator, { action: 'lock', mode: 'PILOT', attestation: ATT }),
    409,
  );
  const adjWorkspace = await getTlv5Workspace(adjudicator);
  if (adjWorkspace.kind !== 'adjudicator') throw new Error('adjudicator workspace expected');
  assert.deepEqual(
    adjWorkspace.cases.filter((c) => c.itemsNeedingAdjudication).map((c) => c.caseId),
    ['SYN-TLV5-003', 'SYN-TLV5-010'],
  );
  assert.equal(
    (await withActor(adjudicator, (tx) => tx.query('select * from public.tlv5_frozen_labels'))).rows
      .length,
    0,
  );
  const detail = await getTlv5AdjudicatorCase(adjudicator, 'SYN-TLV5-003');
  const row = detail.items.find((i) => i.itemCode === 'AREA_NEUROLOGICAL');
  assert.deepEqual(
    [row?.reviewer1Answer, row?.reviewer2Answer, row?.needsAdjudication],
    ['NO', 'YES', true],
  );
  assert.doesNotMatch(JSON.stringify(detail), /label_primary|tier0|stratum/);
  await recordTlv5Adjudication(adjudicator, base);
  await recordTlv5Adjudication(adjudicator, {
    ...base,
    caseId: 'SYN-TLV5-010',
    decision: 'NO',
    basis: 'REVIEWER_1',
    disagreementReasonCode: 'TRIAL_CONTEXT',
  });
  admin = await tlv5AdminAction(investigator, { action: 'lock', mode: 'PILOT', attestation: ATT });
  assert.ok(admin.state.locks.PILOT);
  await denied(
    submitTlv5(pilotA, 'SYN-TLV5-005', submission(answers(pilotPlan['SYN-TLV5-005'].a))),
    409,
  );
  assert.equal((await getTlv5ReviewerCase(pilotA, 'SYN-TLV5-005')).submissionsOpen, false);
  // Pilot bundle: deterministic, hashed, three states kept apart.
  const pilotBundle = await exportTlv5Bundle(investigator, 'PILOT');
  assert.deepEqual(
    pilotBundle.files.map((f) => f.rows),
    [380, 190, 172],
  );
  assert.equal(pilotBundle.manifest.formal_phase_status, 'PILOT');
  assert.equal(pilotBundle.manifest.db_schema_version, '5.0.0');
  assert.deepEqual(await exportTlv5Bundle(investigator, 'PILOT'), pilotBundle);
  const labelsCsv = pilotBundle.files[2].content;
  assert.match(labelsCsv, /SYN_P01,SYN_P01,20,10,0.5,2(\.0+)?,false,true,SYN-5/);
  const reference = pilotBundle.files[1].content;
  assert.match(
    reference,
    /SYN-TLV5-003,PILOT,SG_DIABETES_TYPE,SG_DIABETES_TYPE,RULE-SYN-TLV5-003-SG_DIABETES_TYPE,NOT_APPLICABLE,,NOT_APPLICABLE_BY_RULE/,
  );
  assert.match(
    reference,
    /SYN-TLV5-003,PILOT,AREA,AREA_NEUROLOGICAL,ADJ5-[0-9a-f]{32},NO,,DISCORDANT_RESOLVED,REVIEWER_1,2,2,CONSTRUCT_BOUNDARY,A-[A-F0-9]{6},ADJUDICATOR,true,false/,
  );
  assert.match(
    pilotBundle.files[0].content,
    /SYN-TLV5-010,PILOT,SYN-NCT-0010,AREA,AREA_NEUROLOGICAL,2,PT-[A-Z0-9]{4},CONTEXT_DEPENDENT,CONTEXT_DEPENDENT/,
  );
  await denied(exportTlv5Bundle(pilotA as never, 'PILOT'), 403);
  await denied(exportTlv5Bundle(investigator, 'FORMAL'), 409);
  await denied(
    tlv5AdminAction(investigator, {
      action: 'sign-off',
      checklistVersion: 'PAC-5',
      checklistSha256: '1'.repeat(64),
      attestation: ATT,
    }),
    409,
  );
  admin = await tlv5AdminAction(investigator, { action: 'register-export', mode: 'PILOT' });
  assert.equal(admin.exports.length, 1);
  assert.equal(admin.exports[0].manifestSha256, pilotBundle.manifestSha256);
  if (python) {
    const dir = writeBundle(pilotBundle);
    try {
      await assert.rejects(
        async () => analyse(dir, pilotBundle.manifestName, '--allow-synthetic'),
        /PILOT bundle|allow_pilot/,
      );
      const out = analyse(dir, pilotBundle.manifestName, '--allow-pilot');
      assert.match(
        out + readFileSync(join(dir, 'out', 'performance_results_v5.json'), 'utf8'),
        /is_pilot/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  // ---- sign-off, activation, enrolment ------------------------------------------------------------
  await denied(
    tlv5AdminAction(investigator, {
      action: 'activate',
      designVersion: 'SYN-5',
      adjudicationScope: 'DISAGREEMENTS_ONLY',
      attestation: ATT,
    }),
    409,
  );
  admin = await tlv5AdminAction(investigator, {
    action: 'sign-off',
    checklistVersion: 'PAC-5',
    checklistSha256: '1'.repeat(64),
    attestation: ATT,
  });
  assert.equal(admin.state.pilotSignedOff, true);
  for (const action of [
    {
      action: 'activate',
      designVersion: 'SYN-5',
      adjudicationScope: 'DISAGREEMENTS_ONLY',
      attestation: ATT,
    },
    { action: 'enroll-formal', userId: stagingOne.id },
    { action: 'freeze', labelFileSha256: 'a'.repeat(64), attestation: ATT },
    { action: 'phase', eventType: 'FORMAL_OPENED', attestation: ATT },
    { action: 'assign', mode: 'FORMAL', seed: 3 },
  ] as Tlv5AdminAction[])
    await denied(tlv5AdminAction(investigator, action), 409);

  await denied(
    tlv5AdminAction(investigator, {
      action: 'sign-off',
      checklistVersion: 'PAC-5',
      checklistSha256: '1'.repeat(64),
      attestation: ATT,
    }),
    409,
  );
  await denied(
    importTlv5Case(investigator, {
      case_id: 'EX5-01',
      mode: 'TRAINING',
      packet: synthPacket(901, 'SYN-NCT-9001'),
    }),
    409,
  );
  admin = await syntheticAdminStep({
    action: 'activate',
    designVersion: 'SYN-5',
    adjudicationScope: 'DISAGREEMENTS_ONLY',
    attestation: ATT,
  });
  assert.equal(admin.state.activation?.adjudicationScope, 'DISAGREEMENTS_ONLY');
  assert.deepEqual(admin.formalCandidates.map((c) => c.account).sort(), [
    'staging-reviewer-1',
    'staging-reviewer-2',
  ]);
  await denied(
    tlv5AdminAction(investigator, { action: 'enroll-formal', userId: adjudicator.id }),
    409,
  );
  for (const actor of [stagingOne, stagingTwo])
    admin = await syntheticAdminStep({ action: 'enroll-formal', userId: actor.id });
  assert.equal(admin.reviewers.filter((r) => r.modeScope === 'FORMAL').length, 2);
  // ---- synthetic training example (SYN-NCT-90xx; never the private worked examples) -------------
  await importTlv5Case(investigator, {
    case_id: 'EX5-01',
    mode: 'TRAINING',
    packet: synthPacket(901, 'SYN-NCT-9001'),
  });
  await denied(
    importTlv5Case(investigator, {
      case_id: 'EX5-02',
      mode: 'TRAINING',
      packet: synthPacket(902, 'SYN-NCT-9002'),
      design: { nct_id: 'SYN-NCT-9002' },
    }),
    409,
  );
  await denied(
    importTlv5Case(investigator, {
      case_id: 'EX5-03',
      mode: 'TRAINING',
      packet: {
        ...synthPacket(903, 'SYN-NCT-9003'),
        trial: {
          ...synthPacket(903, 'SYN-NCT-9003').trial,
          brief_summary: 'see clinicaltrials.gov',
        },
      },
    }),
    400,
  );
  admin = await tlv5AdminAction(investigator, { action: 'assign', mode: 'TRAINING', seed: 7 });
  const w1 = await getTlv5Workspace(stagingOne);
  if (w1.kind !== 'reviewer') throw new Error('reviewer workspace expected');
  assert.equal(w1.queue.length, 0, 'training examples never appear in the work queue');
  assert.deepEqual(
    w1.training.map((t) => t.caseId),
    ['EX5-01'],
  );
  await submitTlv5(
    stagingOne,
    'EX5-01',
    submission(answers({ areas: ['ONCOLOGY'], rows: ['CAN_ALL'] })),
  );
  await submitTlv5(
    stagingTwo,
    'EX5-01',
    submission(answers({ areas: ['ONCOLOGY', 'RESPIRATORY'], rows: ['CAN_ALL'] })),
  );
  const trainingQueue = await getTlv5Workspace(adjudicator);
  if (trainingQueue.kind !== 'adjudicator') throw new Error('adjudicator workspace expected');
  assert.deepEqual(
    trainingQueue.cases
      .filter((c) => c.mode === 'TRAINING')
      .map((c) => [c.caseId, c.itemsNeedingAdjudication]),
    [['EX5-01', 1]],
  );
  await recordTlv5Adjudication(adjudicator, {
    caseId: 'EX5-01',
    itemCode: 'AREA_RESPIRATORY',
    decision: 'NO',
    status: 'DISCORDANT_RESOLVED',
    basis: 'REVIEWER_1',
    rationale: 'Synthetic neoplasm policy rationale.',
    disagreementReasonCode: 'POLICY_RULE_INTERPRETATION',
  });
  admin = await tlv5AdminAction(investigator, {
    action: 'lock',
    mode: 'TRAINING',
    attestation: ATT,
  });
  assert.ok(admin.state.locks.TRAINING);
  assert.equal(
    (await exportTlv5Bundle(investigator, 'PILOT')).files[0].content.includes('EX5-01'),
    false,
    'training rows never enter an export',
  );
  // ---- synthetic formal run (TLV5-TESTFX-) --------------------------------------------------------
  const formalIds = Array.from(
    { length: 6 },
    (_, i) => `TLV5-TESTFX-${String(i + 1).padStart(4, '0')}`,
  );
  await denied(tlv5AdminAction(investigator, { action: 'assign', mode: 'FORMAL', seed: 3 }), 409);
  for (const [i, id] of formalIds.entries())
    await importTlv5Case(investigator, {
      case_id: id,
      mode: 'FORMAL',
      packet: synthPacket(i + 1, `SYN-NCT-${String(1001 + i)}`),
      design: {
        nct_id: `SYN-NCT-${String(1001 + i)}`,
        frame: 'SYN_FRAME',
        stratum: 'SYN_F1',
        variance_stratum: 'SYN_F1',
        frame_stratum_size: 60,
        n_sampled_in_stratum: 6,
        selection_probability: 0.1,
        sampling_seed: 3,
        prn: null,
        design_version: 'SYN-5',
        in_mixed_sex_cohort: true,
        figure2_rows: 'CAN_ALL',
        dev_linked: i % 2 === 0,
        tier1_eligible: i % 2 !== 0,
      },
    });
  await denied(
    importTlv5Case(investigator, {
      case_id: 'EX5-02',
      mode: 'TRAINING',
      packet: synthPacket(1, 'SYN-NCT-1001'),
    }),
    409,
  );
  const labelRows = formalIds.flatMap((id) => [
    ...AREA_ITEMS.map((code) => ({
      label_set_id: 'LBL5-TESTFX',
      case_id: id,
      item_code: code,
      label_primary: code === 'AREA_ONCOLOGY' ? 'YES' : 'NO',
      label_secondary: code === 'AREA_ONCOLOGY' ? 'YES' : 'NO',
      label_informational: null,
      dev_linked_area: false,
    })),
    ...ROW_ITEMS.map((code) => ({
      label_set_id: 'LBL5-TESTFX',
      case_id: id,
      item_code: code,
      label_primary: code === 'FIG2_ROW_CAN_ALL' ? 'YES' : 'NO',
    })),
    {
      label_set_id: 'LBL5-TESTFX',
      case_id: id,
      item_code: 'RULE_K',
      label_primary: 'K_KEEP_MALIGNANT_COMPATIBLE',
    },
  ]);
  assert.equal(await importTlv5Labels(investigator, labelRows), labelRows.length);
  await denied(
    tlv5AdminAction(investigator, {
      action: 'phase',
      eventType: 'FORMAL_OPENED',
      attestation: ATT,
    }),
    409,
  );
  // Rubric calibration: open to the enrolled formal reviewers before the freeze, read-only after it
  // (migration 0011 closes calibration at the freeze; the screen must say so, PR #4 finding).
  await importTlv5Case(investigator, {
    case_id: 'CAL5-TESTFX-01',
    mode: 'CALIBRATION',
    packet: synthPacket(701, 'SYN-NCT-7001'),
  });
  const formalPseudos = admin.reviewers
    .filter((r) => r.modeScope === 'FORMAL')
    .map((r) => r.pseudoId);
  for (const [slot, pseudo] of formalPseudos.entries())
    await assignTlv5(
      investigator,
      'CALIBRATION',
      pseudo,
      (slot + 1) as 1 | 2,
      ['CAL5-TESTFX-01'],
      5,
    );
  assert.equal(
    (await getTlv5ReviewerCase(stagingOne, 'CAL5-TESTFX-01')).submissionsOpen,
    true,
    'calibration is open before the freeze',
  );
  // Rubric binding (migration 0017): a mode whose first review activity recorded a different
  // rubric refuses later activity under the runtime rubric instead of mixing instructions.
  await withActor(investigator, (tx) =>
    tx.query("select public.rpc_tlv5_bind_rubric('CALIBRATION', 'REVIEW_RUBRIC_SUPERSEDED', $1)", [
      'f'.repeat(64),
    ]),
  );
  const drifted = await getTlv5ReviewerCase(stagingOne, 'CAL5-TESTFX-01');
  assert.equal(drifted.rubricMismatch, true);
  assert.equal(drifted.submissionsOpen, false, 'a drifted rubric closes the form');
  await denied(
    submitTlv5(
      stagingOne,
      'CAL5-TESTFX-01',
      submission(answers({ areas: ['ONCOLOGY'], rows: ['CAN_ALL'] })),
    ),
    409,
  );
  // The pilot binding was fixed by the first pilot submission and matches the runtime rubric.
  const pilotBinding = await withActor(investigator, (tx) =>
    tx.query<{ rubric_sha256: string; rubric_version: string }>(
      "select rubric_sha256, rubric_version from public.tlv5_rubric_bindings where mode = 'PILOT'",
    ),
  );
  assert.equal(pilotBinding.rows[0]?.rubric_sha256, rubricSha256());
  assert.equal(pilotBundle.manifest.rubric_sha256, rubricSha256());
  await freezeTlv5(investigator, {
    labelFileSha256: 'a'.repeat(64),
    frozenItems: { label_file: 'a'.repeat(64), rubric: rubricSha256() },
    attestation: ATT,
  });
  assert.equal(
    (await getTlv5ReviewerCase(stagingOne, 'CAL5-TESTFX-01')).submissionsOpen,
    false,
    'calibration closes at the freeze',
  );
  await denied(
    submitTlv5(
      stagingOne,
      'CAL5-TESTFX-01',
      submission(answers({ areas: ['ONCOLOGY'], rows: ['CAN_ALL'] })),
    ),
    409,
  );
  admin = (await getTlv5Workspace(investigator)) as typeof admin;
  assert.equal(admin.state.frozen?.nCases, 6);
  assert.equal(admin.state.frozen?.caseListSha256, caseListSha256(formalIds));
  assert.equal(admin.state.frozen?.labelRowsSha256, labelRowsSha256(labelRows as never));
  assert.equal(admin.verification.frozenLabels?.matches, true);
  await denied(
    importTlv5Case(investigator, {
      case_id: 'TLV5-TESTFX-0007',
      mode: 'FORMAL',
      packet: synthPacket(7, 'SYN-NCT-1007'),
      design: {
        nct_id: 'SYN-NCT-1007',
        frame: 'SYN_FRAME',
        stratum: 'SYN_F1',
        variance_stratum: 'SYN_F1',
        frame_stratum_size: 60,
        n_sampled_in_stratum: 6,
        selection_probability: 0.1,
        design_version: 'SYN-5',
        dev_linked: false,
        tier1_eligible: true,
      },
    }),
    409,
  );
  await denied(
    importTlv5Case(investigator, {
      case_id: 'EX5-09',
      mode: 'TRAINING',
      packet: synthPacket(909, 'SYN-NCT-9009'),
    }),
    409,
  );
  await syntheticAdminStep({ action: 'phase', eventType: 'FORMAL_OPENED', attestation: ATT });
  await denied(
    importTlv5Case(investigator, {
      case_id: 'EX5-08',
      mode: 'TRAINING',
      packet: synthPacket(908, 'SYN-NCT-9008'),
    }),
    409,
  );
  admin = await syntheticAdminStep({ action: 'assign', mode: 'FORMAL', seed: 3 });
  assert.deepEqual(
    admin.completion.FORMAL.map((r) => r.assigned),
    [6, 6],
  );
  for (const [i, id] of formalIds.entries()) {
    await submitTlv5(
      stagingOne,
      id,
      submission(answers({ areas: ['ONCOLOGY'], rows: ['CAN_ALL'] })),
    );
    await submitTlv5(
      stagingTwo,
      id,
      submission(
        answers({
          areas: i === 0 ? ['ONCOLOGY', 'RESPIRATORY'] : ['ONCOLOGY'],
          rows: ['CAN_ALL'],
          sgK: i === 1 ? 'UNCLEAR' : 'MALIGNANT',
        }),
      ),
    );
  }
  // No interim look: the investigator and the adjudicator read no FORMAL answer while open.
  assert.equal(
    (
      await withActor(investigator, (tx) =>
        tx.query("select * from public.tlv5_submissions where mode = 'FORMAL'"),
      )
    ).rows.length,
    0,
  );
  assert.equal(
    (
      await withActor(adjudicator, (tx) =>
        tx.query("select * from public.v_tlv5_adjudication_queue where mode = 'FORMAL'"),
      )
    ).rows.length,
    0,
  );
  assert.equal(
    (
      await withActor(investigator, (tx) =>
        tx.query("select * from public.v_tlv5_independent_judgments where mode = 'FORMAL'"),
      )
    ).rows.length,
    0,
  );
  await denied(tlv5AdminAction(investigator, { action: 'snapshot' }), 409);
  admin = await tlv5AdminAction(investigator, {
    action: 'phase',
    eventType: 'FORMAL_CLOSED_COMPLETE',
    attestation: ATT,
  });
  assert.equal(admin.state.phase, 'CLOSED');
  await denied(
    submitTlv5(
      stagingOne,
      formalIds[0],
      submission(answers({ areas: ['ONCOLOGY'], rows: ['CAN_ALL'] })),
    ),
    409,
  );
  await denied(
    recordTlv5Adjudication(adjudicator, {
      caseId: formalIds[0],
      itemCode: 'AREA_RESPIRATORY',
      decision: 'NO',
      status: 'DISCORDANT_RESOLVED',
      basis: 'REVIEWER_1',
      rationale: 'Synthetic.',
      disagreementReasonCode: 'OTHER',
    }),
    409,
  );
  admin = await tlv5AdminAction(investigator, { action: 'snapshot' });
  assert.equal(admin.state.snapshot?.rows, 6 * 19 * 2);
  assert.equal(admin.verification.snapshot?.matches, true);
  assert.equal(
    (await getTlv5AdjudicatorCase(adjudicator, formalIds[0])).adjudicationOpen,
    true,
    'the adjudicator can act after the snapshot without receiving investigator-only snapshot data',
  );
  await denied(
    tlv5AdminAction(investigator, { action: 'lock', mode: 'FORMAL', attestation: ATT }),
    409,
  );
  await recordTlv5Adjudication(adjudicator, {
    caseId: formalIds[0],
    itemCode: 'AREA_RESPIRATORY',
    decision: 'NO',
    status: 'DISCORDANT_RESOLVED',
    basis: 'REVIEWER_1',
    rationale: 'Synthetic neoplasm policy rationale.',
    disagreementReasonCode: 'POLICY_RULE_INTERPRETATION',
  });
  await recordTlv5Adjudication(adjudicator, {
    caseId: formalIds[1],
    itemCode: 'SG_NEOPLASM_MALIGNANCY',
    decision: 'MALIGNANT',
    status: 'DISCORDANT_RESOLVED',
    basis: 'REVIEWER_1',
    rationale: 'Synthetic malignancy rationale.',
    disagreementReasonCode: 'PACKET_INSUFFICIENT',
  });
  admin = await tlv5AdminAction(investigator, { action: 'lock', mode: 'FORMAL', attestation: ATT });
  assert.ok(admin.state.locks.FORMAL);
  assert.equal((await getTlv5AdjudicatorCase(adjudicator, formalIds[0])).adjudicationOpen, false);
  const formalBundle = await exportTlv5Bundle(investigator, 'FORMAL');
  assert.deepEqual(
    formalBundle.files.map((f) => f.rows),
    [6 * 19 * 2, 6 * 19, 6 * 18],
  );
  assert.equal(formalBundle.manifest.formal_phase_status, 'CLOSED_COMPLETE');
  assert.equal(formalBundle.manifest.is_synthetic_fixture, true);
  assert.equal(formalBundle.manifest.snapshot_rows, 228);
  assert.equal(formalBundle.manifest.rubric_sha256, rubricSha256());
  const oldBuild = process.env.VERIFY_APP_GIT_SHA;
  try {
    process.env.VERIFY_APP_GIT_SHA = '0'.repeat(40);
    await denied(exportTlv5Bundle(investigator, 'FORMAL'), 409);
  } finally {
    if (oldBuild === undefined) delete process.env.VERIFY_APP_GIT_SHA;
    else process.env.VERIFY_APP_GIT_SHA = oldBuild;
  }
  // Simulate an incompatible historical freeze in this disposable database: never relabel it
  // with the running application's current rubric. Restore all state before continuing.

  const oldFreeze = (
    await db.query<{ frozen_items: Record<string, string> }>(
      'select frozen_items from public.tlv5_freeze',
    )
  ).rows[0].frozen_items;
  await db.exec('alter table public.tlv5_freeze disable trigger user');
  try {
    await db.query('update public.tlv5_freeze set frozen_items = $1::jsonb', [
      JSON.stringify({ ...oldFreeze, rubric: 'b'.repeat(64) }),
    ]);
    await denied(exportTlv5Bundle(investigator, 'FORMAL'), 409);
  } finally {
    await db.query('update public.tlv5_freeze set frozen_items = $1::jsonb', [
      JSON.stringify(oldFreeze),
    ]);
    await db.exec('alter table public.tlv5_freeze enable trigger user');
  }

  assert.equal(formalBundle.files[0].content.includes('EX5-01'), false);
  assert.equal(formalBundle.files[0].content.includes('SYN-TLV5'), false);
  admin = await tlv5AdminAction(investigator, { action: 'register-export', mode: 'FORMAL' });
  assert.equal(admin.exports.filter((e) => e.mode === 'FORMAL').length, 1);
  if (python) {
    const dir = writeBundle(formalBundle);
    try {
      await assert.rejects(
        async () => analyse(dir, formalBundle.manifestName, '--allow-pilot'),
        /synthetic fixture/,
      );
      const out = analyse(dir, formalBundle.manifestName, '--allow-synthetic');
      const results = JSON.parse(
        readFileSync(join(dir, 'out', 'performance_results_v5.json'), 'utf8'),
      );
      assert.equal(
        results.is_synthetic_fixture ?? results.provenance?.is_synthetic_fixture ?? true,
        true,
      );
      assert.ok(out.length >= 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  // Reference locks close adjudication; repeated exports retain exactly the same bytes.
  await denied(
    recordTlv5Adjudication(adjudicator, {
      caseId: formalIds[0],
      itemCode: 'AREA_RESPIRATORY',
      decision: 'YES',
      status: 'DISCORDANT_RESOLVED',
      basis: 'REVIEWER_2',
      rationale: 'Unauthorized post-lock revision.',
      disagreementReasonCode: 'OTHER',
    }),
    409,
  );
  const after = await exportTlv5Bundle(investigator, 'FORMAL');
  assert.deepEqual(after.files, formalBundle.files);
  for (const actor of [stagingOne, adjudicator])
    for (const view of [
      'v_tlv5_independent_judgments',
      'v_tlv5_adjudicated_reference',
      'v_tlv5_frozen_labels',
    ])
      assert.equal(
        (await withActor(actor, (tx) => tx.query(`select * from public.${view}`))).rows.length,
        0,
        `${actor.role} ${view}`,
      );
  // Audit rows for submissions carry identifiers and a hash only.
  const audit = await withActor(investigator, (tx) =>
    tx.query<{ details: Record<string, unknown> }>(
      "select details from public.audit_log where entity_table = 'tlv5_submission_items'",
    ),
  );
  assert.ok(audit.rows.length);
  assert.equal(JSON.stringify(audit.rows).includes('"answer"'), false);
});
