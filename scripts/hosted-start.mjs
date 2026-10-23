// Hosted entry point: validate configuration before opening a public listening socket.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateWebConfig } from './supabase-web.mjs';

export function hostedSettings(env, build) {
  if (env.VERIFY_DATA_BACKEND !== 'supabase') throw new Error('HOSTED_REQUIRES_SUPABASE');
  const origin = env.VERIFY_SITE_ORIGIN || env.RENDER_EXTERNAL_URL;
  let url;
  try {
    url = new URL(origin);
  } catch {
    throw new Error('HOSTED_REQUIRES_HTTPS_ORIGIN');
  }
  if (
    url.protocol !== 'https:' ||
    url.origin !== origin ||
    url.hostname === 'localhost' ||
    url.hostname === '127.0.0.1'
  )
    throw new Error('HOSTED_REQUIRES_HTTPS_ORIGIN');
  const projectUrl = env.VERIFY_SUPABASE_URL;
  const ref = /^https:\/\/([a-z][a-z0-9]{15,39})\.supabase\.co$/.exec(projectUrl || '')?.[1];
  const problems = validateWebConfig({
    project: { environment: 'staging', stagingProjectRef: ref, projectUrl },
    publishableKey: env.VERIFY_SUPABASE_PUBLISHABLE_KEY,
    accountDomainRef: env.VERIFY_SUPABASE_ACCOUNT_DOMAIN_REF || ref,
    siteOrigin: origin,
  });
  if (problems.length) throw new Error('HOSTED_WEB_CONFIG_INVALID');
  // Privileged tooling configuration and local demo passwords never belong on a web host.
  for (const [key, value] of Object.entries(env)) {
    if (
      value &&
      /SERVICE_ROLE|SECRET_KEY|DATABASE_URL|DATABASE_PASSWORD|VERIFY_SUPABASE_ADMIN|VERIFY_SUPABASE_SIGNIN|^VERIFY_.*PASSWORD$/.test(
        key,
      )
    )
      throw new Error('HOSTED_PRIVILEGED_ENV_REFUSED');
  }
  if (!/^[a-f0-9]{40}$/.test(build || '') || /^0+$/.test(build))
    throw new Error('HOSTED_BUILD_UNVERIFIED');
  for (const declared of [env.RENDER_GIT_COMMIT, env.VERIFY_APP_GIT_SHA])
    if (declared && declared !== build) throw new Error('HOSTED_BUILD_MISMATCH');
  const port = env.PORT || '10000';
  if (!/^\d+$/.test(port) || Number(port) < 1024 || Number(port) > 65535)
    throw new Error('HOSTED_PORT_INVALID');
  return {
    port,
    env: {
      ...env,
      NODE_ENV: 'production',
      VERIFY_SITE_ORIGIN: origin,
      VERIFY_SUPABASE_ACCOUNT_DOMAIN_REF: env.VERIFY_SUPABASE_ACCOUNT_DOMAIN_REF || ref,
      VERIFY_APP_GIT_SHA: build,
      NEXT_TELEMETRY_DISABLED: '1',
    },
  };
}

export async function checkHostedAuth(env, fetchImpl = fetch) {
  const response = await fetchImpl(`${env.VERIFY_SUPABASE_URL}/auth/v1/settings`, {
    headers: { apikey: env.VERIFY_SUPABASE_PUBLISHABLE_KEY },
    redirect: 'error',
    signal: globalThis.AbortSignal.timeout(15000),
  });
  if (!response.ok || (await response.json()).disable_signup !== true)
    throw new Error('HOSTED_SIGNUPS_NOT_CONFIRMED_DISABLED');
}

async function main() {
  const build = JSON.parse(readFileSync('.next/verify-build.json', 'utf8')).commit;
  const settings = hostedSettings(process.env, build);
  await checkHostedAuth(settings.env);
  console.log('Hosted synthetic workspace configuration verified.');
  const child = spawn(
    process.execPath,
    [
      'node_modules/next/dist/bin/next',
      'start',
      '--hostname',
      '0.0.0.0',
      '--port',
      settings.port,
      '--keepAliveTimeout',
      '70000',
    ],
    {
      env: settings.env,
      stdio: 'inherit',
    },
  );
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal));
  child.on('error', () => {
    process.exitCode = 1;
  });
  child.on('exit', (code) => {
    process.exitCode = code ?? 1;
  });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch(() => {
    // Do not print network errors, URLs, configuration or credentials.
    console.error('Hosted startup refused. Check the documented environment and clean build.');
    process.exitCode = 1;
  });
