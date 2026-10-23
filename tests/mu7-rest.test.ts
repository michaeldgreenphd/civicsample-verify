// SYNTHETIC ENGINEERING ONLY. The Supabase path of review design v7 (src/server/mu7-rest.ts) against
// a minimal PostgREST emulator backed by the full migration chain on PGlite: every request runs as
// the `authenticated` role with the bearer token's claims, so row-level security and the rpc_mu7_*
// guards answer exactly as they would behind PostgREST. Not a live Supabase test.
import assert from 'node:assert/strict';
import test from 'node:test';
import { PostgrestClient } from '../src/lib/postgrest';
import type { SupabaseWebConfig } from '../src/lib/supabase-config';
import { MU7_PILOT_PLANTED } from '../src/lib/mu7-synthetic';
import type {
  Mu7AdjudicatorWorkspace,
  Mu7InvestigatorWorkspace,
  Mu7ReviewerWorkspace,
} from '../src/lib/mu7-types';
import * as core from '../src/server/mu7-core';
import { mu7RestData } from '../src/server/mu7-rest';
import { ServiceError } from '../src/server/service';
import { P, signedOffPilot, type FixtureDb } from './mu7-fixture';

const BASE = 'https://emulator.invalid';
const ATT = 'Synthetic attestation for the REST path test only.';
type Who = 'inv' | 'pt1' | 'pt2' | 'adj';

/** GET /rest/v1/<relation>?select=...&col=eq.v|is.null|is.true&order=a,b and POST /rest/v1/rpc/<fn>. */
function emulator(db: FixtureDb): typeof fetch {
  const ident = /^[a-z_][a-z0-9_]*$/;
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const token = String((init?.headers as Record<string, string>).Authorization).replace(
      'Bearer ',
      '',
    );
    const claims = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
    const reply = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    try {
      await db.exec('begin');
      await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]);
      await db.exec('set local role authenticated');
      let result: unknown;
      const rpc = /^\/rest\/v1\/rpc\/([a-z0-9_]+)$/.exec(url.pathname);
      const rel = /^\/rest\/v1\/([a-z_][a-z0-9_]*)$/.exec(url.pathname);
      if (rpc && init?.method === 'POST') {
        const args = JSON.parse(String(init.body ?? '{}')) as Record<string, unknown>;
        const keys = Object.keys(args);
        if (keys.some((k) => !ident.test(k))) throw new Error('bad argument');
        const params = keys.map((k) =>
          args[k] !== null && typeof args[k] === 'object' ? JSON.stringify(args[k]) : args[k],
        );
        const call = `public.${rpc[1]}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')})`;
        const setof = await db.query<{ s: boolean }>(
          "select bool_or(p.proretset) as s from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = $1",
          [rpc[1]],
        );
        result = setof.rows[0]?.s
          ? (await db.query(`select * from ${call}`, params)).rows
          : (await db.query<{ v: unknown }>(`select ${call} as v`, params)).rows[0]?.v;
      } else if (rel && init?.method === 'GET') {
        const cols = (url.searchParams.get('select') ?? '*').split(',');
        const params: unknown[] = [];
        const where: string[] = [];
        for (const [k, v] of url.searchParams) {
          if (k === 'select' || k === 'order') continue;
          if (!ident.test(k)) throw new Error('bad column');
          if (v === 'is.null') where.push(`${k} is null`);
          else if (v === 'is.true' || v === 'is.false') where.push(`${k} is ${v.slice(3)}`);
          else if (v.startsWith('eq.')) {
            params.push(v.slice(3));
            where.push(`${k}::text = $${params.length}`);
          } else throw new Error('unsupported filter');
        }
        const order = url.searchParams.get('order');
        if ([...cols, ...(order ? order.split(',') : [])].some((c) => c !== '*' && !ident.test(c)))
          throw new Error('bad column');
        result = (
          await db.query(
            `select ${cols.join(', ')} from public.${rel[1]}${where.length ? ` where ${where.join(' and ')}` : ''}${order ? ` order by ${order}` : ''}`,
            params,
          )
        ).rows;
      } else throw new Error('unsupported request');
      await db.exec('commit');
      return reply(200, result ?? null);
    } catch (e) {
      await db.exec('rollback').catch(() => undefined);
      const err = e as { message: string; code?: string };
      return reply(err.code === '42501' ? 403 : 400, {
        code: err.code ?? 'P0001',
        message: err.message,
      });
    } finally {
      await db.exec('reset role').catch(() => undefined);
    }
  }) as typeof fetch;
}

function context(db: FixtureDb, who: Who): core.Mu7Context {
  const token = Buffer.from(JSON.stringify({ sub: P[who].sub, aal: P[who].aal })).toString(
    'base64url',
  );
  const config = { url: BASE, publishableKey: 'sb_publishable_emulator' } as SupabaseWebConfig;
  const data = mu7RestData(new PostgrestClient(config, token, core.mu7PublicError, emulator(db)));
  const role = who === 'inv' ? 'INVESTIGATOR' : who === 'adj' ? 'ADJUDICATOR' : 'REVIEWER';
  return { role, withData: (op) => op(data), appGitSha: 'c'.repeat(40), syntheticDatabase: true };
}
async function status(p: Promise<unknown>) {
  try {
    await p;
    return { status: 200, message: '' };
  } catch (e) {
    if (e instanceof ServiceError) return { status: e.status, message: e.message };
    throw e;
  }
}

test('v7 over the PostgREST path: the synthetic pilot under each caller’s own token', async () => {
  const { db } = await signedOffPilot({ stopAfter: 'accounts' });
  try {
    const inv = context(db, 'inv');
    const pt1 = context(db, 'pt1');
    const pt2 = context(db, 'pt2');
    const adj = context(db, 'adj');
    // A reviewer cannot run investigator actions, even past the application's role check: the
    // database refuses under the reviewer's own token.
    assert.equal(
      (
        await status(
          core.mu7AdminAction({ ...pt1, role: 'INVESTIGATOR' }, { action: 'import-pilot' }),
        )
      ).status,
      403,
    );
    await core.mu7AdminAction(inv, { action: 'record-design', attestation: ATT });
    await core.mu7AdminAction(inv, { action: 'import-pilot' });
    await core.mu7AdminAction(inv, { action: 'import-training' });
    let ws = (await core.mu7AdminAction(inv, {
      action: 'assign-pilot',
    })) as Mu7InvestigatorWorkspace;
    assert.equal(ws.counts.pilotQueue, 24);
    assert.equal(ws.localTools, false);
    assert.match(
      (
        await status(
          core.mu7AdminAction(inv, {
            action: 'lock-account',
            account: 'adjudicator',
            reason: 'x-y-z',
          }),
        )
      ).message,
      /privileged identity tool/,
    );
    for (const [ctx, slot] of [
      [pt1, 1],
      [pt2, 2],
    ] as const) {
      const q = (await core.getMu7Workspace(ctx)) as Mu7ReviewerWorkspace;
      assert.equal(q.queue.length, 12);
      assert.equal(q.training.length, 3);
      for (const item of q.queue) {
        const unit = await core.getMu7ReviewerUnit(ctx, item.assignmentId);
        const p = MU7_PILOT_PLANTED[unit.packet.unit.unit_id].find(
          (x) => x.reviewer_slot === slot,
        )!;
        await core.submitMu7(ctx, item.assignmentId, {
          answer: p.answer,
          reasonCode: p.reason_code,
          note: p.note,
          uncertain: p.uncertain,
        });
      }
    }
    // Blinding through the REST path: another reviewer's assignment is not found.
    const q1 = (await core.getMu7Workspace(pt1)) as Mu7ReviewerWorkspace;
    assert.equal(
      (await status(core.getMu7ReviewerUnit(pt2, q1.queue[0].assignmentId))).status,
      404,
    );
    const aq = (await core.getMu7Workspace(adj)) as Mu7AdjudicatorWorkspace;
    assert.equal(aq.queue.length, 5);
    for (const { unitId } of aq.queue)
      await core.recordMu7Adjudication(adj, {
        unitId,
        status: 'UNRESOLVED_ESCALATED',
        basis: 'NONE',
        rationale: 'Synthetic: REST path test.',
      });
    ws = (await core.mu7AdminAction(inv, {
      action: 'lock-pilot',
      attestation: ATT,
    })) as Mu7InvestigatorWorkspace;
    assert.ok(ws.pilotRouting.every((r) => r.matches === true));
    const bundle = await core.exportMu7Bundle(inv, 'PILOT');
    assert.deepEqual(
      bundle.files.map((f) => f.rows),
      [12, 12, 24, 12],
    );
    ws = (await core.mu7AdminAction(inv, {
      action: 'register-pilot-export',
    })) as Mu7InvestigatorWorkspace;
    assert.equal(ws.exports[0].manifestSha256, bundle.manifestSha256);
    // The same bundle text as the local path would write from the same rows: timestamps at
    // millisecond precision, booleans as true/false.
    assert.match(bundle.files[2].content, /,(true|false),/);
    assert.match(bundle.files[2].content, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/);
  } finally {
    await db.close();
  }
});
