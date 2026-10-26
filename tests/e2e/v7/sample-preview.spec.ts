import AxeBuilder from '@axe-core/playwright';
import { test, expect } from '@playwright/test';
import { syntheticSamplePreview } from '../../sample-preview-fixture';
import { previewUnit } from '../../../src/lib/sample-preview';

test('investigator browses all 100 proposed packets without recording answers at desktop and mobile sizes', async ({
  page,
}) => {
  const data = syntheticSamplePreview();
  for (const i of [0, 56]) {
    const packet = data.units[i].packet;
    packet.unit.display_text = i === 0 ? 'in this area' : 'in this row';
    if (i === 0) {
      packet.unit.mapping_label =
        'Therapeutic area: Pathological conditions, signs and symptoms (parent MeSH category C23 Pathological Conditions, Signs and Symptoms)';
      packet.unit.display_note = 'Synthetic policy note retained for the layout check.';
      packet.trial.brief_title = 'Fictional study of symptom monitoring';
      packet.trial.brief_summary =
        'This fictional study compares two ways of recording fatigue during routine activities. Participants describe their symptoms each week. This text is invented for an interface test.';
      packet.trial.detailed_description = 'Additional fictional registry evidence.';
    }
    data.units[i] = previewUnit(packet, data.guide.profile_id);
  }
  const writes: string[] = [];
  page.on('request', (r) => {
    if (r.url().includes('/api/mu7/') && r.method() !== 'GET') writes.push(r.url());
  });
  await page.route('**/api/mu7/admin/preview*', (route) => {
    const n = /\/preview\/(\d+)$/.exec(route.request().url());
    return route.fulfill({
      json: n
        ? data.units[Number(n[1]) - 1]
        : {
            status: 'PROPOSED_PREVIEW',
            guide: data.guide,
            units: data.units.map((u, i) => ({
              position: i + 1,
              title: u.display.title,
              family: u.packet.unit.family,
              trialTitle: u.packet.trial.brief_title,
            })),
          },
    });
  });
  // Explicit glob for detail routes, which include a slash after preview.
  await page.route('**/api/mu7/admin/preview/*', (route) =>
    route.fulfill({ json: data.units[Number(route.request().url().split('/').at(-1)) - 1] }),
  );
  await page.goto('/');
  await page.getByLabel('Pilot account').selectOption('investigator');
  await page
    .getByLabel('Password', { exact: true })
    .fill('e2e-only-generated-fictional-passphrase');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
  await page.getByRole('button', { name: /Mapping units/ }).click();
  const panel = page.getByRole('region', { name: 'The proposed 100 mappings' });
  await panel.getByRole('button', { name: 'Preview all 100 mappings' }).click();
  await expect(panel.getByRole('status')).toContainText('Mapping 1 of 100');
  await expect(panel.getByLabel('Choose a proposed mapping').locator('option')).toHaveCount(100);
  const packet = panel.getByRole('region', { name: 'Unit under review' });
  await expect(packet.getByText('Our classification', { exact: true })).toHaveCount(0);
  await expect(packet.getByText('Why it was classified this way')).toHaveCount(0);
  await expect(packet).not.toContainText('The original sorting used');
  await expect(packet).toContainText(data.units[0].packet.unit.display_note!);
  await expect(packet.getByText(data.units[0].display.context!, { exact: true })).toHaveCount(1);
  // Check reading and visual order, including on narrow screens. These same packet components
  // serve reviewers, adjudicators and worked examples; the stored packet is not rewritten.
  for (const width of [1280, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    const title = packet.getByRole('heading', { name: data.units[0].packet.trial.brief_title });
    const summary = packet.getByText(data.units[0].packet.trial.brief_summary!, { exact: true });
    const mapping = packet.getByText(data.units[0].display.title, { exact: true });
    const [titleBox, summaryBox, mappingBox] = await Promise.all(
      [title, summary, mapping].map((element) => element.boundingBox()),
    );
    expect(titleBox!.y + titleBox!.height).toBeLessThan(summaryBox!.y);
    expect(summaryBox!.y + summaryBox!.height).toBeLessThan(mappingBox!.y);
    const text = await packet.innerText();
    expect(text.indexOf(data.units[0].packet.trial.brief_summary!)).toBeLessThan(
      text.indexOf(data.units[0].display.title),
    );
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    if (width !== 320)
      await packet.screenshot({ path: `test-results/evidence-first-packet-${width}.png` });
  }
  await packet.getByText('Detailed description', { exact: true }).click();
  await expect(packet).toContainText('Additional fictional registry evidence.');
  await panel.getByLabel('Choose a proposed mapping').selectOption('57');
  await expect(panel.getByRole('status')).toContainText('Mapping 57 of 100');
  await expect(packet.getByText('Our classification', { exact: true })).toHaveCount(0);
  await expect(packet.getByText('Why it was classified this way')).toHaveCount(0);
  await panel.getByLabel('Choose a proposed mapping').selectOption('100');
  await expect(panel.getByRole('status')).toContainText('Mapping 100 of 100');
  await expect(panel).toContainText('Fictional trial 100');
  await expect(panel).toContainText('Required separately from the membership answer');
  await expect(packet.getByText('Our classification', { exact: true })).toBeVisible();
  await expect(packet.getByText('Why it was classified this way')).toBeVisible();
  await expect(panel.getByRole('button', { name: /Save|Submit/ })).toHaveCount(0);
  await panel.getByRole('button', { name: 'Read the reviewer guide' }).click();
  await expect(panel).toContainText('Different things you are judging');
  await panel.getByRole('button', { name: 'Return to mappings' }).click();
  for (const width of [1280, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  }
  expect(
    (
      await new AxeBuilder({ page })
        .include('[aria-labelledby="proposed-preview-heading"]')
        .withTags(['wcag2a', 'wcag2aa'])
        .analyze()
    ).violations,
  ).toEqual([]);
  expect(writes).toEqual([]);
  await panel.screenshot({ path: 'test-results/proposed-sample-preview-mobile.png' });
  let release!: () => void;
  const delayed = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/mu7/admin/preview/2', async (route) => {
    await delayed;
    await route.fulfill({ json: data.units[1] }).catch(() => undefined);
  });
  await panel.getByLabel('Choose a proposed mapping').selectOption('2');
  await expect(panel.getByRole('status')).toContainText('Loading mapping');
  await panel.getByRole('button', { name: 'Close preview' }).click();
  release();
  await expect(panel.getByRole('button', { name: 'Preview all 100 mappings' })).toBeVisible();
  await expect(panel.getByLabel('Choose a proposed mapping')).toHaveCount(0);
});
