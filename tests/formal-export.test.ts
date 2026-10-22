import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import {
  buildV4SyntheticBundle,
  computeV4PredictionFileSha256FromDb,
  exportV4SyntheticBundleFromDb,
  renderV4SyntheticPredictions,
  verifyV4DatabaseIntegrity,
  type V4DbExportOptions,
  type V4DbQueryable,
  type V4Row,
  type V4SyntheticExportInput,
} from '../src/lib/formal-export';
import { sha256 } from '../src/lib/export';
import { applyTrialPacketUpgrades } from '../src/server/db';

// Fixture reader for the exact RFC-style CSV produced by the inspected Python generator.
function parseCsv(text: string): V4Row[] {
  const records: string[][] = [];
  let row: string[] = [],
    field = '',
    quoted = false;
  for (let i = 0; i < text.length; i++) {
    const character = text[i];
    if (character === '"') {
      if (quoted && text[i + 1] === '"') {
        field += '"';
        i++;
      } else quoted = !quoted;
    } else if (!quoted && (character === ',' || character === '\n')) {
      row.push(field);
      field = '';
      if (character === '\n') {
        records.push(row);
        row = [];
      }
    } else field += character;
  }
  assert.equal(quoted, false);
  const columns = records.shift()!;
  return records.map((values) =>
    Object.fromEntries(columns.map((column, i) => [column, values[i] === '' ? null : values[i]])),
  );
}

function fixture(): V4SyntheticExportInput {
  const directory = join(process.cwd(), 'analysis/fixtures');
  const read = (name: string) => parseCsv(readFileSync(join(directory, name), 'utf8'));
  return {
    manifest: JSON.parse(
      readFileSync(join(directory, 'synthetic_v4_bundle.manifest.json'), 'utf8'),
    ),
    independentJudgments: read('synthetic_v4_independent_judgments.csv'),
    adjudicatedReference: read('synthetic_v4_adjudicated_reference.csv'),
    frozenPredictions: read('synthetic_v4_frozen_predictions.csv'),
    integrity: { frozenPredictionsMatch: true, judgmentSnapshotMatch: true },
  };
}

test('formal-format synthetic writer reproduces inspected fixture CSV bytes and freeze hashes', () => {
  const data = fixture();
  const result = buildV4SyntheticBundle(data);
  for (const file of result.files) {
    assert.equal(file.content, readFileSync(join('analysis/fixtures', file.name), 'utf8'));
    assert.equal(file.sha256, sha256(file.content));
    assert.equal(file.rows, parseCsv(file.content).length);
  }
  assert.equal(result.manifest_sha256, sha256(result.manifestContent));
  assert.match(result.notice, /SYNTHETIC ENGINEERING ONLY/);
  const reversed = structuredClone(data);
  reversed.independentJudgments.reverse();
  reversed.adjudicatedReference.reverse();
  reversed.frozenPredictions.reverse();
  assert.deepEqual(buildV4SyntheticBundle(reversed), result);
  assert.equal(
    sha256(renderV4SyntheticPredictions(data.frozenPredictions)),
    data.manifest.frozen_prediction_set_sha256,
  );
});

test('writer preserves quoting, explicit indeterminate decisions and absent unresolved references', () => {
  const data = fixture();
  data.independentJudgments[0].descriptor_name = 'Synthetic, "quoted"\nsecond line';
  const bundle = buildV4SyntheticBundle(data);
  const independent = parseCsv(bundle.files[0].content);
  assert.equal(independent[0].descriptor_name, data.independentJudgments[0].descriptor_name);
  const reference = parseCsv(bundle.files[1].content);
  assert.ok(reference.some((row) => row.adjudicated_decision === 'INSUFFICIENT_INFORMATION'));
  const unresolved = reference.filter((row) => row.adjudication_status === 'UNRESOLVED_ESCALATED');
  assert.ok(unresolved.length > 0);
  assert.ok(unresolved.every((row) => row.adjudicated_decision === null));
});

test('writer refuses pilot/real data, mismatched snapshots, missing metadata and changed frozen files', () => {
  const mutate = (change: (input: V4SyntheticExportInput) => void, message: RegExp) => {
    const input = fixture();
    change(input);
    assert.throws(() => buildV4SyntheticBundle(input), message);
  };
  mutate((input) => {
    input.manifest.is_synthetic_fixture = false;
  }, /locked synthetic/);
  mutate((input) => {
    input.manifest.reference_locked = false;
  }, /locked synthetic/);
  mutate((input) => {
    input.integrity.judgmentSnapshotMatch = false;
  }, /integrity/);
  mutate((input) => {
    input.integrity.frozenPredictionsMatch = false;
  }, /integrity/);
  mutate((input) => {
    delete input.manifest.rubric_sha256;
  }, /metadata/);
  mutate((input) => {
    input.manifest.frozen_sample_case_list_sha256 = '0'.repeat(64);
  }, /Case list/);
  mutate((input) => {
    input.frozenPredictions[0].tier0_binary = 'INCLUDE';
  }, /Prediction file/);
  mutate((input) => {
    input.independentJudgments.pop();
    input.independentJudgments.pop();
  }, /populations/);
  mutate((input) => {
    input.independentJudgments.push(input.independentJudgments[0]);
  }, /Duplicate/);
  mutate((input) => {
    input.independentJudgments[0].record_category = 'SYNTHETIC_PILOT';
  }, /pilot records/);
  mutate((input) => {
    input.independentJudgments[0].nct_id = 'NCT' + '12345678';
  }, /registry/);
  mutate((input) => {
    input.frozenPredictions[0].sampling_weight = 1 as unknown as string;
  }, /database text/);
});

test('writer rejects malformed provenance hashes without normalizing or substituting values', () => {
  const keys = [
    'freeze_manifest_sha256',
    'frozen_sample_case_list_sha256',
    'frozen_prediction_set_sha256',
    'ontology_sha256',
    'tier1_decision_file_sha256',
    'tier0_mapping_sha256',
    'rubric_sha256',
    'provenance_audit_sha256',
  ];
  const malformed = [
    'unknown',
    'A'.repeat(64),
    'g'.repeat(64),
    'a'.repeat(63),
    'a'.repeat(65),
    ' ' + 'a'.repeat(64),
    'a'.repeat(64) + '\n',
  ];
  for (const key of keys) {
    for (const value of malformed) {
      const input = fixture();
      input.manifest[key] = value;
      assert.throws(() => buildV4SyntheticBundle(input), /64-character lowercase SHA-256/, key);
      assert.equal(input.manifest[key], value);
    }
  }
});

test(
  'TypeScript-written v4 bundle passes Python integrity validation and paired synthetic analysis',
  {
    skip:
      !process.env.VERIFY_ANALYSIS_PYTHON &&
      'Set VERIFY_ANALYSIS_PYTHON to a Python environment with analysis/requirements.txt',
  },
  () => {
    const directory = mkdtempSync(join(tmpdir(), 'verify-v4-roundtrip-'));
    try {
      const input = fixture();
      const result = buildV4SyntheticBundle(input);
      for (const file of result.files)
        writeFileSync(join(directory, file.name), file.content, 'utf8');
      const manifest = join(directory, 'bundle.manifest.json');
      writeFileSync(manifest, result.manifestContent, 'utf8');
      const code = [
        'import json, sys',
        'from analysis import performance_analysis_v4 as pa4',
        'from analysis import performance_analysis_v3 as pa3',
        'res = pa4.run(sys.argv[1], allow_synthetic=True)',
        "assert res['is_synthetic_fixture'] is True",
        "assert 'SYNTHETIC ENGINEERING ONLY' in res['notice']",
        "assert len(res['integrity_checks_passed']) == 8",
        "for level in ('DESCRIPTOR_LEVEL', 'TRIAL_LEVEL'):",
        ' for rule in pa3.DENOMINATOR_RULES:',
        "  block=res['accuracy'][level][rule]",
        "  assert block['original_technical']['n_binary_pairs'] == block['curated_v11']['n_binary_pairs']",
        "print(json.dumps({'passed': True, 'integrity_checks': len(res['integrity_checks_passed'])}))",
      ].join('\n');
      const output = execFileSync(process.env.VERIFY_ANALYSIS_PYTHON!, ['-c', code, manifest], {
        encoding: 'utf8',
        cwd: process.cwd(),
        timeout: 60000,
      });
      assert.deepEqual(JSON.parse(output), { passed: true, integrity_checks: 8 });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test('writer validates extension approval metadata and unit_type/determination_level consistency', () => {
  const base = fixture();

  // Reject non-empty amendment_id when extension_approved_by_amendment is false
  const badUnapprovedAmendment = structuredClone(base);
  badUnapprovedAmendment.manifest.amendment_id = 'SYN-AMEND-01';
  assert.throws(
    () => buildV4SyntheticBundle(badUnapprovedAmendment),
    /amendment_id must be empty when extension_approved_by_amendment is false/,
  );

  // Reject extension_approved_by_amendment = true when no HELDOUT_EXTENSION_APPROVED records exist
  const badApprovedWithoutRecords = structuredClone(base);
  badApprovedWithoutRecords.manifest.extension_approved_by_amendment = true;
  badApprovedWithoutRecords.manifest.amendment_id = 'SYN-AMEND-01';
  assert.throws(
    () => buildV4SyntheticBundle(badApprovedWithoutRecords),
    /no HELDOUT_EXTENSION_APPROVED records are present/,
  );

  // Reject DESCRIPTOR_AREA row carrying an nct_id
  const badDescriptorNct = structuredClone(base);
  const descIdx = badDescriptorNct.independentJudgments.findIndex(
    (r) => r.unit_type === 'DESCRIPTOR_AREA',
  );
  badDescriptorNct.independentJudgments[descIdx].nct_id = 'SYN-NCT-9999';
  assert.throws(
    () => buildV4SyntheticBundle(badDescriptorNct),
    /DESCRIPTOR_AREA rows must not carry a trial nct_id/,
  );

  // Accept valid protocol-amendment-approved extension records (HO4R-TESTFX-*)
  const extInput = structuredClone(base);
  const targetCase = String(
    extInput.frozenPredictions.find((r) => r.unit_type === 'DESCRIPTOR_AREA')!.case_id,
  );
  const extCase = 'HO4R-TESTFX-99';
  for (const row of extInput.frozenPredictions) {
    if (row.case_id === targetCase) {
      row.case_id = extCase;
      row.record_category = 'HELDOUT_EXTENSION_APPROVED';
    }
  }
  for (const row of extInput.independentJudgments) {
    if (row.case_id === targetCase) {
      row.case_id = extCase;
      row.record_category = 'HELDOUT_EXTENSION_APPROVED';
    }
  }
  for (const row of extInput.adjudicatedReference) {
    if (row.case_id === targetCase) {
      row.case_id = extCase;
      row.record_category = 'HELDOUT_EXTENSION_APPROVED';
    }
  }
  const cases = [...new Set(extInput.frozenPredictions.map((r) => String(r.case_id)))].sort();
  extInput.manifest.frozen_sample_case_list_sha256 = sha256(cases.join('\n'));
  extInput.manifest.frozen_prediction_set_sha256 = sha256(
    renderV4SyntheticPredictions(extInput.frozenPredictions),
  );
  extInput.manifest.extension_approved_by_amendment = true;
  extInput.manifest.amendment_id = 'SYN-AMEND-01';

  const extBundle = buildV4SyntheticBundle(extInput);
  assert.equal(extBundle.manifest.extension_approved_by_amendment, true);
  assert.equal(extBundle.manifest.amendment_id, 'SYN-AMEND-01');
});

test('database export requires an explicit build commit before reading provenance', async () => {
  const neverQueried: V4DbQueryable = {
    query: async () => {
      assert.fail('Invalid build identity must be rejected before querying the database');
    },
  };
  for (const appGitSha of ['', 'abc123', '0'.repeat(40), 'A'.repeat(40), 'not-a-commit']) {
    await assert.rejects(
      exportV4SyntheticBundleFromDb(neverQueried, { appGitSha }),
      /explicit nonzero 40-character lowercase Git commit SHA/,
    );
  }
  await assert.rejects(
    exportV4SyntheticBundleFromDb(neverQueried, {} as V4DbExportOptions),
    /explicit nonzero 40-character lowercase Git commit SHA/,
  );
});

test('database-to-v4-export-to-Python round-trip obtains integrity flags from DB RPCs and validates in Python', async () => {
  const db = new PGlite({ extensions: { pgcrypto } });
  await db.waitReady;
  try {
    for (const file of [
      'supabase_test_shim/auth_shim.sql',
      'schema.sql',
      'migrations/0002_v3_review_design.sql',
      'migrations/0003_v4_record_categories_module_b.sql',
      'migrations/0004_synthetic_verify_workflow.sql',
      'migrations/0005_review_integrity_fixes.sql',
      'migrations/0006_reference_integrity.sql',
      'migrations/0007_frozen_contract_guards.sql',
    ]) {
      await db.exec(await readFile(file, 'utf8'));
    }
    await applyTrialPacketUpgrades(db);

    const ACTORS = {
      investigator: '00000000-0000-4000-8000-0000000000b1',
      pilotA: '00000000-0000-4000-8000-0000000000b2',
      pilotB: '00000000-0000-4000-8000-0000000000b3',
      reviewerA: '00000000-0000-4000-8000-0000000000b4',
      reviewerB: '00000000-0000-4000-8000-0000000000b5',
      adjudicator: '00000000-0000-4000-8000-0000000000b6',
    } as const;
    type Role = keyof typeof ACTORS;
    const ATT = 'Synthetic database-to-v4-export engineering verification.';
    // Explicit fictional build identity for this engineering fixture, never an inferred default.
    const exportOptions = { appGitSha: 'e'.repeat(40) };
    const j = JSON.stringify;

    for (const [role, id] of Object.entries(ACTORS)) {
      const email = `syn-${role.toLowerCase()}@example.invalid`;
      const appRole =
        role === 'investigator'
          ? 'INVESTIGATOR'
          : role === 'adjudicator'
            ? 'ADJUDICATOR'
            : 'REVIEWER';
      await db.query('insert into auth.users(id,email) values($1,$2)', [id, email]);
      await db.query(
        'insert into public.users(user_id,auth_uid,email,display_name,role,is_pilot_test_account) values($1,$1,$2,$3,$4,$5)',
        [id, email, `Synthetic ${role}`, appRole, role.startsWith('pilot')],
      );
    }

    const asRole = <T = unknown>(who: Role, sql: string, params: unknown[] = []): Promise<T> =>
      db.transaction(async (tx) => {
        await tx.exec('set local role authenticated');
        await tx.query("select set_config('request.jwt.claims',$1,true)", [
          j({ sub: ACTORS[who], aal: 'aal2' }),
        ]);
        const res = await tx.query<Record<string, T>>(sql, params);
        return Object.values(res.rows[0] ?? {})[0];
      });

    const investigatorQueryable: V4DbQueryable = {
      query: <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
        db.transaction(async (tx) => {
          await tx.exec('set local role authenticated');
          await tx.query("select set_config('request.jwt.claims',$1,true)", [
            j({ sub: ACTORS.investigator, aal: 'aal2' }),
          ]);
          return tx.query<T>(sql, params);
        }),
    };

    const pseudo = {} as Record<'pilotA' | 'pilotB' | 'reviewerA' | 'reviewerB', string>;
    for (const role of ['pilotA', 'pilotB'] as const) {
      pseudo[role] = await asRole<string>(
        'investigator',
        'select public.rpc_enroll_reviewer($1,$2,$3)',
        [ACTORS[role], 'PILOT', 'Synthetic pilot reviewer'],
      );
    }

    await asRole('investigator', 'select public.rpc_register_ontology_version($1)', [
      j({
        ontology_version: '1.0.0',
        rule_version: '1.0.0',
        rubric_version: 'R-TEST',
        classification_schema_version: '1.0.0',
        protocol_version: 'P-TEST',
        sampling_design_version: 'SYN-DB-V4',
        ontology_sha256: 'b'.repeat(64),
        classification_schema_sha256: 'c'.repeat(64),
        rubric_sha256: 'd'.repeat(64),
        frozen_at: '2026-10-20T00:00:00Z',
        notes: 'Synthetic engineering only',
      }),
    ]);

    const makeCase = (
      caseId: string,
      mode: 'PILOT' | 'FORMAL',
      unitType: 'DESCRIPTOR_AREA' | 'TRIAL_AREA',
      area: string,
      origDecision: 'INCLUDE' | 'EXCLUDE',
      nctId?: string,
    ) => ({
      case_id: caseId,
      mode,
      unit_type: unitType,
      version_set_id: '1.0.0+R-TEST',
      l1_applicable: true,
      l2_applicable: false,
      l3_applicable: false,
      packet: {
        schema_version: '1.0',
        case_title: `Fictional ${caseId}`,
        question: 'Does this fictional unit belong?',
        unit: { unit_type: unitType, unit_id: `SYN-${caseId}::${area}` },
        descriptor: { descriptor_ui: `SYN-${caseId}`, name: `Fictional descriptor ${caseId}` },
        mesh: { scope_note: 'SYNTHETIC ENGINEERING ONLY', tree_numbers: ['SYN.001'] },
        area: { key: area, label: `Fictional ${area}` },
        ...(unitType === 'TRIAL_AREA'
          ? { trial: { nct_id: nctId!, brief_title: `Fictional trial ${caseId}` } }
          : {}),
      },
      change_reason: 'Synthetic initial version',
      design: {
        unit_id: `SYN-${caseId}::${area}`,
        descriptor_ui: `SYN-${caseId}`,
        descriptor_name: `Fictional descriptor ${caseId}`,
        area,
        ...(unitType === 'TRIAL_AREA' ? { nct_id: nctId! } : {}),
        primary_stratum: 'SYN-STRATUM',
        selection_probability: 0.5,
        frame_stratum_size: 20,
        sampling_design_version: 'SYN-DB-V4',
        sampling_seed: 123,
        trial_frequency_weight: 1,
        n_trials_primary: 1,
        original_l1_decision: origDecision,
        source_file: 'synthetic',
        source_row_sha256: 'a'.repeat(64),
      },
    });

    // Complete 10-case pilot sign-off
    const pilotIds = Array.from({ length: 10 }, (_, i) => `SYN-${String(i + 1).padStart(3, '0')}`);
    for (const pid of pilotIds) {
      await asRole('investigator', 'select public.rpc_import_case($1)', [
        j(makeCase(pid, 'PILOT', 'DESCRIPTOR_AREA', 'infectious', 'INCLUDE')),
      ]);
    }
    for (const [slot, role] of (['pilotA', 'pilotB'] as const).entries()) {
      await asRole('investigator', 'select public.rpc_assign_cases($1,$2,$3,$4,$5)', [
        'PILOT',
        pseudo[role],
        slot + 1,
        pilotIds,
        101,
      ]);
      const rows = (
        await db.query<{ assignment_id: string }>(
          'select assignment_id from public.assignments where reviewer_pseudo_id=$1',
          [pseudo[role]],
        )
      ).rows;
      for (const r of rows) {
        await asRole(role, 'select public.rpc_submit_review($1,$2)', [
          r.assignment_id,
          j({
            l1_decision: 'INCLUDE',
            l1_rationale: 'Synthetic pilot judgment.',
            l1_uncertain: false,
          }),
        ]);
      }
    }
    for (const pid of pilotIds) {
      await asRole(
        'investigator',
        "select public.rpc_record_adjudication($1,'clinical_classification','INCLUDE',null,'CONCORDANT_CONFIRMED','BOTH_REVIEWERS','Synthetic pilot adjudication',null,array(select review_id from public.v_effective_reviews where case_id=$1),null,null,false)",
        [pid],
      );
    }
    const pilotExportId = await asRole('investigator', 'select public.rpc_register_export($1)', [
      j({
        mode: 'PILOT',
        export_type: 'ANALYSIS',
        export_format_version: '1',
        version_set_id: '1.0.0+R-TEST',
        ontology_version: '1.0.0',
        rule_version: '1.0.0',
        rubric_version: 'R-TEST',
        classification_schema_version: '1.0.0',
        sampling_design_version: 'SYN-DB-V4',
        app_git_sha: 'abc123',
        row_counts: { rows: 10 },
        file_sha256: { 'synthetic.csv': '2'.repeat(64) },
      }),
    ]);
    await asRole('investigator', 'select public.rpc_unlock_formal_review($1,$2,$3,$4,$5)', [
      'SYN-PILOT-CHECKLIST',
      '1'.repeat(64),
      'abc123',
      pilotExportId,
      ATT,
    ]);
    for (const role of ['reviewerA', 'reviewerB'] as const) {
      pseudo[role] = await asRole<string>(
        'investigator',
        'select public.rpc_enroll_reviewer($1,$2,$3)',
        [ACTORS[role], 'FORMAL', 'Synthetic formal reviewer'],
      );
    }

    // Activate v4 and record an approved synthetic extension amendment before freeze
    await asRole('investigator', 'select public.rpc_activate_design_v4($1,$2,$3)', [
      'SYN-DB-V4',
      'DISAGREEMENTS_ONLY',
      ATT,
    ]);
    await asRole('investigator', 'select public.rpc_register_amendment_v4($1)', [
      j({
        amendment_id: 'AMD4-TESTFX-EXT1',
        purpose: 'ADOPT_EXTENSION_30',
        description:
          'Synthetic engineering test of protocol-amendment-approved extension case workflow.',
      }),
    ]);

    // Register 4 held-out cases: 3 DESCRIPTOR_AREA (including 1 extension case) + 1 two-step TRIAL_AREA case
    const formalSpecs = [
      {
        id: 'HO4-TESTFX-001',
        cat: 'HELDOUT_FORMAL',
        ut: 'DESCRIPTOR_AREA' as const,
        area: 'infectious',
        t0: 'INCLUDE' as const,
        t1Raw: 'INCLUDE',
        t1Bin: 'INCLUDE' as const,
        r1: 'INCLUDE' as const,
        r2: 'INCLUDE' as const,
      },
      {
        id: 'HO4-TESTFX-002',
        cat: 'HELDOUT_FORMAL',
        ut: 'DESCRIPTOR_AREA' as const,
        area: 'oncology',
        t0: 'INCLUDE' as const,
        t1Raw: 'EXCLUDE',
        t1Bin: 'EXCLUDE' as const,
        r1: 'EXCLUDE' as const,
        r2: 'INCLUDE' as const,
      },
      {
        id: 'HO4-TESTFX-003',
        cat: 'HELDOUT_FORMAL',
        ut: 'TRIAL_AREA' as const,
        area: 'cardiovascular',
        nct: 'SYN-NCT-0003',
        t0: 'EXCLUDE' as const,
        t1Raw: 'CONTEXT_DEPENDENT',
        t1Bin: 'INCLUDE' as const,
        stageC: 'INCLUDE',
        r1: 'INCLUDE' as const,
        r2: 'INCLUDE' as const,
      },
      {
        id: 'HO4R-TESTFX-004',
        cat: 'HELDOUT_EXTENSION_APPROVED',
        ut: 'DESCRIPTOR_AREA' as const,
        area: 'respiratory',
        t0: 'EXCLUDE' as const,
        t1Raw: 'EXCLUDE',
        t1Bin: 'EXCLUDE' as const,
        r1: 'EXCLUDE' as const,
        r2: 'EXCLUDE' as const,
      },
    ];

    const predictionsPayload: Record<string, unknown>[] = [];
    for (const s of formalSpecs) {
      await asRole('investigator', 'select public.rpc_import_case($1)', [
        j(makeCase(s.id, 'FORMAL', s.ut, s.area, s.t0, s.nct)),
      ]);
      await asRole('investigator', 'select public.rpc_set_case_design_v3($1)', [
        j({
          case_id: s.id,
          mode: 'FORMAL',
          review_module: 'ONTOLOGY_AREA',
          analysis_set: 'VALIDATION_HELDOUT',
          selection_stratum: 'SYN-STRATUM',
          variance_stratum: s.ut === 'TRIAL_AREA' ? 'SYN-VAR-TRIAL' : 'SYN-VAR-DESC',
          variance_stratum_size: 20,
          selection_probability: 0.25,
          comparison_cell_v11: 'OPOS_CPOS',
          original_binary: s.t0,
          curated_v11_status_raw: s.t1Raw,
          curated_v11_binary: s.t1Bin,
          two_step_required: s.ut === 'TRIAL_AREA',
          sampling_design_version: 'SYN-DB-V4',
        }),
      ]);
      await asRole('investigator', 'select public.rpc_record_heldout_case_v4($1)', [
        j({
          case_id: s.id,
          record_category: s.cat,
          frame_unit_id: `SYN-FRAME-${s.id}`,
          impact_tier: 'STANDARD',
          policy_governed_neoplasm_gen06: s.area === 'oncology',
          provenance_audit_result: 'NO_DEVELOPMENT_FLAG',
          ...(s.cat === 'HELDOUT_EXTENSION_APPROVED' ? { amendment_id: 'AMD4-TESTFX-EXT1' } : {}),
        }),
      ]);
      if (s.ut === 'TRIAL_AREA') {
        await asRole('investigator', 'select public.rpc_add_trial_context_packet($1,$2)', [
          s.id,
          j({
            schema_version: '1.0',
            trial: {
              nct_id: s.nct,
              brief_title: `Fictional Step-2 context for ${s.id}`,
              conditions: ['Fictional cardiovascular condition'],
              summary: 'Synthetic Step-2 trial context packet.',
            },
            notices: ['SYNTHETIC ENGINEERING ONLY'],
          }),
        ]);
        predictionsPayload.push(
          {
            prediction_set_id: 'SYN-PRED-DB-V4',
            case_id: s.id,
            determination_level: 'DESCRIPTOR_LEVEL_IN_TRIAL_CASE',
            tier0_binary: s.t0,
            tier1_version: 'v1.1',
            tier1_status_raw: s.t1Raw,
            tier1_binary: s.t0,
          },
          {
            prediction_set_id: 'SYN-PRED-DB-V4',
            case_id: s.id,
            determination_level: 'TRIAL_LEVEL',
            tier0_binary: s.t0,
            tier1_version: 'v1.1',
            tier1_status_raw: s.t1Raw,
            tier1_binary: s.t1Bin,
            stage_c_trial_status: s.stageC,
          },
        );
      } else {
        predictionsPayload.push({
          prediction_set_id: 'SYN-PRED-DB-V4',
          case_id: s.id,
          determination_level: 'DESCRIPTOR_LEVEL',
          tier0_binary: s.t0,
          tier1_version: 'v1.1',
          tier1_status_raw: s.t1Raw,
          tier1_binary: s.t1Bin,
        });
      }
    }

    await asRole('investigator', 'select public.rpc_import_frozen_predictions_v4($1)', [
      j(predictionsPayload),
    ]);
    await asRole('investigator', 'select public.rpc_freeze_sample_manifest($1)', [
      j({
        review_module: 'ONTOLOGY_AREA',
        sampling_design_version: 'SYN-DB-V4',
        manifest_file_sha256: '3'.repeat(64),
        decision_file_v11_sha256: '4'.repeat(64),
        sampling_seed: 123,
        attestation: ATT,
      }),
    ]);

    // Compute prediction_file_sha256 directly from the database pre-freeze predictions
    const predictionFileSha256 = await computeV4PredictionFileSha256FromDb(investigatorQueryable);

    await asRole('investigator', 'select public.rpc_freeze_v4($1)', [
      j({
        tier1_version: 'v1.1',
        prediction_file_sha256: predictionFileSha256,
        extension_amendment_id: 'AMD4-TESTFX-EXT1',
        frozen_items: {
          ontology_sha256: 'b'.repeat(64),
          tier1_decision_file_sha256: '2'.repeat(64),
          tier0_mapping_sha256: '3'.repeat(64),
          rubric_sha256: 'd'.repeat(64),
          provenance_audit_sha256: '5'.repeat(64),
        },
        attestation: ATT,
      }),
    ]);

    // Assign and submit formal reviews (including two-step trial review and a pre-close revision)
    const formalCaseIds = formalSpecs.map((s) => s.id);
    for (const [slot, role] of (['reviewerA', 'reviewerB'] as const).entries()) {
      await asRole('investigator', 'select public.rpc_assign_cases($1,$2,$3,$4,$5)', [
        'FORMAL',
        pseudo[role],
        slot + 1,
        formalCaseIds,
        202,
      ]);
      const assignments = (
        await db.query<{ assignment_id: string; case_id: string }>(
          "select assignment_id, case_id from public.assignments where mode='FORMAL' and reviewer_pseudo_id=$1 order by case_id",
          [pseudo[role]],
        )
      ).rows;
      for (const a of assignments) {
        const spec = formalSpecs.find((s) => s.id === a.case_id)!;
        const decision = slot === 0 ? spec.r1 : spec.r2;
        if (spec.ut === 'TRIAL_AREA') {
          await asRole(role, 'select public.rpc_record_trial_step1($1,$2)', [
            a.assignment_id,
            j({
              step1_decision: decision,
              step1_rationale: 'Synthetic Step-1 descriptor decision in trial case.',
              step1_uncertain: false,
            }),
          ]);
        }
        await asRole(role, 'select public.rpc_submit_review($1,$2)', [
          a.assignment_id,
          j({
            l1_decision: decision,
            l1_rationale: 'Synthetic initial formal submission.',
            l1_uncertain: false,
          }),
        ]);
        // Submit a pre-close revision on HO4-TESTFX-002 for reviewerA
        if (a.case_id === 'HO4-TESTFX-002' && slot === 0) {
          await asRole(role, 'select public.rpc_submit_review($1,$2)', [
            a.assignment_id,
            j({
              l1_decision: decision,
              l1_rationale: 'Synthetic revised rationale retaining formal decision.',
              l1_uncertain: true,
            }),
          ]);
        }
      }
    }

    await asRole('investigator', 'select public.rpc_close_formal_review($1,$2)', [true, ATT]);
    await asRole('investigator', 'select public.rpc_snapshot_judgments_v4()');

    // Adjudicate the discordant case HO4-TESTFX-002 (concordant cases enter by rule under DISAGREEMENTS_ONLY)
    const consideredIds = (
      await db.query<{ review_id: string }>(
        "select review_id from public.v_effective_reviews where case_id='HO4-TESTFX-002'",
      )
    ).rows.map((r) => r.review_id);
    await asRole('adjudicator', 'select public.rpc_record_adjudication_v3($1)', [
      j({
        case_id: 'HO4-TESTFX-002',
        determination_level: 'DESCRIPTOR_LEVEL',
        layer: 'clinical_classification',
        decision: 'EXCLUDE',
        status: 'DISCORDANT_RESOLVED',
        basis: 'REVIEWER_1',
        reason_code: 'CONSTRUCT_BOUNDARY',
        rationale: 'Synthetic blinded adjudication resolving discordance.',
        considered_ids: consideredIds,
      }),
    ]);

    await asRole('investigator', 'select public.rpc_lock_reference_v4($1)', [ATT]);

    // Verify database integrity directly via the DB RPCs
    const integrity = await verifyV4DatabaseIntegrity(investigatorQueryable);
    assert.equal(integrity.frozenPredictionsMatch, true);
    assert.equal(integrity.judgmentSnapshotMatch, true);

    // Export full bundle from DB views/RPCs
    const bundle = await exportV4SyntheticBundleFromDb(investigatorQueryable, exportOptions);
    assert.equal(bundle.manifest.app_git_sha, exportOptions.appGitSha);
    assert.equal(bundle.manifest.ontology_version, '1.0.0');
    assert.equal(bundle.manifest.ontology_sha256, 'b'.repeat(64));
    assert.equal(bundle.manifest.rubric_version, 'R-TEST');
    assert.equal(bundle.manifest.rubric_sha256, 'd'.repeat(64));
    assert.equal(bundle.manifest.sampling_design_version, 'SYN-DB-V4');
    assert.equal(bundle.manifest.db_schema_version, '4.0.6-canonical-packet-lock-state');
    assert.equal(bundle.manifest.extension_approved_by_amendment, true);
    assert.equal(bundle.manifest.amendment_id, 'AMD4-TESTFX-EXT1');
    assert.equal(bundle.files[0].rows, 10); // 3 descriptor cases * 2 + 1 trial case * 2 levels * 2 reviewers
    assert.equal(bundle.files[1].rows, 5); // 5 case levels
    assert.equal(bundle.files[2].rows, 5); // 5 prediction rows

    // A later development version is legitimate, but cannot relabel the evaluated cases.
    await asRole('investigator', 'select public.rpc_register_ontology_version($1)', [
      j({
        ontology_version: '1.0.1-DVF',
        rule_version: '1.0.1',
        rubric_version: 'R-NEXT',
        classification_schema_version: '1.0.0',
        protocol_version: 'P-TEST',
        sampling_design_version: 'SYN-NEXT',
        ontology_sha256: '6'.repeat(64),
        classification_schema_sha256: '7'.repeat(64),
        rubric_sha256: '8'.repeat(64),
        frozen_at: new Date().toISOString(),
        notes: 'Synthetic later development version, excluded from this evaluation',
      }),
    ]);
    assert.deepEqual(
      await exportV4SyntheticBundleFromDb(investigatorQueryable, exportOptions),
      bundle,
    );

    // Compatibility options assert registered values; none can rewrite frozen provenance.
    for (const option of [
      'ontologyVersion',
      'rubricVersion',
      'samplingDesignVersion',
      'dbSchemaVersion',
      'formalPhaseOpenedAt',
    ] as const) {
      await assert.rejects(
        exportV4SyntheticBundleFromDb(investigatorQueryable, {
          ...exportOptions,
          [option]: 'SYN-CONTRADICTORY-PROVENANCE',
        }),
        /assertion differs from frozen database provenance/,
      );
    }
    assert.deepEqual(
      await exportV4SyntheticBundleFromDb(investigatorQueryable, {
        ...exportOptions,
        ontologyVersion: '1.0.0',
        rubricVersion: 'R-TEST',
        samplingDesignVersion: 'SYN-DB-V4',
        dbSchemaVersion: '4.0.6-canonical-packet-lock-state',
        formalPhaseOpenedAt: String(bundle.manifest.formal_phase_opened_at),
      }),
      bundle,
    );

    // This simulates a malformed legacy freeze without rewriting any actual study data.
    // Matching prediction/snapshot RPCs alone do not prove version provenance.
    for (const [key, registeredHash] of [
      ['ontology_sha256', 'b'.repeat(64)],
      ['rubric_sha256', 'd'.repeat(64)],
    ] as const) {
      await db.exec('set session_replication_role = replica');
      await db.query(
        'update public.freeze_manifests_v4 set frozen_items = jsonb_set(frozen_items, array[$1], to_jsonb($2::text))',
        [key, 'f'.repeat(64)],
      );
      await db.exec('set session_replication_role = origin');
      await assert.rejects(
        exportV4SyntheticBundleFromDb(investigatorQueryable, exportOptions),
        /Frozen ontology\/rubric hashes differ from the registered case versions/,
      );
      await db.exec('set session_replication_role = replica');
      await db.query(
        'update public.freeze_manifests_v4 set frozen_items = jsonb_set(frozen_items, array[$1], to_jsonb($2::text))',
        [key, registeredHash],
      );
      await db.exec('set session_replication_role = origin');
    }

    // Missing, mixed or later registrations cannot silently replace the evaluated version.
    for (const versionSetId of ['SYN-MISSING-REGISTRATION', '1.0.1-DVF+R-NEXT']) {
      await db.exec('set session_replication_role = replica');
      await db.query(
        "update public.case_versions set version_set_id=$1 where case_id='HO4-TESTFX-002'",
        [versionSetId],
      );
      await db.exec('set session_replication_role = origin');
      await assert.rejects(
        exportV4SyntheticBundleFromDb(investigatorQueryable, exportOptions),
        /Frozen cases must share one complete ontology\/rubric registration predating freeze/,
      );
      await db.exec('set session_replication_role = replica');
      await db.query(
        "update public.case_versions set version_set_id='1.0.0+R-TEST' where case_id='HO4-TESTFX-002'",
      );
      await db.exec('set session_replication_role = origin');
    }

    // Negative test: if database judgment_snapshots_v4 or freeze_manifests_v4 mismatches,
    // verifyV4DatabaseIntegrity returns false from the DB RPC and exportV4SyntheticBundleFromDb refuses to export!
    const savedSnapshotHash = (
      await db.query<{ content_sha256: string }>(
        'select content_sha256 from public.judgment_snapshots_v4',
      )
    ).rows[0].content_sha256;
    await db.exec('set session_replication_role = replica');
    await db.query("update public.judgment_snapshots_v4 set content_sha256 = repeat('0', 64)");
    await db.exec('set session_replication_role = origin');
    const badIntegrity = await verifyV4DatabaseIntegrity(investigatorQueryable);
    assert.equal(badIntegrity.judgmentSnapshotMatch, false);
    assert.equal(badIntegrity.frozenPredictionsMatch, true);
    await assert.rejects(
      exportV4SyntheticBundleFromDb(investigatorQueryable, exportOptions),
      /Both database integrity verifications must match before export/,
    );
    await db.exec('set session_replication_role = replica');
    await db.query('update public.judgment_snapshots_v4 set content_sha256 = $1', [
      savedSnapshotHash,
    ]);
    await db.exec('set session_replication_role = origin');

    // Validate the DB-exported bundle in Python performance_analysis_v4
    if (process.env.VERIFY_ANALYSIS_PYTHON) {
      const directory = mkdtempSync(join(tmpdir(), 'verify-db-v4-roundtrip-'));
      try {
        for (const file of bundle.files) {
          writeFileSync(join(directory, file.name), file.content, 'utf8');
        }
        const manifestPath = join(directory, 'bundle.manifest.json');
        writeFileSync(manifestPath, bundle.manifestContent, 'utf8');
        const pyCode = [
          'import json, sys',
          'from analysis import performance_analysis_v4 as pa4',
          'res = pa4.run(sys.argv[1], allow_synthetic=True)',
          "assert res['is_synthetic_fixture'] is True",
          "assert res['counts']['cases'] == 4",
          "assert res['counts']['record_categories'] == {'HELDOUT_FORMAL': 3, 'HELDOUT_EXTENSION_APPROVED': 1}",
          "assert len(res['integrity_checks_passed']) == 8",
          "print(json.dumps({'ok': True, 'cases': res['counts']['cases'], 'checks': len(res['integrity_checks_passed'])}))",
        ].join('\n');
        const out = execFileSync(process.env.VERIFY_ANALYSIS_PYTHON, ['-c', pyCode, manifestPath], {
          encoding: 'utf8',
          cwd: process.cwd(),
          timeout: 60000,
        });
        assert.deepEqual(JSON.parse(out), { ok: true, cases: 4, checks: 8 });
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    }
  } finally {
    await db.close();
  }
});
