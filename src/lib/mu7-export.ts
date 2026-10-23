// Bundle format 7.0 (EXPORT_TO_PERFORMANCE_SPEC_v7.md): four CSV files from the security_invoker
// export views of migration 0024 and a manifest. Column lists are the contract's, in its order
// (the supplied suite checks the same lists against the views, steps MU7-EXP-COL-*). CSV quoting,
// boolean and timestamp text follow the suite's own bundle writer, so a bundle written here and
// one written by tests/handoff/v7.mjs read identically in analysis/v7/performance_analysis_v7.py.
// A PILOT bundle is SYNTHETIC: its manifest says so and the analysis refuses it (mode FORMAL only).
import { createHash } from 'node:crypto';
import type { Mu7Bundle, Mu7BundleFile, Mu7Mode } from './mu7-types';

export const MU7_BUNDLE_FORMAT = '7.0';
export const MU7_EXPORT_COLUMNS = {
  units: [
    'unit_id',
    'mode',
    'record_category',
    'family',
    'category',
    'unit_role',
    'mapping_code',
    'assignment_code',
    'assignment_status',
    'parent_row_code',
    'packet_sha256',
    'created_at',
  ],
  unit_design: [
    'unit_id',
    'mode',
    'nct_id',
    'frame_id',
    'stratum',
    'frame_stratum_size',
    'n_sampled_in_stratum',
    'selection_probability',
    'sampling_seed',
    'prn_key',
    'allocation_option',
    'overlap_setting',
    'design_version',
    'freeze_status',
    'freeze_gate',
    'design_row_sha256',
    'assignment_set_id',
    'assignment_row_sha256',
  ],
  independent_judgments: [
    'unit_id',
    'mode',
    'reviewer_slot',
    'reviewer_pseudo_id',
    'queue_position',
    'judgment_status',
    'answer_initial',
    'reason_initial',
    'note_initial',
    'uncertain_initial',
    'answer_effective',
    'reason_effective',
    'note_effective',
    'uncertain_effective',
    'n_revisions',
    'first_submitted_at',
    'last_submitted_at',
  ],
  final_reference: [
    'unit_id',
    'mode',
    'family',
    'category',
    'unit_role',
    'mapping_code',
    'assignment_code',
    'assignment_status',
    'answer_initial_slot1',
    'answer_initial_slot2',
    'answer_effective_slot1',
    'answer_effective_slot2',
    'routing',
    'final_answer',
    'final_status',
    'adjudication_reason_code',
    'adjudication_status',
    'adjudication_basis',
    'adjudication_disagreement_reason_code',
  ],
} as const;
export type Mu7ExportRole = keyof typeof MU7_EXPORT_COLUMNS;
export const MU7_EXPORT_VIEWS: Record<Mu7ExportRole, string> = {
  units: 'v_mu7_export_units',
  unit_design: 'v_mu7_export_unit_design',
  independent_judgments: 'v_mu7_independent_judgments',
  final_reference: 'v_mu7_final_reference',
};
/** Column names that must never appear in any bundle file (model output, prompts, raw packets). */
export const MU7_FORBIDDEN_COLUMNS =
  /packet$|^labels?$|prediction|model|prompt|reasoning|walkthrough|planted/;

export type Mu7Row = Record<string, unknown>;
const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

/** Timestamps as the suite writes them (Date.toISOString, millisecond precision, Z). */
export function mu7CellText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}/.test(value)) {
    const d = new Date(value.replace(' ', 'T'));
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return String(value);
}
export function mu7Csv(columns: readonly string[], rows: Mu7Row[]): string {
  if (!rows.length) return `${columns.join(',')}\n`;
  const esc = (v: unknown) => {
    const s = mu7CellText(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return (
    [columns.join(','), ...rows.map((r) => columns.map((c) => esc(r[c])).join(','))].join('\n') +
    '\n'
  );
}
/** Stable order: unit_id in code-point order (the database's collate "C"), then reviewer slot. */
export function mu7SortRows(rows: Mu7Row[]): Mu7Row[] {
  const key = (r: Mu7Row) => String(r.unit_id);
  return [...rows].sort((a, b) =>
    key(a) < key(b)
      ? -1
      : key(a) > key(b)
        ? 1
        : Number(a.reviewer_slot ?? 0) - Number(b.reviewer_slot ?? 0),
  );
}

export interface Mu7BundleSources {
  mode: Mu7Mode;
  appGitSha: string;
  design: Record<string, unknown> | null;
  freeze: Record<string, unknown> | null;
  snapshot: Record<string, unknown> | null;
  lockedAt: string;
  nUnitsLocked: number;
  /** True for every database this build serves (local synthetic and synthetic staging). */
  syntheticDatabase: boolean;
  rows: Record<Mu7ExportRole, Mu7Row[]>;
}

export function buildMu7Bundle(s: Mu7BundleSources): Mu7Bundle {
  const files: Mu7BundleFile[] = (Object.keys(MU7_EXPORT_COLUMNS) as Mu7ExportRole[]).map(
    (role) => {
      const rows = mu7SortRows(s.rows[role].filter((r) => r.mode === s.mode));
      const content = mu7Csv(MU7_EXPORT_COLUMNS[role], rows);
      return { name: `${role}.csv`, role, rows: rows.length, sha256: sha256(content), content };
    },
  );
  const manifest: Record<string, unknown> = {
    bundle_format_version: MU7_BUNDLE_FORMAT,
    mode: s.mode,
    status:
      s.mode === 'PILOT'
        ? 'SYNTHETIC PILOT: excluded from every statistic; the analysis reads FORMAL bundles only'
        : s.syntheticDatabase
          ? 'SYNTHETIC: written from a synthetic database (placeholder trials); never a study result'
          : 'FORMAL',
    app_git_sha: s.appGitSha,
    reference_locked_at: mu7CellText(s.lockedAt),
    n_units_locked: s.nUnitsLocked,
    design: s.design,
    freeze: s.freeze,
    snapshot: s.snapshot,
    files: Object.fromEntries(files.map((f) => [f.name, f.sha256])),
    row_counts: Object.fromEntries(files.map((f) => [f.name, f.rows])),
  };
  const manifestText = JSON.stringify(manifest, null, 1) + '\n';
  return {
    mode: s.mode,
    manifest,
    manifestName: 'manifest.json',
    manifestText,
    manifestSha256: sha256(manifestText),
    files,
  };
}

/** The registration payload rpc_mu7_register_export receives (row counts by role, as 0026 reads them). */
export function mu7RegistrationPayload(bundle: Mu7Bundle, appGitSha: string, notes?: string) {
  return {
    mode: bundle.mode,
    bundle_format_version: MU7_BUNDLE_FORMAT,
    row_counts: Object.fromEntries(bundle.files.map((f) => [f.role, f.rows])),
    file_sha256: Object.fromEntries(bundle.files.map((f) => [f.name, f.sha256])),
    manifest_sha256: bundle.manifestSha256,
    app_git_sha: appGitSha,
    notes: notes?.trim() ? notes.trim().slice(0, 4000) : null,
  };
}
