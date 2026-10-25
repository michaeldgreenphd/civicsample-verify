import { MU7_ANSWER_TEXT, type Mu7Answer, type Mu7UnitBlock } from './mu7-types';
import { MU81_REVIEWER_PROFILE_ID, isMu81ReviewerProfileId } from './mu81-reviewer-profile';

/** Presentation helpers never change the stored packet or the submitted vocabulary. */
export const PLAIN_LANGUAGE_PROFILE = MU81_REVIEWER_PROFILE_ID;

export const readableCode = (value: string) =>
  value
    .toLowerCase()
    .replaceAll('_', ' ')
    .replace(/^./, (c) => c.toUpperCase());

const REASON_LABELS: Record<string, string> = {
  ORGAN_OF_ORIGIN_ONLY: 'Cancer’s organ of origin only',
  NOT_THE_CONDITION_STUDIED: 'Not the condition studied',
  MESH_PLACEMENT_MISLEADING: 'MeSH placement is misleading',
  RUBRIC_POLICY_EXCLUDES: 'Excluded by the review policy',
  OTHER_SPECIFIED: 'Another reason — explain in the note',
  TYPE_1_ONLY: 'Type 1 diabetes only',
  OTHER_DIABETES_TYPE: 'Another specified type of diabetes',
  PREDIABETES_ONLY: 'Prediabetes only',
  DIABETES_NOT_STUDIED: 'Diabetes is not studied',
  TYPE_2_STATED: 'Type 2 diabetes is stated',
  TYPE_2_STUDIED: 'Type 2 diabetes is studied',
  TYPE_NOT_DETERMINABLE: 'Diabetes type cannot be determined',
  DIABETES_STUDIED: 'Diabetes is studied',
  BENIGN_NEOPLASM: 'Benign neoplasm',
  PRECANCEROUS: 'Precancerous condition',
  NOT_A_NEOPLASM: 'Not a neoplasm',
  MALIGNANT_NEOPLASM_STUDIED: 'Malignant neoplasm studied',
  NONMALIGNANT_NEOPLASM_STUDIED: 'Nonmalignant neoplasm studied',
};

export function reasonLabel(code: string, profileId?: string | null): string {
  if (code === 'ORGAN_OF_ORIGIN_ONLY' && isMu81ReviewerProfileId(profileId))
    return 'Cancer origin, spread or course only';
  if (code === 'PRECANCEROUS' && isMu81ReviewerProfileId(profileId))
    return 'Cyst, hamartoma or precancerous condition only';
  return REASON_LABELS[code] ?? readableCode(code).replace(/\bmesh\b/gi, 'MeSH');
}

/** Replace internal study labels, never registry evidence or a stored clinical assertion. */
export function studyLabel(text: string): string {
  return text
    .replace(/\bRule D(?:, diabetes type)?\b/g, 'Diabetes inclusion check')
    .replace(/\bRule K(?:, malignancy)?\b/g, 'Neoplasm inclusion check')
    .replace(/\bFigure 2 condition row:/g, 'Condition group:');
}

export function unitDisplay(unit: Mu7UnitBlock, profileId?: string | null) {
  const label = studyLabel(unit.mapping_label);
  const split = label.indexOf(' (parent MeSH category ');
  const title = split < 0 ? label : label.slice(0, split);
  const context = split < 0 ? null : label.slice(split + 2, -1);
  const excluded = unit.family === 'SG' && /(?:^|_)REMOVE(?:_|$)/.test(unit.assignment_code);
  const included = unit.family === 'SG' && /(?:^|_)KEEP(?:_|$)/.test(unit.assignment_code);
  const group = unit.parent_row_label?.replace(/\bMellitus\b/g, 'mellitus');
  // The revised guide judges inclusion. Older packets can make a narrower assertion (for
  // example malignancy), so the legacy question must continue to ask about that assertion.
  const action = isMu81ReviewerProfileId(profileId)
    ? excluded
      ? 'exclude'
      : included
        ? 'include'
        : null
    : null;
  const question = action
    ? `Was it appropriate to ${action} this trial ${excluded ? 'from' : 'in'} the ${group ?? 'displayed condition'} group?`
    : unit.family === 'AREA'
      ? 'Does the trial study a condition that clinically fits this therapeutic area?'
      : unit.family === 'ROW'
        ? 'Does the trial study the displayed condition?'
        : 'Is this displayed classification right for this trial?';
  const decision = unit.display_decision
    ?.replace(/^KEEP:\s*kept in the /, 'Included in the ')
    .replace(/^REMOVE:\s*removed from the /, 'Excluded from the ')
    .replace(/ row$/, ' group');
  const inclusionBasis: Record<string, string> = {
    D1_KEEP_TYPE2: 'A registered MeSH heading indicates type 2 diabetes.',
    D4A_KEEP_UNRESOLVED_PARENT_ONLY:
      'The registered headings include general diabetes without stating its type.',
    D4B_KEEP_UNRESOLVED_COMPLICATION_ONLY:
      'A registered heading describes a diabetes complication without stating the diabetes type.',
    D2_REMOVE_OTHER_TYPE:
      'The headings indicate type 1, gestational or another specified diabetes type, with no type 2 heading.',
    D3_REMOVE_PREDIABETES_ONLY:
      'The headings indicate prediabetes only, with no diabetes mellitus heading.',
    K_KEEP_MALIGNANT_COMPATIBLE:
      'At least one neoplasm heading is outside the study’s list of cysts, hamartomas and precancerous conditions.',
    K_KEEP_HEURISTIC_NONMALIGNANT_CLASS:
      'At least one neoplasm heading is outside the study’s list of cysts, hamartomas and precancerous conditions.',
    K_REMOVE_VERIFIED_NONMALIGNANT:
      'Every neoplasm heading is on the study’s list of cysts, hamartomas and precancerous conditions.',
  };
  return {
    title,
    context,
    // A historical malignancy assertion stays a malignancy assertion. New profiles supply
    // their own versioned text from the server; the UI never invents a replacement target.
    assertion: unit.display_text,
    note: unit.display_note ? studyLabel(unit.display_note) : undefined,
    parent_row_label: unit.parent_row_label,
    decision,
    question,
    polarity:
      action === 'exclude'
        ? 'Agree confirms the exclusion. Disagree means the trial should have been included.'
        : action === 'include'
          ? 'Agree confirms the inclusion. Disagree means the trial should have been excluded.'
          : null,
    basis:
      unit.family === 'AREA'
        ? context
          ? `The original sorting used this ${context}, with any study exception stated below.`
          : 'The trial’s registered MeSH headings produced this therapeutic-area assignment.'
        : unit.family === 'ROW'
          ? 'The trial’s registered MeSH headings met the study’s criteria for this condition group.'
          : (inclusionBasis[unit.assignment_code] ??
            'The trial’s registered MeSH headings produced the inclusion or exclusion shown above.'),
  };
}

export function answerMeaning(answer: Mu7Answer, profileId?: string | null): string {
  if (isMu81ReviewerProfileId(profileId)) {
    if (answer === 'CANNOT_TELL')
      return 'The registry information lacks something you need to decide. Add a note identifying what is missing.';
    if (answer === 'AGREE') return 'The displayed classification is appropriate for this trial.';
    return 'The displayed classification is not appropriate. Choose a reason and explain it briefly.';
  }
  return MU7_ANSWER_TEXT[answer].meaning;
}

/** A deliberately small, text-only Markdown subset. No HTML or executable URLs are interpreted. */
export type GuideBlock =
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'list'; ordered: boolean; items: string[] }
  | { kind: 'table'; headings: string[]; rows: string[][] };

export function parseReviewerGuide(markdown: string): GuideBlock[] {
  const lines = markdown.replaceAll('\r\n', '\n').split('\n');
  const blocks: GuideBlock[] = [];
  const cells = (line: string) =>
    line
      .trim()
      .replace(/^\||\|$/g, '')
      .split('|')
      .map((s) => s.trim());
  const list = /^(?:([-*])\s+|(\d+)\.\s+)(.*)$/;
  for (let i = 0; i < lines.length;) {
    const line = lines[i].trim();
    if (!line) {
      i++;
      continue;
    }
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) {
      blocks.push({ kind: 'heading', level: heading[1].length, text: heading[2] });
      i++;
      continue;
    }
    if (line.startsWith('|') && /^\s*\|(?:\s*:?-+:?\s*\|)+\s*$/.test(lines[i + 1] ?? '')) {
      const headings = cells(line);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i].trim().startsWith('|')) rows.push(cells(lines[i++]));
      blocks.push({ kind: 'table', headings, rows });
      continue;
    }
    const item = list.exec(line);
    if (item) {
      const ordered = Boolean(item[2]);
      const items: string[] = [];
      while (i < lines.length) {
        const next = list.exec(lines[i].trim());
        if (!next || Boolean(next[2]) !== ordered) break;
        items.push(next[3]);
        i++;
      }
      blocks.push({ kind: 'list', ordered, items });
      continue;
    }
    const paragraph = [line];
    i++;
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^(#{1,6})\s|^\||^(?:[-*]|\d+\.)\s/.test(lines[i].trim())
    )
      paragraph.push(lines[i++].trim());
    blocks.push({ kind: 'paragraph', text: paragraph.join(' ') });
  }
  return blocks;
}
