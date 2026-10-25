// Deployment mode and Supabase web configuration (server only). The web application may carry the
// publishable key only; a secret key is refused at startup. Default mode is the local synthetic
// pilot on PGlite, unchanged.
export type DataBackend = 'local' | 'supabase';

export interface SupabaseWebConfig {
  url: string;
  projectRef: string;
  publishableKey: string;
  accountDomainRef: string;
  siteOrigin: string;
}

const REF = /^[a-z][a-z0-9]{15,39}$/;

export type EnvMap = Record<string, string | undefined>;
export function dataBackend(env: EnvMap = process.env): DataBackend {
  return env.VERIFY_DATA_BACKEND === 'supabase' ? 'supabase' : 'local';
}

/** Validate the publishable key shape and refuse anything privileged. */
export function assertPublishableKey(key: string | undefined): string {
  if (!key || /\s/.test(key) || key.length > 8192)
    throw new Error('VERIFY_SUPABASE_PUBLISHABLE_KEY is missing.');
  if (/^sb_secret_/.test(key))
    throw new Error('A secret key must never be configured for the web application.');
  if (/^sb_publishable_[A-Za-z0-9_-]{10,}$/.test(key)) return key;
  try {
    const [, payload] = key.split('.');
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString()) as { role?: string };
    if (claims.role === 'anon') return key;
    throw new Error(`role ${claims.role}`);
  } catch {
    throw new Error(
      'VERIFY_SUPABASE_PUBLISHABLE_KEY is neither a publishable key nor an anon key; a privileged key is refused.',
    );
  }
}

export function supabaseWebConfig(env: EnvMap = process.env): SupabaseWebConfig {
  const url = env.VERIFY_SUPABASE_URL ?? '';
  const match = /^https:\/\/([a-z][a-z0-9]{15,39})\.supabase\.co$/.exec(url);
  if (!match) throw new Error('VERIFY_SUPABASE_URL must be https://<project-ref>.supabase.co');
  const accountDomainRef = env.VERIFY_SUPABASE_ACCOUNT_DOMAIN_REF ?? match[1];
  if (!REF.test(accountDomainRef))
    throw new Error('VERIFY_SUPABASE_ACCOUNT_DOMAIN_REF is not a project reference.');
  const siteOrigin = env.VERIFY_SITE_ORIGIN ?? 'http://127.0.0.1:3300';
  try {
    const o = new URL(siteOrigin);
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(o.hostname);
    if (
      o.origin !== siteOrigin ||
      (o.protocol !== 'https:' && !(loopback && o.protocol === 'http:'))
    )
      throw new Error('x');
  } catch {
    throw new Error(
      'VERIFY_SITE_ORIGIN must be an HTTPS origin, or HTTP on an explicit loopback host.',
    );
  }
  return {
    url,
    projectRef: match[1],
    publishableKey: assertPublishableKey(env.VERIFY_SUPABASE_PUBLISHABLE_KEY),
    accountDomainRef,
    siteOrigin,
  };
}
