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
    userLabelCount: vi.fn(),
    patternFindMany: vi.fn(),
    patternFindUnique: vi.fn(),
    patternUpsert: vi.fn(),
    patternUpdateMany: vi.fn(),
    classifier: vi.fn(),
    activityStart: vi.fn(),
    activityRunDetached: vi.fn(),
    activityRunToCompletion: vi.fn(),
    activityFinishRun: vi.fn(),
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
vi.mock('../src/features/activity/activity.service.js', async () => {
  const actual = await vi.importActual<
    typeof import('../src/features/activity/activity.service.js')
  >('../src/features/activity/activity.service.js');
  return {
    ...actual,
    activityService: {
      start: mocks.activityStart,
      runDetached: mocks.activityRunDetached,
      runToCompletion: mocks.activityRunToCompletion,
      finishRun: mocks.activityFinishRun,
    },
  };
});
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
      count: mocks.userLabelCount,
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
import { AppError } from '../src/errors/AppError.js';
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
  const originalBatchSize = env.AUTOMATION_BATCH_SIZE;

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
    mocks.userLabelCount.mockResolvedValue(1);
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
    env.AUTOMATION_BATCH_SIZE = originalBatchSize;
  });

  it('files newest mail first, matching the window the planner designs from', async () => {
    // Oldest-first spent entire runs on mail predating TAXONOMY_LOOKBACK_DAYS, which the tree was
    // never built to describe, so almost nothing matched and the run looked inaccurate.
    mocks.classifier.mockResolvedValue(classification());
    const service = new AutomationService({ classify: mocks.classifier }, gmailStub());

    await service.run('user-1');

    expect(mocks.messageFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: { internal_date: 'desc' } }),
    );
  });

  it('lets a sibling subject rule beat a domain rule for the mail it names', async () => {
    // A domain rule claims everything an organisation sends, so ranking it above a subject phrase
    // let one broad rule swallow the mail its narrower sibling existed to catch.
    const failedPayments = {
      ...approvedLabel,
      id: 'label-failed',
      leaf_name: 'Failed payments',
      full_path: 'MailMind/Finance/Failed payments',
      depth: 2,
    };
    const trading = {
      ...approvedLabel,
      id: 'label-trading',
      leaf_name: 'Trading',
      full_path: 'MailMind/Finance/Trading',
      depth: 2,
    };
    mocks.userLabelFindMany.mockResolvedValue([failedPayments, trading]);
    mocks.patternFindMany.mockResolvedValue([
      {
        id: 'rule-domain',
        rule_kind: 'SENDER_DOMAIN',
        match_value: 'example.com',
        rule_source: 'PLANNER',
        confidence: 1,
        user_label_id: 'label-trading',
        label_name: 'Trading',
      },
      {
        id: 'rule-subject',
        rule_kind: 'SUBJECT_CONTAINS',
        match_value: 'insufficient funds',
        rule_source: 'PLANNER',
        confidence: 1,
        user_label_id: 'label-failed',
        label_name: 'Failed payments',
      },
    ]);
    mocks.messageFindMany.mockResolvedValue([
      {
        id: 'message-row-1',
        gmail_message_id: 'gmail-message-1',
        subject: 'Payment with insufficient funds',
        sender_email: 'billing@example.com',
        snippet: 'Declined',
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
        data: expect.objectContaining({ label_name: 'Failed payments' }),
      }),
    );
  });

  it('prefers the rule filing into the deeper folder when both match', async () => {
    const finance = {
      ...approvedLabel,
      id: 'label-finance',
      leaf_name: 'Finance',
      full_path: 'MailMind/Finance',
      depth: 1,
    };
    const failedPayments = {
      ...approvedLabel,
      id: 'label-failed',
      leaf_name: 'Failed payments',
      full_path: 'MailMind/Money/Transactions/Failed payments',
      depth: 3,
    };
    mocks.userLabelFindMany.mockResolvedValue([finance, failedPayments]);
    mocks.patternFindMany.mockResolvedValue([
      {
        id: 'rule-shallow',
        rule_kind: 'SENDER_ADDRESS',
        match_value: 'billing@example.com',
        rule_source: 'PLANNER',
        confidence: 1,
        user_label_id: 'label-finance',
        label_name: 'Finance',
      },
      {
        id: 'rule-deep',
        rule_kind: 'SUBJECT_CONTAINS',
        match_value: 'insufficient funds',
        rule_source: 'PLANNER',
        confidence: 1,
        user_label_id: 'label-failed',
        label_name: 'Failed payments',
      },
    ]);
    mocks.messageFindMany.mockResolvedValue([
      {
        id: 'message-row-1',
        gmail_message_id: 'gmail-message-1',
        subject: 'Payment with insufficient funds',
        sender_email: 'billing@example.com',
        snippet: 'Declined',
        internal_date: new Date(),
        is_unread: true,
        is_important: false,
        has_attachments: false,
      },
    ]);
    const service = new AutomationService({ classify: mocks.classifier }, gmailStub());

    await service.run('user-1');

    // Depth outranks kind: the deeper folder wins even though an exact address is the narrowest
    // kind of rule there is.
    expect(mocks.actionCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ label_name: 'Failed payments' }),
      }),
    );
  });

  it('never files spam, which sync stores because it walks the mailbox with includeSpamTrash', async () => {
    mocks.classifier.mockResolvedValue(classification());
    const service = new AutomationService({ classify: mocks.classifier }, gmailStub());

    await service.run('user-1');

    expect(mocks.messageFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          NOT: { label_ids: { hasSome: ['SPAM', 'TRASH'] } },
        }),
      }),
    );
  });

  it('clusters what it could not file into candidate folders without creating any', async () => {
    // A no-fit rate is only actionable if you can see what is inside it. Four unrelated billing
    // senders are invisible one message at a time and obvious once grouped.
    const declined = [
      ...['cloudflare.com', 'microsoft.com', 'anthropic.com', 'substack.com'].map(
        (domain, index) => ({
          id: `action-${index}`,
          message: {
            subject: 'Your invoice is available',
            sender_email: `billing@${domain}`,
          },
        }),
      ),
      ...Array.from({ length: 4 }, (_, index) => ({
        id: `action-noise-${index}`,
        message: {
          subject: `Unrelated thing ${index}`,
          sender_email: `x@spread${index}.com`,
        },
      })),
    ];
    mocks.actionFindMany.mockResolvedValue(declined);

    const report = await new AutomationService(
      { classify: mocks.classifier },
      gmailStub(),
    ).gapReport('user-1');

    expect(mocks.actionFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ label_name: 'NONE' }) }),
    );
    // The shared subject wording is the cluster, not the four different senders. The value is a
    // phrase that literally occurs in the subject, so the rule it proposes actually fires.
    const invoices = report.clusters.find((cluster) => cluster.value === 'invoice is available');
    expect(invoices).toMatchObject({ kind: 'SUBJECT_CONTAINS', messageCount: 4 });
    expect(invoices!.sampleSubjects).toContain('Your invoice is available');
    // Four distinct senders, so no single domain reaches the threshold on its own.
    expect(report.clusters.some((cluster) => cluster.kind === 'SENDER_DOMAIN')).toBe(false);
    // Nothing is created: proposing a folder still goes through the labels flow.
    expect(mocks.actionCreate).not.toHaveBeenCalled();
    expect(mocks.classifier).not.toHaveBeenCalled();
  });

  it('leaves noise out of the gap report rather than proposing a folder for it', async () => {
    mocks.actionFindMany.mockResolvedValue([
      { id: 'a', message: { subject: 'One off thing', sender_email: 'a@one.com' } },
      { id: 'b', message: { subject: 'Another matter', sender_email: 'b@two.com' } },
    ]);

    const report = await new AutomationService(
      { classify: mocks.classifier },
      gmailStub(),
    ).gapReport('user-1');

    expect(report.analyzedCount).toBe(2);
    expect(report.clusters).toEqual([]);
    expect(report.clusteredCount).toBe(0);
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

  it('never offers a parent folder to the classifier, so Gmail only gets leaf labels', async () => {
    // Gmail nesting is cosmetic: a parent exists only in the tree and has no Gmail label. The
    // apply path creates whatever path it is handed, so a parent reaching the classifier would
    // create a folder in Gmail that is supposed to never exist there.
    const parent = {
      ...approvedLabel,
      id: 'label-parent',
      leaf_name: 'Finance',
      full_path: 'MailMind/Finance',
      normalized_name: 'finance',
      parent_id: null,
      gmail_label_id: null,
    };
    const leaf = { ...approvedLabel, parent_id: 'label-parent' };
    mocks.userLabelFindMany.mockResolvedValue([parent, leaf]);
    mocks.classifier.mockResolvedValue(classification());
    const service = new AutomationService({ classify: mocks.classifier }, gmailStub());

    await expect(service.run('user-1')).resolves.toMatchObject({ status: 'COMPLETED' });

    expect(mocks.classifier.mock.calls[0]?.[1]).toMatchObject({ labelNames: ['Invoices'] });
  });

  it('leaves a routing rule that points at a parent folder unresolved', async () => {
    const parent = {
      ...approvedLabel,
      id: 'label-parent',
      leaf_name: 'Finance',
      full_path: 'MailMind/Finance',
      gmail_label_id: null,
    };
    const leaf = { ...approvedLabel, parent_id: 'label-parent' };
    mocks.userLabelFindMany.mockResolvedValue([parent, leaf]);
    mocks.patternFindMany.mockResolvedValue([
      {
        id: 'rule-1',
        rule_kind: 'SENDER_DOMAIN',
        match_value: 'example.com',
        rule_source: 'PLANNER',
        confidence: 1,
        user_label_id: 'label-parent',
        label_name: 'Finance',
      },
    ]);
    mocks.classifier.mockResolvedValue(classification());
    const gmail = gmailStub();
    const service = new AutomationService({ classify: mocks.classifier }, gmail);

    await expect(service.run('user-1')).resolves.toMatchObject({ status: 'COMPLETED' });

    // The rule does not file it into the parent; the message reaches the model instead.
    expect(mocks.classifier).toHaveBeenCalledTimes(1);
    expect(gmail.ensureLabel).not.toHaveBeenCalledWith('account-1', 'MailMind/Finance');
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

  it('carries on past one unusable batch instead of abandoning the run', async () => {
    // A single malformed response used to break the loop, discarding every remaining message that
    // was still inside the budget. The bad batch is left for the next run; the rest is filed now.
    const messages = Array.from({ length: 3 }, (_, index) => ({
      id: `message-row-${index + 1}`,
      gmail_message_id: `gmail-message-${index + 1}`,
      subject: `Invoice ${index + 1}`,
      sender_email: 'billing@example.com',
      snippet: 'Amount due',
      internal_date: new Date(),
      is_unread: true,
      is_important: false,
      has_attachments: false,
    }));
    mocks.messageFindMany.mockResolvedValue(messages);
    env.AUTOMATION_BATCH_SIZE = 1;
    mocks.classifier
      .mockResolvedValueOnce(classification())
      .mockRejectedValueOnce(
        new AppError('PROVIDER_INVALID_RESPONSE', 'Gemini returned an unusable response.', 502),
      )
      .mockResolvedValueOnce(classification());
    const service = new AutomationService({ classify: mocks.classifier }, gmailStub());

    await expect(service.run('user-1')).resolves.toMatchObject({ status: 'PARTIAL' });

    expect(mocks.classifier).toHaveBeenCalledTimes(3);
    expect(mocks.transactionRunUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ messages_labeled_count: 2, failed_count: 1 }),
      }),
    );
  });

  it('stops once batches fail back to back, which means the provider not the mail', async () => {
    const messages = Array.from({ length: 5 }, (_, index) => ({
      id: `message-row-${index + 1}`,
      gmail_message_id: `gmail-message-${index + 1}`,
      subject: `Invoice ${index + 1}`,
      sender_email: 'billing@example.com',
      snippet: 'Amount due',
      internal_date: new Date(),
      is_unread: true,
      is_important: false,
      has_attachments: false,
    }));
    mocks.messageFindMany.mockResolvedValue(messages);
    env.AUTOMATION_BATCH_SIZE = 1;
    mocks.classifier.mockRejectedValue(
      new AppError('PROVIDER_INVALID_RESPONSE', 'Gemini returned an unusable response.', 502),
    );
    const service = new AutomationService({ classify: mocks.classifier }, gmailStub());

    await expect(service.run('user-1')).resolves.toMatchObject({
      status: 'PARTIAL',
      stoppedReason: 'PROVIDER_UNUSABLE',
    });

    // Three strikes, not all five: the run gives up rather than spending the budget on a fault.
    expect(mocks.classifier).toHaveBeenCalledTimes(3);
  });

  it('stops at the daily budget rather than sending a batch it cannot afford to answer', async () => {
    // A reserve too small to hold one result per message returns a truncated body, which reads as
    // a provider fault. The budget has to stop the run before it spends a call on that.
    mocks.runAggregate.mockResolvedValue({
      _sum: {
        input_tokens: 0,
        // Less than one message's worth of output budget left, so even a batch of one is refused.
        output_tokens: env.AUTOMATION_MAX_OUTPUT_TOKENS - 50,
        estimated_cost_microusd: 0,
      },
    });
    const service = new AutomationService({ classify: mocks.classifier }, gmailStub());

    await expect(service.run('user-1')).resolves.toMatchObject({
      status: 'PARTIAL',
      stoppedReason: 'DAILY_BUDGET_REACHED',
    });
    expect(mocks.classifier).not.toHaveBeenCalled();
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
        // Null, not '': the column's check rejects an empty path, and writing one aborted the
        // whole batch, so the documented outcome could never actually be recorded.
        data: expect.objectContaining({ status: 'SKIPPED', label_name: 'NONE', label_path: null }),
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

  // 202 means accepted, not finished: the work is detached and the caller polls the run id.
  it('accepts a filing run without waiting for it and hands back a run id', async () => {
    mocks.userLabelFindMany.mockResolvedValue([approvedLabel]);
    mocks.activityStart.mockResolvedValue({
      runId: 'activity-run-1',
      state: 'RUNNING',
      kind: 'AUTOMATION_FILING',
      startedAt: '2026-08-20T00:00:00.000Z',
      alreadyRunning: false,
    });
    const service = new AutomationService({ classify: mocks.classifier }, gmailStub());

    await expect(service.start('user-1')).resolves.toMatchObject({
      runId: 'activity-run-1',
      state: 'RUNNING',
    });

    expect(mocks.activityRunDetached).toHaveBeenCalledWith('activity-run-1', expect.any(Function));
    // Nothing classified inside the request itself.
    expect(mocks.classifier).not.toHaveBeenCalled();
  });

  // A precondition the caller can act on still answers synchronously, not through a run record.
  it('refuses to accept a run when no label is approved', async () => {
    mocks.userLabelFindMany.mockResolvedValue([]);
    mocks.userLabelCount.mockResolvedValue(0);
    const service = new AutomationService({ classify: mocks.classifier }, gmailStub());

    await expect(service.start('user-1')).rejects.toMatchObject({
      code: 'AUTOMATION_NO_APPROVED_LABELS',
      statusCode: 409,
    });
    expect(mocks.activityStart).not.toHaveBeenCalled();
  });

  it('does not start a second filing run while one is in flight', async () => {
    mocks.activityStart.mockResolvedValue({
      runId: 'activity-run-1',
      state: 'RUNNING',
      kind: 'AUTOMATION_FILING',
      startedAt: '2026-08-20T00:00:00.000Z',
      alreadyRunning: true,
    });
    const service = new AutomationService({ classify: mocks.classifier }, gmailStub());

    await expect(service.start('user-1')).resolves.toMatchObject({ alreadyRunning: true });
    expect(mocks.activityRunDetached).not.toHaveBeenCalled();
  });
});
