// SYNTHETIC ENGINEERING ONLY. The adjudicator DTO carries the v5 scope literal (ALL_ITEMS, not the
// v4 ALL_CASE_LEVELS name), so an ALL_ITEMS campaign can finish: concordant items stay adjudicable.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { AREA_ITEMS, ROW_ITEMS } from '../src/lib/tlv5-codes';
import { DEMO_ACTORS, getDb } from '../src/server/db';
import {
  getTlv5AdjudicatorCase,
  getTlv5Workspace,
  submitTlv5,
  tlv5AdminAction,
} from '../src/server/tlv5';

process.env.VERIFY_DB_DIR = 'memory';
process.env.VERIFY_APP_GIT_SHA ??= 'e'.repeat(40);
const [investigator, pilotA, pilotB, adjudicator] = DEMO_ACTORS;
const items = [...AREA_ITEMS, ...ROW_ITEMS].map((itemCode) => ({
  itemCode,
  answer: 'NO',
  uncertain: false,
}));
after(async () => {
  await (await getDb()).close();
});

test('an ALL_ITEMS activation reaches the adjudicator DTO as ALL_ITEMS and keeps concordant items adjudicable', async () => {
  await tlv5AdminAction(investigator, { action: 'import-pilot' });
  await tlv5AdminAction(investigator, { action: 'assign', mode: 'PILOT', seed: 11 });
  const ws = await getTlv5Workspace(pilotA);
  if (ws.kind !== 'reviewer') throw new Error('reviewer');
  const caseId = ws.queue[0].caseId;
  for (const who of [pilotA, pilotB])
    await submitTlv5(who, caseId, { items, packetIssueFlag: false });
  let detail = await getTlv5AdjudicatorCase(adjudicator, caseId);
  assert.equal(detail.adjudicationScope, 'DISAGREEMENTS_ONLY');
  assert.ok(
    detail.items.every((row) => !row.needsAdjudication),
    'all concordant',
  );
  // Synthetic test database only: represent an ALL_ITEMS activation directly (the sign-off and
  // activation path is exercised in tests/tlv5.test.ts) and read the scope back through the DTO.
  const db = await getDb();
  await db.exec('alter table public.tlv5_activation disable trigger all');
  await db.query(
    "insert into public.tlv5_activation (design_version, adjudication_scope, attestation, activated_by) values ('SYN-SCOPE', 'ALL_ITEMS', 'Synthetic scope regression attestation text.', $1)",
    [investigator.id],
  );
  await db.exec('alter table public.tlv5_activation enable trigger all');
  detail = await getTlv5AdjudicatorCase(adjudicator, caseId);
  assert.equal(detail.adjudicationScope, 'ALL_ITEMS');
  const scope = await db.query<{ s: string }>('select private.tlv5_scope() as s');
  assert.equal(scope.rows[0].s, 'ALL_ITEMS');
});
