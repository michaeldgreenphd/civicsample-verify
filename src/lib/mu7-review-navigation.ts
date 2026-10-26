import type { Mu7ReviewerWorkspace } from './mu7-types';

/** Use the refreshed, authorized queue: the last primary answer can unlock subgroup checks. */
export function nextUnansweredUnit(
  queue: Mu7ReviewerWorkspace['queue'],
  savedAssignmentId: string,
) {
  const position = queue.find((q) => q.assignmentId === savedAssignmentId)?.queuePosition ?? 0;
  const remaining = queue
    .filter((q) => q.available && !q.answered && q.assignmentId !== savedAssignmentId)
    .sort((a, b) => a.queuePosition - b.queuePosition);
  return remaining.find((q) => q.queuePosition > position) ?? remaining[0] ?? null;
}
