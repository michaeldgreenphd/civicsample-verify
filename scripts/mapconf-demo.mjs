// Local mapping-confirmation demonstration: a separate, explicitly named synthetic database and a
// private credentials file, never the existing pilot database (.local/pglite) and never a tracked
// file.
//
//   node scripts/mapconf-demo.mjs setup --credentials /abs/private/mapconf-demo.json
//   node scripts/mapconf-demo.mjs start --credentials /abs/private/mapconf-demo.json [--port 3200]
//        [--database .local/pglite-<name>]   (a separate synthetic database, e.g. for review design v7)
//
// setup writes the four synthetic role passwords (investigator, reviewer-a, reviewer-b,
// adjudicator) to the private file with mode 600 and prints only its path. start reads that file
// and serves the production build (`npm run build` first) on 127.0.0.1 with
// VERIFY_DB_DIR=.local/pglite-mapconf-demo. Nothing here touches .env.local or .local/pglite.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPrivateJson } from './staging-account-tools.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const DEMO_DB_DIR = '.local/pglite-mapconf-demo';
const ROLE_ENV = {
  investigator: 'VERIFY_INVESTIGATOR_PASSWORD',
  'reviewer-a': 'VERIFY_REVIEWER_A_PASSWORD',
  'reviewer-b': 'VERIFY_REVIEWER_B_PASSWORD',
  adjudicator: 'VERIFY_ADJUDICATOR_PASSWORD',
};

function fail(message) {
  console.error(JSON.stringify({ error: message }));
  process.exit(1);
}
function privatePath(path) {
  if (!path || !isAbsolute(path))
    fail('Pass --credentials with an absolute path outside every repository.');
  const parent = dirname(path);
  if (!existsSync(parent)) mkdirSync(parent, { recursive: true, mode: 0o700 });
  const real = realpathSync(parent);
  for (let dir = real; ; dir = dirname(dir)) {
    if (existsSync(join(dir, '.git')))
      fail('The credentials file must live outside every Git repository.');
    if (dirname(dir) === dir) break;
  }
  return join(real, path.slice(parent.length + 1));
}
export function demoCredentials() {
  return {
    purpose:
      'CivicSample Verify local mapping-confirmation demonstration (synthetic accounts only)',
    databaseDir: DEMO_DB_DIR,
    accounts: Object.fromEntries(
      Object.keys(ROLE_ENV).map((k) => [k, randomBytes(18).toString('base64url')]),
    ),
  };
}

const [command, ...rest] = process.argv.slice(2);
const options = {};
for (let i = 0; i < rest.length; i += 2) options[rest[i]] = rest[i + 1];
if (command === 'setup') {
  const target = privatePath(options['--credentials']);
  if (existsSync(target))
    fail('The credentials file exists; delete it first if you want new passwords.');
  writeFileSync(target, JSON.stringify(demoCredentials(), null, 2) + '\n', {
    mode: 0o600,
    flag: 'wx',
  });
  console.log(
    JSON.stringify(
      { written: target, accounts: Object.keys(ROLE_ENV), databaseDir: DEMO_DB_DIR },
      null,
      2,
    ),
  );
} else if (command === 'start') {
  const credentials = readPrivateJson(options['--credentials'], root);
  if (
    !credentials?.accounts ||
    Object.keys(ROLE_ENV).some((k) => typeof credentials.accounts[k] !== 'string')
  )
    fail('The credentials file does not hold the four demo accounts.');
  if (!existsSync(join(root, '.next', 'BUILD_ID')))
    fail('No production build; run `npm run build` first.');
  const port = options['--port'] ?? '3200';
  // Another separate synthetic database may be named; never the pilot database .local/pglite.
  const dbDir = options['--database'] ?? DEMO_DB_DIR;
  if (!/^\.local\/pglite-[a-z0-9][a-z0-9-]{2,40}$/.test(dbDir))
    fail('--database must name a separate folder .local/pglite-<name> (never .local/pglite).');
  const env = {
    ...process.env,
    VERIFY_DB_DIR: join(root, dbDir),
    NEXT_TELEMETRY_DISABLED: '1',
  };
  for (const [account, variable] of Object.entries(ROLE_ENV))
    env[variable] = credentials.accounts[account];
  delete env.VERIFY_DEMO_PASSWORD;
  delete env.VERIFY_STAGING_REVIEWER_1_PASSWORD;
  delete env.VERIFY_STAGING_REVIEWER_2_PASSWORD;
  console.log(
    `Synthetic demo: http://127.0.0.1:${port}/ (database ${dbDir}; accounts investigator, reviewer-a, reviewer-b, adjudicator from the private file)`,
  );
  const child = spawn('npx', ['next', 'start', '--hostname', '127.0.0.1', '--port', port], {
    cwd: root,
    env,
    stdio: 'inherit',
  });
  child.on('exit', (code) => process.exit(code ?? 0));
} else {
  console.log(
    'Usage: node scripts/mapconf-demo.mjs setup|start --credentials /abs/private/mapconf-demo.json [--port 3200]',
  );
}
