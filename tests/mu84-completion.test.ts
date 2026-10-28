import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { MU84_GUIDE_SHA256, MU84_PROTOCOL_ID } from '../src/lib/mu84-completion';
import { completionPilot, completeAnswers } from './mu84-fixture';
import {
  ATT,
  signedOffPilot,
  one,
  rows,
  assignmentOf,
  submitSql,
  adjudicateSql,
  type FixtureDb,
} from './mu7-fixture';

const lit = (v: unknown) => `'${JSON.stringify(v).replace(/'/g, "''")}'::jsonb`;
const bind = (mode = 'PILOT') =>
  `select public.rpc_mu84_bind_protocol(${lit({ mode, protocol_id: MU84_PROTOCOL_ID, guide_sha256: MU84_GUIDE_SHA256, attestation: ATT })})`;
const summary = (db: FixtureDb, who: 'pt1' | 'pt2' | 'inv' | 'out' = 'pt1') =>
  one(db, who, "select public.rpc_mu84_my_completion('PILOT')") as Promise<Record<
    string,
    unknown
  > | null>;
const finish = (db: FixtureDb, who: 'pt1' | 'pt2', hash: string) =>
  one(db, who, 'select public.rpc_mu84_finish_review($1,$2)', ['PILOT', hash]);

test('completion protocol is explicit, immutable, guide-hash bound and not a gate approval', async () => {
  assert.equal(
    createHash('sha256')
      .update(readFileSync('docs/reviewer/REVIEWER_GUIDE_v81_r5.md'))
      .digest('hex'),
    MU84_GUIDE_SHA256,
  );
  const f = await signedOffPilot({
    designVersion: 'SYN-8-1-COMPLETION',
    reviewerProfile: true,
    stopAfter: 'design',
  });
  try {
    assert.equal(
      await one(f.db, 'owner', 'select count(*)::int from public.mu7_completion_protocol_v84'),
      0,
    );
    for (const who of ['pt1', 'pt2', 'adj', 'out', 'inv1'] as const)
      await assert.rejects(one(f.db, who, bind()), /investigator role/);
    await one(f.db, 'inv', bind());
    assert.equal(
      await one(f.db, 'owner', 'select count(*)::int from public.mu7_gate_approvals'),
      0,
    );
    for (const sql of [
      'delete from public.mu7_completion_protocol_v84',
      'truncate public.mu7_completion_protocol_v84 cascade',
    ])
      await assert.rejects(f.db.exec(sql), /immutable|append-only|forbidden|not permitted/i);
    for (const role of ['anon', 'authenticated', 'service_role'])
      assert.equal(
        await one(
          f.db,
          'owner',
          "select has_table_privilege($1,'public.mu7_review_completions_v84','INSERT')",
          [role],
        ),
        false,
      );
    assert.equal(await summary(f.db, 'inv'), null);
    assert.equal(await summary(f.db, 'out'), null);
  } finally {
    await f.db.close();
  }
});

test('finish locks exactly the latest complete answer set, retries safely and isolates the other reviewer', async () => {
  const f = await completionPilot();
  try {
    let s = (await summary(f.db))!;
    await assert.rejects(finish(f.db, 'pt1', String(s.answers_sha256)), /MU84-G09/);
    await completeAnswers(f, 'pt1');
    s = (await summary(f.db))!;
    const a = await assignmentOf(f.db, f.PT1, f.order[1]);
    await one(
      f.db,
      'pt1',
      submitSql(a, { answer: 'AGREE', note: 'Synthetic revision before finishing.' }),
    );
    await assert.rejects(finish(f.db, 'pt1', String(s.answers_sha256)), /MU84-G07/);
    s = (await summary(f.db))!;
    const receipt = (await finish(f.db, 'pt1', String(s.answers_sha256))) as Record<
      string,
      unknown
    >;
    assert.ok(receipt.finished_at);
    assert.equal(receipt.assigned, 12);
    assert.deepEqual(await finish(f.db, 'pt1', String(s.answers_sha256)), receipt);
    await assert.rejects(one(f.db, 'pt1', submitSql(a, { answer: 'AGREE' })), /MU84-G10/);
    await assert.rejects(
      one(f.db, 'inv', "select public.rpc_mu84_finish_review('PILOT',$1)", [s.answers_sha256]),
      /MU84-G05/,
    );
    assert.equal(
      (await rows(f.db, 'pt2', 'select * from public.mu7_review_completions_v84')).length,
      0,
    );
    assert.equal(
      await one(f.db, 'pt2', "select private.mu84_unit_routing($1,'CANNOT_TELL','CANNOT_TELL')", [
        f.order[0],
      ]),
      null,
    );
    assert.equal(
      (await rows(f.db, 'adj', 'select * from public.v_mu7_adjudication_queue')).length,
      0,
    );
    await assert.rejects(
      one(f.db, 'inv', "select public.rpc_mu7_lock_reference('PILOT',$1)", [ATT]),
      /MU7-G48|MU84-G13/,
    );
    const audit = await rows(
      f.db,
      'owner',
      "select details from public.audit_log where entity_table='mu7_review_completions_v84'",
    );
    assert.ok(!JSON.stringify(audit).includes(String(s.answers_sha256)));
    assert.ok(!JSON.stringify(audit).includes(String(receipt.receipt_sha256)));
    for (const sql of [
      'delete from public.mu7_review_completions_v84',
      'truncate public.mu7_review_completions_v84',
    ])
      await assert.rejects(f.db.exec(sql), /immutable|append-only|forbidden|not permitted/i);
    await assert.rejects(one(f.db, 'inv', bind()), /MU84-G04|duplicate/);
  } finally {
    await f.db.close();
  }
});

test('two final Cannot tells route only after both finishes; the flag survives a resolved adjudication', async () => {
  const f = await completionPilot();
  try {
    for (const who of ['pt1', 'pt2'] as const) {
      await completeAnswers(f, who);
      const s = (await summary(f.db, who))!;
      await finish(f.db, who, String(s.answers_sha256));
    }
    const q = await rows(f.db, 'adj', 'select * from public.v_mu7_adjudication_queue');
    assert.equal(q.length, 1);
    assert.equal(q[0].reviewer_1_answer, 'CANNOT_TELL');
    assert.equal(q[0].reviewer_2_answer, 'CANNOT_TELL');
    await assert.rejects(
      one(f.db, 'inv', "select public.rpc_mu7_lock_reference('PILOT',$1)", [ATT]),
      /MU7-G48/,
    );
    await one(
      f.db,
      'adj',
      adjudicateSql({
        unit_id: f.order[0],
        decision: 'AGREE',
        status: 'DISCORDANT_RESOLVED',
        basis: 'NEITHER',
        rationale: 'Synthetic tie-break from adequate evidence.',
      }),
    );
    assert.equal(
      await one(
        f.db,
        'inv',
        'select final_answer from public.v_mu7_final_reference where unit_id=$1',
        [f.order[0]],
      ),
      'AGREE',
    );
    assert.equal(
      await one(
        f.db,
        'inv',
        'select both_final_cannot_tell from public.v_mu84_both_cannot_tell where unit_id=$1',
        [f.order[0]],
      ),
      true,
    );
    await one(f.db, 'inv', "select public.rpc_mu7_lock_reference('PILOT',$1)", [ATT]);
  } finally {
    await f.db.close();
  }
});
