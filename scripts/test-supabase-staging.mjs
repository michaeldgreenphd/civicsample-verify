import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { readPrivateJson } from './staging-account-tools.mjs';
import { blockedPreflight, runStagingPreflight } from './supabase-staging-probes.mjs';

// Existing sessions only. Never sign in, refresh, invite, enroll, seed or mutate.
const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
let report;
if (args.length && (args.length !== 2 || args[0] !== '--config')) {
  report = blockedPreflight('INVALID_ARGUMENTS');
} else {
  const path = args[1] ?? process.env.VERIFY_SUPABASE_STAGING_CONFIG;
  if (!path) {
    report = blockedPreflight();
  } else {
    try {
      report = await runStagingPreflight(readPrivateJson(path, resolve(repositoryRoot)));
    } catch {
      report = blockedPreflight('PRIVATE_STAGING_CONFIG_REFUSED');
    }
  }
}
console.log(JSON.stringify({ generatedAt: new Date().toISOString(), ...report }, null, 2));
// Missing prerequisites may be recorded locally, but must fail a required CI gate.
if (
  report.status === 'FAIL' ||
  (report.status === 'BLOCKED' && process.env.VERIFY_SUPABASE_REQUIRE === '1') ||
  report.reason === 'INVALID_ARGUMENTS' ||
  report.reason === 'INVALID_PRIVATE_STAGING_CONFIG' ||
  report.reason === 'PRIVATE_STAGING_CONFIG_REFUSED'
)
  process.exitCode = 1;
