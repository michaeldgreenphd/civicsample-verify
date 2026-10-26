// Synthetic intercepted DTOs exercise request timing and failures without touching study records.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import type {
  Mu7OwnAnswer,
  Mu7ReviewerUnit,
  Mu7ReviewerWorkspace,
  Mu7SubmissionInput,
} from '../../../src/lib/mu7-types';

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

async function setup(page: Page) {
  const guideText = readFileSync('docs/reviewer/REVIEWER_GUIDE_v81_r4.md', 'utf8');
  const reviewerProfile = {
    profileId: 'mu81-plain-language-r4' as const,
    rubricSha256: createHash('sha256').update(guideText).digest('hex'),
    bindingSha256: 'b'.repeat(64),
    designVersion: 'SYN-8-1-NAV',
    guideText,
  };
  const control = {
    rejectSave: false,
    failProgress: false,
    failDetail: 0,
    holdSave: null as Promise<void> | null,
    holdDetail: null as { position: number; promise: Promise<void> } | null,
    posts: [] as { position: number; input: Mu7SubmissionInput }[],
    reads: [] as number[],
    abortedReads: [] as number[],
    answers: [[], [], []] as Mu7OwnAnswer[][],
  };
  page.on('requestfailed', (request) => {
    const match = /synthetic-nav-(\d)$/.exec(request.url());
    if (match) control.abortedReads.push(Number(match[1]));
  });
  const workspace = (): Mu7ReviewerWorkspace => ({
    kind: 'reviewer',
    designRecorded: true,
    enrolled: true,
    reviewerProfile,
    training: [],
    trainingAcknowledgedAt: null,
    queue: [1, 2, 3].map((n) => ({
      assignmentId: `synthetic-nav-${n}`,
      mode: 'PILOT',
      reviewerSlot: 1,
      queuePosition: n,
      unitId: `SYN-NAV-${n}`,
      unitRole: n === 3 ? 'SUBGROUP' : 'PRIMARY',
      answered: control.answers[n - 1].length > 0,
      available: n !== 3 || control.answers.slice(0, 2).every((a) => a.length > 0),
    })),
  });
  const detail = (n: number): Mu7ReviewerUnit => ({
    assignmentId: `synthetic-nav-${n}`,
    mode: 'PILOT',
    queuePosition: n,
    unitRole: n === 3 ? 'SUBGROUP' : 'PRIMARY',
    reviewerProfile,
    subtypeRequired: false,
    ownAnswers: control.answers[n - 1],
    reasonCodes: [{ code: 'OTHER_SPECIFIED', meaning: 'Another reason, explained in the note.' }],
    packet: {
      unit: {
        unit_id: `SYN-NAV-${n}`,
        mode: 'PILOT',
        family: n === 3 ? 'SG' : n === 2 ? 'ROW' : 'AREA',
        category: 'SYNTHETIC',
        unit_role: n === 3 ? 'SUBGROUP' : 'PRIMARY',
        mapping_code: 'SYNTHETIC',
        mapping_label:
          n === 3
            ? 'Rule K, malignancy'
            : n === 2
              ? 'Figure 2 condition row: Neoplasms'
              : 'Therapeutic area: Oncology',
        assignment_code:
          n === 3 ? 'K_REMOVE_VERIFIED_NONMALIGNANT' : n === 2 ? 'IN_ROW' : 'IN_AREA',
        assignment_status: 'ASSIGNED',
        display_text:
          n === 3 ? 'Excluded from the Neoplasms group' : 'Fictional membership assignment',
        ...(n === 3
          ? {
              parent_row_label: 'Neoplasms',
              display_decision: 'REMOVE: removed from the Neoplasms row',
            }
          : {}),
      },
      trial: {
        nct_id: `SYN-NCT-NAV-${n}`,
        brief_title: `Fictional navigation trial ${n}`,
        brief_summary: 'Synthetic evidence for a save-and-next interface test.',
      },
      notices: ['Synthetic test fixture'],
    },
  });
  await page.route('**/api/mu7/workspace', (route) => {
    if (control.failProgress) {
      control.failProgress = false;
      return route.fulfill({ status: 503, json: { error: 'Synthetic queue failure.' } });
    }
    return route.fulfill({ json: workspace() });
  });
  await page.route('**/api/mu7/assignments/**', async (route) => {
    const match = /synthetic-nav-(\d)(\/submit)?$/.exec(route.request().url())!;
    const position = Number(match[1]);
    if (match[2]) {
      const input = route.request().postDataJSON() as Mu7SubmissionInput;
      control.posts.push({ position, input });
      if (control.holdSave) await control.holdSave;
      if (control.rejectSave) {
        control.rejectSave = false;
        return route.fulfill({
          status: 503,
          json: { error: 'Synthetic save failure. Your answer was not recorded.' },
        });
      }
      control.answers[position - 1].push({
        answer: input.answer,
        reasonCode: input.reasonCode ?? null,
        note: input.note ?? null,
        uncertain: input.uncertain ?? false,
        revisionNumber: control.answers[position - 1].length + 1,
        submittedAt: '2026-10-26T12:00:00Z',
      });
    } else {
      control.reads.push(position);
      if (control.holdDetail?.position === position) await control.holdDetail.promise;
      if (control.failDetail === position) {
        control.failDetail = 0;
        return route.fulfill({ status: 503, json: { error: 'Synthetic case-loading failure.' } });
      }
    }
    await route.fulfill({ json: detail(position) }).catch(() => undefined); // A stale GET may be cancelled.
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
  await expect(page.getByTestId('mu7-unit-id')).toHaveText('SYN-NAV-1');
  return control;
}

test('save and next waits for persistence, unlocks the next check and finishes without repeating a case', async ({
  page,
}) => {
  const state = await setup(page);
  const panel = page.getByRole('region', { name: 'Your answer', exact: true });
  await expect(page.getByRole('button', { name: /^Unit 3:/ })).toBeDisabled();
  await page.getByRole('radio', { name: 'Agree', exact: true }).check();
  const next = page.getByRole('button', { name: 'Save and next', exact: true });
  const stay = page.getByRole('button', { name: 'Save answer', exact: true });
  for (const width of [1280, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    const [a, b] = await Promise.all([next.boundingBox(), stay.boundingBox()]);
    expect(a!.height).toBeGreaterThanOrEqual(48);
    expect(b!.height).toBeGreaterThanOrEqual(48);
    if (width < 600) expect(b!.y - (a!.y + a!.height)).toBeGreaterThanOrEqual(12);
    else expect(b!.x - (a!.x + a!.width)).toBeGreaterThanOrEqual(12);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    if (width !== 320) await panel.screenshot({ path: `test-results/save-next-${width}.png` });
  }
  await page.setViewportSize({ width: 390, height: 900 });
  const hold = deferred();
  state.holdSave = hold.promise;
  await next.focus();
  await page.keyboard.press('Enter');
  await expect.poll(() => state.posts.length).toBe(1);
  await expect(page.getByRole('button', { name: 'Saving…', exact: true })).toBeDisabled();
  await expect(stay).toBeDisabled();
  await expect(page.getByRole('radio', { name: 'Agree', exact: true })).toBeDisabled();
  await expect(page.getByLabel('Choose a practice case')).toBeDisabled();
  await page.keyboard.press('Enter');
  expect(state.posts).toHaveLength(1);
  await expect(page.getByTestId('mu7-unit-id')).toHaveText('SYN-NAV-1');
  hold.release();
  await expect(page.getByTestId('mu7-brief-title')).toHaveText('Fictional navigation trial 2');
  await expect(page.getByTestId('mu7-brief-title')).toBeFocused();
  await expect(page.getByRole('status')).toContainText('Case 1 saved. Next: case 2 of 3.');
  await expect(
    panel.getByRole('radiogroup', { name: 'Answer', exact: true }).locator('input:checked'),
  ).toHaveCount(0);
  await expect(page.getByLabel(/Note \(optional\)/)).toHaveValue('');
  await page.getByRole('radio', { name: 'Agree', exact: true }).check();
  await page.getByRole('button', { name: 'Save and next', exact: true }).click();
  await expect(page.getByTestId('mu7-brief-title')).toHaveText('Fictional navigation trial 3');
  await expect(panel.getByRole('heading')).toHaveText('Exclusion check — Neoplasms');
  await expect(page.getByRole('button', { name: 'Save and next', exact: true })).toHaveCount(0);
  await page.getByRole('radio', { name: 'Agree', exact: true }).check();
  await page.getByRole('button', { name: 'Save answer', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('All 3 answers are saved.');
  await expect(page.getByRole('progressbar')).toHaveAttribute('value', '3');
  await expect(page.getByTestId('mu7-unit-id')).toHaveText('SYN-NAV-3');
  expect(state.posts.map((p) => p.position)).toEqual([1, 2, 3]);
  expect(
    (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()).violations,
  ).toEqual([]);
});

test('save failure preserves the draft; progress retry after a confirmed save never repeats the POST', async ({
  page,
}) => {
  const state = await setup(page);
  state.rejectSave = true;
  await page.getByRole('radio', { name: 'Disagree', exact: true }).check();
  await page.getByLabel('Reason (required)').selectOption('OTHER_SPECIFIED');
  await page
    .getByLabel('Note (required)')
    .fill('Synthetic rationale that must survive a failed save.');
  await page.getByLabel(/I am answering, but I am not sure/).check();
  await page.getByRole('button', { name: 'Save and next', exact: true }).click();
  await expect(
    page.getByRole('tabpanel', { name: 'Practice cases', exact: true }).getByRole('alert'),
  ).toContainText('Your answer was not recorded');
  await expect(page.getByTestId('mu7-unit-id')).toHaveText('SYN-NAV-1');
  await expect(page.getByRole('radio', { name: 'Disagree', exact: true })).toBeChecked();
  await expect(page.getByLabel('Note (required)')).toHaveValue(
    'Synthetic rationale that must survive a failed save.',
  );
  await expect(page.getByLabel('Reason (required)')).toHaveValue('OTHER_SPECIFIED');
  await expect(page.getByLabel(/I am answering, but I am not sure/)).toBeChecked();
  state.failProgress = true;
  await page.getByRole('button', { name: 'Save and next', exact: true }).click();
  await expect(
    page.getByRole('tabpanel', { name: 'Practice cases', exact: true }).getByRole('alert'),
  ).toContainText('Your answer was saved, but progress could not be refreshed.');
  await expect(page.getByTestId('mu7-own-answer')).toContainText('Disagree');
  await expect(page.getByRole('button', { name: 'Save and next', exact: true })).toBeDisabled();
  expect(state.answers[0]).toHaveLength(1);
  await page.getByRole('button', { name: 'Retry progress', exact: true }).click();
  await expect(page.getByTestId('mu7-unit-id')).toHaveText('SYN-NAV-2');
  expect(state.posts).toHaveLength(2); // One rejected attempt, one confirmed save; retry is GET only.
  expect(state.answers[0]).toHaveLength(1);
  await expect(page.getByRole('radio', { name: 'Disagree', exact: true })).not.toBeChecked();
  await expect(page.getByLabel(/I am answering, but I am not sure/)).not.toBeChecked();
});

test('a failed next-case read can be retried without another answer submission', async ({
  page,
}) => {
  const state = await setup(page);
  state.failDetail = 2;
  await page.getByRole('radio', { name: 'Agree', exact: true }).check();
  await page.getByRole('button', { name: 'Save and next', exact: true }).click();
  await expect(
    page.getByRole('tabpanel', { name: 'Practice cases', exact: true }).getByRole('alert'),
  ).toContainText('Synthetic case-loading failure.');
  await expect(page.getByRole('status')).toContainText('Case 1 saved.');
  await page.getByRole('button', { name: 'Retry loading case', exact: true }).click();
  await expect(page.getByTestId('mu7-unit-id')).toHaveText('SYN-NAV-2');
  await expect(page.getByTestId('mu7-brief-title')).toBeFocused();
  expect(state.posts).toHaveLength(1);
});

test('an older case read cannot overwrite the current case or its unsaved text', async ({
  page,
}) => {
  const state = await setup(page);
  const hold = deferred();
  state.holdDetail = { position: 2, promise: hold.promise };
  await page.getByRole('button', { name: /^Unit 2:/ }).click();
  await expect(page.getByText('Loading case…', { exact: true })).toBeVisible();
  await expect.poll(() => state.reads.includes(2)).toBe(true);
  await page.getByRole('button', { name: /^Unit 1:/ }).click();
  await expect.poll(() => state.abortedReads.includes(2)).toBe(true);
  await expect(page.getByTestId('mu7-unit-id')).toHaveText('SYN-NAV-1');
  await page.getByLabel('Note (optional)').fill('New unsaved text on the current case.');
  hold.release();
  await expect(page.getByTestId('mu7-unit-id')).toHaveText('SYN-NAV-1');
  await expect(page.getByLabel('Note (optional)')).toHaveValue(
    'New unsaved text on the current case.',
  );
  expect(state.posts).toEqual([]);
});
