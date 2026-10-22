import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 180000,
  expect: { timeout: 15000 },
  reporter: [['list'], ['html', { open: 'never' }]],
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
      NEXT_TELEMETRY_DISABLED: '1',
    },
  },
});
