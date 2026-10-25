import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  signedOffPilot,
  one,
  as,
  rows,
  assignmentOf,
  type FixtureDb,
  type Who,
} from './mu7-fixture';
import { getMu7ReviewerUnit, submitMu7, type Mu7Context } from '../src/server/mu7-core';
import { mu7SqlData } from '../src/server/mu7';
const literal = (v: unknown) => `'${JSON.stringify(v).replace(/'/g, "''")}'::jsonb`;
function ctx(db: FixtureDb, who: Who): Mu7Context {
  return {
    role: 'REVIEWER',
    withData: (op) => as(db, who, () => op(mu7SqlData({ query: (q, p) => db.query(q, p) }))),
    appGitSha: 'e'.repeat(40),
    syntheticDatabase: true,
  };
}
async function fixture(version: string) {
  const f = await signedOffPilot({ designVersion: version, stopAfter: 'design' });
  const inputs = JSON.parse(
    readFileSync('tests/handoff/fixtures/v7/SYNTHETIC_PILOT_UNITS_v7.json', 'utf8'),
  ).units;
  const primary = inputs[0].import;
  await one(f.db, 'inv', `select public.rpc_mu7_import_unit(${literal(primary)})`);
  const codes = ['D4A_KEEP_UNRESOLVED_PARENT_ONLY', 'D4B_KEEP_UNRESOLVED_COMPLICATION_ONLY'];
  const vocabulary = JSON.parse(
    readFileSync('tests/handoff/fixtures/v7/VOCABULARY_CONTRACT_v7.json', 'utf8'),
  );
  const ids = [primary.unit_id];
  for (const [i, code] of codes.entries()) {
    const u = structuredClone(
      inputs.find((x: { import: { category: string } }) => x.import.category === 'RULE_D_KEPT')
        .import,
    );
    u.unit_id = `SYN7-SG-RULE_D_KEPT-${901 + i}`;
    u.assignment_code = code;
    u.packet.trial.nct_id = `SYN-NCT-${1901 + i}`;
    delete u.packet.trial.registry_url;
    u.design.nct_id = u.packet.trial.nct_id;
    Object.assign(u.packet.unit, {
      unit_id: u.unit_id,
      assignment_code: code,
      display_text: vocabulary.display_texts[`SG|${code}`],
    });
    await one(f.db, 'inv', `select public.rpc_mu7_import_unit(${literal(u)})`);
    ids.push(u.unit_id);
  }
  await one(
    f.db,
    'inv',
    `select public.rpc_mu7_assign_queue('PILOT',${literal({ slots: [f.PT1, f.PT2].map((pid, i) => ({ reviewer_slot: i + 1, reviewer_pseudo_id: pid, unit_ids: ids })) })})`,
  );
  for (const [who, pid] of [
    ['pt1', f.PT1],
    ['pt2', f.PT2],
  ] as const)
    await submitMu7(ctx(f.db, who), await assignmentOf(f.db, pid, ids[0]), { answer: 'AGREE' });
  return { ...f, ids };
}
test('v8.1 subtype is required on each D4A/D4B revision, independent of membership, isolated and hash-bound', async () => {
  const f = await fixture('SYN-8-1-SUBTYPE-TEST');
  const db = f.db;
  try {
    for (const uid of f.ids.slice(1)) {
      const id = await assignmentOf(db, f.PT1, uid);
      const detail = await getMu7ReviewerUnit(ctx(db, 'pt1'), id);
      assert.equal(detail.subtypeRequired, true);
      assert.ok(!detail.reasonCodes.some((r) => r.code === 'TYPE_2_STATED'));
      for (const answer of ['AGREE', 'DISAGREE', 'CANNOT_TELL'] as const) {
        const input = {
          answer,
          ...(answer === 'DISAGREE'
            ? { reasonCode: 'DIABETES_NOT_STUDIED', note: 'Fictional evidence only.' }
            : {}),
        };
        await assert.rejects(submitMu7(ctx(db, 'pt1'), id, input), /MU81-G02/);
        const result = await submitMu7(ctx(db, 'pt1'), id, {
          ...input,
          diabetesSubtype: 'CANNOT_TELL_FROM_PACKET',
        });
        assert.equal(result.ownAnswers.at(-1)?.diabetesSubtype, 'CANNOT_TELL_FROM_PACKET');
      }
      await assert.rejects(
        submitMu7(ctx(db, 'pt1'), id, {
          answer: 'DISAGREE',
          reasonCode: 'TYPE_2_STATED',
          note: 'Fictional evidence.',
          diabetesSubtype: 'TYPE_2_STATED',
        }),
        /MU81-G03/,
      );
      const first = await submitMu7(ctx(db, 'pt1'), id, {
        answer: 'AGREE',
        diabetesSubtype: 'TYPE_2_STATED',
      });
      const second = await submitMu7(ctx(db, 'pt1'), id, {
        answer: 'AGREE',
        diabetesSubtype: 'TYPE_2_NOT_STATED',
      });
      assert.equal(second.ownAnswers.length, first.ownAnswers.length + 1);
      const hashes = await rows<{ content_sha256: string }>(
        db,
        'pt1',
        `select content_sha256 from public.mu7_judgments where assignment_id='${id}' order by revision_number`,
      );
      assert.notEqual(hashes.at(-1)?.content_sha256, hashes.at(-2)?.content_sha256);
      const sha = (v: string) => createHash('sha256').update(v).digest('hex');
      const revision = second.ownAnswers.at(-1)!.revisionNumber;
      const base = sha([id, revision, 'AGREE', '', '', 'false', ''].join('|'));
      assert.equal(
        hashes.at(-1)?.content_sha256,
        sha(['mu81-judgment-1', base, 'TYPE_2_NOT_STATED'].join('|')),
      );
      assert.notEqual(
        hashes.at(-1)?.content_sha256,
        sha(['mu81-judgment-1', base, 'TYPE_2_STATED'].join('|')),
      );
      await assert.rejects(getMu7ReviewerUnit(ctx(db, 'pt2'), id), /MU7-G54/);
      assert.equal(
        await one(
          db,
          'pt2',
          `select count(*)::int from public.mu7_judgments where assignment_id='${id}'`,
        ),
        0,
      );
    }
    await assert.rejects(
      submitMu7(ctx(db, 'pt1'), await assignmentOf(db, f.PT1, f.ids[0]), {
        answer: 'AGREE',
        diabetesSubtype: 'TYPE_2_STATED',
      }),
      /MU81-G02/,
    );
    assert.equal(await one(db, 'pt2', 'select count(*)::int from public.v_mu81_subtypes'), 0); // no export view for reviewers
  } finally {
    await db.close();
  }
});
test('v7 retains the original TYPE_2_STATED disagreement and rejects the new field', async () => {
  const f = await fixture('SYN-7-SUBTYPE-COMPAT');
  try {
    const id = await assignmentOf(f.db, f.PT1, f.ids[1]);
    const detail = await getMu7ReviewerUnit(ctx(f.db, 'pt1'), id);
    assert.equal(detail.subtypeRequired, false);
    assert.ok(detail.reasonCodes.some((r) => r.code === 'TYPE_2_STATED'));
    await submitMu7(ctx(f.db, 'pt1'), id, {
      answer: 'DISAGREE',
      reasonCode: 'TYPE_2_STATED',
      note: 'Fictional evidence only.',
    });
    await assert.rejects(
      submitMu7(ctx(f.db, 'pt1'), id, { answer: 'AGREE', diabetesSubtype: 'TYPE_2_STATED' }),
      /MU81-G02/,
    );
  } finally {
    await f.db.close();
  }
});

test('0035 upgrade preserves existing v7 judgment content and hashes', async () => {
  const migration = 'migrations/0035_v81_subtype_probability.sql';
  const f = await signedOffPilot({ without: [migration], stopAfter: 'pilotAnswers' });
  try {
    const read = () =>
      rows(
        f.db,
        'owner',
        'select judgment_id,answer,reason_code,note,revision_number,content_sha256,submitted_at from public.mu7_judgments order by judgment_id',
      );
    const before = await read();
    await f.db.exec(readFileSync(migration, 'utf8'));
    assert.deepEqual(await read(), before);
    assert.equal(
      await one(
        f.db,
        'owner',
        'select count(*)::int from public.mu7_judgments where diabetes_subtype is not null',
      ),
      0,
    );
  } finally {
    await f.db.close();
  }
});
