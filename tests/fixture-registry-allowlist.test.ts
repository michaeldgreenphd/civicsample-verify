// The fixture guard's registry-identifier rule allows only reviewed identifiers, each in its own
// named vendored file. These tests pin that: every occurrence is checked, an approved value is
// refused anywhere else, names are never allowlisted, and staged and working-tree contents are
// both scanned. No registry-format literal appears in this source (it is scanned too).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { scanRepository } from '../scripts/check-fixtures.mjs';

const id = (digits: string) => `NCT${digits}`;
const SUITE = 'tests/handoff/v7.mjs';
const PILOT = 'tests/handoff/fixtures/v7/SYNTHETIC_PILOT_UNITS_v7.json';
const CHECKER = 'tools/check_public_repo_leakage_v7.py';
const APPROVED_PILOT = id('99000777'); // approved for PILOT (and SUITE) only
const APPROVED_SUITE_ONLY = id('99000102'); // approved for SUITE only
const NEGATIVE_CONTROL = id('01234567'); // approved for CHECKER only
const UNAPPROVED_SYNTHETIC = id('99000888'); // reserved form, never reviewed
const UNAPPROVED_REAL_FORM = id('12345678');

type Finding = { file: string; rule: string; source: string };
const registryFindings = (root: string) =>
  (scanRepository(root) as Finding[]).filter((f) => f.rule === 'registry identifier');

function repository(run: (root: string, git: (...args: string[]) => void) => void) {
  const root = mkdtempSync(join(tmpdir(), 'verify-allowlist-test-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
  try {
    git('init', '--quiet');
    run(root, git);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
function put(root: string, path: string, content: string) {
  const file = join(root, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

test('approved identifiers pass in their own file, staged and in the working tree', () => {
  repository((root, git) => {
    put(root, PILOT, `{"note": "SYNTHETIC ${APPROVED_PILOT}"}`);
    put(root, SUITE, `// SYNTHETIC ${APPROVED_PILOT} ${APPROVED_SUITE_ONLY}`);
    put(root, CHECKER, `# negative control ${NEGATIVE_CONTROL}`);
    git('add', '--', PILOT, SUITE, CHECKER);
    assert.deepEqual(registryFindings(root), []);
  });
});

test('an unapproved identifier fails even inside an allowed fixture or checker file', () => {
  for (const [path, approved] of [
    [PILOT, APPROVED_PILOT],
    [SUITE, APPROVED_SUITE_ONLY],
    [CHECKER, NEGATIVE_CONTROL],
  ]) {
    for (const extra of [
      UNAPPROVED_SYNTHETIC,
      UNAPPROVED_REAL_FORM,
      UNAPPROVED_SYNTHETIC.toLowerCase(),
    ]) {
      repository((root) => {
        // The approved value comes first, so a first-match check would wrongly pass.
        put(root, path, `SYNTHETIC ${approved} then ${extra}`);
        const found = registryFindings(root);
        assert.ok(
          found.some((f) => f.file === path && f.source === 'working-tree'),
          `${path} with an extra identifier must fail`,
        );
        assert.ok(!JSON.stringify(found).includes(extra), 'diagnostics never echo the value');
      });
    }
  }
});

test('an approved identifier fails outside the file it was approved for', () => {
  for (const [path, value] of [
    ['docs/notes.md', APPROVED_PILOT],
    ['tests/handoff/v6.mjs', APPROVED_PILOT],
    [PILOT, APPROVED_SUITE_ONLY], // approved for the suite, not for the pilot fixture
    [SUITE, NEGATIVE_CONTROL], // the checker's control value, not the suite's
    ['tools/check_public_repo_leakage_v6.py', NEGATIVE_CONTROL],
    [`nested/${PILOT}`, APPROVED_PILOT], // same file name under another directory
  ]) {
    repository((root) => {
      put(root, path, `SYNTHETIC ${value}`);
      assert.ok(
        registryFindings(root).some((f) => f.file === path),
        `${value.slice(0, 3)}… must fail in ${path}`,
      );
    });
  }
});

test('an identifier in a file name is never allowed, even an approved value', () => {
  repository((root) => {
    const path = `tests/handoff/fixtures/v7/${APPROVED_PILOT}.json`;
    put(root, path, '{"note": "SYNTHETIC"}');
    assert.ok(registryFindings(root).length > 0);
  });
});

test('staged contents are checked when the working tree is clean, and the reverse', () => {
  repository((root, git) => {
    put(root, PILOT, `{"note": "SYNTHETIC ${APPROVED_PILOT} ${UNAPPROVED_SYNTHETIC}"}`);
    git('add', '--', PILOT);
    put(root, PILOT, `{"note": "SYNTHETIC ${APPROVED_PILOT}"}`);
    const found = registryFindings(root);
    assert.ok(found.some((f) => f.source === 'index' && f.file === PILOT));
    assert.ok(!found.some((f) => f.source === 'working-tree'));
  });
  repository((root, git) => {
    put(root, PILOT, `{"note": "SYNTHETIC ${APPROVED_PILOT}"}`);
    git('add', '--', PILOT);
    put(root, PILOT, `{"note": "SYNTHETIC ${APPROVED_PILOT} ${UNAPPROVED_REAL_FORM}"}`);
    const found = registryFindings(root);
    assert.ok(found.some((f) => f.source === 'working-tree' && f.file === PILOT));
    assert.ok(!found.some((f) => f.source === 'index'));
  });
});

test('the other leakage rules stay active inside allowlisted files', () => {
  repository((root) => {
    const jwtLike = ['eyJ', 'a'.repeat(20), '.', 'b'.repeat(20), '.', 'c'.repeat(20)].join('');
    put(root, PILOT, `{"note": "SYNTHETIC ${APPROVED_PILOT} ${jwtLike}"}`);
    const rules = (scanRepository(root) as Finding[]).map((f) => f.rule);
    assert.ok(rules.includes('encoded credential'));
    assert.ok(!rules.includes('registry identifier'));
  });
});
