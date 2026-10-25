import type { Mu7InvestigatorWorkspace } from './mu7-types';
import { MU81_REVIEWER_PROFILES } from './mu81-reviewer-profile';

export interface PreparationCheck {
  id: string;
  label: string;
  state: 'recorded' | 'pending' | 'not_checked';
  status: string;
  detail: string;
}

/** A deliberately limited status report, never an activation decision or export of study data. */
export function formalPreparation(w: Mu7InvestigatorWorkspace) {
  const formalDesign = w.design?.designVersion === 'review-design-v8.1.0';
  const guide = w.reviewerProfile;
  const pendingGates = w.gates.filter((g) => !g.satisfied);
  const pilotExport = w.exports.some((e) => e.mode === 'PILOT');
  const checks: PreparationCheck[] = [
    {
      id: 'design',
      label: 'Study design',
      state: formalDesign ? 'recorded' : 'pending',
      status: formalDesign ? 'Recorded' : w.design ? 'Practice only' : 'Not recorded',
      detail: formalDesign
        ? 'A v8.1 study design is recorded. This does not approve its sample or open review.'
        : 'The formal study needs its own reviewed design. Practice records remain separate.',
    },
    {
      id: 'guide',
      label: 'Reviewer guide',
      state: guide ? 'recorded' : 'pending',
      status: guide
        ? `Revision ${MU81_REVIEWER_PROFILES[guide.profileId].revision} recorded`
        : 'Earlier guide or no binding',
      detail: guide
        ? 'The exact guide is bound to this workspace. Its scientific approval is tracked below.'
        : 'The revised guide must be bound before importing into a new workspace. Existing answers retain the guide used when they were recorded.',
    },
    {
      id: 'packets',
      label: 'Formal review packets',
      state: w.counts.formalUnits === 0 ? 'pending' : 'not_checked',
      status: w.counts.formalUnits === 0 ? 'Not loaded here' : `${w.counts.formalUnits} recorded`,
      detail:
        'The plan calls for 100 mappings and 200 independent judgments. A packet count alone does not verify the sample, assignments, probabilities or freeze. Private preparation outside this workspace is not shown here.',
    },
    {
      id: 'pilot',
      label: 'Practice evidence',
      state: w.pilotLock && w.pilotLock.nUnitsLocked > 0 && pilotExport ? 'recorded' : 'pending',
      status:
        w.pilotLock && w.pilotLock.nUnitsLocked > 0 && pilotExport
          ? 'Locked and exported'
          : w.pilotLock
            ? 'Export still needed'
            : 'Practice not locked',
      detail:
        'Practice is excluded from study results. A completed practice run is evidence for investigator acceptance, not acceptance itself.',
    },
    {
      id: 'decisions',
      label: 'Investigator decisions',
      state: w.gates.length === 0 ? 'not_checked' : pendingGates.length ? 'pending' : 'recorded',
      status:
        w.gates.length === 0
          ? 'Not available'
          : pendingGates.length
            ? `${pendingGates.length} still pending`
            : 'Current requirements approved',
      detail:
        w.gates.length === 0
          ? 'No decision status was returned; approval cannot be inferred.'
          : 'Use the study-decision records below. This summary records no approval and does not establish that every release requirement has been checked.',
    },
    {
      id: 'hosted',
      label: 'Live-service verification',
      state: 'not_checked',
      status: 'Not certified by this screen',
      detail:
        'The reviewed build still needs its hosted role-isolation, session, backup and recovery checks. Local tests and a working sign-in do not replace these checks.',
    },
    {
      id: 'opening',
      label: 'Formal opening',
      state: 'pending',
      status: 'Disabled in this build',
      detail:
        'No preparation status enables formal review. A verified sample, required approvals and a separately authorized release must precede opening.',
    },
  ];
  return {
    report_format: 'civicsample-preparation-status-1.0' as const,
    purpose: 'Status only; no approval or authorization' as const,
    formal_operations_enabled: false as const,
    source_build: /^[a-f0-9]{40}$/.test(w.appGitSha) ? w.appGitSha : null,
    checks,
    decisions: w.gates.map((g) => ({
      gate: g.gateId,
      requirement_version: g.requirementVersion,
      requirement_status: g.requirementStatus,
      approval_recorded: g.satisfied,
    })),
  };
}
