import { z } from 'zod';
import {
  ACCOUNTS,
  assertLocalRequest,
  expiredCookie,
  getActor,
  HttpError,
  login,
  logout,
  requireActor,
  sessionCookie,
} from '@/lib/auth';
import { adminSchema, adjudicationSchema, draftSchema, judgmentSchema } from '@/lib/validation';
import { buildPilotExport } from '@/lib/export';
import { authorSyntheticPilotCase, evaluateApprovalGates } from '@/server/admin-workflows';
import * as service from '@/server/service';
import * as tlv5 from '@/server/tlv5';
import * as mapconf from '@/server/mapconf';
import * as mapconfRest from '@/server/mapconf-rest';
import * as mu7 from '@/server/mu7';
import * as mu7Rest from '@/server/mu7-rest';
import { mu7AdjudicationSchema, mu7AdminSchema, mu7SubmissionSchema } from '@/lib/mu7-validation';
import type { Actor } from '@/lib/types';
import { dataBackend } from '@/lib/supabase-config';
import {
  clearedSessionCookieHeaders,
  sessionCookieHeaders,
  readSessionCookies,
} from '@/lib/supabase-auth';
import { publicActor, resolveSession, supabaseRuntime, type SessionActor } from '@/server/session';
import { mcManifestText } from '@/lib/mapconf-export';
import { MC_RUBRIC, MC_RUBRIC_VERSION, renderMcRubric } from '@/lib/mapconf-types';
import { mcAdjudicationSchema, mcAdminSchema, mcSubmissionSchema } from '@/lib/mapconf-validation';
import { manifestText } from '@/lib/tlv5-export';
import { renderRubric, TLV5_RUBRIC, TLV5_RUBRIC_VERSION } from '@/lib/tlv5-codes';
import {
  tlv5AdjudicationSchema,
  tlv5AdminSchema,
  tlv5SubmissionSchema,
} from '@/lib/tlv5-validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const jsonHeaders = { 'Cache-Control': 'no-store, private', Pragma: 'no-cache' };
function json(
  data: unknown,
  status = 200,
  headers: Record<string, string> = {},
  cookies: string[] = [],
) {
  const response = Response.json(data, { status, headers: { ...jsonHeaders, ...headers } });
  for (const cookie of cookies) response.headers.append('Set-Cookie', cookie);
  return response;
}
const supabase = () => dataBackend() === 'supabase';
/** Mutations must come from the application's own origin: localhost for the local pilot, the
 *  configured site origin for a Supabase deployment. */
function assertRequestOrigin(request: Request, mutation: boolean) {
  if (!supabase()) return assertLocalRequest(request, mutation);
  const { config } = supabaseRuntime();
  if (!mutation) return;
  const origin = request.headers.get('origin');
  if (!origin || origin !== config.siteOrigin)
    throw new HttpError(403, 'Request origin was not accepted. Reload the application.');
}
async function body(request: Request) {
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, 'A JSON body is required.');
  let count = 0;
  const chunks: Uint8Array[] = [];
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    count += next.value.length;
    if (count > 50000) {
      await reader.cancel();
      throw new HttpError(413, 'Request is too large.');
    }
    chunks.push(next.value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'The request must contain valid JSON.');
  }
}
/** Review design v7 (mapping units): the same routes in both deployment modes. Role first, then the
 *  body: a caller without the role is refused whatever it sends. Returns null when no v7 route
 *  matches. FORMAL operations have no route here. */
async function mu7Route(
  request: Request,
  path: string,
  actor: Actor,
  impl: typeof mu7 | typeof mu7Rest,
  respond: (data: unknown) => Response,
): Promise<Response | null> {
  if (!path.startsWith('/api/mu7/')) return null;
  // The two implementations take the same calls; the local one with an Actor, the REST one with
  // the SessionActor that carries the caller's token.
  const api = impl as typeof mu7;
  const requireRole = (role: Actor['role'], what: string) => {
    if (actor.role !== role) throw new HttpError(403, `This action requires ${what}.`);
  };
  if (path === '/api/mu7/workspace' && request.method === 'GET')
    return respond(await api.getMu7Workspace(actor));
  if (path === '/api/mu7/training/acknowledge' && request.method === 'POST') {
    requireRole('REVIEWER', 'a reviewer account');
    return respond(await api.acknowledgeMu7Training(actor));
  }
  const assignment = /^\/api\/mu7\/assignments\/([0-9a-f-]{36})(?:\/(submit))?$/.exec(path);
  if (assignment) {
    requireRole('REVIEWER', 'a reviewer account');
    if (request.method === 'GET' && !assignment[2])
      return respond(await api.getMu7ReviewerUnit(actor, assignment[1]));
    if (request.method === 'POST' && assignment[2] === 'submit')
      return respond(
        await api.submitMu7(actor, assignment[1], mu7SubmissionSchema.parse(await body(request))),
      );
  }
  const unit = /^\/api\/mu7\/adjudication\/((?:SYN7|MU7)-[A-Z0-9_-]{6,60})$/.exec(path);
  if (unit && request.method === 'GET') {
    requireRole('ADJUDICATOR', 'the adjudicator account');
    return respond(await api.getMu7AdjudicatorUnit(actor, unit[1]));
  }
  if (path === '/api/mu7/adjudicate' && request.method === 'POST') {
    requireRole('ADJUDICATOR', 'the adjudicator account');
    return respond(
      await api.recordMu7Adjudication(actor, mu7AdjudicationSchema.parse(await body(request))),
    );
  }
  if (path.startsWith('/api/mu7/admin/')) requireRole('INVESTIGATOR', 'an investigator account');
  if (path === '/api/mu7/admin/action' && request.method === 'POST')
    return respond(await api.mu7AdminAction(actor, mu7AdminSchema.parse(await body(request))));
  const exported = /^\/api\/mu7\/admin\/export\/(PILOT|FORMAL)(?:\/([a-z_]+\.(?:csv|json)))?$/.exec(
    path,
  );
  if (exported && request.method === 'GET') {
    const bundle = await api.exportMu7Bundle(actor, exported[1] as 'PILOT' | 'FORMAL');
    if (!exported[2])
      return respond({
        mode: bundle.mode,
        manifest: bundle.manifest,
        manifestSha256: bundle.manifestSha256,
        files: bundle.files.map((f) => ({
          name: f.name,
          role: f.role,
          rows: f.rows,
          sha256: f.sha256,
        })),
      });
    const file =
      exported[2] === bundle.manifestName
        ? { name: bundle.manifestName, content: bundle.manifestText, type: 'application/json' }
        : bundle.files
            .filter((f) => f.name === exported[2])
            .map((f) => ({ name: f.name, content: f.content, type: 'text/csv' }))[0];
    if (!file) throw new HttpError(404, 'Resource not available.');
    return new Response(file.content, {
      status: 200,
      headers: {
        ...jsonHeaders,
        'Content-Type': `${file.type}; charset=utf-8`,
        'Content-Disposition': `attachment; filename="${bundle.mode.toLowerCase()}-${file.name}"`,
      },
    });
  }
  throw new HttpError(404, 'Resource not available.');
}

async function handle(request: Request) {
  try {
    const mutation = request.method !== 'GET';
    assertRequestOrigin(request, mutation);
    const path = new URL(request.url).pathname.replace(/\/$/, '');
    if (supabase()) {
      const { config, auth } = supabaseRuntime();
      const secure = config.siteOrigin.startsWith('https://');
      if (path === '/api/session' && request.method === 'POST') {
        const input = z
          .object({ username: z.string().min(1).max(80), password: z.string().min(1).max(256) })
          .strict()
          .parse(await body(request));
        const session = await auth.signIn(input.username.trim().toLowerCase(), input.password);
        const cookies = sessionCookieHeaders(session, secure);
        const probe = new Request(request.url, {
          headers: { cookie: cookies.map((c) => c.split(';')[0]).join('; ') },
        });
        const resolved = await resolveSession(probe);
        if (!resolved.actor) {
          await auth.signOut(session.accessToken).catch(() => undefined);
          throw new HttpError(403, 'This account has no active application role.');
        }
        return json(
          { ok: true, user: publicActor(resolved.actor), environment: 'supabase-staging' },
          200,
          {},
          cookies,
        );
      }
      if (path === '/api/session' && request.method === 'DELETE') {
        const cookies = readSessionCookies(request);
        if (cookies.access) await auth.signOut(cookies.access).catch(() => undefined);
        return json({ ok: true }, 200, {}, clearedSessionCookieHeaders(secure));
      }
      const resolved = await resolveSession(request);
      if (path === '/api/session' && request.method === 'GET')
        return json(
          {
            user: resolved.actor ? publicActor(resolved.actor) : null,
            environment: 'supabase-staging',
          },
          200,
          {},
          resolved.setCookies,
        );
      if (!resolved.actor) throw new HttpError(401, 'Sign in to continue.');
      // Awaited inside the try block so a thrown HttpError or ServiceError is mapped below.
      return await withSupabaseActor(request, path, resolved.actor, resolved.setCookies);
    }
    if (path === '/api/session') {
      if (request.method === 'GET') {
        const local = getActor(request);
        return json({
          user: local ? { ...local, aal: 'aal2', mfaEnrolled: false } : null,
          environment: 'synthetic',
        });
      }
      if (request.method === 'DELETE') {
        logout(request);
        return json({ ok: true }, 200, { 'Set-Cookie': expiredCookie() });
      }
      if (request.method === 'POST') {
        const input = z
          .object({ account: z.string().min(1).max(80), password: z.string().min(1).max(256) })
          .strict()
          .parse(await body(request));
        const token = login(input.account, input.password);
        return json(
          { ok: true, user: { ...ACCOUNTS[input.account], aal: 'aal2', mfaEnrolled: false } },
          200,
          {
            'Set-Cookie': sessionCookie(token),
          },
        );
      }
    }
    const actor = requireActor(request);
    if (
      (path.startsWith('/api/admin/') ||
        path.startsWith('/api/tlv5/admin/') ||
        path.startsWith('/api/mc/admin/')) &&
      actor.role !== 'INVESTIGATOR'
    )
      throw new HttpError(403, 'This action requires an investigator account.');
    if (request.method === 'GET' && path === '/api/workspace')
      return json(await service.getWorkspace(actor));
    if (request.method === 'GET' && path === '/api/admin/export') {
      const bundle = buildPilotExport(await service.getExportData(actor));
      return json(bundle, 200, {
        'Content-Disposition': 'attachment; filename="synthetic-pilot-audit.json"',
      });
    }
    if (request.method === 'POST' && path === '/api/admin/action')
      return json(await service.adminAction(actor, adminSchema.parse(await body(request))));
    if (request.method === 'GET' && path === '/api/admin/gates')
      return json(await evaluateApprovalGates(actor));
    if (request.method === 'POST' && path === '/api/admin/cases')
      return json(await authorSyntheticPilotCase(actor, await body(request)));
    // Design v5 (trial-level label verification): separate routes, same session and origin rules.
    if (path === '/api/tlv5/workspace' && request.method === 'GET')
      return json(await tlv5.getTlv5Workspace(actor));
    if (path === '/api/tlv5/rubric' && request.method === 'GET')
      return json({ version: TLV5_RUBRIC_VERSION, sections: TLV5_RUBRIC, text: renderRubric() });
    if (path === '/api/tlv5/adjudicate' && request.method === 'POST')
      return json(
        await tlv5.recordTlv5Adjudication(actor, tlv5AdjudicationSchema.parse(await body(request))),
      );
    if (path === '/api/tlv5/admin/action' && request.method === 'POST')
      return json(await tlv5.tlv5AdminAction(actor, tlv5AdminSchema.parse(await body(request))));
    const exportMatch =
      /^\/api\/tlv5\/admin\/export\/(PILOT|FORMAL)(?:\/([a-z0-9_.]+\.(?:csv|json)))?$/.exec(path);
    if (exportMatch && request.method === 'GET') {
      const bundle = await tlv5.exportTlv5Bundle(actor, exportMatch[1] as 'PILOT' | 'FORMAL');
      if (!exportMatch[2]) return json(bundle);
      const file =
        exportMatch[2] === bundle.manifestName
          ? { name: bundle.manifestName, content: manifestText(bundle), type: 'application/json' }
          : bundle.files
              .filter((f) => f.name === exportMatch[2])
              .map((f) => ({ name: f.name, content: f.content, type: 'text/csv' }))[0];
      if (!file) throw new HttpError(404, 'Resource not available.');
      return new Response(file.content, {
        status: 200,
        headers: {
          ...jsonHeaders,
          'Content-Type': `${file.type}; charset=utf-8`,
          'Content-Disposition': `attachment; filename="${file.name}"`,
        },
      });
    }
    const tlv5Case = /^\/api\/tlv5\/cases\/([A-Za-z0-9][A-Za-z0-9_.:-]{2,80})(?:\/(submit))?$/.exec(
      path,
    );
    if (tlv5Case) {
      const [, id, action] = tlv5Case;
      if (request.method === 'GET' && !action)
        return json(
          actor.role === 'REVIEWER'
            ? await tlv5.getTlv5ReviewerCase(actor, id)
            : await tlv5.getTlv5AdjudicatorCase(actor, id),
        );
      if (request.method === 'POST' && action === 'submit')
        return json(
          await tlv5.submitTlv5(actor, id, tlv5SubmissionSchema.parse(await body(request))),
        );
    }
    // Mapping confirmation (visible existing assignment): separate routes, same session rules.
    if (path === '/api/mc/workspace' && request.method === 'GET')
      return json(await mapconf.getMcWorkspace(actor));
    if (path === '/api/mc/rubric' && request.method === 'GET')
      return json({ version: MC_RUBRIC_VERSION, sections: MC_RUBRIC, text: renderMcRubric() });
    if (path === '/api/mc/adjudicate' && request.method === 'POST')
      return json(
        await mapconf.recordMcAdjudication(actor, mcAdjudicationSchema.parse(await body(request))),
      );
    if (path === '/api/mc/admin/action' && request.method === 'POST')
      return json(await mapconf.mcAdminAction(actor, mcAdminSchema.parse(await body(request))));
    const mcExport = /^\/api\/mc\/admin\/export(?:\/([a-z0-9_.]+\.(?:csv|json)))?$/.exec(path);
    if (mcExport && request.method === 'GET') {
      const bundle = await mapconf.exportMcBundle(actor);
      if (!mcExport[1]) return json(bundle);
      const file =
        mcExport[1] === bundle.manifestName
          ? { name: bundle.manifestName, content: mcManifestText(bundle), type: 'application/json' }
          : bundle.files
              .filter((f) => f.name === mcExport[1])
              .map((f) => ({ name: f.name, content: f.content, type: 'text/csv' }))[0];
      if (!file) throw new HttpError(404, 'Resource not available.');
      return new Response(file.content, {
        status: 200,
        headers: {
          ...jsonHeaders,
          'Content-Type': `${file.type}; charset=utf-8`,
          'Content-Disposition': `attachment; filename="${file.name}"`,
        },
      });
    }
    const mcAssignment = /^\/api\/mc\/assignments\/([0-9a-f-]{36})(?:\/(submit))?$/.exec(path);
    if (mcAssignment) {
      const [, id, action] = mcAssignment;
      if (request.method === 'GET' && !action)
        return json(await mapconf.getMcReviewerCase(actor, id));
      if (request.method === 'POST' && action === 'submit')
        return json(
          await mapconf.submitMc(actor, id, mcSubmissionSchema.parse(await body(request))),
        );
    }
    const mcCase = /^\/api\/mc\/cases\/(MC-[A-Z]{3,4}-[A-Z0-9][A-Z0-9-]{1,40})$/.exec(path);
    if (mcCase && request.method === 'GET')
      return json(await mapconf.getMcAdjudicatorCase(actor, mcCase[1]));
    const v7 = await mu7Route(request, path, actor, mu7, (data) => json(data));
    if (v7) return v7;
    const match = /^\/api\/cases\/(SYN-[0-9]{3})(?:\/(draft|submit|step1|adjudicate))?$/.exec(path);
    if (match) {
      const [, caseId, action] = match;
      if (request.method === 'GET' && !action) return json(await service.getCase(actor, caseId));
      if (request.method === 'POST') {
        const input = await body(request);
        if (action === 'draft')
          return json(await service.saveDraft(actor, caseId, draftSchema.parse(input)));
        if (action === 'submit')
          return json(await service.submitReview(actor, caseId, judgmentSchema.parse(input)));
        if (action === 'step1')
          return json(await service.submitStep1(actor, caseId, judgmentSchema.parse(input)));
        if (action === 'adjudicate')
          return json(await service.adjudicate(actor, caseId, adjudicationSchema.parse(input)));
      }
    }
    throw new HttpError(404, 'Resource not available.');
  } catch (error) {
    if (error instanceof z.ZodError)
      return json({ error: 'Check the required fields and try again.' }, 400);
    if (error instanceof HttpError) return json({ error: error.message }, error.status);
    // Only the service's intentional safe errors may cross this boundary. Never expose SQL/messages.
    if (error instanceof service.ServiceError) return json({ error: error.message }, error.status);
    console.error('verify_request_failed');
    return json(
      {
        error:
          'The request could not be completed. Your submitted records are unchanged. Try again or contact the investigator.',
      },
      500,
    );
  }
}

/** Supabase mode: multi-factor endpoints, the mapping-confirmation routes through PostgREST under
 *  the caller's token, and nothing else (the local synthetic pilot routes are not served). */
async function withSupabaseActor(
  request: Request,
  path: string,
  actor: SessionActor,
  setCookies: string[],
) {
  const { config, auth } = supabaseRuntime();
  const secure = config.siteOrigin.startsWith('https://');
  if (!actor.accessToken) throw new HttpError(401, 'Sign in to continue.');
  if (path === '/api/mfa/enroll' && request.method === 'POST') {
    const enrolment = await auth.enrollTotp(
      actor.accessToken,
      `CivicSample Verify (${actor.displayName})`,
    );
    return json(
      {
        factorId: enrolment.factorId,
        qrCode: enrolment.qrCode,
        qrSvg: enrolment.qrSvg,
        secret: enrolment.secret,
        uri: enrolment.uri,
      },
      200,
      {},
      setCookies,
    );
  }
  if (path === '/api/mfa/verify' && request.method === 'POST') {
    const input = z
      .object({ factorId: z.string().uuid().optional(), code: z.string().regex(/^\d{6}$/) })
      .strict()
      .parse(await body(request));
    // An already-enrolled investigator only supplies the code; the verified factor is looked up
    // here so nobody has to know or type an authenticator id.
    let factorId = input.factorId;
    if (!factorId) {
      const verified = await auth.verify(actor.accessToken);
      factorId = verified.verifiedFactors[0]?.id;
      if (!factorId) throw new HttpError(409, 'Enrol an authenticator app first.');
    }
    const session = await auth.verifyTotp(actor.accessToken, factorId, input.code);
    const cookies = sessionCookieHeaders(session, secure);
    const probe = new Request(request.url, {
      headers: { cookie: cookies.map((c) => c.split(';')[0]).join('; ') },
    });
    const resolved = await resolveSession(probe);
    return json(
      { ok: true, user: resolved.actor ? publicActor(resolved.actor) : null },
      200,
      {},
      cookies,
    );
  }
  if (path.startsWith('/api/mc/admin/') && actor.role !== 'INVESTIGATOR')
    throw new HttpError(403, 'This action requires an investigator account.');
  if (actor.role === 'INVESTIGATOR' && actor.aal !== 'aal2' && path.startsWith('/api/mc/admin/'))
    throw new HttpError(
      403,
      'Investigator actions need a verified authenticator (second factor). Complete multi-factor sign-in first.',
    );
  if (path === '/api/mc/workspace' && request.method === 'GET')
    return json(await mapconfRest.getMcWorkspace(actor), 200, {}, setCookies);
  if (path === '/api/mc/rubric' && request.method === 'GET')
    return json(
      { version: MC_RUBRIC_VERSION, sections: MC_RUBRIC, text: renderMcRubric() },
      200,
      {},
      setCookies,
    );
  if (path === '/api/mc/adjudicate' && request.method === 'POST') {
    // Role before body: a non-adjudicator is refused whatever it sends, not told how to shape it.
    if (actor.role !== 'ADJUDICATOR')
      throw new HttpError(403, 'This action requires the adjudicator account.');
    return json(
      await mapconfRest.recordMcAdjudication(
        actor,
        mcAdjudicationSchema.parse(await body(request)),
      ),
      200,
      {},
      setCookies,
    );
  }
  if (path === '/api/mc/admin/action' && request.method === 'POST')
    return json(
      await mapconfRest.mcAdminAction(actor, mcAdminSchema.parse(await body(request))),
      200,
      {},
      setCookies,
    );
  const mcExport = /^\/api\/mc\/admin\/export(?:\/([a-z0-9_.]+\.(?:csv|json)))?$/.exec(path);
  if (mcExport && request.method === 'GET') {
    const bundle = await mapconfRest.exportMcBundle(actor);
    if (!mcExport[1]) return json(bundle, 200, {}, setCookies);
    const file =
      mcExport[1] === bundle.manifestName
        ? { name: bundle.manifestName, content: mcManifestText(bundle), type: 'application/json' }
        : bundle.files
            .filter((f) => f.name === mcExport[1])
            .map((f) => ({ name: f.name, content: f.content, type: 'text/csv' }))[0];
    if (!file) throw new HttpError(404, 'Resource not available.');
    return new Response(file.content, {
      status: 200,
      headers: {
        ...jsonHeaders,
        'Content-Type': `${file.type}; charset=utf-8`,
        'Content-Disposition': `attachment; filename="${file.name}"`,
      },
    });
  }
  const mcAssignment = /^\/api\/mc\/assignments\/([0-9a-f-]{36})(?:\/(submit))?$/.exec(path);
  if (mcAssignment) {
    const [, id, action] = mcAssignment;
    if (request.method === 'GET' && !action)
      return json(await mapconfRest.getMcReviewerCase(actor, id), 200, {}, setCookies);
    if (request.method === 'POST' && action === 'submit')
      return json(
        await mapconfRest.submitMc(actor, id, mcSubmissionSchema.parse(await body(request))),
        200,
        {},
        setCookies,
      );
  }
  const mcCase = /^\/api\/mc\/cases\/(MC-[A-Z]{3,4}-[A-Z0-9][A-Z0-9-]{1,40})$/.exec(path);
  if (mcCase && request.method === 'GET')
    return json(await mapconfRest.getMcAdjudicatorCase(actor, mcCase[1]), 200, {}, setCookies);
  if (path.startsWith('/api/mu7/admin/') && actor.role === 'INVESTIGATOR' && actor.aal !== 'aal2')
    throw new HttpError(
      403,
      'Investigator actions need a verified authenticator (second factor). Complete multi-factor sign-in first.',
    );
  const v7 = await mu7Route(request, path, actor, mu7Rest, (data) =>
    json(data, 200, {}, setCookies),
  );
  if (v7) return v7;
  if (/^\/api\/(workspace|tlv5|cases|admin)(\/|$)/.test(path))
    throw new HttpError(
      503,
      'This workflow is not served in the Supabase deployment mode; only the mapping-confirmation review is connected.',
    );
  throw new HttpError(404, 'Resource not available.');
}
export const GET = handle;
export const POST = handle;
export const DELETE = handle;
