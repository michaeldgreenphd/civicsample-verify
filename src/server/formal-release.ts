import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  releaseRequestSchema,
  releaseStatusSchema,
  type ReleaseStatus,
} from '../lib/formal-release';
import type { Mu7Context } from './mu7-core';
import { readFormalIntakeFile } from './formal-intake';
import { ServiceError } from './service';

function investigator(ctx: Mu7Context) {
  if (ctx.role !== 'INVESTIGATOR')
    throw new ServiceError(403, 'An investigator account is required.');
}
export async function formalReleaseStatus(ctx: Mu7Context): Promise<ReleaseStatus> {
  investigator(ctx);
  const present = await ctx.withData((d) =>
    d.select('app_schema_version', {
      columns: ['version'],
      eq: { version: '8.4.2-formal-release-controls' },
    }),
  );
  if (!present.length)
    throw new ServiceError(
      409,
      'Apply the reviewed release-controls migration before using these actions.',
    );
  return releaseStatusSchema.parse(
    await ctx.withData((d) => d.rpc('rpc_mu84_release_status', {}, 'value')),
  );
}
export async function formalReleaseAction(
  ctx: Mu7Context,
  request: unknown,
): Promise<ReleaseStatus> {
  investigator(ctx);
  const input = releaseRequestSchema.parse(request);
  const p: Record<string, unknown> = { attestation: input.attestation };
  if (input.action === 'accept-pilot') {
    if (!/^[0-9a-f]{40}$/.test(ctx.appGitSha) || /^0{40}$/.test(ctx.appGitSha))
      throw new ServiceError(409, 'Rehearsal acceptance requires a verified build.');
    const checklist = readFileSync(
      join(process.cwd(), 'docs/FORMAL_REHEARSAL_CHECKLIST.md'),
      'utf8',
    );
    Object.assign(p, {
      pilot_export_id: input.pilotExportId,
      checklist_version: 'mu84-formal-rehearsal-1',
      checklist_sha256: createHash('sha256').update(checklist).digest('hex'),
      app_git_sha: ctx.appGitSha,
    });
  }
  if (input.action === 'assign-reviewers') {
    // Queue bytes stay server-side. The DB verifies them against the frozen queue checksum.
    const intake = await readFormalIntakeFile(
      process.env.VERIFY_FORMAL_INTAKE_FILE,
      process.env.VERIFY_FORMAL_INTAKE_SHA256,
    );
    Object.assign(p, {
      reviewer_ids: input.reviewerIds,
      qualifications: input.qualifications,
      queue: intake.queue,
    });
  }
  try {
    const result = await ctx.withData((d) =>
      d.rpc(
        'rpc_mu84_release_action',
        { p_action: input.action, p_state_sha256: input.stateSha256, p },
        'value',
      ),
    );
    return releaseStatusSchema.parse(result);
  } catch (error) {
    // Never forward raw database errors, source paths, packet text or roster details.
    if (error instanceof ServiceError && error.status === 403) throw error;
    throw new ServiceError(
      409,
      'The action was not confirmed. Refresh release status and check its prerequisites. Existing records were not replaced; do not assume an action succeeded after a connection error.',
    );
  }
}
