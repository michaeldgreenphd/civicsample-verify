// Verified sample description. No population estimator, weights, intervals or sensitivity analysis.
// The investigator deferred those analyses on October 27. Never prints IDs.
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { csvRecords, verifyMu7Bundle } from './verify-mu7-bundle';
import { sampleAgreement, sampleOutcomePercentages } from '../src/lib/sample-agreement';
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
type Row = Record<string, string>;
const answers = ['AGREE', 'DISAGREE', 'CANNOT_TELL'] as const;
const states = ['TYPE_2_STATED', 'TYPE_2_NOT_STATED', 'CANNOT_TELL_FROM_PACKET'] as const;
export function summarizeMu84Bundle(dir: string, registeredManifestSha256: string) {
  const check = verifyMu7Bundle(dir, registeredManifestSha256);
  if (!check.ok || check.format !== '8.4')
    throw new Error('A verified, registered bundle 8.4 is required.');
  const bytes = readFileSync(join(dir, 'manifest.json'), 'utf8');
  if (hash(bytes) !== registeredManifestSha256)
    throw new Error('Bundle changed during verification.');
  const manifest = JSON.parse(bytes);
  const read = (name: string): Row[] => {
    const file = join(dir, name);
    if (!lstatSync(file).isFile()) throw new Error('Bundle changed during verification.');
    const text = readFileSync(file, 'utf8');
    if (hash(text) !== manifest.files[name]) throw new Error('Bundle changed during verification.');
    const [columns, ...rows] = csvRecords(text);
    return rows.map((row) => Object.fromEntries(columns.map((c, i) => [c, row[i]])));
  };
  const finals = read('final_reference.csv'),
    flags = read('final_answer_flags.csv'),
    history = read('judgment_history.csv');
  const double = new Set(
    flags.filter((f) => f.both_final_cannot_tell === 'true').map((f) => f.unit_id),
  );
  const count = (rows: Row[]) => ({
    mappings: rows.length,
    confirmed: rows.filter((f) => f.final_answer === 'AGREE').length,
    notConfirmed: rows.filter((f) => f.final_answer === 'DISAGREE').length,
    unresolved: rows.filter((f) => f.final_status === 'UNRESOLVED').length,
    missing: rows.filter(
      (f) => f.final_status === 'INCOMPLETE' || f.final_status === 'PENDING_ADJUDICATION',
    ).length,
    bothFinalCannotTell: rows.filter((f) => double.has(f.unit_id)).length,
    adjudicated: rows.filter((f) => f.routing === 'ROUTED').length,
    finalIndependentAnswerTable: answers.flatMap((a) =>
      answers.map((b) => ({
        reviewer1: a,
        reviewer2: b,
        count: rows.filter((f) => f.answer_effective_slot1 === a && f.answer_effective_slot2 === b)
          .length,
      })),
    ),
  });
  const strata = [...new Set(finals.map((f) => `${f.family}|${f.category}`))].sort();
  const first = new Map<string, Row>(),
    latest = new Map<string, Row>();
  for (const h of history) {
    const k = h.unit_id + '|' + h.reviewer_slot;
    if (!first.has(k) || Number(h.revision_number) < Number(first.get(k)!.revision_number))
      first.set(k, h);
    if (!latest.has(k) || Number(h.revision_number) > Number(latest.get(k)!.revision_number))
      latest.set(k, h);
  }
  const subtypeCounts = (rows: Row[]) =>
    [1, 2].map((slot) => ({
      reviewerSlot: slot,
      answers: answers.flatMap((a) =>
        states.map((t) => ({
          membershipAnswer: a,
          statedType: t,
          count: rows.filter(
            (r) => r.reviewer_slot === String(slot) && r.answer === a && r.diabetes_subtype === t,
          ).length,
        })),
      ),
    }));
  return {
    reportVersion: 'mu84-descriptive-agreement-1',
    mode: check.mode,
    status: check.status,
    scope:
      check.status !== 'FORMAL'
        ? 'SYNTHETIC PRACTICE ONLY; excluded from study statistics'
        : 'Description of these reviewed mappings only; no population estimate.',
    registeredManifestSha256,
    populationEstimation:
      'DEFERRED: no weights, confidence intervals or population inference in this report',
    totalMappings: finals.length,
    finalIndependentJudgments: latest.size,
    savedRevisions: history.length - latest.size,
    byFamily: ['AREA', 'ROW', 'SG'].map((family) => {
      const records = finals.filter((f) => f.family === family),
        counts = count(records);
      return {
        family,
        ...counts,
        ...(family === 'SG'
          ? {}
          : {
              outcomePercentages: sampleOutcomePercentages(counts),
              reviewerAgreement: sampleAgreement(records),
            }),
      };
    }),
    byCategory: strata.map((stratum) => {
      const [family, category] = stratum.split('|');
      return {
        family,
        category,
        ...count(finals.filter((f) => f.family === family && f.category === category)),
      };
    }),
    diabetesStatedType: {
      adjudicated: false,
      first: subtypeCounts([...first.values()]),
      final: subtypeCounts([...latest.values()]),
    },
  };
}
if (process.argv[1] && resolve(process.argv[1]) === resolve('scripts/summarize-mu84-bundle.ts')) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 4 || args[0] !== '--bundle' || args[2] !== '--expect-manifest-sha256')
      throw new Error('Arguments required.');
    console.log(JSON.stringify(summarizeMu84Bundle(args[1], args[3]), null, 2));
  } catch {
    console.error(
      'Counts refused. Supply --bundle <directory> --expect-manifest-sha256 <registered hash> for a valid bundle 8.4.',
    );
    process.exitCode = 1;
  }
}
