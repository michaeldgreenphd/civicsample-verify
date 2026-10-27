import { expect, test } from '@playwright/test';
import type {
  Mu7AdjudicationInput,
  Mu7AdjudicatorUnit,
  Mu7AdjudicatorWorkspace,
} from '../../../src/lib/mu7-types';

const ids = ['SYN-UI-ADJ-001', 'SYN-UI-ADJ-002'];
function detail(unitId: string): Mu7AdjudicatorUnit {
  return {
    unitId,
    mode: 'PILOT',
    packet: {
      unit: {
        unit_id: unitId,
        mode: 'PILOT',
        family: 'AREA',
        category: 'CARDIOVASCULAR',
        unit_role: 'PRIMARY',
        mapping_code: 'C14',
        mapping_label: 'Therapeutic area: Cardiovascular',
        assignment_code: 'ASSIGNED',
        assignment_status: 'ASSIGNED',
        display_text: 'in this area',
      },
      trial: {
        nct_id: 'SYN-NCT-ADJ-UI',
        brief_title: `Fictional adjudication interface case ${unitId}`,
        brief_summary: 'Invented cardiovascular evidence for an interface regression.',
      },
      notices: ['Synthetic interface test only.'],
    },
    answers: [
      {
        reviewerSlot: 1,
        answer: unitId === ids[0] ? 'CANNOT_TELL' : 'AGREE',
        reasonCode: null,
        note: 'Fictional reviewer 1 note.',
        uncertain: false,
      },
      {
        reviewerSlot: 2,
        answer: unitId === ids[0] ? 'AGREE' : 'DISAGREE',
        reasonCode: unitId === ids[0] ? null : 'OTHER_SPECIFIED',
        note: 'Fictional reviewer 2 note.',
        uncertain: false,
      },
    ],
    reasonCodes: [{ code: 'OTHER_SPECIFIED', meaning: 'Another reason, written in the note.' }],
    disagreementReasons: [],
    adjudication: null,
    referenceLocked: false,
  };
}
const workspace: Mu7AdjudicatorWorkspace = {
  kind: 'adjudicator',
  designRecorded: true,
  training: [],
  queue: ids.map((unitId) => ({
    unitId,
    mode: 'PILOT',
    family: 'AREA',
    category: 'CARDIOVASCULAR',
    unitRole: 'PRIMARY',
    mappingLabel: 'Therapeutic area: Cardiovascular',
    displayText: 'in this area',
    adjudicated: false,
  })),
};

test('adjudication requires a deliberate decision, matching basis and a fresh form per case', async ({
  page,
}) => {
  const posts: Mu7AdjudicationInput[] = [];
  let releaseSubmission!: () => void;
  const submissionReleased = new Promise<void>((resolve) => (releaseSubmission = resolve));
  await page.route('**/api/mu7/workspace', (route) => route.fulfill({ json: workspace }));
  await page.route('**/api/mu7/adjudication/*', (route) =>
    route.fulfill({ json: detail(route.request().url().split('/').at(-1)!) }),
  );
  await page.route('**/api/mu7/adjudicate', async (route) => {
    const input = route.request().postDataJSON() as Mu7AdjudicationInput;
    posts.push(input);
    await submissionReleased;
    const response = detail(input.unitId);
    response.adjudication = {
      ...input,
      decision: input.decision ?? null,
      reasonCode: input.reasonCode ?? null,
      disagreementReasonCode: null,
      decidedAt: '2026-10-27T12:00:00Z',
    };
    await route.fulfill({ json: response });
  });
  await page.goto('/');
  await page.getByLabel('Pilot account').selectOption('adjudicator');
  await page
    .getByLabel('Password', { exact: true })
    .fill('e2e-only-generated-fictional-passphrase');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByRole('button', { name: /Mapping units/ }).click();
  await page.getByRole('button', { name: new RegExp(`^${ids[0]}`) }).click();
  const decision = page.getByRole('combobox', { name: 'Decision', exact: true });
  const basis = page.getByRole('combobox', { name: 'Basis', exact: true });
  const rationale = page.getByRole('textbox', { name: 'Rationale', exact: true });
  const save = page.getByRole('button', { name: 'Record the tie-break' });
  await expect(decision).toHaveValue('');
  await expect(basis).toBeDisabled();
  await rationale.fill('A rationale alone must never choose an answer for the adjudicator.');
  await expect(save).toBeDisabled();
  expect(posts).toHaveLength(0);

  // Reviewer 1 could not tell; only Reviewer 2 can be adopted for Agree.
  await decision.selectOption('AGREE');
  await expect(basis).toHaveValue('REVIEWER_2');
  await expect(basis.locator('option[value="REVIEWER_1"]')).toHaveCount(0);
  await expect(save).toBeEnabled();
  await decision.selectOption('DISAGREE');
  await expect(basis).toHaveValue('NEITHER');
  await expect(save).toBeDisabled();
  await page.getByRole('combobox', { name: 'Reason', exact: true }).selectOption('OTHER_SPECIFIED');
  await expect(save).toBeEnabled();

  // Switching cases must not retain the decision, basis, reason or rationale.
  await page.getByRole('button', { name: new RegExp(`^${ids[1]}`) }).click();
  await expect(decision).toHaveValue('');
  await expect(rationale).toHaveValue('');
  await expect(basis).toHaveValue('');
  await expect(page.getByRole('combobox', { name: 'Reason', exact: true })).toHaveCount(0);
  await rationale.fill('Fictional reason for adopting the appropriate independent answer.');
  await expect(save).toBeDisabled();
  await decision.selectOption('AGREE');
  await expect(basis).toHaveValue('REVIEWER_1');
  const submissionSent = page.waitForRequest('**/api/mu7/adjudicate');
  await save.click();
  await submissionSent;
  await expect(page.getByRole('button', { name: new RegExp(`^${ids[0]}`) })).toBeDisabled();
  await expect(save).toBeDisabled();
  releaseSubmission();
  await expect(page.getByTestId('mu7-adjudication')).toContainText('Resolved: Agree');
  expect(posts).toHaveLength(1);
  expect(posts[0]).toMatchObject({
    unitId: ids[1],
    decision: 'AGREE',
    basis: 'REVIEWER_1',
    reasonCode: null,
  });
});

test('a delayed adjudication case cannot erase the next case or its draft', async ({ page }) => {
  let releaseFirst!: () => void;
  let firstRequested!: () => void;
  const firstArrived = new Promise<void>((resolve) => (firstRequested = resolve));
  const firstReleased = new Promise<void>((resolve) => (releaseFirst = resolve));
  let firstHandled!: () => void;
  const firstDone = new Promise<void>((resolve) => (firstHandled = resolve));
  await page.route('**/api/mu7/workspace', (route) => route.fulfill({ json: workspace }));
  await page.route('**/api/mu7/adjudication/*', async (route) => {
    const id = route.request().url().split('/').at(-1)!;
    if (id === ids[0]) {
      firstRequested();
      await firstReleased;
      try {
        await route.fulfill({ json: detail(id) });
      } catch {
        // The obsolete request is intentionally aborted when another case is selected.
      } finally {
        firstHandled();
      }
    } else await route.fulfill({ json: detail(id) });
  });
  await page.goto('/');
  await page.getByLabel('Pilot account').selectOption('adjudicator');
  await page
    .getByLabel('Password', { exact: true })
    .fill('e2e-only-generated-fictional-passphrase');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByRole('button', { name: /Mapping units/ }).click();
  await page.getByRole('button', { name: new RegExp(`^${ids[0]}`) }).click();
  await firstArrived;
  await page.getByRole('button', { name: new RegExp(`^${ids[1]}`) }).click();
  await page.getByRole('combobox', { name: 'Decision', exact: true }).selectOption('DISAGREE');
  await page.getByRole('combobox', { name: 'Reason', exact: true }).selectOption('OTHER_SPECIFIED');
  await page
    .getByRole('textbox', { name: 'Rationale', exact: true })
    .fill('Keep this second-case draft.');
  releaseFirst();
  await firstDone;
  // A new browser request ensures the earlier routed response has had an opportunity to arrive.
  await page.evaluate(() => fetch('/api/mu7/workspace').then((r) => r.json()));
  await expect(page.getByTestId('mu7-brief-title')).toContainText(ids[1]);
  await expect(page.getByRole('combobox', { name: 'Decision', exact: true })).toHaveValue(
    'DISAGREE',
  );
  await expect(page.getByRole('combobox', { name: 'Basis', exact: true })).toHaveValue(
    'REVIEWER_2',
  );
  await expect(page.getByRole('textbox', { name: 'Rationale', exact: true })).toHaveValue(
    'Keep this second-case draft.',
  );
});
