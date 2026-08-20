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
    actionCreate: vi.fn(),
    actionUpdate: vi.fn(),
    actionFindUniqueOrThrow: vi.fn(),
    messageFindMany: vi.fn(),
    messageCount: vi.fn(),
    messageUpdate: vi.fn(),
    userLabelFindMany: vi.fn(),
    userLabelFindFirst: vi.fn(),
    patternFindMany: vi.fn(),
    patternFindUnique: vi.fn(),
    patternUpsert: vi.fn(),
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
  safeErrorDetails: () => ({ errorType: 'GeminiProviderError' }),
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
    automation_message_actions: {
      findMany: mocks.actionFindMany,
      create: mocks.actionCreate,
      update: mocks.actionUpdate,
      findUniqueOrThrow: mocks.actionFindUniqueOrThrow,
    },
    gmail_message_metadata: {
      findMany: mocks.messageFindMany,
      count: mocks.messageCount,
      update: mocks.messageUpdate,
    },
    user_labels: {
      findMany: mocks.userLabelFindMany,
      findFirst: mocks.userLabelFindFirst,
    },
    learned_classification_patterns: {
      findMany: mocks.patternFindMany,
      findUnique: mocks.patternFindUnique,
      upsert: mocks.patternUpsert,
      updateMany: mocks.patternUpdateMany,
    },
    $transaction: mocks.transaction,
  },
}));

import { env } from '../src/config/env.js';
import { GeminiProviderError } from '../src/features/automation/gemini-automation.provider.js';
import { AutomationService } from '../src/features/automation/automation.service.js';

const approvedLabel = {
  id: 'label-1',
  connected_google_account_id: 'account-1',
  leaf_name: 'Invoices',
  full_path: 'MailMind/Invoices',
  normalized_name: 'invoices',
  source: 'AI_PROPOSED',
  gmail_label_id: 'Label_1',
};

const gmailStub = () => ({
  ensureLabel: vi.fn().mockResolvedValue({ id: 'Label_1', created: false }),
  applyLabel: vi.fn().mockResolvedValue(undefined),
  renameLabel: vi.fn().mockResolvedValue(undefined),
});

function classification(overrides: Record<string, unknown> = {}) {
  return {
    classifications: [
      {
        key: 'm1',
        labelName: 'Invoices',
        confidence: 0.97,
        explanation: 'Billing terms are present.',
        reasonCodes: ['INVOICE_TERMS'],
        ...overrides,
      },
    ],
    usage: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 5 },
  };
}

describe('AutomationService', () => {
  const originalKey = env.GEMINI_API_KEY;
  const originalEnabled = env.AUTOMATION_ENABLED;

  beforeEach(() => {
    vi.resetAllMocks();
    env.GEMINI_API_KEY = 'test-gemini-key';
    env.AUTOMATION_ENABLED = true;
    mocks.connectedAccount.mockResolvedValue({ id: 'account-1', user_id: 'user-1' });
    mocks.settingsUpsert.mockResolvedValue({});
    mocks.stateUpsert.mockResolvedValue({ failure_count: 0 });
    mocks.stateUpdateMany.mockResolvedValue({ count: 1 });
    mocks.runUpdateMany.mockResolvedValue({ count: 0 });
    mocks.runCreate.mockResolvedValue({ id: 'run-1' });
    mocks.runAggregate.mockResolvedValue({
      _sum: { input_tokens: 0, output_tokens: 0, estimated_cost_microusd: 0 },
    });
    mocks.actionFindMany.mockResolvedValue([]);
    mocks.actionCreate.mockResolvedValue({ id: 'action-1' });
    mocks.actionUpdate.mockResolvedValue({});
    mocks.actionFindUniqueOrThrow.mockResolvedValue({
      gmail_message_id: 'message-row-1',
      message: { label_ids: [] },
    });
    mocks.messageUpdate.mockResolvedValue({});
    mocks.messageCount.mockResolvedValue(1);
    mocks.userLabelFindMany.mockResolvedValue([approvedLabel]);
    mocks.messageFindMany.mockResolvedValue([
      {
        id: 'message-row-1',
        gmail_message_id: 'gmail-message-1',
        subject: 'Invoice 22',
        sender_email: 'billing@example.com',
        snippet: 'Amount due',
        internal_date: new Date(),
        is_unread: true,
        is_important: false,
        has_attachments: false,
      },
    ]);
    mocks.patternFindMany.mockResolvedValue([]);
    mocks.patternFindUnique.mockResolvedValue(null);
    mocks.patternUpsert.mockResolvedValue({});
    mocks.incrementalSync.mockResolvedValue(undefined);
    mocks.transactionStateUpdate.mockResolvedValue({ count: 1 });
    mocks.transactionRunUpdate.mockResolvedValue({});
  });

  afterEach(() => {
    env.GEMINI_API_KEY = originalKey;
    env.AUTOMATION_ENABLED = originalEnabled;
  });

  it('refuses to run until the account has at least one approved label', async () => {
    mocks.userLabelFindMany.mockResolvedValue([]);
    const service = new AutomationService({ classify: mocks.classifier }, gmailStub());

    await expect(service.run('user-1')).rejects.toMatchObject({
      code: 'AUTOMATION_NO_APPROVED_LABELS',
      statusCode: 409,
    });
    expect(mocks.classifier).not.toHaveBeenCalled();
    expect(mocks.runCreate).not.toHaveBeenCalled();
  });

  it('constrains the provider to the approved labels and applies a confident match', async () => {
    mocks.classifier.mockResolvedValue(classification());
    const gmail = gmailStub();
    const service = new AutomationService({ classify: mocks.classifier }, gmail);

    await expect(service.run('user-1')).resolves.toMatchObject({ status: 'COMPLETED' });

    expect(mocks.classifier.mock.calls[0]?.[1]).toMatchObject({ labelNames: ['Invoices'] });
    expect(mocks.actionCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          label_name: 'Invoices',
          label_path: 'MailMind/Invoices',
          status: 'PENDING',
        }),
      }),
    );
    expect(gmail.ensureLabel).toHaveBeenCalledWith('account-1', 'MailMind/Invoices');
    expect(gmail.applyLabel).toHaveBeenCalledWith('account-1', 'gmail-message-1', 'Label_1');
  });

  it('leaves a no-fit message in the inbox instead of inventing a label', async () => {
    mocks.classifier.mockResolvedValue(
      classification({ labelName: 'NONE', explanation: 'No approved label fits.' }),
    );
    const gmail = gmailStub();
    const service = new AutomationService({ classify: mocks.classifier }, gmail);

    await expect(service.run('user-1')).resolves.toMatchObject({ status: 'COMPLETED' });

    expect(mocks.actionCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'SKIPPED', label_name: 'NONE', label_path: '' }),
      }),
    );
    expect(gmail.ensureLabel).not.toHaveBeenCalled();
    expect(gmail.applyLabel).not.toHaveBeenCalled();
    expect(mocks.transactionRunUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ no_label_skipped_count: 1, messages_labeled_count: 0 }),
      }),
    );
  });

  it('treats an unknown label from the provider as no fit', async () => {
    mocks.classifier.mockResolvedValue(classification({ labelName: 'Something Invented' }));
    const gmail = gmailStub();
    const service = new AutomationService({ classify: mocks.classifier }, gmail);

    await service.run('user-1');

    expect(mocks.actionCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'SKIPPED' }) }),
    );
    expect(gmail.applyLabel).not.toHaveBeenCalled();
  });

  it('reports the remaining backlog so a backfill can resume on later runs', async () => {
    mocks.messageCount.mockResolvedValue(410);
    mocks.classifier.mockResolvedValue(classification());
    const service = new AutomationService({ classify: mocks.classifier }, gmailStub());

    await service.run('user-1');

    expect(mocks.messageFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: { internal_date: 'asc' } }),
    );
    expect(mocks.transactionRunUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ backlog_remaining: 409 }) }),
    );
  });

  it('files mail a routing rule covers without calling Gemini at all', async () => {
    mocks.patternFindMany.mockResolvedValue([
      {
        id: 'pattern-1',
        rule_kind: 'SENDER_DOMAIN',
        match_value: 'example.com',
        rule_source: 'PLANNER',
        user_label_id: 'label-1',
        label_name: 'Invoices',
        confidence: 1,
        label_path: 'MailMind/Invoices',
      },
    ]);
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
    const service = new AutomationService({ classify: mocks.classifier }, gmailStub());

    await expect(service.run('user-1')).resolves.toMatchObject({ status: 'COMPLETED' });

    expect(mocks.classifier).not.toHaveBeenCalled();
    expect(mocks.actionCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          label_name: 'Invoices',
          source: 'LEARNED_PATTERN',
          reason_codes: ['ROUTING_RULE', 'SENDER_DOMAIN'],
        }),
      }),
    );
    expect(mocks.transactionRunUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          provider_call_count: 0,
          pattern_reused_count: 1,
          messages_labeled_count: 1,
          input_tokens: 0,
        }),
      }),
    );
  });

  it('sends mail no rule covers to Gemini and checkpoints rate-limit recovery', async () => {
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
    mocks.classifier.mockRejectedValue(
      new GeminiProviderError(
        'PROVIDER_RATE_LIMITED',
        'Gemini is rate limited.',
        503,
        429,
        'RESOURCE_EXHAUSTED',
        'request-safe-id',
        false,
      ),
    );
    const service = new AutomationService({ classify: mocks.classifier }, gmailStub());

    await expect(service.run('user-1')).resolves.toMatchObject({
      success: false,
      runId: 'run-1',
      status: 'PARTIAL',
    });

    expect(mocks.classifier).toHaveBeenCalledTimes(1);
    expect(mocks.transactionRunUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          provider_call_count: 1,
          // A rate limit stops the run so the next scheduled tick resumes from the checkpoint.
          stopped_reason: 'PROVIDER_RATE_LIMITED',
          last_error_code: 'PROVIDER_RATE_LIMITED',
          last_provider_status: 429,
          last_provider_code: 'RESOURCE_EXHAUSTED',
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
});
