import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  MU84_PROTOCOL_ID,
  MU84_GUIDE_SHA256,
  type Mu84Protocol,
  type Mu84Completion,
} from '../lib/mu84-completion';
import type { Mu7Mode } from '../lib/mu7-types';
import type { Mu7Context, Mu7Data } from './mu7-core';
import { ServiceError } from './service';

const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const hasCompletionSchema = async (d: Mu7Data) =>
  (
    await d.select<{ version: string }>('app_schema_version', {
      columns: ['version'],
      eq: { version: '8.4.0-reviewer-completion' },
    })
  ).length > 0;
export async function readCompletionProtocols(d: Mu7Data): Promise<Mu84Protocol[]> {
  // Legacy exports can be inspected during upgrade. Do not catch permission/query failures.
  if (!(await hasCompletionSchema(d))) return [];
  const rows = await d.select<Record<string, string>>('mu7_completion_protocol_v84', {
    columns: ['mode', 'protocol_id', 'guide_sha256', 'base_profile_sha256', 'binding_sha256'],
  });
  if (!rows.length) return [];
  const guideText = readFileSync(
    join(process.cwd(), 'docs/reviewer/REVIEWER_GUIDE_v81_r5.md'),
    'utf8',
  );
  if (hash(guideText) !== MU84_GUIDE_SHA256) throw new Error('Completion guide checksum mismatch.');
  return rows.map((r) => {
    if (
      !['PILOT', 'FORMAL'].includes(r.mode) ||
      r.protocol_id !== MU84_PROTOCOL_ID ||
      r.guide_sha256 !== MU84_GUIDE_SHA256 ||
      r.binding_sha256 !==
        hash(
          [
            'mu84-completion-binding-1',
            r.mode,
            r.protocol_id,
            r.base_profile_sha256,
            r.guide_sha256,
          ].join('|'),
        )
    )
      throw new Error('Completion protocol mismatch.');
    return {
      mode: r.mode as Mu7Mode,
      protocolId: r.protocol_id,
      guideSha256: r.guide_sha256,
      baseProfileSha256: r.base_profile_sha256,
      bindingSha256: r.binding_sha256,
      guideText,
    };
  });
}
function completion(r: Record<string, unknown> | null): Mu84Completion | null {
  if (!r) return null;
  return {
    mode: r.mode as Mu7Mode,
    assigned: Number(r.assigned),
    answered: Number(r.answered),
    answersSha256: String(r.answers_sha256),
    finishedAt: r.finished_at ? String(r.finished_at) : null,
    receiptSha256: r.receipt_sha256 ? String(r.receipt_sha256) : null,
  };
}
export async function readOwnCompletions(d: Mu7Data): Promise<Mu84Completion[]> {
  if (!(await hasCompletionSchema(d))) return [];
  const result: Mu84Completion[] = [];
  for (const mode of ['PILOT', 'FORMAL'] as const) {
    const r = completion(await d.rpc('rpc_mu84_my_completion', { p_mode: mode }, 'value'));
    if (r) result.push(r);
  }
  return result;
}
export async function finishReview(ctx: Mu7Context, input: unknown): Promise<Mu84Completion> {
  if (ctx.role !== 'REVIEWER')
    throw new ServiceError(403, 'Only a reviewer can finish their own review.');
  const p = input as Record<string, unknown>;
  if (
    !p ||
    typeof p !== 'object' ||
    Array.isArray(p) ||
    Object.keys(p).some((k) => !['mode', 'answersSha256', 'confirm'].includes(k)) ||
    (p.mode !== 'PILOT' && p.mode !== 'FORMAL') ||
    p.confirm !== true ||
    typeof p.answersSha256 !== 'string' ||
    !/^[0-9a-f]{64}$/.test(p.answersSha256)
  )
    throw new ServiceError(400, 'Confirm the complete saved answer set before finishing.');
  return ctx.withData(async (d) => {
    const r = completion(
      await d.rpc(
        'rpc_mu84_finish_review',
        { p_mode: p.mode, p_answers_sha256: p.answersSha256 },
        'value',
      ),
    );
    if (!r?.finishedAt || !r.receiptSha256)
      throw new ServiceError(409, 'Final submission was not confirmed. Reload your review status.');
    return r;
  });
}
