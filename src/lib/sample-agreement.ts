/** Descriptive statistics of observed paired answers only; no sampling weights or intervals. */
const answers = ['AGREE', 'DISAGREE', 'CANNOT_TELL'] as const;
export type SamplePair = { answer_effective_slot1?: string; answer_effective_slot2?: string };
export function sampleAgreement(rows: SamplePair[]) {
  const table = answers.map((a) =>
    answers.map(
      (b) =>
        rows.filter((r) => r.answer_effective_slot1 === a && r.answer_effective_slot2 === b).length,
    ),
  );
  const paired = table.flat().reduce((a, b) => a + b, 0);
  const matching = table.reduce((s, row, i) => s + row[i], 0);
  const expected = paired
    ? table.reduce(
        (s, row, i) => s + row.reduce((a, b) => a + b, 0) * table.reduce((a, r) => a + r[i], 0),
        0,
      ) /
      (paired * paired)
    : null;
  const observed = paired ? matching / paired : null;
  return {
    pairedFinalAnswers: paired,
    excludedUnpaired: rows.length - paired,
    matchingFinalAnswers: matching,
    matchingCannotTell: table[2][2],
    exactAgreementPercent: observed === null ? null : observed * 100,
    unweightedCohenKappa:
      observed === null || expected === null || expected >= 1
        ? null
        : (observed - expected) / (1 - expected),
    interpretation:
      'Descriptive agreement in this reviewed sample. Matching Cannot tell answers are agreement, not clinical confirmation.',
  };
}
export function sampleOutcomePercentages(counts: {
  mappings: number;
  confirmed: number;
  notConfirmed: number;
  unresolved: number;
  missing: number;
}) {
  const pct = (n: number) => (counts.mappings ? (n / counts.mappings) * 100 : null);
  return {
    denominator: counts.mappings,
    denominatorDescription:
      'All reviewed mappings in this family; unresolved answers remain a separate outcome.',
    confirmedPercent: pct(counts.confirmed),
    notConfirmedPercent: pct(counts.notConfirmed),
    unresolvedPercent: pct(counts.unresolved),
    missingPercent: pct(counts.missing),
  };
}
