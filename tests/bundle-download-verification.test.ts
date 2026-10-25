// Transport verification only. Fictional one-row exports are not study fixtures or outcomes.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { buildMu7Bundle, type Mu7BundleSources } from '../src/lib/mu7-export';
import { verifyMu7Bundle } from '../scripts/verify-mu7-bundle';
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const id = 'MU7-AREA-ONCOLOGY-999';
function fixture(mode: 'PILOT' | 'FORMAL' = 'FORMAL', overlap = 'ONE_PER_TRIAL') {
  const design = { design_version: 'SYN-8-1-DOWNLOAD', overlap_setting: overlap };
  const source =
    'unit_id,stratum,N_h,n_h,nominal_probability_n_h_over_N_h,pi_mc_ONE_PER_TRIAL,mc_se,pattern_group_units,weight_ONE_PER_TRIAL,ratio_mc_to_nominal\n' +
    `${id},AREA_ONCOLOGY,100,5,0.05,0.055000000000000005,3e-6,1,18,1.1\n`;
  const body = `${id},0.055000000000000005,0.000003\n`;
  const b = {
    binding_version: 'mu81-probability-1',
    design_version: design.design_version,
    method: 'MONTE_CARLO_ONE_PER_TRIAL',
    replicates: 20000,
    seed: 123,
    file_sha256: sha(source),
    rows_sha256: sha(body),
  };
  const digest = sha(Object.values(b).join('|'));
  const sources: Mu7BundleSources = {
    mode,
    appGitSha: 'd'.repeat(40),
    design,
    freeze:
      mode === 'FORMAL'
        ? { probability_binding_sha256: overlap === 'ONE_PER_TRIAL' ? digest : null }
        : null,
    snapshot: null,
    lockedAt: '2026-01-01T00:00:00Z',
    nUnitsLocked: 1,
    syntheticDatabase: true,
    rows: {
      units: [{ unit_id: id, mode }],
      unit_design: [],
      independent_judgments: [],
      final_reference: [],
    },
    subtypes: [],
    probability: {
      ...b,
      binding_sha256: digest,
      canonical_csv: 'unit_id,pi_i,mc_standard_error\n' + body,
      source_csv: source,
    },
  };
  const bundle = buildMu7Bundle(sources);
  const dir = mkdtempSync(join(tmpdir(), 'verify-download-'));
  for (const f of bundle.files) writeFileSync(join(dir, f.name), f.content);
  writeFileSync(join(dir, 'manifest.json'), bundle.manifestText);
  return { dir, bundle, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
type TestManifest = {
  app_git_sha: string;
  vocabulary_version: string;
  bundle_format_version: string;
  files: Record<string, string>;
  row_counts: Record<string, number>;
  freeze: { probability_binding_sha256: string };
  probability_binding: {
    seed: number;
    replicates: number;
    file_sha256: string;
    binding_sha256: string;
    [key: string]: string | number;
  };
};
function editManifest(dir: string, change: (m: TestManifest) => void) {
  // test-only mutations
  const p = join(dir, 'manifest.json');
  const m = JSON.parse(readFileSync(p, 'utf8'));
  change(m);
  writeFileSync(p, JSON.stringify(m));
}
function editFile(dir: string, name: string, change: (s: string) => string) {
  const p = join(dir, name);
  const s = change(readFileSync(p, 'utf8'));
  writeFileSync(p, s);
  editManifest(dir, (m) => {
    m.files[name] = sha(s);
  });
}
for (const [mode, overlap] of [
  ['PILOT', 'ALLOW'],
  ['PILOT', 'ONE_PER_TRIAL'],
  ['FORMAL', 'ALLOW'],
  ['FORMAL', 'ONE_PER_TRIAL'],
] as const)
  test(`download verification supports bundle 8.1 ${mode} ${overlap}`, () => {
    const f = fixture(mode, overlap);
    try {
      const r = verifyMu7Bundle(f.dir, f.bundle.manifestSha256);
      assert.deepEqual(r.problems, []);
      assert.equal(r.registrationVerified, true);
      assert.equal(verifyMu7Bundle(f.dir).registrationVerified, false);
    } finally {
      f.cleanup();
    }
  });
const mutations: [string, (dir: string) => void][] = [
  ['missing subtype', (d) => unlinkSync(join(d, 'subtype_observations.csv'))],
  [
    'changed source bytes',
    (d) => editFile(d, 'probability_source.csv', (s) => s.replace('3e-6', '4e-6')),
  ],
  [
    'changed canonical rows',
    (d) => editFile(d, 'probabilities.csv', (s) => s.replace('0.000003', '0.000004')),
  ],
  [
    'missing probability row',
    (d) => editFile(d, 'probabilities.csv', (s) => s.split('\n')[0] + '\n'),
  ],
  [
    'changed freeze',
    (d) =>
      editManifest(d, (m) => {
        m.freeze.probability_binding_sha256 = 'f'.repeat(64);
      }),
  ],
  [
    'changed metadata',
    (d) =>
      editManifest(d, (m) => {
        m.probability_binding.seed++;
      }),
  ],
  [
    'zero replicates',
    (d) =>
      editManifest(d, (m) => {
        m.probability_binding.replicates = 0;
      }),
  ],
  [
    'invented vocabulary',
    (d) =>
      editManifest(d, (m) => {
        m.vocabulary_version = 'OTHER';
      }),
  ],
  [
    'old format new design',
    (d) =>
      editManifest(d, (m) => {
        m.bundle_format_version = '7.0';
      }),
  ],
  [
    'unknown file',
    (d) =>
      editManifest(d, (m) => {
        m.files['../PRIVATE-MARKER'] = 'a'.repeat(64);
        m.row_counts['../PRIVATE-MARKER'] = 1;
      }),
  ],
  ['extra field', (d) => editFile(d, 'units.csv', (s) => s.trimEnd() + ',extra\n')],
  ['unclosed quote', (d) => editFile(d, 'units.csv', (s) => s + '"PRIVATE-MARKER')],
  ['stray quote', (d) => editFile(d, 'units.csv', (s) => s + 'BAD"PRIVATE-MARKER\n')],
  ['text after quote', (d) => editFile(d, 'units.csv', (s) => s + '"BAD"PRIVATE-MARKER\n')],
  [
    'symlink input',
    (d) => {
      const p = join(d, 'probabilities.csv');
      unlinkSync(p);
      symlinkSync('probability_source.csv', p);
    },
  ],
  ['invalid UTF8', (d) => writeFileSync(join(d, 'units.csv'), Buffer.from([0xff]))],
  ['array manifest', (d) => writeFileSync(join(d, 'manifest.json'), '[]')],
  ['null manifest', (d) => writeFileSync(join(d, 'manifest.json'), 'null')],
  ['malformed JSON', (d) => writeFileSync(join(d, 'manifest.json'), '{"PRIVATE-MARKER":')],
];
for (const [name, change] of mutations)
  test(`download verifier refuses ${name} without printing private data`, () => {
    const f = fixture();
    try {
      change(f.dir);
      const r = verifyMu7Bundle(f.dir);
      assert.equal(r.ok, false);
      assert.doesNotMatch(JSON.stringify(r), /PRIVATE-MARKER/);
    } finally {
      f.cleanup();
    }
  });
test('registered hash detects a self-consistent replacement manifest', () => {
  const f = fixture();
  try {
    editManifest(f.dir, (m) => {
      m.app_git_sha = 'e'.repeat(40);
    });
    assert.equal(verifyMu7Bundle(f.dir).ok, true);
    assert.match(
      verifyMu7Bundle(f.dir, f.bundle.manifestSha256).problems.join(';'),
      /registered manifest hash/,
    );
    assert.equal(verifyMu7Bundle(f.dir, '').ok, false);
  } finally {
    f.cleanup();
  }
});
test('source and canonical values must match even if the binding hashes are rebuilt', () => {
  const f = fixture();
  try {
    editFile(f.dir, 'probability_source.csv', (s) => s.replace('3e-6', '4e-6'));
    editManifest(f.dir, (m) => {
      const b = m.probability_binding;
      b.file_sha256 = m.files['probability_source.csv'];
      b.binding_sha256 = sha(
        [
          'binding_version',
          'design_version',
          'method',
          'replicates',
          'seed',
          'file_sha256',
          'rows_sha256',
        ]
          .map((k) => String(b[k]))
          .join('|'),
      );
      m.freeze.probability_binding_sha256 = b.binding_sha256;
    });
    assert.equal(verifyMu7Bundle(f.dir).ok, false);
  } finally {
    f.cleanup();
  }
});
test('CLI malformed input produces one sanitized JSON result and exit one', () => {
  const f = fixture();
  try {
    writeFileSync(join(f.dir, 'manifest.json'), '{"PRIVATE-MARKER":');
    const r = spawnSync(
      process.execPath,
      ['--import', 'tsx', 'scripts/verify-mu7-bundle.ts', '--bundle', f.dir],
      { encoding: 'utf8' },
    );
    assert.equal(r.status, 1);
    assert.equal(JSON.parse(r.stdout).ok, false);
    assert.doesNotMatch(r.stdout + r.stderr, /PRIVATE-MARKER|SyntaxError|stack/i);
  } finally {
    f.cleanup();
  }
});

test('CLI never silently drops a requested registration check', () => {
  const f = fixture();
  try {
    const r = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        'scripts/verify-mu7-bundle.ts',
        '--bundle',
        f.dir,
        '--expect-manifest-sha256',
      ],
      { encoding: 'utf8' },
    );
    assert.equal(r.status, 2);
    assert.equal(JSON.parse(r.stdout).ok, false);
  } finally {
    f.cleanup();
  }
});
test('escaped quotes, commas and multiline notes remain valid CSV', () => {
  const f = fixture('PILOT', 'ALLOW');
  try {
    // Reuse the actual exporter to create syntactically valid quoted fields.
    const b = buildMu7Bundle({
      mode: 'PILOT',
      appGitSha: 'd'.repeat(40),
      design: { design_version: 'SYN-7-CSV' },
      freeze: null,
      snapshot: null,
      lockedAt: '2026-01-01T00:00:00Z',
      nUnitsLocked: 1,
      syntheticDatabase: true,
      rows: {
        units: [],
        unit_design: [],
        independent_judgments: [
          {
            unit_id: id,
            mode: 'PILOT',
            note_initial: 'Fictional "quoted", note\nwith another line.',
          },
        ],
        final_reference: [],
      },
    });
    for (const file of b.files) writeFileSync(join(f.dir, file.name), file.content);
    writeFileSync(join(f.dir, 'manifest.json'), b.manifestText);
    assert.deepEqual(verifyMu7Bundle(f.dir, b.manifestSha256).problems, []);
  } finally {
    f.cleanup();
  }
});

for (const format of ['7.0', '8.1'] as const) {
  for (const note of ['first\rsecond', '\rfirst', 'last\r', '"quoted"\rnote', 'first\r\nsecond']) {
    test(`exported ${format} carriage-return note round-trips: ${JSON.stringify(note)}`, () => {
      const f = fixture('PILOT', 'ALLOW');
      try {
        const bundle = buildMu7Bundle({
          mode: 'PILOT',
          appGitSha: 'd'.repeat(40),
          design: {
            design_version: format === '8.1' ? 'SYN-8-1-CSV-COMPAT' : 'SYN-7-CSV-COMPAT',
            overlap_setting: 'ALLOW',
          },
          freeze: null,
          snapshot: null,
          lockedAt: '2026-01-01T00:00:00Z',
          nUnitsLocked: 1,
          syntheticDatabase: true,
          subtypes: [],
          rows: {
            units: [],
            unit_design: [],
            final_reference: [],
            independent_judgments: [
              { unit_id: id, mode: 'PILOT', note_initial: note, note_effective: note },
            ],
          },
        });
        for (const file of bundle.files) writeFileSync(join(f.dir, file.name), file.content);
        writeFileSync(join(f.dir, 'manifest.json'), bundle.manifestText);
        const result = verifyMu7Bundle(f.dir, bundle.manifestSha256);
        assert.deepEqual(result.problems, []);
        assert.equal(result.registrationVerified, true);
        if (!/[",\n]/.test(note)) {
          const name = 'independent_judgments.csv';
          const exported = readFileSync(join(f.dir, name), 'utf8');
          assert.ok(
            exported.includes(`"${note}"`),
            'new exports quote lone CR for standard CSV readers',
          );
          // Keep verifying the bytes emitted by the old writer, too; existing files are never rewritten.
          editFile(f.dir, name, (text) => text.replaceAll(`"${note}"`, note));
          const legacyHash = sha(readFileSync(join(f.dir, 'manifest.json'), 'utf8'));
          assert.deepEqual(verifyMu7Bundle(f.dir, legacyHash).problems, []);
        }
      } finally {
        f.cleanup();
      }
    });
  }
}
for (const overlap of [['ONE_PER_TRIAL'], ['ALLOW'], null, true, 1, {}, 'UNKNOWN']) {
  test(`non-enum overlap cannot bypass probability files: ${JSON.stringify(overlap)}`, () => {
    // Start with no probability files/binding. The malformed array used to select that
    // inventory after passing a string-coerced enum check, even for a FORMAL bundle.
    const f = fixture('FORMAL', 'ALLOW');
    try {
      const path = join(f.dir, 'manifest.json');
      const manifest = JSON.parse(readFileSync(path, 'utf8'));
      manifest.design.overlap_setting = overlap;
      const raw = JSON.stringify(manifest);
      writeFileSync(path, raw);
      const result = verifyMu7Bundle(f.dir, sha(raw));
      assert.equal(result.ok, false);
      assert.equal(result.registrationVerified, false);
      assert.match(result.problems.join(';'), /design or vocabulary is invalid/);
    } finally {
      f.cleanup();
    }
  });
}
