// A reviewed presentation version, distinct from the sampling design and scientific approvals.
export const MU81_REVIEWER_PROFILES = {
  'mu81-plain-language-r3': {
    sha256: '1cd8584d68a313e60aab2f5e03f36fba66105c31b0050dec1be7d8f36ddba284',
    file: 'REVIEWER_GUIDE_v81_r3.md',
    revision: 3,
  },
  'mu81-plain-language-r4': {
    sha256: '1eee3cdcae8f9c097a119255cbd410524f2d2ad08a24df3f02de38a1c096c88a',
    file: 'REVIEWER_GUIDE_v81_r4.md',
    revision: 4,
  },
} as const;
export type Mu81ReviewerProfileId = keyof typeof MU81_REVIEWER_PROFILES;
export const MU81_REVIEWER_PROFILE_ID = 'mu81-plain-language-r4';
export const MU81_REVIEWER_GUIDE_SHA256 = MU81_REVIEWER_PROFILES[MU81_REVIEWER_PROFILE_ID].sha256;
/** Both immutable revisions have the same clinical meaning; only a section heading changed. */
export function isMu81ReviewerProfileId(value: unknown): value is Mu81ReviewerProfileId {
  return typeof value === 'string' && Object.hasOwn(MU81_REVIEWER_PROFILES, value);
}
export function matchesMu81ReviewerProfile(id: unknown, sha256: unknown): boolean {
  return isMu81ReviewerProfileId(id) && MU81_REVIEWER_PROFILES[id].sha256 === sha256;
}
export const MU81_PROFILE_KEEP_TEXT =
  'a neoplasm heading other than a cyst, hamartoma or precancerous condition, counted in the Neoplasms row';
export const MU81_PROFILE_REMOVE_TEXT =
  'cyst, hamartoma or precancerous condition only (every neoplasm heading is one of these)';
export interface Mu81ReviewerProfile {
  profileId: Mu81ReviewerProfileId;
  rubricSha256: string;
  bindingSha256: string;
  designVersion: string;
  guideText: string;
}
export function mu81ProfileDisplayText(code: string): string | undefined {
  if (['K_KEEP_MALIGNANT_COMPATIBLE', 'K_KEEP_HEURISTIC_NONMALIGNANT_CLASS'].includes(code))
    return MU81_PROFILE_KEEP_TEXT;
  if (code === 'K_REMOVE_VERIFIED_NONMALIGNANT') return MU81_PROFILE_REMOVE_TEXT;
}
export const MU81_PROFILE_REASON_MEANING: Record<string, string> = {
  NONMALIGNANT_NEOPLASM_STUDIED:
    'The trial studies a nonmalignant neoplasm that belongs in the Neoplasms row.',
  PRECANCEROUS:
    'The trial studies only a cyst, hamartoma or precancerous condition that the grouping excludes.',
  ORGAN_OF_ORIGIN_ONLY:
    'The area reflects only where a cancer starts, its cells or tissue of origin, its spread or course; no separate condition in this area is studied.',
};
