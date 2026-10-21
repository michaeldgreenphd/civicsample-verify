import { z } from 'zod';
export const contextSchema = z.object({ clinicalContext: z.string().trim().min(1), inclusionConditions: z.string().trim().min(1), exclusionConditions: z.string().trim().min(1) }).strict();
function validContext(value: string) { try { return contextSchema.safeParse(JSON.parse(value)).success; } catch { return false; } }
export const decisionSchema = z.enum(['INCLUDE', 'EXCLUDE', 'CONTEXT_DEPENDENT', 'INSUFFICIENT_INFORMATION']);
const base = {
  decision: decisionSchema,
  rationale: z.string().max(10000),
  uncertain: z.boolean(),
  context: z.string().max(10000),
  packetProblem: z.boolean(),
  level: z.enum(['DESCRIPTOR_LEVEL', 'DESCRIPTOR_LEVEL_IN_TRIAL_CASE', 'TRIAL_LEVEL']).optional(),
  amendmentId: z.string().uuid().optional(),
  descriptorRole: z.enum(['DISEASE_STUDIED','COMORBIDITY','COMPLICATION','OUTCOME_ONLY','PREVENTION_TARGET','RISK_FACTOR','OTHER','UNRESOLVABLE']).optional(),
  packetProblemNote: z.string().max(10000).optional(),
};
export const draftSchema = z.object(base).strict();
export const judgmentSchema = draftSchema.superRefine((value, ctx) => {
  if (!value.rationale.trim()) ctx.addIssue({code: 'custom', message: 'A rationale is required.', path: ['rationale']});
  if (value.decision === 'CONTEXT_DEPENDENT' && !validContext(value.context)) ctx.addIssue({code: 'custom', message: 'Describe the context required for this decision.', path: ['context']});
});
export const adjudicationSchema = z.object({
  ...base, decision: decisionSchema.nullable(), status: z.enum(['RESOLVED','UNRESOLVED_ESCALATED']),
  basis: z.string().trim().min(1).max(10000),
  reasonCode: z.enum(['CONSTRUCT_BOUNDARY','POLICY_RULE_INTERPRETATION','MESH_PLACEMENT_MISLEADING','TRIAL_CONTEXT','PACKET_INSUFFICIENT','MULTILABEL_OR_CROSS_AREA','OTHER']),
}).strict().superRefine((value, ctx) => {
  if (!value.rationale.trim()) ctx.addIssue({code:'custom',message:'A rationale is required.',path:['rationale']});
  if ((value.status === 'UNRESOLVED_ESCALATED') !== (value.decision === null)) ctx.addIssue({code:'custom',message:'Unresolved adjudications must have no reference decision.',path:['decision']});
  if (value.decision === 'CONTEXT_DEPENDENT' && !validContext(value.context)) ctx.addIssue({code:'custom',message:'Context is required.',path:['context']});
});
export const adminSchema = z.object({
  action: z.enum(['close','authorize-adjudication','lock','configure','activate-formal','authorize-amendment']),
  attestation: z.string().trim().min(1).max(2000).optional(),
  caseId: z.string().max(80).optional(), reviewerId: z.string().uuid().optional(), level: base.level, reason: z.string().trim().min(1).max(2000).optional(),
  configuration: z.object({tierVersion:z.enum(['PENDING','v1.1','v1.2']).optional(),tierState:z.enum(['PROPOSED','APPROVED','FROZEN']).optional(),rubricState:z.enum(['PROPOSED','APPROVED','FROZEN']).optional(),sampleState:z.enum(['PROPOSED','APPROVED','FROZEN']).optional(),adjudicationScope:z.enum(['ALL_CASE_LEVELS','DISAGREEMENTS_ONLY']).optional(),analysisPlanState:z.enum(['PROPOSED','APPROVED','FROZEN']).optional()}).strict().optional(),
}).strict();
