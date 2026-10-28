// Fresh in-memory application database, fictional records, no network or study configuration.
import assert from 'node:assert/strict';
import test from 'node:test';
import { DEMO_ACTORS, getDb, withActor } from '../src/server/db';
import { mu7RegistrationPayload } from '../src/lib/mu7-export';
import {
  finishMu7Review,
  getMu7Workspace,
  mu7AdminAction,
  getMu7ReviewerUnit,
  submitMu7,
  recordMu7Adjudication,
  exportMu7Bundle,
} from '../src/server/mu7';
import type { Mu7ReviewerWorkspace, Mu7AdjudicatorWorkspace } from '../src/lib/mu7-types';
process.env.VERIFY_DB_DIR = 'memory';
process.env.VERIFY_APP_GIT_SHA = 'b'.repeat(40);
const [inv, a, b, adj] = DEMO_ACTORS;
const attestation = 'Synthetic completion protocol rehearsal only.';
test('application service: explicit pilot opt-in, each own final set, two Cannot tells, locked bundle', async () => {
  for (const actor of [a, b, adj])
    await assert.rejects(
      mu7AdminAction(actor, { action: 'enable-completion-pilot', attestation }),
      /not available to your role/,
    );
  await mu7AdminAction(inv, { action: 'record-profile-design', attestation });
  await mu7AdminAction(inv, { action: 'enable-completion-pilot', attestation });
  await mu7AdminAction(inv, { action: 'import-pilot' });
  await mu7AdminAction(inv, { action: 'assign-pilot' });
  for (const actor of [inv, adj])
    await assert.rejects(
      finishMu7Review(actor, { mode: 'PILOT', answersSha256: '0'.repeat(64), confirm: true }),
      /reviewer/,
    );
  await assert.rejects(
    finishMu7Review(a, {
      mode: 'PILOT',
      reviewerId: 'another-reviewer',
      answersSha256: '0'.repeat(64),
      confirm: true,
    }),
    /Confirm/,
  );
  let disputed = '';
  for (const actor of [a, b]) {
    const ws = (await getMu7Workspace(actor)) as Mu7ReviewerWorkspace;
    assert.equal(ws.completionProtocols?.[0].mode, 'PILOT');
    assert.equal(ws.completions?.[0].finishedAt, null);
    for (const item of ws.queue) {
      const unit = await getMu7ReviewerUnit(actor, item.assignmentId);
      if (!disputed) disputed = unit.packet.unit.unit_id;
      const ct = unit.packet.unit.unit_id === disputed;
      await submitMu7(actor, item.assignmentId, {
        answer: ct ? 'CANNOT_TELL' : 'AGREE',
        note: ct ? 'Synthetic evidence needs a tie-break.' : null,
        ...(unit.subtypeRequired ? { diabetesSubtype: 'TYPE_2_NOT_STATED' as const } : {}),
      });
    }
    const fresh = (await getMu7Workspace(actor)) as Mu7ReviewerWorkspace;
    const completion = fresh.completions![0];
    assert.equal(completion.answered, 12);
    const receipt = await finishMu7Review(actor, {
      mode: 'PILOT',
      answersSha256: completion.answersSha256,
      confirm: true,
    });
    assert.ok(receipt.finishedAt);
    await assert.rejects(
      submitMu7(actor, ws.queue[0].assignmentId, { answer: 'AGREE' }),
      /finished review is locked/,
    );
    if (actor === a)
      assert.equal(((await getMu7Workspace(adj)) as Mu7AdjudicatorWorkspace).queue.length, 0);
  }
  const queue = ((await getMu7Workspace(adj)) as Mu7AdjudicatorWorkspace).queue;
  assert.equal(queue.length, 1);
  await recordMu7Adjudication(adj, {
    unitId: disputed,
    decision: 'AGREE',
    status: 'DISCORDANT_RESOLVED',
    basis: 'NEITHER',
    rationale: 'Fictional outcome supported by the practice evidence.',
  });
  await mu7AdminAction(inv, { action: 'lock-pilot', attestation });
  const bundle = await exportMu7Bundle(inv, 'PILOT');
  assert.equal(bundle.manifest.bundle_format_version, '8.4');
  assert.ok(
    bundle.files.find((f) => f.name === 'final_answer_flags.csv')?.content.includes(',true'),
  );
  assert.equal(bundle.files.find((f) => f.name === 'review_completions.csv')?.rows, 2);
  // Bypass the writer: the database must validate the inventory on a direct RPC too.
  const payload = mu7RegistrationPayload(bundle, 'b'.repeat(40));
  for (const units of [undefined, 0, 11, 13, '12.0']) {
    const rowCounts = { ...payload.row_counts } as Record<string, unknown>;
    if (units === undefined) delete rowCounts.units;
    else rowCounts.units = units;
    await assert.rejects(
      withActor(inv, (tx) =>
        tx.query('select public.rpc_mu7_register_export($1::jsonb)', [
          JSON.stringify({ ...payload, row_counts: rowCounts }),
        ]),
      ),
      /MU7X-G03/,
    );
  }
  const db = await getDb();
  assert.equal(
    (await db.query<{ n: number }>('select count(*)::int as n from public.mu7_exports')).rows[0].n,
    0,
  );
  await mu7AdminAction(inv, { action: 'register-pilot-export' });
  assert.equal(
    (await db.query<{ row_counts: { units: number } }>('select row_counts from public.mu7_exports'))
      .rows[0].row_counts.units,
    12,
  );
});
