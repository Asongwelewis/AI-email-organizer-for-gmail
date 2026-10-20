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
    '/api/favorites': { items: [] },
    '/api/favorites/keys': { keys: [] },
    '/api/notifications': { items: [], unreadCount: 0, nextCursor: null },
    '/api/notifications/push': { configured: false, publicKey: null, subscriptions: 0 },
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
    // Set up already, so no screen shows the setup card unless a test says otherwise.
    '/api/onboarding': {
      state: 'DONE',
      stage: 'DONE',
      processed: 300,
      total: 300,
      sorted: 300,
      message: null,
      stopReason: null,
      runId: 'run-onboarding',
      startedAt: '2026-08-25T00:00:00.000Z',
      finishedAt: '2026-08-25T00:03:00.000Z',
      completedAt: '2026-08-25T00:03:00.000Z',
    },
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
    // Find reads these two. A screen that logs a 404 because nothing serves a call it makes is
    // exactly what the console-error test below exists to catch.
    '/api/facets/vocabulary': {
      entity: [{ value: 'linkedin', messageCount: 40 }],
      domain: [{ value: 'career', messageCount: 40 }],
      intent: [{ value: 'application-received', messageCount: 25 }],
    },
    '/api/facets/search': {
      query: null,
      filters: { entity: null, domain: null, intent: null },
      order: ['domain', 'intent'],
      results: [],
      total: 0,
      nextCursor: null,
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

  await page.goto('/inbox');
  await expect(page).toHaveURL(/\/login$/);
});

test('a signed-in visitor lands in the authenticated shell', async ({ page }) => {
  await page.route('http://127.0.0.1:4174/api/**', apiMock);
  await page.goto('/inbox');

  await expect(page.getByRole('heading', { level: 1, name: 'Inbox' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Log out' })).toBeVisible();
  // The folder itself, not its star, whose label names the folder too.
  await expect(page.getByRole('button', { name: /^(?!.*favourites).*Job hunt/ })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add Job hunt to favourites' })).toBeVisible();
  // The menu sits on the left of every screen.
  await expect(page.getByRole('link', { name: 'Menu' })).toBeVisible();
});

test('every screen is reachable from the navigation', async ({ page }) => {
  await page.route('http://127.0.0.1:4174/api/**', apiMock);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/inbox');

  // Exact names: a screen may also link to another by a longer phrase — Find offers "Browse
  // folders instead" — and a substring match would resolve to two elements.
  await page.getByRole('link', { name: 'Find', exact: true }).first().click();
  await expect(page.getByRole('heading', { level: 1, name: 'Find' })).toBeVisible();
  await page.getByRole('link', { name: 'Favourites', exact: true }).first().click();
  await expect(page.getByRole('heading', { level: 1, name: 'Favourites' })).toBeVisible();
  await page.getByRole('link', { name: 'Folders', exact: true }).first().click();
  await expect(page.getByRole('heading', { level: 1, name: 'Folders' })).toBeVisible();
  await page.getByRole('link', { name: 'Activity', exact: true }).first().click();
  await expect(page.getByRole('heading', { level: 1, name: 'Activity' })).toBeVisible();
  await expect(page.getByText('Nothing has run yet')).toBeVisible();
  // Notifications live behind the menu on the left.
  await page.getByRole('link', { name: 'Menu' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Menu' })).toBeVisible();
  await page.getByRole('link', { name: /Notifications/ }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Notifications' })).toBeVisible();
});

/**
 * Setup is deliberately absent from the navigation — it is a path you walk once. After Gmail is
 * connected it has no buttons: the server sets the mailbox up on its own and this screen shows it
 * happening, because a friend who signed up once saw nothing sorted and an operator's error.
 */
test('setup shows a connected mailbox being set up, with nothing to press', async ({ page }) => {
  await page.route('http://127.0.0.1:4174/api/**', async (route) => {
    if (new URL(route.request().url()).pathname !== '/api/onboarding') return apiMock(route);
    await route.fulfill({
      status: 200,
      json: {
        state: 'RUNNING',
        stage: 'SORTING',
        processed: 75,
        total: 300,
        sorted: 0,
        message: null,
        stopReason: null,
        runId: 'run-onboarding',
        startedAt: '2026-08-25T00:00:00.000Z',
        finishedAt: null,
        completedAt: null,
      },
    });
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/setup');

  await expect(page.getByRole('heading', { level: 1, name: 'Set up' })).toBeVisible();
  await expect(page.getByText('Setting up your inbox')).toBeVisible();
  await expect(page.getByText('Sorting your newest mail into folders')).toBeVisible();
  await expect(page.getByText('75 of 300')).toBeVisible();
  await expect(page.getByRole('button', { name: /Start reading|Sort my mail/i })).toHaveCount(0);
});

test('retired screens redirect into the authenticated area rather than 404', async ({ page }) => {
  await page.route('http://127.0.0.1:4174/api/**', apiMock);

  // Each retired screen lands on whichever replaced it. Sorted is called Inbox now, and keeps its
  // query string so an old bookmark still opens the same folder.
  for (const [retired, destination] of [
    ['/sorted', /\/inbox$/],
    ['/sorted?range=all', /\/inbox\?range=all$/],
    ['/review', /\/inbox$/],
    ['/approve', /\/inbox$/],
    ['/dashboard', /\/inbox$/],
    ['/dashboard/automation', /\/inbox$/],
    ['/dashboard/classification', /\/inbox$/],
    ['/dashboard/labels/discover', /\/inbox$/],
    ['/labels', /\/inbox$/],
    ['/automation', /\/activity$/],
    ['/settings/connections', /\/inbox$/],
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
    '/inbox',
    '/find',
    '/favorites',
    '/folders',
    '/activity',
    '/menu',
    '/notifications',
    '/privacy',
    '/terms',
    '/support',
    '/data-deletion',
  ]) {
    await page.goto(route);
    await expect(page.locator('h1').first()).toBeVisible();
  }

  expect(failures).toEqual([]);
});
