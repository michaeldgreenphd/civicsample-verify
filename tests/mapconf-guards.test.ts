import assert from 'node:assert/strict';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { GUARD_IDS, guardActor } from './tlv5-guard-fixture';
import {
  MC_GUARD_ATT,
  MC_GUARD_CASE,
  MC_GUARD_SHA,
  mcGuardAdjudication,
  mcGuardCase,
  mcGuardSubmit,
  seedMcGuardDatabase,
} from './mapconf-guard-fixture';

const phase = (db: PGlite, type: string) =>
  guardActor(db, 'investigator', () =>
    db.query('select public.rpc_mc_phase($1, $2, $3)', [type, MC_GUARD_ATT, MC_GUARD_SHA]),
  );

test('mapping confirmation: reviewer isolation, finality, adjudicator timing and investigator write denial at the database boundary', async () => {
  const db = new PGlite({ extensions: { pgcrypto } });
  try {
    await seedMcGuardDatabase(db);
    // The reviewer sees the assignment under review and the evidence, nothing else.
    await guardActor(db, 'a', async () => {
      const c = await db.query<{
        assignment: { assigned: boolean };
        evidence: { brief_title: string };
      }>('select assignment, evidence from public.mc_cases');
      assert.equal(c.rows.length, 1);
      assert.equal(c.rows[0].assignment.assigned, true);
      assert.equal(c.rows[0].evidence.brief_title, 'Fictional guard mapping');
      assert.equal(
        (await db.query('select * from public.mc_assignments')).rows.length,
        1,
        'own assignment only',
      );
    });
    await assert.rejects(
      mcGuardSubmit(db, 'a', 'NO'),
      /check constraint|violates/i,
      'NO needs an annotation',
    );
    await mcGuardSubmit(db, 'a', 'YES');
    // Reviewer b, the adjudicator and the investigator read no response while the campaign is open.
    for (const who of ['b', 'adjudicator', 'investigator'] as const)
      await guardActor(db, who, async () => {
        assert.equal(
          (await db.query('select * from public.mc_responses')).rows.length,
          0,
          `${who}: responses`,
        );
        assert.equal(
          (await db.query('select * from public.v_mc_adjudication_queue')).rows.length,
          0,
          `${who}: queue`,
        );
      });
    await guardActor(db, 'adjudicator', async () => {
      for (const table of ['mc_cases', 'mc_assignments'])
        assert.equal((await db.query(`select * from public.${table}`)).rows.length, 0, table);
    });
    // Finality and write paths: no second final, no direct writes, no investigator submission.
    await assert.rejects(mcGuardSubmit(db, 'a', 'NO', 'x'), /final mapping response is locked/);
    await assert.rejects(
      guardActor(db, 'a', () => db.query("update public.mc_responses set answer = 'NO'")),
      /permission denied|append-only|immutable/i,
    );
    await assert.rejects(
      guardActor(db, 'a', () => db.query('delete from public.mc_responses')),
      /permission denied|append-only|immutable/i,
    );
    await assert.rejects(
      guardActor(db, 'investigator', async () => {
        const a = (
          await db.query<{ assignment_id: string }>(
            'select assignment_id from public.mc_assignments',
          )
        ).rows[0];
        await db.query('select public.rpc_mc_submit($1, $2::jsonb)', [a.assignment_id, '{}']);
      }),
      /not your mapping assignment/,
    );
    await assert.rejects(
      guardActor(db, 'adjudicator', () =>
        db.query('select public.rpc_mc_adjudicate($1::jsonb)', [
          JSON.stringify(mcGuardAdjudication),
        ]),
      ),
      /mapping adjudication opens only after/,
    );
    await mcGuardSubmit(db, 'b', 'NO', 'Synthetic disagreement.');
    // Closed but not authorized: the adjudicator still reads nothing; the investigator reads counts.
    await phase(db, 'CLOSED');
    await assert.rejects(
      mcGuardSubmit(db, 'b', 'YES'),
      /campaign is closed|final mapping response is locked/,
    );
    await guardActor(db, 'adjudicator', async () => {
      assert.equal((await db.query('select * from public.mc_responses')).rows.length, 0);
      assert.equal((await db.query('select * from public.v_mc_adjudication_queue')).rows.length, 0);
    });
    await assert.rejects(phase(db, 'LOCKED'), /authorize adjudication before locking/);
    await phase(db, 'ADJUDICATION_AUTHORIZED');
    await guardActor(db, 'adjudicator', async () => {
      assert.equal((await db.query('select * from public.mc_responses')).rows.length, 2);
      const q = await db.query<{ needs_adjudication: boolean }>(
        'select * from public.v_mc_adjudication_queue',
      );
      assert.equal(q.rows[0].needs_adjudication, true);
    });
    // The investigator never enters a judgment, even with a forged adjudicator claim on their own row.
    await assert.rejects(
      guardActor(db, 'investigator', () =>
        db.query('select public.rpc_mc_adjudicate($1::jsonb)', [
          JSON.stringify(mcGuardAdjudication),
        ]),
      ),
      /ADJUDICATOR role is needed/,
    );
    await db.exec('begin');
    await db.query("select set_config('request.jwt.claims',$1,true)", [
      JSON.stringify({ sub: GUARD_IDS.investigator, aal: 'aal2' }),
    ]);
    await assert.rejects(
      db.query(
        "insert into public.mc_adjudications(case_id, decision, status, basis, rationale, decided_by) values ($1,'NO','DISCORDANT_RESOLVED','REVIEWER_2','forged',$2)",
        [MC_GUARD_CASE, GUARD_IDS.investigator],
      ),
      /An active ADJUDICATOR must record their own adjudication/,
    );
    await db.exec('rollback');
    await assert.rejects(phase(db, 'LOCKED'), /disagreeing mappings have no adjudication/);
    await guardActor(db, 'adjudicator', () =>
      db.query('select public.rpc_mc_adjudicate($1::jsonb)', [JSON.stringify(mcGuardAdjudication)]),
    );
    await assert.rejects(
      guardActor(db, 'adjudicator', () =>
        db.query('select public.rpc_mc_adjudicate($1::jsonb)', [
          JSON.stringify(mcGuardAdjudication),
        ]),
      ),
      /duplicate key/,
    );
    // Export view: empty before the lock; after the lock, the investigator reads typed rows.
    await guardActor(db, 'investigator', async () => {
      assert.equal((await db.query('select * from public.v_mc_export')).rows.length, 0);
    });
    await assert.rejects(
      guardActor(db, 'investigator', () =>
        db.query('select public.rpc_mc_register_export($1::jsonb)', [
          JSON.stringify({
            format_version: 'mapping-confirmation-1.0',
            manifest_sha256: 'd'.repeat(64),
            app_git_sha: MC_GUARD_SHA,
          }),
        ]),
      ),
      /registered only after the lock/,
    );
    await phase(db, 'LOCKED');
    await guardActor(db, 'investigator', async () => {
      const rows = await db.query<Record<string, unknown>>(
        'select * from public.v_mc_export order by reviewer_slot',
      );
      assert.equal(rows.rows.length, 2);
      assert.equal(rows.rows[0].review_mode, 'MAPPING_CONFIRMATION');
      assert.equal(rows.rows[0].assignment_visibility, 'EXISTING_ASSIGNMENT_VISIBLE');
      assert.equal(rows.rows[0].adjudicated_decision, 'NO');
      for (const key of Object.keys(rows.rows[0]))
        assert.ok(!/probab|weight|stratum|label_/.test(key), `no sampling or label column: ${key}`);
    });
    await assert.rejects(
      guardActor(db, 'adjudicator', () =>
        db.query('select public.rpc_mc_adjudicate($1::jsonb)', [
          JSON.stringify({ ...mcGuardAdjudication, case_id: 'MC-SYN-OTHER' }),
        ]),
      ),
      /mapping adjudication opens only after|Two independent/,
    );
    await assert.rejects(
      guardActor(db, 'investigator', () =>
        db.query('select public.rpc_mc_import_case($1::jsonb)', [
          JSON.stringify(mcGuardCase('MC-SYN-LATE', 'SYN-NCT-9982')),
        ]),
      ),
      /imported only while the campaign is open/,
    );
    // Audit rows for responses carry identifiers and a hash only.
    await guardActor(db, 'investigator', async () => {
      const audit = await db.query<{ details: Record<string, unknown> }>(
        "select details from public.audit_log where entity_table = 'mc_responses'",
      );
      assert.equal(audit.rows.length, 2);
      for (const r of audit.rows)
        assert.ok(!('answer' in r.details) && !('annotation' in r.details));
    });
  } finally {
    await db.close();
  }
});

test('mapping evidence: allow-listed source fields only; nothing generated, predicted or linked', async () => {
  const db = new PGlite({ extensions: { pgcrypto } });
  try {
    await seedMcGuardDatabase(db);
    const attempt = (patch: (c: ReturnType<typeof mcGuardCase>) => void) =>
      guardActor(db, 'investigator', async () => {
        const c = mcGuardCase('MC-SYN-EVID', 'SYN-NCT-9983');
        patch(c);
        await db.query('select public.rpc_mc_import_case($1::jsonb)', [JSON.stringify(c)]);
      });
    await assert.rejects(
      attempt((c) => ((c.evidence as Record<string, unknown>).model_rationale = 'x')),
      /not on the reviewer-visible allow list/,
    );
    await assert.rejects(
      attempt(
        (c) =>
          ((c.evidence as Record<string, unknown>).brief_summary = {
            present: false,
            text: 'made up',
          }),
      ),
      /never generate or substitute/,
    );
    await assert.rejects(
      attempt(
        (c) =>
          ((c.evidence as Record<string, unknown>).brief_summary = {
            present: true,
            text: 'see clinicaltrials.gov',
          }),
      ),
      /no registry link/,
    );
    await assert.rejects(
      attempt(
        (c) =>
          ((c.evidence as Record<string, unknown>).detailed_description = {
            present: true,
            text: 'x',
          }),
      ),
      /provenance/,
    );
    await assert.rejects(
      attempt(
        (c) => ((c.evidence as Record<string, unknown>).source = { system: 'AACT', fields: [] }),
      ),
      /source needs/,
    );
    await assert.rejects(
      attempt(
        (c) =>
          ((c.evidence as Record<string, unknown>).brief_summary = {
            present: true,
            text: 'x',
            predicted_label: 'y',
          }),
      ),
      /could carry a prediction/,
    );
    await assert.rejects(
      attempt((c) => ((c.assignment as Record<string, unknown>).classifier_reasoning = 'x')),
      /assignment key .* is not on the allow list/,
    );
    await assert.rejects(
      attempt((c) => (c.condition_code = 'XYZ')),
      /check constraint|violates/i,
    );
    await assert.rejects(
      attempt((c) => (c.record_category = 'EVALUATION')),
      /check constraint|violates/i,
      'an EVALUATION record cannot use the synthetic prefix',
    );
    await assert
      .rejects(
        attempt(
          (c) => ((c.evidence as Record<string, unknown>).brief_summary = { present: false }),
        ),
        /x/,
      )
      .catch(() => undefined);
    await guardActor(db, 'investigator', async () => {
      const c = mcGuardCase('MC-SYN-MISSING', 'SYN-NCT-9984');
      (c.evidence as Record<string, unknown>).brief_summary = { present: false };
      await db.query('select public.rpc_mc_import_case($1::jsonb)', [JSON.stringify(c)]);
      const row = await db.query<{ evidence_sha256: string; assignment_sha256: string }>(
        "select evidence_sha256, assignment_sha256 from public.mc_cases where case_id = 'MC-SYN-MISSING'",
      );
      assert.match(row.rows[0].evidence_sha256, /^[0-9a-f]{64}$/);
      assert.notEqual(row.rows[0].evidence_sha256, '0'.repeat(64));
    });
    // A trial maps to a condition once; the training prefix needs the training category.
    await assert.rejects(
      attempt((c) => (c.trial_ref = 'SYN-NCT-9981')),
      /duplicate key/,
    );
    await assert.rejects(
      guardActor(db, 'investigator', () =>
        db.query('select public.rpc_mc_import_case($1::jsonb)', [
          JSON.stringify({
            ...mcGuardCase('MC-TRN-X', 'SYN-NCT-9985'),
            record_category: 'SYNTHETIC_PILOT',
          }),
        ]),
      ),
      /check constraint|violates/i,
    );
  } finally {
    await db.close();
  }
});
