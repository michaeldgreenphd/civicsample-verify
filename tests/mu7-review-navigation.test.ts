import assert from 'node:assert/strict';
import test from 'node:test';
import { nextUnansweredUnit } from '../src/lib/mu7-review-navigation';
import type { Mu7ReviewerWorkspace } from '../src/lib/mu7-types';

const queue = (): Mu7ReviewerWorkspace['queue'] =>
  [1, 2, 3, 4].map((n) => ({
    assignmentId: `synthetic-assignment-${n}`,
    mode: 'PILOT',
    reviewerSlot: 1,
    queuePosition: n,
    unitId: `SYN-NAV-${n}`,
    unitRole: n === 4 ? 'SUBGROUP' : 'PRIMARY',
    available: n !== 4,
    answered: n === 2,
  }));

test('next case follows queue position, skips answered and unavailable cases, and preserves the queue', () => {
  const q = queue().reverse();
  const before = structuredClone(q);
  assert.equal(nextUnansweredUnit(q, 'synthetic-assignment-1')?.queuePosition, 3);
  assert.deepEqual(q, before);
});
test('next case wraps to an earlier unanswered case after out-of-order review', () => {
  assert.equal(nextUnansweredUnit(queue(), 'synthetic-assignment-3')?.queuePosition, 1);
});
test('fresh availability can unlock the subgroup after the final primary answer', () => {
  const q = queue().map((row) => ({ ...row, answered: row.unitRole === 'PRIMARY' }));
  assert.equal(nextUnansweredUnit(q, 'synthetic-assignment-3'), null);
  q[3].available = true;
  assert.equal(nextUnansweredUnit(q, 'synthetic-assignment-3')?.queuePosition, 4);
});
test('a finished or empty queue never repeats the saved case', () => {
  assert.equal(
    nextUnansweredUnit(
      queue().map((q) => ({ ...q, answered: true })),
      'synthetic-assignment-4',
    ),
    null,
  );
  assert.equal(nextUnansweredUnit([queue()[0]], 'synthetic-assignment-1'), null);
  assert.equal(nextUnansweredUnit([], 'synthetic-assignment-1'), null);
});
