// REAL Supabase staging checks of the v7 synthetic pilot, in phases around the investigator's own
// browser steps (investigator actions need a second factor, so they are never scripted). Each phase
// runs only when the private files are named and VERIFY_STAGING_V7_PHASE selects it; otherwise
// every check is BLOCKED, never a pass. The checks use the application's own v7 service code over
// PostgREST under each synthetic account's own token. Synthetic accounts and synthetic units only.
//
//   VERIFY_SUPABASE_WEB_CONFIG=/abs/private/web-app.json
//   VERIFY_SUPABASE_SIGNIN=/abs/private/synthetic-sign-in.json
//   VERIFY_STAGING_V7_PHASE=restrictions|reviewers|adjudicator|account-lock|after-lock
//   (account-lock also needs VERIFY_SUPABASE_ADMIN_CONFIG, VERIFY_SUPABASE_ADMIN_APPLY=1 and
//    VERIFY_STAGING_V7_PLAN_SHA256: it runs the privileged lock and unlock tool itself)
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { PostgrestClient } from '../src/lib/postgrest';
import { supabaseWebConfig } from '../src/lib/supabase-config';
import { SupabaseAuth } from '../src/lib/supabase-auth';
import { MU7_PILOT_EXPECTED_ROUTING, MU7_PILOT_PLANTED } from '../src/lib/mu7-synthetic';
import type { Mu7AdjudicatorWorkspace, Mu7ReviewerWorkspace } from '../src/lib/mu7-types';
import * as core from '../src/server/mu7-core';
import { mu7RestData } from '../src/server/mu7-rest';
import { ServiceError } from '../src/server/service';

const webPath = process.env.VERIFY_SUPABASE_WEB_CONFIG;
const signInPath = process.env.VERIFY_SUPABASE_SIGNIN;
const phase = process.env.VERIFY_STAGING_V7_PHASE;
const only = (name: string) => ({
  skip:
    !webPath || !signInPath
      ? 'BLOCKED: private web configuration and synthetic sign-in file not named'
      : phase !== name
        ? `not selected (VERIFY_STAGING_V7_PHASE=${name})`
        : false,
  timeout: 300_000,
});
/** A private file: owner-only and outside every Git repository (it holds synthetic passwords). */
function privateJson(path: string) {
  const real = realpathSync(path);
  assert.equal(statSync(real).mode & 0o077, 0, 'private files must be mode 600');
  for (let dir = dirname(real); ; dir = dirname(dir)) {
    assert.ok(
      !existsSync(join(dir, '.git')),
      'private files must live outside every Git repository',
    );
    if (dirname(dir) === dir) break;
  }
  return JSON.parse(readFileSync(real, 'utf8'));
}
function runtime() {
  const web = privateJson(webPath!);
  const signIn = privateJson(signInPath!) as {
    accounts: { username: string; role: string; password: string }[];
  };
  const config = supabaseWebConfig({
    VERIFY_DATA_BACKEND: 'supabase',
    VERIFY_SUPABASE_URL: web.project.projectUrl,
    VERIFY_SUPABASE_PUBLISHABLE_KEY: web.publishableKey,
    VERIFY_SUPABASE_ACCOUNT_DOMAIN_REF: web.accountDomainRef,
    VERIFY_SITE_ORIGIN: web.siteOrigin,
  });
  const auth = new SupabaseAuth(config);
  const account = (username: string) => {
    const a = signIn.accounts.find((x) => x.username === username);
    assert.ok(a, `${username} is in the private sign-in file`);
    return a!;
  };
  return { config, auth, account };
}
type Runtime = ReturnType<typeof runtime>;
async function session(rt: Runtime, username: string) {
  const a = rt.account(username);
  const s = await rt.auth.signIn(a.username, a.password);
  const client = new PostgrestClient(rt.config, s.accessToken, core.mu7PublicError);
  const ctx: core.Mu7Context = {
    role: a.role as core.Mu7Context['role'],
    withData: (op) => op(mu7RestData(client)),
    appGitSha: '0'.repeat(40),
    syntheticDatabase: true,
  };
  return { ctx, client, token: s.accessToken, signOut: () => rt.auth.signOut(s.accessToken) };
}
async function outcome(p: Promise<unknown>) {
  try {
    await p;
    return { status: 200, message: '' };
  } catch (e) {
    if (e instanceof ServiceError) return { status: e.status, message: e.message };
    throw e;
  }
}

test(
  'staging v7 restrictions: reviewers, the adjudicator and an investigator without a second factor cannot run investigator actions',
  only('restrictions'),
  async () => {
    const rt = runtime();
    for (const username of ['syn-pilot-reviewer-1', 'syn-adjudicator', 'syn-investigator-2']) {
      const s = await session(rt, username);
      try {
        // A read-only probe first: if the database let this account read the investigator-only gate
        // status (for example because a second factor is not required), stop before any write.
        const probe = await outcome(s.client.rpc('rpc_mu7_gate_status', {}));
        assert.equal(
          probe.status,
          403,
          `${username} must be refused the investigator-only read before any write is tried`,
        );
        // Past the application's own role check: the database refuses under the caller's token.
        const asInvestigator = { ...s.ctx, role: 'INVESTIGATOR' as const };
        for (const action of [
          {
            action: 'record-design',
            attestation: 'Synthetic attestation, live restriction check.',
          },
          { action: 'import-pilot' },
          { action: 'lock-pilot', attestation: 'Synthetic attestation, live restriction check.' },
        ] as const) {
          const r = await outcome(core.mu7AdminAction(asInvestigator, action));
          assert.ok([403, 409].includes(r.status), `${username} ${action.action}: ${r.status}`);
          assert.notEqual(r.status, 200);
        }
        const approve = await outcome(
          s.client.rpc('rpc_mu7_approve_gate', {
            p_gate_id: 'G-PAIN-01',
            p_attestation: 'Synthetic attestation, live restriction check.',
            p_evidence_reference: 'investigator decisions 2026-10-23, addendum 8, item 40',
          }),
        );
        assert.equal(approve.status, 403, `${username} cannot approve a gate`);
        for (const view of [
          'v_mu7_export_units',
          'v_mu7_export_unit_design',
          'mu7_gate_approvals',
          'mu7_unit_design',
        ])
          assert.deepEqual(
            await s.client.select(view, 'select=*&limit=1'),
            [],
            `${username} reads no ${view}`,
          );
      } finally {
        await s.signOut();
      }
    }
  },
);

test(
  'staging v7 reviewers: independent answers with the planted refusals, isolation and persistence across sessions',
  only('reviewers'),
  async () => {
    const rt = runtime();
    const [p1, p2] = [
      await session(rt, 'syn-pilot-reviewer-1'),
      await session(rt, 'syn-pilot-reviewer-2'),
    ];
    try {
      const q1 = (await core.getMu7Workspace(p1.ctx)) as Mu7ReviewerWorkspace;
      const q2 = (await core.getMu7Workspace(p2.ctx)) as Mu7ReviewerWorkspace;
      assert.equal(q1.queue.length, 12, 'the investigator assigned 12 units to slot 1');
      assert.equal(q2.queue.length, 12);
      assert.ok(q1.queue.filter((q) => q.unitRole === 'SUBGROUP').every((q) => !q.available));
      // Isolation: neither reviewer reaches the other's assignment or answers.
      assert.equal(
        (await outcome(core.getMu7ReviewerUnit(p2.ctx, q1.queue[0].assignmentId))).status,
        404,
      );
      for (const [s, slot, q] of [
        [p1, 1, q1],
        [p2, 2, q2],
      ] as const) {
        for (const item of q.queue) {
          const unit = await core.getMu7ReviewerUnit(s.ctx, item.assignmentId);
          const p = MU7_PILOT_PLANTED[unit.packet.unit.unit_id].find(
            (x) => x.reviewer_slot === slot,
          )!;
          // Resumable: an answer already on record (from an earlier, interrupted run) must be the
          // planted one and is not submitted again, so a rerun never adds a revision.
          const last = unit.ownAnswers.at(-1);
          if (last) {
            assert.equal(last.answer, p.answer, `${unit.packet.unit.unit_id}: answer on record`);
            assert.equal(
              last.reasonCode,
              p.reason_code,
              `${unit.packet.unit.unit_id}: reason on record`,
            );
            continue;
          }
          if (p.answer === 'DISAGREE')
            assert.match(
              (
                await outcome(
                  core.submitMu7(s.ctx, item.assignmentId, {
                    answer: 'DISAGREE',
                    reasonCode: p.reason_code,
                  }),
                )
              ).message,
              /^MU7-G36:/,
            );
          await core.submitMu7(s.ctx, item.assignmentId, {
            answer: p.answer,
            reasonCode: p.reason_code,
            note: p.note,
            uncertain: p.uncertain,
          });
        }
      }
      const other = await p2.client.select<{ reviewer_slot: number }>(
        'mu7_judgments',
        'select=reviewer_slot',
      );
      assert.ok(
        other.every((j) => j.reviewer_slot === 2),
        'reviewer 2 reads only their own judgments',
      );
    } finally {
      await Promise.all([p1.signOut(), p2.signOut()]);
    }
    // Persistence: a new session reads every answer back from the database.
    const again = await session(rt, 'syn-pilot-reviewer-1');
    try {
      const ws = (await core.getMu7Workspace(again.ctx)) as Mu7ReviewerWorkspace;
      assert.ok(ws.queue.every((q) => q.answered));
      for (const item of ws.queue) {
        const unit = await core.getMu7ReviewerUnit(again.ctx, item.assignmentId);
        const p = MU7_PILOT_PLANTED[unit.packet.unit.unit_id].find((x) => x.reviewer_slot === 1)!;
        assert.equal(unit.ownAnswers.at(-1)?.answer, p.answer, unit.packet.unit.unit_id);
      }
    } finally {
      await again.signOut();
    }
  },
);

test(
  'staging v7 adjudicator: only the 5 routed units, routing as expected, tie-breaks recorded once',
  only('adjudicator'),
  async () => {
    const rt = runtime();
    const a = await session(rt, 'syn-adjudicator');
    try {
      const ws = (await core.getMu7Workspace(a.ctx)) as Mu7AdjudicatorWorkspace;
      const routed = Object.entries(MU7_PILOT_EXPECTED_ROUTING)
        .filter(([, r]) => r === 'ROUTED')
        .map(([u]) => u)
        .sort();
      assert.deepEqual(
        ws.queue.map((q) => q.unitId),
        routed,
      );
      const finals = await a.client.select<{ unit_id: string; routing: string }>(
        'v_mu7_final_reference',
        'select=unit_id,routing&mode=eq.PILOT',
      );
      for (const f of finals)
        assert.equal(f.routing, MU7_PILOT_EXPECTED_ROUTING[f.unit_id], f.unit_id);
      const concordant = finals.find((f) => f.routing === 'CONCORDANT_AGREE')!.unit_id;
      assert.equal((await outcome(core.getMu7AdjudicatorUnit(a.ctx, concordant))).status, 404);
      for (const unitId of routed) {
        const done = await core.recordMu7Adjudication(a.ctx, {
          unitId,
          status: 'UNRESOLVED_ESCALATED',
          basis: 'NONE',
          rationale: 'Synthetic: escalated in the live staging pilot.',
        });
        assert.ok(done.adjudication);
      }
      assert.equal(
        (
          await outcome(
            core.recordMu7Adjudication(a.ctx, {
              unitId: routed[0],
              status: 'UNRESOLVED_ESCALATED',
              basis: 'NONE',
              rationale: 'A second tie-break must be refused.',
            }),
          )
        ).status,
        409,
      );
    } finally {
      await a.signOut();
    }
  },
);

test(
  'staging account lock: an already-issued token is refused while locked and works again after release',
  only('account-lock'),
  async () => {
    const rt = runtime();
    const adminConfig = process.env.VERIFY_SUPABASE_ADMIN_CONFIG;
    const planHash = process.env.VERIFY_STAGING_V7_PLAN_SHA256;
    assert.ok(
      adminConfig && planHash && process.env.VERIFY_SUPABASE_ADMIN_APPLY === '1',
      'BLOCKED: lock test needs the authorized admin configuration',
    );
    const ref = privateJson(adminConfig!).project.stagingProjectRef as string;
    const tool = (command: 'lock' | 'unlock') => {
      const r = spawnSync(
        process.execPath,
        [
          'scripts/supabase-admin.mjs',
          command,
          '--config',
          adminConfig!,
          '--username',
          'syn-reviewer-1',
          '--apply',
          '--confirm-project',
          ref,
          '--plan-sha256',
          planHash!,
        ],
        { encoding: 'utf8', env: process.env },
      );
      assert.equal(r.status, 0, `${command} failed`);
    };
    // A staging reviewer outside the pilot: its token is issued before the lock.
    const s = await session(rt, 'syn-reviewer-1');
    const whoami = async () => (await s.client.rpc<unknown[]>('rpc_whoami', {})).length;
    assert.equal(await whoami(), 1);
    try {
      // Inside the cleanup scope: if the lock stops part-way, the release below still runs (the
      // privileged tool's lock and unlock are both resumable).
      tool('lock');
      assert.equal(await whoami(), 0, 'the issued token resolves to no user while locked');
      await assert.rejects(
        rt.auth.signIn('syn-reviewer-1', rt.account('syn-reviewer-1').password),
        'sign-in is refused while locked',
      );
    } finally {
      tool('unlock');
    }
    assert.equal(await whoami(), 1, 'the same token works again after release');
    await s.signOut();
  },
);

test(
  'staging v7 after the pilot lock: no answer is accepted and no tie-break can be added',
  only('after-lock'),
  async () => {
    const rt = runtime();
    const [p2, a] = [
      await session(rt, 'syn-pilot-reviewer-2'),
      await session(rt, 'syn-adjudicator'),
    ];
    try {
      const ws = (await core.getMu7Workspace(p2.ctx)) as Mu7ReviewerWorkspace;
      const late = await outcome(
        core.submitMu7(p2.ctx, ws.queue[0].assignmentId, { answer: 'AGREE' }),
      );
      assert.equal(late.status, 409);
      assert.match(late.message, /^MU7-G34:|^MU7X-G01:/);
      const unit = (await core.getMu7Workspace(a.ctx)) as Mu7AdjudicatorWorkspace;
      assert.ok(unit.queue.every((q) => q.adjudicated));
      const detail = await core.getMu7AdjudicatorUnit(a.ctx, unit.queue[0].unitId);
      assert.equal(detail.referenceLocked, true);
    } finally {
      await Promise.all([p2.signOut(), a.signOut()]);
    }
  },
);
