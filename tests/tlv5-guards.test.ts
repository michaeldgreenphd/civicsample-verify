import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import {
  GUARD_ATT,
  guardFreezeInput,
  prepareGuardFreeze,
  GUARD_CASE,
  GUARD_IDS,
  GUARD_MIGRATION,
  guardActor,
  guardAdjudication,
  guardSubmit,
  seedGuardDatabase,
} from './tlv5-guard-fixture';

test('v5 database finality, independent adjudication and direct helper blinding', async () => {
  const db = new PGlite({ extensions: { pgcrypto } });
  try {
    await seedGuardDatabase(db);
    await guardSubmit(db, 'a', 'YES');
    for (const who of ['b', 'adjudicator'] as const)
      await guardActor(db, who, async () => {
        for (const table of ['tlv5_submissions', 'tlv5_submission_items'])
          assert.equal(
            (await db.query(`select * from public.${table}`)).rows.length,
            0,
            `${who}: ${table}`,
          );
        assert.equal(
          (
            await db.query('select * from private.tlv5_item_answers($1,$2)', [
              GUARD_CASE,
              'AREA_ONCOLOGY',
            ])
          ).rows.length,
          0,
        );
        assert.equal(
          (await db.query<{ n: number }>('select private.tlv5_n_reviewed($1) as n', [GUARD_CASE]))
            .rows[0].n,
          0,
        );
      });
    await guardActor(db, 'adjudicator', async () => {
      for (const table of ['tlv5_cases', 'tlv5_assignments', 'v_tlv5_adjudication_queue'])
        assert.equal((await db.query(`select * from public.${table}`)).rows.length, 0, table);
    });
    await assert.rejects(
      guardActor(db, 'adjudicator', () =>
        db.query('select public.rpc_tlv5_record_adjudication($1::jsonb)', [
          JSON.stringify(guardAdjudication),
        ]),
      ),
      /Two independent final submissions/,
    );
    await assert.rejects(guardSubmit(db, 'a'), /Final v5 submission is locked/);
    await assert.rejects(
      guardActor(db, 'investigator', () =>
        db.query("select public.rpc_tlv5_lock_reference('PILOT',$1)", [GUARD_ATT]),
      ),
      /Two independent|no adjudication/,
    );
    await guardSubmit(db, 'b');
    await assert.rejects(
      guardActor(db, 'investigator', () =>
        db.query('select public.rpc_tlv5_record_adjudication($1::jsonb)', [
          JSON.stringify(guardAdjudication),
        ]),
      ),
      /active ADJUDICATOR/,
    );
    await db.exec('begin');
    await db.query("select set_config('request.jwt.claims',$1,true)", [
      JSON.stringify({ sub: GUARD_IDS.investigator, aal: 'aal2' }),
    ]);
    await assert.rejects(
      db.query(
        "insert into public.tlv5_adjudications(case_id,mode,item_code,decision,status,basis,rationale,disagreement_reason_code,decided_by) values($1,'PILOT','AREA_ONCOLOGY','NO','DISCORDANT_RESOLVED','REVIEWER_2','Synthetic spoof regression','CONSTRUCT_BOUNDARY',$2)",
        [GUARD_CASE, GUARD_IDS.adjudicator],
      ),
      /active ADJUDICATOR/,
    );
    await db.exec('rollback');
    await guardActor(db, 'adjudicator', async () => {
      assert.equal((await db.query('select * from public.tlv5_submissions')).rows.length, 2);
      assert.equal((await db.query('select * from public.tlv5_frozen_labels')).rows.length, 0);
      await db.query('select public.rpc_tlv5_record_adjudication($1::jsonb)', [
        JSON.stringify(guardAdjudication),
      ]);
    });
    for (const decision of ['YES', 'NO']) {
      await assert.rejects(
        guardActor(db, 'adjudicator', () =>
          db.query('select public.rpc_tlv5_record_adjudication($1::jsonb)', [
            JSON.stringify({ ...guardAdjudication, decision }),
          ]),
        ),
        /Final v5 adjudication is locked/,
      );
    }
    await guardActor(db, 'investigator', () =>
      db.query("select public.rpc_tlv5_lock_reference('PILOT',$1)", [GUARD_ATT]),
    );
    await assert.rejects(
      guardActor(db, 'adjudicator', () =>
        db.query('select public.rpc_tlv5_record_adjudication($1::jsonb)', [
          JSON.stringify(guardAdjudication),
        ]),
      ),
      /reference is locked/,
    );
  } finally {
    await db.close();
  }
});

test('v5 additive migration preserves existing revisions and denies new revisions', async () => {
  const db = new PGlite({ extensions: { pgcrypto } });
  try {
    await seedGuardDatabase(db, false);
    await guardSubmit(db, 'a', 'YES');
    await guardSubmit(db, 'a', 'NO');
    // Preserve historical investigator adjudications too, including revisions
    // formerly permitted by the supplied module. Only future writes tighten.
    for (const decision of ['YES', 'NO'])
      await guardActor(db, 'investigator', () =>
        db.query('select public.rpc_tlv5_record_adjudication($1::jsonb)', [
          JSON.stringify({
            ...guardAdjudication,
            decision,
            status: 'SINGLE_REVIEW_ADJUDICATED',
            basis: 'REVIEWER_1',
          }),
        ]),
      );
    const priorAdjudications = (
      await db.query('select * from public.tlv5_adjudications order by adjudication_id')
    ).rows;
    const before = (
      await db.query('select * from public.tlv5_submissions order by revision_number')
    ).rows;
    await db.exec(await readFile(GUARD_MIGRATION, 'utf8'));
    assert.deepEqual(
      (await db.query('select * from public.tlv5_submissions order by revision_number')).rows,
      before,
    );
    assert.deepEqual(
      (await db.query('select * from public.tlv5_adjudications order by adjudication_id')).rows,
      priorAdjudications,
    );
    await assert.rejects(guardSubmit(db, 'a'), /Final v5 submission is locked/);
    await guardSubmit(db, 'b');
    await assert.rejects(
      guardActor(db, 'adjudicator', () =>
        db.query('select public.rpc_tlv5_record_adjudication($1::jsonb)', [
          JSON.stringify(guardAdjudication),
        ]),
      ),
      /Final v5 adjudication is locked/,
    );
  } finally {
    await db.close();
  }
});

test('v5 strict synthetic freeze bootstrap and manifest verification', async () => {
  const db = new PGlite({ extensions: { pgcrypto } });
  try {
    await seedGuardDatabase(db);
    await prepareGuardFreeze(db);
    await guardActor(db, 'investigator', async () => {
      await db.query('select public.rpc_tlv5_freeze($1::jsonb)', [
        JSON.stringify(guardFreezeInput),
      ]);
      assert.equal(
        (
          await db.query<{ matches: boolean }>(
            'select matches from public.rpc_tlv5_verify_frozen_labels()',
          )
        ).rows[0].matches,
        true,
      );
    });
  } finally {
    await db.close();
  }
});

test('v5 review fixes (0015): the adjudication basis must match the reviewer answers; reviewers read freeze and scope state', async () => {
  const db = new PGlite({ extensions: { pgcrypto } });
  try {
    await seedGuardDatabase(db);
    await db.exec(await readFile('migrations/0014_legacy_pilot_and_packet_guards.sql', 'utf8'));
    await db.exec(await readFile('migrations/0015_v5_review_fixes.sql', 'utf8'));
    await guardActor(db, 'a', async () => {
      const row = (
        await db.query<{ frozen: boolean; scope: string }>(
          'select private.tlv5_frozen() as frozen, private.tlv5_scope() as scope',
        )
      ).rows[0];
      assert.equal(row.frozen, false);
      assert.equal(row.scope, 'DISAGREEMENTS_ONLY');
      // The grant widens nothing else: labels and other helpers stay closed to reviewers.
      await assert.rejects(db.query('select private.tlv5_active()'), /permission denied/);
    });
    await guardSubmit(db, 'a', 'YES');
    await guardSubmit(db, 'b', 'NO');
    const attempt = (patch: Record<string, unknown>) =>
      guardActor(db, 'adjudicator', () =>
        db.query('select public.rpc_tlv5_record_adjudication($1::jsonb)', [
          JSON.stringify({ ...guardAdjudication, ...patch }),
        ]),
      );
    // Reviewer 1 answered YES: a NO decision cannot claim reviewer 1, both reviewers, or neither.
    await assert.rejects(
      attempt({ decision: 'NO', basis: 'REVIEWER_1' }),
      /basis REVIEWER_1 does not match/,
    );
    await assert.rejects(
      attempt({ decision: 'NO', basis: 'BOTH_REVIEWERS' }),
      /basis BOTH_REVIEWERS does not match/,
    );
    await assert.rejects(
      attempt({ decision: 'NO', basis: 'NEITHER' }),
      /basis NEITHER does not match/,
    );
    await assert.rejects(
      attempt({ decision: 'YES', basis: 'REVIEWER_2' }),
      /basis REVIEWER_2 does not match/,
    );
    await assert.rejects(
      attempt({ decision: 'NO', basis: 'NONE', status: 'DISCORDANT_RESOLVED' }),
      /basis NONE applies only|check constraint|violates/i,
    );
    // The consistent record is accepted and locked; the mismatch never reached the table.
    await attempt({ decision: 'NO', basis: 'REVIEWER_2' });
    await guardActor(db, 'investigator', async () => {
      const rows = await db.query<{ basis: string; decision: string }>(
        'select basis, decision from public.tlv5_adjudications',
      );
      assert.deepEqual(rows.rows, [{ basis: 'REVIEWER_2', decision: 'NO' }]);
    });
  } finally {
    await db.close();
  }
});

test('v5 rubric binding (0017): the first review activity fixes the rubric; a different runtime rubric is refused', async () => {
  const db = new PGlite({ extensions: { pgcrypto } });
  try {
    await seedGuardDatabase(db);
    for (const file of [
      'migrations/0014_legacy_pilot_and_packet_guards.sql',
      'migrations/0015_v5_review_fixes.sql',
      'migrations/0017_v5_rubric_binding.sql',
    ])
      await db.exec(await readFile(file, 'utf8'));
    const bind = (
      who: 'a' | 'b' | 'investigator' | 'adjudicator',
      mode: string,
      version: string,
      sha: string,
    ) =>
      guardActor(
        db,
        who,
        async () =>
          (
            await db.query<{ r: string }>('select public.rpc_tlv5_bind_rubric($1,$2,$3) as r', [
              mode,
              version,
              sha,
            ])
          ).rows[0].r,
      );
    assert.equal(await bind('a', 'PILOT', 'R-ONE', 'a'.repeat(64)), 'BOUND');
    assert.equal(
      await bind('b', 'PILOT', 'R-ONE', 'A'.repeat(64)),
      'VERIFIED',
      'case-insensitive hash',
    );
    await assert.rejects(
      bind('b', 'PILOT', 'R-ONE', 'b'.repeat(64)),
      /differs from the rubric bound to PILOT/,
    );
    await assert.rejects(
      bind('b', 'PILOT', 'R-TWO', 'a'.repeat(64)),
      /differs from the rubric bound to PILOT/,
    );
    await assert.rejects(bind('a', 'PILOT', 'R-ONE', 'not-a-hash'), /not a SHA-256/);
    // Other modes bind independently; the binding is append-only and readable by every role.
    assert.equal(await bind('adjudicator', 'TRAINING', 'R-ONE', 'c'.repeat(64)), 'BOUND');
    await assert.rejects(
      guardActor(db, 'investigator', () =>
        db.query("update public.tlv5_rubric_bindings set rubric_sha256 = repeat('d', 64)"),
      ),
      /permission denied|append-only|immutable/i,
    );
    await guardActor(db, 'a', async () => {
      assert.equal((await db.query('select * from public.tlv5_rubric_bindings')).rows.length, 2);
    });
    // Audit rows carry the binding (identifiers and hash; no answer content exists here).
    await guardActor(db, 'investigator', async () => {
      const rows = await db.query(
        "select details from public.audit_log where entity_table = 'tlv5_rubric_bindings'",
      );
      assert.equal(rows.rows.length, 2);
    });
  } finally {
    await db.close();
  }
});
