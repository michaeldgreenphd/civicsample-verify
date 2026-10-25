// Session resolution for both deployment modes. Local: the synthetic cookie session of
// src/lib/auth.ts. Supabase: HttpOnly cookies carrying a Supabase session; the access token is
// verified with Auth on every request (cached 30 s), refreshed server-side when it is about to
// expire, and the application identity (role, pseudonymous id) is read through PostgREST under
// that token, so the database decides who the caller is.
import { HttpError, getActor as getLocalActor } from '../lib/auth';
import { PostgrestClient } from '../lib/postgrest';
import { dataBackend, supabaseWebConfig, type SupabaseWebConfig } from '../lib/supabase-config';
import {
  SupabaseAuth,
  clearedSessionCookieHeaders,
  readSessionCookies,
  sessionCookieHeaders,
  type VerifiedUser,
} from '../lib/supabase-auth';
import type { Actor } from '../lib/types';

export interface SessionActor extends Actor {
  /** Supabase mode only: the verified access token used for data access; never serialised. */
  accessToken?: string;
  aal: 'aal1' | 'aal2';
  mfaEnrolled: boolean;
  practiceReadOnly?: boolean;
}
export interface ResolvedSession {
  actor: SessionActor | null;
  setCookies: string[];
  backend: 'local' | 'supabase';
}

const globals = globalThis as typeof globalThis & {
  verifySupabaseAuth?: SupabaseAuth;
  verifySupabaseConfig?: SupabaseWebConfig;
};
export function supabaseRuntime(): { config: SupabaseWebConfig; auth: SupabaseAuth } {
  globals.verifySupabaseConfig ??= supabaseWebConfig();
  globals.verifySupabaseAuth ??= new SupabaseAuth(globals.verifySupabaseConfig);
  return { config: globals.verifySupabaseConfig, auth: globals.verifySupabaseAuth };
}
export const publicActor = (actor: SessionActor): Omit<SessionActor, 'accessToken'> => {
  const { accessToken: _token, ...rest } = actor;
  return rest;
};
const secureCookies = (config: SupabaseWebConfig) => config.siteOrigin.startsWith('https://');

async function identityFor(
  config: SupabaseWebConfig,
  user: VerifiedUser,
  accessToken: string,
): Promise<SessionActor | null> {
  const client = new PostgrestClient(config, accessToken, () => null);
  const who = await client.rpc<
    { user_id: string; role: Actor['role']; is_pilot_test_account: boolean }[]
  >('rpc_whoami', {});
  if (!Array.isArray(who) || who.length !== 1) return null; // no active, unlocked application user
  const rows = await client.select<{ display_name: string; practice_read_only: boolean }>(
    'users',
    `select=display_name,practice_read_only&user_id=eq.${who[0].user_id}`,
  );
  return {
    id: who[0].user_id,
    role: who[0].role,
    displayName: rows[0]?.display_name ?? who[0].role,
    accessToken,
    practiceReadOnly: rows[0]?.practice_read_only === true,
    aal: user.aal,
    mfaEnrolled: user.verifiedFactors.length > 0,
  };
}

export async function resolveSession(
  request: Request,
  onCookies: (cookies: string[]) => void = () => undefined,
): Promise<ResolvedSession> {
  if (dataBackend() === 'local') {
    const local = getLocalActor(request);
    return {
      actor: local ? { ...local, aal: 'aal2', mfaEnrolled: false } : null,
      setCookies: [],
      backend: 'local',
    };
  }
  const { config, auth } = supabaseRuntime();
  const cookies = readSessionCookies(request);
  if (!cookies.access && !cookies.refresh)
    return { actor: null, setCookies: [], backend: 'supabase' };
  let access = cookies.access;
  let setCookies: string[] = [];
  const updateCookies = (cookies: string[]) => {
    setCookies = cookies;
    // A later data-service or authorization error must still return a rotated refresh token.
    onCookies(cookies);
  };
  let user: VerifiedUser | null = null;
  if (access) {
    try {
      user = await auth.verify(access);
    } catch (error) {
      if (!(error instanceof HttpError && error.status === 401)) throw error;
      user = null;
    }
  }
  // Refresh ahead of expiry, on every protected API route, so an active review does not lose its
  // session mid-form. Definite Auth refusals clear cookies; a temporary outage keeps them usable.
  if (cookies.refresh && (!user || user.exp - Math.floor(Date.now() / 1000) < 120)) {
    try {
      const next = await auth.refresh(cookies.refresh);
      access = next.accessToken;
      updateCookies(sessionCookieHeaders(next, secureCookies(config)));
      user = await auth.verify(access);
    } catch (error) {
      if (!(error instanceof HttpError && error.status === 401)) throw error;
      updateCookies(clearedSessionCookieHeaders(secureCookies(config)));
      return {
        actor: null,
        setCookies,
        backend: 'supabase',
      };
    }
  }
  if (!user || !access) {
    updateCookies(clearedSessionCookieHeaders(secureCookies(config)));
    return {
      actor: null,
      setCookies,
      backend: 'supabase',
    };
  }
  // The startup session request receives the legacy /api/session cookie. Migrate it without
  // forcing returning users to sign in again; new and legacy names cannot shadow one another.
  if (cookies.legacyRefresh && cookies.refresh && setCookies.length === 0)
    updateCookies(
      sessionCookieHeaders(
        { accessToken: access, refreshToken: cookies.refresh, expiresAt: user.exp },
        secureCookies(config),
      ),
    );
  const actor = await identityFor(config, user, access);
  return { actor, setCookies, backend: 'supabase' };
}
