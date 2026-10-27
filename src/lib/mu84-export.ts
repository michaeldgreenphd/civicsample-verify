import { createHash } from 'node:crypto';
import { MU84_GUIDE_SHA256, MU84_PROTOCOL_ID } from './mu84-completion';

type Row = Record<string, string>;
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const check = (v: unknown) => {
  if (!v)
    throw new Error('Completion receipts or final-answer flags differ from the recorded protocol.');
};
/** Called after the existing history/snapshot validation. Never echoes a response or identifier. */
export function verifyCompletionExport(
  manifest: Record<string, unknown>,
  protocol: Record<string, unknown>,
  guide: string,
  receipts: Row[],
  history: Row[],
  finals: Row[],
  flags: Row[],
) {
  const mode = String(manifest.mode);
  const base = manifest.reviewer_profile as Record<string, unknown> | undefined;
  check(
    protocol.mode === mode &&
      protocol.protocol_id === MU84_PROTOCOL_ID &&
      protocol.guide_sha256 === MU84_GUIDE_SHA256 &&
      hash(guide) === MU84_GUIDE_SHA256,
  );
  check(base?.binding_sha256 === protocol.base_profile_sha256);
  check(
    protocol.binding_sha256 ===
      hash(
        [
          'mu84-completion-binding-1',
          mode,
          MU84_PROTOCOL_ID,
          protocol.base_profile_sha256,
          MU84_GUIDE_SHA256,
        ].join('|'),
      ),
  );
  if (mode === 'FORMAL')
    check(
      (manifest.freeze as Record<string, unknown>)?.completion_protocol_sha256 ===
        protocol.binding_sha256,
    );
  check(
    receipts.length === 2 &&
      new Set(receipts.map((r) => r.reviewer_slot)).size === 2 &&
      new Set(receipts.map((r) => r.reviewer_pseudo_id)).size === 2,
  );
  const latest = new Map<string, Row>();
  for (const r of history) {
    const k = r.unit_id + '|' + r.reviewer_slot;
    if (!latest.has(k) || Number(r.revision_number) > Number(latest.get(k)!.revision_number))
      latest.set(k, r);
  }
  for (const r of receipts) {
    check(
      ['1', '2'].includes(r.reviewer_slot) &&
        r.mode === mode &&
        r.protocol_binding_sha256 === protocol.binding_sha256,
    );
    const chosen = [...latest.values()]
      .filter((j) => j.reviewer_slot === r.reviewer_slot)
      .sort((a, b) => (a.unit_id < b.unit_id ? -1 : a.unit_id > b.unit_id ? 1 : 0));
    check(chosen.every((j) => j.reviewer_pseudo_id === r.reviewer_pseudo_id));
    const txt = chosen
      .map((j) =>
        [j.unit_id, j.reviewer_slot, j.assignment_id, j.revision_number, j.content_sha256].join(
          '|',
        ),
      )
      .join('\n');
    check(
      chosen.length === finals.length &&
        chosen.length === Number(r.answer_count) &&
        chosen.length > 0 &&
        (mode !== 'FORMAL' || chosen.length === 100),
    );
    check(
      txt === r.answers_text &&
        hash(txt) === r.answers_sha256 &&
        r.receipt_sha256 ===
          hash(
            [
              'mu84-completion-receipt-1',
              mode,
              r.reviewer_pseudo_id,
              r.protocol_binding_sha256,
              r.answers_sha256,
            ].join('|'),
          ),
    );
    const time = Date.parse(r.finished_at);
    check(Number.isFinite(time));
    check(chosen.every((j) => Date.parse(j.submitted_at_utc) <= time + 1)); // CSV receipt timestamps have millisecond precision.
  }
  check(
    flags.length === finals.length && new Set(flags.map((f) => f.unit_id)).size === finals.length,
  );
  const byId = new Map(flags.map((f) => [f.unit_id, f]));
  for (const f of finals) {
    const a = latest.get(f.unit_id + '|1'),
      b = latest.get(f.unit_id + '|2');
    check(a && b);
    check(f.answer_effective_slot1 === a!.answer && f.answer_effective_slot2 === b!.answer);
    const both = a!.answer === 'CANNOT_TELL' && b!.answer === 'CANNOT_TELL';
    check(
      byId.get(f.unit_id)?.mode === mode &&
        byId.get(f.unit_id)?.both_final_cannot_tell === String(both),
    );
    const concordant = a!.answer === b!.answer && a!.answer !== 'CANNOT_TELL';
    if (concordant)
      check(
        f.routing === `CONCORDANT_${a!.answer}` &&
          f.final_status === 'CONCORDANT' &&
          f.final_answer === a!.answer,
      );
    else {
      check(f.routing === 'ROUTED');
      if (f.adjudication_status === 'UNRESOLVED_ESCALATED')
        check(
          f.final_status === 'UNRESOLVED' &&
            f.final_answer === '' &&
            f.adjudication_basis === 'NONE',
        );
      else {
        check(
          f.adjudication_status === 'DISCORDANT_RESOLVED' &&
            f.final_status === 'ADJUDICATED' &&
            ['AGREE', 'DISAGREE'].includes(f.final_answer),
        );
        check(
          (f.adjudication_basis === 'REVIEWER_1' && f.final_answer === a!.answer) ||
            (f.adjudication_basis === 'REVIEWER_2' && f.final_answer === b!.answer) ||
            (f.adjudication_basis === 'NEITHER' &&
              f.final_answer !== a!.answer &&
              f.final_answer !== b!.answer),
        );
      }
    }
  }
}
