import { expect, test, type Route } from '@playwright/test';

async function apiMock(route: Route) {
  const url = new URL(route.request().url());
  const path = url.pathname;
  const responses: Record<string, unknown> = {
    '/api/auth/me': {
      user: {
        id: 'user-1',
        email: 'ada@example.com',
        displayName: 'Ada',
        avatarUrl: null,
        status: 'ACTIVE',
        gmailConnected: true,
        tutorialCompletedAt: '2026-07-20T00:00:00.000Z',
      },
    },
    // AuthProvider still resolves the Gmail connection; it is session plumbing, not a screen.
    '/api/integrations/google/status': {
      connected: true,
      email: 'ada@gmail.com',
      status: 'CONNECTED',
      grantedScopes: ['https://www.googleapis.com/auth/gmail.modify'],
      requiresReauthentication: false,
      connectedAt: '2026-07-20T00:00:00.000Z',
    },
  };
  const response = responses[path];
  if (response === undefined) {
    await route.fulfill({ status: 404, json: { error: { code: 'NOT_MOCKED' } } });
    return;
  }
  await route.fulfill({ status: 200, json: response });
}

test('a signed-out visitor moves from landing to login without granting Gmail access', async ({
  page,
}) => {
  await page.route('http://127.0.0.1:4174/api/**', async (route) => {
    if (new URL(route.request().url()).pathname === '/api/auth/me') {
      await route.fulfill({ status: 401, json: { error: { code: 'AUTH_REQUIRED' } } });
      return;
    }
    await apiMock(route);
  });
  await page.goto('/');

  await expect(page.getByText('No Gmail access at sign-in')).toBeVisible();
  await page.getByRole('link', { name: /Begin with Google/i }).click();
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole('button', { name: /Continue with Google/i })).toBeVisible();
});

test('a signed-out visitor is sent to login and returned to the authenticated area', async ({
  page,
}) => {
  await page.route('http://127.0.0.1:4174/api/**', async (route) => {
    await route.fulfill({ status: 401, json: { error: { code: 'AUTH_REQUIRED' } } });
  });

  await page.goto('/sorted');
  await expect(page).toHaveURL(/\/login$/);
});

test('a signed-in visitor lands in the authenticated shell', async ({ page }) => {
  await page.route('http://127.0.0.1:4174/api/**', apiMock);
  await page.goto('/sorted');

  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Log out' })).toBeVisible();
});

test('retired screens redirect into the authenticated area rather than 404', async ({ page }) => {
  await page.route('http://127.0.0.1:4174/api/**', apiMock);

  for (const retired of [
    '/dashboard',
    '/dashboard/automation',
    '/dashboard/classification',
    '/dashboard/labels/discover',
    '/labels',
    '/settings/connections',
  ]) {
    await page.goto(retired);
    await expect(page).toHaveURL(/\/sorted$/);
  }
});

test('every surviving page renders without console or page errors', async ({ page }) => {
  const failures: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') failures.push(`console: ${message.text()}`);
  });
  page.on('pageerror', (error) => failures.push(`pageerror: ${error.message}`));
  await page.route('http://127.0.0.1:4174/api/**', apiMock);

  for (const route of ['/', '/login', '/sorted', '/privacy', '/terms']) {
    await page.goto(route);
    await expect(page.locator('h1').first()).toBeVisible();
  }

  expect(failures).toEqual([]);
});
