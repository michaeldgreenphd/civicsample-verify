import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Actor } from './types';

export const COOKIE_NAME = 'verify_session';
const MAX_AGE = 8 * 60 * 60 * 1000;
export const ACCOUNTS: Record<string, Actor> = {
  investigator: { id: '00000000-0000-4000-8000-000000000001', role: 'INVESTIGATOR', displayName: 'Synthetic investigator' },
  'reviewer-a': { id: '00000000-0000-4000-8000-000000000002', role: 'REVIEWER', displayName: 'Synthetic reviewer A' },
  'reviewer-b': { id: '00000000-0000-4000-8000-000000000003', role: 'REVIEWER', displayName: 'Synthetic reviewer B' },
  adjudicator: { id: '00000000-0000-4000-8000-000000000004', role: 'ADJUDICATOR', displayName: 'Synthetic adjudicator' },
};
const globals = globalThis as typeof globalThis & {
  verifySessions?: Map<string, { actor: Actor; expires: number }>;
  verifyAttempts?: { count: number; until: number };
};
const sessions = globals.verifySessions ??= new Map();
export class HttpError extends Error { constructor(public status: number, message: string) { super(message); } }

export function assertLocalRequest(request: Request, mutation = false) {
  const host = request.headers.get('host') ?? '';
  if (!/^(127\.0\.0\.1|localhost|\[::1\])(:[0-9]{1,5})?$/.test(host)) {
    throw new HttpError(403, 'The synthetic pilot is available on localhost only.');
  }
  if (mutation) {
    const origin = request.headers.get('origin');
    if (!origin || origin !== `http://${host}`) throw new HttpError(403, 'Request origin was not accepted. Reload the local application.');
  }
}
function tokenFrom(request: Request) {
  return request.headers.get('cookie')?.split(';').map(p => p.trim()).find(p => p.startsWith(`${COOKIE_NAME}=`))?.slice(COOKIE_NAME.length + 1);
}
export function getActor(request: Request): Actor | null {
  const token = tokenFrom(request);
  if (!token) return null;
  const entry = sessions.get(token);
  if (!entry || entry.expires <= Date.now()) { sessions.delete(token); return null; }
  return { ...entry.actor };
}
export function requireActor(request: Request): Actor {
  const actor = getActor(request);
  if (!actor) throw new HttpError(401, 'Sign in to continue.');
  return actor;
}
export function login(account: string, password: string): string {
  const now = Date.now();
  if (!globals.verifyAttempts || globals.verifyAttempts.until <= now) globals.verifyAttempts = { count: 0, until: now + 15 * 60 * 1000 };
  if (globals.verifyAttempts.count >= 40) throw new HttpError(429, 'Too many sign-in attempts. Try again in 15 minutes.');
  const expected = process.env.VERIFY_DEMO_PASSWORD;
  if (!expected || expected.length < 16) throw new HttpError(503, 'Run npm run setup, then restart the server to configure the local pilot password.');
  const matches = timingSafeEqual(createHash('sha256').update(password).digest(), createHash('sha256').update(expected).digest());
  if (!Object.hasOwn(ACCOUNTS, account) || !matches) { globals.verifyAttempts.count += 1; throw new HttpError(401, 'Account or password was not accepted.'); }
  for (const [token, session] of sessions) if (session.expires <= now) sessions.delete(token);
  if (sessions.size > 100) throw new HttpError(429, 'Too many active local sessions. Restart the pilot server.');
  const token = randomBytes(32).toString('hex');
  sessions.set(token, { actor: { ...ACCOUNTS[account] }, expires: now + MAX_AGE });
  return token;
}
export function logout(request: Request) { const token = tokenFrom(request); if (token) sessions.delete(token); }
export function sessionCookie(token: string) { return `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${MAX_AGE / 1000}`; }
export function expiredCookie() { return `${COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`; }
