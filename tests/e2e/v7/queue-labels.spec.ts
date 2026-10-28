import { expect, test } from '@playwright/test';
import type { Mu7QueueItem } from '../../../src/lib/mu7-types';

test('follow-up queue labels explain the choice and lock on desktop and mobile without fetching packets', async ({
  page,
}) => {
  // Entirely synthetic DTOs: no study packets, accounts, identifiers or responses.
  const checks = [
    ['RULE_D_REMOVED', 'Diabetes — excluded'],
    ['RULE_D_KEPT', 'Diabetes — included'],
    ['RULE_K_KEPT', 'Neoplasms — included'],
    ['RULE_K_REMOVED', 'Neoplasms — excluded'],
  ];
  const queue: Mu7QueueItem[] = Array.from({ length: 96 }, (_, i) => ({
    assignmentId: `synthetic-primary-${i + 1}`,
    mode: 'FORMAL',
    reviewerSlot: 1,
    queuePosition: i + 1,
    unitId: `SYN-PRIMARY-${i + 1}`,
    unitRole: 'PRIMARY',
    answered: false,
    available: true,
  }));
  checks.forEach(([code], i) =>
    queue.push({
      assignmentId: `synthetic-followup-${i + 1}`,
      mode: 'FORMAL',
      reviewerSlot: 1,
      queuePosition: 97 + i,
      unitId: `MU7-SG-${code}-SYNTHETIC`,
      unitRole: 'SUBGROUP',
      answered: false,
      available: false,
    }),
  );
  const packetRequests: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/api/mu7/assignments/')) packetRequests.push(request.url());
  });
  await page.route('**/api/session', (route) =>
    route.fulfill({
      json: {
        environment: 'supabase-staging',
        user: {
          id: 'synthetic-queue-user',
          displayName: 'Synthetic reviewer',
          role: 'REVIEWER',
          aal: 'aal1',
        },
      },
    }),
  );
  await page.route('**/api/mu7/workspace', (route) =>
    route.fulfill({
      json: {
        kind: 'reviewer',
        designRecorded: true,
        enrolled: true,
        queue,
        training: [],
        trainingAcknowledgedAt: null,
      },
    }),
  );
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.goto('/');
  const panel = page.getByRole('complementary', { name: 'Unit queue' });
  for (let i = 0; i < checks.length; i++) {
    const button = panel.getByRole('button', {
      name: `Unit ${97 + i}: ${checks[i][1]}`,
      exact: true,
    });
    await expect(button).toBeDisabled();
    await expect(button).toContainText(
      'Opens when you have answered all 96 classifications (96 remaining).',
    );
  }
  await expect(panel).not.toContainText('RULE_D');
  await expect(panel).not.toContainText('RULE_K');
  await panel
    .getByRole('button', { name: 'Unit 100: Neoplasms — excluded', exact: true })
    .scrollIntoViewIfNeeded();
  await panel.screenshot({ path: 'test-results/followup-checks-desktop.png' });
  await page.getByRole('tab', { name: /Worked examples/ }).click();
  await expect(
    page.getByRole('heading', { name: 'See how an answer becomes a recorded decision' }),
  ).toBeVisible();
  await page.getByRole('tab', { name: 'Review cases', exact: true }).click();
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    const picker = page.getByLabel('Choose a review case');
    await expect(picker).toBeVisible();
    for (let i = 0; i < checks.length; i++) {
      await expect(
        picker
          .locator('option')
          .filter({ hasText: `${97 + i}. ${checks[i][1]} · After classification answers` }),
      ).toHaveJSProperty('disabled', true);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await expect(panel).toContainText('96 remaining classification answers');
  }
  await panel.screenshot({ path: 'test-results/followup-checks-mobile.png' });
  expect(packetRequests).toEqual([]);
});
