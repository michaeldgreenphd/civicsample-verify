// Database-boundary regressions for the PR #6 review findings (migration 0018). Synthetic only.
import assert from 'node:assert/strict';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { GUARD_IDS, guardActor } from './tlv5-guard-fixture';
import {
  MC_GUARD_ATT,
  MC_GUARD_SHA,
  mcGuardAdjudication,
  mcGuardCase,
  mcGuardSubmit,
  seedMcGuardDatabase,
} from './mapconf-guard-fixture';

const phase = (db: PGlite, type: string, attestation = MC_GUARD_ATT) =>
  guardActor(db, 'investigator', () =>
    db.query('select public.rpc_mc_phase($1, $2, $3)', [type, attestation, MC_GUARD_SHA]),
  );
const importCase = (
  db: PGlite,
  patch: (c: ReturnType<typeof mcGuardCase>) => void,
  id = 'MC-SYN-FIX',
  ref = 'SYN-NCT-9990',
) =>
  guardActor(db, 'investigator', async () => {
    const c = mcGuardCase(id, ref);
    patch(c);
    await db.query('select public.rpc_mc_import_case($1::jsonb)', [JSON.stringify(c)]);
  });
const evidence = (c: ReturnType<typeof mcGuardCase>) => c.evidence as Record<string, unknown>;

test('import boundary: synthetic only, one condition set, consistent entries and provenance; hash-only audit', async () => {
  const db = new PGlite({ extensions: { pgcrypto } });
  try {
    await seedMcGuardDatabase(db);
    // A blank attestation is refused at the database (checked before any mapping is added).
    await assert.rejects(
      phase(db, 'CLOSED', '                    '),
      /check constraint|violates/i,
      'blank attestation',
    );
    // Evaluation records and real registry references are refused in the database, not only by the API.
    await assert.rejects(
      importCase(db, (c) => (c.record_category = 'EVALUATION'), 'MC-EVAL-0001', 'SYN-NCT-9991'),
      /evaluation import is disabled pending scientific approval/,
    );
    await assert.rejects(
      importCase(db, () => undefined, 'MC-SYN-REAL', 'NCT' + '12345678'),
      /only synthetic trial references/,
    );
    await assert.rejects(
      importCase(db, (c) => (c.condition_set_id = 'CONDSET-OTHER')),
      /names condition set CONDSET-OTHER but the campaign is/,
    );
    await assert.rejects(
      importCase(db, (c) => (c.condition_label = 'Asthma')),
      /check constraint|violates/i,
      'code and label form one entry',
    );
    await assert.rejects(
      importCase(db, (c) => delete evidence(c).schema_version),
      /schema_version must be mc-evidence-1/,
    );
    await assert.rejects(
      importCase(db, (c) => (evidence(c).schema_version = 'mc-evidence-9')),
      /schema_version must be mc-evidence-1/,
    );
    await assert.rejects(
      importCase(
        db,
        (c) =>
          (evidence(c).detailed_description = {
            present: true,
            source_field: 'detailed_description',
          }),
      ),
      /present detailed_description carries the source text/,
    );
    await assert.rejects(
      importCase(
        db,
        (c) =>
          (evidence(c).detailed_description = {
            present: false,
            text: 'made up',
            source_field: 'detailed_description',
          }),
      ),
      /missing detailed_description carries no text/,
    );
    await assert.rejects(
      importCase(
        db,
        (c) =>
          (evidence(c).detailed_description = {
            present: true,
            text: 'x',
            source_field: 'classifier_rationale',
          }),
      ),
      /names a field that is not a registry description/,
    );
    await assert.rejects(
      importCase(
        db,
        (c) =>
          (evidence(c).source = {
            system: 'SYNTHETIC_FIXTURE',
            version: 'g1',
            fields: ['brief_title', 'model_prediction'],
          }),
      ),
      /source field "model_prediction" is not a reviewer-visible registry field/,
    );
    await assert.rejects(
      importCase(
        db,
        (c) =>
          (evidence(c).source = { system: 'MODEL_OUTPUT', version: 'g1', fields: ['brief_title'] }),
      ),
      /not an accepted registry source name/,
    );
    await assert.rejects(
      importCase(
        db,
        (c) =>
          (evidence(c).source = {
            system: 'SYNTHETIC_FIXTURE',
            version: 'classifier-v3 predictions',
            fields: ['brief_title'],
          }),
      ),
      /not an accepted provenance value/,
    );
    // A consistent import succeeds and its audit row carries identifiers and hashes only.
    await importCase(db, (c) => {
      evidence(c).detailed_description = {
        present: true,
        text: 'Fictional detailed description.',
        source_field: 'detailed_description',
      };
      (evidence(c).source as { fields: string[] }).fields.push('detailed_description');
    });
    await guardActor(db, 'investigator', async () => {
      const audit = await db.query<{ details: Record<string, unknown> }>(
        "select details from public.audit_log where entity_table = 'mc_cases' and entity_id = 'MC-SYN-FIX'",
      );
      assert.equal(audit.rows.length, 1);
      assert.deepEqual(Object.keys(audit.rows[0].details).sort(), [
        'assignment_sha256',
        'case_id',
        'condition_code',
        'condition_set_id',
        'evidence_sha256',
        'evidence_version',
        'record_category',
      ]);
      assert.ok(!JSON.stringify(audit.rows[0].details).includes('Fictional'));
    });
  } finally {
    await db.close();
  }
});

test('lock and adjudication: incomplete campaigns never lock; insufficient-information needs review; decision and basis fit the answers', async () => {
  const db = new PGlite({ extensions: { pgcrypto } });
  try {
    await seedMcGuardDatabase(db);
    // A second mapping assigned to both reviewers but answered by one only.
    await importCase(db, () => undefined, 'MC-SYN-SECOND', 'SYN-NCT-9992');
    await guardActor(db, 'investigator', async () => {
      const pseudos = (
        await db.query<{ reviewer_pseudo_id: string; user_id: string }>(
          "select reviewer_pseudo_id, user_id from public.reviewers where mode_scope = 'PILOT'",
        )
      ).rows;
      const slot = (role: 'a' | 'b') =>
        pseudos.find((p) => p.user_id === GUARD_IDS[role])!.reviewer_pseudo_id;
      await db.query('select public.rpc_mc_assign($1, 1, $2::text[], 12)', [
        slot('a'),
        ['MC-SYN-SECOND'],
      ]);
      await db.query('select public.rpc_mc_assign($1, 2, $2::text[], 12)', [
        slot('b'),
        ['MC-SYN-SECOND'],
      ]);
    });
    await mcGuardSubmit(db, 'a', 'INSUFFICIENT_INFORMATION', 'Synthetic: no summary.');
    await mcGuardSubmit(db, 'b', 'INSUFFICIENT_INFORMATION', 'Synthetic: title only.');
    await phase(db, 'CLOSED');
    await phase(db, 'ADJUDICATION_AUTHORIZED');
    // One assignment of MC-SYN-SECOND has no response: the lock is refused before anything else.
    await assert.rejects(
      phase(db, 'LOCKED'),
      /lack two final responses; an incomplete campaign cannot be locked/,
    );
    // Both reviewers proposed the rubric addition on the guard mapping: a YES/NO resolution is refused,
    // and so is a lock without the rubric-addition review.
    const adjudicate = (patch: Record<string, unknown>) =>
      guardActor(db, 'adjudicator', () =>
        db.query('select public.rpc_mc_adjudicate($1::jsonb)', [
          JSON.stringify({ ...mcGuardAdjudication, ...patch }),
        ]),
      );
    await assert.rejects(
      adjudicate({ decision: 'NO', status: 'DISCORDANT_RESOLVED', basis: 'REVIEWER_2' }),
      /both reviewers proposed a rubric addition/,
    );
    await assert.rejects(
      adjudicate({ decision: 'NO', status: 'RUBRIC_ADDITION_REVIEWED', basis: 'NONE' }),
      /check constraint|violates/i,
    );
    await adjudicate({ decision: null, status: 'RUBRIC_ADDITION_REVIEWED', basis: 'NONE' });
    await guardActor(db, 'investigator', async () => {
      const row = await db.query<{ decision: string | null; status: string; basis: string }>(
        'select decision, status, basis from public.mc_adjudications',
      );
      assert.deepEqual(row.rows, [
        { decision: null, status: 'RUBRIC_ADDITION_REVIEWED', basis: 'NONE' },
      ]);
    });
  } finally {
    await db.close();
  }
});

test('adjudication basis must name the reviewer whose answer the decision adopts', async () => {
  const db = new PGlite({ extensions: { pgcrypto } });
  try {
    await seedMcGuardDatabase(db);
    await mcGuardSubmit(db, 'a', 'YES');
    await mcGuardSubmit(db, 'b', 'NO', 'Synthetic disagreement.');
    await phase(db, 'CLOSED');
    await phase(db, 'ADJUDICATION_AUTHORIZED');
    const adjudicate = (patch: Record<string, unknown>) =>
      guardActor(db, 'adjudicator', () =>
        db.query('select public.rpc_mc_adjudicate($1::jsonb)', [
          JSON.stringify({ ...mcGuardAdjudication, ...patch }),
        ]),
      );
    await assert.rejects(
      adjudicate({ decision: 'NO', basis: 'REVIEWER_1' }),
      /basis REVIEWER_1 does not match the reviewer answers/,
    );
    await assert.rejects(
      adjudicate({ decision: 'YES', basis: 'REVIEWER_2' }),
      /basis REVIEWER_2 does not match the reviewer answers/,
    );
    await assert.rejects(
      adjudicate({ decision: 'NO', basis: 'NEITHER' }),
      /basis NEITHER does not match the reviewer answers/,
    );
    await assert.rejects(
      adjudicate({ decision: null, status: 'RUBRIC_ADDITION_REVIEWED', basis: 'NONE' }),
      /RUBRIC_ADDITION_REVIEWED applies only when both reviewers proposed/,
    );
    await assert.rejects(
      phase(db, 'LOCKED'),
      /disagreeing or insufficient-information mappings have no adjudication/,
    );
    await adjudicate({ decision: 'NO', basis: 'REVIEWER_2' });
    await phase(db, 'LOCKED');
    await guardActor(db, 'investigator', async () => {
      const rows = await db.query<Record<string, unknown>>(
        'select * from public.v_mc_export order by reviewer_slot',
      );
      assert.equal(rows.rows[0].assignment_assigned, true);
      assert.equal(rows.rows[0].displayed_evidence_version, 1);
      assert.equal(rows.rows[1].answer, 'NO');
    });
  } finally {
    await db.close();
  }
});
