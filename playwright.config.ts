import { defineConfig } from '@playwright/test';
import { execFileSync } from 'node:child_process';
// The served-browser regression exercises synthetic exports from a developer checkout, which may
// carry uncommitted work; the export's clean-tree rule would otherwise refuse the manifest. The
// injected build identity is the checked-out commit and the bundles are synthetic fixtures.
const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 180000,
  expect: { timeout: 15000 },
  reporter: [['list'], ['html', { open: 'never' }]],
  // One served in-memory database for every scenario. Recording a review design v7 refuses new
  // v5/v6 formal, calibration and training cases and new v2 formal cases in that database (guards
  // MU7-G04 to MU7-G06, by design), so the v7 scenario runs after the others, explicitly.
  projects: [
    { name: 'designs-before-v7', testIgnore: /\/v7\// },
    {
      name: 'review-design-v7',
      testMatch: /\/v7\/.*\.spec\.ts$/,
      dependencies: ['designs-before-v7'],
    },
  ],
  use: {
    baseURL: 'http://127.0.0.1:3100',
    actionTimeout: 15000,
    navigationTimeout: 30000,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: process.env.VERIFY_E2E_PRODUCTION
      ? 'npm run start -- --port 3100'
      : 'npm run dev -- --port 3100',
    url: 'http://127.0.0.1:3100',
    reuseExistingServer: false,
    timeout: 120000,
    env: {
      VERIFY_DEMO_PASSWORD: 'e2e-only-generated-fictional-passphrase',
      VERIFY_INVESTIGATOR_PASSWORD: 'e2e-only-generated-fictional-passphrase',
      VERIFY_REVIEWER_A_PASSWORD: 'e2e-only-generated-fictional-passphrase',
      VERIFY_REVIEWER_B_PASSWORD: 'e2e-only-generated-fictional-passphrase',
      VERIFY_ADJUDICATOR_PASSWORD: 'e2e-only-generated-fictional-passphrase',
      VERIFY_DB_DIR: 'memory',
      VERIFY_APP_GIT_SHA: head,
      NEXT_TELEMETRY_DISABLED: '1',
    },
  },
});
