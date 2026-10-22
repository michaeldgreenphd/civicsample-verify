import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const checker = resolve('tools/check_public_repo_leakage_v4.py');
const ignore = readFileSync('.gitignore', 'utf8');
const python = process.env.VERIFY_ANALYSIS_PYTHON || 'python3';
function workspace(run: (root: string) => void) {
  const root = mkdtempSync(join(tmpdir(), 'verify-leakage-v4-'));
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
const markers = {
  heldout: ['HO4-', '123'].join(''),
  reserve: ['HO4R-', '123'].join(''),
  development: ['DEV4-', '1234'].join(''),
  calibration: ['CAL4-', '12'].join(''),
  moduleB: ['MB4-T', '1-12'].join(''),
  frame: ['DU::', 'D123456', '::synthetic'].join(''),
  trial: ['NCT', '12345678'].join(''),
};

test('v4 checker rejects every real-format unit family without echoing identifiers or filenames', () => {
  for (const marker of Object.values(markers))
    workspace((root) => {
      const file = `${marker.replaceAll(':', '-')}.txt`;
      put(root, file, marker);
      const result = scan(root);
      assert.equal(result.status, 1, result.output);
      assert.equal(result.output.includes(marker), false);
      assert.equal(result.output.includes(file), false);
    });
});

test('upstream v2 and v3 content protections remain active alongside v4 headers', () => {
  const contents = [
    ['PCN23-', 'SYNTHETIC'].join(''),
    ['table1_2023_', 'q01_report'].join(''),
    ['POSSIBLE_', 'NEW_ERROR'].join(''),
    ['high_risk_assessment_', 'PROVISIONAL'].join(''),
    ['provisional_curated_status', 'source_stage'].join(','),
    ['case_id_v3', 'selection_stratum'].join(','),
    ['case_id_v4', 'selection_stratum_v4'].join(','),
    ['dev_case_id_v4', 'primary_exclusion_reason'].join(','),
    ['frame_unit_id_v3', 'f_ontology_text_named'].join(','),
    ['module_b_unit_id', 'pipeline_compatibility_status'].join(','),
    JSON.stringify({ prompt_sha256: 'a'.repeat(64), model_id: 'synthetic-model' }),
    ['eyJ' + 'a'.repeat(20), 'b'.repeat(20), 'c'.repeat(20)].join('.'),
  ];
  for (const content of contents)
    workspace((root) => {
      put(root, 'payload.txt', content);
      const result = scan(root);
      assert.equal(result.status, 1, result.output);
      assert.match(result.output, /FORBIDDEN_CONTENT/);
      assert.equal(result.output.includes(content), false);
    });
});

test('only ignored runtime content is excluded; ignored study files still fail tree scan', () => {
  workspace((root) => {
    put(root, '.local/state.txt', markers.development);
    put(root, '.env.local', 'SYNTHETIC_LOCAL_SETTING=private');
    put(root, '.pytest_cache/state.txt', markers.calibration);
    put(root, 'test-results/state.txt', markers.heldout);
    assert.equal(scan(root).status, 0);
    writeFileSync(join(root, '.gitignore'), ignore.replace(/^\.local\/\n/m, ''));
    assert.equal(scan(root).status, 1);
  });
  workspace((root) => {
    put(root, 'data_private/secret.txt', 'synthetic private data');
    const result = scan(root);
    assert.equal(result.status, 1);
    assert.match(result.output, /FORBIDDEN_DIR/);
  });
});

test('indexed objects are checked even when the working file is clean, deleted or ignored', () => {
  for (const name of ['safe.txt', '.local/staged.txt'])
    workspace((root) => {
      put(root, name, markers.development);
      execFileSync('git', ['add', '-f', '--', name], { cwd: root });
      put(root, name, 'synthetic sanitized replacement');
      const result = scan(root);
      assert.equal(result.status, 1);
      assert.match(result.output, /FORBIDDEN_CONTENT/);
      assert.equal(result.output.includes(markers.development), false);
      rmSync(join(root, name));
      assert.equal(scan(root).status, 1);
    });
});

test('environment template exemption is exact and still scans secrets in working tree and index', () => {
  workspace((root) => {
    put(root, '.env.example', 'SYNTHETIC_CONFIG=placeholder');
    assert.equal(scan(root).status, 0);
    put(root, '.env.other.example', 'SYNTHETIC_CONFIG=placeholder');
    assert.equal(scan(root).status, 1);
    rmSync(join(root, '.env.other.example'));
    const secret = ['SUPABASE_SERVICE_ROLE_KEY=', 'synthetic-secret-'.repeat(3)].join('');
    put(root, '.env.example', secret);
    assert.equal(scan(root).status, 1);
    execFileSync('git', ['add', '.env.example'], { cwd: root });
    put(root, '.env.example', 'SYNTHETIC_CONFIG=placeholder');
    const result = scan(root);
    assert.equal(result.status, 1);
    assert.equal(result.output.includes(secret), false);
  });
});

test('private sample deep comparison covers indexed content and never prints source values or paths', () => {
  workspace((root) => {
    const privateDirectory = mkdtempSync(join(tmpdir(), 'verify-private-sample-'));
    try {
      const privatePath = join(privateDirectory, 'private.csv');
      const name = 'Synthetic withheld descriptor';
      writeFileSync(privatePath, `descriptor_ui,nct_id,descriptor_name\nSYNTHETIC_UI,,${name}\n`);
      put(root, 'source.md', name);
      execFileSync('git', ['add', 'source.md'], { cwd: root });
      put(root, 'source.md', 'synthetic cleaned');
      const result = scan(root, ['--private-sample', privatePath]);
      assert.equal(result.status, 1);
      assert.match(result.output, /PRIVATE_SAMPLE_TERM/);
      assert.equal(result.output.includes(name), false);
      assert.equal(result.output.includes(privatePath), false);
      const missing = scan(root, ['--private-sample', join(privateDirectory, 'missing.csv')]);
      assert.equal(missing.status, 1);
      assert.match(missing.output, /PRIVATE_SAMPLE_UNREADABLE/);
      assert.equal(missing.output.includes(privateDirectory), false);
    } finally {
      rmSync(privateDirectory, { recursive: true, force: true });
    }
  });
});
