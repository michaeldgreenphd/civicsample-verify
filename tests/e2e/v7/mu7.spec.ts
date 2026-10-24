// Review design v7 (mapping units) in the served application, four separate browser sessions:
// investigator, pilot reviewer A, pilot reviewer B and the adjudicator. Synthetic units only.
// Covers the worked examples, independent answers with the planted guard refusals, save and
// reload with a revision, blinding and permission denials at the API, the tie-break of the routed
// units, the account lock and its release, the pilot lock, and the bundle 7.0 export checked byte
// for byte against its manifest and its registration. The formal review stays disabled.
import { createHash } from 'node:crypto';
import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import PILOT from '../../handoff/fixtures/v7/SYNTHETIC_PILOT_UNITS_v7.json';

const password = 'e2e-only-generated-fictional-passphrase';
const origin = 'http://127.0.0.1:3100';
const ATT = 'Synthetic attestation for the v7 browser regression, twenty characters or more.';
// Design rows, weights, the walkthrough and pseudonymous ids never reach a reviewer or adjudicator.
const hidden =
  /stratum|selection_probability|frame_stratum_size|prn_key|sampling_seed|design_row|walkthrough|planted|expected_routing|reviewer_pseudo_id|request\.jwt|service_role/i;
const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
type Planted = {
  reviewer_slot: 1 | 2;
  answer: string;
  reason_code: string | null;
  note: string | null;
  uncertain: boolean;
};
const UNITS = (
  PILOT as unknown as {
    units: {
      import: { unit_id: string; unit_role: string };
      walkthrough: { planted_answers: Planted[]; expected_routing: string };
    }[];
  }
).units;
const planted = (unitId: string, slot: 1 | 2) =>
  UNITS.find((u) => u.import.unit_id === unitId)!.walkthrough.planted_answers.find(
    (p) => p.reviewer_slot === slot,
  )!;
const ROUTED = UNITS.filter((u) =>
  ['AGREE_VS_DISAGREE', 'ONE_CANNOT_TELL'].includes(u.walkthrough.expected_routing),
)
  .map((u) => u.import.unit_id)
  .sort();

async function signIn(page: Page, account: string) {
  await page.goto('/');
  await page.getByLabel('Pilot account').selectOption(account);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
  await page.getByRole('button', { name: /Mapping units/ }).click();
}
const post = (context: BrowserContext, path: string, data: unknown) =>
  context.request.post(path, { data, headers: { origin } });
interface QueueItem {
  assignmentId: string;
  unitId: string;
  unitRole: string;
  available: boolean;
  answered: boolean;
}
const queueOf = async (c: BrowserContext) =>
  ((await (await c.request.get('/api/mu7/workspace')).json()) as { queue: QueueItem[] }).queue;
async function answerByApi(c: BrowserContext, slot: 1 | 2, skip: string[] = []) {
  for (const q of await queueOf(c)) {
    if (q.answered || skip.includes(q.unitId)) continue;
    const p = planted(q.unitId, slot);
    const r = await post(c, `/api/mu7/assignments/${q.assignmentId}/submit`, {
      answer: p.answer,
      reasonCode: p.reason_code,
      note: p.note,
      uncertain: p.uncertain,
    });
    expect(r.status(), `${q.unitId}: ${await r.text()}`).toBe(200);
  }
}

test('review design v7: synthetic pilot across four separate sessions, lock and verified export', async ({
  browser,
}) => {
  const contexts = await Promise.all(
    Array.from({ length: 4 }, () => browser.newContext({ baseURL: origin })),
  );
  const [admin, a, b, adj] = contexts;
  const [adminPage, aPage, bPage, adjPage] = await Promise.all(contexts.map((c) => c.newPage()));
  try {
    // ---- investigator: design, import, assignment ---------------------------------------------
    await signIn(adminPage, 'investigator');
    await expect(adminPage.getByTestId('mu7-phase')).toContainText('No design recorded');
    await expect(adminPage.getByText('Formal review disabled')).toBeVisible();
    await adminPage.getByLabel(/Attestation/).fill(ATT);
    await adminPage.getByRole('button', { name: 'Record the synthetic design' }).click();
    await expect(adminPage.getByTestId('mu7-phase')).toContainText('Pilot open');
    await adminPage.getByRole('button', { name: 'Import the synthetic pilot units' }).click();
    await expect(adminPage.getByRole('button', { name: 'Pilot units imported' })).toBeDisabled();
    await adminPage.getByRole('button', { name: 'Import the worked examples' }).click();
    await expect(
      adminPage.getByRole('button', { name: 'Worked examples imported' }),
    ).toBeDisabled();
    await adminPage.getByRole('button', { name: 'Assign both pilot queues' }).click();
    await expect(adminPage.getByRole('button', { name: 'Both queues assigned' })).toBeDisabled();
    // The pilot cannot lock before the answers and tie-breaks (guard message shown as is).
    await adminPage.getByLabel(/Attestation/).fill(ATT);
    await adminPage.getByRole('button', { name: 'Lock the pilot reference' }).click();
    await expect(adminPage.locator('.notice.error')).toContainText('MU7-G48:');

    for (const [page, account] of [
      [aPage, 'reviewer-a'],
      [bPage, 'reviewer-b'],
      [adjPage, 'adjudicator'],
    ] as const)
      await signIn(page, account);

    // ---- permission denials at the API (role before body) --------------------------------------
    const firstA = (await queueOf(a))[0];
    expect((await post(a, '/api/mu7/admin/action', { action: 'import-pilot' })).status()).toBe(403);
    expect((await a.request.get('/api/mu7/admin/export/PILOT')).status()).toBe(403);
    expect((await a.request.get(`/api/mu7/adjudication/${ROUTED[0]}`)).status()).toBe(403);
    expect((await post(a, '/api/mu7/adjudicate', {})).status()).toBe(403);
    expect((await adj.request.get(`/api/mu7/assignments/${firstA.assignmentId}`)).status()).toBe(
      403,
    );
    expect((await b.request.get(`/api/mu7/assignments/${firstA.assignmentId}`)).status()).toBe(404);
    expect(
      (
        await post(b, `/api/mu7/assignments/${firstA.assignmentId}/submit`, { answer: 'AGREE' })
      ).status(),
    ).toBe(404);
    expect((await post(admin, '/api/mu7/admin/action', { action: 'freeze' })).status()).toBe(400);
    expect((await admin.request.get('/api/mu7/admin/export/FORMAL')).status()).toBe(409);

    // ---- reviewer A in the browser --------------------------------------------------------------
    await expect(aPage.getByRole('button', { name: /^Unit 9:/ })).toBeDisabled();
    await expect(aPage.getByRole('group', { name: 'Choose a worked example' })).toBeHidden();
    await aPage.getByRole('tab', { name: 'Worked examples' }).click();
    await aPage.getByRole('button', { name: /Example 3/ }).click();
    await expect(
      aPage.getByRole('region', { name: 'Illustrative answers and outcome' }),
    ).not.toContainText('ORGAN_OF_ORIGIN_ONLY');
    await expect(
      aPage.getByRole('region', { name: 'Illustrative answers and outcome' }),
    ).toContainText('Organ of origin only');
    await expect(
      aPage.getByText('the adjudicator adopts Reviewer 2', { exact: false }),
    ).toBeVisible();
    // A failed acknowledgment stays visible on the examples tab and is safe to retry.
    await aPage.route(
      '**/api/mu7/training/acknowledge',
      (route) =>
        route.fulfill({
          status: 503,
          json: { error: 'Synthetic temporary acknowledgment failure.' },
        }),
      { times: 1 },
    );
    await aPage.getByRole('button', { name: 'Mark the worked examples as read' }).click();
    await expect(
      aPage.getByRole('alert').filter({ hasText: 'Synthetic temporary acknowledgment failure.' }),
    ).toBeVisible();
    await aPage.getByRole('button', { name: 'Mark the worked examples as read' }).click();
    await expect(aPage.getByTestId('mu7-training-ack')).toContainText('Read ');
    await aPage.getByRole('button', { name: 'Back to practice cases' }).click();
    // The adjudicator can study illustrations before any actual response is available.
    const beforeAnswers = await (await adj.request.get('/api/mu7/workspace')).json();
    expect(beforeAnswers.queue).toEqual([]);
    expect(beforeAnswers.training).toHaveLength(3);
    await adjPage.getByRole('tab', { name: 'Worked examples' }).click();
    await expect(adjPage.getByRole('group', { name: 'Choose a worked example' })).toBeVisible();
    await expect(adjPage.getByTestId('mu7-slot-1')).toHaveCount(0);
    await adjPage.getByRole('tab', { name: 'Review guide' }).click();
    await expect(adjPage.getByRole('article')).toContainText(
      'You do not enter a third independent reviewer answer.',
    );
    await expect(adjPage.getByTestId('mu7-slot-1')).toHaveCount(0);
    await adjPage.getByRole('tab', { name: 'Adjudication', exact: true }).click();
    const aQueue = await queueOf(a);
    const disagreeUnit = aQueue.find(
      (q) => q.unitRole === 'PRIMARY' && planted(q.unitId, 1).answer === 'DISAGREE',
    )!;
    const pos = aQueue.indexOf(disagreeUnit) + 1;
    await aPage.getByRole('button', { name: new RegExp(`^Unit ${pos}:`) }).click();
    await expect(aPage.getByTestId('mu7-unit-id')).toHaveText(disagreeUnit.unitId);
    await expect(aPage.getByTestId('mu7-family-label')).toHaveText(
      /Therapeutic area|Condition row/,
    );
    await expect(aPage.getByTestId('mu7-notice')).toContainText(
      'Synthetic unit · excluded from every statistic',
    );
    const p = planted(disagreeUnit.unitId, 1);
    await aPage.getByRole('radio', { name: 'Disagree', exact: true }).check();
    await aPage.getByLabel(/^Reason \(required\)/).selectOption(p.reason_code!);
    await expect(aPage.getByLabel(/^Reason \(required\)/).locator('option:checked')).not.toHaveText(
      /_/,
    );
    await expect(aPage.locator('#mu7-reviewer-reason-help')).not.toBeEmpty();
    await aPage.getByRole('button', { name: 'Save answer' }).click();
    await expect(aPage.locator('.notice.error')).toContainText(
      'MU7-G36: a DISAGREE answer needs a note',
    );
    await aPage.getByLabel(/Note/).fill(p.note!);
    await aPage.getByLabel(/not sure/).check();
    // Switching to a read-only example must neither submit nor discard the unsaved form.
    const writes: string[] = [];
    const captureWrite = (request: import('@playwright/test').Request) => {
      if (request.method() === 'POST') writes.push(request.url());
    };
    aPage.on('request', captureWrite);
    await aPage.getByRole('tab', { name: 'Practice cases', exact: true }).focus();
    await aPage.keyboard.press('ArrowRight');
    await expect(aPage.getByRole('tab', { name: 'Worked examples' })).toBeFocused();
    for (const example of [1, 2, 3]) {
      await aPage.getByRole('button', { name: new RegExp(`Example ${example}`) }).click();
      await expect(
        aPage.getByRole('region', { name: 'Illustrative answers and outcome' }),
      ).toBeVisible();
    }
    expect(
      (await new AxeBuilder({ page: aPage }).withTags(['wcag2a', 'wcag2aa']).analyze()).violations,
    ).toEqual([]);
    await aPage.screenshot({ path: 'test-results/mu7-examples-desktop.png', fullPage: true });
    await aPage.setViewportSize({ width: 390, height: 844 });
    await aPage.screenshot({ path: 'test-results/mu7-examples-mobile.png', fullPage: true });
    for (const width of [320, 640]) {
      await aPage.setViewportSize({ width, height: 844 });
      expect(
        await aPage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
    }
    // The guide is a third read-only panel, with full keyboard wrapping and preserved input.
    await aPage.setViewportSize({ width: 1280, height: 900 });
    await aPage.getByRole('tab', { name: 'Worked examples' }).focus();
    await aPage.keyboard.press('ArrowRight');
    const guideTab = aPage.getByRole('tab', { name: 'Review guide', exact: true });
    await expect(guideTab).toBeFocused();
    const guide = aPage.getByRole('article', { name: 'Synthetic practice review guide' });
    await expect(guide).toContainText('practice-guide-1.0');
    await expect(guide.getByRole('heading', { level: 3 })).toHaveText(
      'Save an answer, then move to the next unit',
    );
    for (const label of ['Therapeutic area', 'Condition row', 'Subgroup decision'])
      await expect(guide.getByText(label, { exact: true })).toBeVisible();
    expect(
      (await new AxeBuilder({ page: aPage }).withTags(['wcag2a', 'wcag2aa']).analyze()).violations,
    ).toEqual([]);
    await aPage.screenshot({ path: 'test-results/mu7-guide-desktop.png', fullPage: true });
    for (const width of [320, 390, 640]) {
      await aPage.setViewportSize({ width, height: 844 });
      expect(
        await aPage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      const box = await guideTab.boundingBox();
      expect(box!.height).toBeGreaterThanOrEqual(44);
      if (width === 390) {
        await aPage.screenshot({ path: 'test-results/mu7-guide-mobile.png', fullPage: true });
        expect(
          (await new AxeBuilder({ page: aPage }).withTags(['wcag2a', 'wcag2aa']).analyze())
            .violations,
        ).toEqual([]);
      }
    }
    await guideTab.focus();
    await aPage.keyboard.press('ArrowRight');
    await expect(aPage.getByRole('tab', { name: 'Practice cases', exact: true })).toBeFocused();
    await aPage.keyboard.press('ArrowLeft');
    await expect(guideTab).toBeFocused();
    await aPage.keyboard.press('Home');
    await aPage.keyboard.press('End');
    await expect(guideTab).toBeFocused();
    await aPage.setViewportSize({ width: 390, height: 844 });

    await aPage.keyboard.press('Home');
    await expect(aPage.getByRole('tab', { name: 'Practice cases', exact: true })).toBeFocused();
    await expect(aPage.getByRole('radio', { name: 'Disagree', exact: true })).toBeChecked();
    await expect(aPage.getByLabel(/^Reason \(required\)/)).toHaveValue(p.reason_code!);
    await expect(aPage.getByLabel(/Note/)).toHaveValue(p.note!);
    await expect(aPage.getByLabel(/not sure/)).toBeChecked();
    expect(writes).toEqual([]);
    aPage.off('request', captureWrite);
    expect(
      (
        await a.request
          .get(`/api/mu7/assignments/${disagreeUnit.assignmentId}`)
          .then((r) => r.json())
      ).ownAnswers,
    ).toHaveLength(0);
    await expect(aPage.getByLabel('Choose a practice case')).toHaveValue(disagreeUnit.assignmentId);
    await expect(
      aPage
        .getByLabel('Choose a practice case')
        .locator('option')
        .filter({ hasText: 'Opens later' })
        .first(),
    ).toHaveJSProperty('disabled', true);
    // Saving on mobile persists the answer; changing the mobile picker loads the right case.
    await aPage.getByLabel(/not sure/).uncheck();
    await aPage.getByRole('button', { name: 'Save answer' }).click();
    await expect(aPage.getByTestId('mu7-own-answer')).toContainText(
      'Your answer on record: Disagree',
    );
    await expect(aPage.getByTestId('mu7-own-answer')).toContainText('MeSH placement misleading');
    expect(
      (
        await a.request
          .get(`/api/mu7/assignments/${disagreeUnit.assignmentId}`)
          .then((r) => r.json())
      ).ownAnswers.at(-1).reasonCode,
    ).toBe(p.reason_code);
    expect(await aPage.content()).not.toMatch(hidden);
    const axe = await new AxeBuilder({ page: aPage }).withTags(['wcag2a', 'wcag2aa']).analyze();
    expect(axe.violations).toEqual([]);
    await aPage.screenshot({ path: 'test-results/mu7-reviewer-mobile.png', fullPage: true });
    for (const width of [320, 640]) {
      await aPage.setViewportSize({ width, height: 844 });
      expect(
        await aPage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
    }
    const nextMobile = aQueue.find(
      (q) => q.available && q.assignmentId !== disagreeUnit.assignmentId,
    )!;
    await aPage.getByLabel('Choose a practice case').selectOption(nextMobile.assignmentId);
    await expect(aPage.getByTestId('mu7-unit-id')).toHaveText(nextMobile.unitId);
    await aPage.getByLabel('Choose a practice case').selectOption(disagreeUnit.assignmentId);
    await expect(aPage.getByTestId('mu7-own-answer')).toContainText('Disagree');
    await aPage.setViewportSize({ width: 1440, height: 1000 });
    await aPage.screenshot({ path: 'test-results/mu7-reviewer-desktop.png', fullPage: true });
    // Preview the hosted navigation with the same local authenticated synthetic data.
    // Only the session's display-environment flag is mocked; no Supabase service is contacted.
    const preview = await a.newPage();
    await preview.route('**/api/session', async (route) => {
      const response = await route.fetch();
      const session = await response.json();
      await route.fulfill({ response, json: { ...session, environment: 'supabase-staging' } });
    });
    await preview.setViewportSize({ width: 1440, height: 1000 });
    await preview.goto('/');
    await preview.getByRole('button', { name: new RegExp(`^Unit ${pos}:`) }).click();
    await expect(preview.getByTestId('mu7-own-answer')).toContainText('Disagree');
    await preview.screenshot({
      path: 'test-results/mu7-hosted-practice-desktop.png',
      fullPage: true,
    });
    await preview.getByRole('tab', { name: 'Worked examples' }).click();
    await preview.getByRole('button', { name: /Example 3/ }).click();
    await preview.screenshot({
      path: 'test-results/mu7-hosted-examples-desktop.png',
      fullPage: true,
    });
    await preview.setViewportSize({ width: 390, height: 844 });
    await preview.screenshot({
      path: 'test-results/mu7-hosted-examples-mobile.png',
      fullPage: true,
    });
    await preview.getByRole('tab', { name: 'Practice cases', exact: true }).click();
    await preview.screenshot({
      path: 'test-results/mu7-hosted-practice-mobile.png',
      fullPage: true,
    });
    await preview.close();
    // Save and reload: the answer comes back from the database; a revision keeps the first one.
    await aPage.reload();
    await aPage.getByRole('button', { name: /Mapping units/ }).click();
    await aPage.getByRole('button', { name: new RegExp(`^Unit ${pos}:`) }).click();
    await expect(aPage.getByTestId('mu7-own-answer')).toContainText('Disagree');
    await expect(aPage.getByLabel(/Note/)).toHaveValue(p.note!);
    await aPage.getByLabel(/not sure/).check();
    await aPage.getByRole('button', { name: 'Save revision' }).click();
    await expect(aPage.getByTestId('mu7-own-answer')).toContainText('Revision 2');
    await answerByApi(a, 1);
    // Subgroup units open once every primary unit is answered, restating the parent row.
    await aPage.reload();
    await aPage.getByRole('button', { name: /Mapping units/ }).click();
    await aPage.getByRole('button', { name: /^Unit 9:/ }).click();
    await expect(aPage.getByTestId('mu7-display-decision')).toContainText(/KEEP|REMOVE/);
    await expect(aPage.getByText(/^Parent row:/)).toBeVisible();
    // Registry text that names another trial is shown unchanged.
    const canAll = aQueue.findIndex((q) => q.unitId === 'SYN7-ROW-CAN_ALL-001') + 1;
    await aPage.getByRole('button', { name: new RegExp(`^Unit ${canAll}:`) }).click();
    await expect(aPage.getByTestId('mu7-brief-summary')).toContainText(`NCT${'99000777'}`);

    // ---- reviewer B: independent, never sees A ----------------------------------------------------
    await answerByApi(b, 2);
    const bText =
      (await (await b.request.get('/api/mu7/workspace')).text()) + (await bPage.content());
    expect(bText).not.toContain(p.note!);
    expect(bText).not.toMatch(hidden);
    expect((await post(b, '/api/mu7/training/acknowledge', {})).status()).toBe(200);

    // ---- adjudicator: routed units only ----------------------------------------------------------
    await adjPage.reload();
    await adjPage.getByRole('button', { name: /Mapping units/ }).click();
    const adjQueue = (await (await adj.request.get('/api/mu7/workspace')).json()) as {
      queue: { unitId: string }[];
    };
    expect(adjQueue.queue.map((q) => q.unitId)).toEqual(ROUTED);
    const concordant = UNITS.find((u) => u.walkthrough.expected_routing === 'BOTH_AGREE')!.import
      .unit_id;
    expect((await adj.request.get(`/api/mu7/adjudication/${concordant}`)).status()).toBe(404);
    await adjPage.getByRole('button', { name: new RegExp(`^${ROUTED[0]}`) }).click();
    await expect(adjPage.getByTestId('mu7-slot-1')).toBeVisible();
    await expect(adjPage.getByTestId('mu7-slot-2')).toBeVisible();
    expect(await adjPage.content()).not.toMatch(hidden);
    await adjPage.getByRole('radio', { name: 'Mark unresolved' }).check();
    await adjPage.getByLabel('Rationale').fill('Synthetic: the registry text does not settle it.');
    await adjPage.getByRole('button', { name: 'Record the tie-break' }).click();
    await expect(adjPage.getByTestId('mu7-adjudication')).toContainText('Marked unresolved');
    await adjPage.screenshot({ path: 'test-results/mu7-adjudicator-desktop.png', fullPage: true });
    // A reviewer cannot answer a unit after its tie-break (0025, MU7X-G01).
    const aOnRouted = (await queueOf(a)).find((q) => q.unitId === ROUTED[0])!;
    const late = await post(a, `/api/mu7/assignments/${aOnRouted.assignmentId}/submit`, {
      answer: 'CANNOT_TELL',
    });
    expect(late.status()).toBe(409);
    expect(await late.text()).toContain('MU7X-G01');

    // ---- account lock and release ----------------------------------------------------------------
    await adminPage.reload();
    await adminPage.getByRole('button', { name: /Mapping units/ }).click();
    await adminPage.getByLabel('Reason').fill('Synthetic lock for the browser regression.');
    await adminPage.getByRole('button', { name: 'Lock adjudicator' }).click();
    await expect(adminPage.locator('.notice.error')).toHaveCount(0);
    expect((await adj.request.get('/api/mu7/workspace')).status()).toBe(401);
    await adjPage.reload();
    await expect(adjPage.getByLabel('Pilot account')).toBeVisible();
    await adjPage.getByLabel('Pilot account').selectOption('adjudicator');
    await adjPage.getByLabel('Password', { exact: true }).fill(password);
    await adjPage.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(adjPage.locator('.notice.error')).toBeVisible();
    await adminPage.getByRole('button', { name: 'Release adjudicator' }).click();
    await signIn(adjPage, 'adjudicator');
    for (const unitId of ROUTED.slice(1)) {
      const r = await post(adj, '/api/mu7/adjudicate', {
        unitId,
        status: 'UNRESOLVED_ESCALATED',
        basis: 'NONE',
        rationale: 'Synthetic: escalated in the browser regression.',
      });
      expect(r.status(), await r.text()).toBe(200);
    }

    // ---- lock, export, integrity -----------------------------------------------------------------
    await adminPage.reload();
    await adminPage.getByRole('button', { name: /Mapping units/ }).click();
    await expect(adminPage.getByTestId('mu7-routing')).not.toContainText('✗');
    await adminPage.getByLabel(/Attestation/).fill(ATT);
    await adminPage.getByRole('button', { name: 'Lock the pilot reference' }).click();
    await expect(adminPage.getByTestId('mu7-phase')).toContainText('Pilot locked (12 units)');
    const afterLock = await post(
      b,
      `/api/mu7/assignments/${(await queueOf(b))[0].assignmentId}/submit`,
      { answer: 'AGREE' },
    );
    expect(await afterLock.text()).toContain('MU7-G34');
    await adminPage.getByRole('button', { name: 'Build export' }).click();
    await expect(adminPage.getByTestId('mu7-bundle')).toContainText('SYNTHETIC PILOT');
    const summary = (await (await admin.request.get('/api/mu7/admin/export/PILOT')).json()) as {
      manifestSha256: string;
      files: { name: string; sha256: string; rows: number }[];
    };
    const manifestText = await (
      await admin.request.get('/api/mu7/admin/export/PILOT/manifest.json')
    ).text();
    expect(sha256(manifestText)).toBe(summary.manifestSha256);
    const manifest = JSON.parse(manifestText) as {
      files: Record<string, string>;
      row_counts: Record<string, number>;
      mode: string;
    };
    expect(manifest.mode).toBe('PILOT');
    for (const f of summary.files) {
      const body = await (await admin.request.get(`/api/mu7/admin/export/PILOT/${f.name}`)).text();
      expect(sha256(body), f.name).toBe(manifest.files[f.name]);
      expect(body.trim().split('\n').length - 1, f.name).toBe(manifest.row_counts[f.name]);
      expect(body).not.toMatch(/walkthrough|planted|expected_routing/);
    }
    await adminPage.getByRole('button', { name: 'Register export' }).click();
    await expect(adminPage.getByRole('button', { name: 'Export registered' })).toBeDisabled();
    await expect(adminPage.getByTestId('mu7-export-record')).toContainText(
      summary.manifestSha256.slice(0, 12),
    );
    // The same locked data rebuilds the same bytes.
    const again = (await (await admin.request.get('/api/mu7/admin/export/PILOT')).json()) as {
      manifestSha256: string;
    };
    expect(again.manifestSha256).toBe(summary.manifestSha256);
    expect((await a.request.get('/api/mu7/admin/export/PILOT/units.csv')).status()).toBe(403);
    await adminPage.screenshot({
      path: 'test-results/mu7-investigator-desktop.png',
      fullPage: true,
    });
  } finally {
    await Promise.all(contexts.map((c) => c.close()));
  }
});
