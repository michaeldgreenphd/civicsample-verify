// Bundle format 5.0 writer (docs/design_v5/EXPORT_TO_PERFORMANCE_SPEC_v5.md, section 1). Pure
// functions: rows in, deterministic CSV text and manifest out. The database views supply the
// rows; this module never reorders semantics, it only renders. Every numeric database value must
// already be text so CSV serialization cannot round it.
import { createHash } from 'node:crypto';
import { AREA_ITEMS, ROW_ITEMS, SG_ITEMS } from './tlv5-codes';
import type { Tlv5Bundle, Tlv5BundleFile } from './tlv5-types';

export type Cell = string | boolean | number | null;
export type Row = Record<string, Cell>;

export const JUDGMENT_COLUMNS = [
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
] as const;
export const REFERENCE_COLUMNS = [
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
] as const;
export const LABEL_COLUMNS = [
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
] as const;
export const MANIFEST_KEYS = [
  'export_id',
  'export_format_version',
  'mode',
  'created_at',
  'app_git_sha',
  'db_schema_version',
  'is_synthetic_fixture',
  'design_version',
  'adjudication_scope',
  'label_set_id',
  'frozen_at',
  'frozen_case_list_sha256',
  'frozen_label_rows_sha256',
  'formal_phase_opened_at',
  'formal_phase_closed_at',
  'formal_phase_status',
  'snapshot_taken_at',
  'snapshot_sha256',
  'snapshot_rows',
  'reference_locked',
  'reference_lock_id',
  'reference_locked_at',
  'rubric_version',
  'rubric_sha256',
  'files',
] as const;

const ITEM_ORDER = [...AREA_ITEMS, ...ROW_ITEMS, ...SG_ITEMS, 'RULE_D', 'RULE_K'];
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

function renderCsv(rows: Row[], columns: readonly string[]): string {
  for (const row of rows) {
    const keys = Object.keys(row);
    if (keys.length !== columns.length || columns.some((c) => !(c in row)))
      throw new Error('Row columns differ from the v5 contract');
  }
  return (
    [columns.join(','), ...rows.map((row) => columns.map((c) => cell(row[c])).join(','))].join(
      '\n',
    ) + '\n'
  );
}

function itemRank(code: Cell): number {
  const index = ITEM_ORDER.indexOf(String(code));
  return index === -1 ? ITEM_ORDER.length : index;
}
export function sortRows(rows: Row[]): Row[] {
  return [...rows].sort(
    (a, b) =>
      compare(String(a.case_id), String(b.case_id)) ||
      itemRank(a.item_code) - itemRank(b.item_code) ||
      Number(a.reviewer_slot ?? 0) - Number(b.reviewer_slot ?? 0),
  );
}

/** Hash procedures of the spec, section 4 (identical in the sampling script and the database). */
export function caseListSha256(caseIds: Iterable<string>): string {
  return sha256([...new Set(caseIds)].sort(compare).join('\n'));
}
export function labelRowText(r: Row): string {
  return [
    r.label_set_id,
    r.case_id,
    r.item_code,
    r.label_primary,
    r.label_secondary ?? '',
    r.label_informational ?? '',
  ]
    .map((v) => (v === null || v === undefined ? '' : String(v)))
    .join('|');
}
export function labelRowsSha256(labels: Row[]): string {
  const hashes = [...labels]
    .sort(
      (a, b) =>
        compare(String(a.case_id), String(b.case_id)) ||
        compare(String(a.item_code), String(b.item_code)),
    )
    .map((r) => sha256(labelRowText(r)));
  return sha256(hashes.join('\n'));
}

/** Deterministic manifest export_id for a locked state: a name-based UUID of the lock and mode. */
export function manifestExportId(mode: string, lockId: string): string {
  const h = sha256(`tlv5-bundle|${mode}|${lockId}`);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export interface Tlv5ManifestInput {
  export_id: string;
  mode: 'PILOT' | 'FORMAL';
  created_at: string;
  app_git_sha: string;
  design_version: string;
  adjudication_scope: string;
  label_set_id: string;
  frozen_at: string;
  frozen_case_list_sha256: string;
  frozen_label_rows_sha256: string;
  formal_phase_opened_at: string | null;
  formal_phase_closed_at: string | null;
  formal_phase_status: string;
  snapshot_taken_at: string | null;
  snapshot_sha256: string | null;
  snapshot_rows: number | null;
  reference_lock_id: string;
  reference_locked_at: string;
  rubric_version: string;
  rubric_sha256: string;
  is_synthetic_fixture: boolean;
}

export function buildTlv5Bundle(
  manifestInput: Tlv5ManifestInput,
  judgments: Row[],
  reference: Row[],
  labels: Row[],
): Tlv5Bundle {
  const prefix = manifestInput.mode.toLowerCase();
  const render = (role: Tlv5BundleFile['role'], rows: Row[], columns: readonly string[]) => {
    if (!rows.length) throw new Error(`${role}: no rows to export`);
    const content = renderCsv(sortRows(rows), columns);
    return {
      role,
      name: `${prefix}_${role}_v5.csv`,
      rows: rows.length,
      sha256: sha256(content),
      content,
    };
  };
  const files: Tlv5BundleFile[] = [
    render('independent_judgments', judgments, JUDGMENT_COLUMNS),
    render('adjudicated_reference', reference, REFERENCE_COLUMNS),
    render('frozen_labels', labels, LABEL_COLUMNS),
  ];
  const manifest: Record<string, unknown> = {
    ...manifestInput,
    export_format_version: '5.0',
    db_schema_version: '5.0.0',
    reference_locked: true,
    files: files.map(({ role, name, sha256: digest, rows }) => ({
      role,
      name,
      sha256: digest,
      rows,
    })),
    notice:
      manifestInput.mode === 'PILOT'
        ? 'SYNTHETIC PILOT. Excluded from every statistic; pipeline dry run only.'
        : 'Design v5 bundle; the analysis plan and every scientific choice require investigator approval.',
  };
  for (const key of MANIFEST_KEYS) if (!(key in manifest)) throw new Error(`manifest lacks ${key}`);
  const ordered = Object.fromEntries(
    [...MANIFEST_KEYS, 'notice'].map((key) => [
      key,
      manifest[key] === undefined ? null : manifest[key],
    ]),
  );
  const text = JSON.stringify(ordered, null, 1) + '\n';
  return {
    manifest: ordered,
    manifestName: `${prefix}_bundle_v5.manifest.json`,
    manifestSha256: sha256(text),
    files,
  };
}

export function manifestText(bundle: Tlv5Bundle): string {
  return JSON.stringify(bundle.manifest, null, 1) + '\n';
}
