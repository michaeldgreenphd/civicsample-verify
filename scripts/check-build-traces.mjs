// Build-package safety: only the reviewed SQL inputs may accompany server bundles.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const sqlInputs = new Set([
  'schema.sql',
  'supabase_test_shim/auth_shim.sql',
  'migrations/0002_v3_review_design.sql',
  'migrations/0003_v4_record_categories_module_b.sql',
  'migrations/0004_synthetic_verify_workflow.sql',
  'migrations/0005_review_integrity_fixes.sql',
  'migrations/0006_reference_integrity.sql',
  'migrations/0007_frozen_contract_guards.sql',
  'migrations/0008_trial_packet_and_concurrency_guards.sql',
]);
function traces(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const filename = path.join(directory, entry.name);
    // Concurrent local development and compiler caches are not production output.
    if (entry.isDirectory()) return ['dev', 'cache'].includes(entry.name) ? [] : traces(filename);
    return entry.name.endsWith('.nft.json') ? [filename] : [];
  });
}
const manifests = traces(path.join(root, '.next'));
assert.ok(manifests.length, 'No production file traces found. Run the build first.');
const apiTrace = path.join(root, '.next/server/app/api/[...path]/route.js.nft.json');
assert.ok(manifests.includes(apiTrace), 'API deployment trace is missing.');
for (const manifest of manifests) {
  const observedSql = new Set();
  for (const name of JSON.parse(readFileSync(manifest, 'utf8')).files) {
    const filename = path.resolve(path.dirname(manifest), name);
    const relative = path.relative(root, filename);
    const parts = relative.split(path.sep);
    if (parts[0] === 'node_modules' || parts[0] === '.next') continue;
    assert.ok(
      sqlInputs.has(relative),
      'Unexpected application or runtime file in production trace; build rejected.',
    );
    observedSql.add(relative);
  }
  if (manifest === apiTrace) {
    assert.deepEqual(
      observedSql,
      sqlInputs,
      'API deployment trace must contain every reviewed SQL migration.',
    );
  }
}
console.log(
  `Production trace check passed: ${manifests.length} manifests, ${sqlInputs.size} SQL inputs, no local runtime files.`,
);
