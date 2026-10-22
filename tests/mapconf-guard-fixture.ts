// Synthetic database-boundary fixtures for the mapping-confirmation module; never connects to an
// application database. Builds on the v5 guard fixture (schema through 0013) and adds 0014 to 0020.
import { readFile } from 'node:fs/promises';
import { GUARD_IDS, guardActor, seedGuardDatabase, type GuardDb } from './tlv5-guard-fixture';

export const MC_GUARD_CASE = 'MC-SYN-GUARD';
export const MC_GUARD_RUBRIC_SHA = 'b'.repeat(64);
export const MC_GUARD_ATT = 'Synthetic engineering attestation for mapping guard tests only.';
export const MC_GUARD_SHA = 'c'.repeat(40);
export const mcGuardCase = (caseId = MC_GUARD_CASE, trialRef = 'SYN-NCT-9981') => ({
  case_id: caseId,
  record_category: caseId.startsWith('MC-TRN-') ? 'TRAINING_EXAMPLE' : 'SYNTHETIC_PILOT',
  trial_ref: trialRef,
  condition_code: 'HTN',
  condition_label: 'Hypertension',
  condition_set_id: 'CONDSET-GUARD',
  assignment: { assigned: true, assignment_source: 'SYN-GUARD', assignment_version: 'g1' },
  evidence: {
    schema_version: 'mc-evidence-1',
    brief_title: 'Fictional guard mapping',
    brief_summary: { present: true, text: 'Fictional summary for the guard regression.' },
    source: {
      system: 'SYNTHETIC_FIXTURE',
      version: 'g1',
      fields: ['brief_title', 'brief_summary'],
    },
  },
});
export async function seedMcGuardDatabase(db: GuardDb) {
  await seedGuardDatabase(db);
  await db.exec(await readFile('migrations/0014_legacy_pilot_and_packet_guards.sql', 'utf8'));
  await db.exec(await readFile('migrations/0015_v5_review_fixes.sql', 'utf8'));
  await db.exec(await readFile('migrations/0016_mapping_confirmation.sql', 'utf8'));
  await db.exec(await readFile('migrations/0017_v5_rubric_binding.sql', 'utf8'));
  await db.exec(await readFile('migrations/0018_mapping_confirmation_review_fixes.sql', 'utf8'));
  await db.exec(await readFile('migrations/0019_v5_rubric_binding_reconciliation.sql', 'utf8'));
  await db.exec(
    await readFile(
      'migrations/0020_mapping_confirmation_completeness_and_serialization.sql',
      'utf8',
    ),
  );
  await guardActor(db, 'investigator', async () => {
    await db.query('select public.rpc_mc_create_campaign($1::jsonb)', [
      JSON.stringify({
        condition_set_id: 'CONDSET-GUARD',
        condition_set_status: 'PROPOSED',
        rubric_version: 'GUARD-RUBRIC',
        rubric_sha256: MC_GUARD_RUBRIC_SHA,
      }),
    ]);
    await db.query('select public.rpc_mc_import_case($1::jsonb)', [JSON.stringify(mcGuardCase())]);
    // The v5 guard fixture enrolled both pilot reviewers; assign the guard mapping to both slots.
    const pseudos = (
      await db.query<{ reviewer_pseudo_id: string; user_id: string }>(
        "select reviewer_pseudo_id, user_id from public.reviewers where mode_scope = 'PILOT' order by reviewer_pseudo_id",
      )
    ).rows;
    const slotOf = (role: 'a' | 'b') => pseudos.find((p) => p.user_id === GUARD_IDS[role])!;
    await db.query('select public.rpc_mc_assign($1, 1, $2::text[], 11)', [
      slotOf('a').reviewer_pseudo_id,
      [MC_GUARD_CASE],
    ]);
    await db.query('select public.rpc_mc_assign($1, 2, $2::text[], 11)', [
      slotOf('b').reviewer_pseudo_id,
      [MC_GUARD_CASE],
    ]);
  });
}
export async function mcGuardSubmit(
  db: GuardDb,
  role: 'a' | 'b',
  answer = 'YES',
  annotation: string | null = null,
) {
  return guardActor(db, role, async () => {
    const a = (
      await db.query<{ assignment_id: string }>(
        'select assignment_id from public.mc_assignments where case_id = $1',
        [MC_GUARD_CASE],
      )
    ).rows[0];
    const c = (
      await db.query<{ assignment_sha256: string; evidence_sha256: string }>(
        'select assignment_sha256, evidence_sha256 from public.mc_cases where case_id = $1',
        [MC_GUARD_CASE],
      )
    ).rows[0];
    return db.query('select public.rpc_mc_submit($1, $2::jsonb)', [
      a.assignment_id,
      JSON.stringify({
        answer,
        annotation,
        displayed_assignment_sha256: c.assignment_sha256,
        displayed_evidence_sha256: c.evidence_sha256,
        displayed_evidence_version: 1,
        rubric_version: 'GUARD-RUBRIC',
        rubric_sha256: MC_GUARD_RUBRIC_SHA,
        app_git_sha: MC_GUARD_SHA,
        seconds_on_case: 3,
      }),
    ]);
  });
}
export const mcGuardAdjudication = {
  case_id: MC_GUARD_CASE,
  decision: 'NO',
  status: 'DISCORDANT_RESOLVED',
  basis: 'REVIEWER_2',
  rationale: 'Synthetic boundary regression only.',
};
