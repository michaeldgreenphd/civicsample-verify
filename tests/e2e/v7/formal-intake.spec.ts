// Served production UI with a synthetic intake-plan DTO. No study data or remote writes.
import AxeBuilder from '@axe-core/playwright';
import { test, expect } from '@playwright/test';

test('sample intake confirms counts, requires an attestation and preserves occupied workspaces', async ({
  page,
}) => {
  let state = 'EMPTY',
    fail = false;
  const writes: unknown[] = [];
  await page.route('**/api/mu7/admin/intake', async (route) => {
    if (route.request().method() === 'GET')
      return route.fulfill({
        json: {
          packageSha256: 'a'.repeat(64),
          targetState: state,
          mappings: 100,
          queuePositionsChecked: 200,
          guideProfile: 'mu81-plain-language-r4',
          reviewRemainsClosed: true,
        },
      });
    writes.push(route.request().postDataJSON());
    return route.fulfill(
      fail
        ? {
            status: 409,
            json: {
              error:
                'Sample intake was not confirmed. Check the connected package and empty destination, then retry the same plan.',
            },
          }
        : {
            json: {
              state: 'RECORDED',
              mappings: 100,
              queuePositionsChecked: 200,
              reviewRemainsClosed: true,
            },
          },
    );
  });
  await page.goto('/');
  await page.getByLabel('Pilot account').selectOption('investigator');
  await page
    .getByLabel('Password', { exact: true })
    .fill('e2e-only-generated-fictional-passphrase');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
  await page.getByRole('button', { name: /Mapping units/ }).click();
  const panel = page.getByRole('region', { name: 'Connect the prepared sample' });
  await panel.getByRole('button', { name: 'Check prepared sample' }).click();
  await expect(panel).toContainText('100 mappings · 200 planned queue positions');
  const load = panel.getByRole('button', { name: 'Load 100 mappings for preparation' });
  await expect(load).toBeDisabled();
  const attestation = 'Synthetic test: authorize preparation only; formal review stays closed.';
  await panel.getByRole('textbox').fill(attestation);
  await expect(load).toBeEnabled();
  for (const width of [1280, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  }
  expect(
    (
      await new AxeBuilder({ page })
        .include('[aria-labelledby="sample-intake-heading"]')
        .withTags(['wcag2a', 'wcag2aa'])
        .analyze()
    ).violations,
  ).toEqual([]);
  await panel.screenshot({ path: 'test-results/sample-intake-mobile.png' });
  fail = true;
  await load.click();
  await expect(panel.getByRole('status')).toContainText('was not confirmed');
  fail = false;
  await load.click();
  await expect(panel.getByRole('status')).toContainText('Review remains closed');
  expect(writes).toEqual(Array(2).fill({ packageSha256: 'a'.repeat(64), attestation }));
  for (const occupied of ['OCCUPIED', 'CLOSED']) {
    state = occupied;
    await panel.getByRole('button', { name: 'Check prepared sample' }).click();
    await expect(load).toHaveCount(0);
    await expect(panel).toContainText(
      occupied === 'OCCUPIED' ? 'practice records cannot be replaced' : 'Intake is closed',
    );
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await panel.screenshot({ path: 'test-results/sample-intake-desktop.png' });
});
