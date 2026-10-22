import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const checker = resolve('tools/check_public_repo_leakage_v5.py');
const ignore = readFileSync('.gitignore', 'utf8');
const python = process.env.VERIFY_ANALYSIS_PYTHON || 'python3';
function workspace(run: (root: string) => void) {
  const root = mkdtempSync(join(tmpdir(), 'verify-leakage-v5-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: root });
    writeFileSync(join(root, '.gitignore'), ignore);
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
function put(root: string, file: string, content: string) {
  mkdirSync(dirname(join(root, file)), { recursive: true });
  writeFileSync(join(root, file), content);
}
function scan(root: string, extra: string[] = []) {
  const result = spawnSync(python, [checker, '--root', root, '--tree', ...extra], {
    encoding: 'utf8',
  });
  assert.equal(result.error, undefined);
  return { status: result.status, output: result.stdout + result.stderr };
}
// Real-format v5 identifiers are assembled at runtime so this test file never contains one.
const real = { formal: ['TLV5-', '123'].join(''), calibration: ['CAL5-', '12'].join('') };
const synthetic = ['SYN-TLV5-001', 'TLV5-TESTFX-0001', 'CAL5-TESTFX-01', 'EX5-01'];

test('v5 checker rejects real-format v5 case identifiers without echoing them', () => {
  for (const marker of Object.values(real))
    workspace((root) => {
      put(root, 'note.txt', `synthetic note mentioning ${marker}`);
      const result = scan(root);
      assert.equal(result.status, 1, result.output);
      assert.match(result.output, /FORBIDDEN_CONTENT/);
      assert.equal(result.output.includes(marker), false);
    });
});

test('v5 checker accepts synthetic pilot, test-fixture, calibration-fixture and training identifiers', () => {
  workspace((root) => {
    put(root, 'synthetic.md', `Synthetic identifiers: ${synthetic.join(', ')}`);
    put(
      root,
      'cases.csv',
      `case_id,note\n${synthetic.map((id) => `${id},synthetic`).join('\n')}\n`,
    );
    const result = scan(root);
    assert.equal(result.status, 0, result.output);
  });
});

test('v5 SVG content cannot bypass identifier or private-sample scans', () => {
  workspace((root) => {
    put(root, 'diagram.svg', `<svg><text>${real.formal}</text></svg>`);
    const direct = scan(root);
    assert.equal(direct.status, 1);
    assert.equal(direct.output.includes(real.formal), false);
    const privateDirectory = mkdtempSync(join(tmpdir(), 'verify-private-svg-'));
    try {
      const privatePath = join(privateDirectory, 'private.csv');
      const marker = 'SYN-NCT-9988';
      writeFileSync(privatePath, `case_id_v5,nct_id\nEX5-01,${marker}\n`);
      put(root, 'diagram.svg', `<svg><text>${marker}</text></svg>`);
      execFileSync('git', ['add', 'diagram.svg'], { cwd: root });
      put(root, 'diagram.svg', '<svg><text>Synthetic</text></svg>');
      const deep = scan(root, ['--private-sample', privatePath]);
      assert.equal(deep.status, 1);
      assert.match(deep.output, /PRIVATE_SAMPLE_TERM/);
      assert.equal(deep.output.includes(marker), false);
    } finally {
      rmSync(privateDirectory, { recursive: true, force: true });
    }
  });
});

test('v5 checker rejects private worked-example and sample file names and the v5 sample header', () => {
  const names = [
    'worked_examples_v5.json',
    'data/REVIEW_SAMPLE_v5_PROPOSED.csv',
    'FROZEN_LABELS_v5_PROPOSED.csv',
  ];
  for (const name of names)
    workspace((root) => {
      put(root, name, 'synthetic placeholder');
      const result = scan(root);
      assert.equal(result.status, 1, result.output);
      assert.match(result.output, /FORBIDDEN_FILE/);
      assert.equal(result.output.includes(name), false);
    });
  workspace((root) => {
    const header = ['case_id_v5', 'nct_id', 'stratum_v5'].join(',');
    put(root, 'sample.csv', `${header}\nSYN-TLV5-001,SYN-NCT-0001,synthetic\n`);
    const result = scan(root);
    assert.equal(result.status, 1, result.output);
    assert.match(result.output, /FORBIDDEN_CONTENT/);
    assert.equal(result.output.includes(header), false);
  });
});

test('upstream v4 rules remain active under the v5 checker', () => {
  workspace((root) => {
    put(root, 'legacy.txt', ['HO4-', '123'].join(''));
    const result = scan(root);
    assert.equal(result.status, 1, result.output);
    assert.match(result.output, /FORBIDDEN_CONTENT/);
  });
});

test('v5 deep check counts private NCT and case identifiers without printing them', () => {
  workspace((root) => {
    const privateDirectory = mkdtempSync(join(tmpdir(), 'verify-private-v5-'));
    try {
      const privatePath = join(privateDirectory, 'private.csv');
      const id = ['SYN-TLV5-', '777'].join('');
      writeFileSync(privatePath, `case_id_v5,nct_id\n${id},SYN-NCT-7777\nEX5-01,SYN-NCT-7778\n`);
      put(root, 'source.md', `synthetic mention of ${id}`);
      const result = scan(root, ['--private-sample', privatePath]);
      assert.equal(result.status, 1, result.output);
      assert.match(result.output, /PRIVATE_SAMPLE_TERM/);
      assert.equal(result.output.includes(id), false);
      assert.equal(result.output.includes(privatePath), false);
      put(root, 'source.md', 'synthetic mention of EX5-01 only');
      assert.equal(scan(root, ['--private-sample', privatePath]).status, 0);
    } finally {
      rmSync(privateDirectory, { recursive: true, force: true });
    }
  });
});

test('current repository tree scans clean under the v5 checker', () => {
  const result = spawnSync(python, [checker, '--tree'], { encoding: 'utf8' });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
