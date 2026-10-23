// Serve the web application against Supabase staging using a PRIVATE web configuration file
// (outside every repository, mode 600) that holds the publishable key only.
//
//   node scripts/supabase-web.mjs check --config /abs/private/web-app.json
//   node scripts/supabase-web.mjs start --config /abs/private/web-app.json [--port 3300]
//
// check validates the file (placeholder or secret key refused), reaches the project's public Auth
// settings and reports sign-up and provider state; it prints no key. start serves the production
// build (`npm run build` first) with VERIFY_DATA_BACKEND=supabase; the local pilot database,
// .env.local and the local demo are untouched. Never put the secret key or a database password here.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPrivateJson } from './staging-account-tools.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REF = /^[a-z][a-z0-9]{15,39}$/;

export function validateWebConfig(config) {
  const problems = [];
  const p = config?.project ?? {};
  if (p.environment !== 'staging') problems.push('project.environment must be "staging"');
  if (!REF.test(p.stagingProjectRef ?? ''))
    problems.push('project.stagingProjectRef is not a project reference');
  if (p.projectUrl !== `https://${p.stagingProjectRef}.supabase.co`)
    problems.push('project.projectUrl must be https://<ref>.supabase.co');
  const key = config?.publishableKey ?? '';
  if (/REPLACE_WITH/.test(key)) problems.push('publishableKey still holds the placeholder');
  else if (/^sb_secret_/.test(key))
    problems.push(
      'publishableKey holds a SECRET key; the web application must only hold the publishable key',
    );
  else if (!/^sb_publishable_[A-Za-z0-9_-]{10,}$/.test(key)) {
    let anon = false;
    try {
      anon = JSON.parse(Buffer.from(key.split('.')[1], 'base64url').toString()).role === 'anon';
    } catch {
      /* not a JWT */
    }
    if (!anon) problems.push('publishableKey is neither sb_publishable_… nor a legacy anon key');
  }
  if (!REF.test(config?.accountDomainRef ?? ''))
    problems.push('accountDomainRef is not a project reference');
  try {
    const o = new URL(config?.siteOrigin ?? '');
    if (o.origin !== config.siteOrigin) problems.push('siteOrigin must be a bare origin');
  } catch {
    problems.push('siteOrigin is not a URL');
  }
  return problems;
}

export function webEnv(config, port) {
  return {
    VERIFY_DATA_BACKEND: 'supabase',
    VERIFY_SUPABASE_URL: config.project.projectUrl,
    VERIFY_SUPABASE_PUBLISHABLE_KEY: config.publishableKey,
    VERIFY_SUPABASE_ACCOUNT_DOMAIN_REF: config.accountDomainRef,
    VERIFY_SITE_ORIGIN: port ? `http://127.0.0.1:${port}` : config.siteOrigin,
    NEXT_TELEMETRY_DISABLED: '1',
  };
}

async function main(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let i = 0; i < rest.length; i += 2) options[rest[i]] = rest[i + 1];
  if (!['check', 'start'].includes(command)) {
    console.log(
      'Usage: node scripts/supabase-web.mjs check|start --config /abs/private/web-app.json [--port 3300]',
    );
    return 2;
  }
  const path = options['--config'] ?? process.env.VERIFY_SUPABASE_WEB_CONFIG;
  if (!path) {
    console.log(JSON.stringify({ status: 'BLOCKED', reason: 'PRIVATE_WEB_CONFIG_UNAVAILABLE' }));
    return 2;
  }
  let config;
  try {
    config = readPrivateJson(path, root);
  } catch (error) {
    console.log(
      JSON.stringify({ status: 'BLOCKED', reason: error.code ?? 'PRIVATE_WEB_CONFIG_REFUSED' }),
    );
    return 1;
  }
  const problems = validateWebConfig(config);
  if (problems.length) {
    console.log(JSON.stringify({ status: 'INVALID', problems }, null, 2));
    return 1;
  }
  if (command === 'check') {
    const response = await fetch(`${config.project.projectUrl}/auth/v1/settings`, {
      headers: { apikey: config.publishableKey },
      redirect: 'error',
    }).catch(() => null);
    const settings = response && response.ok ? await response.json().catch(() => null) : null;
    console.log(
      JSON.stringify(
        {
          status: settings ? 'OK' : 'UNREACHABLE',
          projectRef: config.project.stagingProjectRef,
          auth: settings
            ? {
                signUpsDisabled: settings.disable_signup === true,
                emailProvider: settings.external?.email === true,
                note:
                  settings.disable_signup === true
                    ? 'Sign-ups are disabled, as required.'
                    : 'Sign-ups are still ENABLED: disable "Allow new users to sign up" in Authentication settings.',
              }
            : null,
          publishableKey: 'present (not shown)',
        },
        null,
        2,
      ),
    );
    return settings ? 0 : 1;
  }
  if (!existsSync(join(root, '.next', 'BUILD_ID'))) {
    console.log(
      JSON.stringify({
        status: 'BLOCKED',
        reason: 'NO_PRODUCTION_BUILD',
        hint: 'run npm run build first',
      }),
    );
    return 1;
  }
  const port = options['--port'] ?? '3300';
  const env = { ...process.env, ...webEnv(config, port) };
  for (const k of Object.keys(env))
    if (
      /^VERIFY_(INVESTIGATOR|REVIEWER_A|REVIEWER_B|ADJUDICATOR|STAGING_REVIEWER_1|STAGING_REVIEWER_2|DEMO)_PASSWORD$/.test(
        k,
      )
    )
      delete env[k];
  console.log(
    `CivicSample Verify on Supabase staging (${config.project.stagingProjectRef}): http://127.0.0.1:${port}/`,
  );
  const child = spawn('npx', ['next', 'start', '--hostname', '127.0.0.1', '--port', port], {
    cwd: root,
    env,
    stdio: 'inherit',
  });
  return new Promise((resolveExit) => child.on('exit', (code) => resolveExit(code ?? 0)));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
