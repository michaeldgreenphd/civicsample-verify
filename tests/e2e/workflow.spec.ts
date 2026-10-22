import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
const password = 'e2e-only-generated-fictional-passphrase';
const origin = 'http://127.0.0.1:3100';
async function signIn(page: Page, account: string) {
  await page.goto('/');
  await page.getByLabel('Pilot account').selectOption(account);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
}
async function post(context: BrowserContext, path: string, data: unknown) {
  return context.request.post(path, { data, headers: { origin } });
}
const answer = (decision = 'INCLUDE') => ({
  decision,
  rationale: 'Fictional engineering judgment. This is not clinical evidence.',
  uncertain: false,
  context: '',
  packetProblem: false,
});
const structuredContext = JSON.stringify({
  clinicalContext: 'Fictional context for the pilot regression.',
  inclusionConditions: 'Include when the fictional condition is studied.',
  exclusionConditions: 'Exclude incidental fictional findings.',
});
const hidden =
  /tier0_binary|tier1_binary|prediction_set|selection_probability|comparison_cell|frame_unit|request\.jwt|service_role|snapshot_hash/;

test('served browser previews custom evidence and reviewers receive exactly the authored two-step case', async ({
  browser,
}) => {
  const [admin, a] = await Promise.all([
    browser.newContext({ baseURL: origin }),
    browser.newContext({ baseURL: origin }),
  ]);
  const [adminPage, aPage] = await Promise.all([admin.newPage(), a.newPage()]);
  const custom = {
    title: 'Fictional neurological condition Q',
    area: 'Neurological',
    descriptorName: 'Fictional neural condition Q',
    descriptorId: 'TESTFX-D0111',
    scopeNote: 'A fictional neural condition used only to verify synthetic case authoring.',
    entryTerms: 'Fictional neural synonym Q',
    treeNumber: 'TESTFX.111',
    treeLabel: 'Fictional neurological branch',
    areaDefinition: 'Synthetic neurological construct for engineering verification.',
    source: 'Fictional investigator-authored neurology packet',
    sourceVersion: 'synthetic-neurology-v2',
    registryId: 'SYN-NCT-0111',
    trialTitle: 'Fictional neurological intervention trial',
    summary:
      'A fictional neurological trial evaluates an invented neural intervention and cognition outcome.',
    conditions: ['Fictional neural condition Q', 'Fictional neural condition R'],
    interventions: ['Fictional neural training', 'Fictional neural comparison'],
    primaryOutcomes: ['Fictional cognition score', 'Fictional recall score'],
    studyType: 'Fictional randomized study',
    primaryPurpose: 'Fictional neurological treatment',
    phase: 'Fictional pilot phase',
    ageRange: 'Fictional adults aged 40 to 70',
  };
  try {
    await signIn(adminPage, 'investigator');
    await expect(adminPage.getByRole('heading', { name: 'Pilot overview' })).toBeVisible();
    await adminPage.locator('summary').filter({ hasText: 'Author a synthetic pilot case' }).click();
    await expect(adminPage.getByLabel('New synthetic case ID')).toHaveValue('SYN-011');
    const fields = [
      ['Case title', custom.title],
      ['Construct area', custom.area],
      ['Descriptor name', custom.descriptorName],
      ['Synthetic descriptor ID', custom.descriptorId],
      ['Descriptor scope note', custom.scopeNote],
      ['Entry terms', custom.entryTerms],
      ['Tree number', custom.treeNumber],
      ['Tree placement label', custom.treeLabel],
      ['Area definition', custom.areaDefinition],
      ['Evidence source', custom.source],
      ['Evidence source version', custom.sourceVersion],
      ['Synthetic trial registry ID', custom.registryId],
      ['Trial title', custom.trialTitle],
      ['Trial summary', custom.summary],
      ['Conditions', custom.conditions.join(', ')],
      ['Interventions', custom.interventions.join(', ')],
      ['Primary outcomes', custom.primaryOutcomes.join(', ')],
      ['Study type', custom.studyType],
      ['Primary purpose', custom.primaryPurpose],
      ['Trial phase', custom.phase],
      ['Age range', custom.ageRange],
    ];
    for (const [label, value] of fields) {
      await adminPage.getByLabel(label, { exact: true }).fill(value);
    }
    const preview = adminPage.getByRole('region', { name: 'Evidence preview' });
    await expect(preview.getByText(custom.scopeNote, { exact: true })).toBeVisible();
    await expect(preview.getByText(custom.summary, { exact: true })).toBeVisible();
    await expect(preview.getByText(custom.conditions.join('; '), { exact: true })).toBeVisible();
    await expect(preview.getByText(custom.interventions.join('; '), { exact: true })).toBeVisible();
    await expect(
      preview.getByText(custom.primaryOutcomes.join('; '), { exact: true }),
    ).toBeVisible();
    await expect(
      preview.getByText(`${custom.source} · ${custom.sourceVersion}`, { exact: true }),
    ).toHaveCount(2);
    await expect(preview).not.toContainText('Fictional respiratory symptom score');
    await adminPage.getByLabel('Case kind', { exact: true }).selectOption('DESCRIPTOR');
    await expect(preview.getByText('Disclosed trial evidence')).toHaveCount(0);
    await adminPage.getByLabel('Case kind', { exact: true }).selectOption('TWO_STEP');
    await expect(preview.getByText(custom.summary, { exact: true })).toBeVisible();
    const submittedRequest = adminPage.waitForRequest(
      (request) =>
        request.method() === 'POST' && new URL(request.url()).pathname === '/api/admin/cases',
    );
    await adminPage.getByRole('button', { name: 'Author synthetic case' }).click();
    const submitted = (await submittedRequest).postDataJSON();
    expect(submitted.trialPacket).toEqual({
      registryId: custom.registryId,
      title: custom.trialTitle,
      summary: custom.summary,
      conditions: custom.conditions,
      interventions: custom.interventions,
      primaryOutcomes: custom.primaryOutcomes,
      studyType: custom.studyType,
      primaryPurpose: custom.primaryPurpose,
      phase: custom.phase,
      ageRange: custom.ageRange,
      source: custom.source,
      sourceVersion: custom.sourceVersion,
    });
    await expect(
      adminPage.getByText('Synthetic case SYN-011 authored and assigned to both reviewers.'),
    ).toBeVisible();

    await signIn(aPage, 'reviewer-a');
    expect(
      (
        await post(a, '/api/admin/cases', {
          id: 'SYN-012',
          kind: 'DESCRIPTOR',
          packet: {},
        })
      ).status(),
    ).toBe(403);

    await aPage.getByRole('button', { name: new RegExp(custom.title) }).click();
    await expect(aPage.getByRole('heading', { name: custom.title })).toBeVisible();
    await expect(aPage.getByText('Step 1 of 2')).toBeVisible();
    await expect(aPage.getByText(custom.descriptorId, { exact: true })).toBeVisible();
    await expect(aPage.getByText(custom.entryTerms, { exact: true })).toBeVisible();
    await expect(
      aPage.getByText(`${custom.treeNumber} — ${custom.treeLabel}`, { exact: true }),
    ).toBeVisible();
    await expect(aPage.getByText(custom.scopeNote, { exact: true })).toBeVisible();
    await expect(aPage.getByText(custom.areaDefinition, { exact: true })).toBeVisible();
    await expect(aPage.getByText(custom.registryId)).toHaveCount(0);
    await expect(aPage.getByText(custom.summary)).toHaveCount(0);
    await expect(aPage.getByText('Disclosed trial evidence')).toHaveCount(0);

    await aPage.getByRole('radio', { name: /^Include\b/ }).check();
    await aPage
      .getByLabel(/^Rationale/)
      .fill('Reviewer A Step 1 descriptor judgment on authored synthetic case SYN-011.');
    await aPage.getByRole('button', { name: 'Lock Step 1 & continue', exact: true }).click();
    await aPage.getByRole('button', { name: /Confirm & lock/ }).click();

    await expect(aPage.getByText(/Step 1 locked:\s*Include/)).toBeVisible();
    await expect(aPage.getByText('Step 2 of 2')).toBeVisible();
    await expect(aPage.getByText('Disclosed trial evidence')).toBeVisible();
    await expect(aPage.getByRole('heading', { name: custom.trialTitle })).toBeVisible();
    await expect(aPage.getByText(custom.registryId, { exact: true })).toBeVisible();
    await expect(aPage.getByText(custom.summary, { exact: true })).toBeVisible();
    await expect(aPage.getByText(custom.conditions.join('; '), { exact: true })).toBeVisible();
    await expect(aPage.getByText(custom.interventions.join('; '), { exact: true })).toBeVisible();
    await expect(aPage.getByText(custom.primaryOutcomes.join('; '), { exact: true })).toBeVisible();
    await expect(
      aPage.getByText(`${custom.studyType} · ${custom.primaryPurpose}`, { exact: true }),
    ).toBeVisible();
    await expect(
      aPage.getByText(`${custom.phase} · ${custom.ageRange}`, { exact: true }),
    ).toBeVisible();
    await expect(
      aPage.getByText(`${custom.source} · ${custom.sourceVersion}`, { exact: true }),
    ).toHaveCount(2);
    await expect(aPage.getByText('Fictional nebulized intervention')).toHaveCount(0);
    await expect(aPage.getByText('Fictional respiratory symptom score')).toHaveCount(0);

    await aPage.getByLabel(/Descriptor role in this trial/).selectOption('DISEASE_STUDIED');
    await aPage.getByRole('radio', { name: /^Include\b/ }).check();
    await aPage
      .getByLabel(/^Rationale/)
      .fill('Reviewer A Step 2 trial judgment on authored synthetic case SYN-011.');
    await aPage.getByRole('button', { name: 'Submit judgment', exact: true }).click();
    await aPage.getByRole('button', { name: /Confirm & lock/ }).click();
    await expect(aPage.getByText(/Final submission locked/i).first()).toBeVisible();
  } finally {
    await admin.close();
    await a.close();
  }
});

test('four isolated browser roles: review, two-step blinding, adjudication, lock and export', async ({
  browser,
}) => {
  const contexts = await Promise.all(
    Array.from({ length: 4 }, () => browser.newContext({ baseURL: origin })),
  );
  const [admin, a, b, adj] = contexts;
  const pages = await Promise.all(contexts.map((c) => c.newPage()));
  const [adminPage, aPage, bPage, adjPage] = pages;
  await signIn(adminPage, 'investigator');
  await expect(adminPage.getByRole('heading', { name: 'Pilot overview' })).toBeVisible();
  await expect(adminPage.getByRole('heading', { name: 'Readiness gates' })).toBeVisible();
  await adminPage
    .locator('summary')
    .filter({ hasText: 'Authorize a documented amendment' })
    .click();
  await expect(adminPage.getByLabel('Judgment level').locator('option')).toHaveText([
    'Descriptor',
    'Trial',
  ]);
  await expect(adminPage.getByText(/Step 1 in a trial case cannot be amended/)).toBeVisible();
  await adminPage
    .locator('summary')
    .filter({ hasText: 'Authorize a documented amendment' })
    .click();
  await adminPage.screenshot({ path: 'test-results/investigator-desktop.png', fullPage: true });
  for (const [page, account] of [
    [aPage, 'reviewer-a'],
    [bPage, 'reviewer-b'],
    [adjPage, 'adjudicator'],
  ] as const)
    await signIn(page, account);
  expect((await adj.request.get('/api/cases/SYN-001')).status()).toBeGreaterThanOrEqual(400);
  expect((await a.request.get('/api/admin/export')).status()).toBe(403);
  expect((await a.request.get('/api/audit')).status()).toBe(404);
  expect((await a.request.get('/api/cases/SYN-999')).status()).toBe(404);
  expect(
    (await post(a, '/api/admin/action', { action: 'close', attestation: 'test' })).status(),
  ).toBe(403);
  expect(
    (
      await post(admin, '/api/admin/action', { action: 'activate-formal', attestation: 'test' })
    ).status(),
  ).toBe(403);
  expect(
    (
      await a.request.post('/api/cases/SYN-001/submit', {
        data: answer(),
        headers: { origin: 'https://untrusted.example' },
      })
    ).status(),
  ).toBe(403);
  const beforeTrial = await (await a.request.get('/api/cases/SYN-009')).json();
  expect(beforeTrial.trialPacket).toBeUndefined();
  expect(JSON.stringify(beforeTrial)).not.toMatch(/Fictional trial|SYN-NCT/);
  expect(JSON.stringify(beforeTrial)).not.toMatch(hidden);
  expect((await post(a, '/api/cases/SYN-009/submit', answer())).status()).toBe(409);
  expect(
    (
      await post(a, '/api/cases/SYN-001/submit', { ...answer('CONTEXT_DEPENDENT'), context: 'x' })
    ).status(),
  ).toBe(400);
  expect(
    (
      await post(a, '/api/cases/SYN-001/submit', { ...answer(), reviewerId: 'another-user' })
    ).status(),
  ).toBe(400);

  await expect(aPage.getByRole('heading', { name: 'Your review workspace' })).toBeVisible();
  await aPage.getByRole('radio', { name: /^Include\b/ }).check();
  await aPage
    .getByLabel(/^Rationale/)
    .fill('Reviewer A private rationale: fictional engineering response.');
  await expect(aPage.getByText(/saved/i).first()).toBeVisible();
  const bFirst = await (await b.request.get('/api/cases/SYN-001')).text();
  expect(bFirst).not.toContain('Reviewer A private');
  expect(await (await admin.request.get('/api/workspace')).text()).not.toContain(
    'Reviewer A private',
  );
  await aPage.screenshot({ path: 'test-results/reviewer-desktop.png', fullPage: true });
  const axe = await new AxeBuilder({ page: aPage })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
    .analyze();
  expect(axe.violations).toEqual([]);
  await aPage.getByRole('button', { name: 'Submit judgment', exact: true }).click();
  await aPage.getByRole('button', { name: /Confirm &/ }).click();
  await expect(aPage.getByText(/Final submission locked/i).first()).toBeVisible();
  expect((await post(a, '/api/cases/SYN-001/submit', answer('EXCLUDE'))).status()).toBe(409);

  for (const [context, slot] of [
    [a, 'A'],
    [b, 'B'],
  ] as const) {
    for (let i = 1; i <= 11; i++) {
      if (slot === 'A' && (i === 1 || i === 11)) continue;
      const id = `SYN-${String(i).padStart(3, '0')}`;
      if (i >= 9) {
        const step = await post(context, `/api/cases/${id}/step1`, answer());
        expect(step.ok(), await step.text()).toBeTruthy();
        const detail = await (await context.request.get(`/api/cases/${id}`)).json();
        expect(detail.trialPacket.registryId).toMatch(/^SYN-NCT/);
        if (slot === 'A' && i === 9) {
          const amendment = await post(admin, '/api/admin/action', {
            action: 'authorize-amendment',
            caseId: id,
            reviewerId: '00000000-0000-4000-8000-000000000002',
            level: 'DESCRIPTOR_LEVEL_IN_TRIAL_CASE',
            reason: 'Synthetic regression must not revise a pre-context judgment.',
            attestation: 'Fictional attempted authorization after reveal.',
          });
          expect(amendment.status()).toBe(409);
          expect(await amendment.text()).toContain('Step 1');
          const unchanged = await (await context.request.get(`/api/cases/${id}`)).json();
          expect(unchanged.step1.version).toBe(1);
          expect(unchanged.availableAmendments).toEqual([]);
        }
      }
      const result = await post(context, `/api/cases/${id}/submit`, {
        ...answer(slot === 'B' && i === 1 ? 'EXCLUDE' : 'INCLUDE'),
        ...(slot === 'A' && i === 2
          ? { decision: 'CONTEXT_DEPENDENT', context: structuredContext }
          : {}),
        ...(i >= 9 ? { descriptorRole: 'DISEASE_STUDIED' } : {}),
      });
      expect(result.ok(), await result.text()).toBeTruthy();
      const reviewerBody = await (await context.request.get(`/api/cases/${id}`)).text();
      expect(reviewerBody).not.toMatch(hidden);
    }
  }
  await adminPage.reload();
  await adminPage.getByRole('button', { name: 'Close independent review' }).click();
  await adminPage
    .getByLabel('Attestation / reason')
    .fill('Synthetic investigator closes the completed pilot.');
  await adminPage.getByRole('button', { name: 'Confirm action' }).click();
  await expect(adminPage.getByRole('button', { name: 'Authorize adjudication' })).toBeEnabled();
  expect((await post(a, '/api/cases/SYN-002/draft', answer())).status()).toBe(409);
  await adminPage.getByRole('button', { name: 'Authorize adjudication' }).click();
  await adminPage
    .getByLabel('Attestation / reason')
    .fill('Authorize separate synthetic adjudication.');
  await adminPage.getByRole('button', { name: 'Confirm action' }).click();
  await expect(adminPage.getByRole('button', { name: 'Lock pilot & enable export' })).toBeEnabled();
  await adjPage.reload();
  await adjPage.getByLabel('Judgment level').selectOption('DESCRIPTOR_LEVEL');
  await expect(
    adjPage.getByText('Reviewer A private rationale: fictional engineering response.'),
  ).toBeVisible();
  await adjPage.getByRole('radio', { name: /^Include\b/ }).check();
  await adjPage.getByLabel(/^Rationale/).fill('Synthetic adjudicator resolution.');
  await adjPage
    .getByLabel(/^Basis for/)
    .fill('Comparison of the fictional packet and independent responses.');
  await adjPage.getByLabel(/^Reason code/).selectOption('CONSTRUCT_BOUNDARY');
  await adjPage.getByRole('button', { name: /Review & submit adjudication/ }).click();
  await adjPage.getByRole('button', { name: 'Confirm & lock' }).click();
  await expect(adjPage.getByText('Adjudication locked', { exact: true })).toBeVisible();
  await adjPage.screenshot({ path: 'test-results/adjudicator-desktop.png', fullPage: true });
  for (let i = 1; i <= 11; i++) {
    const id = `SYN-${String(i).padStart(3, '0')}`;
    const detail = await (await adj.request.get(`/api/cases/${id}`)).json();
    expect(JSON.stringify(detail)).not.toMatch(hidden);
    if (i === 2) {
      const contextual = detail.humanReviews.find(
        (r: { decision: string }) => r.decision === 'CONTEXT_DEPENDENT',
      );
      expect(contextual.context).toBe(structuredContext);
      expect(contextual.packetProblem).toBe(false);
      expect(contextual.packetProblemNote).toBeUndefined();
    }
    const levels = [...new Set<string>(detail.humanReviews.map((r: { level: string }) => r.level))];
    for (const level of levels) {
      if (i === 1) continue;
      const result = await post(adj, `/api/cases/${id}/adjudicate`, {
        ...answer(),
        level,
        status: 'RESOLVED',
        basis: 'Fictional packet',
        reasonCode: 'OTHER',
      });
      expect(result.ok(), await result.text()).toBeTruthy();
    }
  }
  await adminPage.getByRole('button', { name: 'Lock pilot & enable export' }).click();
  await adminPage.getByLabel('Attestation / reason').fill('Lock the synthetic pilot reference.');
  await adminPage.getByRole('button', { name: 'Confirm action' }).click();
  await expect(adminPage.getByRole('link', { name: /Download locked export/ })).toBeVisible();
  const exported = await admin.request.get('/api/admin/export');
  expect(exported.ok(), await exported.text()).toBeTruthy();
  const exportBytes = await exported.text();
  const repeated = await admin.request.get('/api/admin/export');
  expect(repeated.ok(), await repeated.text()).toBeTruthy();
  expect(await repeated.text()).toBe(exportBytes);
  const bundle = JSON.parse(exportBytes);
  expect(bundle.manifest.analysis_eligible).toBe(false);
  expect(bundle.manifest.clinical_metrics).toBeNull();
  expect(bundle.files.find((f: { role: string }) => f.role === 'independent_judgments').rows).toBe(
    28,
  );
  expect((await adj.request.get('/api/admin/export')).status()).toBe(403);
  await aPage.setViewportSize({ width: 390, height: 844 });
  await aPage.reload();
  await expect(aPage.getByText('Final submission locked', { exact: true })).toBeVisible();
  await aPage.keyboard.press('Tab');
  expect(await aPage.evaluate(() => document.activeElement?.tagName)).not.toBe('BODY');
  expect(
    await aPage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
  ).toBe(true);
  await aPage.screenshot({ path: 'test-results/reviewer-mobile.png', fullPage: true });
  for (const context of contexts) await context.close();
});
