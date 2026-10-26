// Review design v7 on the local synthetic database (PGlite). Each service operation runs in one
// transaction under the signed-in actor's database identity (src/server/db.ts withActor), so
// row-level security and the rpc_mu7_* guards decide everything, as on Supabase.
import { ACCOUNTS, restoreLocalSignIn, revokeActorSessions } from '../lib/auth';
import type { Actor } from '../lib/types';
import type {
  Mu7AdjudicationInput,
  Mu7AdminAction,
  Mu7Mode,
  Mu7SubmissionInput,
} from '../lib/mu7-types';
import { getDb, withActor } from './db';
import * as core from './mu7-core';
import * as intake from './formal-intake';
import { ServiceError } from './service';
import { appGitSha } from './tlv5';

type Tx = Parameters<Parameters<typeof withActor>[1]>[0];
const IDENT = /^[a-z_][a-z0-9_]*$/;

/** The two operations of the v7 service over a SQL connection (a transaction or a client). */
export function mu7SqlData(tx: {
  query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}): core.Mu7Data {
  return {
    async select<T>(
      relation: string,
      options: { columns?: readonly string[]; eq?: core.Mu7Filter; order?: string[] } = {},
    ) {
      const names = [
        relation,
        ...(options.columns ?? []),
        ...Object.keys(options.eq ?? {}),
        ...(options.order ?? []),
      ];
      if (names.some((n) => !IDENT.test(n))) throw new ServiceError(500, 'Invalid relation.');
      const params: unknown[] = [];
      const where = Object.entries(options.eq ?? {}).map(([k, v]) => {
        if (v === null) return `${k} is null`;
        params.push(v);
        return `${k} = $${params.length}`;
      });
      const sql = `select ${options.columns?.length ? options.columns.join(', ') : '*'} from public.${relation}${
        where.length ? ` where ${where.join(' and ')}` : ''
      }${options.order?.length ? ` order by ${options.order.join(', ')}` : ''}`;
      return (await tx.query<T>(sql, params)).rows;
    },
    async rpc<T>(fn: string, args: Record<string, unknown>, shape: 'value' | 'rows') {
      if (!/^rpc_[a-z0-9_]+$/.test(fn) || Object.keys(args).some((k) => !IDENT.test(k)))
        throw new ServiceError(500, 'Invalid function.');
      const keys = Object.keys(args);
      const params = keys.map((k) => {
        const v = args[k];
        return v !== null && typeof v === 'object' ? JSON.stringify(v) : v;
      });
      const call = `public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')})`;
      if (shape === 'rows') return (await tx.query(`select * from ${call}`, params)).rows as T;
      const r = await tx.query<{ v: T }>(`select ${call} as v`, params);
      return r.rows[0]?.v as T;
    },
  };
}

async function run<T>(actor: Actor, operation: (data: core.Mu7Data) => Promise<T>): Promise<T> {
  try {
    return await withActor(actor, (tx: Tx) => operation(mu7SqlData(tx)));
  } catch (error) {
    if (error instanceof ServiceError) throw error;
    const mapped = core.mu7PublicError(error instanceof Error ? error.message : '');
    if (mapped) throw mapped;
    throw new ServiceError(500, 'The local review database could not complete this request.');
  }
}

/** The privileged identity tool's lock and release, for the local synthetic database only. The
 *  lock row is written by the database owner (no application role may write account locks) and
 *  every local session of the account is revoked; every identity helper then refuses the account. */
function localTools(actor: Actor): core.Mu7Context['localTools'] {
  const target = (account: string) => {
    const a = ACCOUNTS[account];
    if (!a || !['reviewer-a', 'reviewer-b', 'adjudicator'].includes(account))
      throw new ServiceError(
        400,
        'Only a synthetic reviewer or adjudicator account can be locked here.',
      );
    return a;
  };
  return {
    async lockAccount(account, reason) {
      const a = target(account);
      const db = await getDb();
      const active = await db.query(
        'select 1 from public.account_locks where user_id = $1 and released_at is null',
        [a.id],
      );
      if (active.rows.length) throw new ServiceError(409, 'This account is already locked.');
      await db.query(
        'insert into public.account_locks (user_id, locked_by, reason) values ($1, $2, $3)',
        [a.id, `local investigator ${actor.id}`, reason],
      );
      revokeActorSessions(a.id, actor);
    },
    async unlockAccount(account) {
      const a = target(account);
      const db = await getDb();
      const released = await db.query(
        'update public.account_locks set released_at = now(), released_by = $2 where user_id = $1 and released_at is null returning lock_id',
        [a.id, `local investigator ${actor.id}`],
      );
      if (!released.rows.length) throw new ServiceError(409, 'This account is not locked.');
      restoreLocalSignIn(a.id, actor);
    },
  };
}

function context(actor: Actor): core.Mu7Context {
  return {
    role: actor.role as core.Mu7Context['role'],
    withData: (operation) => run(actor, operation),
    appGitSha: appGitSha(),
    syntheticDatabase: true,
    localTools: actor.role === 'INVESTIGATOR' ? localTools(actor) : undefined,
  };
}

export const getMu7Workspace = (actor: Actor) => core.getMu7Workspace(context(actor));
export const getFormalIntakePlan = (actor: Actor) => intake.formalIntakePlan(context(actor));
export const stageFormalSample = (actor: Actor, request: unknown) =>
  intake.stageFormalSample(context(actor), request);
export const getMu7ReviewerUnit = (actor: Actor, assignmentId: string) =>
  core.getMu7ReviewerUnit(context(actor), assignmentId);
export const submitMu7 = (actor: Actor, assignmentId: string, input: Mu7SubmissionInput) =>
  core.submitMu7(context(actor), assignmentId, input);
export const acknowledgeMu7Training = (actor: Actor) => core.acknowledgeMu7Training(context(actor));
export const getMu7AdjudicatorUnit = (actor: Actor, unitId: string) =>
  core.getMu7AdjudicatorUnit(context(actor), unitId);
export const recordMu7Adjudication = (actor: Actor, input: Mu7AdjudicationInput) =>
  core.recordMu7Adjudication(context(actor), input);
export const mu7AdminAction = (actor: Actor, input: Mu7AdminAction) =>
  core.mu7AdminAction(context(actor), input);
export const exportMu7Bundle = (actor: Actor, mode: Mu7Mode) =>
  core.exportMu7Bundle(context(actor), mode);
