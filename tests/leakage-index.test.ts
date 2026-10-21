import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { scanRepository } from '../scripts/check-fixtures.mjs';

const scanner = resolve('scripts/check-fixtures.mjs');
function repository(run: (root: string, git: (...args: string[]) => void) => void) {
  const root = mkdtempSync(join(tmpdir(), 'verify-index-test-'));
  const git = (...args: string[]) => {
    execFileSync('git', args, { cwd: root, stdio: 'ignore' });
  };
  try {
    git('init', '--quiet');
    run(root, git);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function assertSafeCliFailure(root: string, payload: string) {
  const result = spawnSync(process.execPath, [scanner, root], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.ok(
    !`${result.stdout}${result.stderr}`.includes(payload),
    'Diagnostic output must not echo the payload',
  );
}

test('scans staged blob when the working tree was replaced with harmless content', () => {
  repository((root, git) => {
    const payload = 'NCT' + '12345678';
    const file = join(root, 'fixture.txt');
    writeFileSync(file, payload);
    git('add', '--', 'fixture.txt');
    writeFileSync(file, 'SYNTHETIC fixture only');
    const findings = scanRepository(root);
    assert.ok(
      findings.some((item) => item.source === 'index' && item.rule === 'registry identifier'),
    );
    assert.ok(!JSON.stringify(findings).includes(payload));
    assertSafeCliFailure(root, payload);
    rmSync(file);
    assert.ok(
      scanRepository(root).some(
        (item) => item.source === 'index' && item.rule === 'registry identifier',
      ),
    );
  });
});

test('staged symlink remains blocked after replacement with a regular working file', () => {
  repository((root, git) => {
    const payload = 'private-target-' + 'not-for-diagnostics';
    const file = join(root, 'fixture-link');
    symlinkSync(payload, file);
    git('add', '--', 'fixture-link');
    rmSync(file);
    writeFileSync(file, 'Synthetic replacement');
    assert.ok(
      scanRepository(root).some(
        (item) => item.source === 'index' && item.rule === 'symlink requires explicit review',
      ),
    );
    assertSafeCliFailure(root, payload);
  });
});

test('staged environment files and excluded runtime directories cannot hide behind ignore rules', () => {
  for (const filename of ['.env.local', '.local/db', 'node_modules/fixture.txt']) {
    repository((root, git) => {
      writeFileSync(join(root, '.gitignore'), '.env.local\n.local/\nnode_modules/\n');
      const file = join(root, filename);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, 'Synthetic runtime fixture');
      git('add', '--force', '--', filename);
      rmSync(file);
      const findings = scanRepository(root);
      assert.ok(
        findings.some(
          (item) =>
            item.source === 'index' &&
            ['environment secrets file', 'excluded runtime path staged in index'].includes(
              item.rule,
            ),
        ),
        filename,
      );
      assertSafeCliFailure(root, 'Synthetic runtime fixture');
    });
  }
});

test('clean staged synthetic files and ignored untracked runtime files pass', () => {
  repository((root, git) => {
    writeFileSync(join(root, '.gitignore'), '.env.local\n.local/\n');
    writeFileSync(join(root, 'fixture with spaces.txt'), 'SYNTHETIC ENGINEERING ONLY TESTFX-0001');
    git('add', '--', '.gitignore', 'fixture with spaces.txt');
    writeFileSync(join(root, '.env.local'), 'LOCAL_SECRET=local-only');
    mkdirSync(join(root, '.local'));
    writeFileSync(join(root, '.local', 'db'), 'local-only');
    assert.deepEqual(scanRepository(root), []);
    const result = spawnSync(process.execPath, [scanner, root], { encoding: 'utf8' });
    assert.equal(result.status, 0);
  });
});

test('index filename diagnostics redact identifiers and support unusual filenames', () => {
  repository((root, git) => {
    const payload = 'NCT' + '87654321';
    const filename = `fixture\t${payload}\n.txt`;
    writeFileSync(join(root, filename), 'Synthetic fixture');
    git('add', '--', filename);
    rmSync(join(root, filename));
    const findings = scanRepository(root);
    assert.ok(
      findings.some((item) => item.source === 'index' && item.rule === 'registry identifier'),
    );
    assert.ok(!JSON.stringify(findings).includes(payload));
    assertSafeCliFailure(root, payload);
  });
});
