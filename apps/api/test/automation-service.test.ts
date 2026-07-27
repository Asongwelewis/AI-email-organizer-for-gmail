import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const transactionStateUpdate = vi.fn();
  const transactionRunUpdate = vi.fn();
  return {
    auditRecord: vi.fn(),
    incrementalSync: vi.fn(),
    initialSync: vi.fn(),
    connectedAccount: vi.fn(),
    settingsUpsert: vi.fn(),
    stateUpsert: vi.fn(),
    stateUpdateMany: vi.fn(),
    runUpdateMany: vi.fn(),
    runCreate: vi.fn(),
    runAggregate: vi.fn(),
    actionFindMany: vi.fn(),
    messageFindMany: vi.fn(),
    patternFindMany: vi.fn(),
    patternUpdateMany: vi.fn(),
    classifier: vi.fn(),
    transactionStateUpdate,
    transactionRunUpdate,
    transaction: vi.fn(async (callback: (transaction: unknown) => unknown) =>
      callback({
        automation_states: { updateMany: transactionStateUpdate },
        automation_runs: { update: transactionRunUpdate },
      }),
    ),
  };
});

vi.mock('../src/audit/audit.service.js', () => ({
  auditService: { record: mocks.auditRecord },
}));
vi.mock('../src/integrations/gmail/gmail.service.js', () => ({
  gmailSyncService: {
    incrementalSync: mocks.incrementalSync,
    initialSync: mocks.initialSync,
  },
}));
vi.mock('../src/config/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
  safeErrorDetails: () => ({ errorType: 'OpenAiProviderError' }),
}));
vi.mock('../src/database/prisma.js', () => ({
  prisma: {
    connected_google_accounts: { findFirst: mocks.connectedAccount },
    automation_settings: { upsert: mocks.settingsUpsert },
    automation_states: {
      upsert: mocks.stateUpsert,
      updateMany: mocks.stateUpdateMany,
    },
    automation_runs: {
      updateMany: mocks.runUpdateMany,
      create: mocks.runCreate,
      aggregate: mocks.runAggregate,
    },
    automation_message_actions: { findMany: mocks.actionFindMany },
    gmail_message_metadata: { findMany: mocks.messageFindMany },
    learned_classification_patterns: {
      findMany: mocks.patternFindMany,
      updateMany: mocks.patternUpdateMany,
    },
    $transaction: mocks.transaction,
  },
}));

import { env } from '../src/config/env.js';
import { OpenAiProviderError } from '../src/features/automation/openai-automation.provider.js';
import { AutomationService } from '../src/features/automation/automation.service.js';

describe('AutomationService recovery', () => {
  const originalKey = env.OPENAI_API_KEY;
  const originalEnabled = env.AUTOMATION_ENABLED;

  beforeEach(() => {
    vi.resetAllMocks();
    env.OPENAI_API_KEY = 'test-openai-key';
    env.AUTOMATION_ENABLED = true;
    mocks.connectedAccount.mockResolvedValue({
      id: 'account-1',
      user_id: 'user-1',
    });
    mocks.settingsUpsert.mockResolvedValue({});
    mocks.stateUpsert.mockResolvedValue({ failure_count: 0 });
    mocks.stateUpdateMany.mockResolvedValue({ count: 1 });
    mocks.runUpdateMany.mockResolvedValue({ count: 0 });
    mocks.runCreate.mockResolvedValue({ id: 'run-1' });
    mocks.runAggregate.mockResolvedValue({
      _sum: { input_tokens: 0, output_tokens: 0, estimated_cost_microusd: 0 },
    });
    mocks.actionFindMany.mockResolvedValue([]);
    mocks.messageFindMany.mockResolvedValue([
      {
        id: 'message-row-1',
        gmail_message_id: 'gmail-message-1',
        subject: 'Project update',
        sender_email: 'person@example.com',
        snippet: 'Status',
        internal_date: new Date(),
        is_unread: true,
        is_important: false,
        has_attachments: false,
      },
    ]);
    mocks.patternFindMany.mockResolvedValue([
      {
        id: 'pattern-1',
        sender_domain: 'example.com',
        category: 'WORK',
        confidence: 0.95,
        label_path: 'MailMind/Work',
      },
    ]);
    mocks.incrementalSync.mockResolvedValue(undefined);
    mocks.transactionStateUpdate.mockResolvedValue({ count: 1 });
    mocks.transactionRunUpdate.mockResolvedValue({});
  });

  it('still sends learned-pattern mail through OpenAI and checkpoints quota recovery', async () => {
    mocks.classifier.mockRejectedValue(
      new OpenAiProviderError(
        'OPENAI_INSUFFICIENT_QUOTA',
        'OpenAI quota is unavailable.',
        503,
        429,
        'insufficient_quota',
        'request-safe-id',
        false,
      ),
    );
    const service = new AutomationService(
      { classify: mocks.classifier },
      { ensureLabel: vi.fn(), applyLabel: vi.fn() },
    );

    await expect(service.run('user-1')).resolves.toMatchObject({
      success: false,
      runId: 'run-1',
      status: 'PARTIAL',
    });

    expect(mocks.classifier).toHaveBeenCalledTimes(1);
    expect(mocks.classifier.mock.calls[0]?.[0]?.[0]).toMatchObject({
      learnedPattern: { category: 'WORK', labelPath: 'MailMind/Work' },
    });
    expect(mocks.transactionRunUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          provider_call_count: 1,
          last_error_code: 'OPENAI_INSUFFICIENT_QUOTA',
          last_provider_status: 429,
          last_provider_code: 'insufficient_quota',
          last_provider_request_id: 'request-safe-id',
        }),
      }),
    );
    expect(mocks.transactionStateUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          retry_at: expect.any(Date),
          failure_count: { increment: 1 },
        }),
      }),
    );
  });

  afterEach(() => {
    env.OPENAI_API_KEY = originalKey;
    env.AUTOMATION_ENABLED = originalEnabled;
  });
});
