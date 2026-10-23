// Off-site logical backup of the approved Supabase staging project (Free plan: no provider backup
// is assumed), with PostgreSQL's own pg_dump and pg_dumpall, read-only.
//
//   node scripts/supabase-backup.mjs --config /abs/private/supabase-admin.json \
//        --pg-bin /abs/path/to/postgresql-17/bin --out-dir /abs/private/backups/<new folder>
//
// What it writes (a NEW owner-only folder, mode 700, outside every Git repository; files mode 600):
//   roles.sql        pg_dumpall --roles-only --no-role-passwords (role names and attributes)
//   app.dump         pg_dump custom format of the application schemas public and private
//                    (tables, data, functions, triggers, policies, grants, sequences)
//   auth-data.dump   pg_dump custom format, data only, of schema auth (Auth users, identities,
//                    factors, sessions). It holds password hashes and TOTP secrets: keep it private.
//   manifest.json    tool and server versions, schema markers, live catalog counts taken in the
//                    same read-only session style, and the SHA-256 and size of each file
// Excluded: storage objects (none used), the Supabase-managed schemas and extensions themselves,
// and project settings (Auth configuration, API keys), which a new project provides.
//
// Safety: the destination is validated as the approved staging project; TLS is verified
// (verify-full with the private CA file); pg_dump reads in its own read-only transaction and the
// summary query runs inside BEGIN READ ONLY (the pooler ignores a server-side read-only default);
// the password reaches the tools through the environment only and is never printed. Only file
// names, sizes and hashes are printed.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  readAdminConfig,
  SupabaseIdentityError,
  validateDatabaseDestination,
} from './supabase-identity-tools.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function outsideRepositories(path) {
  for (let dir = path; ; dir = dirname(dir)) {
    if (existsSync(join(dir, '.git')))
      throw new SupabaseIdentityError(
        'USAGE',
        'Backups must be written outside every Git repository.',
      );
    if (dirname(dir) === dir) break;
  }
}
/** libpq environment for the approved destination; never printed. */
export function libpqEnvironment(databaseUrl, caPath) {
  const url = new URL(databaseUrl);
  /** @type {Record<string, string>} */
  const env = {
    PGHOST: url.hostname,
    PGPORT: url.port || '5432',
    PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password),
    PGDATABASE: decodeURIComponent(url.pathname.replace(/^\//, '')),
    PGSSLMODE: caPath ? 'verify-full' : 'require',
    PGCONNECT_TIMEOUT: '20',
    // Asked for, but the Supabase connection pooler does not pass startup options through, so the
    // read-only guarantee comes from the commands themselves (see readOnly in the manifest).
    PGOPTIONS: '-c default_transaction_read_only=on',
  };
  if (caPath) env.PGSSLROOTCERT = caPath;
  return env;
}

async function main(argv) {
  const at = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const config = readAdminConfig(at('--config'), root);
  const destination = validateDatabaseDestination(
    config.databaseUrl,
    config.project.stagingProjectRef,
  );
  const bin = at('--pg-bin');
  if (!bin || !isAbsolute(bin) || !existsSync(join(bin, 'pg_dump')))
    throw new SupabaseIdentityError(
      'USAGE',
      '--pg-bin must name a PostgreSQL 17 bin folder with pg_dump.',
    );
  const out = at('--out-dir');
  if (!out || !isAbsolute(out))
    throw new SupabaseIdentityError('USAGE', '--out-dir must be an absolute private path.');
  if (existsSync(out))
    throw new SupabaseIdentityError('USAGE', 'The backup folder must not exist yet.');
  outsideRepositories(realpathSync(dirname(out)));
  let ca = null;
  if (config.databaseCaCertPath) {
    ca = realpathSync(config.databaseCaCertPath);
    if ((statSync(ca).mode & 0o077) !== 0)
      throw new SupabaseIdentityError('DATABASE_CA_CERT', 'The CA file must be owner-only.');
  }
  // Every file the tools write is owner-only.
  process.umask(0o077);
  mkdirSync(out, { mode: 0o700 });
  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    ...libpqEnvironment(config.databaseUrl, ca),
  };
  const secret = env.PGPASSWORD;
  const redact = (text) =>
    String(text ?? '')
      .split(secret)
      .join('[redacted]');
  const run = (tool, args) => {
    const r = spawnSync(join(bin, tool), args, {
      env,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    if (r.status !== 0)
      throw new Error(`${tool} failed (exit ${r.status}): ${redact(r.stderr).slice(-600)}`);
    return redact(r.stdout);
  };
  const version = run('pg_dump', ['--version']).trim();
  run('pg_dumpall', [
    '--roles-only',
    '--no-role-passwords',
    '--no-password',
    '--file',
    join(out, 'roles.sql'),
  ]);
  run('pg_dump', [
    '--format=custom',
    '--schema=public',
    '--schema=private',
    '--no-password',
    '--file',
    join(out, 'app.dump'),
  ]);
  run('pg_dump', [
    '--format=custom',
    '--data-only',
    '--schema=auth',
    '--no-password',
    '--file',
    join(out, 'auth-data.dump'),
  ]);
  // Live catalog counts and markers, read-only, for the restore comparison.
  const countsText = run('psql', [
    '--no-password',
    '--no-psqlrc',
    '--tuples-only',
    '--no-align',
    '--quiet',
    '--command',
    `begin transaction isolation level repeatable read read only; select json_build_object(
         'server_version_num', current_setting('server_version_num')::int,
         'read_only', current_setting('transaction_read_only'),
         'schema_versions', (select json_agg(version order by applied_at) from public.app_schema_version),
         'tables', (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname in ('public','private') and c.relkind in ('r','p')),
         'views', (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname in ('public','private') and c.relkind = 'v'),
         'functions', (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('public','private')),
         'triggers', (select count(*) from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace where n.nspname in ('public','private') and not t.tgisinternal),
         'policies', (select count(*) from pg_policies where schemaname in ('public','private')),
         'public_rows', (select sum(n_live_tup) from pg_stat_user_tables where schemaname = 'public'),
         'auth_users', (select count(*) from auth.users))::jsonb; rollback;`,
  ]).trim();
  let counts;
  try {
    counts = JSON.parse(countsText);
  } catch {
    throw new Error(`unexpected summary output: ${countsText.slice(0, 160)}`);
  }
  const files = {};
  for (const name of ['roles.sql', 'app.dump', 'auth-data.dump']) {
    const p = join(out, name);
    statSync(p);
    files[name] = {
      bytes: statSync(p).size,
      sha256: createHash('sha256').update(readFileSync(p)).digest('hex'),
    };
  }
  const manifest = {
    kind: 'civicsample-verify staging logical backup',
    projectRef: config.project.stagingProjectRef,
    destinationMode: destination.mode,
    takenAt: new Date().toISOString(),
    tool: version,
    readOnly:
      'pg_dump reads inside its own READ ONLY REPEATABLE READ transaction; pg_dumpall --roles-only reads role catalogs; the summary below ran inside BEGIN READ ONLY (live.read_only) and was rolled back',
    live: counts,
    files,
    excludes: [
      'storage objects',
      'Supabase-managed schemas and extensions',
      'project and Auth settings, API keys',
    ],
  };
  writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', {
    mode: 0o600,
    flag: 'wx',
  });
  console.log(
    JSON.stringify(
      {
        status: 'BACKUP_WRITTEN_READ_ONLY',
        folder: out,
        tool: version,
        files,
        live: { ...counts, schema_versions: counts.schema_versions?.at(-1) },
      },
      null,
      2,
    ),
  );
  return 0;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      console.error(
        JSON.stringify({
          status: 'FAILED',
          error: error?.code ?? 'ERROR',
          message: String(error?.message ?? '').slice(0, 600),
        }),
      );
      process.exit(1);
    },
  );
