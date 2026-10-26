import { z } from 'zod';
import { matchesMu81ReviewerProfile } from './mu81-reviewer-profile';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const formalIntakeSchema = z
  .object({
    format: z.literal('civicsample-formal-intake-1.0'),
    prepared_by_build: z.string().regex(/^[a-f0-9]{40}$/),
    source_import_sha256: hash,
    design: z
      .object({
        design_version: z.literal('review-design-v8.1.0'),
        assignment_set_id: z.string().min(1),
        overlap_setting: z.enum(['ALLOW', 'ONE_PER_TRIAL']),
        n_primary_planned: z.literal(96),
        n_subgroup_planned: z.literal(4),
      })
      .strict(),
    reviewer_profile: z
      .object({ profile_id: z.string(), rubric_sha256: hash })
      .strict()
      .refine((v) => matchesMu81ReviewerProfile(v.profile_id, v.rubric_sha256)),
    units: z.array(z.record(z.string(), z.unknown())).length(100),
    queue: z
      .array(
        z
          .object({
            reviewer_slot: z.enum(['1', '2']),
            queue_position: z.string().regex(/^([1-9]|[1-9][0-9]|100)$/),
            unit_id: z.string(),
          })
          .strict(),
      )
      .length(200),
    expected: z
      .object({
        unit_list_sha256: hash,
        assignment_set_sha256: hash,
        design_rows_sha256: hash,
        queue_sha256: hash,
        packet_inventory_sha256: hash,
        probability_binding_sha256: hash.nullable(),
      })
      .strict(),
    probability_binding: z.record(z.string(), z.unknown()).nullable(),
  })
  .strict();
export type FormalIntake = z.infer<typeof formalIntakeSchema>;
export interface FormalIntakePlan {
  packageSha256: string;
  targetState: 'EMPTY' | 'OCCUPIED' | 'RECORDED' | 'CLOSED';
  mappings: 100;
  queuePositionsChecked: 200;
  guideProfile: string;
  reviewRemainsClosed: true;
}
export const intakeRequestSchema = z
  .object({
    packageSha256: hash,
    attestation: z.string().trim().min(20).max(2000),
  })
  .strict();
