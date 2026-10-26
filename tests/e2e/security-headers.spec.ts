import { test, expect } from '@playwright/test';

test('hosted name chooser submits only the selected username and password (mock Auth)', async ({
  page,
}) => {
  let submitted: unknown;
  await page.route('**/api/session', async (route) => {
    if (route.request().method() === 'POST') {
      submitted = route.request().postDataJSON();
      return route.fulfill({
        status: 401,
        json: { error: 'Account or password was not accepted.' },
      });
    }
    return route.fulfill({
      json: {
        user: null,
        environment: 'supabase-staging',
        loginChoices: [{ username: 'synthetic-person', label: 'Synthetic Person' }],
      },
    });
  });
  await page.goto('/');
  await page.getByLabel('Your name').selectOption({ label: 'Synthetic Person' });
  await expect(page.locator('.environment-banner')).toContainText('REVIEW WORKSPACE');
  await expect(page.locator('.auth-note')).toHaveText(
    'Sign in to your assigned workspace. Study access is controlled by the investigator.',
  );
  await expect(page.getByText('Fabricated evidence only.', { exact: false })).toHaveCount(0);
  await page.getByLabel('Password', { exact: true }).fill('fictional-wrong-password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.locator('form [role="alert"]')).toContainText(
    'Account or password was not accepted.',
  );
  expect(submitted).toEqual({ username: 'synthetic-person', password: 'fictional-wrong-password' });
  await expect(page.getByRole('button', { name: 'Sign out' })).toHaveCount(0);
});

test('hosted navigation opens Mapping units by default (mock session, no remote Auth claim)', async ({
  page,
}) => {
  await page.route('**/api/session', (route) =>
    route.fulfill({
      json: {
        environment: 'supabase-staging',
        user: {
          id: 'synthetic-navigation-user',
          displayName: 'Synthetic reviewer',
          role: 'REVIEWER',
          aal: 'aal1',
          mfaEnrolled: false,
        },
      },
    }),
  );
  await page.route('**/api/mu7/**', (route) =>
    route.fulfill({ status: 503, json: { error: 'Synthetic navigation check only.' } }),
  );
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Mapping units Design v7' })).toHaveClass('active');
  await expect(page.getByRole('heading', { name: 'Clinical classification review' })).toBeVisible();
  await expect(page.locator('.environment-banner')).toContainText('REVIEW WORKSPACE');
});

test('workspace wording waits for session context and retains the local synthetic warning', async ({
  page,
}) => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/session', async (route) => {
    await pending;
    await route.fulfill({ json: { user: null, environment: 'synthetic' } });
  });
  await page.goto('/');
  await expect(page.locator('.environment-banner')).toContainText('CONNECTING');
  await expect(page.locator('.environment-banner')).not.toContainText('SYNTHETIC PILOT');
  release();
  await expect(page.locator('.environment-banner')).toContainText('SYNTHETIC PILOT');
  await expect(page.locator('.environment-banner')).toContainText('Fabricated evidence only.');
  await expect(page.getByLabel('Pilot account')).toBeVisible();
});

test('served page hydrates under nonce CSP and refuses an injected unnonced script', async ({
  page,
  request,
}) => {
  // Inject into the HTML parser, not through DevTools evaluation (which is a trusted
  // script execution context and can propagate strict-dynamic trust).
  await page.route('**/*', async (route) => {
    if (!route.request().isNavigationRequest()) return route.continue();
    const response = await route.fetch();
    const body = (await response.text()).replace(
      '</body>',
      '<script>document.documentElement.dataset.injected = "executed"</script></body>',
    );
    await route.fulfill({ response, body });
  });
  const response = await page.goto('/');
  const csp = response!.headers()['content-security-policy'];
  expect(csp).toContain("'strict-dynamic'");
  const nonce = /'nonce-([^']+)'/.exec(csp)![1];
  if (process.env.VERIFY_E2E_PRODUCTION) expect(csp).not.toContain('unsafe-eval');
  expect(csp.split(';').find((v) => v.trim().startsWith('script-src'))).not.toContain(
    'unsafe-inline',
  );
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
  expect(
    await page
      .locator('script[src]')
      .first()
      .evaluate((s) => (s as HTMLScriptElement).nonce),
  ).toBe(nonce);
  const again = await request.get('/');
  expect(again.headers()['content-security-policy']).not.toContain(`'nonce-${nonce}'`);
  expect(await page.locator('html').getAttribute('data-injected')).toBeNull();
  // A React interaction still works: a nonce mismatch would leave this unhydrated.
  await page.getByLabel('Password', { exact: true }).fill('incorrect-synthetic-password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByText('Account or password was not accepted.')).toBeVisible();
});

test('view-only investigator sees progress without MFA or editing controls (mock session)', async ({
  page,
}) => {
  await page.route('**/api/session', (route) =>
    route.fulfill({
      json: {
        environment: 'supabase-staging',
        user: {
          id: 'synthetic-observer',
          displayName: 'Synthetic observer',
          role: 'INVESTIGATOR',
          aal: 'aal1',
          practiceReadOnly: true,
        },
      },
    }),
  );
  await page.route('**/api/practice-observer', (route) =>
    route.fulfill({
      json: {
        pilotUnits: 12,
        locked: false,
        training: [],
        completion: [
          { reviewerSlot: 1, assigned: 12, answered: 3 },
          { reviewerSlot: 2, assigned: 12, answered: 2 },
        ],
      },
    }),
  );
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'View-only practice' })).toBeVisible();
  await expect(page.getByText('Reviewer 1: 3 of 12 answered')).toBeVisible();
  await expect(
    page.getByRole('button', { name: /enrol|verify|import|assign|lock|approve|export/i }),
  ).toHaveCount(0);
});

test('hosted sign-out can retry an outage and leaves an expired workspace (mock Auth)', async ({
  page,
}) => {
  let attempts = 0;
  await page.route('**/api/session', (route) => {
    if (route.request().method() === 'DELETE') {
      attempts++;
      return route.fulfill(
        attempts === 1
          ? { status: 502, json: { error: 'Sign-out could not be confirmed. Please try again.' } }
          : { json: { ok: true, revocation: 'credentials_unavailable' } },
      );
    }
    return route.fulfill({
      json: {
        environment: 'supabase-staging',
        user: {
          id: 'synthetic-expired-user',
          displayName: 'Synthetic reviewer',
          role: 'REVIEWER',
          aal: 'aal1',
          mfaEnrolled: false,
        },
      },
    });
  });
  await page.route('**/api/mu7/workspace', (route) =>
    route.fulfill({
      json: {
        kind: 'reviewer',
        enrolled: true,
        designRecorded: true,
        queue: [],
        training: [],
        trainingAcknowledgedAt: null,
      },
    }),
  );
  await page.goto('/');
  await expect(page.getByRole('tab', { name: 'Worked examples', exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('main').getByRole('alert')).toContainText('Please try again');
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign out' })).toHaveCount(0);
  await expect(page.getByRole('tab', { name: 'Worked examples', exact: false })).toHaveCount(0);
  expect(attempts).toBe(2);
});
