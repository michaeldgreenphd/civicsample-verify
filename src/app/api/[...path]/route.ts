import { z } from 'zod';
import { ACCOUNTS, assertLocalRequest, expiredCookie, getActor, HttpError, login, logout, requireActor, sessionCookie } from '@/lib/auth';
import { adminSchema, adjudicationSchema, draftSchema, judgmentSchema } from '@/lib/validation';
import { buildPilotExport } from '@/lib/export';
import * as service from '@/server/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const jsonHeaders = { 'Cache-Control': 'no-store, private', 'Pragma': 'no-cache' };
function json(data: unknown, status = 200, headers: Record<string,string> = {}) { return Response.json(data, { status, headers: { ...jsonHeaders, ...headers } }); }
async function body(request: Request) {
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, 'A JSON body is required.');
  let count = 0; const chunks: Uint8Array[] = [];
  while (true) {
    const next = await reader.read(); if (next.done) break;
    count += next.value.length;
    if (count > 50000) { await reader.cancel(); throw new HttpError(413, 'Request is too large.'); }
    chunks.push(next.value);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new HttpError(400, 'The request must contain valid JSON.'); }
}
async function handle(request: Request) {
  try {
    const mutation = request.method !== 'GET';
    assertLocalRequest(request, mutation);
    const path = new URL(request.url).pathname.replace(/\/$/, '');
    if (path === '/api/session') {
      if (request.method === 'GET') return json({user: getActor(request), environment: 'synthetic'});
      if (request.method === 'DELETE') { logout(request); return json({ok:true},200,{'Set-Cookie':expiredCookie()}); }
      if (request.method === 'POST') {
        const input = z.object({account:z.string().min(1).max(80),password:z.string().min(1).max(256)}).strict().parse(await body(request));
        const token = login(input.account,input.password);
        return json({ok:true,user:ACCOUNTS[input.account]},200,{'Set-Cookie':sessionCookie(token)});
      }
    }
    const actor = requireActor(request);
    if (path.startsWith('/api/admin/') && actor.role !== 'INVESTIGATOR') throw new HttpError(403, 'This action requires an investigator account.');
    if (request.method === 'GET' && path === '/api/workspace') return json(await service.getWorkspace(actor));
    if (request.method === 'GET' && path === '/api/admin/export') {
      const bundle = buildPilotExport(await service.getExportData(actor));
      return json(bundle,200,{'Content-Disposition':'attachment; filename="synthetic-pilot-audit.json"'});
    }
    if (request.method === 'POST' && path === '/api/admin/action') return json(await service.adminAction(actor,adminSchema.parse(await body(request))));
    const match = /^\/api\/cases\/(SYN-[0-9]{3})(?:\/(draft|submit|step1|adjudicate))?$/.exec(path);
    if (match) {
      const [,caseId,action] = match;
      if (request.method === 'GET' && !action) return json(await service.getCase(actor,caseId));
      if (request.method === 'POST') {
        const input = await body(request);
        if (action === 'draft') return json(await service.saveDraft(actor,caseId,draftSchema.parse(input)));
        if (action === 'submit') return json(await service.submitReview(actor,caseId,judgmentSchema.parse(input)));
        if (action === 'step1') return json(await service.submitStep1(actor,caseId,judgmentSchema.parse(input)));
        if (action === 'adjudicate') return json(await service.adjudicate(actor,caseId,adjudicationSchema.parse(input)));
      }
    }
    throw new HttpError(404,'Resource not available.');
  } catch (error) {
    if (error instanceof z.ZodError) return json({error:'Check the required fields and try again.'},400);
    if (error instanceof HttpError) return json({error:error.message},error.status);
    // Only the service's intentional safe errors may cross this boundary. Never expose SQL/messages.
    if (error instanceof service.ServiceError) return json({error:error.message},error.status);
    console.error('verify_request_failed');
    return json({error:'The request could not be completed. Your submitted records are unchanged. Try again or contact the investigator.'},500);
  }
}
export const GET = handle;
export const POST = handle;
export const DELETE = handle;
