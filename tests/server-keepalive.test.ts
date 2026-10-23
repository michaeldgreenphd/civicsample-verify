// The production server keeps idle keep-alive connections open longer than any client of the
// served app (Playwright's API request context in the browser suite, or a proxy) leaves them idle.
// With the Node default the server closes an idle socket about 6 s after a response, without
// notifying the client; a request sent on that socket at the same moment fails with ECONNRESET.
// Measured against `next start` (Next 16.4.2, Node 26): reusing a socket after a 6.0 s idle gap
// was reset in 3 of 6 attempts with the default, and in 0 of 30 attempts (5.8 to 6.2 s) with
// --keepAliveTimeout 70000. See README.md (Verification).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const scripts = JSON.parse(readFileSync('package.json', 'utf8')).scripts as Record<string, string>;

test('the production start command sets a keep-alive timeout above client idle gaps', () => {
  const m = scripts.start.match(/--keepAliveTimeout (\d+)/);
  assert.ok(m, 'npm run start passes --keepAliveTimeout');
  assert.ok(Number(m[1]) >= 65_000, 'at least 65 s, longer than common proxy idle timeouts');
});

test('the production browser suite serves through that start command', () => {
  const config = readFileSync('playwright.config.ts', 'utf8');
  assert.match(config, /'npm run start -- --port 3100'/);
});
