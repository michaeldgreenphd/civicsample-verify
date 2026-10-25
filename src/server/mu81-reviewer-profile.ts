import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  MU81_REVIEWER_PROFILE_ID,
  MU81_REVIEWER_GUIDE_SHA256,
  type Mu81ReviewerProfile,
} from '../lib/mu81-reviewer-profile';
import { isMu81Design } from '../lib/mu7-types';
import type { Mu7Data } from './mu7-core';

const hash = (v: string) => createHash('sha256').update(v, 'utf8').digest('hex');
export function reviewerGuideText(): string {
  const text = readFileSync(join(process.cwd(), 'docs/reviewer/REVIEWER_GUIDE_v81_r3.md'), 'utf8');
  if (hash(text) !== MU81_REVIEWER_GUIDE_SHA256)
    throw new Error('Reviewed guide checksum differs from the deployed version.');
  return text;
}
/** No identity, attestation, sample metadata or other reviewer's work is returned. */
export async function readReviewerProfile(d: Mu7Data): Promise<Mu81ReviewerProfile | null> {
  const p = await d.rpc<Record<string, unknown> | null>('rpc_mu81_reviewer_profile', {}, 'value');
  if (p === null) return null;
  if (
    !p ||
    p.profile_id !== MU81_REVIEWER_PROFILE_ID ||
    p.rubric_sha256 !== MU81_REVIEWER_GUIDE_SHA256 ||
    !isMu81Design(p.design_version) ||
    p.binding_sha256 !==
      hash(['mu81-reviewer-profile-1', p.design_version, p.profile_id, p.rubric_sha256].join('|'))
  )
    throw new Error('Reviewer profile does not match the reviewed application version.');
  return {
    profileId: MU81_REVIEWER_PROFILE_ID,
    rubricSha256: MU81_REVIEWER_GUIDE_SHA256,
    bindingSha256: String(p.binding_sha256),
    designVersion: String(p.design_version),
    guideText: reviewerGuideText(),
  };
}
