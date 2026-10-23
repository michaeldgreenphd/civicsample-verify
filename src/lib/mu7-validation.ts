// Request shapes for the review design v7 routes. Shape only: every rule (a DISAGREE needs a fitting
// reason code and a note, the basis must match the answers, the order of operations) is the
// database's, and its guard message reaches the user unchanged (PILOT_ACCEPTANCE_CHECKLIST_v7.md).
import { z } from 'zod';

const code = z.string().regex(/^[A-Z][A-Z0-9_]{1,40}$/);
export const mu7SubmissionSchema = z
  .object({
    answer: z.enum(['AGREE', 'DISAGREE', 'CANNOT_TELL']),
    reasonCode: code.nullable().optional(),
    note: z.string().max(2000).nullable().optional(),
    uncertain: z.boolean().optional(),
    secondsOnUnit: z.number().int().min(0).max(10_000_000).nullable().optional(),
  })
  .strict();

export const mu7AdjudicationSchema = z
  .object({
    unitId: z.string().regex(/^(SYN7|MU7)-(AREA|ROW|SG)-[A-Z0-9_]{2,40}-[0-9]{3}$/),
    decision: z.enum(['AGREE', 'DISAGREE']).nullable().optional(),
    reasonCode: code.nullable().optional(),
    status: z.enum(['DISCORDANT_RESOLVED', 'UNRESOLVED_ESCALATED']),
    basis: z.enum(['REVIEWER_1', 'REVIEWER_2', 'NEITHER', 'NONE']),
    disagreementReasonCode: code.nullable().optional(),
    rationale: z.string().trim().min(3).max(4000),
  })
  .strict();

const attestation = z.string().trim().min(20).max(2000);
const account = z.enum(['reviewer-a', 'reviewer-b', 'adjudicator']);
export const mu7AdminSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('record-design'), attestation }).strict(),
  z.object({ action: z.literal('import-pilot') }).strict(),
  z.object({ action: z.literal('import-training') }).strict(),
  z.object({ action: z.literal('assign-pilot') }).strict(),
  z
    .object({
      action: z.literal('approve-gate'),
      gateId: z.string().regex(/^G-[A-Z0-9-]{2,30}$/),
      attestation,
    })
    .strict(),
  z.object({ action: z.literal('lock-pilot'), attestation }).strict(),
  z
    .object({ action: z.literal('register-pilot-export'), notes: z.string().max(2000).optional() })
    .strict(),
  z
    .object({
      action: z.literal('lock-account'),
      account,
      reason: z.string().trim().min(3).max(400),
    })
    .strict(),
  z.object({ action: z.literal('unlock-account'), account }).strict(),
]);

export const MU7_ASSIGNMENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const MU7_UNIT_ID = /^(SYN7|MU7)-(AREA|ROW|SG)-[A-Z0-9_]{2,40}-[0-9]{3}$/;
