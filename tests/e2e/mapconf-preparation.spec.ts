// Served UI recovery test with synthetic responses. No writes reach the database.
import { test, expect } from '@playwright/test';
import type { McInvestigatorWorkspace } from '../../src/lib/mapconf-types';

test('mapping preparation exposes retry after partial import and assignment', async ({
  browser,
}) => {
  const context = await browser.newContext({ baseURL: 'http://127.0.0.1:3100' });
  const page = await context.newPage();
  const workspace: McInvestigatorWorkspace = {
    kind: 'investigator',
    campaign: {
      reviewMode: 'MAPPING_CONFIRMATION',
      assignmentVisibility: 'EXISTING_ASSIGNMENT_VISIBLE',
      conditionSetId: 'SYN-CONDITIONS',
      conditionSetStatus: 'PROPOSED',
      rubricVersion: 'SYN-RUBRIC',
      rubricSha256: 'a'.repeat(64),
      phase: 'OPEN',
      createdAt: '2026-01-01T00:00:00Z',
    },
    conditions: [],
    counts: { syntheticPilot: 0, trainingExample: 0, evaluation: 0 },
    completion: [],
    reviewers: [],
    events: [],
    exports: [],
    adjudicationsRecorded: 0,
    evaluationImportAllowed: false,
    appGitSha: 'a'.repeat(40),
  };
  let importAttempts = 0;
  let assignmentAttempts = 0;
  try {
    await page.route('**/api/mc/workspace', (route) => route.fulfill({ json: workspace }));
    await page.route('**/api/mc/admin/action', (route) => {
      const action = route.request().postDataJSON().action;
      if (action === 'import-synthetic') {
        if (++importAttempts === 1) {
          workspace.counts.syntheticPilot = 3;
          return route.fulfill({
            status: 502,
            json: { error: 'The connection was interrupted. Please retry.' },
          });
        }
        workspace.counts = { syntheticPilot: 12, trainingExample: 3, evaluation: 0 };
      } else if (action === 'assign') {
        workspace.completion = [
          { reviewerPseudoId: 'SYN-R1', reviewerSlot: 1, assigned: 12, submitted: 0 },
        ];
        if (++assignmentAttempts === 1)
          return route.fulfill({
            status: 502,
            json: { error: 'The connection was interrupted. Please retry.' },
          });
        workspace.completion.push({
          reviewerPseudoId: 'SYN-R2',
          reviewerSlot: 2,
          assigned: 12,
          submitted: 0,
        });
      } else throw new Error(`Unexpected preparation action ${action}`);
      return route.fulfill({ json: workspace });
    });
    await page.goto('/');
    await page.getByLabel('Pilot account').selectOption('investigator');
    await page
      .getByLabel('Password', { exact: true })
      .fill('e2e-only-generated-fictional-passphrase');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
    await page.getByRole('button', { name: /Mapping confirmation/ }).click();
    const campaign = page.getByRole('region', { name: 'Campaign', exact: true });
    await campaign.getByRole('button', { name: 'Import synthetic mappings', exact: true }).click();
    await expect(page.getByRole('main').getByRole('alert')).toContainText('Please retry');
    await expect(campaign).toContainText('The import is incomplete.');
    await expect(
      campaign.getByRole('button', { name: 'Assign to the two pilot reviewers' }),
    ).toBeDisabled();
    await campaign.getByRole('button', { name: 'Resume synthetic import' }).click();
    await expect(page.getByRole('main').getByRole('alert')).toHaveCount(0);
    await campaign.getByRole('button', { name: 'Assign to the two pilot reviewers' }).click();
    await expect(campaign).toContainText('Some mappings still need assigning.');
    await expect(campaign).not.toContainText('Every mapping is assigned to both pilot reviewers.');
    await expect(
      campaign.getByRole('button', { name: 'Resume reviewer assignment' }),
    ).toBeEnabled();
    await page.screenshot({
      path: 'test-results/mapconf-preparation-resume-desktop.png',
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(
      campaign.getByRole('button', { name: 'Resume reviewer assignment' }),
    ).toBeVisible();
    await campaign.screenshot({ path: 'test-results/mapconf-preparation-resume-mobile.png' });
    await campaign.getByRole('button', { name: 'Resume reviewer assignment' }).click();
    await expect(page.getByRole('main').getByRole('alert')).toHaveCount(0);
    await expect(campaign).toContainText('Every mapping is assigned to both pilot reviewers.');
    await expect(campaign.getByRole('button', { name: 'Resume reviewer assignment' })).toHaveCount(
      0,
    );
    expect(importAttempts).toBe(2);
    expect(assignmentAttempts).toBe(2);
  } finally {
    await context.close();
  }
});
