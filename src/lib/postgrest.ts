// PostgREST access with the signed-in user's own token (server side). Row-level security and the
// SECURITY DEFINER RPCs decide what each role may read or write, exactly as on the local PGlite
// path; the server adds the publishable key only. Error text from the database is mapped to the
// same fixed public messages the local service layer uses; raw messages never reach a client.
import type { SupabaseWebConfig } from './supabase-config';
import { ServiceError } from '../server/service';

export interface PostgrestError {
  status: number;
  code: string | null;
  message: string;
}
export type PublicErrorMapper = (message: string) => ServiceError | null;

export class PostgrestClient {
  constructor(
    private readonly config: SupabaseWebConfig,
    private readonly accessToken: string,
    private readonly mapError: PublicErrorMapper,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    prefer?: string,
  ): Promise<T> {
    const url = new URL(path, this.config.url);
    if (url.origin !== new URL(this.config.url).origin)
      throw new ServiceError(500, 'Data origin mismatch.');
    const headers: Record<string, string> = {
      apikey: this.config.publishableKey,
      Authorization: `Bearer ${this.accessToken}`,
      Accept: 'application/json',
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (prefer) headers.Prefer = prefer;
    const response = await this.fetchImpl(url.href, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'error',
      cache: 'no-store',
      signal: AbortSignal.timeout(20000),
    });
    const text = await response.text();
    let parsed: unknown = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
    }
    if (response.ok) return parsed as T;
    const err = (parsed ?? {}) as {
      code?: string;
      message?: string;
      details?: string;
      hint?: string;
    };
    const message = [err.message, err.details, err.hint].filter(Boolean).join(' ');
    throw this.toServiceError({ status: response.status, code: err.code ?? null, message });
  }

  private toServiceError(error: PostgrestError): ServiceError {
    if (error.status === 401) return new ServiceError(401, 'Sign in to continue.');
    const mapped = this.mapError(error.message);
    if (mapped) return mapped;
    if (error.status === 403 || error.code === '42501')
      return new ServiceError(403, 'This action is not available to your role.');
    if (error.status === 404 || error.code === 'PGRST202')
      return new ServiceError(404, 'Resource not available.');
    if (error.code === '23505')
      return new ServiceError(
        409,
        'This step was already recorded or conflicts with an existing record.',
      );
    if (error.code?.startsWith('23') || error.code === '22023')
      return new ServiceError(400, 'The input breaks the rules of this record.');
    return new ServiceError(502, 'The data service could not complete this request.');
  }

  /** `select` on a table or view; `query` is the PostgREST query string without the leading `?`. */
  async select<T>(relation: string, query: string): Promise<T[]> {
    if (!/^[a-z_][a-z0-9_]*$/.test(relation)) throw new ServiceError(500, 'Invalid relation.');
    const rows = await this.request<T[]>('GET', `/rest/v1/${relation}?${query}`);
    return Array.isArray(rows) ? rows : [];
  }
  /** Call an RPC with named arguments; a scalar result is returned as is. */
  async rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
    if (!/^rpc_[a-z0-9_]+$/.test(fn)) throw new ServiceError(500, 'Invalid function.');
    return this.request<T>('POST', `/rest/v1/rpc/${fn}`, args);
  }
}

/** PostgREST returns `2026-10-22T19:52:03.123456+00:00`; the export contract uses
 *  `YYYY-MM-DDTHH:MM:SS.ffffffZ` (the database `to_char` format of the local path). */
export function toExportTimestamp(value: string | null | undefined): string | null {
  if (!value) return null;
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?(?:Z|\+00:00)?$/.exec(
    value,
  );
  if (!m) {
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return value;
    return d.toISOString().replace(/\.(\d{3})Z$/, '.$1000Z');
  }
  return `${m[1]}T${m[2]}.${(m[3] ?? '').padEnd(6, '0')}Z`;
}
