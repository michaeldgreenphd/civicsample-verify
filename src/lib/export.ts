import { createHash } from 'node:crypto';
import type { ExportData } from './types';

export const ENGINEERING_NOTICE =
  'SYNTHETIC ENGINEERING ONLY — analysis plan is not approved; no clinical results';

/** UTF-8 JSON, recursively sorted object keys, preserved array order, trailing LF. */
export function canonicalJson(value: unknown): string {
  const order = (input: unknown): unknown => {
    if (input === null || typeof input === 'string' || typeof input === 'boolean') return input;
    if (typeof input === 'number' && Number.isFinite(input)) return input;
    if (Array.isArray(input)) return input.map(order);
    if (input && typeof input === 'object') {
      return Object.fromEntries(
        Object.entries(input)
          .sort(([a], [b]) => compare(a, b))
          .map(([key, item]) => [key, order(item)]),
      );
    }
    throw new Error('Export contains undefined, non-finite, or unsupported values');
  };
  return JSON.stringify(order(value), null, 2) + '\n';
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
export function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/** This is deliberately NOT a formal v4 analysis bundle. No prediction or weight is invented. */
export function buildPilotExport(data: ExportData) {
  if (data.campaign.mode !== 'SYNTHETIC_PILOT' || data.campaign.state !== 'LOCKED') {
    throw new Error('Only a locked synthetic pilot may be exported');
  }
  const cases = [...data.cases].sort((a, b) => compare(a.caseId, b.caseId));
  const ids = new Set(cases.map((row) => row.caseId));
  if (
    !cases.length ||
    ids.size !== cases.length ||
    cases.some((row) => !/^SYN-[A-Z0-9-]+$/.test(row.caseId))
  ) {
    throw new Error('Pilot export requires unique synthetic case identifiers');
  }
  const rows = <T extends { caseId: string; level: string; submittedAt: string; id: string }>(
    items: T[],
  ): T[] => {
    if (items.some((row) => !ids.has(row.caseId)))
      throw new Error('Export row is outside the pilot case list');
    if (new Set(items.map((row) => row.id)).size !== items.length)
      throw new Error('Duplicate export record');
    return [...items].sort(
      (a, b) =>
        compare(a.caseId, b.caseId) ||
        compare(a.level, b.level) ||
        compare(a.submittedAt, b.submittedAt) ||
        compare(a.id, b.id),
    );
  };
  const raw = rows(data.judgments);
  const adjudicated = rows(data.adjudications);
  const files = [
    {
      name: 'synthetic_cases.json',
      role: 'cases',
      rows: cases.length,
      content: canonicalJson(cases),
    },
    {
      name: 'synthetic_independent_judgments.json',
      role: 'independent_judgments',
      rows: raw.length,
      content: canonicalJson(raw),
    },
    {
      name: 'synthetic_adjudicated_reference.json',
      role: 'adjudicated_reference',
      rows: adjudicated.length,
      content: canonicalJson(adjudicated),
    },
    {
      name: 'synthetic_configuration.json',
      role: 'configuration',
      rows: 1,
      content: canonicalJson(data.configuration),
    },
    {
      name: 'synthetic_provenance.json',
      role: 'provenance',
      rows: 1,
      content: canonicalJson(data.provenance),
    },
  ].map((file) => ({ ...file, sha256: sha256(file.content) }));
  const manifest = {
    notice: ENGINEERING_NOTICE,
    export_type: 'SYNTHETIC_PILOT_ENGINEERING_ARCHIVE',
    export_format_version: 'pilot-json-1.0',
    is_synthetic_fixture: true,
    mode: 'SYNTHETIC_PILOT',
    campaign: data.campaign,
    analysis_eligible: false,
    clinical_metrics: null,
    metrics_blocked_reason:
      'SYN- pilot records are excluded from all performance analyses; the analysis plan is not approved.',
    reference_locked: true,
    frozen_prediction_set: null,
    sampling_weights: null,
    case_list_sha256: sha256(cases.map((row) => row.caseId).join('\n')),
    encoding: 'UTF-8; canonical sorted object keys; LF; file contents include trailing LF',
    judgment_semantics:
      'Independent submitted records are separate from the reference. Revision versions and timestamps, where present, are preserved. No reference decision overwrites a reviewer decision.',
    files: files.map((file) => ({
      name: file.name,
      role: file.role,
      rows: file.rows,
      sha256: file.sha256,
    })),
  };
  return { manifest, manifest_sha256: sha256(canonicalJson(manifest)), files };
}
