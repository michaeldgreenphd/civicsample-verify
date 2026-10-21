import { ENGINEERING_NOTICE, canonicalJson, sha256 } from './export';

/** Numeric database values must arrive as text, so CSV serialization cannot round them. */
export type V4Cell = string | boolean | null;
export type V4Row = Record<string, V4Cell>;
export interface V4SyntheticExportInput {
  manifest: Record<string, unknown>;
  independentJudgments: V4Row[];
  adjudicatedReference: V4Row[];
  frozenPredictions: V4Row[];
  integrity: { frozenPredictionsMatch: boolean; judgmentSnapshotMatch: boolean };
}

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const booleanManifestKeys = new Set([
  'is_synthetic_fixture',
  'reference_locked',
  'extension_approved_by_amendment',
]);
const permittedLevels = new Set([
  'DESCRIPTOR_LEVEL',
  'DESCRIPTOR_LEVEL_IN_TRIAL_CASE',
  'TRIAL_LEVEL',
]);

function cell(value: V4Cell): string {
  if (value === null) return '';
  if (typeof value !== 'string' && typeof value !== 'boolean')
    throw new Error('CSV cells must be explicit null, boolean, or database text');
  const text = String(value);
  return /[",\r\n]/.test(text) ? '"' + text.replaceAll('"', '""') + '"' : text;
}

function render(rows: V4Row[], columns: readonly string[], exportId?: string): string {
  if (!rows.length) throw new Error('Synthetic v4 tables cannot be empty');
  const normalized = rows.map((row) => {
    const result = { ...row };
    if (exportId !== undefined) {
      if (row.export_id !== undefined && row.export_id !== exportId)
        throw new Error('Row export ID differs from manifest');
      result.export_id = exportId;
    }
    if (
      columns.some((column) => !(column in result)) ||
      Object.keys(result).some((column) => !columns.includes(column))
    ) {
      throw new Error('Row columns differ from the v4 contract');
    }
    if (
      result.record_category !== 'HELDOUT_FORMAL' ||
      typeof result.case_id !== 'string' ||
      !/^HO4-TESTFX-\d+$/.test(result.case_id)
    ) {
      throw new Error(
        'Only synthetic HO4-TESTFX held-out records may enter this engineering writer; pilot records are forbidden',
      );
    }
    if (
      typeof result.determination_level !== 'string' ||
      !permittedLevels.has(result.determination_level)
    )
      throw new Error('Invalid determination level');
    for (const [key, value] of Object.entries(result)) {
      cell(value);
      if (typeof value === 'string' && /\bNCT\d{8}\b/i.test(value))
        throw new Error('Real registry identifiers are forbidden');
      if (
        key === 'nct_id' &&
        value !== null &&
        value !== '' &&
        (typeof value !== 'string' || !/^SYN-NCT-\d+$/.test(value))
      )
        throw new Error('Trial identifiers must be fictional');
      if (
        key.endsWith('_at') &&
        (typeof value !== 'string' ||
          !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value) ||
          !Number.isFinite(Date.parse(value)))
      ) {
        throw new Error('Timestamps must already be valid ISO UTC text ending in Z');
      }
    }
    return result;
  });
  const key = (row: V4Row) =>
    canonicalJson([row.case_id, row.determination_level, row.reviewer_slot ?? '']);
  if (new Set(normalized.map(key)).size !== normalized.length)
    throw new Error('Duplicate case-level record');
  normalized.sort(
    (a, b) =>
      compare(String(a.case_id), String(b.case_id)) ||
      compare(String(a.determination_level), String(b.determination_level)) ||
      compare(String(a.reviewer_slot ?? ''), String(b.reviewer_slot ?? '')),
  );
  return (
    columns.join(',') +
    '\n' +
    normalized.map((row) => columns.map((column) => cell(row[column])).join(',')).join('\n') +
    '\n'
  );
}

/** Use this exact renderer to hash the synthetic prediction file at its engineering freeze. */
export function renderV4SyntheticPredictions(rows: V4Row[]): string {
  return render(rows, PREDICTION_COLUMNS);
}

/** Pure exporter: callers supply reference values, predictions, design metadata and integrity outcomes. */
export function buildV4SyntheticBundle(input: V4SyntheticExportInput) {
  const m = input.manifest;
  if (
    m.is_synthetic_fixture !== true ||
    m.reference_locked !== true ||
    m.mode !== 'FORMAL' ||
    m.review_module !== 'ONTOLOGY_AREA' ||
    m.export_format_version !== '4.0'
  ) {
    throw new Error(
      'A locked synthetic Module A v4 bundle is required; no clinical or pilot export is supported',
    );
  }
  if (
    input.integrity.frozenPredictionsMatch !== true ||
    input.integrity.judgmentSnapshotMatch !== true
  )
    throw new Error('Both database integrity verifications must match before export');
  for (const key of MANIFEST_KEYS_V4) {
    if (key === 'files') continue;
    const value = m[key];
    if (
      booleanManifestKeys.has(key)
        ? typeof value !== 'boolean'
        : typeof value !== 'string' || (key !== 'amendment_id' && !value)
    )
      throw new Error('Required manifest metadata is absent or has the wrong type');
  }
  if (m.extension_approved_by_amendment !== false)
    throw new Error('Extensions are outside this synthetic engineering writer');
  if (!['v1.1', 'v1.2'].includes(String(m.tier1_version_frozen)))
    throw new Error('The frozen Tier 1 version must be supplied');
  if (!['ALL_CASE_LEVELS', 'DISAGREEMENTS_ONLY'].includes(String(m.adjudication_scope)))
    throw new Error('The adjudication scope must be supplied');
  const caseKeys = (rows: V4Row[]) =>
    [...new Set(rows.map((row) => canonicalJson([row.case_id, row.determination_level])))].sort(
      compare,
    );
  const expected = canonicalJson(caseKeys(input.frozenPredictions));
  if (
    canonicalJson(caseKeys(input.independentJudgments)) !== expected ||
    canonicalJson(caseKeys(input.adjudicatedReference)) !== expected
  )
    throw new Error('Case-level populations must match across all three tables');
  const cases = [...new Set(input.frozenPredictions.map((row) => String(row.case_id)))].sort(
    compare,
  );
  if (sha256(cases.join('\n')) !== m.frozen_sample_case_list_sha256)
    throw new Error('Case list differs from the frozen sample');
  const files = [
    {
      name: 'synthetic_v4_independent_judgments.csv',
      role: 'independent_judgments',
      rows: input.independentJudgments.length,
      content: render(input.independentJudgments, JUDGMENT_COLUMNS, String(m.export_id)),
    },
    {
      name: 'synthetic_v4_adjudicated_reference.csv',
      role: 'adjudicated_reference',
      rows: input.adjudicatedReference.length,
      content: render(input.adjudicatedReference, ADJUDICATION_COLUMNS, String(m.export_id)),
    },
    {
      name: 'synthetic_v4_frozen_predictions.csv',
      role: 'frozen_predictions',
      rows: input.frozenPredictions.length,
      content: renderV4SyntheticPredictions(input.frozenPredictions),
    },
  ].map((file) => ({ ...file, sha256: sha256(file.content) }));
  if (files[2].sha256 !== m.frozen_prediction_set_sha256)
    throw new Error('Prediction file differs from the hash recorded at freeze');
  const manifest = Object.fromEntries(
    MANIFEST_KEYS_V4.filter((key) => key !== 'files').map((key) => [key, m[key]]),
  );
  manifest.notice = ENGINEERING_NOTICE;
  manifest.files = files.map((file) => ({
    name: file.name,
    role: file.role,
    sha256: file.sha256,
    rows: file.rows,
  }));
  return {
    notice: ENGINEERING_NOTICE,
    manifest,
    manifestContent: canonicalJson(manifest),
    manifest_sha256: sha256(canonicalJson(manifest)),
    files,
  };
}

export const JUDGMENT_COLUMNS = [
  'export_id',
  'record_category',
  'case_id',
  'case_version',
  'review_module',
  'unit_type',
  'unit_id',
  'nct_id',
  'descriptor_ui',
  'descriptor_name',
  'area',
  'determination_level',
  'reviewer_slot',
  'reviewer_pseudo_id',
  'decision_initial',
  'decision_effective_preclose',
  'n_revisions_preclose',
  'uncertain',
  'packet_issue_flag',
  'first_submitted_at',
  'last_submitted_at',
] as const;
export const ADJUDICATION_COLUMNS = [
  'export_id',
  'record_category',
  'case_id',
  'determination_level',
  'adjudication_id',
  'adjudicated_decision',
  'adjudication_status',
  'adjudication_basis',
  'disagreement_reason_code',
  'adjudicator_pseudo_id',
  'adjudicator_role',
  'adjudication_blinded',
  'adjudicator_exposed_to_index_labels',
  'post_unblinding_revision_exists',
  'adjudicated_at',
  'reference_lock_id',
] as const;
export const PREDICTION_COLUMNS = [
  'prediction_set_id',
  'record_category',
  'case_id',
  'frame_unit_id',
  'unit_type',
  'unit_id',
  'nct_id',
  'descriptor_ui',
  'area',
  'determination_level',
  'tier0_binary',
  'tier1_version',
  'tier1_status_raw',
  'tier1_binary',
  'stage_c_trial_status',
  'prediction_frozen_at',
  'selection_stratum',
  'variance_stratum',
  'variance_stratum_size',
  'selection_probability',
  'sampling_weight',
  'comparison_cell',
  'impact_tier',
  'policy_governed_neoplasm_GEN06',
  'provenance_audit_result',
] as const;
export const MANIFEST_KEYS_V4 = [
  'export_id',
  'export_type',
  'export_format_version',
  'mode',
  'review_module',
  'created_at',
  'app_git_sha',
  'db_schema_version',
  'is_synthetic_fixture',
  'reference_locked',
  'reference_lock_id',
  'reference_locked_at',
  'formal_phase_opened_at',
  'formal_phase_closed_at',
  'freeze_manifest_id',
  'freeze_manifest_sha256',
  'frozen_at',
  'frozen_sample_case_list_sha256',
  'frozen_prediction_set_sha256',
  'tier1_version_frozen',
  'ontology_version',
  'ontology_sha256',
  'tier1_decision_file_sha256',
  'tier0_mapping_sha256',
  'rubric_version',
  'rubric_sha256',
  'sampling_design_version',
  'provenance_audit_sha256',
  'extension_approved_by_amendment',
  'amendment_id',
  'adjudication_scope',
  'files',
] as const;
