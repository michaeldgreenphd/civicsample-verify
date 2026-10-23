// Read-only, record-level snapshot of the approved staging project before a schema change.
//
//   node scripts/supabase-readonly-snapshot.mjs --config /abs/private/supabase-admin.json --out /abs/private/snapshot.json
//
// One `begin transaction read only` block reads every table of the public schema (rows as JSON),
// the schema markers and the table list, then rolls back. The output file is written owner-only
// (mode 600), never overwritten, and must lie outside every Git repository. It holds synthetic
// records only today, but it is treated as private: nothing from it is printed except per-table
// counts and SHA-256 digests. Auth tables (password hashes, factors) are not read; the provider's
// own backups cover them. This is a comparison and recovery aid, not a replacement for those.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  readAdminConfig,
  SupabaseIdentityError,
  validateDatabaseDestination,
} from './supabase-identity-tools.mjs';
import { READ_ONLY_STATEMENT } from './supabase-readonly-inspect.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const IDENT = /^[a-z_][a-z0-9_]*$/;

/** The snapshot, written against `query(sql)`. */
export async function snapshotWith(query) {
  const q = async (sql) => {
    if (!READ_ONLY_STATEMENT.test(sql)) throw new Error('refused: not a read-only statement');
    return (await query(sql)).rows;
  };
  const snapshot = { readOnly: true, tables: {}, digests: {} };
  await q('begin transaction read only');
  try {
    await q("set local statement_timeout = '60s'");
    snapshot.schemaVersions = (
      await q('select version from public.app_schema_version order by applied_at')
    ).map((r) => r.version);
    const tables = (
      await q(
        "select c.relname as name from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind in ('r', 'p') order by 1",
      )
    ).map((r) => r.name);
    for (const t of tables) {
      if (!IDENT.test(t)) throw new Error('unexpected table name');
      const rows = (
        await q(`select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) as rows from public.${t} x`)
      )[0].rows;
      snapshot.tables[t] = rows;
      snapshot.digests[t] = {
        rows: rows.length,
        sha256: createHash('sha256').update(JSON.stringify(rows)).digest('hex'),
      };
    }
  } finally {
    await q('rollback');
  }
  return snapshot;
}

function privateOut(path) {
  if (!path || !isAbsolute(path))
    throw new SupabaseIdentityError('USAGE', '--out must be an absolute private path.');
  const parent = realpathSync(dirname(path));
  for (let dir = parent; ; dir = dirname(dir)) {
    if (existsSync(join(dir, '.git')))
      throw new SupabaseIdentityError(
        'USAGE',
        'The snapshot must be written outside every repository.',
      );
    if (dirname(dir) === dir) break;
  }
  return join(parent, path.slice(dirname(path).length + 1));
}

async function main(argv) {
  const at = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const configPath = at('--config') ?? process.env.VERIFY_SUPABASE_ADMIN_CONFIG;
  const out = privateOut(at('--out'));
  if (!configPath) {
    console.log(JSON.stringify({ status: 'BLOCKED', reason: 'PRIVATE_ADMIN_CONFIG_UNAVAILABLE' }));
    return 2;
  }
  const config = readAdminConfig(configPath, root);
  validateDatabaseDestination(config.databaseUrl, config.project.stagingProjectRef);
  const { Client } = await import('pg');
  const ssl = { rejectUnauthorized: true };
  if (config.databaseCaCertPath) {
    const real = realpathSync(config.databaseCaCertPath);
    if ((statSync(real).mode & 0o077) !== 0)
      throw new SupabaseIdentityError('DATABASE_CA_CERT', 'The CA file must be owner-only.');
    ssl.ca = readFileSync(real, 'utf8');
  }
  const db = new Client({ connectionString: config.databaseUrl, ssl });
  await db.connect();
  let snapshot;
  try {
    snapshot = await snapshotWith((sql) => db.query(sql));
  } finally {
    await db.end();
  }
  const body = JSON.stringify(
    {
      projectRef: config.project.stagingProjectRef,
      takenAt: new Date().toISOString(),
      ...snapshot,
    },
    null,
    1,
  );
  writeFileSync(out, body + '\n', { mode: 0o600, flag: 'wx' });
  console.log(
    JSON.stringify(
      {
        status: 'SNAPSHOT_READ_ONLY',
        written: out,
        fileSha256: createHash('sha256')
          .update(body + '\n')
          .digest('hex'),
        schemaVersion: snapshot.schemaVersions.at(-1),
        tables: Object.keys(snapshot.digests).length,
        rows: Object.values(snapshot.digests).reduce((n, d) => n + d.rows, 0),
        mutationsPerformed: false,
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
          message: String(error?.message ?? '').slice(0, 200),
        }),
      );
      process.exit(1);
    },
  );
