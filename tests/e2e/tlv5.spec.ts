import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { createHash } from 'node:crypto';
const password = 'e2e-only-generated-fictional-passphrase';
const origin = 'http://127.0.0.1:3100';
const ATT = 'Synthetic attestation for the browser regression, twenty characters or more.';
const AREAS = [
  'ONCOLOGY',
  'CARDIOVASCULAR',
  'MENTAL_HEALTH',
  'INFECTIOUS',
  'METABOLIC',
  'NEUROLOGICAL',
  'RESPIRATORY',
];
const ROWS = ['CAN_ALL', 'DIAB', 'DEP', 'OBE', 'AST', 'COPD', 'COV', 'SCZ', 'HTN', 'PAIN'];
// Field-shaped tokens that must never reach a reviewer or adjudicator page or response. Plain words
// such as "enrollment" appear legitimately in the rubric's list of what reviewers will not see.
const hidden =
  /label_primary|label_secondary|label_informational|tier0_|tier1_|curated_v|stratum_v|variance_stratum|selection_probability|sampling_weight|dev_linked|frame_stratum|clinicaltrials\.gov|request\.jwt|service_role|NCT\d{8}/i;
async function signIn(page: Page, account: string) {
  await page.goto('/');
  await page.getByLabel('Pilot account').selectOption(account);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
  await page.getByRole('button', { name: /Trial verification/ }).click();
}
async function post(context: BrowserContext, path: string, data: unknown) {
  return context.request.post(path, { data, headers: { origin } });
}
function items(areas: string[], rows: string[], override: Record<string, string> = {}) {
  const out = AREAS.map((a) => ({
    itemCode: `AREA_${a}`,
    answer: override[`AREA_${a}`] ?? (areas.includes(a) ? 'YES' : 'NO'),
    uncertain: false,
  }));
  for (const r of ROWS)
    out.push({
      itemCode: `FIG2_ROW_${r}`,
      answer: rows.includes(r) ? 'YES' : 'NO',
      uncertain: false,
    });
  if (rows.includes('DIAB'))
    out.push({ itemCode: 'SG_DIABETES_TYPE', answer: 'TYPE_2', uncertain: false });
  if (rows.includes('CAN_ALL'))
    out.push({ itemCode: 'SG_NEOPLASM_MALIGNANCY', answer: 'MALIGNANT', uncertain: false });
  return out;
}
const plan: Record<string, [string[], string[], Record<string, string>?]> = {
  'SYN-TLV5-002': [['ONCOLOGY'], ['CAN_ALL']],
  'SYN-TLV5-003': [['CARDIOVASCULAR'], []],
  'SYN-TLV5-004': [['MENTAL_HEALTH'], ['DEP']],
  'SYN-TLV5-005': [['RESPIRATORY'], ['COPD']],
  'SYN-TLV5-006': [['RESPIRATORY'], ['AST']],
  'SYN-TLV5-007': [['INFECTIOUS', 'RESPIRATORY'], ['COV']],
  'SYN-TLV5-008': [['MENTAL_HEALTH'], ['SCZ']],
  'SYN-TLV5-009': [['METABOLIC'], ['OBE']],
  'SYN-TLV5-010': [[], ['PAIN']],
};

test('design v5 synthetic pilot: browser form, blinding, adjudication, lock, export and sign-off', async ({
  browser,
}) => {
  const contexts = await Promise.all(
    Array.from({ length: 4 }, () => browser.newContext({ baseURL: origin })),
  );
  const [admin, a, b, adj] = contexts;
  const [adminPage, aPage, bPage, adjPage] = await Promise.all(contexts.map((c) => c.newPage()));
  try {
    await signIn(adminPage, 'investigator');
    await expect(adminPage.getByRole('heading', { name: 'Gated actions' })).toBeVisible();
    await adminPage.getByRole('button', { name: 'Import the 10 synthetic pilot trials' }).click();
    await expect(adminPage.getByText('Pilot import recorded.')).toBeVisible();
    await adminPage
      .getByRole('button', { name: 'Assign pilot trials to both pilot accounts' })
      .click();
    await expect(adminPage.getByText('Pilot assignment recorded.')).toBeVisible();
    await expect(adminPage.getByRole('table').first()).toContainText('0 / 10');

    for (const [page, account] of [
      [aPage, 'reviewer-a'],
      [bPage, 'reviewer-b'],
      [adjPage, 'adjudicator'],
    ] as const)
      await signIn(page, account);
    // Blinding at the API: reviewer sessions reach no export, no label and no adjudication queue.
    expect((await a.request.get('/api/tlv5/admin/export/PILOT')).status()).toBe(403);
    expect((await a.request.get('/api/tlv5/cases/SYN-TLV5-099')).status()).toBe(404);
    expect(
      (
        await post(a, '/api/tlv5/admin/action', { action: 'lock', mode: 'PILOT', attestation: ATT })
      ).status(),
    ).toBe(403);
    expect(
      (
        await post(adj, '/api/tlv5/adjudicate', {
          caseId: 'SYN-TLV5-001',
          itemCode: 'AREA_METABOLIC',
          decision: 'YES',
          status: 'CONCORDANT_CONFIRMED',
          basis: 'BOTH_REVIEWERS',
          rationale: 'premature',
        })
      ).status(),
    ).toBeGreaterThanOrEqual(400);
    const reviewerBody = await (await a.request.get('/api/tlv5/cases/SYN-TLV5-001')).text();
    expect(reviewerBody).toContain('SYN-NCT-0001');
    expect(reviewerBody).not.toMatch(hidden);

    // Reviewer A completes SYN-TLV5-001 in the browser: the subgroup item appears only after the row answer is Yes.
    await aPage.getByRole('button', { name: /Fictional once-weekly agent SYN-101/ }).click();
    await expect(
      aPage.getByRole('heading', { name: /Fictional once-weekly agent SYN-101/ }),
    ).toBeVisible();
    expect(await aPage.content()).not.toMatch(hidden);
    await expect(aPage.getByLabel('Answer (SG_DIABETES_TYPE)')).toHaveCount(0);
    for (const area of AREAS)
      await aPage
        .getByLabel(`Answer (AREA_${area})`)
        .selectOption(area === 'METABOLIC' ? 'YES' : 'NO');
    for (const row of ROWS)
      await aPage
        .getByLabel(`Answer (FIG2_ROW_${row})`)
        .selectOption(row === 'DIAB' ? 'YES' : 'NO');
    await expect(aPage.getByLabel('Answer (SG_DIABETES_TYPE)')).toBeVisible();
    await aPage.getByLabel('Answer (FIG2_ROW_DIAB)').selectOption('NO');
    await expect(aPage.getByLabel('Answer (SG_DIABETES_TYPE)')).toHaveCount(0);
    await aPage.getByLabel('Answer (FIG2_ROW_DIAB)').selectOption('YES');
    await aPage.getByRole('button', { name: 'Submit trial verification' }).click();
    await expect(aPage.getByText(/Answer every item before submitting/)).toBeVisible();
    await aPage.getByLabel('Answer (SG_DIABETES_TYPE)').selectOption('TYPE_2');
    const axe = await new AxeBuilder({ page: aPage })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
      .analyze();
    expect(axe.violations).toEqual([]);
    await aPage.screenshot({ path: 'test-results/tlv5-reviewer-desktop.png', fullPage: true });
    await aPage.getByRole('button', { name: 'Submit trial verification' }).click();
    await expect(
      aPage.getByText(
        'Final submission recorded and locked. Contact the investigator if a correction is needed.',
      ),
    ).toBeVisible();
    await expect(aPage.getByRole('button', { name: 'Submit trial verification' })).toHaveCount(0);
    await expect(aPage.getByLabel('Answer (AREA_METABOLIC)')).toBeDisabled();
    expect(await (await b.request.get('/api/tlv5/cases/SYN-TLV5-001')).json()).toMatchObject({
      submissions: [],
    });
    expect(
      JSON.stringify(await (await admin.request.get('/api/tlv5/workspace')).json()),
    ).not.toContain('TYPE_2');

    // The remaining submissions follow the pilot script through the same endpoint.
    for (const [id, [areas, rows, override]] of Object.entries(plan)) {
      const r1 = await post(a, `/api/tlv5/cases/${id}/submit`, {
        items: items(areas, rows, override),
        packetIssueFlag: false,
      });
      expect(r1.ok(), await r1.text()).toBeTruthy();
    }
    for (const id of ['SYN-TLV5-001', ...Object.keys(plan)]) {
      const [areas, rows] = id === 'SYN-TLV5-001' ? [['METABOLIC'], ['DIAB']] : plan[id];
      const override: Record<string, string> =
        id === 'SYN-TLV5-003'
          ? { AREA_NEUROLOGICAL: 'YES' }
          : id === 'SYN-TLV5-010'
            ? { AREA_NEUROLOGICAL: 'CONTEXT_DEPENDENT' }
            : {};
      const extra =
        id === 'SYN-TLV5-009'
          ? { packetIssueFlag: true, packetIssueNote: 'Synthetic packet problem.' }
          : { packetIssueFlag: false };
      const r2 = await post(b, `/api/tlv5/cases/${id}/submit`, {
        items: items(areas, rows, override),
        ...extra,
      });
      expect(r2.ok(), await r2.text()).toBeTruthy();
    }
    // A packet problem needs a note; a submitted final cannot be revised.
    expect(
      (
        await post(a, '/api/tlv5/cases/SYN-TLV5-004/submit', {
          items: items(['MENTAL_HEALTH'], ['DEP']),
          packetIssueFlag: true,
        })
      ).status(),
    ).toBe(400);
    const revision = await post(a, '/api/tlv5/cases/SYN-TLV5-004/submit', {
      items: items(['MENTAL_HEALTH'], ['DEP']),
      packetIssueFlag: false,
      overallComment: 'revised',
    });
    expect(revision.status()).toBe(409);
    const locked = await (await a.request.get('/api/tlv5/cases/SYN-TLV5-004')).json();
    expect(locked.submissions.map((s: { revision: number }) => s.revision)).toEqual([1]);
    expect(locked.submissionsOpen).toBe(false);

    // Adjudicator: planted disagreements only; labels never reach the page.
    await adjPage.reload();
    await adjPage.getByRole('button', { name: /Trial verification/ }).click();
    await adjPage.getByRole('button', { name: /Fictional anticoagulant SYN-303/ }).click();
    await expect(
      adjPage.getByRole('heading', { name: /Fictional anticoagulant SYN-303/ }),
    ).toBeVisible();
    expect(await adjPage.content()).not.toMatch(hidden);
    await adjPage.getByLabel('Item').selectOption('AREA_NEUROLOGICAL');
    await adjPage.getByLabel('Status').selectOption('DISCORDANT_RESOLVED');
    await adjPage.getByLabel('Decision').selectOption('NO');
    await adjPage.getByLabel('Basis').selectOption('REVIEWER_1');
    await adjPage.getByLabel('Disagreement reason code').selectOption('CONSTRUCT_BOUNDARY');
    await adjPage
      .getByLabel('Rationale')
      .fill('Synthetic adjudication of the planted disagreement.');
    await adjPage.getByRole('button', { name: 'Record adjudication' }).click();
    await expect(adjPage.getByText('Adjudication recorded and locked.')).toBeVisible();
    await expect(adjPage.locator('#adj-item option[value="AREA_NEUROLOGICAL"]')).toBeDisabled();
    await expect(adjPage.getByRole('button', { name: 'Record adjudication' })).toBeDisabled();
    await adjPage.screenshot({ path: 'test-results/tlv5-adjudicator-desktop.png', fullPage: true });
    const second = await post(adj, '/api/tlv5/adjudicate', {
      caseId: 'SYN-TLV5-010',
      itemCode: 'AREA_NEUROLOGICAL',
      decision: 'NO',
      status: 'DISCORDANT_RESOLVED',
      basis: 'REVIEWER_1',
      rationale: 'Synthetic explicit indeterminate kept apart from No.',
      disagreementReasonCode: 'TRIAL_CONTEXT',
    });
    expect(second.ok(), await second.text()).toBeTruthy();

    // Investigator: lock, preview, download, register, sign-off.
    await adminPage.reload();
    await adminPage.getByRole('button', { name: /Trial verification/ }).click();
    await adminPage.getByLabel('Attestation (at least 20 characters)').fill(ATT);
    await adminPage.getByRole('button', { name: 'Lock pilot reference' }).click();
    await expect(adminPage.getByText('Pilot reference lock recorded.')).toBeVisible();
    expect(
      (
        await post(a, '/api/tlv5/cases/SYN-TLV5-005/submit', {
          items: items(['RESPIRATORY'], ['COPD']),
          packetIssueFlag: false,
        })
      ).status(),
    ).toBe(409);
    await adminPage.getByRole('button', { name: 'Preview pilot bundle' }).click();
    await expect(
      adminPage.getByRole('link', { name: 'pilot_bundle_v5.manifest.json' }),
    ).toBeVisible();
    const bundle = await (await admin.request.get('/api/tlv5/admin/export/PILOT')).json();
    expect(bundle.files.map((f: { rows: number }) => f.rows)).toEqual([380, 190, 172]);
    const manifest = await (
      await admin.request.get('/api/tlv5/admin/export/PILOT/pilot_bundle_v5.manifest.json')
    ).text();
    expect(createHash('sha256').update(manifest).digest('hex')).toBe(bundle.manifestSha256);
    const labels = await (
      await admin.request.get('/api/tlv5/admin/export/PILOT/pilot_frozen_labels_v5.csv')
    ).text();
    expect(createHash('sha256').update(labels).digest('hex')).toBe(bundle.files[2].sha256);
    expect(labels).not.toContain('@');
    await adminPage.getByRole('button', { name: 'Register pilot export' }).click();
    await expect(adminPage.getByText('Pilot export registration recorded.')).toBeVisible();
    await adminPage.getByLabel('SHA-256 of the signed checklist').fill('1'.repeat(64));
    await adminPage.getByRole('button', { name: 'Sign off the v5 pilot' }).click();
    await expect(adminPage.getByText('Pilot sign-off recorded.')).toBeVisible();
    await adminPage.screenshot({
      path: 'test-results/tlv5-investigator-desktop.png',
      fullPage: true,
    });
    expect(
      (
        await post(admin, '/api/tlv5/admin/action', {
          action: 'sign-off',
          checklistVersion: 'x',
          checklistSha256: '1'.repeat(64),
          attestation: ATT,
        })
      ).status(),
    ).toBe(409);
  } finally {
    await Promise.all(contexts.map((c) => c.close()));
  }
});
