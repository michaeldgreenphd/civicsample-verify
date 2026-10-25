import { mu7ReasonCodes, MU7_REASON_MEANING } from './mu7-types';
import { isMu81ReviewerProfileId, MU81_PROFILE_REASON_MEANING } from './mu81-reviewer-profile';

/** One vocabulary for the physician form, investigator preview and separate AI comparison. */
export function reviewReasonOptions(family: string, code: string, profileId?: string | null) {
  const revised = isMu81ReviewerProfileId(profileId);
  let reasons = mu7ReasonCodes(family, code);
  if (revised && family === 'SG') {
    if (['K_KEEP_MALIGNANT_COMPATIBLE', 'K_KEEP_HEURISTIC_NONMALIGNANT_CLASS'].includes(code))
      reasons = reasons.filter((r) => r !== 'BENIGN_NEOPLASM');
    if (code === 'K_REMOVE_VERIFIED_NONMALIGNANT') reasons.push('NONMALIGNANT_NEOPLASM_STUDIED');
  }
  return reasons.map((c) => ({
    code: c,
    meaning: (revised ? MU81_PROFILE_REASON_MEANING[c] : undefined) ?? MU7_REASON_MEANING[c] ?? '',
  }));
}
