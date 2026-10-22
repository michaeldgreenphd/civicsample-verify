// Mapping-confirmation export (format mapping-confirmation-1.0, docs/MAPPING_CONFIRMATION.md).
// Pure rendering: rows from the database views in, deterministic CSV text and manifest out. The
// export carries no sampling probability, weight, label or accuracy statistic: the analysis
// specification for this review mode is pending and v4/v5 calculations are not reused.
import { createHash } from 'node:crypto';
import {
  MC_ASSIGNMENT_VISIBILITY,
  MC_FORMAT_VERSION,
  MC_REVIEW_MODE,
  type McBundle,
  type McBundleFile,
} from './mapconf-types';

export type Cell = string | boolean | number | null;
export type Row = Record<string, Cell>;
export const MC_CASE_COLUMNS = [
  'record_category',
  'case_id',
  'trial_ref',
  'condition_code',
  'condition_label',
  'condition_set_id',
  'assignment_source',
  'assignment_version',
  'assignment_sha256',
  'evidence_sha256',
  'evidence_version',
  'brief_summary_present',
  'detailed_description_included',
  'adjudication_id',
  'adjudicated_decision',
  'adjudication_status',
  'adjudication_basis',
  'adjudicator_role',
  'adjudicated_at',
] as const;
export const MC_RESPONSE_COLUMNS = [
  'record_category',
  'case_id',
  'reviewer_slot',
  'reviewer_pseudo_id',
  'answer',
  'annotation',
  'rubric_addition_proposed',
  'review_mode',
  'assignment_visibility',
  'displayed_assignment_sha256',
  'displayed_evidence_sha256',
  'rubric_version',
  'rubric_sha256',
  'response_app_git_sha',
  'submitted_at',
] as const;
export const MC_MANIFEST_KEYS = [
  'export_id',
  'export_format_version',
  'review_mode',
  'assignment_visibility',
  'created_at',
  'app_git_sha',
  'db_schema_version',
  'is_synthetic_fixture',
  'condition_set_id',
  'condition_set_status',
  'rubric_version',
  'rubric_sha256',
  'closed_at',
  'adjudication_authorized_at',
  'locked_at',
  'n_mappings',
  'n_responses',
  'n_adjudications',
  'training_examples_excluded',
  'weights_or_probabilities',
  'analysis_specification',
  'files',
] as const;
/** Column names that must never appear in this export (trial-level v5 design artefacts). */
export const MC_FORBIDDEN_COLUMNS = [
  'selection_probability',
  'sampling_weight',
  'stratum',
  'variance_stratum',
  'frame_stratum_size',
  'label_primary',
  'label_secondary',
  'tier1_eligible',
  'dev_linked',
];

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
export const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
function cell(value: Cell): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) throw new Error('Non-integer numbers must arrive as text');
    return String(value);
  }
  return /[",\r\n]/.test(value) ? '"' + value.replaceAll('"', '""') + '"' : value;
}
export function renderMcCsv(rows: Row[], columns: readonly string[]): string {
  for (const row of rows) {
    const keys = Object.keys(row);
    if (keys.length !== columns.length || columns.some((c) => !(c in row)))
      throw new Error('Row columns differ from the mapping-confirmation contract');
    for (const key of keys)
      if (MC_FORBIDDEN_COLUMNS.includes(key)) throw new Error(`forbidden column ${key}`);
  }
  const sorted = [...rows].sort(
    (a, b) =>
      compare(String(a.case_id), String(b.case_id)) ||
      Number(a.reviewer_slot ?? 0) - Number(b.reviewer_slot ?? 0),
  );
  return (
    [columns.join(','), ...sorted.map((row) => columns.map((c) => cell(row[c])).join(','))].join(
      '\n',
    ) + '\n'
  );
}
export function mcExportId(lockedAt: string, manifestSeed: string): string {
  const h = sha256(`mc-bundle|${lockedAt}|${manifestSeed}`);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
export interface McManifestInput {
  created_at: string;
  app_git_sha: string;
  is_synthetic_fixture: boolean;
  condition_set_id: string;
  condition_set_status: string;
  rubric_version: string;
  rubric_sha256: string;
  closed_at: string | null;
  adjudication_authorized_at: string | null;
  locked_at: string;
  n_adjudications: number;
}
export function buildMcBundle(input: McManifestInput, cases: Row[], responses: Row[]): McBundle {
  const render = (role: McBundleFile['role'], rows: Row[], columns: readonly string[]) => {
    if (!rows.length) throw new Error(`${role}: no rows to export`);
    const content = renderMcCsv(rows, columns);
    return {
      role,
      name: `mapping_confirmation_${role}.csv`,
      rows: rows.length,
      sha256: sha256(content),
      content,
    };
  };
  const files = [
    render('cases', cases, MC_CASE_COLUMNS),
    render('responses', responses, MC_RESPONSE_COLUMNS),
  ];
  const manifest: Record<string, unknown> = {
    export_id: mcExportId(input.locked_at, files.map((f) => f.sha256).join('|')),
    export_format_version: MC_FORMAT_VERSION,
    review_mode: MC_REVIEW_MODE,
    assignment_visibility: MC_ASSIGNMENT_VISIBILITY,
    ...input,
    db_schema_version: '6.0.0-mapping-confirmation',
    n_mappings: cases.length,
    n_responses: responses.length,
    training_examples_excluded: true,
    weights_or_probabilities: 'NONE: mapping units carry no sampling probability or weight',
    analysis_specification:
      'PENDING: no accuracy statistic is computed from this export until an investigator-approved analysis specification for the mapping-confirmation mode exists',
    files: files.map(({ role, name, sha256: digest, rows }) => ({
      role,
      name,
      sha256: digest,
      rows,
    })),
    notice: input.is_synthetic_fixture
      ? 'SYNTHETIC PILOT. Excluded from every statistic; pipeline dry run only.'
      : 'Mapping-confirmation review of visible existing assignments; not a blinded clinical reference assessment. Never mix with v4/v5 blinded-reference outputs.',
  };
  for (const key of MC_MANIFEST_KEYS)
    if (!(key in manifest)) throw new Error(`manifest lacks ${key}`);
  const ordered = Object.fromEntries(
    [...MC_MANIFEST_KEYS, 'notice'].map((k) => [k, manifest[k] ?? null]),
  );
  const text = JSON.stringify(ordered, null, 1) + '\n';
  return {
    manifest: ordered,
    manifestName: 'mapping_confirmation_bundle.manifest.json',
    manifestSha256: sha256(text),
    files,
  };
}
export function mcManifestText(bundle: McBundle): string {
  return JSON.stringify(bundle.manifest, null, 1) + '\n';
}
