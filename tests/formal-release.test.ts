// Full-size fictional preparation, ordinary user roles, disposable databases only.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, realpathSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from 'pg';
import { withDisposableHandoffDatabase } from '../scripts/test-handoff-postgres-helpers.mjs';
import { syntheticIntake, emptyIntakeDatabase } from './formal-intake-fixture';
import {
  ATT,
  as,
  one,
  rows,
  uidOf,
  specifyAndApproveGates,
  type FixtureDb,
  type Who,
} from './mu7-fixture';
import { mu7SqlData } from '../src/server/mu7';
import * as core from '../src/server/mu7-core';
import { formalReleaseStatus, formalReleaseAction } from '../src/server/formal-release';
import {
  releaseRequestSchema,
  type ReleaseAction,
  type ReleaseStatus,
} from '../src/lib/formal-release';
import { finishReview } from '../src/server/mu84-completion';
import { MU84_PROTOCOL_ID, MU84_GUIDE_SHA256 } from '../src/lib/mu84-completion';
import { summarizeMu84Bundle } from '../scripts/summarize-mu84-bundle';
import type { Mu7ReviewerWorkspace, Mu7AdjudicatorWorkspace } from '../src/lib/mu7-types';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
function context(db: FixtureDb, who: Who): core.Mu7Context {
  return {
    role: who.startsWith('inv') ? 'INVESTIGATOR' : who === 'adj' ? 'ADJUDICATOR' : 'REVIEWER',
    withData: (op) => as(db, who, () => op(mu7SqlData(db))),
    appGitSha: 'b'.repeat(40),
    syntheticDatabase: false,
  };
}
let cached: ReturnType<typeof syntheticIntake>;
const sample = () => (cached ??= syntheticIntake());

async function exercise(db: FixtureDb) {
  const p = await sample(),
    inv = context(db, 'inv');
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'verify-release-'))),
    file = join(dir, 'intake.json');
  const oldFile = process.env.VERIFY_FORMAL_INTAKE_FILE,
    oldHash = process.env.VERIFY_FORMAL_INTAKE_SHA256;
  const bytes = JSON.stringify(p);
  writeFileSync(file, bytes, { mode: 0o600 });
  process.env.VERIFY_FORMAL_INTAKE_FILE = file;
  process.env.VERIFY_FORMAL_INTAKE_SHA256 = sha(bytes);
  try {
    await one(db, 'inv', 'select public.rpc_mu81_stage_sample($1::jsonb,$2)', [bytes, ATT]);
    const initial = await formalReleaseStatus(inv);
    assert.equal(initial.formal_units, 100);
    assert.equal(initial.assignments, 0);
    assert.equal(initial.prepared, true);
    assert.equal(initial.frozen, false);
    assert.equal(initial.descriptive_plan_recorded, false);
    assert.equal(JSON.stringify(initial).includes('intake_manifest'), false);
    assert.ok(!JSON.stringify(initial).includes(p.expected.unit_list_sha256));
    for (const who of ['r1', 'r2', 'pt1', 'pt2', 'adj', 'out', 'inv1'] as const) {
      await assert.rejects(
        one(db, who, 'select public.rpc_mu84_release_status()'),
        /investigator role/,
      );
      await assert.rejects(
        one(db, who, 'select public.rpc_mu84_release_action($1,$2,$3::jsonb)', [
          'open-review',
          initial.state_sha256,
          JSON.stringify({ attestation: ATT }),
        ]),
        /investigator role/,
      );
    }
    for (const role of ['anon', 'service_role']) {
      await db.exec(`begin; set local role ${role}`);
      try {
        await assert.rejects(
          db.query('select public.rpc_mu84_release_status()'),
          /permission denied/,
        );
      } finally {
        await db.exec('rollback');
      }
    }
    let s: ReleaseStatus = initial;
    const act = async (action: ReleaseAction, extra: Record<string, unknown> = {}) => {
      s = await formalReleaseStatus(inv);
      s = await formalReleaseAction(inv, {
        action,
        stateSha256: s.state_sha256,
        attestation: ATT,
        confirm: true,
        ...extra,
      });
      return s;
    };
    await act('record-descriptive-plan');
    assert.equal(s.descriptive_plan_recorded, true);
    const plan = (await one(
      db,
      'inv',
      "select decision_reference from public.mu7_gate_requirements where gate_id='G-EST-01' order by requirement_version desc limit 1",
    )) as string;
    assert.ok(plan.includes(sha(readFileSync('docs/DESCRIPTIVE_REVIEW_PLAN.md', 'utf8'))));
    assert.equal(await one(db, 'owner', 'select count(*)::int from public.mu7_gate_approvals'), 0);
    await assert.rejects(
      formalReleaseAction(inv, {
        action: 'bind-completion',
        stateSha256: initial.state_sha256,
        attestation: ATT,
        confirm: true,
      }),
      /not confirmed/,
    );
    await act('bind-completion');
    assert.equal(s.protocol_bound, true);
    await assert.rejects(act('open-review'), /not confirmed/);
    await assert.rejects(act('freeze-sample'), /not confirmed/);
    // The rehearsal lives alongside, but never enters the formal queue or analysis.
    await one(db, 'inv', 'select public.rpc_mu84_bind_protocol($1::jsonb)', [
      JSON.stringify({
        mode: 'PILOT',
        protocol_id: MU84_PROTOCOL_ID,
        guide_sha256: MU84_GUIDE_SHA256,
        attestation: ATT,
      }),
    ]);
    for (const action of ['import-pilot', 'import-training', 'assign-pilot'] as const)
      await core.mu7AdminAction(inv, { action });
    let pilotDispute = '';
    for (const who of ['pt1', 'pt2'] as const) {
      const c = context(db, who),
        w = (await core.getMu7Workspace(c)) as Mu7ReviewerWorkspace;
      assert.equal(w.queue.length, 12);
      for (const q of w.queue) {
        const u = await core.getMu7ReviewerUnit(c, q.assignmentId);
        pilotDispute ||= u.packet.unit.unit_id;
        await core.submitMu7(c, q.assignmentId, {
          answer: u.packet.unit.unit_id === pilotDispute ? 'CANNOT_TELL' : 'AGREE',
          note:
            u.packet.unit.unit_id === pilotDispute ? 'Fictional evidence needs resolution.' : null,
          ...(u.subtypeRequired ? { diabetesSubtype: 'TYPE_2_NOT_STATED' as const } : {}),
        });
      }
      const done = (await core.getMu7Workspace(c)) as Mu7ReviewerWorkspace;
      await finishReview(c, {
        mode: 'PILOT',
        answersSha256: done.completions![0].answersSha256,
        confirm: true,
      });
    }
    await core.recordMu7Adjudication(context(db, 'adj'), {
      unitId: pilotDispute,
      status: 'DISCORDANT_RESOLVED',
      decision: 'AGREE',
      basis: 'NEITHER',
      rationale: 'Synthetic resolution from fictional packet.',
    });
    await core.mu7AdminAction(inv, { action: 'lock-pilot', attestation: ATT });
    await core.mu7AdminAction(inv, { action: 'register-pilot-export' });
    s = await formalReleaseStatus(inv);
    assert.equal(s.pilot_exports.length, 1);
    await act('accept-pilot', { pilotExportId: s.pilot_exports[0].id });
    assert.equal(s.phase, 'SIGNED_OFF');
    await assert.rejects(act('freeze-sample'), /not confirmed/);
    // Synthetic specifications in this disposable DB only; preserve the real scope requirement.
    const gates = await rows<{ gate_id: string }>(
      db,
      'owner',
      "select distinct gate_id from public.mu7_gate_requirements where gate_id<>'G-EST-01'",
    );
    await specifyAndApproveGates(
      db,
      gates.map((g) => g.gate_id),
    );
    await assert.rejects(act('freeze-sample'), /not confirmed/);
    await one(db, 'inv', 'select public.rpc_mu7_approve_gate($1,$2,$3)', ['G-EST-01', ATT, plan]);
    await act('freeze-sample');
    assert.equal(s.frozen, true);
    assert.equal(s.assignments, 0);
    const ids = [await uidOf(db, 'r1'), await uidOf(db, 'r2')];
    await assert.rejects(
      act('assign-reviewers', { reviewerIds: [ids[0], ids[0]], qualifications: [ATT, ATT] }),
      /not confirmed/,
    );
    assert.equal(
      await one(
        db,
        'owner',
        "select count(*)::int from public.reviewers where mode_scope='FORMAL'",
      ),
      0,
    );
    const bad = structuredClone(p);
    [bad.queue[0].unit_id, bad.queue[1].unit_id] = [bad.queue[1].unit_id, bad.queue[0].unit_id];
    writeFileSync(file, JSON.stringify(bad));
    process.env.VERIFY_FORMAL_INTAKE_SHA256 = sha(JSON.stringify(bad));
    await assert.rejects(
      act('assign-reviewers', { reviewerIds: ids, qualifications: [ATT, ATT] }),
      /not confirmed/,
    );
    assert.equal(
      await one(
        db,
        'owner',
        "select count(*)::int from public.reviewers where mode_scope='FORMAL'",
      ),
      0,
    );
    writeFileSync(file, bytes);
    process.env.VERIFY_FORMAL_INTAKE_SHA256 = sha(bytes);
    await act('assign-reviewers', { reviewerIds: ids, qualifications: [ATT, ATT] });
    assert.equal(s.assignments, 200);
    assert.equal(s.phase, 'SIGNED_OFF');
    assert.equal(
      ((await core.getMu7Workspace(context(db, 'r1'))) as Mu7ReviewerWorkspace).queue.filter(
        (q) => q.available,
      ).length,
      0,
    );
    await act('open-review');
    assert.equal(s.phase, 'OPEN');
    await assert.rejects(act('close-review'), /not confirmed/);
    let bothCt = '',
      singleCt = '';
    for (const who of ['r1', 'r2'] as const) {
      const c = context(db, who),
        w = (await core.getMu7Workspace(c)) as Mu7ReviewerWorkspace;
      assert.equal(w.queue.length, 100);
      await core.acknowledgeMu7Training(c);
      for (const [i, q] of w.queue.entries()) {
        const u = await core.getMu7ReviewerUnit(c, q.assignmentId);
        if (i === 0) bothCt = u.packet.unit.unit_id;
        if (i === 1) singleCt = u.packet.unit.unit_id;
        const ct = i === 0 || (i === 1 && who === 'r1');
        await core.submitMu7(c, q.assignmentId, {
          answer: ct ? 'CANNOT_TELL' : 'AGREE',
          note: ct ? 'Fictional text is insufficient.' : null,
          ...(u.subtypeRequired ? { diabetesSubtype: 'CANNOT_TELL_FROM_PACKET' as const } : {}),
        });
      }
      const done = (await core.getMu7Workspace(c)) as Mu7ReviewerWorkspace;
      const own = done.completions!.find((x) => x.mode === 'FORMAL')!;
      await finishReview(c, { mode: 'FORMAL', answersSha256: own.answersSha256, confirm: true });
      await assert.rejects(
        core.submitMu7(c, w.queue[0].assignmentId, { answer: 'AGREE' }),
        /finished review is locked/,
      );
      assert.equal(
        ((await core.getMu7Workspace(context(db, 'adj'))) as Mu7AdjudicatorWorkspace).queue.filter(
          (q) => q.mode === 'FORMAL',
        ).length,
        0,
      );
      if (who === 'r1') await assert.rejects(act('close-review'), /not confirmed/);
    }
    await act('close-review');
    assert.equal(s.phase, 'CLOSED_COMPLETE');
    assert.equal(s.snapshot_recorded, true);
    assert.ok(s.completion.every((c) => c.finished && c.answered === 100));
    await assert.rejects(act('lock-reference'), /not confirmed/);
    for (const unitId of [bothCt, singleCt])
      await core.recordMu7Adjudication(context(db, 'adj'), {
        unitId,
        status: 'UNRESOLVED_ESCALATED',
        decision: null,
        basis: 'NONE',
        rationale: 'Synthetic packet still cannot resolve membership.',
      });
    await act('lock-reference');
    const bundle = await core.exportMu7Bundle(inv, 'FORMAL');
    assert.equal(bundle.manifest.status, 'FORMAL'); // simulated hosted path, fictional data only
    const localBundle = await core.exportMu7Bundle({ ...inv, syntheticDatabase: true }, 'FORMAL');
    assert.ok(String(localBundle.manifest.status).startsWith('SYNTHETIC'));
    await core.mu7AdminAction(inv, { action: 'register-formal-export' });
    assert.equal((await formalReleaseStatus(inv)).formal_exports, 1);
    for (const f of bundle.files) writeFileSync(join(dir, f.name), f.content);
    writeFileSync(join(dir, 'manifest.json'), bundle.manifestText);
    const report = summarizeMu84Bundle(dir, bundle.manifestSha256);
    assert.equal(report.totalMappings, 100);
    assert.equal(report.finalIndependentJudgments, 200);
    assert.equal(
      report.byFamily.reduce((s, f) => s + f.bothFinalCannotTell, 0),
      1,
    );
    assert.equal(
      report.byFamily.reduce((s, f) => s + f.unresolved, 0),
      2,
    );
    assert.equal(report.byFamily.find((f) => f.family === 'SG')?.reviewerAgreement, undefined);
    assert.ok(!JSON.stringify(report).includes(String(p.units[0].unit_id)));
    assert.equal(
      await one(db, 'inv', 'select count(*)::int from public.mu7_gate_approvals'),
      gates.length + 1,
    );
  } finally {
    if (oldFile === undefined) delete process.env.VERIFY_FORMAL_INTAKE_FILE;
    else process.env.VERIFY_FORMAL_INTAKE_FILE = oldFile;
    if (oldHash === undefined) delete process.env.VERIFY_FORMAL_INTAKE_SHA256;
    else process.env.VERIFY_FORMAL_INTAKE_SHA256 = oldHash;
    rmSync(dir, { recursive: true, force: true });
  }
}
test('prepared sample: explicit release, two final sets, adjudication and descriptive export', async () => {
  const db = await emptyIntakeDatabase();
  try {
    await exercise(db);
  } finally {
    await db.close();
  }
});
test('server refuses other roles before file or database access; confirmation is explicit', async () => {
  for (const role of ['REVIEWER', 'ADJUDICATOR', 'PRACTICE_OBSERVER'] as const) {
    const ctx = {
      role,
      withData: () => {
        throw new Error('PRIVATE_SENTINEL');
      },
    } as unknown as core.Mu7Context;
    await assert.rejects(formalReleaseStatus(ctx), /investigator/);
    await assert.rejects(formalReleaseAction(ctx, {}), /investigator/);
  }
  assert.throws(() =>
    releaseRequestSchema.parse({
      action: 'open-review',
      stateSha256: 'a'.repeat(64),
      attestation: ATT,
      confirm: false,
    }),
  );
  assert.throws(() =>
    releaseRequestSchema.parse({
      action: 'open-review',
      stateSha256: 'a'.repeat(64),
      attestation: ATT,
      confirm: true,
      gateApproval: true,
    }),
  );
});
test(
  'native PostgreSQL formal release and export with all guards',
  { skip: !process.env.VERIFY_PG_TEST_URL },
  async () => {
    await withDisposableHandoffDatabase(process.env.VERIFY_PG_TEST_URL!, async (url: string) => {
      const c = new Client({ connectionString: url });
      await c.connect();
      const db = {
        query: <T>(sql: string, params?: unknown[]) =>
          c.query(sql, params) as unknown as Promise<{ rows: T[] }>,
        exec: (sql: string) => c.query(sql),
      };
      try {
        await emptyIntakeDatabase(db);
        await exercise(db);
      } finally {
        await c.end();
      }
    });
  },
);
