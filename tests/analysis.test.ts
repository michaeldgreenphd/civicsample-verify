import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildPilotExport, canonicalJson, sha256 } from '../src/lib/export';
import type { ExportData } from '../src/lib/types';
// JavaScript scanner intentionally also runs before TypeScript dependencies are installed.
import { scanRepository } from '../scripts/check-fixtures.mjs';

function fixture(): ExportData {
  return {
    campaign: { id: 'synthetic-pilot', title: 'SYNTHETIC ENGINEERING ONLY', state: 'LOCKED', mode: 'SYNTHETIC_PILOT', caseCount: 2, completed: 4, total: 4 },
    configuration: { tierVersion: 'PENDING', tierState: 'PROPOSED', rubricState: 'PROPOSED', sampleState: 'PROPOSED', analysisPlanState: 'PROPOSED', adjudicationScope: 'ALL_CASE_LEVELS' },
    cases: [{ caseId: 'SYN-002', area: 'fictional', evidenceHash: sha256('fixture two') }, { caseId: 'SYN-001', area: 'fictional', evidenceHash: sha256('fixture one') }],
    judgments: [
      { id: 'review-2', caseId: 'SYN-001', level: 'DESCRIPTOR_LEVEL', decision: 'INSUFFICIENT_INFORMATION', rationale: 'Synthetic revised record', uncertain: true, context: '', packetProblem: false, submittedAt: '2030-01-02T00:00:00Z', reviewerSlot: 'A', version: 2 },
      { id: 'review-1', caseId: 'SYN-001', level: 'DESCRIPTOR_LEVEL', decision: 'INCLUDE', rationale: 'Synthetic initial record', uncertain: false, context: '', packetProblem: false, submittedAt: '2030-01-01T00:00:00Z', reviewerSlot: 'A', version: 1 },
    ],
    adjudications: [{ id: 'reference-1', status: 'RESOLVED', caseId: 'SYN-001', level: 'DESCRIPTOR_LEVEL', decision: 'EXCLUDE', rationale: 'Independent synthetic adjudication', uncertain: false, context: '', packetProblem: false, submittedAt: '2030-01-03T00:00:00Z' }],
    provenance: { source: 'fictional engineering fixture' },
  };
}

test('pilot archive is deterministic, hashes exact UTF-8 contents, and preserves initial judgments', () => {
  const data = fixture();
  const first = buildPilotExport(data);
  const shuffled = structuredClone(data);
  shuffled.cases.reverse(); shuffled.judgments.reverse();
  assert.equal(canonicalJson(first), canonicalJson(buildPilotExport(shuffled)));
  assert.equal(first.manifest_sha256, sha256(canonicalJson(first.manifest)));
  for (const file of first.files) {
    assert.equal(sha256(file.content), file.sha256);
    assert.notEqual(sha256(file.content + ' '), file.sha256);
    assert.equal(first.manifest.files.find(item => item.role === file.role)?.sha256, file.sha256);
  }
  const raw = JSON.parse(first.files.find(file => file.role === 'independent_judgments')!.content);
  assert.deepEqual(raw.map((row: { decision: string }) => row.decision), ['INCLUDE', 'INSUFFICIENT_INFORMATION']);
  assert.equal(JSON.parse(first.files.find(file => file.role === 'adjudicated_reference')!.content)[0].decision, 'EXCLUDE');
  assert.equal(first.manifest.analysis_eligible, false);
  assert.equal(first.manifest.clinical_metrics, null);
  assert.equal(first.manifest.frozen_prediction_set, null);
  assert.equal(first.manifest.sampling_weights, null);
  assert.match(first.manifest.notice, /SYNTHETIC ENGINEERING ONLY/);
});

test('archive refuses open campaigns, foreign IDs, duplicate cases, and invalid JSON values', () => {
  const data = fixture(); data.campaign.state = 'OPEN';
  assert.throws(() => buildPilotExport(data), /locked synthetic/);
  data.campaign.state = 'LOCKED'; data.judgments[0].caseId = 'SYN-999';
  assert.throws(() => buildPilotExport(data), /outside/);
  const duplicate = fixture(); duplicate.cases.push(duplicate.cases[0]);
  assert.throws(() => buildPilotExport(duplicate), /unique synthetic/);
  assert.equal(canonicalJson({ explicit: null, value: 'INSUFFICIENT_INFORMATION' }), '{\n  "explicit": null,\n  "value": "INSUFFICIENT_INFORMATION"\n}\n');
  assert.throws(() => canonicalJson({ missing: undefined }), /unsupported/);
  assert.throws(() => canonicalJson({ value: NaN }), /unsupported/);
});

test('leakage scanner rejects injected identifiers, secrets, private paths and filenames without echoing values', () => {
  const dir = mkdtempSync(join(tmpdir(), 'verify-leak-test-'));
  try {
    const forbidden = [
      'NCT' + '12345678',
      'HO4-' + 'REAL0001',
      'HO4R-' + 'REAL0001',
      ['claude', 'code', 'handoff'].join('_') + '_v4.zip',
      ['FROZEN', 'VERSIONS'].join('_') + '.json',
      '/Users/example/Library/' + 'CloudStorage/private/source.csv',
      'ghp_' + 'a'.repeat(36),
      '-----BEGIN ' + 'PRIVATE KEY-----',
    ];
    for (const payload of forbidden) {
      writeFileSync(join(dir, 'injected.txt'), payload);
      const findings = scanRepository(dir);
      assert.ok(findings.length > 0, 'Injection should fail scan');
      assert.ok(!JSON.stringify(findings).includes(payload), 'Diagnostics must not echo secrets');
    }
    writeFileSync(join(dir, 'injected.txt'), 'SYNTHETIC ENGINEERING ONLY HO4-TESTFX-0001 SYN-NCT-001');
    assert.deepEqual(scanRepository(dir), []);
    mkdirSync(join(dir, 'node_modules'));
    writeFileSync(join(dir, 'node_modules', 'third-party.txt'), forbidden[0]);
    assert.deepEqual(scanRepository(dir), []);
    writeFileSync(join(dir, '.env.local'), 'LOCAL_SECRET=fixture');
    assert.ok(scanRepository(dir).some((item) => item.rule === 'environment secrets file'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
