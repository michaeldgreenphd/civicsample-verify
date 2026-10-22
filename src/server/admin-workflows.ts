import { z } from 'zod';
import { exportV4SyntheticBundleFromDb, type V4DbExportOptions } from '../lib/formal-export';
import type { Actor, Workspace } from '../lib/types';
import { withActor } from './db';
import { ServiceError, getWorkspace } from './service';

export type ApprovalGateStatus = 'PROPOSED' | 'SYNTHETIC_PILOT_ONLY' | 'BLOCKED';

export interface ApprovalGateItem {
  gate:
    | 'scientific_version'
    | 'sample_adequacy'
    | 'holdout_provenance'
    | 'sample_provenance'
    | 'rubric'
    | 'inputs'
    | 'independent_roles'
    | 'investigator_pilot'
    | 'security'
    | 'analysis'
    | 'operations';
  label: string;
  status: ApprovalGateStatus;
  requiredEvidence: string;
  currentStateSummary: string;
}

export interface ApprovalGateReport {
  formalActivationAllowed: false;
  formalActivationReason: string;
  moduleBApproved: false;
  schemaVersion: string;
  pilotPhase: string;
  tier1Proposal: string;
  gates: ApprovalGateItem[];
}

const treeNumberSchema = z.strictObject({
  number: z.string().regex(/^(?:TESTFX|SYN)\.\d{3}(?:\.\d{3})*$/),
  label: z.string().trim().min(1).max(200),
});

const trialPacketSchema = z.strictObject({
  registryId: z.string().regex(/^SYN-NCT-\d{4,8}$/),
  title: z.string().trim().min(1).max(300),
  summary: z.string().trim().min(1).max(4000),
  conditions: z.array(z.string().trim().min(1).max(200)).min(1).max(20),
  interventions: z.array(z.string().trim().min(1).max(200)).min(1).max(20),
  primaryOutcomes: z.array(z.string().trim().min(1).max(300)).min(1).max(20),
  studyType: z.string().trim().min(1).max(200),
  primaryPurpose: z.string().trim().min(1).max(200),
  phase: z.string().trim().min(1).max(200),
  ageRange: z.string().trim().min(1).max(200),
  source: z.string().trim().min(1).max(200),
  sourceVersion: z.string().trim().min(1).max(100),
});

export const syntheticCaseAuthorSchema = z.strictObject({
  id: z.string().regex(/^SYN-\d{3}$/),
  kind: z.enum(['DESCRIPTOR', 'TWO_STEP']),
  packet: z.strictObject({
    title: z.string().trim().min(1).max(300),
    area: z.string().trim().min(1).max(100),
    descriptorName: z.string().trim().min(1).max(300),
    descriptorId: z.string().regex(/^(?:TESTFX|SYN)-D\d{3,6}$/),
    scopeNote: z.string().trim().min(1).max(2000),
    entryTerms: z.array(z.string().trim().min(1).max(200)).min(1).max(20),
    treeNumbers: z.array(treeNumberSchema).min(1).max(20),
    areaDefinition: z.string().trim().min(1).max(2000),
    source: z.string().trim().min(1).max(200),
    sourceVersion: z.string().trim().min(1).max(100),
  }),
  trialPacket: trialPacketSchema.optional(),
});

export type SyntheticCaseAuthorInput = z.infer<typeof syntheticCaseAuthorSchema>;

function requireInvestigator(actor: Actor): void {
  if (actor.role !== 'INVESTIGATOR') {
    throw new ServiceError(403, 'This action is not available to your role.');
  }
}

/**
 * Inspect all 11 approval gates defined in `docs/APPROVAL_GATES.md`.
 * Explicitly distinguishes `PROPOSED`, `SYNTHETIC_PILOT_ONLY`, and `BLOCKED` states, and
 * keeps formal production activation disabled (`formalActivationAllowed: false`).
 */
export async function evaluateApprovalGates(actor: Actor): Promise<ApprovalGateReport> {
  requireInvestigator(actor);

  const row = await withActor(actor, async (tx) => {
    const res = await tx.query<{
      phase: string;
      tier1_proposal: string | null;
      locked_at: string | null;
      schema_version: string;
      n_pilot_cases: number;
    }>(
      `select
         s.phase,
         s.tier1_proposal,
         s.locked_at::text as locked_at,
         (
           select v.version
           from public.app_schema_version v
           order by v.applied_at desc, v.version desc
           limit 1
         ) as schema_version,
         (select count(distinct case_id)::integer from public.verify_assignments) as n_pilot_cases
       from public.verify_state s
       where s.singleton`,
    );
    return res.rows[0];
  });

  const tierProposal = row?.tier1_proposal ?? 'PENDING';
  const pilotPhase = row?.phase ?? 'OPEN';
  const pilotLocked = pilotPhase === 'LOCKED' && Boolean(row?.locked_at);

  const gates: ApprovalGateItem[] = [
    {
      gate: 'scientific_version',
      label: 'Scientific version',
      status: 'PROPOSED',
      requiredEvidence: 'Explicit choice and approval of the classification version',
      currentStateSummary:
        tierProposal === 'PENDING'
          ? 'No Tier 1 version selected; scientific approval is pending.'
          : `Tier 1 version ${tierProposal} is recorded as a proposal only, not an investigator approval.`,
    },
    {
      gate: 'sample_adequacy',
      label: 'Sample adequacy',
      status: 'BLOCKED',
      requiredEvidence:
        'Approved sample/design, coverage limitation acknowledged, target inference stated',
      currentStateSummary:
        'Proposed sample weak coverage of Tier 0-negative / Tier 1-positive cell remains a blocking warning pending investigator approval.',
    },
    {
      gate: 'holdout_provenance',
      label: 'Holdout provenance',
      status: 'PROPOSED',
      requiredEvidence: 'Complete versioned exclusion ledger and no overlap or duplicates',
      currentStateSummary:
        'Database schema and exporter enforce NO_DEVELOPMENT_FLAG; formal exclusion ledger approval is pending.',
    },
    {
      gate: 'sample_provenance',
      label: 'Sample provenance',
      status: 'PROPOSED',
      requiredEvidence:
        'Frame/ledger/sample identifiers, case list, stratum, inclusion probability, seed and source',
      currentStateSummary:
        'Synthetic fixtures exercise sampling weights and strata; formal study sample provenance is not yet frozen.',
    },
    {
      gate: 'rubric',
      label: 'Rubric',
      status: 'PROPOSED',
      requiredEvidence: 'Approved, frozen text and matching checksum',
      currentStateSummary:
        'Synthetic pilot rubric is active for engineering only; formal clinical rubric text and SHA-256 are not yet approved.',
    },
    {
      gate: 'inputs',
      label: 'Inputs',
      status: 'SYNTHETIC_PILOT_ONLY',
      requiredEvidence: 'Immutable ontology/predictions/evidence/sample/rubric hashes verified',
      currentStateSummary:
        'Database triggers and v4 exporter verify SHA-256 digests on synthetic fixtures; formal study inputs are not loaded.',
    },
    {
      gate: 'independent_roles',
      label: 'Independent roles',
      status: 'SYNTHETIC_PILOT_ONLY',
      requiredEvidence: 'Two authorized reviewers and separate qualified adjudicator',
      currentStateSummary:
        'Enforced across synthetic accounts; real clinician invitations and adjudicator assignment remain disabled.',
    },
    {
      gate: 'investigator_pilot',
      label: 'Investigator pilot',
      status: pilotLocked ? 'SYNTHETIC_PILOT_ONLY' : 'PROPOSED',
      requiredEvidence: 'Signed acceptance after a successful synthetic pilot',
      currentStateSummary: pilotLocked
        ? `Synthetic pilot reference is locked (${row?.n_pilot_cases ?? 10} cases); formal sign-off attestation is still required.`
        : `Synthetic pilot is in phase ${pilotPhase} (${row?.n_pilot_cases ?? 10} cases).`,
    },
    {
      gate: 'security',
      label: 'Security',
      status: 'BLOCKED',
      requiredEvidence: 'Actual PostgreSQL, Supabase JWT/RLS/MFA, API and browser negative tests',
      currentStateSummary:
        'PGlite, API, browser, and CI PostgreSQL harnesses are wired; live deployed Supabase JWT/PostgREST/MFA staging verification is BLOCKED.',
    },
    {
      gate: 'analysis',
      label: 'Analysis',
      status: 'PROPOSED',
      requiredEvidence: 'Approved frozen plan and tested export/analysis compatibility',
      currentStateSummary:
        'Database-to-exporter-to-Python v4 round trip passes on synthetic fixtures; formal statistical analysis plan is not approved.',
    },
    {
      gate: 'operations',
      label: 'Operations',
      status: 'BLOCKED',
      requiredEvidence: 'Hosting region, retention, backup/restore, invited access and monitoring',
      currentStateSummary:
        'Invited-session adapter is tested locally; production hosting region, backup/restore, and retention remain pending.',
    },
  ];

  return {
    formalActivationAllowed: false,
    formalActivationReason:
      'Formal activation is disabled. Proposed settings do not constitute approval; all 11 approval gates in docs/APPROVAL_GATES.md and live Supabase/PostgreSQL staging verification must be completed first.',
    moduleBApproved: false,
    schemaVersion: row?.schema_version ?? '4.0.5-trial-packet-concurrency-guards',
    pilotPhase,
    tier1Proposal: tierProposal,
    gates,
  };
}

/**
 * Author a new synthetic pilot case (`SYN-NNN`) while the synthetic pilot is `OPEN`.
 * Validates blinding, fictional identifiers, and two-step trial packet rules in both
 * the server DTO layer and the database security-definer RPC (`rpc_verify_author_case`).
 */
export async function authorSyntheticPilotCase(
  actor: Actor,
  rawInput: unknown,
): Promise<Workspace> {
  requireInvestigator(actor);
  const parsed = syntheticCaseAuthorSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new ServiceError(
      400,
      'Check synthetic case authoring fields: SYN-NNN ID, DESCRIPTOR or TWO_STEP kind, and fictional SYN-D / SYN-NCT identifiers are required.',
    );
  }
  const input = parsed.data;
  if ((input.kind === 'TWO_STEP') !== Boolean(input.trialPacket)) {
    throw new ServiceError(
      400,
      'TWO_STEP synthetic cases require a trialPacket, and DESCRIPTOR cases cannot include one.',
    );
  }
  const serialized = JSON.stringify(input);
  if (/\bNCT\d{8}\b/i.test(serialized)) {
    throw new ServiceError(400, 'Real clinical-trial registry identifiers are forbidden.');
  }

  try {
    await withActor(actor, async (tx) => {
      await tx.query('select public.rpc_verify_author_case($1::jsonb)', [serialized]);
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (/Configuration locked/.test(message)) {
      throw new ServiceError(409, 'Configuration is locked after review closes.');
    }
    if (/duplicate key/.test(message)) {
      throw new ServiceError(409, 'A synthetic case with this identifier already exists.');
    }
    if (/Packet key|Real registry identifiers|SYN-NNN|TWO_STEP|canonical/.test(message)) {
      throw new ServiceError(400, message.replace(/^error:\s*/i, ''));
    }
    throw new ServiceError(500, 'The local review database could not complete this request.');
  }

  return getWorkspace(actor);
}

/**
 * Export a locked synthetic Module A v4 bundle directly from the database views and
 * integrity verification RPCs under the authenticated investigator's session.
 */
export async function exportFormalV4BundleForInvestigator(
  actor: Actor,
  options: V4DbExportOptions,
) {
  requireInvestigator(actor);
  return withActor(actor, async (tx) => exportV4SyntheticBundleFromDb(tx, options));
}
