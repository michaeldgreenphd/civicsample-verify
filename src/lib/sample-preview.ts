import { z } from 'zod';
import { mu7PacketView, MU7_ANSWERS, MU7_ANSWER_TEXT, type Mu7Packet } from './mu7-types';
import { answerMeaning, unitDisplay } from './mu7-display';
import { reviewReasonOptions } from './mu7-review-options';
import { isMu81ReviewerProfileId, matchesMu81ReviewerProfile } from './mu81-reviewer-profile';

export const AI_MAPPING_INPUT_FORMAT = 'civicsample-ai-mapping-input-1.0' as const;
export function previewUnit(packet: Mu7Packet, profileId: string) {
  const subtype =
    packet.unit.family === 'SG' &&
    ['D4A_KEEP_UNRESOLVED_PARENT_ONLY', 'D4B_KEEP_UNRESOLVED_COMPLICATION_ONLY'].includes(
      packet.unit.assignment_code,
    );
  return {
    unit_id: packet.unit.unit_id,
    packet,
    display: unitDisplay(packet.unit, profileId),
    answer_options: MU7_ANSWERS.map((code) => ({
      code,
      label: MU7_ANSWER_TEXT[code].label,
      meaning: answerMeaning(code, profileId),
    })),
    reason_codes: reviewReasonOptions(
      packet.unit.family,
      packet.unit.assignment_code,
      profileId,
    ).filter((r) => !subtype || r.code !== 'TYPE_2_STATED'),
    subtype_required: subtype,
  };
}
export type PreviewUnit = ReturnType<typeof previewUnit>;
export interface SamplePreviewBundle {
  format: typeof AI_MAPPING_INPUT_FORMAT;
  guide: { text: string; sha256: string; profile_id: string };
  source: { app_commit: string; sample_sha256: string; prepared_import_sha256: string };
  units: PreviewUnit[];
}
export interface SamplePreviewIndex {
  status: 'PROPOSED_PREVIEW';
  guide: SamplePreviewBundle['guide'];
  units: { position: number; title: string; family: string; trialTitle: string }[];
}

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const envelope = z
  .object({
    format: z.literal(AI_MAPPING_INPUT_FORMAT),
    guide: z
      .object({ text: z.string().min(1).max(100000), sha256: hash, profile_id: z.string() })
      .strict(),
    source: z
      .object({
        app_commit: z.string().regex(/^[a-f0-9]{40}$/),
        sample_sha256: hash,
        prepared_import_sha256: hash,
      })
      .strict(),
    units: z
      .array(
        z
          .object({
            unit_id: z.string().min(1),
            packet: z.record(z.string(), z.unknown()),
            display: z.record(z.string(), z.unknown()),
            answer_options: z.array(z.record(z.string(), z.unknown())),
            reason_codes: z.array(z.record(z.string(), z.unknown())),
            subtype_required: z.boolean(),
          })
          .strict(),
      )
      .length(100),
  })
  .strict();

/** Reject unexpected fields rather than serving hidden research metadata from an arbitrary file. */
export function parseSamplePreview(value: unknown): SamplePreviewBundle {
  const raw = envelope.parse(value);
  if (
    !isMu81ReviewerProfileId(raw.guide.profile_id) ||
    !matchesMu81ReviewerProfile(raw.guide.profile_id, raw.guide.sha256)
  )
    throw new Error('Unrecognized reviewer guide.');
  const units = raw.units.map((u) => {
    const packet = mu7PacketView(u.packet);
    const expected = previewUnit(packet, raw.guide.profile_id);
    if (
      JSON.stringify(expected) !==
      JSON.stringify({
        unit_id: u.unit_id,
        packet: u.packet,
        display: u.display,
        answer_options: u.answer_options,
        reason_codes: u.reason_codes,
        subtype_required: u.subtype_required,
      })
    )
      throw new Error('Preview differs from the reviewed presentation.');
    if (!packet.trial.brief_title || !packet.trial.nct_id || packet.unit.mode !== 'FORMAL')
      throw new Error('Incomplete proposed packet.');
    if (
      packet.trial.registry_url &&
      packet.trial.registry_url !== `https://clinicaltrials.gov/study/${packet.trial.nct_id}`
    )
      throw new Error('Unexpected registry link.');
    return expected;
  });
  if (
    new Set(units.map((u) => u.unit_id)).size !== 100 ||
    new Set(units.map((u) => u.packet.trial.nct_id)).size !== 100
  )
    throw new Error('Expected 100 distinct mappings and trials.');
  for (const [family, count] of [
    ['AREA', 56],
    ['ROW', 40],
    ['SG', 4],
  ] as const)
    if (units.filter((u) => u.packet.unit.family === family).length !== count)
      throw new Error('Unexpected mapping allocation.');
  return { ...raw, units };
}
