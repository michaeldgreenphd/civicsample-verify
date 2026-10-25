import type { McInvestigatorWorkspace } from './mapconf-types';

// Public synthetic pilot sizes; the regression test binds these to the actual fixture arrays.
export const MC_PILOT_SIZE = 12;
export const MC_TRAINING_SIZE = 3;

export function mcPreparation(workspace: Pick<McInvestigatorWorkspace, 'counts' | 'completion'>) {
  const imported =
    workspace.counts.syntheticPilot === MC_PILOT_SIZE &&
    workspace.counts.trainingExample === MC_TRAINING_SIZE &&
    workspace.counts.evaluation === 0;
  const hasImported = workspace.counts.syntheticPilot + workspace.counts.trainingExample > 0;
  const hasAssignments = workspace.completion.some((row) => row.assigned > 0);
  const assigned =
    imported &&
    workspace.completion.length === 2 &&
    new Set(workspace.completion.map((row) => row.reviewerPseudoId)).size === 2 &&
    [1, 2].every((slot) =>
      workspace.completion.some(
        (row) => row.reviewerSlot === slot && row.assigned === MC_PILOT_SIZE,
      ),
    );
  return { imported, assigned, hasImported, hasAssignments };
}
