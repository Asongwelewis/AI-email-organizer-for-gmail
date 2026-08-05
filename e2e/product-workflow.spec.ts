import { expect, test, type Route } from '@playwright/test';

const syncStatus = {
  status: 'READY',
  initialSyncCompleted: true,
  lastSuccessfulSyncAt: '2026-07-26T18:00:00.000Z',
  lastErrorCode: null,
  nextRetryAt: null,
  totalGmailMessages: 257,
  syncedMessages: 257,
  classifiedMessages: 7,
  unprocessedMessages: 250,
  messageCount: 257,
  syncRunning: false,
  backfill: {
    running: false,
    completed: true,
    messagesProcessed: 257,
    totalMessages: 257,
    remainingMessages: 0,
    pagesCompleted: 2,
    checkpointedAt: '2026-07-26T18:00:00.000Z',
    checkpointHistoryId: 'history-safe',
  },
};

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
    '/api/integrations/google/status': {
      connected: true,
      email: 'ada@gmail.com',
      status: 'CONNECTED',
      grantedScopes: ['https://www.googleapis.com/auth/gmail.modify'],
      requiresReauthentication: false,
      connectedAt: '2026-07-20T00:00:00.000Z',
    },
    '/api/gmail/sync/status': syncStatus,
    '/api/labels': {
      maxLabels: 25,
      labels: [
        {
          id: 'label-1',
          leafName: 'Invoices',
          fullPath: 'MailMind/Invoices',
          source: 'AI_PROPOSED',
          gmailLabelId: 'Label_1',
          createdAt: '2026-07-30T00:00:00.000Z',
        },
      ],
      proposals: [
        {
          id: 'proposal-1',
          leafName: 'Flights',
          fullPath: 'MailMind/Flights',
          confidence: 0.82,
          messageCount: 14,
          reasonCodes: ['SOURCE_VOLUME'],
        },
      ],
    },
    '/api/automation/status': {
      gmailConnected: true,
      requiresReauthentication: false,
      enabled: true,
      running: false,
      nextRunAt: '2026-07-27T02:00:00.000Z',
      retryAt: '2026-07-27T00:00:00.000Z',
      lastErrorCode: 'OPENAI_INSUFFICIENT_QUOTA',
      lastRun: {
        id: 'run-1',
        status: 'PARTIAL',
        trigger: 'MANUAL',
        messagesSeen: 250,
        patternReused: 0,
        openaiClassified: 0,
        reviewRequired: 0,
        noLabelSkipped: 0,
        backlogRemaining: 0,
        messagesLabeled: 0,
        failed: 10,
        providerCalls: 1,
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        estimatedCostMicrousd: 0,
        stoppedReason: null,
        lastErrorCode: 'OPENAI_INSUFFICIENT_QUOTA',
        lastProviderStatus: 429,
        lastProviderCode: 'insufficient_quota',
        lastProviderRequestId: 'request-safe-id',
        startedAt: '2026-07-26T18:00:00.000Z',
        completedAt: '2026-07-26T18:00:05.000Z',
      },
      usageToday: {
        providerCalls: 1,
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        estimatedCostMicrousd: 0,
        messagesLabeled: 0,
      },
      limits: {
        inputTokens: 100000,
        outputTokens: 10000,
        estimatedCostMicrousd: 500000,
        messages: 250,
      },
      pendingReviewCount: 0,
      approvedLabelCount: 1,
      labelsReady: true,
      backlogRemaining: 0,
    },
    '/api/automation/review': { items: [] },
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

test('a signed-in visitor lands on the dashboard', async ({ page }) => {
  await page.route('http://127.0.0.1:4174/api/**', apiMock);
  await page.goto('/dashboard');

  await expect(page.getByRole('heading', { level: 1 })).toContainText('Good to see you');
  await expect(page.getByRole('navigation', { name: 'Primary navigation' })).toBeVisible();
});

test('the dashboard navigates to automation and shows safe provider failure detail', async ({
  page,
}) => {
  await page.route('http://127.0.0.1:4174/api/**', apiMock);
  await page.goto('/dashboard');

  await page.getByRole('link', { name: 'Automation', exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard\/automation$/);

  await expect(page.getByRole('navigation', { name: 'MailMind workflow' })).toBeVisible();
  await expect(page.getByText('7 of 257 synced messages processed')).toBeVisible();

  const tooltipButton = page.getByRole('button', { name: 'Explain Unprocessed' });
  await tooltipButton.hover();
  await expect(page.getByRole('tooltip')).toContainText(/automation has not acted on/i);

  await expect(page.getByText(/OpenAI quota is unavailable/i)).toBeVisible();
  await expect(page.getByText(/Provider status: 429/i)).toBeVisible();
  await expect(page.getByText(/Safe code: insufficient_quota/i)).toBeVisible();
  await expect(page.getByText(/Request reference: request-safe-id/i)).toBeVisible();
  await expect(page.getByText(/authorization|api key|email body/i)).toHaveCount(0);
});

test('the labels screen lists approvals and never touches Gmail before confirmation', async ({
  page,
}) => {
  await page.route('http://127.0.0.1:4174/api/**', apiMock);
  await page.goto('/dashboard');

  await page.getByRole('link', { name: 'Labels', exact: true }).click();
  await expect(page).toHaveURL(/\/labels$/);

  await expect(page.getByText('MailMind/Invoices')).toBeVisible();
  await expect(page.locator('input[value="Flights"]')).toBeVisible();
  await expect(page.getByText('1 of 25 labels')).toBeVisible();

  // The confirm dialog stands between the proposal list and any Gmail write.
  await page.getByRole('button', { name: /Confirm and create in Gmail/i }).click();
  await expect(page.getByRole('dialog')).toContainText('No messages are moved or relabeled');
});

test('retired classification and label-discovery routes redirect to the dashboard', async ({
  page,
}) => {
  await page.route('http://127.0.0.1:4174/api/**', apiMock);

  await page.goto('/dashboard/classification');
  await expect(page).toHaveURL(/\/dashboard$/);

  await page.goto('/dashboard/labels/discover');
  await expect(page).toHaveURL(/\/dashboard$/);
});

test('every surviving page renders without console or page errors', async ({ page }) => {
  const failures: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') failures.push(`console: ${message.text()}`);
  });
  page.on('pageerror', (error) => failures.push(`pageerror: ${error.message}`));
  await page.route('http://127.0.0.1:4174/api/**', apiMock);

  for (const route of [
    '/',
    '/login',
    '/dashboard',
    '/settings/connections',
    '/labels',
    '/dashboard/automation',
  ]) {
    await page.goto(route);
    await expect(page.locator('h1').first()).toBeVisible();
  }

  expect(failures).toEqual([]);
});
