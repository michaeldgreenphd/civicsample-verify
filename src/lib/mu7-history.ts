// Reproduce the database's existing hashes, never a new serialization of stored judgments.
import { createHash } from 'node:crypto';
import { MU7_REASON_MEANING } from './mu7-types';
import { isMu81ReviewerProfileId } from './mu81-reviewer-profile';
export const HISTORY_COLUMNS = [
  'unit_id',
  'mode',
  'assignment_id',
  'reviewer_slot',
  'reviewer_pseudo_id',
  'revision_number',
  'answer',
  'reason_code',
  'note',
  'uncertain',
  'seconds_on_unit',
  'diabetes_subtype',
  'content_sha256',
  'submitted_at_utc',
] as const;
type Row = Record<string, string>;
const hash = (v: string) => createHash('sha256').update(v, 'utf8').digest('hex');
const fields = (r: Row, names: readonly string[]) => names.map((k) => r[k]).join('|');
const group = (r: Row) => JSON.stringify([r.unit_id, r.reviewer_slot]);
const revision = (r: Row) => JSON.stringify([r.unit_id, r.reviewer_slot, r.revision_number]);
const check: (value: unknown) => asserts value = (value) => {
  if (!value)
    throw new Error('Judgment history differs from its locked snapshot or export contract');
};
const integer = (v: string, min: number, max = 2147483647) =>
  /^(0|[1-9][0-9]*)$/.test(v) && Number(v) >= min && Number(v) <= max;
const milliseconds = (v: string) => v.slice(0, 23) + 'Z';
function timestamp(v: string) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(v)) return false;
  const d = new Date(milliseconds(v));
  return Number.isFinite(d.getTime()) && d.toISOString() === milliseconds(v);
}
/** All rows are CSV strings. Errors deliberately contain no response text or identifiers. */
export function verifyJudgmentHistory(
  history: Row[],
  judgments: Row[],
  subtypes: Row[],
  mode: 'PILOT' | 'FORMAL',
  snapshot: unknown,
  reviewerProfileId?: string,
): void {
  const groups = new Map<string, Row[]>();
  const assignments = new Map<string, string>();
  const observations = new Map<string, Row>();
  for (const s of subtypes) {
    check(!observations.has(revision(s)));
    observations.set(revision(s), s);
  }
  for (const r of history) {
    check(HISTORY_COLUMNS.every((k) => typeof r[k] === 'string'));
    check(r.mode === mode && /^[A-Za-z0-9_-]+$/.test(r.unit_id));
    check((mode === 'PILOT' ? /^PT-[A-Z0-9]{4}$/ : /^R-[A-Z0-9]{4}$/).test(r.reviewer_pseudo_id));
    check(['1', '2'].includes(r.reviewer_slot) && integer(r.revision_number, 1));
    check(/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(r.assignment_id));
    check(['AGREE', 'DISAGREE', 'CANNOT_TELL'].includes(r.answer));
    check(
      r.answer === 'DISAGREE'
        ? Object.hasOwn(MU7_REASON_MEANING, r.reason_code) ||
            (isMu81ReviewerProfileId(reviewerProfileId) &&
              r.reason_code === 'NONMALIGNANT_NEOPLASM_STUDIED')
        : r.reason_code === '',
    );
    check(['true', 'false'].includes(r.uncertain));
    check(r.seconds_on_unit === '' || integer(r.seconds_on_unit, 0));
    check(
      ['', 'TYPE_2_STATED', 'TYPE_2_NOT_STATED', 'CANNOT_TELL_FROM_PACKET'].includes(
        r.diabetes_subtype,
      ),
    );
    check(timestamp(r.submitted_at_utc));
    const base = hash(
      fields(r, [
        'assignment_id',
        'revision_number',
        'answer',
        'reason_code',
        'note',
        'uncertain',
        'seconds_on_unit',
      ]),
    );
    check(hash(['mu81-judgment-1', base, r.diabetes_subtype].join('|')) === r.content_sha256);
    const s = observations.get(revision(r));
    check(
      s && ['mode', 'answer', 'diabetes_subtype', 'content_sha256'].every((k) => s[k] === r[k]),
    );
    observations.delete(revision(r));
    const key = group(r);
    check(!assignments.has(r.assignment_id) || assignments.get(r.assignment_id) === key);
    assignments.set(r.assignment_id, key);
    const rows = groups.get(key) ?? [];
    rows.push(r);
    groups.set(key, rows);
  }
  check(observations.size === 0);
  const seen = new Set<string>();
  for (const j of judgments) {
    const key = group(j);
    check(j.mode === mode && !seen.has(key));
    seen.add(key);
    const rows = (groups.get(key) ?? []).sort(
      (a, b) => Number(a.revision_number) - Number(b.revision_number),
    );
    if (j.judgment_status === 'NOT_ANSWERED') {
      check(rows.length === 0);
      continue;
    }
    check(j.judgment_status === 'ANSWERED' && integer(j.n_revisions, 0));
    check(rows.length === Number(j.n_revisions) + 1);
    check(
      rows.every(
        (r, i) =>
          Number(r.revision_number) === i + 1 &&
          r.reviewer_pseudo_id === j.reviewer_pseudo_id &&
          r.assignment_id === rows[0].assignment_id,
      ),
    );
    for (const [r, suffix, time] of [
      [rows[0], 'initial', 'first_submitted_at'],
      [rows.at(-1)!, 'effective', 'last_submitted_at'],
    ] as const) {
      check(
        r.answer === j[`answer_${suffix}`] &&
          r.reason_code === j[`reason_${suffix}`] &&
          r.note === j[`note_${suffix}`] &&
          r.uncertain === j[`uncertain_${suffix}`],
      );
      check(milliseconds(r.submitted_at_utc) === j[time]);
    }
    groups.delete(key);
  }
  check(groups.size === 0);
  if (mode === 'FORMAL') {
    check(snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot));
    const snap = snapshot as Record<string, unknown>;
    const sorted = [...history].sort((a, b) =>
      a.unit_id < b.unit_id
        ? -1
        : a.unit_id > b.unit_id
          ? 1
          : Number(a.reviewer_slot) - Number(b.reviewer_slot) ||
            Number(a.revision_number) - Number(b.revision_number),
    );
    const body = sorted
      .map((r) =>
        fields(r, [
          'unit_id',
          'reviewer_slot',
          'reviewer_pseudo_id',
          'revision_number',
          'answer',
          'reason_code',
          'note',
          'uncertain',
          'content_sha256',
          'submitted_at_utc',
        ]),
      )
      .join('\n');
    check(snap.n_rows === history.length && snap.content_sha256 === hash(body));
  } else check(snapshot === null);
}
