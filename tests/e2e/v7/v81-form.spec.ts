// Served component check with synthetic API fixtures. The real DB/RLS and export roundtrip are
// exercised separately by mu81-subtype.test.ts and mu8-roundtrip.test.ts.
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import type { Mu7ReviewerUnit, Mu7ReviewerWorkspace } from '../../../src/lib/mu7-types';

test('v8.1 subtype control: required, readable, persistent on reload, mobile and desktop', async ({
  page,
}) => {
  const assignmentId = '10000000-0000-4000-8000-000000000001';
  const unitId = 'SYN7-SG-RULE_D_KEPT-901';
  const detail: Mu7ReviewerUnit = {
    assignmentId,
    mode: 'PILOT',
    queuePosition: 1,
    unitRole: 'SUBGROUP',
    subtypeRequired: true,
    packet: {
      unit: {
        unit_id: unitId,
        mode: 'PILOT',
        family: 'SG',
        category: 'RULE_D_KEPT',
        unit_role: 'SUBGROUP',
        mapping_code: 'RULE_D',
        mapping_label: 'Diabetes membership',
        assignment_code: 'D4A_KEEP_UNRESOLVED_PARENT_ONLY',
        assignment_status: 'ASSIGNED',
        display_text: 'Diabetes of a type not stated',
      },
      trial: {
        nct_id: 'SYN-NCT-1901',
        brief_title: 'Fictional diabetes trial for interface testing',
        brief_summary:
          'Synthetic evidence only. The trial studies diabetes; its type is not stated.',
      },
      notices: [],
    },
    reasonCodes: [{ code: 'DIABETES_NOT_STUDIED', meaning: 'The trial does not study diabetes.' }],
    ownAnswers: [],
  };
  const workspace: Mu7ReviewerWorkspace = {
    kind: 'reviewer',
    designRecorded: true,
    enrolled: true,
    queue: [
      {
        assignmentId,
        mode: 'PILOT',
        reviewerSlot: 1,
        queuePosition: 1,
        unitId,
        unitRole: 'SUBGROUP',
        answered: false,
        available: true,
      },
    ],
    training: [],
    trainingAcknowledgedAt: null,
  };
  await page.route('**/api/mu7/workspace', (route) => route.fulfill({ json: workspace }));
  await page.route(`**/api/mu7/assignments/${assignmentId}`, (route) =>
    route.fulfill({ json: detail }),
  );
  await page.route(`**/api/mu7/assignments/${assignmentId}/submit`, async (route) => {
    const body = route.request().postDataJSON();
    expect(body.answer).toBe('AGREE');
    expect(body.reasonCode).toBe(null);
    expect(body.diabetesSubtype).toBe('TYPE_2_NOT_STATED');
    detail.ownAnswers.push({
      revisionNumber: 1,
      answer: 'AGREE',
      reasonCode: null,
      note: null,
      uncertain: false,
      submittedAt: '2026-01-01T00:00:00Z',
      diabetesSubtype: body.diabetesSubtype,
    });
    workspace.queue[0].answered = true;
    await route.fulfill({ json: detail });
  });
  await page.goto('/');
  await page.getByLabel('Pilot account').selectOption('reviewer-a');
  await page
    .getByLabel('Password', { exact: true })
    .fill('e2e-only-generated-fictional-passphrase');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByRole('button', { name: /Mapping units/ }).click();
  await page.getByRole('button', { name: `Unit 1: ${unitId}` }).click();
  await page.getByRole('radio', { name: 'Agree', exact: true }).check();
  await expect(page.getByRole('button', { name: 'Save answer', exact: true })).toBeDisabled();
  await page.getByRole('radio', { name: 'Type 2 diabetes is not stated', exact: true }).check();
  await page.getByRole('button', { name: 'Save answer', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Your answer is saved.');
  await page.reload();
  await page.getByRole('button', { name: /Mapping units/ }).click();
  await page.getByRole('button', { name: `Unit 1: ${unitId}` }).click();
  await expect(
    page.getByRole('radio', { name: 'Type 2 diabetes is not stated', exact: true }),
  ).toBeChecked();
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    const scan = await new AxeBuilder({ page })
      .include('section[aria-label="Your answer"]')
      .analyze();
    expect(scan.violations).toEqual([]);
    await page.screenshot({ path: `test-results/v81-subtype-${width}.png`, fullPage: true });
  }
});
