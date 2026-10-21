import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertLocalRequest, login, getActor, logout, sessionCookie, HttpError } from '../src/lib/auth';
import { judgmentSchema, adjudicationSchema } from '../src/lib/validation';

test('local auth rejects public hosts and cross-origin mutations', () => {
  assert.throws(() => assertLocalRequest(new Request('http://example.test/api/session',{headers:{host:'example.test'}})),HttpError);
  assert.throws(() => assertLocalRequest(new Request('http://localhost:3000/api/session',{headers:{host:'localhost:3000',origin:'http://evil.test'}}),true),HttpError);
  assert.throws(() => assertLocalRequest(new Request('http://localhost:3000/api/session',{headers:{host:'localhost:3000'}}),true),HttpError);
  assert.doesNotThrow(() => assertLocalRequest(new Request('http://localhost:3000/api/session',{headers:{host:'localhost:3000',origin:'http://localhost:3000'}}),true));
});
test('opaque sessions authenticate known synthetic accounts and revoke on logout', () => {
  process.env.VERIFY_DEMO_PASSWORD = 'test-only-long-local-passphrase';
  assert.throws(() => login('reviewer-a','wrong'),HttpError);
  assert.throws(() => login('toString',process.env.VERIFY_DEMO_PASSWORD!),HttpError);
  const token=login('reviewer-a',process.env.VERIFY_DEMO_PASSWORD);
  const request=new Request('http://localhost/api/session',{headers:{cookie:sessionCookie(token)}});
  assert.equal(getActor(request)?.role,'REVIEWER');
  assert.equal(getActor(new Request('http://localhost/api/session',{headers:{cookie:'verify_session=forged'}})),null);
  assert.match(sessionCookie(token),/HttpOnly; SameSite=Strict/);
  logout(request); assert.equal(getActor(request),null);
});
test('final answers require rationale; hidden fields and absent context are rejected', () => {
  const input={decision:'INCLUDE',rationale:'Synthetic rationale',uncertain:false,context:'',packetProblem:false};
  assert.equal(judgmentSchema.safeParse(input).success,true);
  assert.equal(judgmentSchema.safeParse({...input,rationale:'   '}).success,false);
  assert.equal(judgmentSchema.safeParse({...input,tier0:'INCLUDE'}).success,false);
  assert.equal(judgmentSchema.safeParse({...input,decision:'CONTEXT_DEPENDENT'}).success,false);
  assert.equal(judgmentSchema.safeParse({...input,decision:null}).success,false);
  assert.equal(judgmentSchema.safeParse({...input,decision:'CONTEXT_DEPENDENT',context:'x'}).success,false);
  assert.equal(judgmentSchema.safeParse({...input,decision:'CONTEXT_DEPENDENT',context:JSON.stringify({clinicalContext:'Fictional trial',inclusionConditions:'Primary condition',exclusionConditions:'Outcome only'})}).success,true);
});
test('unresolved adjudication remains distinct from an insufficient-information answer', () => {
  const input={decision:null,rationale:'Cannot resolve from fictional packet.',uncertain:true,context:'',packetProblem:true,status:'UNRESOLVED_ESCALATED',basis:'Packet',reasonCode:'PACKET_INSUFFICIENT'};
  assert.equal(adjudicationSchema.safeParse(input).success,true);
  assert.equal(adjudicationSchema.safeParse({...input,decision:'INSUFFICIENT_INFORMATION'}).success,false);
  assert.equal(adjudicationSchema.safeParse({...input,decision:'INSUFFICIENT_INFORMATION',status:'RESOLVED'}).success,true);
});
