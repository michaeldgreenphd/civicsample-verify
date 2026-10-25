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
import { MU7_PILOT_EXPECTED_ROUTING } from '../src/lib/mu7-synthetic';
import type { Mu7AdjudicatorWorkspace, Mu7ReviewerWorkspace } from '../src/lib/mu7-types';
import * as core from '../src/server/mu7-core';
import { mu7RestData } from '../src/server/mu7-rest';
import {
  adjudicationDuplicateRefused,
  adjudicatorPhase,
  outcome,
  reviewerPersistence,
  reviewerPhase,
} from './mu7-live-phases';

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
  return {
    ctx,
    client,
    token: s.accessToken,
    signOut: () => rt.auth.signOut(s.accessToken, 'local'),
  };
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
        // A gate still pending specification: even if every role check failed, MU7X-G08 would refuse
        // the row, so this refusal check can never record an approval.
        const approve = await outcome(
          s.client.rpc('rpc_mu7_approve_gate', {
            p_gate_id: 'G-PROV-01',
            p_attestation: 'Synthetic attestation, live restriction check.',
            p_evidence_reference: 'synthetic restriction check, not a decision record',
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
  'staging v7 reviewers: independent answers with the planted refusals, isolation and persistence across sessions (resumable)',
  only('reviewers'),
  async () => {
    const rt = runtime();
    const [p1, p2] = [
      await session(rt, 'syn-pilot-reviewer-1'),
      await session(rt, 'syn-pilot-reviewer-2'),
    ];
    try {
      // tests/mu7-live-phases.ts: resumable; answers on record are validated, never resubmitted.
      const stats = await reviewerPhase([
        { ctx: p1.ctx, slot: 1 },
        { ctx: p2.ctx, slot: 2 },
      ]);
      assert.equal(stats.submitted + stats.skipped, 24);
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
      await reviewerPersistence({ ctx: again.ctx, slot: 1 });
    } finally {
      await again.signOut();
    }
  },
);

test(
  'staging v7 adjudicator: only the 5 routed units, routing as expected, missing tie-breaks recorded once (resumable)',
  only('adjudicator'),
  async () => {
    const rt = runtime();
    const a = await session(rt, 'syn-adjudicator');
    try {
      const finals = await a.client.select<{ unit_id: string; routing: string }>(
        'v_mu7_final_reference',
        'select=unit_id,routing&mode=eq.PILOT',
      );
      assert.equal(finals.length, 12);
      for (const f of finals)
        assert.equal(f.routing, MU7_PILOT_EXPECTED_ROUTING[f.unit_id], f.unit_id);
      // tests/mu7-live-phases.ts: tie-breaks on record are validated and skipped; only missing
      // ones are written.
      const stats = await adjudicatorPhase(a.ctx);
      assert.equal(stats.recorded + stats.skipped, 5);
    } finally {
      await a.signOut();
    }
  },
);

test(
  'staging v7 adjudicator: a second tie-break of an adjudicated unit is refused',
  only('adjudicator'),
  async () => {
    const rt = runtime();
    const a = await session(rt, 'syn-adjudicator');
    try {
      const routed = Object.entries(MU7_PILOT_EXPECTED_ROUTING)
        .filter(([, r]) => r === 'ROUTED')
        .map(([u]) => u)
        .sort();
      await adjudicationDuplicateRefused(a.ctx, routed[0]);
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
