// Served UI over a fictional status fixture. Database lifecycle/authorization runs separately.
import AxeBuilder from '@axe-core/playwright';
import { test, expect } from '@playwright/test';
import type { Mu7InvestigatorWorkspace } from '../../../src/lib/mu7-types';
import type { ReleaseStatus } from '../../../src/lib/formal-release';

test('release controls require a current plan, a specific action and deliberate confirmation', async ({
  page,
}) => {
  const workspace: Mu7InvestigatorWorkspace = {
    kind: 'investigator',
    training: [],
    design: {
      designVersion: 'review-design-v8.1.0',
      assignmentSetId: 'SYNTHETIC-RELEASE',
      overlapSetting: 'ONE_PER_TRIAL',
      nPrimaryPlanned: 96,
      nSubgroupPlanned: 4,
      recordedAt: '2026-01-01T00:00:00Z',
    },
    counts: { pilotUnits: 0, formalUnits: 100, trainingUnits: 0, pilotQueue: 0 },
    pilotReviewers: [],
    completion: [],
    pilotRouting: [],
    pilotLock: null,
    exports: [],
    phaseEvents: [],
    gates: [],
    formalOperationsEnabled: false,
    formalDisabledReason: 'Synthetic pending requirements.',
    localTools: false,
    appGitSha: 'a'.repeat(40),
  };
  const status: ReleaseStatus = {
    prepared: true,
    phase: 'NOT_SIGNED_OFF',
    formal_units: 100,
    training_units: 0,
    pilot_locked: false,
    pilot_exports: [],
    protocol_bound: false,
    descriptive_plan_recorded: false,
    frozen: false,
    assignments: 0,
    completion: [],
    snapshot_recorded: false,
    reference_locked: false,
    formal_exports: 0,
    freeze_blockers: 'Synthetic decision pending',
    opening_blockers: 'Synthetic decision pending',
    reviewers: [],
    state_sha256: 'a'.repeat(64),
  };
  const writes: Record<string, unknown>[] = [];
  let fail = false;
  await page.route('**/api/mu7/workspace', (r) => r.fulfill({ json: workspace }));
  await page.route('**/api/mu7/admin/release', async (r) => {
    if (r.request().method() === 'GET') return r.fulfill({ json: status });
    writes.push(r.request().postDataJSON());
    if (fail)
      return r.fulfill({
        status: 409,
        json: { error: 'The plan changed. Refresh before confirming again.' },
      });
    status.descriptive_plan_recorded = true;
    status.state_sha256 = 'b'.repeat(64);
    return r.fulfill({ json: status });
  });
  await page.goto('/');
  await page.getByLabel('Pilot account').selectOption('investigator');
  await page
    .getByLabel('Password', { exact: true })
    .fill('e2e-only-generated-fictional-passphrase');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
  await page.getByRole('button', { name: /Mapping units/ }).click();
  const panel = page.getByRole('region', { name: 'Prepare and open clinical review' });
  await panel.getByRole('button', { name: 'Check release status' }).click();
  await expect(panel).toContainText('100 / 0');
  const action = panel.getByLabel('Choose a step');
  await action.selectOption('open-review');
  await expect(panel).toContainText('awaiting rehearsal acceptance');
  await expect(panel.getByRole('checkbox')).toHaveCount(0);
  expect(writes).toEqual([]);
  await action.selectOption('record-descriptive-plan');
  await panel.getByText('What the initial report includes', { exact: true }).click();
  await expect(panel).toContainText('not clinical confirmation');
  const record = panel.getByRole('button', {
    name: 'Record the sample-only reporting plan',
    exact: true,
  });
  await expect(record).toBeDisabled();
  await panel
    .getByLabel('Why you authorize this step')
    .fill('Synthetic scope attestation for served UI testing only.');
  await expect(record).toBeDisabled();
  await panel.getByRole('checkbox').check();
  await expect(record).toBeEnabled();
  await panel
    .getByLabel('Why you authorize this step')
    .fill('Updated synthetic scope attestation for testing only.');
  await expect(panel.getByRole('checkbox')).not.toBeChecked();
  for (const width of [1280, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  }
  expect(
    (
      await new AxeBuilder({ page })
        .include('[aria-labelledby="release-heading"]')
        .withTags(['wcag2a', 'wcag2aa'])
        .analyze()
    ).violations,
  ).toEqual([]);
  await panel.screenshot({ path: 'test-results/formal-release-mobile.png' });
  fail = true;
  await panel.getByRole('checkbox').check();
  await record.click();
  await expect(panel).toContainText('Refresh before confirming again');
  await expect(record).toHaveCount(0);
  await panel.getByRole('button', { name: 'Check release status' }).click();
  await expect(panel.getByRole('checkbox')).not.toBeChecked();
  fail = false;
  await panel.getByRole('checkbox').check();
  await record.click();
  await expect(panel).toContainText('Record the sample-only reporting plan: recorded.');
  expect(writes).toHaveLength(2);
  expect(writes[1]).toEqual({
    action: 'record-descriptive-plan',
    stateSha256: 'a'.repeat(64),
    attestation: 'Updated synthetic scope attestation for testing only.',
    confirm: true,
  });
  await action.selectOption('open-review');
  await expect(panel.getByRole('checkbox')).toHaveCount(0);
  await page.setViewportSize({ width: 1280, height: 1000 });
  await panel.screenshot({ path: 'test-results/formal-release-desktop.png' });
});
