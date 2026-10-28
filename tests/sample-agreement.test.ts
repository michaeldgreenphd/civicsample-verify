import test from 'node:test';
import assert from 'node:assert/strict';
import { sampleAgreement, sampleOutcomePercentages } from '../src/lib/sample-agreement';

test('sample agreement includes matching Cannot tell without turning it into confirmation', () => {
  const a = ['AGREE', 'DISAGREE', 'CANNOT_TELL'];
  const rows = [
    [2, 1, 0],
    [1, 2, 0],
    [0, 0, 2],
  ].flatMap((r, i) =>
    r.flatMap((n, j) =>
      Array.from({ length: n }, () => ({
        answer_effective_slot1: a[i],
        answer_effective_slot2: a[j],
      })),
    ),
  );
  const result = sampleAgreement([...rows, { answer_effective_slot1: 'AGREE' }]);
  assert.equal(result.pairedFinalAnswers, 8);
  assert.equal(result.excludedUnpaired, 1);
  assert.equal(result.matchingFinalAnswers, 6);
  assert.equal(result.matchingCannotTell, 2);
  assert.equal(result.exactAgreementPercent, 75);
  assert.ok(Math.abs(result.unweightedCohenKappa! - 13 / 21) < 1e-12);
  assert.equal(sampleAgreement([]).exactAgreementPercent, null);
  assert.equal(
    sampleAgreement([{ answer_effective_slot1: 'AGREE', answer_effective_slot2: 'AGREE' }])
      .unweightedCohenKappa,
    null,
  );
});
test('outcome percentages name the full family denominator and preserve unresolved outcomes', () => {
  const result = sampleOutcomePercentages({
    mappings: 20,
    confirmed: 12,
    notConfirmed: 3,
    unresolved: 5,
    missing: 0,
  });
  assert.equal(result.denominator, 20);
  assert.equal(result.confirmedPercent, 60);
  assert.equal(result.notConfirmedPercent, 15);
  assert.equal(result.unresolvedPercent, 25);
  assert.equal(
    sampleOutcomePercentages({
      mappings: 0,
      confirmed: 0,
      notConfirmed: 0,
      unresolved: 0,
      missing: 0,
    }).confirmedPercent,
    null,
  );
});
