// Migration 0020 regressions (PGlite): a mapping with zero or one reviewer assignment blocks the
// close; a mapping with an unanswered slot blocks the lock. Synthetic only.
import assert from 'node:assert/strict';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { GUARD_IDS, guardActor } from './tlv5-guard-fixture';
import {
  MC_GUARD_ATT,
  MC_GUARD_SHA,
  mcGuardCase,
  mcGuardSubmit,
  seedMcGuardDatabase,
} from './mapconf-guard-fixture';

const phase = (db: PGlite, type: string) =>
  guardActor(db, 'investigator', () =>
    db.query('select public.rpc_mc_phase($1, $2, $3)', [type, MC_GUARD_ATT, MC_GUARD_SHA]),
  );
async function assign(db: PGlite, caseId: string, slots: ('a' | 'b')[]) {
  await guardActor(db, 'investigator', async () => {
    const pseudos = (
      await db.query<{ reviewer_pseudo_id: string; user_id: string }>(
        "select reviewer_pseudo_id, user_id from public.reviewers where mode_scope = 'PILOT'",
      )
    ).rows;
    for (const role of slots) {
      const pseudo = pseudos.find((p) => p.user_id === GUARD_IDS[role])!.reviewer_pseudo_id;
      await db.query('select public.rpc_mc_assign($1, $2, $3::text[], 13)', [
        pseudo,
        role === 'a' ? 1 : 2,
        [caseId],
      ]);
    }
  });
}

test('a mapping with zero or one reviewer assignment blocks the close; both slots assigned allow it', async () => {
  const db = new PGlite({ extensions: { pgcrypto } });
  try {
    await seedMcGuardDatabase(db);
    await mcGuardSubmit(db, 'a', 'YES');
    await mcGuardSubmit(db, 'b', 'YES');
    // Zero assignments.
    await guardActor(db, 'investigator', () =>
      db.query('select public.rpc_mc_import_case($1::jsonb)', [
        JSON.stringify(mcGuardCase('MC-SYN-UNASSIGNED', 'SYN-NCT-9993')),
      ]),
    );
    await assert.rejects(
      phase(db, 'CLOSED'),
      /1 mappings lack a second reviewer assignment; the campaign cannot be closed/,
    );
    // One assignment, even with its response, is still incomplete.
    await assign(db, 'MC-SYN-UNASSIGNED', ['a']);
    await guardActor(db, 'a', async () => {
      const a = (
        await db.query<{ assignment_id: string }>(
          "select assignment_id from public.mc_assignments where case_id = 'MC-SYN-UNASSIGNED'",
        )
      ).rows[0];
      const c = (
        await db.query<{ assignment_sha256: string; evidence_sha256: string }>(
          "select assignment_sha256, evidence_sha256 from public.mc_cases where case_id = 'MC-SYN-UNASSIGNED'",
        )
      ).rows[0];
      await db.query('select public.rpc_mc_submit($1, $2::jsonb)', [
        a.assignment_id,
        JSON.stringify({
          answer: 'YES',
          annotation: null,
          displayed_assignment_sha256: c.assignment_sha256,
          displayed_evidence_sha256: c.evidence_sha256,
          displayed_evidence_version: 1,
          rubric_version: 'GUARD-RUBRIC',
          rubric_sha256: 'b'.repeat(64),
          app_git_sha: MC_GUARD_SHA,
        }),
      ]);
    });
    await assert.rejects(phase(db, 'CLOSED'), /lack a second reviewer assignment/);
    await assign(db, 'MC-SYN-UNASSIGNED', ['b']);
    await phase(db, 'CLOSED');
    await phase(db, 'ADJUDICATION_AUTHORIZED');
    // The second slot never answered: the lock is refused and the export view stays empty.
    await assert.rejects(
      phase(db, 'LOCKED'),
      /1 mappings lack two final responses; an incomplete campaign cannot be locked/,
    );
    await guardActor(db, 'investigator', async () => {
      assert.equal((await db.query('select * from public.v_mc_export')).rows.length, 0);
    });
  } finally {
    await db.close();
  }
});
