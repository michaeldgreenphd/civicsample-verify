import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const excluded = new Set([
  '.git',
  'node_modules',
  '.next',
  '.venv',
  'venv',
  '__pycache__',
  '.pytest_cache',
  'test-results',
  'playwright-report',
  'coverage',
  '.data',
  '.local',
]);
/** @type {Array<[string, RegExp]>} */
const rules = [
  ['registry identifier', /\bNCT\d{8}\b/i],
  ['non-fixture held-out identifier', /\bHO4R?-(?!TESTFX(?:-|\b))[A-Z0-9]{2,}(?:-[A-Z0-9]+)*/i],
  [
    'private source archive',
    new RegExp(['claude', 'code', 'handoff'].join('_') + '(?:_v\\d+)?\\.zip', 'i'),
  ],
  [
    'private source filename',
    /(?:PACKAGE_MANIFEST_v\d+|FROZEN_VERSIONS|reviewer_rubric_redaction_report(?:_v\d+)?|finding_v\d+_\d+_probe|v3_regression_results_with_0003)\.(?:csv|json)/i,
  ],
  [
    'private source location',
    new RegExp(
      '(?:/Users/[^\\s"\']+/(?:Library/CloudStorage|One' + 'Drive)|Revision_' + '\\d{8}/)',
      'i',
    ),
  ],
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  [
    'access credential',
    /\b(?:AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|sk-[A-Za-z0-9]{24,})\b/,
  ],
  ['encoded credential', /\beyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\b/],
];

/**
 * Reviewed registry-format identifiers that may appear in exactly these vendored files and nowhere
 * else. Each file is a byte-identical copy of the handoff v7 package (verified against its manifest
 * on 2026-10-23). The NCT99 values are the handoff's synthetic-fixture form, which migration 0024's
 * guard MU7-G16 requires in a FORMAL or worked-example packet; the checker values are the planted
 * negative-control inputs of its own self-test. Every occurrence in a file is checked against that
 * file's list, so an allowed value never masks another identifier, and an identifier in a file NAME
 * is never allowed. Extending this list is a reviewed change, never a convenience.
 */
const ALLOWED_REGISTRY_IDENTIFIERS = Object.freeze({
  'tests/handoff/v7.mjs': new Set(
    [101, 102, 103, 104, 105, 106, 107, 108, 201, 203, 301, 302, 303, 777, 999].map(
      (n) => `NCT99000${String(n).padStart(3, '0')}`,
    ),
  ),
  'tests/handoff/fixtures/v7/SYNTHETIC_PILOT_UNITS_v7.json': new Set([`NCT${'99000777'}`]),
  'tools/check_public_repo_leakage_v7.py': new Set(
    ['01234567', '99000101', '99000999'].map((digits) => `NCT${digits}`),
  ),
});
const REGISTRY_IDENTIFIER_ALL = /\bNCT\d{8}\b/gi;

/** True when the content holds a registry identifier not reviewed for this exact path. */
function hasUnapprovedRegistryIdentifier(name, content) {
  const allowed = ALLOWED_REGISTRY_IDENTIFIERS[name.split('\\').join('/')];
  for (const match of content.matchAll(REGISTRY_IDENTIFIER_ALL))
    if (!allowed || !allowed.has(match[0].toUpperCase())) return true;
  return false;
}

/** Never includes matched content in diagnostics. Also scans prospective, untracked source files. */
export function scanRepository(root) {
  root = resolve(root);
  const paths = new Set();
  const findings = [];
  const addFinding = (name, rule, source) => {
    // A forbidden identifier can occur in a filename as well as a file body.
    const safeName = rules.some(([, pattern]) => pattern.test(name)) ? '[redacted path]' : name;
    findings.push({ file: safeName, rule, source });
  };
  const inspect = (name, content, source) => {
    if (/^\.env(?:\.|$)/.test(name.split('/').at(-1)) && !name.endsWith('.example'))
      addFinding(name, 'environment secrets file', source);
    if (
      ['.zip', '.xlsx', '.xls', '.sqlite', '.db', '.docx', '.pdf'].includes(
        extname(name).toLowerCase(),
      )
    ) {
      addFinding(name, 'unreviewed private-data capable binary', source);
      return;
    }
    for (const [rule, pattern] of rules) {
      if (rule === 'registry identifier') {
        // Names are never allowlisted; contents are checked occurrence by occurrence.
        if (pattern.test(name) || hasUnapprovedRegistryIdentifier(name, content))
          addFinding(name, rule, source);
        continue;
      }
      if (pattern.test(name) || pattern.test(content)) addFinding(name, rule, source);
    }
    if (/\.(?:csv|jsonl)$/i.test(name) && !/synthetic|TESTFX|SYN-/i.test(content))
      addFinding(name, 'unmarked tabular data', source);
  };
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (excluded.has(entry.name)) continue;
      const path = join(dir, entry.name);
      if (entry.name === '.env.local') {
        // setup creates this local runtime secret. A tracked copy is still scanned below.
        try {
          execFileSync('git', ['check-ignore', '-q', '--', path], { cwd: root, stdio: 'ignore' });
          continue;
        } catch {
          /* Unignored secrets are prospective source. */
        }
      }
      if (entry.isDirectory()) walk(path);
      else paths.add(path);
    }
  };
  walk(root);
  let inRepository = false;
  try {
    inRepository =
      execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim() === 'true';
  } catch {
    /* Temporary test fixtures need not be git repositories. */
  }
  if (inRepository) {
    try {
      // Scan the actual indexed objects, not merely their current working-tree paths.
      // NUL records and the first tab preserve spaces, tabs and newlines in filenames.
      const records = execFileSync('git', ['ls-files', '--stage', '-z'], {
        cwd: root,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      for (const record of records.split('\0').filter(Boolean)) {
        const separator = record.indexOf('\t');
        const metadata = record.slice(0, separator).split(' ');
        const [mode, objectId, stage] = metadata;
        const name = record.slice(separator + 1);
        if (
          separator < 0 ||
          !/^[0-7]{6}$/.test(mode) ||
          !/^[a-f0-9]{40,64}$/.test(objectId) ||
          !/^[0-3]$/.test(stage)
        ) {
          addFinding('[git index]', 'unreadable index entry', 'index');
          continue;
        }
        paths.add(join(root, name));
        if (name.split('/').some((part) => excluded.has(part)))
          addFinding(name, 'excluded runtime path staged in index', 'index');
        if (stage !== '0') addFinding(name, 'unresolved index conflict', 'index');
        if (mode === '120000') {
          addFinding(name, 'symlink requires explicit review', 'index');
          continue;
        }
        if (mode !== '100644' && mode !== '100755') {
          addFinding(name, 'non-file index entry requires explicit review', 'index');
          continue;
        }
        try {
          const content = execFileSync('git', ['cat-file', 'blob', objectId], {
            cwd: root,
            maxBuffer: 64 * 1024 * 1024,
            stdio: ['ignore', 'pipe', 'ignore'],
          }).toString('utf8');
          inspect(name, content, 'index');
        } catch {
          addFinding(name, 'indexed blob could not be scanned', 'index');
        }
      }
    } catch {
      addFinding('[git index]', 'Git index could not be scanned', 'index');
    }
  }
  for (const path of [...paths].sort()) {
    const name = relative(root, path);
    let stat;
    try {
      stat = lstatSync(path);
    } catch {
      continue;
    }
    if (stat.isSymbolicLink()) {
      addFinding(name, 'symlink requires explicit review', 'working-tree');
      continue;
    }
    if (!stat.isFile()) continue;
    inspect(name, readFileSync(path).toString('utf8'), 'working-tree');
  }
  return findings;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const findings = scanRepository(process.argv[2] || process.cwd());
  for (const finding of findings)
    console.error(`[${finding.source}] ${finding.file}: ${finding.rule}`);
  if (findings.length) process.exitCode = 1;
  else
    console.log(
      'Synthetic fixture / source leakage scan passed. Heuristic scan; manual review remains required.',
    );
}
