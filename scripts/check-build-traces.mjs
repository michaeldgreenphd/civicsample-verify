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
  'migrations/0009_canonical_packet_and_lock_state_guards.sql',
  'migrations/0010_investigator_judgment_boundary.sql',
  'migrations/0011_v5_trial_label_verification.sql',
  'migrations/0012_v5_training_examples.sql',
  'migrations/0013_v5_independent_finality_guards.sql',
  'migrations/0014_legacy_pilot_and_packet_guards.sql',
  'migrations/0015_v5_review_fixes.sql',
  'migrations/0017_v5_rubric_binding.sql',
  'migrations/0019_v5_rubric_binding_reconciliation.sql',
  'migrations/0016_mapping_confirmation.sql',
  'migrations/0018_mapping_confirmation_review_fixes.sql',
  'migrations/0020_mapping_confirmation_completeness_and_serialization.sql',
  'migrations/0021_account_locks.sql',
  'migrations/0022_service_role_admin_grants.sql',
  'migrations/0023_service_role_truncate_revoke.sql',
  'migrations/0024_v7_mapping_units.sql',
  'migrations/0025_v7_review_fixes.sql',
  'migrations/0026_v7_lifecycle_and_gates.sql',
  'migrations/0027_service_role_least_privilege.sql',
  'migrations/0028_v7_gate_specifications_v8_1.sql',
  'migrations/0029_v7_versioned_gate_approvals.sql',
  'migrations/0030_v7_current_unit_freeze_gates.sql',
  'migrations/0031_practice_observer.sql',
  'migrations/0032_v7_freeze_gates_v8_4.sql',
  'migrations/0033_v8_design_foundation.sql',
  'migrations/0034_v8_synthetic_identifiers.sql',
  'migrations/0035_v81_subtype_probability.sql',
  'migrations/0036_v81_judgment_history.sql',
  'migrations/preflight_frozen_trial_compatibility.sql',
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
