// Review artefact for the synthetic pilot import on staging: what `import-synthetic` would create,
// without any remote request. Prints the campaign parameters and every synthetic mapping with its
// condition, trial reference, category and evidence flags, plus a SHA-256 of the exact payload each
// RPC call would carry. Nothing is imported; the investigator authorizes the import separately.
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const types = await import(pathToFileURL(resolve(root, 'src/lib/mapconf-types.ts')).href);
const synthetic = await import(pathToFileURL(resolve(root, 'src/lib/mapconf-synthetic.ts')).href);
const sha = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const cases = [...synthetic.MC_SYNTHETIC_PILOT_CASES, ...synthetic.MC_SYNTHETIC_TRAINING_CASES].map(
  (c) => {
    const payload = {
      case_id: c.caseId,
      record_category: c.recordCategory,
      trial_ref: c.trialRef,
      condition_code: c.conditionCode,
      condition_label: c.conditionLabel,
      condition_set_id: types.MC_CONDITION_SET_ID,
      assignment: c.assignment,
      evidence: c.evidence,
    };
    return {
      caseId: c.caseId,
      recordCategory: c.recordCategory,
      trialRef: c.trialRef,
      condition: `${c.conditionCode} (${c.conditionLabel})`,
      briefSummaryPresent: c.evidence.brief_summary.present,
      detailedDescription: Boolean(c.evidence.detailed_description),
      source: `${c.evidence.source.system} ${c.evidence.source.version}`,
      payloadSha256: sha(payload),
    };
  },
);
console.log(
  JSON.stringify(
    {
      plan: 'MAPPING_CONFIRMATION_SYNTHETIC_IMPORT_PLAN',
      mutationsPerformed: false,
      campaign: {
        rpc: 'rpc_mc_create_campaign',
        condition_set_id: types.MC_CONDITION_SET_ID,
        condition_set_status: types.MC_CONDITION_SET_STATUS,
        rubric_version: types.MC_RUBRIC_VERSION,
        rubric_sha256: types.mcRubricSha256(),
      },
      import: {
        rpc: 'rpc_mc_import_case',
        count: cases.length,
        syntheticPilot: cases.filter((c) => c.recordCategory === 'SYNTHETIC_PILOT').length,
        trainingExamples: cases.filter((c) => c.recordCategory === 'TRAINING_EXAMPLE').length,
        cases,
      },
      assignment: {
        rpc: 'rpc_mc_assign',
        note: 'two PILOT-scope reviewers (is_pilot_test_account accounts) take slots 1 and 2; seed supplied at run time',
      },
      notes: [
        'Synthetic fixtures only (SYN-NCT references, fictional titles and summaries); no study record.',
        'The database refuses EVALUATION records and real registry references in this build (migration 0018).',
        'The database computes its own evidence and assignment hashes from the stored JSON; payloadSha256 identifies the request payload for review.',
      ],
    },
    null,
    2,
  ),
);
