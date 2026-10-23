// The preparation tools of the Supabase synthetic pilot, without any remote call: the read-only
// inspection and the record-level snapshot send nothing but reads inside one read-only transaction
// that is always rolled back, and the bundle verifier accepts an application-written bundle and
// refuses tampered ones.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { inspectWith, READ_ONLY_STATEMENT } from '../scripts/supabase-readonly-inspect.mjs';
import { snapshotWith } from '../scripts/supabase-readonly-snapshot.mjs';
import { verifyMu7Bundle } from '../scripts/verify-mu7-bundle';
import { readMu7Bundle } from '../src/server/mu7-core';
import { mu7SqlData } from '../src/server/mu7';
import { as, newDatabase, signedOffPilot } from './mu7-fixture';

test('inspection and snapshot send only reads, inside one read-only transaction, rolled back', async () => {
  const db = await newDatabase();
  try {
    await db.exec(
      'create table if not exists auth.mfa_factors (id uuid, user_id uuid, status text, factor_type text)',
    );
    for (const run of [inspectWith, snapshotWith]) {
      const sent: string[] = [];
      const result = await run(async (sql: string) => {
        sent.push(sql);
        return db.query(sql);
      });
      assert.equal(result.readOnly, true);
      assert.equal(sent[0], 'begin transaction isolation level repeatable read read only');
      assert.equal(sent.at(-1), 'rollback');
      assert.ok(
        sent.every((s) => READ_ONLY_STATEMENT.test(s)),
        'only reads were sent',
      );
      assert.ok(
        !sent.some((s) =>
          /^\s*(insert|update|delete|alter|create|drop|grant|revoke|truncate)\b/i.test(s),
        ),
      );
    }
    for (const write of [
      'insert into x values (1)',
      'update x set a = 1',
      'delete from x',
      'grant all on x to y',
    ])
      assert.doesNotMatch(write, READ_ONLY_STATEMENT);
    // A failure inside the block still ends it with rollback.
    const sent: string[] = [];
    await assert.rejects(
      inspectWith(async (sql: string) => {
        sent.push(sql);
        if (/pg_extension/.test(sql)) throw new Error('synthetic failure');
        return db.query(sql);
      }),
    );
    assert.equal(sent.at(-1), 'rollback');
  } finally {
    await db.close();
  }
});

test('the bundle verifier accepts an application-written pilot bundle and refuses tampering', async () => {
  const { db } = await signedOffPilot({ stopAfter: 'pilotLock' });
  const dir = mkdtempSync(join(tmpdir(), 'verify-bundle-check-'));
  try {
    const bundle = await as(db, 'inv', () =>
      readMu7Bundle(
        mu7SqlData({ query: (sql, params) => db.query(sql, params) }),
        'PILOT',
        'e'.repeat(40),
        true,
      ),
    );
    const write = (d: string) => {
      mkdirSync(d, { recursive: true });
      for (const f of bundle.files) writeFileSync(join(d, f.name), f.content);
      writeFileSync(join(d, 'manifest.json'), bundle.manifestText);
    };
    write(join(dir, 'ok'));
    const ok = verifyMu7Bundle(join(dir, 'ok'), bundle.manifestSha256);
    assert.deepEqual(ok.problems, []);
    assert.equal(ok.ok, true);
    assert.equal(ok.mode, 'PILOT');
    // A changed answer, a different registered manifest, and a removed column are each refused.
    write(join(dir, 'tampered'));
    const p = join(dir, 'tampered', 'final_reference.csv');
    writeFileSync(p, readFileSync(p, 'utf8').replace('CONCORDANT_AGREE', 'CONCORDANT_DISAGREE'));
    assert.match(
      verifyMu7Bundle(join(dir, 'tampered')).problems.join(';'),
      /final_reference\.csv: SHA-256 differs/,
    );
    assert.match(
      verifyMu7Bundle(join(dir, 'ok'), 'f'.repeat(64)).problems.join(';'),
      /registered manifest hash/,
    );
    write(join(dir, 'columns'));
    const u = join(dir, 'columns', 'units.csv');
    writeFileSync(u, readFileSync(u, 'utf8').replace('packet_sha256,', ''));
    assert.match(
      verifyMu7Bundle(join(dir, 'columns')).problems.join(';'),
      /units\.csv: columns differ/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await db.close();
  }
});

test('equal data gives an equal snapshot digest whatever the physical row order', async () => {
  const digests: string[] = [];
  for (const order of [
    ['alpha', 'beta', 'gamma'],
    ['gamma', 'alpha', 'beta'],
  ]) {
    const db = await newDatabase();
    try {
      await db.exec('create table public.zz_order_probe (v text)');
      for (const v of order) await db.query('insert into public.zz_order_probe values ($1)', [v]);
      const s = await snapshotWith((sql: string) => db.query(sql));
      digests.push((s.digests as Record<string, { sha256: string }>).zz_order_probe.sha256);
    } finally {
      await db.close();
    }
  }
  assert.equal(digests[0], digests[1]);
});

test('the live v7 test refuses a sign-in file inside a Git repository, before any request', () => {
  const repo = mkdtempSync(join(tmpdir(), 'verify-signin-in-repo-'));
  try {
    execFileSync('git', ['init', '--quiet'], { cwd: repo });
    for (const name of ['web.json', 'signin.json']) {
      writeFileSync(join(repo, name), JSON.stringify({ project: {}, accounts: [] }), {
        mode: 0o600,
      });
      chmodSync(join(repo, name), 0o600);
    }
    const r = spawnSync(
      process.execPath,
      ['--import', 'tsx', '--test', 'tests/staging-live-v7.test.ts'],
      {
        encoding: 'utf8',
        env: {
          // Run as its own test process, not as a subtest reporting to this runner.
          ...(Object.fromEntries(
            Object.entries(process.env).filter(([k]) => k !== 'NODE_TEST_CONTEXT'),
          ) as NodeJS.ProcessEnv),
          VERIFY_SUPABASE_WEB_CONFIG: join(repo, 'web.json'),
          VERIFY_SUPABASE_SIGNIN: join(repo, 'signin.json'),
          VERIFY_STAGING_V7_PHASE: 'restrictions',
        },
      },
    );
    assert.notEqual(r.status, 0);
    assert.match(r.stdout + r.stderr, /private files must live outside every Git repository/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('the backup passes the connection to pg_dump through the environment only, with TLS verified', async () => {
  const { libpqEnvironment } = await import('../scripts/supabase-backup.mjs');
  const env = libpqEnvironment(
    'postgresql://postgres.abcdefghijklmnopqrst:synthetic%2Fsecret@aws-0-eu-west-1.pooler.supabase.com:5432/postgres',
    '/abs/private/ca.crt',
  );
  assert.equal(env.PGHOST, 'aws-0-eu-west-1.pooler.supabase.com');
  assert.equal(env.PGPORT, '5432');
  assert.equal(env.PGUSER, 'postgres.abcdefghijklmnopqrst');
  assert.equal(env.PGPASSWORD, 'synthetic/secret');
  assert.equal(env.PGDATABASE, 'postgres');
  assert.equal(env.PGSSLMODE, 'verify-full');
  assert.equal(env.PGSSLROOTCERT, '/abs/private/ca.crt');
});
