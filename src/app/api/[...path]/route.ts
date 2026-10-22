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
function json(data: unknown, status = 200, headers: Record<string, string> = {}) {
  return Response.json(data, { status, headers: { ...jsonHeaders, ...headers } });
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
async function handle(request: Request) {
  try {
    const mutation = request.method !== 'GET';
    assertLocalRequest(request, mutation);
    const path = new URL(request.url).pathname.replace(/\/$/, '');
    if (path === '/api/session') {
      if (request.method === 'GET')
        return json({ user: getActor(request), environment: 'synthetic' });
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
        return json({ ok: true, user: ACCOUNTS[input.account] }, 200, {
          'Set-Cookie': sessionCookie(token),
        });
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
export const GET = handle;
export const POST = handle;
export const DELETE = handle;
