// The v7 reviewer rubric: the supplied text is kept verbatim, and the current version (7.1) differs
// from it exactly by the Pain edit of engineering message v8.3 (investigator decisions, addendum 11,
// item 60). Any further rubric change must update docs/design_v7/RUBRIC_PROVENANCE_v7.md and this
// test together. Reviewers receive the rubric as docs/design_v7/REVIEW_RUBRIC_v7.md; the application
// does not render it, so this file is the copy they read.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const sha256 = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex');
const SUPPLIED = 'docs/design_v7/REVIEW_RUBRIC_v7_supplied.md';
const CURRENT = 'docs/design_v7/REVIEW_RUBRIC_v7.md';
const SUPPLIED_SHA256 = '615af589ee5918553fe89e4421569c6328b50c4ae2cd4e6d9ae5ef1b66586cfd';
const RUBRIC_7_1_SHA256 = '9ab8d6a9aa146b648358c7f3993068a8963146861a5d0b04ae5d6e1bda60cf46';
const WITHDRAWN_REVISION_1_SHA256 =
  '38b42ee0eca3c2dea95b60d00aaa58bf5ad75f4025f18ded774192401395760c';
const SUPPLIED_PAIN_LINE = '- Pain (descriptive row; provisional until gate G-PAIN-01)';
const PAIN_PARAGRAPH =
  'Pain: the row holds trials with the MeSH heading Pain. Agree when the trial studies pain of any kind (for example acute, postoperative, procedural or chronic pain), in any population; judge whether pain is the condition studied, not how long it lasts.';
const section = (text: string, n: number) => {
  const start = text.indexOf(`\n## ${n}. `);
  const end = text.indexOf(`\n## ${n + 1}. `, start + 1);
  assert.ok(start >= 0, `section ${n}`);
  return text.slice(start, end < 0 ? undefined : end);
};

test('the supplied v7 rubric is kept verbatim and the current rubric is version 7.1', () => {
  assert.equal(sha256(SUPPLIED), SUPPLIED_SHA256);
  assert.equal(sha256(CURRENT), RUBRIC_7_1_SHA256);
  const provenance = readFileSync('docs/design_v7/RUBRIC_PROVENANCE_v7.md', 'utf8');
  for (const h of [SUPPLIED_SHA256, RUBRIC_7_1_SHA256, WITHDRAWN_REVISION_1_SHA256])
    assert.ok(provenance.includes(h), h);
  // Gate G-PAIN-01, version 3 (migration 0032), names this version in its decision record.
  assert.ok(
    readFileSync('migrations/0032_v7_freeze_gates_v8_4.sql', 'utf8').includes(RUBRIC_7_1_SHA256),
  );
});

test('7.1 changes exactly the Pain line and adds the Pain paragraph below the list of rows', () => {
  const a = readFileSync(SUPPLIED, 'utf8').split('\n');
  const b = readFileSync(CURRENT, 'utf8').split('\n');
  const at = a.indexOf(SUPPLIED_PAIN_LINE);
  assert.ok(at > 0);
  assert.equal(a[at + 1], '');
  assert.deepEqual(b.slice(0, at), a.slice(0, at), 'nothing changes before the Pain line');
  assert.deepEqual(b.slice(at, at + 4), ['- Pain', '', PAIN_PARAGRAPH, '']);
  assert.deepEqual(b.slice(at + 4), a.slice(at + 2), 'nothing changes after the paragraph');
  assert.equal(b.length, a.length + 2);
});

test('7.1 keeps the approved policies, the pending markers and the worked examples, and adds no other content', () => {
  const supplied = readFileSync(SUPPLIED, 'utf8');
  const current = readFileSync(CURRENT, 'utf8');
  const flat = (t: string) => t.replace(/\s+/g, ' ');
  // The policy texts OQ-03 and OQ-04 are pending (a rubric 7.2 needs the investigator's approval).
  assert.ok(
    flat(current).includes(
      'Depression policy text (OQ-03) and smoking cessation policy text (OQ-04) are pending (gates G-OQ-03 and G-OQ-04)',
    ),
  );
  // Approved policies and the three worked examples (sections 2, 4 to 8) are byte-identical.
  for (const n of [1, 2, 4, 5, 6, 7, 8])
    assert.equal(section(current, n), section(supplied, n), `section ${n}`);
  // No rule-book content, AI output, benchmark, female share or PPR in what reviewers read.
  for (const pattern of [
    /\bAI\b/,
    /\bLLM\b/,
    /Stage [AB]\b/,
    /kappa/i,
    /rule[- ]book/i,
    /ontology/i,
    /-POL-\d/,
    /benchmark/i,
    /female share/i,
    /participation-to-prevalence/i,
    /\bPPR\b/,
  ])
    assert.doesNotMatch(current, pattern, String(pattern));
});

test('no application source embeds a copy of the reviewer rubric', () => {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|tsx|mjs|js|json|md|css|sql)$/.test(name)) files.push(p);
    }
  };
  walk('src');
  assert.ok(files.length > 0);
  for (const f of files) {
    const text = readFileSync(f, 'utf8');
    assert.ok(!text.includes('## 3. Figure 2 condition rows'), f);
    assert.ok(!text.includes(PAIN_PARAGRAPH), f);
  }
});
