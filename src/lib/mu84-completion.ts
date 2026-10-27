import type { Mu7Mode } from './mu7-types';

export const MU84_PROTOCOL_ID = 'mu84-finish-and-adjudicate-1';
export const MU84_GUIDE_SHA256 = '03cc9a6617aae436bbbc73c6a8d2b792d3808ecebd6b661133e942df4408595e';
export interface Mu84Protocol {
  mode: Mu7Mode;
  protocolId: string;
  guideSha256: string;
  baseProfileSha256: string;
  bindingSha256: string;
  guideText: string;
}
export interface Mu84Completion {
  mode: Mu7Mode;
  assigned: number;
  answered: number;
  answersSha256: string;
  finishedAt: string | null;
  receiptSha256: string | null;
}
export const MU84_RECEIPT_COLUMNS = [
  'mode',
  'reviewer_pseudo_id',
  'reviewer_slot',
  'answer_count',
  'answers_text',
  'answers_sha256',
  'protocol_binding_sha256',
  'receipt_sha256',
  'finished_at',
] as const;
export const MU84_FLAG_COLUMNS = ['unit_id', 'mode', 'both_final_cannot_tell'] as const;
