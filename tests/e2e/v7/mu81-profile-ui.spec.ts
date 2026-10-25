// Served-browser presentation regression with synthetic, intercepted review DTOs. The database
// and profile authorization paths are covered separately; this test makes no study writes.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import AxeBuilder from '@axe-core/playwright';
import { test, expect } from '@playwright/test';
import type {
  Mu7OwnAnswer,
  Mu7SubmissionInput,
  Mu7ReviewerUnit,
  Mu7ReviewerWorkspace,
} from '../../../src/lib/mu7-types';

test('revised guide, unsaved subtype answer and accessible mobile reference navigation', async ({
  browser,
}) => {
  const context = await browser.newContext({ baseURL: 'http://127.0.0.1:3100' });
  const page = await context.newPage();
  const guideText = readFileSync('docs/reviewer/REVIEWER_GUIDE_v81_r4.md', 'utf8');
  const reviewerProfile = {
    profileId: 'mu81-plain-language-r4' as const,
    rubricSha256: createHash('sha256').update(guideText).digest('hex'),
    bindingSha256: 'b'.repeat(64),
    designVersion: 'SYN-8-1-UI-PROFILE',
    guideText,
  };
  let ownAnswers: Mu7OwnAnswer[] = [];
  const submitted: Mu7SubmissionInput[] = [];
  const assignmentId = 'synthetic-ui-assignment';
  const workspace = (): Mu7ReviewerWorkspace => ({
    kind: 'reviewer',
    designRecorded: true,
    enrolled: true,
    reviewerProfile,
    training: [],
    trainingAcknowledgedAt: null,
    queue: [
      {
        assignmentId,
        mode: 'PILOT',
        reviewerSlot: 1,
        queuePosition: 1,
        unitId: 'SYN-UI-DIABETES-001',
        unitRole: 'SUBGROUP',
        answered: ownAnswers.length > 0,
        available: true,
      },
    ],
  });
  const detail = (): Mu7ReviewerUnit => ({
    assignmentId,
    mode: 'PILOT',
    queuePosition: 1,
    unitRole: 'SUBGROUP',
    subtypeRequired: true,
    reviewerProfile,
    ownAnswers,
    reasonCodes: [{ code: 'DIABETES_NOT_STUDIED', meaning: 'The trial does not study diabetes.' }],
    packet: {
      unit: {
        unit_id: 'SYN-UI-DIABETES-001',
        mode: 'PILOT',
        family: 'SG',
        category: 'RULE_D_KEPT',
        unit_role: 'SUBGROUP',
        mapping_code: 'RULE_D',
        mapping_label: 'Rule D, diabetes type',
        assignment_code: 'D4B_KEEP_UNRESOLVED_COMPLICATION_ONLY',
        assignment_status: 'ASSIGNED',
        display_text: 'diabetes, type not stated in the registry headings',
        display_decision: 'KEEP: kept in the Diabetes Mellitus row',
        parent_row_label: 'Diabetes Mellitus',
      },
      trial: {
        nct_id: 'SYN-NCT-UI-001',
        brief_title: 'Fictional diabetes evidence for a browser check',
        brief_summary: 'Synthetic text describes a diabetes study without a stated type.',
      },
      notices: ['SYNTHETIC UNIT: excluded from every statistic'],
    },
  });
  try {
    await page.route('**/api/mu7/workspace', (route) => route.fulfill({ json: workspace() }));
    await page.route(`**/api/mu7/assignments/${assignmentId}`, (route) =>
      route.fulfill({ json: detail() }),
    );
    await page.route(`**/api/mu7/assignments/${assignmentId}/submit`, async (route) => {
      const input = route.request().postDataJSON() as Mu7SubmissionInput;
      submitted.push(input);
      ownAnswers = [
        ...ownAnswers,
        {
          answer: input.answer,
          reasonCode: input.reasonCode ?? null,
          note: input.note ?? null,
          uncertain: input.uncertain ?? false,
          diabetesSubtype: input.diabetesSubtype,
          revisionNumber: ownAnswers.length + 1,
          submittedAt: '2026-10-25T12:00:00Z',
        },
      ];
      await route.fulfill({ json: detail() });
    });
    await page.goto('/');
    await page.getByLabel('Pilot account').selectOption('reviewer-a');
    await page
      .getByLabel('Password', { exact: true })
      .fill('e2e-only-generated-fictional-passphrase');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
    await page.getByRole('button', { name: /Mapping units/ }).click();
    await page.getByRole('button', { name: /^Unit 1:/ }).click();
    await expect(page.getByTestId('mu7-mapping-label')).toHaveText('Diabetes inclusion check');
    await expect(page.getByText('Why it was classified this way', { exact: true })).toBeVisible();
    await expect(page.getByText(/Agree confirms the inclusion/)).toBeVisible();
    await page.getByRole('radio', { name: 'Agree', exact: true }).check();
    await expect(page.getByRole('button', { name: 'Save answer', exact: true })).toBeDisabled();
    await page.getByRole('radio', { name: 'Type 2 diabetes is not stated', exact: true }).check();
    await page.getByLabel(/Note \(optional\)/).fill('Synthetic unsaved note stays in place.');
    await page.getByRole('tab', { name: 'Practice cases', exact: true }).focus();
    await page.keyboard.press('End');
    await expect(page.getByRole('tab', { name: 'Review guide', exact: true })).toBeFocused();
    await expect(page.getByRole('article', { name: 'Review instructions' })).toContainText(
      'No additional narrower clinical definitions',
    );
    await expect(page.getByRole('article', { name: 'Review instructions' })).toContainText(
      'same Depression definition',
    );
    await expect(
      page.getByRole('heading', { name: '2. Different things you are judging', exact: true }),
    ).toBeVisible();
    expect(
      (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()).violations,
    ).toEqual([]);
    await page.screenshot({ path: 'test-results/mu81-guide-desktop.png', fullPage: true });
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: 'test-results/mu81-guide-mobile.png', fullPage: true });
    await page.getByRole('tab', { name: 'Review guide', exact: true }).focus();
    await page.keyboard.press('Home');
    await expect(page.getByRole('radio', { name: 'Agree', exact: true })).toBeChecked();
    await expect(
      page.getByRole('radio', { name: 'Type 2 diabetes is not stated', exact: true }),
    ).toBeChecked();
    await expect(page.getByLabel(/Note \(optional\)/)).toHaveValue(
      'Synthetic unsaved note stays in place.',
    );
    expect(submitted).toEqual([]);
    await page.getByRole('button', { name: 'Save answer', exact: true }).click();
    await expect(page.getByTestId('mu7-own-answer')).toContainText(
      'Registry stated-type answer: Type 2 diabetes is not stated.',
    );
    expect(submitted).toHaveLength(1);
    expect(submitted[0].diabetesSubtype).toBe('TYPE_2_NOT_STATED');
    await page.screenshot({ path: 'test-results/mu81-question-mobile.png', fullPage: true });
  } finally {
    await context.close();
  }
});
