import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  auditRecord: vi.fn(),
  incrementalSync: vi.fn(),
  initialSync: vi.fn(),
  connectedAccount: vi.fn(),
  stateUpsert: vi.fn(),
  actionFindMany: vi.fn(),
  actionFindFirst: vi.fn(),
  actionCreate: vi.fn(),
  actionUpdate: vi.fn(),
  runCreate: vi.fn(),
  runUpdate: vi.fn(),
  messageUpdate: vi.fn(),
  userLabelFindMany: vi.fn(),
  userLabelFindFirst: vi.fn(),
  userLabelCount: vi.fn(),
  userLabelUpdate: vi.fn(),
  gmailLabelFindMany: vi.fn(),
  facetVocabularyApproved: vi.fn(),
  classifyAccount: vi.fn(),
  fileAccount: vi.fn(),
  activityStart: vi.fn(),
  activityRunDetached: vi.fn(),
  activityRunToCompletion: vi.fn(),
}));

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
      finishRun: vi.fn(),
    },
  };
});
vi.mock('../src/integrations/gmail/gmail.service.js', () => ({
  gmailSyncService: { incrementalSync: mocks.incrementalSync, initialSync: mocks.initialSync },
}));
vi.mock('../src/config/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
  safeErrorDetails: () => ({ errorType: 'Error' }),
}));
vi.mock('../src/features/label-discovery/facet-vocabulary.repository.js', () => ({
  facetVocabularyRepository: { approved: mocks.facetVocabularyApproved },
}));
vi.mock('../src/database/prisma.js', () => ({
  prisma: {
    connected_google_accounts: { findFirst: mocks.connectedAccount },
    automation_states: { upsert: mocks.stateUpsert },
    automation_message_actions: {
      findMany: mocks.actionFindMany,
      findFirst: mocks.actionFindFirst,
      create: mocks.actionCreate,
      update: mocks.actionUpdate,
    },
    automation_runs: { create: mocks.runCreate, update: mocks.runUpdate },
    gmail_labels: { findMany: mocks.gmailLabelFindMany },
    gmail_message_metadata: { update: mocks.messageUpdate, count: vi.fn().mockResolvedValue(0) },
    user_labels: {
      findMany: mocks.userLabelFindMany,
      findFirst: mocks.userLabelFindFirst,
      count: mocks.userLabelCount,
      update: mocks.userLabelUpdate,
    },
  },
}));

import { env } from '../src/config/env.js';
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
  applyExclusiveLabel: vi.fn().mockResolvedValue(undefined),
  renameLabel: vi.fn().mockResolvedValue(undefined),
});

const classified = (overrides: Record<string, unknown> = {}) => ({
  messagesSeen: 10,
  ruleDecided: 4,
  modelDecided: 6,
  domainAssigned: 10,
  intentAssigned: 9,
  entityAssigned: 10,
  crossEntityRuleHits: 2,
  rulesLearned: 1,
  failed: 0,
  providerCalls: 1,
  usage: { inputTokens: 120, cachedInputTokens: 0, outputTokens: 40 },
  costMicrousd: 2000,
  stoppedReason: null,
  lastErrorCode: null,
  ...overrides,
});

const filed = (overrides: Record<string, unknown> = {}) => ({
  seen: 10,
  filed: 8,
  none: 1,
  reviewRequired: 1,
  failed: 0,
  fromRules: 4,
  fromModel: 6,
  labelsCreated: 2,
  labelsReused: 3,
  staleLabelsRemoved: 1,
  pivot: { nodes: [], order: ['entity', 'intent'], unfiled: 0, collapsed: 0 },
  runId: 'automation-run-1',
  ...overrides,
});

function service(gmail = gmailStub()) {
  return new AutomationService(
    gmail as never,
    { classifyAccount: mocks.classifyAccount } as never,
    { fileAccount: mocks.fileAccount } as never,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  env.GEMINI_API_KEY = 'test-gemini-key';
  env.AUTOMATION_ENABLED = true;
  // The shipped default. Filing is the export path now, not what runs every night.
  env.GMAIL_WRITE_ENABLED = false;
  mocks.connectedAccount.mockResolvedValue({ id: 'account-1', user_id: 'user-1' });
  mocks.stateUpsert.mockResolvedValue({});
  mocks.userLabelCount.mockResolvedValue(1);
  mocks.userLabelFindMany.mockResolvedValue([approvedLabel]);
  mocks.incrementalSync.mockResolvedValue(undefined);
  mocks.initialSync.mockResolvedValue(undefined);
  mocks.classifyAccount.mockResolvedValue(classified());
  mocks.fileAccount.mockResolvedValue(filed());
  mocks.auditRecord.mockResolvedValue(undefined);
  mocks.runCreate.mockResolvedValue({ id: 'classification-run-1' });
  mocks.runUpdate.mockResolvedValue({});
  mocks.facetVocabularyApproved.mockResolvedValue({
    domain: [{ name: 'finance', definition: 'Money, banking, payments, invoices, and receipts.' }],
    intent: [{ name: 'newsletter', definition: 'A periodic or broadcast roundup of information.' }],
  });
});

afterEach(() => {
  env.AUTOMATION_ENABLED = true;
  env.GMAIL_WRITE_ENABLED = false;
});

/**
 * One engine, and — since card 21 — one half of it on a normal night.
 *
 * There used to be two engines, and the one the scheduler ran unattended was the retired taxonomy
 * classifier — a Gemini call per batch that picked a leaf of the approved tree and applied it
 * through an ADDITIVE modify. It was mis-filing live mail. What is left orchestrates the facet
 * pipeline and owns nothing about how a message is classified or where it ends up.
 *
 * Filing is now opt-in and off by default: the PWA builds its folders from `message_facets`, so
 * mail classified tonight is in its folder tonight without a single `messages.modify`.
 */
describe('an unattended run', () => {
  it('refreshes the mailbox and classifies it, and writes nothing to Gmail', async () => {
    await service().run('user-1');

    expect(mocks.incrementalSync).toHaveBeenCalledWith('user-1');
    expect(mocks.classifyAccount).toHaveBeenCalledWith('account-1');
    expect(mocks.fileAccount).not.toHaveBeenCalled();
    expect(mocks.incrementalSync.mock.invocationCallOrder[0]!).toBeLessThan(
      mocks.classifyAccount.mock.invocationCallOrder[0]!,
    );
  });

  /**
   * One run, one row. Nothing else records what classification spent: `status().usageToday` sums
   * these columns across today's runs, and the classifier's own daily cap reads the same sum. Left
   * unwritten they would blank the usage panel AND hand every run of the day a full allowance.
   *
   * Filing used to open that row. With filing off there is nobody left to open it, so a
   * classification-only run opens its own and closes it in the same breath.
   */
  it('opens a run row of its own and records what classification spent onto it', async () => {
    const result = await service().run('user-1');

    expect(mocks.runCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ connected_google_account_id: 'account-1' }),
      }),
    );
    expect(mocks.runUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'classification-run-1' },
        data: expect.objectContaining({
          provider_call_count: 1,
          input_tokens: 120,
          output_tokens: 40,
          estimated_cost_microusd: 2000,
          ai_classified_count: 6,
          pattern_reused_count: 4,
          // Nobody else will close it, so the classification-only path closes it itself.
          status: 'COMPLETED',
          messages_seen: 10,
        }),
      }),
    );
    expect(result.runId).toBe('classification-run-1');
  });

  /**
   * A screen that has rendered "0 filed" every night reads correctly; a missing key renders
   * nothing at all. So the filing counters are zero on a run that did not file, not absent.
   */
  it('reports the filing counters as zero rather than leaving them out', async () => {
    const result = await service().run('user-1');

    expect(result).toMatchObject({ success: true, status: 'COMPLETED' });
    expect(result.counters).toMatchObject({
      messagesSeen: 10,
      messagesClassified: 10,
      ruleDecided: 4,
      modelDecided: 6,
      messagesLabeled: 0,
      labelsCreated: 0,
      staleLabelsRemoved: 0,
      providerCalls: 1,
    });
  });

  // Each facet service takes the same account-scoped lease itself, so a run holding one while it
  // called them would deadlock against its own halves.
  it('holds no lease of its own while the facet services run', async () => {
    await service().run('user-1');

    const leaseWrites = mocks.stateUpsert.mock.calls.filter(
      ([query]) => query.update?.lease_token !== undefined,
    );
    expect(leaseWrites).toEqual([]);
  });

  it('stops before touching Gemini or Gmail when automation is disabled', async () => {
    env.AUTOMATION_ENABLED = false;

    await expect(service().run('user-1')).rejects.toMatchObject({ code: 'AUTOMATION_DISABLED' });
    expect(mocks.classifyAccount).not.toHaveBeenCalled();
    expect(mocks.fileAccount).not.toHaveBeenCalled();
  });
});

/** The export path: someone who does want the folders mirrored into Gmail's own sidebar. */
describe('a run with Gmail writing turned on', () => {
  beforeEach(() => {
    env.GMAIL_WRITE_ENABLED = true;
  });

  it('refreshes the mailbox, classifies into facets, then files, in that order', async () => {
    await service().run('user-1');

    expect(mocks.fileAccount).toHaveBeenCalledWith('account-1', 'user-1');
    expect(mocks.classifyAccount.mock.invocationCallOrder[0]!).toBeLessThan(
      mocks.fileAccount.mock.invocationCallOrder[0]!,
    );
  });

  it('reports both halves of the run under one set of counters', async () => {
    const result = await service().run('user-1');

    expect(result).toMatchObject({ success: true, status: 'COMPLETED' });
    expect(result.counters).toMatchObject({
      messagesClassified: 10,
      messagesLabeled: 8,
      reviewRequired: 1,
      noLabelSkipped: 1,
      staleLabelsRemoved: 1,
    });
  });

  /**
   * Filing spends no tokens and makes no model call — the classification is already stored. So a
   * run that ran out of Gemini budget half way still has mail worth putting into folders tonight,
   * and holding it back until tomorrow would buy nothing.
   */
  it('files what was classified even when classification stopped early', async () => {
    mocks.classifyAccount.mockResolvedValue(
      classified({ stoppedReason: 'DAILY_BUDGET_REACHED', modelDecided: 2 }),
    );

    const result = await service().run('user-1');

    expect(mocks.fileAccount).toHaveBeenCalled();
    expect(result).toMatchObject({ status: 'PARTIAL', stoppedReason: 'DAILY_BUDGET_REACHED' });
  });

  // Filing already opened a row, so nothing opens a second one for the same run.
  it('records what classification spent onto the run row filing opened', async () => {
    const result = await service().run('user-1');

    expect(mocks.runCreate).not.toHaveBeenCalled();
    expect(mocks.runUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'automation-run-1' },
        data: expect.objectContaining({
          provider_call_count: 1,
          input_tokens: 120,
          ai_classified_count: 6,
          pattern_reused_count: 4,
        }),
      }),
    );
    expect(result.runId).toBe('automation-run-1');
  });

  it('surfaces a filing failure rather than reporting a run that did not happen', async () => {
    mocks.fileAccount.mockRejectedValue(new Error('nowhere to file'));

    await expect(service().run('user-1')).rejects.toThrow();
    // The schedule is still stamped, or the account would never become eligible again.
    expect(mocks.stateUpsert).toHaveBeenCalled();
  });
});

describe('accepting a run over HTTP', () => {
  beforeEach(() => {
    mocks.activityStart.mockResolvedValue({
      runId: 'activity-run-1',
      state: 'RUNNING',
      kind: 'AUTOMATION_FILING',
      startedAt: '2026-08-25T00:00:00.000Z',
      alreadyRunning: false,
    });
  });

  // 202 means accepted, not finished: the work is detached and the caller polls the run id.
  it('accepts a filing run without waiting for it and hands back a run id', async () => {
    await expect(service().start('user-1')).resolves.toMatchObject({
      runId: 'activity-run-1',
      state: 'RUNNING',
    });

    expect(mocks.activityRunDetached).toHaveBeenCalledWith('activity-run-1', expect.any(Function));
    // Nothing classified inside the request itself.
    expect(mocks.classifyAccount).not.toHaveBeenCalled();
  });

  // A precondition the caller can act on still answers synchronously, not through a run record.
  it('refuses to accept a run when no folder exists to file into', async () => {
    env.GMAIL_WRITE_ENABLED = true;
    mocks.userLabelCount.mockResolvedValue(0);

    await expect(service().start('user-1')).rejects.toMatchObject({
      code: 'AUTOMATION_NO_APPROVED_LABELS',
      statusCode: 409,
    });
    expect(mocks.activityStart).not.toHaveBeenCalled();
  });

  /**
   * "Somewhere to file into" is a precondition of filing and of nothing else. With the export off
   * a run classifies and stops, and folders are computed from `message_facets` — so requiring a
   * `user_labels` row would refuse every run on an account that never mirrored into Gmail, which
   * is now the default account.
   */
  it('accepts a classification-only run on an account with no folder rows at all', async () => {
    mocks.userLabelCount.mockResolvedValue(0);

    await expect(service().start('user-1')).resolves.toMatchObject({ runId: 'activity-run-1' });
  });

  it('does not start a second filing run while one is in flight', async () => {
    mocks.activityStart.mockResolvedValue({
      runId: 'activity-run-1',
      state: 'RUNNING',
      kind: 'AUTOMATION_FILING',
      startedAt: '2026-08-25T00:00:00.000Z',
      alreadyRunning: true,
    });

    await expect(service().start('user-1')).resolves.toMatchObject({ alreadyRunning: true });
    expect(mocks.activityRunDetached).not.toHaveBeenCalled();
  });
});

describe('the gap report', () => {
  it('clusters what it could not file into candidate folders without creating any', async () => {
    // A no-fit rate is only actionable if you can see what is inside it. Four unrelated billing
    // senders are invisible one message at a time and obvious once grouped.
    mocks.actionFindMany.mockResolvedValue([
      ...['cloudflare.com', 'microsoft.com', 'anthropic.com', 'substack.com'].map(
        (domain, index) => ({
          id: `action-${index}`,
          message: { subject: 'Your invoice is available', sender_email: `billing@${domain}` },
        }),
      ),
      ...Array.from({ length: 4 }, (_, index) => ({
        id: `action-noise-${index}`,
        message: { subject: `Unrelated thing ${index}`, sender_email: `x@spread${index}.com` },
      })),
    ]);

    const report = await service().gapReport('user-1');

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
  });

  it('leaves noise out of the gap report rather than proposing a folder for it', async () => {
    mocks.actionFindMany.mockResolvedValue([
      { id: 'a', message: { subject: 'One off thing', sender_email: 'a@one.com' } },
      { id: 'b', message: { subject: 'Another matter', sender_email: 'b@two.com' } },
    ]);

    const report = await service().gapReport('user-1');

    expect(report.analyzedCount).toBe(2);
    expect(report.clusters).toEqual([]);
    expect(report.clusteredCount).toBe(0);
  });
});

describe('review approvals', () => {
  const reviewable = {
    id: 'action-1',
    connected_google_account_id: 'account-1',
    gmail_message_id: 'row-1',
    status: 'REVIEW_REQUIRED',
    message: {
      gmail_message_id: 'gmail-1',
      // Already filed under the previous tree, plus one label of the user's own.
      label_ids: ['Label_old', 'Label_personal'],
      sender_email: 'billing@netflix.com',
      subject: 'Payment failed',
    },
  };

  beforeEach(() => {
    mocks.actionFindFirst.mockResolvedValue(reviewable);
    mocks.gmailLabelFindMany.mockResolvedValue([{ gmail_label_id: 'Label_old' }]);
    mocks.actionUpdate.mockResolvedValue({});
    mocks.messageUpdate.mockResolvedValue({});
    // Mirroring a reviewer's decision into Gmail is the export half, so these exercise it on.
    env.GMAIL_WRITE_ENABLED = true;
    mocks.userLabelFindFirst.mockResolvedValue({
      ...approvedLabel,
      full_path: 'MailMind/Invoices',
    });
  });

  /**
   * Card 31. `automation.service.approve` reached Gmail with no GMAIL_WRITE_ENABLED check, so a
   * reviewer clicking Approve wrote a label while writes were nominally off — the scope check
   * passed, because a mailbox connected before the downgrade still holds gmail.modify.
   *
   * With the export off a decision is a fact in MailMind and nothing else. Refusing instead would
   * strand the review queue behind a setting that has nothing to do with reviewing.
   */
  it('records a reviewer decision without touching the mailbox when the export is off', async () => {
    env.GMAIL_WRITE_ENABLED = false;
    const gmail = gmailStub();

    await service(gmail).approve('user-1', 'action-1', 'MailMind/Invoices');

    expect(gmail.ensureLabel).not.toHaveBeenCalled();
    expect(gmail.applyExclusiveLabel).not.toHaveBeenCalled();
    // The decision is still recorded, and honestly: no Gmail label was involved, so none is named.
    expect(mocks.actionUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'APPLIED', source: 'USER', gmail_label_id: null }),
      }),
    );
    /*
     * The one thing that must never happen: `label_ids` mirrors what Gmail actually holds, so
     * recording a label nobody applied would leave the database describing a mailbox that
     * disagrees with it.
     */
    expect(mocks.messageUpdate).not.toHaveBeenCalled();
  });

  it('moves the message rather than adding a second MailMind label', async () => {
    const gmail = gmailStub();
    mocks.userLabelFindFirst.mockResolvedValue({
      ...approvedLabel,
      full_path: 'MailMind/Invoices',
    });

    await service(gmail).approve('user-1', 'action-1', 'MailMind/Invoices');

    expect(gmail.applyLabel).not.toHaveBeenCalled();
    // The old MailMind label comes off in the same call the new one goes on; the user's own
    // label is not MailMind's to touch.
    expect(gmail.applyExclusiveLabel).toHaveBeenCalledWith('account-1', 'gmail-1', 'Label_1', [
      'Label_old',
    ]);
    expect(mocks.messageUpdate.mock.calls[0]![0].data.label_ids).toEqual([
      'Label_personal',
      'Label_1',
    ]);
  });

  it('refuses a bare folder name that several folders share', async () => {
    mocks.userLabelFindFirst.mockResolvedValue(null);
    mocks.userLabelFindMany.mockResolvedValue([
      { ...approvedLabel, full_path: 'MailMind/Netflix/Payment failed' },
      { ...approvedLabel, full_path: 'MailMind/Coursera/Payment failed' },
    ]);

    // A pivot repeats its lower levels, so the name alone cannot say which folder is meant.
    await expect(service().approve('user-1', 'action-1', 'Payment failed')).rejects.toMatchObject({
      code: 'AUTOMATION_VALIDATION_FAILED',
    });
  });
});
