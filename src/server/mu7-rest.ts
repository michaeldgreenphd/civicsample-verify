import { finishReview as finishCompletion } from './mu84-completion';
// Review design v7 over PostgREST with the signed-in user's own token (Supabase mode). The same
// service core as the local path (src/server/mu7-core.ts); reads go to the mu7_ tables and views
// under the caller's row-level security and writes to the rpc_mu7_* functions. No service-role key
// exists here, and account locks are recorded only by the privileged identity tool.
import { PostgrestClient } from '../lib/postgrest';
import type {
  Mu7AdjudicationInput,
  Mu7AdminAction,
  Mu7Mode,
  Mu7SubmissionInput,
} from '../lib/mu7-types';
import * as core from './mu7-core';
import * as intake from './formal-intake';
import * as release from './formal-release';
import { ServiceError } from './service';
import { supabaseRuntime, type SessionActor } from './session';
import { appGitSha } from './tlv5';

const IDENT = /^[a-z_][a-z0-9_]*$/;

/** The two operations of the v7 service over a PostgREST client. */
export function mu7RestData(c: Pick<PostgrestClient, 'select' | 'rpc'>): core.Mu7Data {
  return {
    async select<T>(
      relation: string,
      options: { columns?: readonly string[]; eq?: core.Mu7Filter; order?: string[] } = {},
    ) {
      const names = [
        ...(options.columns ?? []),
        ...Object.keys(options.eq ?? {}),
        ...(options.order ?? []),
      ];
      if (names.some((n) => !IDENT.test(n))) throw new ServiceError(500, 'Invalid relation.');
      const parts = [`select=${options.columns?.length ? options.columns.join(',') : '*'}`];
      for (const [k, v] of Object.entries(options.eq ?? {}))
        parts.push(
          v === null
            ? `${k}=is.null`
            : typeof v === 'boolean'
              ? `${k}=is.${v}`
              : `${k}=eq.${encodeURIComponent(String(v))}`,
        );
      if (options.order?.length) parts.push(`order=${options.order.join(',')}`);
      return c.select<T>(relation, parts.join('&'));
    },
    async rpc<T>(fn: string, args: Record<string, unknown>, shape: 'value' | 'rows') {
      const result = await c.rpc<T>(fn, args);
      if (shape === 'rows') return (Array.isArray(result) ? result : []) as T;
      return result;
    },
  };
}

function context(actor: SessionActor): core.Mu7Context {
  if (!actor.accessToken) throw new ServiceError(401, 'Sign in to continue.');
  const client = new PostgrestClient(
    supabaseRuntime().config,
    actor.accessToken,
    core.mu7PublicError,
  );
  const data = mu7RestData(client);
  return {
    role: actor.role as core.Mu7Context['role'],
    withData: (operation) => operation(data),
    appGitSha: appGitSha(),
    syntheticDatabase: false,
  };
}

export const getMu7Workspace = (actor: SessionActor) => core.getMu7Workspace(context(actor));
export const getFormalIntakePlan = (actor: SessionActor) => intake.formalIntakePlan(context(actor));
export const stageFormalSample = (actor: SessionActor, request: unknown) =>
  intake.stageFormalSample(context(actor), request);
export const getFormalReleaseStatus = (actor: SessionActor) =>
  release.formalReleaseStatus(context(actor));
export const recordFormalReleaseAction = (actor: SessionActor, request: unknown) =>
  release.formalReleaseAction(context(actor), request);
export const getMu7ReviewerUnit = (actor: SessionActor, assignmentId: string) =>
  core.getMu7ReviewerUnit(context(actor), assignmentId);
export const submitMu7 = (actor: SessionActor, assignmentId: string, input: Mu7SubmissionInput) =>
  core.submitMu7(context(actor), assignmentId, input);
export const acknowledgeMu7Training = (actor: SessionActor) =>
  core.acknowledgeMu7Training(context(actor));
export const getMu7AdjudicatorUnit = (actor: SessionActor, unitId: string) =>
  core.getMu7AdjudicatorUnit(context(actor), unitId);
export const recordMu7Adjudication = (actor: SessionActor, input: Mu7AdjudicationInput) =>
  core.recordMu7Adjudication(context(actor), input);
export const mu7AdminAction = (actor: SessionActor, input: Mu7AdminAction) =>
  core.mu7AdminAction(context(actor), input);
export const exportMu7Bundle = (actor: SessionActor, mode: Mu7Mode) =>
  core.exportMu7Bundle(context(actor), mode);

export const finishMu7Review = (actor: SessionActor, input: unknown) =>
  finishCompletion(context(actor), input);
