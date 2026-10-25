// Served UI and download check with synthetic DTOs. No study data or approval is written.
import { readFile } from 'node:fs/promises';
import AxeBuilder from '@axe-core/playwright';
import { test, expect } from '@playwright/test';
import type { Mu7InvestigatorWorkspace } from '../../../src/lib/mu7-types';

test('investigator preparation status is readable, private and never authorizes formal review', async ({
  browser,
}) => {
  const context = await browser.newContext({ baseURL: 'http://127.0.0.1:3100' });
  const page = await context.newPage();
  const sentinel = 'SYNTHETIC_PRIVATE_STATUS_SENTINEL';
  const workspace: Mu7InvestigatorWorkspace = {
    kind: 'investigator',
    training: [],
    design: null,
    counts: { pilotUnits: 0, formalUnits: 0, trainingUnits: 0, pilotQueue: 0 },
    pilotReviewers: [sentinel],
    completion: [],
    pilotRouting: [],
    pilotLock: null,
    exports: [],
    phaseEvents: [],
    gates: [],
    formalOperationsEnabled: false,
    formalDisabledReason: 'Formal review disabled for this synthetic check.',
    localTools: false,
    appGitSha: 'a'.repeat(40),
  };
  const writes: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/api/mu7/') && request.method() !== 'GET')
      writes.push(request.url());
  });
  try {
    await page.route('**/api/mu7/workspace', (route) => route.fulfill({ json: workspace }));
    await page.goto('/');
    await page.getByLabel('Pilot account').selectOption('investigator');
    await page
      .getByLabel('Password', { exact: true })
      .fill('e2e-only-generated-fictional-passphrase');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
    await page.getByRole('button', { name: /Mapping units/ }).click();
    const panel = page.getByRole('region', { name: 'Preparing formal review' });
    await expect(panel).toBeVisible();
    await expect(panel).toContainText(
      'No decision status was returned; approval cannot be inferred.',
    );
    await expect(panel).toContainText('Disabled in this build');
    await expect(panel.getByRole('button')).toHaveCount(1);
    const downloadPromise = page.waitForEvent('download');
    await panel.getByRole('button', { name: 'Download preparation status' }).click();
    const download = await downloadPromise;
    const path = await download.path();
    expect(path).not.toBeNull();
    const text = await readFile(path!, 'utf8');
    const report = JSON.parse(text);
    expect(report.formal_operations_enabled).toBe(false);
    expect(report.report_format).toBe('civicsample-preparation-status-1.0');
    expect(text).not.toContain(sentinel);
    expect(writes).toEqual([]);
    await page.screenshot({ path: 'test-results/formal-preparation-desktop.png', fullPage: true });
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      await expect(panel.getByRole('button')).toBeVisible();
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
    }
    expect(
      (
        await new AxeBuilder({ page })
          .include('[aria-labelledby="formal-preparation-heading"]')
          .withTags(['wcag2a', 'wcag2aa'])
          .analyze()
      ).violations,
    ).toEqual([]);
    await page.setViewportSize({ width: 390, height: 844 });
    await panel.screenshot({ path: 'test-results/formal-preparation-mobile.png' });
  } finally {
    await context.close();
  }
});

test('reviewer and adjudicator workspaces do not show the investigator preparation report', async ({
  browser,
}) => {
  for (const account of ['reviewer-a', 'adjudicator']) {
    const context = await browser.newContext({ baseURL: 'http://127.0.0.1:3100' });
    const page = await context.newPage();
    try {
      await page.route('**/api/mu7/workspace', (route) =>
        route.fulfill({
          json: {
            kind: account === 'reviewer-a' ? 'reviewer' : 'adjudicator',
            training: [],
            designRecorded: false,
            enrolled: true,
            trainingAcknowledgedAt: null,
            queue: [],
          },
        }),
      );
      await page.goto('/');
      await page.getByLabel('Pilot account').selectOption(account);
      await page
        .getByLabel('Password', { exact: true })
        .fill('e2e-only-generated-fictional-passphrase');
      await page.getByRole('button', { name: 'Sign in', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
      await page.getByRole('button', { name: /Mapping units/ }).click();
      await expect(page.getByRole('tab', { name: 'Worked examples', exact: false })).toBeVisible();
      await expect(page.getByRole('region', { name: 'Preparing formal review' })).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Download preparation status' })).toHaveCount(
        0,
      );
    } finally {
      await context.close();
    }
  }
});
