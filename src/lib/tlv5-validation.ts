// Request validation for the design v5 routes. The database re-checks every rule; these schemas
// keep malformed input from reaching it and give reviewers a precise error.
import { z } from 'zod';
import {
  ADJUDICATION_BASES,
  ADJUDICATION_STATUSES,
  DISAGREEMENT_REASONS,
  REVIEWER_ITEMS,
  SG_ROW,
  answerAllowed,
  detailAllowed,
  itemFamily,
} from './tlv5-codes';

const itemSchema = z
  .object({
    itemCode: z.string().max(40),
    answer: z.string().max(40),
    uncertain: z.boolean(),
    note: z.string().max(2000).optional(),
    detailCode: z.string().max(40).optional(),
  })
  .strict();

export const tlv5SubmissionSchema = z
  .object({
    items: z.array(itemSchema).min(17).max(19),
    overallComment: z.string().max(4000).optional(),
    packetIssueFlag: z.boolean(),
    packetIssueNote: z.string().max(2000).optional(),
    secondsOnCase: z.number().int().min(0).max(10_000_000).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const codes = value.items.map((i) => i.itemCode);
    if (new Set(codes).size !== codes.length)
      ctx.addIssue({ code: 'custom', message: 'Duplicate item.', path: ['items'] });
    for (const [index, item] of value.items.entries()) {
      if (!REVIEWER_ITEMS.includes(item.itemCode))
        ctx.addIssue({ code: 'custom', message: 'Unknown item.', path: ['items', index] });
      else if (!answerAllowed(item.itemCode, item.answer))
        ctx.addIssue({
          code: 'custom',
          message: 'Answer is outside the item scale.',
          path: ['items', index, 'answer'],
        });
      else if (!detailAllowed(item.itemCode, item.answer, item.detailCode))
        ctx.addIssue({
          code: 'custom',
          message: 'Detail code does not fit the answer.',
          path: ['items', index, 'detailCode'],
        });
      if (item.detailCode === 'OTHER_SPECIFIED' && !item.note?.trim())
        ctx.addIssue({
          code: 'custom',
          message: 'OTHER_SPECIFIED needs a note.',
          path: ['items', index, 'note'],
        });
    }
    const families = value.items.map((i) => itemFamily(i.itemCode));
    if (families.filter((f) => f === 'AREA').length !== 7)
      ctx.addIssue({
        code: 'custom',
        message: 'All seven area items are required.',
        path: ['items'],
      });
    if (families.filter((f) => f === 'FIG2_ROW').length !== 10)
      ctx.addIssue({
        code: 'custom',
        message: 'All ten condition-row items are required.',
        path: ['items'],
      });
    for (const [sg, row] of Object.entries(SG_ROW)) {
      const rowYes = value.items.some((i) => i.itemCode === row && i.answer === 'YES');
      const present = value.items.some((i) => i.itemCode === sg);
      if (rowYes !== present)
        ctx.addIssue({
          code: 'custom',
          message: `${sg} is answered exactly when ${row} is YES.`,
          path: ['items'],
        });
    }
    if (value.packetIssueFlag && !value.packetIssueNote?.trim())
      ctx.addIssue({
        code: 'custom',
        message: 'Describe the packet problem.',
        path: ['packetIssueNote'],
      });
  });

export const tlv5AdjudicationSchema = z
  .object({
    caseId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{2,80}$/),
    itemCode: z.string().max(40),
    decision: z.string().max(40).nullable(),
    detailCode: z.string().max(40).optional(),
    status: z.enum(ADJUDICATION_STATUSES),
    basis: z.enum(ADJUDICATION_BASES),
    rationale: z.string().trim().min(3).max(4000),
    disagreementReasonCode: z.enum(DISAGREEMENT_REASONS).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (!REVIEWER_ITEMS.includes(value.itemCode))
      ctx.addIssue({ code: 'custom', message: 'Unknown item.', path: ['itemCode'] });
    if ((value.status === 'UNRESOLVED_ESCALATED') !== (value.decision === null))
      ctx.addIssue({
        code: 'custom',
        message: 'Unresolved escalation has no decision; every other status needs one.',
        path: ['decision'],
      });
    if ((value.status === 'UNRESOLVED_ESCALATED') !== (value.basis === 'NONE'))
      ctx.addIssue({
        code: 'custom',
        message: 'Basis NONE is for unresolved items only.',
        path: ['basis'],
      });
    if (value.decision !== null) {
      const family = itemFamily(value.itemCode);
      const sg = family === 'SG_DIABETES_TYPE' || family === 'SG_NEOPLASM_MALIGNANCY';
      if (!(
        answerAllowed(value.itemCode, value.decision) ||
        (sg && value.decision === 'NOT_APPLICABLE')
      ))
        ctx.addIssue({
          code: 'custom',
          message: 'Decision is outside the item scale.',
          path: ['decision'],
        });
      else if (!detailAllowed(value.itemCode, value.decision, value.detailCode))
        ctx.addIssue({
          code: 'custom',
          message: 'Detail code does not fit the decision.',
          path: ['detailCode'],
        });
    }
  });

const attestation = z.string().trim().min(20).max(4000);
export const tlv5AdminSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('import-pilot') }).strict(),
  z
    .object({
      action: z.literal('assign'),
      mode: z.enum(['PILOT', 'FORMAL', 'TRAINING']),
      seed: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    })
    .strict(),
  z
    .object({
      action: z.literal('lock'),
      mode: z.enum(['PILOT', 'TRAINING', 'FORMAL']),
      attestation,
    })
    .strict(),
  z
    .object({
      action: z.literal('register-export'),
      mode: z.enum(['PILOT', 'FORMAL']),
      notes: z.string().max(2000).optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal('sign-off'),
      checklistVersion: z.string().trim().min(1).max(80),
      checklistSha256: z.string().regex(/^[0-9a-fA-F]{64}$/),
      attestation,
    })
    .strict(),
  z
    .object({
      action: z.literal('activate'),
      designVersion: z.string().trim().min(3).max(80),
      adjudicationScope: z.enum(['DISAGREEMENTS_ONLY', 'ALL_ITEMS']),
      attestation,
    })
    .strict(),
  z
    .object({
      action: z.literal('enroll-formal'),
      userId: z.string().uuid(),
      qualifications: z.string().max(1000).optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal('freeze'),
      labelFileSha256: z.string().regex(/^[0-9a-fA-F]{64}$/),
      attestation,
    })
    .strict(),
  z
    .object({
      action: z.literal('phase'),
      eventType: z.enum(['FORMAL_OPENED', 'FORMAL_CLOSED_COMPLETE', 'FORMAL_CLOSED_INCOMPLETE']),
      attestation,
    })
    .strict(),
  z.object({ action: z.literal('snapshot') }).strict(),
  z.object({ action: z.literal('provision-staging-accounts') }).strict(),
]);
