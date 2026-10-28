import { MU7_PILOT_IMPORTS } from '../src/lib/mu7-synthetic';
import { MU84_GUIDE_SHA256, MU84_PROTOCOL_ID } from '../src/lib/mu84-completion';
import { mu81ProfileDisplayText } from '../src/lib/mu81-reviewer-profile';
import { ATT, signedOffPilot, one, assignmentOf, submitSql, type FixtureDb } from './mu7-fixture';
const lit = (v: unknown) => `'${JSON.stringify(v).replace(/'/g, "''")}'::jsonb`;
const bind = (mode = 'PILOT') =>
  `select public.rpc_mu84_bind_protocol(${lit({ mode, protocol_id: MU84_PROTOCOL_ID, guide_sha256: MU84_GUIDE_SHA256, attestation: ATT })})`;
export async function completionPilot(existing?: FixtureDb) {
  const f = await signedOffPilot({
    existing,
    designVersion: 'SYN-8-1-COMPLETION',
    reviewerProfile: true,
    stopAfter: 'design',
  });
  await one(f.db, 'inv', bind());
  const input = structuredClone(MU7_PILOT_IMPORTS);
  for (const u of input) {
    const p = u.packet as { unit: { assignment_code: string; display_text: string } };
    const display = mu81ProfileDisplayText(p.unit.assignment_code);
    if (display) p.unit.display_text = display;
    await one(f.db, 'inv', `select public.rpc_mu7_import_unit(${lit(u)})`);
  }
  const order = input
    .filter((u) => u.unit_role === 'PRIMARY')
    .concat(input.filter((u) => u.unit_role === 'SUBGROUP'))
    .map((u) => String(u.unit_id));
  await one(
    f.db,
    'inv',
    `select public.rpc_mu7_assign_queue('PILOT',${lit({
      slots: [
        { reviewer_slot: 1, reviewer_pseudo_id: f.PT1, unit_ids: order },
        { reviewer_slot: 2, reviewer_pseudo_id: f.PT2, unit_ids: order },
      ],
    })})`,
  );
  return { ...f, order };
}
export async function completeAnswers(
  f: Awaited<ReturnType<typeof completionPilot>>,
  who: 'pt1' | 'pt2',
) {
  const pseudo = who === 'pt1' ? f.PT1 : f.PT2;
  for (const [i, u] of f.order.entries())
    await one(
      f.db,
      who,
      submitSql(
        await assignmentOf(f.db, pseudo, u),
        i === 0
          ? { answer: 'CANNOT_TELL', note: 'Synthetic evidence is insufficient.' }
          : { answer: 'AGREE' },
      ),
    );
}
