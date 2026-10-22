// Request validation for the mapping-confirmation routes. The database re-checks every rule.
import { z } from 'zod';
import { MC_ADJUDICATION_STATUSES, MC_ANSWERS } from './mapconf-types';

const hex64 = z.string().regex(/^[0-9a-fA-F]{64}$/);
export const mcSubmissionSchema = z
  .object({
    answer: z.enum(MC_ANSWERS),
    annotation: z.string().max(4000).optional(),
    displayedAssignmentSha256: hex64,
    displayedEvidenceSha256: hex64,
    displayedEvidenceVersion: z.number().int().min(1),
    rubricVersion: z.string().min(3).max(80),
    rubricSha256: hex64,
    secondsOnCase: z.number().int().min(0).max(10_000_000).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.answer !== 'YES' && !value.annotation?.trim())
      ctx.addIssue({
        code: 'custom',
        message: 'An annotation is required for No and Insufficient information.',
        path: ['annotation'],
      });
  });

export const mcAdjudicationSchema = z
  .object({
    caseId: z.string().regex(/^MC-(SYN|TRN|EVAL)-[A-Z0-9][A-Z0-9-]{1,40}$/),
    decision: z.enum(['YES', 'NO']).optional(),
    status: z.enum(MC_ADJUDICATION_STATUSES),
    basis: z.enum(['REVIEWER_1', 'REVIEWER_2', 'NEITHER', 'NONE']),
    rationale: z.string().min(3).max(4000),
  })
  .strict()
  .superRefine((value, ctx) => {
    const escalated = value.status === 'UNRESOLVED_ESCALATED';
    if (escalated !== (value.decision === undefined))
      ctx.addIssue({
        code: 'custom',
        message: 'A decision is recorded unless the mapping is escalated.',
        path: ['decision'],
      });
    if (escalated !== (value.basis === 'NONE'))
      ctx.addIssue({
        code: 'custom',
        message: 'Basis NONE applies only to an escalation.',
        path: ['basis'],
      });
  });

const attestation = z.string().min(20).max(2000);
export const mcAdminSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('create-campaign') }).strict(),
  z.object({ action: z.literal('import-synthetic') }).strict(),
  z.object({ action: z.literal('import-evaluation') }).strict(),
  z
    .object({ action: z.literal('assign'), seed: z.number().int().min(1).max(2_147_483_647) })
    .strict(),
  z
    .object({
      action: z.literal('phase'),
      eventType: z.enum(['CLOSED', 'ADJUDICATION_AUTHORIZED', 'LOCKED']),
      attestation,
    })
    .strict(),
  z
    .object({ action: z.literal('register-export'), notes: z.string().max(2000).optional() })
    .strict(),
]);
