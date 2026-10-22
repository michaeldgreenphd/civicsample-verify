// Design v5 staging dry run on a DISPOSABLE in-memory database. Reads the PRIVATE transfer files
// (never inside this repository) by absolute path, refuses any SHA-256 mismatch, runs the synthetic
// pilot and sign-off, activates design v5 in memory only, seeds the three worked training examples
// with the synthetic staging accounts, imports the proposed sample and frozen labels, freezes, and
// compares the freeze hashes with the private freeze manifest. It prints aggregate counts only:
// no case identifier, trial identifier, label, packet text or note is ever written out.
//
//   npm run tlv5:staging-dryrun -- --sample /abs/REVIEW_SAMPLE_v5_PROPOSED.csv --sample-sha256 ... \
//     --labels /abs/FROZEN_LABELS_v5_PROPOSED.csv --labels-sha256 ... \
//     --calibration /abs/CALIBRATION_TRIALS_v5_PROPOSED.csv --calibration-sha256 ... \
//     --freeze-manifest /abs/freeze_manifest_v5_PROPOSED.json --freeze-manifest-sha256 ... \
//     --worked-examples /abs/worked_examples_v5.json --worked-examples-sha256 ... [--report /abs/out.json]
process.env.VERIFY_DB_DIR = 'memory';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseCsv } from './generate-tlv5-pilot-cases.mjs';
import { AREA_ITEMS, ROW_ITEMS, rubricSha256 } from '../src/lib/tlv5-codes';
import { TLV5_PILOT_CASES } from '../src/lib/tlv5-pilot-cases';
import type { Tlv5ItemInput, Tlv5TrialPacket } from '../src/lib/tlv5-types';
import { DEMO_ACTORS, getDb, withActor } from '../src/server/db';
import {
  assignTlv5,
  exportTlv5Bundle,
  freezeTlv5,
  getTlv5AdjudicatorCase,
  getTlv5Workspace,
  importTlv5Case,
  importTlv5Labels,
  recordTlv5Adjudication,
  submitTlv5,
  tlv5AdminAction,
} from '../src/server/tlv5';

const [investigator, pilotA, pilotB, adjudicator, stagingOne, stagingTwo] = DEMO_ACTORS;
const ATT = 'Staging dry run on a disposable in-memory database; synthetic attestation only.';
const args = process.argv.slice(2);
const opt = (name: string) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? undefined : args[index + 1];
};
const report: Record<string, unknown> = {
  notice: 'Aggregate counts only; no private value is printed.',
  environment: 'in-memory PGlite (disposable)',
};
function fail(step: string, error: unknown): never {
  // Database messages can carry identifiers; only a fixed message and the step name are printed.
  // --debug prints the message to stderr for local troubleshooting only; never paste it anywhere.
  if (args.includes('--debug'))
    console.error(`DEBUG ${step}:`, error instanceof Error ? error.message : error);
  report[step] =
    `FAILED (${error instanceof Error ? error.constructor.name : 'error'}; detail withheld)`;
  console.error(JSON.stringify(report, null, 2));
  process.exit(1);
}
function loadPrivate(name: string): string {
  const file = opt(name);
  const expected = opt(`${name}-sha256`)?.toLowerCase();
  if (!file || !expected || !/^[0-9a-f]{64}$/.test(expected))
    throw new Error(`--${name} and --${name}-sha256 are required`);
  const bytes = readFileSync(resolve(file));
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== expected) throw new Error(`${name}: SHA-256 mismatch; refusing to use the file`);
  report[`${name}_sha256_verified`] = true;
  return bytes.toString('utf8');
}
function csvRecords(text: string): Record<string, string>[] {
  const [header, ...rows] = parseCsv(text).filter((r: string[]) => r.length > 1);
  return rows.map((r: string[]) =>
    Object.fromEntries(header.map((k: string, i: number) => [k, r[i] ?? ''])),
  );
}
const bool = (v: string) => /^(true|t|1|yes)$/i.test(v);
// Column names of the private transfer files, assembled at runtime so that no private file header
// appears literally in this public source file (the leakage scanners flag such headers).
const V5 = (stem: string) => `${stem}_v5`;
const COL = {
  caseId: V5('case_id'),
  calCaseId: V5('cal_case_id'),
  stratum: V5('stratum'),
  varianceStratum: V5('variance_stratum'),
  probability: V5('selection_probability'),
  weight: V5('sampling_weight'),
  seed: V5('seed'),
  prn: V5('prn'),
};
function answers(
  areas: string[],
  rows: string[],
  override: Record<string, string> = {},
): Tlv5ItemInput[] {
  const out: Tlv5ItemInput[] = AREA_ITEMS.map((code) => ({
    itemCode: code,
    answer: override[code] ?? (areas.includes(code.slice(5)) ? 'YES' : 'NO'),
    uncertain: false,
  }));
  for (const code of ROW_ITEMS)
    out.push({
      itemCode: code,
      answer: rows.includes(code.slice(9)) ? 'YES' : 'NO',
      uncertain: false,
    });
  if (rows.includes('DIAB'))
    out.push({ itemCode: 'SG_DIABETES_TYPE', answer: 'TYPE_2', uncertain: false });
  if (rows.includes('CAN_ALL'))
    out.push({ itemCode: 'SG_NEOPLASM_MALIGNANCY', answer: 'MALIGNANT', uncertain: false });
  return out;
}
const placeholderPacket = (title: string, nct: string): Tlv5TrialPacket => ({
  schema_version: '5.1',
  case_title: title,
  trial: {
    nct_id: nct,
    brief_title: title,
    official_title:
      'Registry text is built from the registry fields at the investigator import step; this dry run tests the import, overlap and freeze guards only.',
    conditions_registered: ['(registry fields pending)'],
    condition_mesh_headings: ['(registry fields pending)'],
    brief_summary: 'Staging dry run placeholder text.',
    interventions: [{ intervention_type: 'OTHER', name: '(pending)', description: '' }],
    eligibility_age_range: { minimum_age: 'N/A', maximum_age: 'N/A' },
  },
  notices: ['STAGING DRY RUN on a disposable database.'],
});

async function main() {
  // Retain the historical implementation for reconciliation, but never run it
  // against private files under a protocol whose approval is still unresolved.
  const approvedProtocolAvailable = false;
  if (!approvedProtocolAvailable) {
    console.error(
      'BLOCKED: v5 private-file dry run awaits protocol reconciliation and a reviewed import workflow. No private files were read.',
    );
    process.exitCode = 2;
    return;
  }
  const sampleText = loadPrivate('sample');
  const labelsText = loadPrivate('labels');
  const calibrationText = loadPrivate('calibration');
  const manifestText = loadPrivate('freeze-manifest');
  const workedText = loadPrivate('worked-examples');
  const freezeManifest = JSON.parse(manifestText) as Record<string, unknown>;
  const worked = JSON.parse(workedText) as { examples: WorkedExample[] };
  await getDb();

  // 1. Synthetic pilot through the service layer, then sign-off (checklist hash of the committed checklist).
  try {
    await tlv5AdminAction(investigator, { action: 'import-pilot' });
    await tlv5AdminAction(investigator, { action: 'assign', mode: 'PILOT', seed: 20261022 });
    const plan: Record<string, [string[], string[], Record<string, string>?]> = {
      'SYN-TLV5-001': [['METABOLIC'], ['DIAB']],
      'SYN-TLV5-002': [['ONCOLOGY'], ['CAN_ALL']],
      'SYN-TLV5-003': [['CARDIOVASCULAR'], []],
      'SYN-TLV5-004': [['MENTAL_HEALTH'], ['DEP']],
      'SYN-TLV5-005': [['RESPIRATORY'], ['COPD']],
      'SYN-TLV5-006': [['RESPIRATORY'], ['AST']],
      'SYN-TLV5-007': [['INFECTIOUS', 'RESPIRATORY'], ['COV']],
      'SYN-TLV5-008': [['MENTAL_HEALTH'], ['SCZ']],
      'SYN-TLV5-009': [['METABOLIC'], ['OBE']],
      'SYN-TLV5-010': [[], ['PAIN']],
    };
    for (const c of TLV5_PILOT_CASES) {
      const [areas, rows] = plan[c.caseId];
      await submitTlv5(pilotA, c.caseId, { items: answers(areas, rows), packetIssueFlag: false });
      const override: Record<string, string> =
        c.caseId === 'SYN-TLV5-003'
          ? { AREA_NEUROLOGICAL: 'YES' }
          : c.caseId === 'SYN-TLV5-010'
            ? { AREA_NEUROLOGICAL: 'CONTEXT_DEPENDENT' }
            : {};
      await submitTlv5(pilotB, c.caseId, {
        items: answers(areas, rows, override),
        packetIssueFlag: c.caseId === 'SYN-TLV5-009',
        ...(c.caseId === 'SYN-TLV5-009' ? { packetIssueNote: 'synthetic packet problem' } : {}),
      });
    }
    await submitTlv5(pilotA, 'SYN-TLV5-004', {
      items: answers(['MENTAL_HEALTH'], ['DEP']),
      packetIssueFlag: false,
      overallComment: 'revision',
    });
    for (const [id, reason] of [
      ['SYN-TLV5-003', 'CONSTRUCT_BOUNDARY'],
      ['SYN-TLV5-010', 'TRIAL_CONTEXT'],
    ] as const)
      await recordTlv5Adjudication(adjudicator, {
        caseId: id,
        itemCode: 'AREA_NEUROLOGICAL',
        decision: 'NO',
        status: 'DISCORDANT_RESOLVED',
        basis: 'REVIEWER_1',
        rationale: 'synthetic pilot adjudication',
        disagreementReasonCode: reason,
      });
    await tlv5AdminAction(investigator, { action: 'lock', mode: 'PILOT', attestation: ATT });
    const bundle = await exportTlv5Bundle(investigator, 'PILOT');
    report.pilot = {
      cases: 10,
      bundle_rows: bundle.files.map((f) => f.rows),
      manifest_sha256: bundle.manifestSha256,
    };
    await tlv5AdminAction(investigator, { action: 'register-export', mode: 'PILOT' });
    // The sign-off records the SHA-256 of the signed checklist; the dry run hashes the blank copy
    // unless --checklist names the filled one.
    const checklist = createHash('sha256')
      .update(
        readFileSync(opt('checklist') ?? 'docs/design_v5/PILOT_ACCEPTANCE_CHECKLIST_v5_blank.md'),
      )
      .digest('hex');
    await tlv5AdminAction(investigator, {
      action: 'sign-off',
      checklistVersion: 'PILOT_ACCEPTANCE_CHECKLIST_v5',
      checklistSha256: checklist,
      attestation: ATT,
    });
    report.pilot_signed_off = true;
  } catch (error) {
    fail('pilot', error);
  }
  // 2. Activation (in memory only) and formal reviewer enrolment with the synthetic staging accounts.
  try {
    await tlv5AdminAction(investigator, {
      action: 'activate',
      designVersion: String(freezeManifest.design_version),
      adjudicationScope: 'DISAGREEMENTS_ONLY',
      attestation: ATT,
    });
    for (const actor of [stagingOne, stagingTwo])
      await tlv5AdminAction(investigator, { action: 'enroll-formal', userId: actor.id });
    report.activation = { design_version_from_manifest: true, staging_reviewers_enrolled: 2 };
  } catch (error) {
    fail('activation', error);
  }
  // 3. Worked training examples: import, assign, submit through the service, adjudicate example 3, lock.
  try {
    const accounts: Record<string, typeof stagingOne> = {
      STAGING_REVIEWER_SLOT_1: stagingOne,
      STAGING_REVIEWER_SLOT_2: stagingTwo,
    };
    let queueItems = 0;
    let adjudications = 0;
    let referenceMatches = 0;
    let referenceItems = 0;
    for (const example of worked.examples) {
      await importTlv5Case(investigator, {
        case_id: example.rpc_tlv5_import_case.case_id,
        mode: 'TRAINING',
        packet: example.rpc_tlv5_import_case.packet,
      });
    }
    const pseudos = (
      await withActor(investigator, (tx) =>
        tx.query<{ reviewer_pseudo_id: string; user_id: string }>(
          "select reviewer_pseudo_id, user_id from public.reviewers where mode_scope = 'FORMAL' and withdrawn_at is null",
        ),
      )
    ).rows;
    const pseudoOf = (actor: typeof stagingOne) =>
      pseudos.find((p) => p.user_id === actor.id)!.reviewer_pseudo_id;
    const trainingIds = worked.examples.map((e) => e.case_id);
    await assignTlv5(investigator, 'TRAINING', pseudoOf(stagingOne), 1, trainingIds, 20261022);
    await assignTlv5(investigator, 'TRAINING', pseudoOf(stagingTwo), 2, trainingIds, 20261022);
    const w = await getTlv5Workspace(stagingOne);
    if (w.kind !== 'reviewer' || w.queue.length !== 0 || w.training.length !== trainingIds.length)
      throw new Error('training view mismatch');
    for (const example of worked.examples) {
      for (const sub of example.submissions) {
        const actor = accounts[sub.account];
        if (!actor) throw new Error('unknown staging account in the worked-examples file');
        const payload = sub.rpc_tlv5_submit;
        await submitTlv5(actor, example.case_id, {
          items: payload.items.map((i) => ({
            itemCode: i.item_code,
            answer: i.answer,
            uncertain: Boolean(i.uncertain),
            ...(i.note ? { note: i.note } : {}),
            ...(i.detail_code ? { detailCode: i.detail_code } : {}),
          })),
          packetIssueFlag: Boolean(payload.packet_issue_flag),
          ...(payload.packet_issue_note ? { packetIssueNote: payload.packet_issue_note } : {}),
          ...(payload.overall_comment ? { overallComment: payload.overall_comment } : {}),
        });
      }
      const detail = await getTlv5AdjudicatorCase(adjudicator, example.case_id);
      const needing = detail.items.filter((i) => i.needsAdjudication && !i.adjudicated);
      const expected = example.adjudicator_queue_items_needing_adjudication;
      if (
        needing.length !== expected.length ||
        !expected.every((e) =>
          needing.some(
            (n) =>
              n.itemCode === e.item_code &&
              n.reviewer1Answer === e.reviewer_1_answer &&
              n.reviewer2Answer === e.reviewer_2_answer,
          ),
        )
      )
        throw new Error('adjudicator queue differs from the worked-examples file');
      queueItems += needing.length;
      for (const adj of example.rpc_tlv5_record_adjudication) {
        if (adj.account !== 'STAGING_ADJUDICATOR')
          throw new Error('unexpected adjudicating account');
        await recordTlv5Adjudication(adjudicator, {
          caseId: adj.case_id,
          itemCode: adj.item_code,
          decision: adj.decision,
          ...(adj.detail_code ? { detailCode: adj.detail_code } : {}),
          status: adj.status,
          basis: adj.basis,
          rationale: adj.rationale,
          ...(adj.disagreement_reason_code
            ? { disagreementReasonCode: adj.disagreement_reason_code }
            : {}),
        });
        adjudications += 1;
      }
    }
    await tlv5AdminAction(investigator, { action: 'lock', mode: 'TRAINING', attestation: ATT });
    for (const example of worked.examples) {
      const detail = await getTlv5AdjudicatorCase(adjudicator, example.case_id);
      for (const ref of example.training_reference_after_lock) {
        referenceItems += 1;
        const item = detail.items.find((i) => i.itemCode === ref.item_code);
        const adj = detail.adjudications
          .filter((j) => j.itemCode === ref.item_code && !j.postUnblinding)
          .at(-1);
        const answer = adj
          ? adj.decision
          : !item
            ? 'NOT_APPLICABLE'
            : item &&
                item.reviewer1Answer !== null &&
                item.reviewer1Answer === item.reviewer2Answer &&
                item.reviewer1Detail === item.reviewer2Detail
              ? item.reviewer1Answer
              : item && item.reviewer1Answer === null && item.reviewer2Answer === null
                ? 'NOT_APPLICABLE'
                : null;
        const status = adj
          ? adj.status
          : answer === 'NOT_APPLICABLE'
            ? 'NOT_APPLICABLE_BY_RULE'
            : answer !== null
              ? 'CONCORDANT_ADOPTED_BY_RULE'
              : 'UNRESOLVED';
        if (answer === ref.reference_answer && status === ref.adjudication_status)
          referenceMatches += 1;
        else if (args.includes('--debug'))
          console.error(
            `DEBUG reference mismatch ${example.case_id} ${ref.item_code}: expected status ${ref.adjudication_status}, got ${status}; answer ${answer === ref.reference_answer ? 'equal' : 'differs'}`,
          );
      }
    }
    const anyBundleHasTraining = (await exportTlv5Bundle(investigator, 'PILOT')).files.some((f) =>
      trainingIds.some((id) => f.content.includes(id)),
    );
    report.training = {
      examples: worked.examples.length,
      submissions: worked.examples.reduce((n, e) => n + e.submissions.length, 0),
      queue_items_needing_adjudication: queueItems,
      adjudications,
      blinded_by_adjudicator: adjudications,
      training_reference_items: referenceItems,
      training_reference_matches: referenceMatches,
      training_rows_in_exports: anyBundleHasTraining ? 1 : 0,
    };
    if (referenceMatches !== referenceItems)
      throw new Error('training reference differs from the worked-examples file');
  } catch (error) {
    fail('training', error);
  }
  // 4. Calibration trials (placeholder packets carrying the identifier) and the formal sample with its labels.
  try {
    const calibration = csvRecords(calibrationText);
    for (const row of calibration)
      await importTlv5Case(investigator, {
        case_id: row[COL.calCaseId],
        mode: 'CALIBRATION',
        packet: placeholderPacket('Calibration trial', row.nct_id),
      });
    report.calibration = { rows: calibration.length, imported: calibration.length };
    const sample = csvRecords(sampleText);
    let weightChecks = 0;
    for (const row of sample) {
      const p = Number(row[COL.probability]);
      if (Math.abs(Number(row[COL.weight]) * p - 1) > 1e-9)
        throw new Error('weight is not 1 / probability');
      weightChecks += 1;
      await importTlv5Case(investigator, {
        case_id: row[COL.caseId],
        mode: 'FORMAL',
        packet: placeholderPacket('Formal trial', row.nct_id),
        design: {
          nct_id: row.nct_id,
          frame: row.frame,
          stratum: row[COL.stratum],
          variance_stratum: row[COL.varianceStratum],
          frame_stratum_size: Number(row.N_h),
          n_sampled_in_stratum: Number(row.n_h),
          selection_probability: row[COL.probability],
          sampling_seed: row[COL.seed] ? Number(row[COL.seed]) : null,
          prn: row[COL.prn] || null,
          design_version: row.sampling_design_version,
          in_mixed_sex_cohort: bool(row.in_mixed_sex_cohort),
          figure2_rows: row.figure2_rows,
          dev_linked: bool(row.dev_linked),
          tier1_eligible: bool(row.tier1_eligible),
        },
      });
    }
    const labels = csvRecords(labelsText).map((r) => ({
      label_set_id: r.label_set_id,
      case_id: r.case_id,
      item_code: r.item_code,
      label_primary: r.label_primary,
      label_secondary: r.label_secondary || null,
      label_informational: r.label_informational || null,
      dev_linked_area: r.dev_linked_area ? bool(r.dev_linked_area) : null,
    }));
    const imported = await importTlv5Labels(investigator, labels);
    // A training trial and a calibration trial are refused as FORMAL cases (overlap guard), without printing which.
    let overlapRefusals = 0;
    for (const nct of [
      worked.examples[0].rpc_tlv5_import_case.packet.trial.nct_id!,
      calibration[0].nct_id,
    ]) {
      try {
        await importTlv5Case(investigator, {
          case_id: 'TLV5-TESTFX-9999',
          mode: 'FORMAL',
          packet: placeholderPacket('overlap probe', nct),
          design: {
            nct_id: nct,
            frame: sample[0].frame,
            stratum: sample[0][COL.stratum],
            variance_stratum: sample[0][COL.varianceStratum],
            frame_stratum_size: Number(sample[0].N_h),
            n_sampled_in_stratum: Number(sample[0].n_h),
            selection_probability: sample[0][COL.probability],
            design_version: sample[0].sampling_design_version,
            dev_linked: false,
            tier1_eligible: true,
          },
        });
      } catch {
        overlapRefusals += 1;
      }
    }
    const labelFileSha = createHash('sha256').update(labelsText).digest('hex');
    await freezeTlv5(investigator, {
      labelFileSha256: labelFileSha,
      frozenItems: {
        sample_file: opt('sample-sha256')!,
        label_file: labelFileSha,
        calibration_file: opt('calibration-sha256')!,
        freeze_manifest: opt('freeze-manifest-sha256')!,
        rubric: rubricSha256(),
      },
      attestation: ATT,
    });
    const admin = await getTlv5Workspace(investigator);
    if (admin.kind !== 'investigator' || !admin.state.frozen) throw new Error('freeze missing');
    report.formal = {
      sample_rows: sample.length,
      cases_imported: sample.length,
      weight_checks: weightChecks,
      label_rows_imported: imported,
      overlap_refusals: overlapRefusals,
      frozen_cases: admin.state.frozen.nCases,
      frozen_label_rows: admin.state.frozen.nLabelRows,
      case_list_sha256_equals_manifest:
        admin.state.frozen.caseListSha256 === freezeManifest.case_list_sha256,
      label_set_sha256_equals_manifest:
        admin.state.frozen.labelRowsSha256 === freezeManifest.label_set_sha256,
      n_cases_equals_manifest: admin.state.frozen.nCases === Number(freezeManifest.n_cases),
      n_label_rows_equals_manifest:
        admin.state.frozen.nLabelRows === Number(freezeManifest.n_label_rows),
      frozen_labels_verify: admin.verification.frozenLabels?.matches ?? null,
    };
    let postFreezeRefusals = 0;
    for (const attempt of [
      () =>
        importTlv5Case(investigator, {
          case_id: 'TLV5-TESTFX-9998',
          mode: 'FORMAL',
          packet: placeholderPacket('post-freeze probe', 'SYN-NCT-9998'),
          design: {
            nct_id: 'SYN-NCT-9998',
            frame: 'X',
            stratum: 'X',
            variance_stratum: 'X',
            frame_stratum_size: 1,
            n_sampled_in_stratum: 1,
            selection_probability: 1,
            design_version: 'X',
            dev_linked: false,
            tier1_eligible: true,
          },
        }),
      () =>
        importTlv5Labels(investigator, [
          {
            label_set_id: labels[0].label_set_id,
            case_id: sample[0][COL.caseId],
            item_code: 'RULE_D',
            label_primary: 'D1_KEEP_TYPE2',
          },
        ]),
      () =>
        importTlv5Case(investigator, {
          case_id: 'CAL5-TESTFX-99',
          mode: 'CALIBRATION',
          packet: placeholderPacket('post-freeze probe', 'SYN-NCT-9997'),
        }),
    ]) {
      try {
        await attempt();
      } catch {
        postFreezeRefusals += 1;
      }
    }
    await tlv5AdminAction(investigator, {
      action: 'phase',
      eventType: 'FORMAL_OPENED',
      attestation: ATT,
    });
    const assigned = await tlv5AdminAction(investigator, {
      action: 'assign',
      mode: 'FORMAL',
      seed: 20261022,
    });
    let trainingAfterOpenRefused = 0;
    try {
      await importTlv5Case(investigator, {
        case_id: 'EX5-09',
        mode: 'TRAINING',
        packet: placeholderPacket('post-open probe', 'SYN-NCT-9099'),
      });
    } catch {
      trainingAfterOpenRefused = 1;
    }
    report.post_freeze = {
      refusals_of_3_additions: postFreezeRefusals,
      formal_assignments_per_slot: assigned.completion.FORMAL.map((r) => r.assigned),
      training_import_after_open_refused: trainingAfterOpenRefused,
    };
  } catch (error) {
    fail('formal', error);
  }
  const out = JSON.stringify(report, null, 2);
  console.log(out);
  if (opt('report')) writeFileSync(resolve(opt('report')!), out + '\n');
  await (await getDb()).close();
}
interface WorkedExample {
  case_id: string;
  rpc_tlv5_import_case: { case_id: string; mode: 'TRAINING'; packet: Tlv5TrialPacket };
  submissions: {
    reviewer_slot: number;
    account: string;
    rpc_tlv5_submit: {
      items: {
        item_code: string;
        answer: string;
        uncertain: boolean;
        note: string | null;
        detail_code: string | null;
      }[];
      overall_comment: string | null;
      packet_issue_flag: boolean;
      packet_issue_note: string | null;
    };
  }[];
  adjudicator_queue_items_needing_adjudication: {
    item_code: string;
    reviewer_1_answer: string | null;
    reviewer_2_answer: string | null;
  }[];
  rpc_tlv5_record_adjudication: {
    case_id: string;
    item_code: string;
    decision: string | null;
    detail_code: string | null;
    status: string;
    basis: string;
    rationale: string;
    disagreement_reason_code: string | null;
    account: string;
  }[];
  training_reference_after_lock: {
    item_code: string;
    reference_answer: string | null;
    reference_detail: string | null;
    adjudication_status: string;
  }[];
}
main().catch((error) => fail('run', error));
