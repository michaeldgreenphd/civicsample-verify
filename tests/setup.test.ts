import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseEnv } from 'node:util';

test('local credential setup preserves existing configuration and data and never prints passwords', () => {
  const directory = mkdtempSync(join(tmpdir(), 'verify-local-access-'));
  try {
    const original =
      'VERIFY_DEMO_PASSWORD=synthetic-legacy-password\nVERIFY_DB_DIR=preserved-pilot\nEXISTING_SETTING=keep-me\n';
    writeFileSync(join(directory, '.env.local'), original, { mode: 0o600 });
    writeFileSync(join(directory, 'preserved-record.txt'), 'Synthetic stored response sentinel');
    const script = resolve('scripts/setup.mjs');
    execFileSync(process.execPath, [script], { cwd: directory });
    assert.equal(readFileSync(join(directory, '.env.local'), 'utf8'), original);
    const output = execFileSync(process.execPath, [script, '--individual-credentials'], {
      cwd: directory,
      encoding: 'utf8',
    });
    const configuredText = readFileSync(join(directory, '.env.local'), 'utf8');
    assert.ok(configuredText.startsWith(original));
    const values = parseEnv(configuredText);
    const passwords = [
      'VERIFY_INVESTIGATOR_PASSWORD',
      'VERIFY_REVIEWER_A_PASSWORD',
      'VERIFY_REVIEWER_B_PASSWORD',
      'VERIFY_ADJUDICATOR_PASSWORD',
    ].map((key) => values[key]);
    assert.equal(new Set(passwords).size, 4);
    for (const password of passwords) {
      assert.ok(password);
      assert.match(password, /^[A-Za-z0-9_-]{32}$/);
      assert.equal(output.includes(password), false);
      assert.ok(
        readFileSync(join(directory, '.local/pilot-access.txt'), 'utf8').includes(password),
      );
    }
    assert.equal(statSync(join(directory, '.local/pilot-access.txt')).mode & 0o777, 0o600);
    execFileSync(process.execPath, [script, '--individual-credentials'], { cwd: directory });
    assert.equal(readFileSync(join(directory, '.env.local'), 'utf8'), configuredText);
    assert.equal(
      readFileSync(join(directory, 'preserved-record.txt'), 'utf8'),
      'Synthetic stored response sentinel',
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
