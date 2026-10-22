import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
const password = 'e2e-only-generated-fictional-passphrase';
const origin = 'http://127.0.0.1:3100';
const ATT = 'Synthetic attestation for the browser regression, twenty characters or more.';
// Field-shaped tokens that must never reach a reviewer or adjudicator page or response.
const hidden =
  /label_primary|label_secondary|selection_probability|sampling_weight|variance_stratum|dev_linked|clinicaltrials\.gov|request\.jwt|service_role|NCT\d{8}|model_rationale/i;
async function signIn(page: Page, account: string) {
  await page.goto('/');
  await page.getByLabel('Pilot account').selectOption(account);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
  await page.getByRole('button', { name: /Mapping confirmation/ }).click();
}
async function post(context: BrowserContext, path: string, data: unknown) {
  return context.request.post(path, { data, headers: { origin } });
}
interface Queue {
  queue: { assignmentId: string; caseId: string }[];
}
interface CaseDto {
  case: { assignmentSha256: string; evidenceSha256: string; evidenceVersion: number };
  campaign: { rubricVersion: string; rubricSha256: string };
}
async function submitRest(
  context: BrowserContext,
  except: string[],
  answerOf: (caseId: string) => [string, string?],
) {
  const ws = (await (await context.request.get('/api/mc/workspace')).json()) as Queue;
  for (const q of ws.queue) {
    if (except.includes(q.caseId)) continue;
    const c = (await (
      await context.request.get(`/api/mc/assignments/${q.assignmentId}`)
    ).json()) as CaseDto;
    const [answer, annotation] = answerOf(q.caseId);
    const r = await post(context, `/api/mc/assignments/${q.assignmentId}/submit`, {
      answer,
      annotation,
      displayedAssignmentSha256: c.case.assignmentSha256,
      displayedEvidenceSha256: c.case.evidenceSha256,
      displayedEvidenceVersion: c.case.evidenceVersion,
      rubricVersion: c.campaign.rubricVersion,
      rubricSha256: c.campaign.rubricSha256,
    });
    expect(r.status(), q.caseId).toBe(200);
  }
}

test('mapping confirmation: visible assignment, reviewer isolation, adjudication timing, lock and export', async ({
  browser,
}) => {
  const contexts = await Promise.all(
    Array.from({ length: 4 }, () => browser.newContext({ baseURL: origin })),
  );
  const [admin, a, b, adj] = contexts;
  const [adminPage, aPage, bPage, adjPage] = await Promise.all(contexts.map((c) => c.newPage()));
  try {
    await signIn(adminPage, 'investigator');
    await adminPage.getByRole('button', { name: 'Create synthetic campaign' }).click();
    await expect(adminPage.getByTestId('mc-phase')).toContainText('Open');
    await adminPage.getByRole('button', { name: 'Import synthetic mappings' }).click();
    await expect(adminPage.getByText('Synthetic pilot mappings')).toBeVisible();
    await adminPage.getByRole('button', { name: 'Assign to the two pilot reviewers' }).click();
    await expect(adminPage.getByRole('table').first()).toContainText('12');
    await expect(
      adminPage.getByRole('button', { name: /Import evaluation mappings/ }),
    ).toBeDisabled();
    expect(
      (await post(admin, '/api/mc/admin/action', { action: 'import-evaluation' })).status(),
    ).toBe(409);

    for (const [page, account] of [
      [aPage, 'reviewer-a'],
      [bPage, 'reviewer-b'],
      [adjPage, 'adjudicator'],
    ] as const)
      await signIn(page, account);
    // Access at the API: reviewers reach no export, no admin action and no adjudicator case.
    expect((await a.request.get('/api/mc/admin/export')).status()).toBe(403);
    expect(
      (
        await post(a, '/api/mc/admin/action', {
          action: 'phase',
          eventType: 'CLOSED',
          attestation: ATT,
        })
      ).status(),
    ).toBe(403);
    expect((await a.request.get('/api/mc/cases/MC-SYN-011')).status()).toBe(403);
    expect((await adj.request.get('/api/mc/cases/MC-SYN-011')).status()).toBe(404);

    // Reviewer A: the assignment under review is visible; answer Yes in the browser.
    await aPage.getByRole('button', { name: /^MC-SYN-011:/ }).click();
    await expect(aPage.getByTestId('mc-assignment')).toContainText('Assigned to this condition');
    await expect(aPage.getByTestId('mc-condition')).toContainText('COVID-19');
    await expect(aPage.getByTestId('mc-title')).toContainText(
      'Fictional Vaccine Immunogenicity Study',
    );
    const aBody = await aPage.content();
    expect(aBody).not.toMatch(hidden);
    const axe = await new AxeBuilder({ page: aPage }).withTags(['wcag2a', 'wcag2aa']).analyze();
    expect(axe.violations).toEqual([]);
    await aPage.screenshot({ path: 'test-results/mapconf-reviewer-desktop.png', fullPage: true });
    await aPage.getByLabel('Yes, the mapping is appropriate').check();
    await aPage.getByRole('button', { name: 'Submit final answer' }).click();
    await expect(aPage.getByTestId('mc-own-response')).toContainText('Your final answer');
    await expect(aPage.getByRole('button', { name: 'Submit final answer' })).toHaveCount(0);
    // A missing summary is marked, never filled in.
    await aPage.getByRole('button', { name: /^MC-SYN-003:/ }).click();
    await expect(aPage.getByTestId('mc-summary-missing')).toBeVisible();
    await submitRest(a, ['MC-SYN-011'], (id) =>
      id === 'MC-SYN-012'
        ? ['INSUFFICIENT_INFORMATION', 'Synthetic: no summary in the source.']
        : ['YES'],
    );

    // Reviewer B: No with annotation in the browser; never sees A's answer.
    await bPage.getByRole('button', { name: /^MC-SYN-011:/ }).click();
    await expect(bPage.getByTestId('mc-assignment')).toContainText('Assigned to this condition');
    expect(await bPage.content()).not.toContain('Your final answer');
    await bPage.getByLabel('No, the mapping is not appropriate').check();
    await expect(bPage.getByRole('button', { name: 'Submit final answer' })).toBeDisabled();
    await bPage.getByLabel(/Annotation/).fill('Synthetic: healthy volunteers without infection.');
    await bPage.getByRole('button', { name: 'Submit final answer' }).click();
    await expect(bPage.getByTestId('mc-own-response')).toContainText(
      'No, the mapping is not appropriate',
    );
    await submitRest(b, ['MC-SYN-011'], (id) =>
      id === 'MC-SYN-012' ? ['INSUFFICIENT_INFORMATION', 'Synthetic: title only.'] : ['YES'],
    );
    const bWorkspace = await (await b.request.get('/api/mc/workspace')).text();
    expect(bWorkspace).not.toContain('healthy volunteers without infection');
    expect(bWorkspace).not.toMatch(hidden);

    // Adjudicator: nothing before the close and the authorization.
    expect((await adj.request.get('/api/mc/cases/MC-SYN-011')).status()).toBe(404);
    await adminPage.reload();
    await adminPage.getByRole('button', { name: /Mapping confirmation/ }).click();
    await expect(adminPage.getByRole('table').first()).toContainText('12');
    await adminPage.getByLabel(/Attestation/).fill(ATT);
    await adminPage.getByRole('button', { name: 'Close submissions' }).click();
    await expect(adminPage.getByTestId('mc-phase')).toContainText('Closed');
    expect((await adj.request.get('/api/mc/cases/MC-SYN-011')).status()).toBe(404);
    await adminPage.getByLabel(/Attestation/).fill(ATT);
    await adminPage.getByRole('button', { name: 'Authorize adjudication' }).click();
    await expect(adminPage.getByTestId('mc-phase')).toContainText('Adjudication');
    await adminPage.getByLabel(/Attestation/).fill(ATT);
    await adminPage.getByRole('button', { name: 'Lock the campaign' }).click();
    await expect(adminPage.getByRole('alert').filter({ hasText: 'not allowed now' })).toBeVisible();

    await adjPage.reload();
    await adjPage.getByRole('button', { name: /Mapping confirmation/ }).click();
    await adjPage.getByRole('button', { name: /^MC-SYN-011/ }).click();
    await expect(adjPage.getByTestId('mc-slot-1')).toContainText('Yes');
    await expect(adjPage.getByTestId('mc-slot-2')).toContainText(
      'healthy volunteers without infection',
    );
    expect(await adjPage.content()).not.toMatch(hidden);
    const adjAxe = await new AxeBuilder({ page: adjPage })
      .withTags(['wcag2a', 'wcag2aa'])
      .analyze();
    expect(adjAxe.violations).toEqual([]);
    await adjPage.screenshot({
      path: 'test-results/mapconf-adjudicator-desktop.png',
      fullPage: true,
    });
    await adjPage.getByLabel('Decision').selectOption('NO');
    await adjPage.getByLabel('Basis').selectOption('REVIEWER_2');
    await adjPage
      .getByLabel('Rationale')
      .fill('Synthetic: healthy volunteers are not a COVID-19 population.');
    await adjPage.getByRole('button', { name: 'Record adjudication' }).click();
    await expect(adjPage.getByTestId('mc-adjudication')).toContainText('Discordant resolved (NO)');
    expect(
      (
        await post(adj, '/api/mc/adjudicate', {
          caseId: 'MC-SYN-012',
          status: 'UNRESOLVED_ESCALATED',
          basis: 'NONE',
          rationale: 'Synthetic: both reviewers proposed the rubric addition.',
        })
      ).status(),
    ).toBe(200);
    expect(
      (
        await post(admin, '/api/mc/adjudicate', {
          caseId: 'MC-SYN-001',
          decision: 'YES',
          status: 'DISCORDANT_RESOLVED',
          basis: 'REVIEWER_1',
          rationale: 'forged',
        })
      ).status(),
    ).toBe(403);

    // Investigator: lock, build and register the export.
    await adminPage.getByLabel(/Attestation/).fill(ATT);
    await adminPage.getByRole('button', { name: 'Lock the campaign' }).click();
    await expect(adminPage.getByTestId('mc-phase')).toContainText('Locked');
    await adminPage.getByRole('button', { name: 'Build export' }).click();
    await expect(adminPage.getByTestId('mc-bundle')).toContainText('MAPPING_CONFIRMATION');
    const manifest = await (
      await admin.request.get('/api/mc/admin/export/mapping_confirmation_bundle.manifest.json')
    ).json();
    expect(manifest.export_format_version).toBe('mapping-confirmation-1.0');
    expect(manifest.assignment_visibility).toBe('EXISTING_ASSIGNMENT_VISIBLE');
    expect(manifest.is_synthetic_fixture).toBe(true);
    expect(manifest.n_responses).toBe(24);
    const csv = await (
      await admin.request.get('/api/mc/admin/export/mapping_confirmation_responses.csv')
    ).text();
    expect(csv.split('\n')[0]).toContain('review_mode,assignment_visibility');
    expect(csv).not.toContain('MC-TRN-');
    expect(csv).not.toMatch(/sampling_weight|selection_probability/);
    await adminPage.getByRole('button', { name: 'Register export' }).click();
    await expect(adminPage.getByText(/export .* registered/)).toBeVisible();
    await adminPage.screenshot({
      path: 'test-results/mapconf-investigator-desktop.png',
      fullPage: true,
    });
  } finally {
    await Promise.all(contexts.map((c) => c.close()));
  }
});
