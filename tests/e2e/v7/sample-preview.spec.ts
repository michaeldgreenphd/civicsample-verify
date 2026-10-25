import AxeBuilder from '@axe-core/playwright';
import { test, expect } from '@playwright/test';
import { syntheticSamplePreview } from '../../sample-preview-fixture';

test('investigator browses all 100 proposed packets without recording answers at desktop and mobile sizes', async ({
  page,
}) => {
  const data = syntheticSamplePreview();
  const writes: string[] = [];
  page.on('request', (r) => {
    if (r.url().includes('/api/mu7/') && r.method() !== 'GET') writes.push(r.url());
  });
  await page.route('**/api/mu7/admin/preview*', (route) => {
    const n = /\/preview\/(\d+)$/.exec(route.request().url());
    return route.fulfill({
      json: n
        ? data.units[Number(n[1]) - 1]
        : {
            status: 'PROPOSED_PREVIEW',
            guide: data.guide,
            units: data.units.map((u, i) => ({
              position: i + 1,
              title: u.display.title,
              family: u.packet.unit.family,
              trialTitle: u.packet.trial.brief_title,
            })),
          },
    });
  });
  // Explicit glob for detail routes, which include a slash after preview.
  await page.route('**/api/mu7/admin/preview/*', (route) =>
    route.fulfill({ json: data.units[Number(route.request().url().split('/').at(-1)) - 1] }),
  );
  await page.goto('/');
  await page.getByLabel('Pilot account').selectOption('investigator');
  await page
    .getByLabel('Password', { exact: true })
    .fill('e2e-only-generated-fictional-passphrase');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
  await page.getByRole('button', { name: /Mapping units/ }).click();
  const panel = page.getByRole('region', { name: 'The proposed 100 mappings' });
  await panel.getByRole('button', { name: 'Preview all 100 mappings' }).click();
  await expect(panel.getByRole('status')).toContainText('Mapping 1 of 100');
  await expect(panel.getByLabel('Choose a proposed mapping').locator('option')).toHaveCount(100);
  await panel.getByLabel('Choose a proposed mapping').selectOption('100');
  await expect(panel.getByRole('status')).toContainText('Mapping 100 of 100');
  await expect(panel).toContainText('Fictional trial 100');
  await expect(panel).toContainText('Required separately from the membership answer');
  await expect(panel.getByRole('button', { name: /Save|Submit/ })).toHaveCount(0);
  await panel.getByRole('button', { name: 'Read the reviewer guide' }).click();
  await expect(panel).toContainText('Different things you are judging');
  await panel.getByRole('button', { name: 'Return to mappings' }).click();
  for (const width of [1280, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  }
  expect(
    (
      await new AxeBuilder({ page })
        .include('[aria-labelledby="proposed-preview-heading"]')
        .withTags(['wcag2a', 'wcag2aa'])
        .analyze()
    ).violations,
  ).toEqual([]);
  expect(writes).toEqual([]);
  await panel.screenshot({ path: 'test-results/proposed-sample-preview-mobile.png' });
  let release!: () => void;
  const delayed = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/mu7/admin/preview/2', async (route) => {
    await delayed;
    await route.fulfill({ json: data.units[1] }).catch(() => undefined);
  });
  await panel.getByLabel('Choose a proposed mapping').selectOption('2');
  await expect(panel.getByRole('status')).toContainText('Loading mapping');
  await panel.getByRole('button', { name: 'Close preview' }).click();
  release();
  await expect(panel.getByRole('button', { name: 'Preview all 100 mappings' })).toBeVisible();
  await expect(panel.getByLabel('Choose a proposed mapping')).toHaveCount(0);
});
