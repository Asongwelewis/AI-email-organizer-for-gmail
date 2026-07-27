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
    '/api/label-discovery/status': {
      enabled: true,
      running: false,
      activeRunId: null,
      pendingCount: 0,
      approvedCount: 0,
      maxPendingCandidates: 50,
      maxApprovedLabels: 100,
      gmailLabelCreationSupported: false,
      lastErrorCode: null,
      latestRun: null,
      versions: {
        discovery: 'v1',
        naming: 'v1',
        confidence: 'v1',
      },
    },
    '/api/label-discovery/candidates': { candidates: [], nextCursor: null },
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

test('low classification coverage leads to the correct next action and safe automation detail', async ({
  page,
}) => {
  await page.route('http://127.0.0.1:4174/api/**', apiMock);
  await page.goto('/dashboard/labels/discover');

  await expect(page.getByRole('navigation', { name: 'MailMind workflow' })).toBeVisible();
  await expect(page.getByText('7 of 257 synced messages are classified')).toBeVisible();
  await expect(page.getByText('thresholds have not been lowered')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Classify remaining messages' })).toHaveAttribute(
    'href',
    '/dashboard/classification',
  );

  const tooltipButton = page.getByRole('button', { name: 'Explain Unprocessed' });
  await tooltipButton.focus();
  await expect(page.getByRole('tooltip')).toContainText(/classification/i);

  await page.getByRole('link', { name: /Automate/i }).click();
  await expect(page).toHaveURL(/\/dashboard\/automation$/);
  await expect(page.getByText(/OpenAI quota is unavailable/i)).toBeVisible();
  await expect(page.getByText(/Provider status: 429/i)).toBeVisible();
  await expect(page.getByText(/Safe code: insufficient_quota/i)).toBeVisible();
  await expect(page.getByText(/Request reference: request-safe-id/i)).toBeVisible();
  await expect(page.getByText(/authorization|api key|email body/i)).toHaveCount(0);
});
