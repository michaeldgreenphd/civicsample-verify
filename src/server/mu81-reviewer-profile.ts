import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  MU81_REVIEWER_PROFILE_ID,
  MU81_REVIEWER_PROFILES,
  isMu81ReviewerProfileId,
  matchesMu81ReviewerProfile,
  type Mu81ReviewerProfileId,
  type Mu81ReviewerProfile,
} from '../lib/mu81-reviewer-profile';
import { isMu81Design } from '../lib/mu7-types';
import type { Mu7Data } from './mu7-core';

const hash = (v: string) => createHash('sha256').update(v, 'utf8').digest('hex');
export function reviewerGuideText(
  profileId: Mu81ReviewerProfileId = MU81_REVIEWER_PROFILE_ID,
): string {
  const profile = MU81_REVIEWER_PROFILES[profileId];
  const text = readFileSync(join(process.cwd(), 'docs/reviewer', profile.file), 'utf8');
  if (hash(text) !== profile.sha256)
    throw new Error('Reviewed guide checksum differs from the deployed version.');
  return text;
}
/** No identity, attestation, sample metadata or other reviewer's work is returned. */
export async function readReviewerProfile(d: Mu7Data): Promise<Mu81ReviewerProfile | null> {
  const p = await d.rpc<Record<string, unknown> | null>('rpc_mu81_reviewer_profile', {}, 'value');
  if (p === null) return null;
  if (
    !p ||
    !isMu81ReviewerProfileId(p.profile_id) ||
    !matchesMu81ReviewerProfile(p.profile_id, p.rubric_sha256) ||
    !isMu81Design(p.design_version) ||
    p.binding_sha256 !==
      hash(['mu81-reviewer-profile-1', p.design_version, p.profile_id, p.rubric_sha256].join('|'))
  )
    throw new Error('Reviewer profile does not match the reviewed application version.');
  return {
    profileId: p.profile_id,
    rubricSha256: MU81_REVIEWER_PROFILES[p.profile_id].sha256,
    bindingSha256: String(p.binding_sha256),
    designVersion: String(p.design_version),
    guideText: reviewerGuideText(p.profile_id),
  };
}
