import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Actor } from './types';

export const COOKIE_NAME = 'verify_session';
const MAX_AGE = 8 * 60 * 60 * 1000;
const PASSWORD_VARIABLES: Record<string, string> = {
  investigator: 'VERIFY_INVESTIGATOR_PASSWORD',
  'reviewer-a': 'VERIFY_REVIEWER_A_PASSWORD',
  'reviewer-b': 'VERIFY_REVIEWER_B_PASSWORD',
  adjudicator: 'VERIFY_ADJUDICATOR_PASSWORD',
};
export const ACCOUNTS: Record<string, Actor> = {
  investigator: {
    id: '00000000-0000-4000-8000-000000000001',
    role: 'INVESTIGATOR',
    displayName: 'Synthetic investigator',
  },
  'reviewer-a': {
    id: '00000000-0000-4000-8000-000000000002',
    role: 'REVIEWER',
    displayName: 'Synthetic reviewer A',
  },
  'reviewer-b': {
    id: '00000000-0000-4000-8000-000000000003',
    role: 'REVIEWER',
    displayName: 'Synthetic reviewer B',
  },
  adjudicator: {
    id: '00000000-0000-4000-8000-000000000004',
    role: 'ADJUDICATOR',
    displayName: 'Synthetic adjudicator',
  },
};

export interface InvitedAccountRecord {
  userId: string;
  email: string;
  displayName: string;
  role: Actor['role'];
  inviteTokenHash: string;
  invitedBy: string;
  expiresAt: number;
  claimedAt?: number;
  revokedAt?: number;
  activeSessionId?: string;
  mfaRequired: boolean;
}

export interface VerifiedJwtClaims {
  sub: string;
  email?: string;
  aal: 'aal1' | 'aal2';
  exp: number;
  iat?: number;
  sessionId?: string;
  role: 'authenticated';
}

const globals = globalThis as typeof globalThis & {
  verifySessions?: Map<string, { actor: Actor; expires: number; sessionId?: string }>;
  verifyAttempts?: { count: number; until: number };
  verifyInvites?: Map<string, InvitedAccountRecord>;
  verifyRevokedUsers?: Set<string>;
  verifyEverRevokedUsers?: Set<string>;
  verifyRevokedSessionIds?: Set<string>;
};
const sessions = (globals.verifySessions ??= new Map());
const invites = (globals.verifyInvites ??= new Map());
const revokedUsers = (globals.verifyRevokedUsers ??= new Set());
const everRevokedUsers = (globals.verifyEverRevokedUsers ??= new Set());
const revokedSessionIds = (globals.verifyRevokedSessionIds ??= new Set());
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export function assertLocalRequest(request: Request, mutation = false) {
  const host = request.headers.get('host') ?? '';
  if (!/^(127\.0\.0\.1|localhost|\[::1\])(:[0-9]{1,5})?$/.test(host)) {
    throw new HttpError(403, 'The synthetic pilot is available on localhost only.');
  }
  if (mutation) {
    const origin = request.headers.get('origin');
    if (!origin || origin !== `http://${host}`)
      throw new HttpError(403, 'Request origin was not accepted. Reload the local application.');
  }
}
function tokenFrom(request: Request) {
  return request.headers
    .get('cookie')
    ?.split(';')
    .map((p) => p.trim())
    .find((p) => p.startsWith(`${COOKIE_NAME}=`))
    ?.slice(COOKIE_NAME.length + 1);
}
export function getActor(request: Request): Actor | null {
  const token = tokenFrom(request);
  if (!token) return null;
  const entry = sessions.get(token);
  const invite = entry && invites.get(entry.actor.id);
  const replacedSession = Boolean(
    entry?.sessionId &&
    (revokedSessionIds.has(entry.sessionId) ||
      !invite ||
      invite.revokedAt !== undefined ||
      invite.claimedAt === undefined ||
      invite.activeSessionId !== entry.sessionId),
  );
  if (
    !entry ||
    entry.expires <= Date.now() ||
    revokedUsers.has(entry.actor.id) ||
    replacedSession
  ) {
    sessions.delete(token);
    return null;
  }
  return { ...entry.actor };
}
export function requireActor(request: Request): Actor {
  const actor = getActor(request);
  if (!actor) throw new HttpError(401, 'Sign in to continue.');
  return actor;
}
export function login(account: string, password: string): string {
  const now = Date.now();
  if (!globals.verifyAttempts || globals.verifyAttempts.until <= now)
    globals.verifyAttempts = { count: 0, until: now + 15 * 60 * 1000 };
  if (globals.verifyAttempts.count >= 40)
    throw new HttpError(429, 'Too many sign-in attempts. Try again in 15 minutes.');
  if (!Object.hasOwn(ACCOUNTS, account)) {
    globals.verifyAttempts.count += 1;
    throw new HttpError(401, 'Account or password was not accepted.');
  }
  // Existing pilots retain their legacy password until individually configured.
  // Once any role password is configured, missing roles fail closed: no shared fallback.
  const individualPasswords = Object.values(PASSWORD_VARIABLES).some((key) =>
    Boolean(process.env[key]),
  );
  const expected = individualPasswords
    ? process.env[PASSWORD_VARIABLES[account]]
    : process.env.VERIFY_DEMO_PASSWORD;
  if (!expected || expected.length < 16)
    throw new HttpError(
      503,
      'Run npm run setup -- --individual-credentials, then restart the server to configure local role passwords.',
    );
  const matches = timingSafeEqual(
    createHash('sha256').update(password).digest(),
    createHash('sha256').update(expected).digest(),
  );
  if (!Object.hasOwn(ACCOUNTS, account) || !matches || revokedUsers.has(ACCOUNTS[account].id)) {
    globals.verifyAttempts.count += 1;
    throw new HttpError(401, 'Account or password was not accepted.');
  }
  for (const [token, session] of sessions) if (session.expires <= now) sessions.delete(token);
  if (sessions.size > 100)
    throw new HttpError(429, 'Too many active local sessions. Restart the pilot server.');
  const token = randomBytes(32).toString('hex');
  sessions.set(token, { actor: { ...ACCOUNTS[account] }, expires: now + MAX_AGE });
  return token;
}
export function logout(request: Request) {
  const token = tokenFrom(request);
  if (token) sessions.delete(token);
}
export function sessionCookie(token: string) {
  return `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${MAX_AGE / 1000}`;
}
export function expiredCookie() {
  return `${COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;
}

/**
 * SYNTHETIC TEST SCAFFOLDING ONLY.
 *
 * The helpers below (`issueSyntheticInvite`, `claimInvitedSession`, `signSyntheticJwt`,
 * `verifySignedJwtClaims`, `revokeActorSessions`) exercise invitation, claim, session-ID,
 * assurance-level (`aal1`/`aal2`), and revocation state transitions in local synthetic tests.
 * They do NOT implement TOTP enrollment, cryptographic MFA verification, or a production
 * identity provider. Production authentication must remain behind a verified external
 * identity-provider boundary (e.g., Supabase Auth with verified TOTP MFA).
 */
export function issueSyntheticInvite(
  issuer: Actor,
  input: {
    userId: string;
    email: string;
    displayName: string;
    role: Actor['role'];
    ttlMs?: number;
    mfaRequired?: boolean;
  },
): { inviteToken: string; record: InvitedAccountRecord } {
  if (issuer.role !== 'INVESTIGATOR') {
    throw new HttpError(403, 'Only an investigator may issue account invitations.');
  }
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.userId)
  ) {
    throw new HttpError(400, 'Invited account userId must be a valid UUID.');
  }
  if (!/^[a-z0-9._%+-]+@(?:example|synthetic)\.invalid$/i.test(input.email)) {
    throw new HttpError(
      400,
      'Only synthetic @example.invalid or @synthetic.invalid addresses may be invited during the build phase.',
    );
  }
  if (!input.displayName.trim() || input.displayName.trim().length > 120) {
    throw new HttpError(400, 'Display name is required.');
  }
  const previous = invites.get(input.userId);
  if (previous?.activeSessionId) {
    revokedSessionIds.add(previous.activeSessionId);
  }
  const inviteToken = randomBytes(32).toString('hex');
  const inviteTokenHash = createHash('sha256').update(inviteToken).digest('hex');
  const mfaRequired = input.role === 'INVESTIGATOR' ? true : (input.mfaRequired ?? true);
  const record: InvitedAccountRecord = {
    userId: input.userId,
    email: input.email.toLowerCase(),
    displayName: input.displayName.trim(),
    role: input.role,
    inviteTokenHash,
    invitedBy: issuer.id,
    expiresAt: Date.now() + (input.ttlMs ?? 24 * 60 * 60 * 1000),
    mfaRequired,
  };
  invites.set(input.userId, record);
  return { inviteToken, record: { ...record } };
}

/**
 * Synthetic test helper to claim an invited account token.
 * Does NOT default to `aal2`: callers must explicitly pass the assurance level verified
 * by an external identity provider (defaulting to `'aal1'` when omitted).
 */
export function claimInvitedSession(
  userId: string,
  inviteToken: string,
  options: { aal?: 'aal1' | 'aal2' } = {},
): { sessionToken: string; actor: Actor; claims: VerifiedJwtClaims } {
  const now = Date.now();
  const invite = invites.get(userId);
  if (!invite || invite.revokedAt !== undefined) {
    throw new HttpError(401, 'Invitation is invalid or has been revoked.');
  }
  if (invite.claimedAt !== undefined) {
    throw new HttpError(401, 'Invitation has already been claimed.');
  }
  if (invite.expiresAt <= now) {
    throw new HttpError(401, 'Invitation has expired.');
  }
  const suppliedHash = createHash('sha256').update(inviteToken).digest();
  const expectedHash = Buffer.from(invite.inviteTokenHash, 'hex');
  if (suppliedHash.length !== expectedHash.length || !timingSafeEqual(suppliedHash, expectedHash)) {
    throw new HttpError(401, 'Invitation token was not accepted.');
  }
  const aal: 'aal1' | 'aal2' = options.aal ?? 'aal1';
  if (invite.mfaRequired && aal !== 'aal2') {
    throw new HttpError(403, 'Multi-factor authentication (aal2) is required to claim this role.');
  }
  const sessionToken = randomBytes(32).toString('hex');
  const sessionId = randomBytes(16).toString('hex');
  invite.claimedAt = now;
  invite.activeSessionId = sessionId;
  revokedUsers.delete(userId);
  const actor: Actor = {
    id: invite.userId,
    role: invite.role,
    displayName: invite.displayName,
  };
  const expires = now + MAX_AGE;
  sessions.set(sessionToken, { actor, expires, sessionId });
  return {
    sessionToken,
    actor: { ...actor },
    claims: {
      sub: actor.id,
      email: invite.email,
      aal,
      iat: Math.floor(now / 1000),
      exp: Math.floor(expires / 1000),
      sessionId,
      role: 'authenticated',
    },
  };
}

/**
 * Synthetic test helper to sign HS256 JWT tokens shaped like Supabase `request.jwt.claims`.
 */
export function signSyntheticJwt(claims: VerifiedJwtClaims, secret: string): string {
  if (!secret || secret.length < 16) {
    throw new Error('JWT signing secret must be at least 16 characters');
  }
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const signingInput = `${header}.${payload}`;
  const signature = createHmac('sha256', secret).update(signingInput).digest('base64url');
  return `${signingInput}.${signature}`;
}

export function verifySignedJwtClaims(
  jwtToken: string,
  secret: string,
  options: { requireMfaForInvestigator?: boolean } = {},
): { actor: Actor; claims: VerifiedJwtClaims } {
  if (!secret || secret.length < 16) {
    throw new HttpError(503, 'JWT verification secret is not configured.');
  }
  const parts = jwtToken.split('.');
  if (parts.length !== 3) {
    throw new HttpError(401, 'Malformed JWT token.');
  }
  const [headerB64, payloadB64, sigB64] = parts;
  let header: { alg?: string; typ?: string };
  let payload: Record<string, unknown>;
  try {
    header = JSON.parse(Buffer.from(headerB64, 'base64url').toString('utf8'));
    payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  } catch {
    throw new HttpError(401, 'Invalid JWT encoding.');
  }
  if (header.alg !== 'HS256') {
    throw new HttpError(401, 'Unsupported JWT algorithm.');
  }
  const expectedSig = createHmac('sha256', secret).update(`${headerB64}.${payloadB64}`).digest();
  const actualSig = Buffer.from(sigB64, 'base64url');
  if (actualSig.length !== expectedSig.length || !timingSafeEqual(actualSig, expectedSig)) {
    throw new HttpError(401, 'JWT signature verification failed.');
  }
  const nowSec = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== 'number' || payload.exp <= nowSec) {
    throw new HttpError(401, 'JWT token has expired.');
  }
  if (typeof payload.sub !== 'string' || !payload.sub) {
    throw new HttpError(401, 'JWT sub claim is required.');
  }
  const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : undefined;
  if (sessionId && revokedSessionIds.has(sessionId)) {
    throw new HttpError(401, 'User session has been revoked.');
  }
  if (revokedUsers.has(payload.sub)) {
    throw new HttpError(401, 'User session has been revoked.');
  }
  const invited = invites.get(payload.sub);
  const knownDemo = Object.values(ACCOUNTS).find((a) => a.id === payload.sub);
  let actor: Actor | null = null;
  if (invited) {
    if (
      invited.claimedAt === undefined ||
      invited.revokedAt !== undefined ||
      !invited.activeSessionId ||
      sessionId !== invited.activeSessionId
    ) {
      throw new HttpError(401, 'User session has been revoked.');
    }
    actor = { id: invited.userId, role: invited.role, displayName: invited.displayName };
  } else if (knownDemo) {
    if (everRevokedUsers.has(payload.sub)) {
      throw new HttpError(401, 'User session has been revoked.');
    }
    actor = { ...knownDemo };
  }
  if (!actor) {
    throw new HttpError(401, 'JWT subject is not an enrolled account.');
  }
  const aal: 'aal1' | 'aal2' = payload.aal === 'aal2' ? 'aal2' : 'aal1';
  const requireMfa = options.requireMfaForInvestigator ?? true;
  if (actor.role === 'INVESTIGATOR' && requireMfa && aal !== 'aal2') {
    throw new HttpError(403, 'Investigator actions require an MFA-verified (aal2) session.');
  }
  if (invited?.mfaRequired && aal !== 'aal2') {
    throw new HttpError(403, 'Multi-factor authentication (aal2) is required for this account.');
  }
  return {
    actor,
    claims: {
      sub: actor.id,
      email: typeof payload.email === 'string' ? payload.email : invited?.email,
      aal,
      exp: payload.exp,
      iat: typeof payload.iat === 'number' ? payload.iat : undefined,
      sessionId,
      role: 'authenticated',
    },
  };
}

/**
 * Revoke all active sessions and invitations for a user ID. Immediately blocks both cookie
 * sessions and previously issued JWT tokens for that subject, even if the user is later re-invited.
 */
export function revokeActorSessions(targetUserId: string, revokedBy: Actor): number {
  if (revokedBy.role !== 'INVESTIGATOR') {
    throw new HttpError(403, 'Only an investigator may revoke user sessions.');
  }
  revokedUsers.add(targetUserId);
  everRevokedUsers.add(targetUserId);
  const invite = invites.get(targetUserId);
  if (invite) {
    invite.revokedAt = Date.now();
    if (invite.activeSessionId) {
      revokedSessionIds.add(invite.activeSessionId);
      invite.activeSessionId = undefined;
    }
  }
  let removed = 0;
  for (const [token, session] of sessions) {
    if (session.actor.id === targetUserId) {
      if (session.sessionId) {
        revokedSessionIds.add(session.sessionId);
      }
      sessions.delete(token);
      removed += 1;
    }
  }
  return removed;
}

export function resetInvitedAuthStateForTests(): void {
  invites.clear();
  revokedUsers.clear();
  everRevokedUsers.clear();
  revokedSessionIds.clear();
  sessions.clear();
}
