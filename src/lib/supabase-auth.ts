// Supabase Auth from the server (GoTrue REST), with verified cookie sessions. Usernames map to the
// internal never-deliverable addresses the admin tool provisions; the browser never holds a
// Supabase token (HttpOnly cookies), and every request verifies the access token with Auth
// (GET /auth/v1/user) before trusting its claims. Refresh happens server-side.
import type { SupabaseWebConfig } from './supabase-config';
import { HttpError } from './auth';

export const ACCESS_COOKIE = 'verify_sb_access';
export const REFRESH_COOKIE = 'verify_sb_refresh';
export const REFRESH_MAX_AGE = 7 * 24 * 60 * 60;
export const USERNAME = /^[a-z][a-z0-9._-]{2,31}$/;

export interface SupabaseSession {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // unix seconds
}
export interface VerifiedUser {
  authUid: string;
  email: string;
  aal: 'aal1' | 'aal2';
  exp: number;
  sessionId: string | null;
  verifiedFactors: { id: string; friendlyName: string | null }[];
  unverifiedFactors: { id: string; friendlyName: string | null }[];
}
export interface TotpEnrollment {
  factorId: string;
  qrCode: string; // data: URI (SVG) from Auth
  secret: string;
  uri: string;
}

export const internalEmail = (username: string, ref: string) =>
  `${username}@${ref}.accounts.invalid`;

function decodeClaims(token: string): Record<string, unknown> {
  const parts = token.split('.');
  if (parts.length !== 3) throw new HttpError(401, 'Sign in to continue.');
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString()) as Record<string, unknown>;
  } catch {
    throw new HttpError(401, 'Sign in to continue.');
  }
}

export class SupabaseAuth {
  private readonly cache = new Map<string, { user: VerifiedUser; until: number }>();
  constructor(
    private readonly config: SupabaseWebConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async call<T>(
    path: string,
    init: { method: string; body?: unknown; token?: string },
  ): Promise<{ status: number; body: T | null }> {
    const url = new URL(path, this.config.url);
    if (url.origin !== new URL(this.config.url).origin)
      throw new HttpError(500, 'Auth origin mismatch.');
    const headers: Record<string, string> = {
      apikey: this.config.publishableKey,
      Accept: 'application/json',
    };
    if (init.body !== undefined) headers['Content-Type'] = 'application/json';
    if (init.token) headers.Authorization = `Bearer ${init.token}`;
    const response = await this.fetchImpl(url.href, {
      method: init.method,
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      redirect: 'error',
      cache: 'no-store',
      signal: AbortSignal.timeout(15000),
    });
    const text = await response.text();
    let body: T | null = null;
    if (text) {
      try {
        body = JSON.parse(text) as T;
      } catch {
        body = null;
      }
    }
    return { status: response.status, body };
  }

  private toSession(
    body: {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      expires_at?: number;
    } | null,
  ): SupabaseSession {
    if (!body?.access_token || !body.refresh_token)
      throw new HttpError(502, 'The identity service returned an unexpected response.');
    const expiresAt = body.expires_at ?? Math.floor(Date.now() / 1000) + (body.expires_in ?? 3600);
    return { accessToken: body.access_token, refreshToken: body.refresh_token, expiresAt };
  }

  /** Username + password through Supabase Auth; the username is mapped, never echoed. */
  async signIn(username: string, password: string): Promise<SupabaseSession> {
    if (!USERNAME.test(username) || !password || password.length > 256)
      throw new HttpError(401, 'Account or password was not accepted.');
    const result = await this.call<{
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      expires_at?: number;
    }>('/auth/v1/token?grant_type=password', {
      method: 'POST',
      body: { email: internalEmail(username, this.config.accountDomainRef), password },
    });
    if (result.status === 429)
      throw new HttpError(429, 'Too many sign-in attempts. Try again later.');
    if (result.status === 400 || result.status === 401 || result.status === 403)
      throw new HttpError(401, 'Account or password was not accepted.');
    if (result.status !== 200) throw new HttpError(502, 'The identity service is unavailable.');
    return this.toSession(result.body);
  }

  async refresh(refreshToken: string): Promise<SupabaseSession> {
    const result = await this.call<{
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      expires_at?: number;
    }>('/auth/v1/token?grant_type=refresh_token', {
      method: 'POST',
      body: { refresh_token: refreshToken },
    });
    if (result.status !== 200) throw new HttpError(401, 'Sign in to continue.');
    return this.toSession(result.body);
  }

  /** Verify an access token with Auth and read its claims; cached for 30 seconds per token. */
  async verify(accessToken: string): Promise<VerifiedUser> {
    const cached = this.cache.get(accessToken);
    if (cached && cached.until > Date.now()) return cached.user;
    const result = await this.call<{
      id?: string;
      email?: string;
      factors?: { id: string; status: string; friendly_name?: string | null }[];
    }>('/auth/v1/user', { method: 'GET', token: accessToken });
    if (result.status !== 200 || !result.body?.id) throw new HttpError(401, 'Sign in to continue.');
    const claims = decodeClaims(accessToken);
    if (claims.sub !== result.body.id) throw new HttpError(401, 'Sign in to continue.');
    const factors = result.body.factors ?? [];
    const user: VerifiedUser = {
      authUid: result.body.id,
      email: result.body.email ?? '',
      aal: claims.aal === 'aal2' ? 'aal2' : 'aal1',
      exp: typeof claims.exp === 'number' ? claims.exp : 0,
      sessionId: typeof claims.session_id === 'string' ? claims.session_id : null,
      verifiedFactors: factors
        .filter((f) => f.status === 'verified')
        .map((f) => ({ id: f.id, friendlyName: f.friendly_name ?? null })),
      unverifiedFactors: factors
        .filter((f) => f.status !== 'verified')
        .map((f) => ({ id: f.id, friendlyName: f.friendly_name ?? null })),
    };
    this.cache.set(accessToken, { user, until: Date.now() + 30_000 });
    if (this.cache.size > 500) this.cache.delete(this.cache.keys().next().value as string);
    return user;
  }

  async signOut(accessToken: string, scope: 'local' | 'global' = 'global'): Promise<void> {
    this.cache.delete(accessToken);
    await this.call(`/auth/v1/logout?scope=${scope}`, { method: 'POST', token: accessToken });
  }

  // ---- TOTP multi-factor authentication ----
  async enrollTotp(accessToken: string, friendlyName: string): Promise<TotpEnrollment> {
    const result = await this.call<{
      id?: string;
      totp?: { qr_code?: string; secret?: string; uri?: string };
    }>('/auth/v1/factors', {
      method: 'POST',
      token: accessToken,
      body: { factor_type: 'totp', friendly_name: friendlyName, issuer: 'CivicSample Verify' },
    });
    if (result.status === 422)
      throw new HttpError(
        409,
        'An unverified authenticator is already enrolled; remove it or verify it.',
      );
    if (result.status !== 200 || !result.body?.id || !result.body.totp?.secret)
      throw new HttpError(502, 'The identity service could not start enrolment.');
    this.cache.delete(accessToken);
    return {
      factorId: result.body.id,
      qrCode: result.body.totp.qr_code ?? '',
      secret: result.body.totp.secret,
      uri: result.body.totp.uri ?? '',
    };
  }
  async verifyTotp(accessToken: string, factorId: string, code: string): Promise<SupabaseSession> {
    if (!/^[0-9a-f-]{36}$/i.test(factorId) || !/^\d{6}$/.test(code))
      throw new HttpError(400, 'Enter the six-digit code from your authenticator app.');
    const challenge = await this.call<{ id?: string }>(`/auth/v1/factors/${factorId}/challenge`, {
      method: 'POST',
      token: accessToken,
      body: {},
    });
    if (challenge.status !== 200 || !challenge.body?.id)
      throw new HttpError(502, 'The identity service could not start verification.');
    const verified = await this.call<{
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      expires_at?: number;
    }>(`/auth/v1/factors/${factorId}/verify`, {
      method: 'POST',
      token: accessToken,
      body: { challenge_id: challenge.body.id, code },
    });
    if (verified.status === 400 || verified.status === 401 || verified.status === 422)
      throw new HttpError(
        401,
        'The code was not accepted. Check the time on your device and try the next code.',
      );
    if (verified.status !== 200)
      throw new HttpError(502, 'The identity service could not complete verification.');
    this.cache.delete(accessToken);
    return this.toSession(verified.body);
  }
}

// ---- cookies ----
export function readSessionCookies(request: Request): { access?: string; refresh?: string } {
  const out: { access?: string; refresh?: string } = {};
  for (const part of request.headers.get('cookie')?.split(';') ?? []) {
    const [name, ...rest] = part.trim().split('=');
    const value = rest.join('=');
    if (name === ACCESS_COOKIE && /^[A-Za-z0-9._-]{20,4096}$/.test(value)) out.access = value;
    if (name === REFRESH_COOKIE && /^[A-Za-z0-9._-]{10,4096}$/.test(value)) out.refresh = value;
  }
  return out;
}
export function sessionCookieHeaders(session: SupabaseSession, secure: boolean): string[] {
  const flags = `HttpOnly; Path=/; SameSite=Lax${secure ? '; Secure' : ''}`;
  const maxAge = Math.max(60, session.expiresAt - Math.floor(Date.now() / 1000));
  return [
    `${ACCESS_COOKIE}=${session.accessToken}; ${flags}; Max-Age=${maxAge}`,
    `${REFRESH_COOKIE}=${session.refreshToken}; HttpOnly; Path=/api/session; SameSite=Strict${secure ? '; Secure' : ''}; Max-Age=${REFRESH_MAX_AGE}`,
  ];
}
export function clearedSessionCookieHeaders(secure: boolean): string[] {
  const s = secure ? '; Secure' : '';
  return [
    `${ACCESS_COOKIE}=; HttpOnly; Path=/; SameSite=Lax${s}; Max-Age=0`,
    `${REFRESH_COOKIE}=; HttpOnly; Path=/api/session; SameSite=Strict${s}; Max-Age=0`,
  ];
}
