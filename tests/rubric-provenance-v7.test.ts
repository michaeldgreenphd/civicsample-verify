// The v7 reviewer rubric: the supplied text is kept verbatim and the current revision differs from
// it by the one line engineering message v8.1 names (addendum 8, item 40). Any further rubric change
// must update docs/design_v7/RUBRIC_PROVENANCE_v7.md and this test together.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const sha256 = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex');
const SUPPLIED = 'docs/design_v7/REVIEW_RUBRIC_v7_supplied.md';
const CURRENT = 'docs/design_v7/REVIEW_RUBRIC_v7.md';

test('the supplied v7 rubric is kept verbatim and the current revision is the recorded one', () => {
  assert.equal(
    sha256(SUPPLIED),
    '615af589ee5918553fe89e4421569c6328b50c4ae2cd4e6d9ae5ef1b66586cfd',
  );
  assert.equal(sha256(CURRENT), '38b42ee0eca3c2dea95b60d00aaa58bf5ad75f4025f18ded774192401395760c');
  const provenance = readFileSync('docs/design_v7/RUBRIC_PROVENANCE_v7.md', 'utf8');
  for (const h of [sha256(SUPPLIED), sha256(CURRENT)]) assert.ok(provenance.includes(h));
});

test('revision 1 changes exactly the Pain line', () => {
  const a = readFileSync(SUPPLIED, 'utf8').split('\n');
  const b = readFileSync(CURRENT, 'utf8').split('\n');
  assert.equal(a.length, b.length);
  const changed = a.map((line, i) => [line, b[i]]).filter(([x, y]) => x !== y);
  assert.deepEqual(changed, [
    ['- Pain (descriptive row; provisional until gate G-PAIN-01)', '- Pain (descriptive row)'],
  ]);
});
