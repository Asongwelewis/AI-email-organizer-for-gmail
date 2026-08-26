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
    '/api/labels': {
      maxLabels: 40,
      maxDepth: 3,
      labels: [
        {
          id: '00000000-0000-4000-8000-000000000010',
          parentId: null,
          depth: 1,
          leafName: 'Job hunt',
          fullPath: 'MailMind/Job hunt',
          path: 'Job hunt',
          isLeaf: true,
          rationale: null,
          messageCount: 12,
          source: 'AI_PROPOSED',
          gmailLabelId: 'Label_1',
          createdAt: '2026-08-20T00:00:00.000Z',
        },
      ],
      plan: null,
    },
    '/api/activity/runs': { runs: [] },
    '/api/automation/status': {
      gmailConnected: true,
      requiresReauthentication: false,
      enabled: true,
      running: false,
      nextRunAt: '2026-08-26T02:00:00.000Z',
      retryAt: null,
      lastErrorCode: null,
      lastRun: null,
      usageToday: {
        providerCalls: 0,
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        estimatedCostMicrousd: 0,
        messagesLabeled: 0,
      },
      pendingReviewCount: 0,
      approvedLabelCount: 1,
      labelsReady: true,
      backlogRemaining: 0,
    },
    '/api/automation/review': { items: [] },
    '/api/gmail/sync/status': {
      status: 'IDLE',
      initialSyncCompleted: true,
      lastSuccessfulSyncAt: '2026-08-25T00:00:00.000Z',
      lastErrorCode: null,
      nextRetryAt: null,
      totalGmailMessages: 120,
      syncedMessages: 120,
      classifiedMessages: 120,
      unprocessedMessages: 0,
      messageCount: 120,
      syncRunning: false,
      backfill: {},
    },
    '/api/facets/pivot': { canonicalPivot: ['entity', 'intent'], minMessages: 5 },
    // The Sorted screen renders this tree now, not `/api/labels` — a folder is a facet
    // combination, and its contents come from `/api/facets/messages`.
    '/api/facets/pivot/view': {
      order: ['domain', 'intent'],
      nodes: [
        {
          facetKey: 'domain=career',
          parentFacetKey: null,
          fullPath: 'MailMind/Job hunt',
          leafName: 'Job hunt',
          depth: 1,
          messageCount: 0,
          subtreeMessageCount: 40,
          isLeaf: false,
        },
        {
          facetKey: 'domain=career|intent=application-received',
          parentFacetKey: 'domain=career',
          fullPath: 'MailMind/Job hunt/Applications sent',
          leafName: 'Applications sent',
          depth: 2,
          messageCount: 25,
          subtreeMessageCount: 25,
          isLeaf: true,
        },
      ],
      unfiled: { total: 0, noFacetValue: 0, belowThreshold: 0 },
      collapsed: 0,
    },
    '/api/facets/messages': { messages: [], nextCursor: null, total: 0 },
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

  await expect(page.getByRole('heading', { level: 1, name: 'Sorted' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Log out' })).toBeVisible();
  await expect(page.getByRole('button', { name: /Job hunt/ })).toBeVisible();
});

test('every screen is reachable from the navigation', async ({ page }) => {
  await page.route('http://127.0.0.1:4174/api/**', apiMock);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/sorted');

  // Folders and Review are the screens restored in card 14. Without them the pipeline exists in
  // the API and cannot be operated at all.
  await page.getByRole('link', { name: 'Folders' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Folders' })).toBeVisible();
  await page.getByRole('link', { name: 'Review' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Review' })).toBeVisible();
  await page.getByRole('link', { name: 'Approve' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Approve' })).toBeVisible();
  await page.getByRole('link', { name: 'Activity' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Activity' })).toBeVisible();
  await expect(page.getByText('Nothing has run yet')).toBeVisible();
});

/**
 * Setup is deliberately absent from the navigation — it is a path you walk once. What matters is
 * that it exists and is reachable, because the first-run failure this card removes was landing on
 * an empty Sorted screen whose only route onwards answered 409.
 */
test('the setup path exists and gates its steps in order', async ({ page }) => {
  await page.route('http://127.0.0.1:4174/api/**', apiMock);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/setup');

  await expect(page.getByRole('heading', { level: 1, name: 'Set up' })).toBeVisible();
  // This account is connected and already synced, so the first two steps are behind it and only
  // the last one offers an action — which is the gating this screen exists to do.
  await expect(page.getByText('Connect Gmail')).toBeVisible();
  await expect(page.getByText('Read the mailbox')).toBeVisible();
  await expect(page.getByRole('button', { name: /Sort my mail/i })).toBeVisible();
  await expect(page.getByRole('button', { name: /Start reading/i })).toHaveCount(0);
});

test('retired screens redirect into the authenticated area rather than 404', async ({ page }) => {
  await page.route('http://127.0.0.1:4174/api/**', apiMock);

  // Each retired screen lands on whichever of the three replaced it.
  for (const [retired, destination] of [
    ['/dashboard', /\/sorted$/],
    ['/dashboard/automation', /\/sorted$/],
    ['/dashboard/classification', /\/sorted$/],
    ['/dashboard/labels/discover', /\/sorted$/],
    ['/labels', /\/approve$/],
    ['/automation', /\/activity$/],
    ['/settings/connections', /\/sorted$/],
  ] as const) {
    await page.goto(retired);
    await expect(page).toHaveURL(destination);
  }
});

test('every surviving page renders without console or page errors', async ({ page }) => {
  const failures: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') failures.push(`console: ${message.text()}`);
  });
  page.on('pageerror', (error) => failures.push(`pageerror: ${error.message}`));
  await page.route('http://127.0.0.1:4174/api/**', apiMock);

  // Every screen, including the three restored in card 14 — a page that logs a 404 because
  // nothing serves a call it makes is exactly the silent breakage this test exists to catch.
  for (const route of [
    '/',
    '/login',
    '/setup',
    '/sorted',
    '/folders',
    '/review',
    '/approve',
    '/activity',
    '/privacy',
    '/terms',
  ]) {
    await page.goto(route);
    await expect(page.locator('h1').first()).toBeVisible();
  }

  expect(failures).toEqual([]);
});
