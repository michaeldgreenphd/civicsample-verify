// A reviewed presentation version, distinct from the sampling design and scientific approvals.
export const MU81_REVIEWER_PROFILE_ID = 'mu81-plain-language-r3';
export const MU81_REVIEWER_GUIDE_SHA256 =
  '1cd8584d68a313e60aab2f5e03f36fba66105c31b0050dec1be7d8f36ddba284';
export const MU81_PROFILE_KEEP_TEXT =
  'a neoplasm heading other than a cyst, hamartoma or precancerous condition, counted in the Neoplasms row';
export const MU81_PROFILE_REMOVE_TEXT =
  'cyst, hamartoma or precancerous condition only (every neoplasm heading is one of these)';
export interface Mu81ReviewerProfile {
  profileId: typeof MU81_REVIEWER_PROFILE_ID;
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
