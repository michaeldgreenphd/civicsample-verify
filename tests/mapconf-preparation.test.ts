import assert from 'node:assert/strict';
import test from 'node:test';
import { mcPreparation, MC_PILOT_SIZE, MC_TRAINING_SIZE } from '../src/lib/mapconf-preparation';
import {
  MC_SYNTHETIC_PILOT_CASES,
  MC_SYNTHETIC_TRAINING_CASES,
} from '../src/lib/mapconf-synthetic';
import type { McCompletionRow } from '../src/lib/mapconf-types';

const completeCounts = { syntheticPilot: 12, trainingExample: 3, evaluation: 0 };
const slot = (
  reviewerSlot: number,
  assigned = 12,
  reviewerPseudoId = `SYN-R${reviewerSlot}`,
): McCompletionRow => ({
  reviewerPseudoId,
  reviewerSlot,
  assigned,
  submitted: 0,
});

test('synthetic preparation counts follow the reviewed fixture sizes', () => {
  assert.equal(MC_PILOT_SIZE, MC_SYNTHETIC_PILOT_CASES.length);
  assert.equal(MC_TRAINING_SIZE, MC_SYNTHETIC_TRAINING_CASES.length);
});

test('partial synthetic import remains resumable, including missing training examples', () => {
  for (const counts of [
    { syntheticPilot: 3, trainingExample: 0, evaluation: 0 },
    { syntheticPilot: 12, trainingExample: 2, evaluation: 0 },
  ]) {
    const result = mcPreparation({ counts, completion: [] });
    assert.equal(result.imported, false);
    assert.equal(result.assigned, false);
    assert.equal(result.hasImported, true);
  }
});

test('one queue or a partial second queue never implies complete assignment', () => {
  for (const completion of [
    [slot(1)],
    [slot(1), slot(2, 5)],
    [slot(1), slot(2, 12, 'SYN-R1')],
    [slot(1), slot(1, 12, 'SYN-OTHER')],
  ]) {
    const result = mcPreparation({ counts: completeCounts, completion });
    assert.equal(result.imported, true);
    assert.equal(result.assigned, false);
    assert.equal(result.hasAssignments, true);
  }
  assert.equal(
    mcPreparation({ counts: completeCounts, completion: [slot(1), slot(2)] }).assigned,
    true,
  );
});
