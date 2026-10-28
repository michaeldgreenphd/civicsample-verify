import { z } from 'zod';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const count = z.number().int().nonnegative();
export const releaseStatusSchema = z.object({
  prepared: z.boolean(),
  phase: z.enum(['NOT_SIGNED_OFF', 'SIGNED_OFF', 'OPEN', 'CLOSED_COMPLETE', 'CLOSED_INCOMPLETE']),
  formal_units: count,
  training_units: count,
  pilot_locked: z.boolean(),
  pilot_exports: z.array(z.object({ id: z.uuid(), manifest: hash })),
  protocol_bound: z.boolean(),
  descriptive_plan_recorded: z.boolean(),
  frozen: z.boolean(),
  assignments: count,
  completion: z.array(
    z.object({
      reviewer_slot: z.number().int().min(1).max(2),
      assigned: count,
      answered: count,
      finished: z.boolean(),
    }),
  ),
  snapshot_recorded: z.boolean(),
  reference_locked: z.boolean(),
  formal_exports: count,
  freeze_blockers: z.string().nullable(),
  opening_blockers: z.string().nullable(),
  reviewers: z.array(z.object({ id: z.uuid(), label: z.string() })),
  state_sha256: hash,
});
export type ReleaseStatus = z.infer<typeof releaseStatusSchema>;
const common = {
  stateSha256: hash,
  attestation: z.string().trim().min(20).max(2000),
  confirm: z.literal(true),
};
export const releaseRequestSchema = z.discriminatedUnion('action', [
  z.object({ ...common, action: z.literal('bind-completion') }).strict(),
  z.object({ ...common, action: z.literal('record-descriptive-plan') }).strict(),
  z.object({ ...common, action: z.literal('accept-pilot'), pilotExportId: z.uuid() }).strict(),
  z.object({ ...common, action: z.literal('freeze-sample') }).strict(),
  z
    .object({
      ...common,
      action: z.literal('assign-reviewers'),
      reviewerIds: z.tuple([z.uuid(), z.uuid()]),
      qualifications: z.tuple([
        z.string().trim().min(20).max(2000),
        z.string().trim().min(20).max(2000),
      ]),
    })
    .strict(),
  z.object({ ...common, action: z.literal('open-review') }).strict(),
  z.object({ ...common, action: z.literal('close-review') }).strict(),
  z.object({ ...common, action: z.literal('lock-reference') }).strict(),
]);
export type ReleaseAction = z.infer<typeof releaseRequestSchema>['action'];
export const RELEASE_ACTIONS: Record<ReleaseAction, { label: string; description: string }> = {
  'record-descriptive-plan': {
    label: 'Record the sample-only reporting plan',
    description:
      'Describe the 100 reviewed mappings: separate area and condition results, reviewer agreement, adjudicated outcomes and Cannot tell counts. Defer weights, confidence intervals and population estimates. This specifies G-EST-01 for a separate investigator approval.',
  },
  'bind-completion': {
    label: 'Record final-submission rules',
    description:
      'Each reviewer may revise saved answers until finishing all 100. Every Cannot tell goes to adjudication. This records guide revision 5 before any formal answers.',
  },
  'accept-pilot': {
    label: 'Accept the completed rehearsal',
    description:
      'Confirm the reviewed rehearsal checklist and select its registered synthetic export. Practice answers remain excluded from study results.',
  },
  'freeze-sample': {
    label: 'Freeze the prepared sample',
    description:
      'Lock the exact 100 mappings, packets, guide and probability provenance. All required investigator decisions must already be approved.',
  },
  'assign-reviewers': {
    label: 'Assign the two reviewers',
    description:
      'Enroll two separate clinical reviewers and assign the verified 100-position queue to each. Review remains closed.',
  },
  'open-review': {
    label: 'Open clinical review',
    description:
      'Allow the two assigned reviewers to read and answer the real mappings. This is the final launch action.',
  },
  'close-review': {
    label: 'Close review and prepare adjudication',
    description:
      'Both reviewers must have finished. Preserve their final answers and revision history in a snapshot, then make disagreements and Cannot tell cases available to the adjudicator.',
  },
  'lock-reference': {
    label: 'Lock the adjudicated reference',
    description:
      'Require every routed case to be resolved or explicitly recorded as unresolved. Lock the reference before export.',
  },
};
export function releaseBlocker(s: ReleaseStatus, action: ReleaseAction): string | null {
  if (!s.prepared || s.formal_units !== 100)
    return 'Load and verify the 100-mapping preparation first.';
  switch (action) {
    case 'record-descriptive-plan':
      return s.descriptive_plan_recorded ||
        s.frozen ||
        !['NOT_SIGNED_OFF', 'SIGNED_OFF'].includes(s.phase)
        ? 'Already recorded or past the preparation stage.'
        : null;
    case 'bind-completion':
      return s.protocol_bound || s.frozen || !['NOT_SIGNED_OFF', 'SIGNED_OFF'].includes(s.phase)
        ? 'Already recorded or past the preparation stage.'
        : null;
    case 'accept-pilot':
      return s.phase !== 'NOT_SIGNED_OFF'
        ? 'Pilot acceptance is already recorded.'
        : !s.pilot_locked || !s.pilot_exports.length
          ? 'Finish, lock and register the synthetic rehearsal in this workspace first.'
          : null;
    case 'freeze-sample':
      return s.frozen
        ? 'The sample is already frozen.'
        : !s.protocol_bound
          ? 'Record final-submission rules first.'
          : !s.descriptive_plan_recorded
            ? 'Record the sample-only reporting plan first.'
            : s.phase !== 'SIGNED_OFF'
              ? 'Accept the completed rehearsal first.'
              : s.training_units !== 3
                ? 'Record the three separate worked examples first.'
                : s.freeze_blockers;
    case 'assign-reviewers':
      return !s.frozen || s.phase !== 'SIGNED_OFF'
        ? 'Freeze the sample before assignment.'
        : s.assignments
          ? 'Reviewer assignments are already recorded.'
          : s.reviewers.length < 2
            ? 'Two active clinical reviewer accounts are required.'
            : null;
    case 'open-review':
      return s.phase !== 'SIGNED_OFF'
        ? 'Review is already open, closed or awaiting rehearsal acceptance.'
        : !s.frozen ||
            !s.protocol_bound ||
            !s.descriptive_plan_recorded ||
            s.assignments !== 200 ||
            s.training_units !== 3
          ? 'Complete the freeze, protocol, 200 assignments and three worked examples first.'
          : s.opening_blockers;
    case 'close-review':
      return s.phase !== 'OPEN'
        ? 'Review must be open.'
        : s.completion.length !== 2 ||
            s.completion.some((c) => !c.finished || c.assigned !== 100 || c.answered !== 100)
          ? 'Wait for both reviewers to finish and lock all 100 answers.'
          : null;
    case 'lock-reference':
      return !s.snapshot_recorded || s.phase !== 'CLOSED_COMPLETE'
        ? 'Close completed review and record the snapshot first.'
        : s.reference_locked
          ? 'The reference is already locked.'
          : null;
  }
}
