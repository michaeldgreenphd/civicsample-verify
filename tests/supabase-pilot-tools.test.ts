// The preparation tools of the Supabase synthetic pilot, without any remote call: the read-only
// inspection and the record-level snapshot send nothing but reads inside one read-only transaction
// that is always rolled back, and the bundle verifier accepts an application-written bundle and
// refuses tampered ones.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
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
      assert.equal(sent[0], 'begin transaction read only');
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
