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
  await expect(page.getByRole('heading', { name: 'Clinical review practice' })).toBeVisible();
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
