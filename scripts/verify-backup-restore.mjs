// Restores a backup written by scripts/supabase-backup.mjs into a DISPOSABLE local PostgreSQL 17
// cluster and checks it against the live project (read-only), then deletes the cluster.
//
//   node scripts/verify-backup-restore.mjs --backup /abs/private/backups/<folder> \
//        --pg-bin /abs/path/to/postgresql-17/bin --config /abs/private/supabase-admin.json
//
// Restored and checked: roles.sql (role layout, no passwords), app.dump (schemas public and
// private with owners, grants, policies, functions, triggers and data). Compared with the live
// project: schema markers; counts of tables, views, functions, triggers and policies; and the
// SHA-256 of every public table's rows in canonical order (a fresh read-only snapshot of the live
// project, scripts/supabase-readonly-snapshot.mjs). auth-data.dump is checked as readable only:
// restoring it needs the Supabase Auth schema, which this local cluster does not have, so that step
// stays UNTESTED and is reported as such. Nothing is printed from any record.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readAdminConfig, validateDatabaseDestination } from './supabase-identity-tools.mjs';
import { snapshotWith } from './supabase-readonly-snapshot.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CATALOG = `select json_build_object(
  'schema_versions', (select json_agg(version order by applied_at) from public.app_schema_version),
  'tables', (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname in ('public','private') and c.relkind in ('r','p')),
  'views', (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname in ('public','private') and c.relkind = 'v'),
  'functions', (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('public','private')),
  'triggers', (select count(*) from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace where n.nspname in ('public','private') and not t.tgisinternal),
  'policies', (select count(*) from pg_policies where schemaname in ('public','private')))::jsonb as c`;

const freePort = () =>
  new Promise((ok) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => ok(p));
    });
  });

async function main(argv) {
  const at = (n) => {
    const i = argv.indexOf(n);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const backup = at('--backup');
  const bin = at('--pg-bin');
  const manifest = JSON.parse(readFileSync(join(backup, 'manifest.json'), 'utf8'));
  const { Client } = await import('pg');
  // 1. The live side, read-only: catalog counts and a canonical row snapshot.
  const config = readAdminConfig(at('--config'), root);
  validateDatabaseDestination(config.databaseUrl, config.project.stagingProjectRef);
  const ssl = { rejectUnauthorized: true };
  if (config.databaseCaCertPath) ssl.ca = readFileSync(config.databaseCaCertPath, 'utf8');
  const live = new Client({ connectionString: config.databaseUrl, ssl });
  await live.connect();
  let liveCatalog, liveSnapshot;
  try {
    await live.query('begin transaction isolation level repeatable read read only');
    liveCatalog = (await live.query(CATALOG)).rows[0].c;
    await live.query('rollback');
    liveSnapshot = await snapshotWith((sql) => live.query(sql));
  } finally {
    await live.end();
  }
  // 2. A disposable cluster (UTC, local socket only), deleted at the end.
  const dir = mkdtempSync(join(tmpdir(), 'verify-restore-'));
  const data = join(dir, 'data');
  const port = await freePort();
  const sh = (tool, args, opts = {}) =>
    spawnSync(join(bin, tool), args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });
  const report = {
    backup,
    restoredInto: 'disposable local PostgreSQL 17 cluster (deleted afterwards)',
  };
  let started = false;
  try {
    let r = sh('initdb', [
      '-D',
      data,
      '-U',
      'restore_superuser',
      '-A',
      'trust',
      '-E',
      'UTF8',
      '--no-locale',
    ]);
    if (r.status !== 0) throw new Error(`initdb failed: ${r.stderr.slice(-300)}`);
    r = sh('pg_ctl', [
      '-D',
      data,
      '-l',
      join(dir, 'log'),
      '-w',
      '-o',
      `-p ${port} -k ${dir} -c listen_addresses='' -c timezone=UTC`,
      'start',
    ]);
    if (r.status !== 0) throw new Error(`pg_ctl start failed: ${r.stderr.slice(-300)}`);
    started = true;
    const conn = ['-h', dir, '-p', String(port), '-U', 'restore_superuser', '-d', 'postgres'];
    const psql = (sql) =>
      sh('psql', [...conn, '--no-psqlrc', '-v', 'ON_ERROR_STOP=0', '-q', '-c', sql]);
    // Roles as the project has them (no passwords); errors are counted, not hidden.
    r = sh('psql', [
      ...conn,
      '--no-psqlrc',
      '-v',
      'ON_ERROR_STOP=0',
      '-q',
      '-f',
      join(backup, 'roles.sql'),
    ]);
    report.rolesErrors = (r.stderr.match(/ERROR:/g) ?? []).length;
    // Role statements only (names and settings of roles, no records): kinds of what failed locally.
    report.rolesErrorKinds = [
      ...new Set(
        (r.stderr.match(/ERROR: [^\n]*/g) ?? []).map((e) =>
          e.replace(/"[^"]*"/g, '"…"').slice(0, 120),
        ),
      ),
    ];
    // What a Supabase project provides before the application schema: the Auth stand-in and extensions.
    r = sh('psql', [
      ...conn,
      '--no-psqlrc',
      '-v',
      'ON_ERROR_STOP=1',
      '-q',
      '-f',
      join(root, 'supabase_test_shim/auth_shim.sql'),
    ]);
    if (r.status !== 0) throw new Error(`auth stand-in failed: ${r.stderr.slice(-300)}`);
    psql(
      'create schema if not exists extensions; create extension if not exists pgcrypto with schema extensions; create extension if not exists "uuid-ossp" with schema extensions;',
    );
    // The application schemas, with owners and grants.
    // The documented procedure: --clean --if-exists replaces the empty public schema a new database has.
    r = sh('pg_restore', [
      ...conn,
      '--no-password',
      '--clean',
      '--if-exists',
      '--exit-on-error',
      join(backup, 'app.dump'),
    ]);
    report.appRestore = r.status === 0 ? 'OK' : `FAILED: ${r.stderr.slice(-400)}`;
    if (r.status !== 0) throw new Error(report.appRestore);
    const local = new Client({ host: dir, port, user: 'restore_superuser', database: 'postgres' });
    await local.connect();
    try {
      await local.query('set timezone = UTC');
      report.catalog = { live: liveCatalog, restored: (await local.query(CATALOG)).rows[0].c };
      report.catalogMatches =
        JSON.stringify(report.catalog.live) === JSON.stringify(report.catalog.restored);
      const restoredSnapshot = await snapshotWith((sql) => local.query(sql));
      const tables = Object.keys(liveSnapshot.digests);
      const differing = tables.filter(
        (t) => liveSnapshot.digests[t].sha256 !== restoredSnapshot.digests[t]?.sha256,
      );
      report.rows = {
        tables: tables.length,
        rows: tables.reduce((n, t) => n + liveSnapshot.digests[t].rows, 0),
        identicalTables: tables.length - differing.length,
        differingTables: differing,
      };
    } finally {
      await local.end();
    }
    // Auth data: readable, not restored here.
    r = sh('pg_restore', ['--list', join(backup, 'auth-data.dump')]);
    report.authData = {
      readable: r.status === 0,
      tableDataEntries: (r.stdout.match(/TABLE DATA auth /g) ?? []).length,
      restore: 'UNTESTED: needs the Supabase Auth schema (a Supabase project)',
    };
    report.manifestFiles = Object.fromEntries(
      Object.entries(manifest.files).map(([k, v]) => [
        k,
        statSync(join(backup, k)).size === v.bytes,
      ]),
    );
  } finally {
    if (started) sh('pg_ctl', ['-D', data, '-m', 'fast', '-w', 'stop']);
    rmSync(dir, { recursive: true, force: true });
  }
  report.ok =
    report.appRestore === 'OK' &&
    report.catalogMatches &&
    report.rows.differingTables.length === 0 &&
    report.authData.readable;
  console.log(JSON.stringify(report, null, 2));
  return report.ok ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      console.error(
        JSON.stringify({ status: 'FAILED', message: String(e?.message ?? e).slice(0, 600) }),
      );
      process.exit(1);
    },
  );
