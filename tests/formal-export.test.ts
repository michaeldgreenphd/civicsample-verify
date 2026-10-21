import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  buildV4SyntheticBundle,
  renderV4SyntheticPredictions,
  type V4Row,
  type V4SyntheticExportInput,
} from '../src/lib/formal-export';
import { sha256 } from '../src/lib/export';

// Fixture reader for the exact RFC-style CSV produced by the inspected Python generator.
function parseCsv(text: string): V4Row[] {
  const records: string[][] = [];
  let row: string[] = [],
    field = '',
    quoted = false;
  for (let i = 0; i < text.length; i++) {
    const character = text[i];
    if (character === '"') {
      if (quoted && text[i + 1] === '"') {
        field += '"';
        i++;
      } else quoted = !quoted;
    } else if (!quoted && (character === ',' || character === '\n')) {
      row.push(field);
      field = '';
      if (character === '\n') {
        records.push(row);
        row = [];
      }
    } else field += character;
  }
  assert.equal(quoted, false);
  const columns = records.shift()!;
  return records.map((values) =>
    Object.fromEntries(columns.map((column, i) => [column, values[i] === '' ? null : values[i]])),
  );
}

function fixture(): V4SyntheticExportInput {
  const directory = join(process.cwd(), 'analysis/fixtures');
  const read = (name: string) => parseCsv(readFileSync(join(directory, name), 'utf8'));
  return {
    manifest: JSON.parse(
      readFileSync(join(directory, 'synthetic_v4_bundle.manifest.json'), 'utf8'),
    ),
    independentJudgments: read('synthetic_v4_independent_judgments.csv'),
    adjudicatedReference: read('synthetic_v4_adjudicated_reference.csv'),
    frozenPredictions: read('synthetic_v4_frozen_predictions.csv'),
    integrity: { frozenPredictionsMatch: true, judgmentSnapshotMatch: true },
  };
}

test('formal-format synthetic writer reproduces inspected fixture CSV bytes and freeze hashes', () => {
  const data = fixture();
  const result = buildV4SyntheticBundle(data);
  for (const file of result.files) {
    assert.equal(file.content, readFileSync(join('analysis/fixtures', file.name), 'utf8'));
    assert.equal(file.sha256, sha256(file.content));
    assert.equal(file.rows, parseCsv(file.content).length);
  }
  assert.equal(result.manifest_sha256, sha256(result.manifestContent));
  assert.match(result.notice, /SYNTHETIC ENGINEERING ONLY/);
  const reversed = structuredClone(data);
  reversed.independentJudgments.reverse();
  reversed.adjudicatedReference.reverse();
  reversed.frozenPredictions.reverse();
  assert.deepEqual(buildV4SyntheticBundle(reversed), result);
  assert.equal(
    sha256(renderV4SyntheticPredictions(data.frozenPredictions)),
    data.manifest.frozen_prediction_set_sha256,
  );
});

test('writer preserves quoting, explicit indeterminate decisions and absent unresolved references', () => {
  const data = fixture();
  data.independentJudgments[0].descriptor_name = 'Synthetic, "quoted"\nsecond line';
  const bundle = buildV4SyntheticBundle(data);
  const independent = parseCsv(bundle.files[0].content);
  assert.equal(independent[0].descriptor_name, data.independentJudgments[0].descriptor_name);
  const reference = parseCsv(bundle.files[1].content);
  assert.ok(reference.some((row) => row.adjudicated_decision === 'INSUFFICIENT_INFORMATION'));
  const unresolved = reference.filter((row) => row.adjudication_status === 'UNRESOLVED_ESCALATED');
  assert.ok(unresolved.length > 0);
  assert.ok(unresolved.every((row) => row.adjudicated_decision === null));
});

test('writer refuses pilot/real data, mismatched snapshots, missing metadata and changed frozen files', () => {
  const mutate = (change: (input: V4SyntheticExportInput) => void, message: RegExp) => {
    const input = fixture();
    change(input);
    assert.throws(() => buildV4SyntheticBundle(input), message);
  };
  mutate((input) => {
    input.manifest.is_synthetic_fixture = false;
  }, /locked synthetic/);
  mutate((input) => {
    input.manifest.reference_locked = false;
  }, /locked synthetic/);
  mutate((input) => {
    input.integrity.judgmentSnapshotMatch = false;
  }, /integrity/);
  mutate((input) => {
    input.integrity.frozenPredictionsMatch = false;
  }, /integrity/);
  mutate((input) => {
    delete input.manifest.rubric_sha256;
  }, /metadata/);
  mutate((input) => {
    input.manifest.frozen_sample_case_list_sha256 = 'changed';
  }, /Case list/);
  mutate((input) => {
    input.frozenPredictions[0].tier0_binary = 'INCLUDE';
  }, /Prediction file/);
  mutate((input) => {
    input.independentJudgments.pop();
    input.independentJudgments.pop();
  }, /populations/);
  mutate((input) => {
    input.independentJudgments.push(input.independentJudgments[0]);
  }, /Duplicate/);
  mutate((input) => {
    input.independentJudgments[0].record_category = 'SYNTHETIC_PILOT';
  }, /pilot records/);
  mutate((input) => {
    input.independentJudgments[0].nct_id = 'NCT' + '12345678';
  }, /registry/);
  mutate((input) => {
    input.frozenPredictions[0].sampling_weight = 1 as unknown as string;
  }, /database text/);
});

test(
  'TypeScript-written v4 bundle passes Python integrity validation and paired synthetic analysis',
  {
    skip:
      !process.env.VERIFY_ANALYSIS_PYTHON &&
      'Set VERIFY_ANALYSIS_PYTHON to a Python environment with analysis/requirements.txt',
  },
  () => {
    const directory = mkdtempSync(join(tmpdir(), 'verify-v4-roundtrip-'));
    try {
      const input = fixture();
      const result = buildV4SyntheticBundle(input);
      for (const file of result.files)
        writeFileSync(join(directory, file.name), file.content, 'utf8');
      const manifest = join(directory, 'bundle.manifest.json');
      writeFileSync(manifest, result.manifestContent, 'utf8');
      const code = [
        'import json, sys',
        'from analysis import performance_analysis_v4 as pa4',
        'from analysis import performance_analysis_v3 as pa3',
        'res = pa4.run(sys.argv[1], allow_synthetic=True)',
        "assert res['is_synthetic_fixture'] is True",
        "assert 'SYNTHETIC ENGINEERING ONLY' in res['notice']",
        "assert len(res['integrity_checks_passed']) == 8",
        "for level in ('DESCRIPTOR_LEVEL', 'TRIAL_LEVEL'):",
        ' for rule in pa3.DENOMINATOR_RULES:',
        "  block=res['accuracy'][level][rule]",
        "  assert block['original_technical']['n_binary_pairs'] == block['curated_v11']['n_binary_pairs']",
        "print(json.dumps({'passed': True, 'integrity_checks': len(res['integrity_checks_passed'])}))",
      ].join('\n');
      const output = execFileSync(process.env.VERIFY_ANALYSIS_PYTHON!, ['-c', code, manifest], {
        encoding: 'utf8',
        cwd: process.cwd(),
        timeout: 60000,
      });
      assert.deepEqual(JSON.parse(output), { passed: true, integrity_checks: 8 });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
