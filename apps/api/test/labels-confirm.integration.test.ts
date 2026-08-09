import cookieParser from 'cookie-parser';
import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Exercises propose -> confirm end to end against an in-memory repository so the real
 * service, controller, routes and normalization run. Only Gmail, the session and the
 * audit log are faked.
 */

const { mocks, forwardTo } = vi.hoisted(() => {
  const holders = {
    auditRecord: vi.fn(),
    authenticate: vi.fn(),
    // Filled in by build(); the HTTP suite drives the module-level singleton service.
    repository: { current: null as Record<string, unknown> | null },
    gmail: { current: null as Record<string, unknown> | null },
  };
  /** Late-binds the module singletons to whichever fake the current test built. */
  const forward = (holder: { current: Record<string, unknown> | null }) =>
    new Proxy(
      {},
      {
        get(_target, property: string) {
          const current = holder.current;
          if (!current) throw new Error('no fake bound for this test');
          const value = current[property];
          return typeof value === 'function' ? value.bind(current) : value;
        },
      },
    );
  return { mocks: holders, forwardTo: forward };
});

vi.mock('../src/audit/audit.service.js', () => ({
  auditService: { record: mocks.auditRecord },
}));
vi.mock('../src/config/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
  safeErrorDetails: () => ({}),
}));
vi.mock('../src/sessions/session.service.js', () => ({
  sessionService: { authenticate: mocks.authenticate },
}));
vi.mock('../src/middleware/rateLimiters.js', () => {
  const passthrough = (_request: unknown, _response: unknown, next: () => void) => next();
  return { labelsReadLimiter: passthrough, labelsMutationLimiter: passthrough };
});
vi.mock('../src/features/labels/labels.repository.js', async () => {
  const actual = await vi.importActual<
    typeof import('../src/features/labels/labels.repository.js')
  >('../src/features/labels/labels.repository.js');
  return {
    ...actual,
    labelsRepository: forwardTo(mocks.repository),
  };
});
vi.mock('../src/features/automation/automation-gmail.service.js', () => ({
  automationGmailService: forwardTo(mocks.gmail),
}));

import type { user_label_source, user_labels } from '@prisma/client';

import type { LabelsRepository } from '../src/features/labels/labels.repository.js';
import { labelPathFor } from '../src/features/labels/labels.repository.js';
import { labelsRouter } from '../src/features/labels/labels.routes.js';
import { errorHandler } from '../src/middleware/errorHandler.js';
import { LabelsService } from '../src/features/labels/labels.service.js';
import { discoverDeterministicCandidates } from '../src/features/label-discovery/label-discovery.engine.js';
import { LABEL_CANDIDATE_TYPES } from '../src/features/label-discovery/label-discovery.taxonomy.js';
import type {
  CandidateGroup,
  DiscoveryMessage,
  DiscoveryPreferences,
} from '../src/features/label-discovery/label-discovery.types.js';
import {
  labelsAreSimilar,
  normalizeLabelForComparison,
} from '../src/features/label-discovery/label-normalization.js';

const ACCOUNT_ID = 'account-1';
const USER_ID = 'user-1';

interface StoredProposal {
  id: string;
  suggested_leaf_name: string;
  suggested_full_path: string;
  normalized_name: string;
  status: 'PENDING' | 'CREATED' | 'REJECTED' | 'SUPERSEDED';
  confidence: number;
  message_count: number;
  reason_codes: string[];
}

/** Minimal stand-in for the Prisma-backed repository: real data, no database. */
class InMemoryLabelsRepository {
  labels: user_labels[] = [];
  proposals: StoredProposal[] = [];
  messages: Parameters<InMemoryLabelsRepository['seedMessages']>[0] = [];
  gmailLabelNames: string[] = [];
  private sequence = 0;

  seedMessages(
    messages: {
      id: string;
      gmail_thread_id: string | null;
      internal_date: Date | null;
      subject: string | null;
      sender_name: string | null;
      sender_email: string | null;
      label_ids: string[];
    }[],
  ) {
    this.messages = messages;
  }

  seedProposals(leafNames: string[]) {
    this.proposals = leafNames.map((leafName, index) => ({
      id: `proposal-${index}`,
      suggested_leaf_name: leafName,
      suggested_full_path: labelPathFor(leafName),
      normalized_name: normalizeLabelForComparison(leafName),
      status: 'PENDING' as const,
      confidence: 0.8,
      message_count: 12,
      reason_codes: ['SOURCE_VOLUME'],
    }));
  }

  activeAccountForUser() {
    return Promise.resolve({ id: ACCOUNT_ID, user_id: USER_ID });
  }

  acquireProposalLease() {
    return Promise.resolve({ accountId: ACCOUNT_ID, token: 'lease-token' });
  }

  releaseProposalLease() {
    return Promise.resolve();
  }

  eligibleMessages() {
    return Promise.resolve(this.messages);
  }

  existingGmailLabelNames() {
    return Promise.resolve(this.gmailLabelNames);
  }

  approvedLabels() {
    return Promise.resolve([...this.labels]);
  }

  pendingProposals() {
    return Promise.resolve(this.proposals.filter((proposal) => proposal.status === 'PENDING'));
  }

  clearPendingProposals() {
    for (const proposal of this.proposals) {
      if (proposal.status === 'PENDING') proposal.status = 'SUPERSEDED';
    }
    return Promise.resolve();
  }

  storeProposal(_accountId: string, group: CandidateGroup, leafName: string) {
    this.sequence += 1;
    this.proposals.push({
      id: `proposal-${this.sequence}`,
      suggested_leaf_name: leafName,
      suggested_full_path: labelPathFor(leafName),
      normalized_name: normalizeLabelForComparison(leafName),
      status: 'PENDING',
      confidence: group.confidence,
      message_count: group.messageCount,
      reason_codes: group.reasonCodes,
    });
    return Promise.resolve();
  }

  createLabel(input: { accountId: string; leafName: string; source: user_label_source }) {
    this.sequence += 1;
    const row = {
      id: `label-${this.sequence}`,
      connected_google_account_id: input.accountId,
      leaf_name: input.leafName,
      full_path: labelPathFor(input.leafName),
      normalized_name: normalizeLabelForComparison(input.leafName),
      source: input.source,
      gmail_label_id: null,
      created_at: new Date('2026-08-01T00:00:00.000Z'),
      updated_at: new Date('2026-08-01T00:00:00.000Z'),
    } as unknown as user_labels;
    this.labels.push(row);
    return Promise.resolve(row);
  }

  setGmailLabelId(id: string, gmailLabelId: string) {
    const row = this.labels.find((label) => label.id === id);
    if (!row) throw new Error(`unknown label ${id}`);
    row.gmail_label_id = gmailLabelId;
    return Promise.resolve(row);
  }

  markProposalsApproved(_accountId: string, leafNames: string[]) {
    const normalized = leafNames.map(normalizeLabelForComparison);
    for (const proposal of this.proposals) {
      if (proposal.status !== 'PENDING') continue;
      proposal.status = normalized.includes(proposal.normalized_name) ? 'CREATED' : 'REJECTED';
    }
    return Promise.resolve();
  }
}

function build() {
  const repository = new InMemoryLabelsRepository();
  const gmail = {
    ensureLabel: vi.fn(async (_accountId: string, labelPath: string) => ({
      id: `Label_${labelPath.replace(/\W+/g, '_')}`,
      created: true,
    })),
    applyLabel: vi.fn(),
    renameLabel: vi.fn(),
  };
  const service = new LabelsService(
    repository as unknown as LabelsRepository,
    gmail as unknown as ConstructorParameters<typeof LabelsService>[1],
  );
  // Also bind the module singletons so the HTTP suite hits the same fakes.
  mocks.repository.current = repository as unknown as Record<string, unknown>;
  mocks.gmail.current = gmail as unknown as Record<string, unknown>;
  return { repository, gmail, service };
}

const ORIGIN = 'http://localhost:5173';

function httpApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use((incoming, _response, next) => {
    incoming.requestId = 'request-id';
    next();
  });
  app.use('/api/labels', labelsRouter);
  app.use(errorHandler);
  return app;
}

const REALISTIC_PROPOSALS = [
  'Finance',
  'Job applications',
  'Dev tools',
  'Verification codes',
  'School',
];

describe('labels propose -> confirm', () => {
  beforeEach(() => {
    mocks.auditRecord.mockReset();
    mocks.auditRecord.mockResolvedValue(undefined);
  });

  it('writes a user_labels row with a gmail_label_id for every seeded proposal', async () => {
    const { repository, gmail, service } = build();
    repository.seedProposals(REALISTIC_PROPOSALS);

    const overview = await service.confirm(
      USER_ID,
      REALISTIC_PROPOSALS.map((leafName) => ({ leafName, source: 'AI_PROPOSED' as const })),
    );

    expect(repository.labels).toHaveLength(REALISTIC_PROPOSALS.length);
    for (const leafName of REALISTIC_PROPOSALS) {
      const row = repository.labels.find((label) => label.leaf_name === leafName);
      expect(row, `${leafName} should have a user_labels row`).toBeDefined();
      expect(row?.full_path).toBe(`MailMind/${leafName}`);
      expect(row?.gmail_label_id, `${leafName} should carry a Gmail label id`).toEqual(
        expect.stringMatching(/^Label_/),
      );
    }
    expect(gmail.ensureLabel).toHaveBeenCalledTimes(REALISTIC_PROPOSALS.length);
    expect(overview.labels).toHaveLength(REALISTIC_PROPOSALS.length);
    expect(overview.proposals).toHaveLength(0);
    expect(repository.proposals.every((proposal) => proposal.status === 'CREATED')).toBe(true);
  });

  it('is idempotent: confirming the same set twice does not duplicate rows', async () => {
    const { repository, gmail, service } = build();
    repository.seedProposals(REALISTIC_PROPOSALS);
    const payload = REALISTIC_PROPOSALS.map((leafName) => ({
      leafName,
      source: 'AI_PROPOSED' as const,
    }));

    await service.confirm(USER_ID, payload);
    await service.confirm(USER_ID, payload);

    expect(repository.labels).toHaveLength(REALISTIC_PROPOSALS.length);
    expect(gmail.ensureLabel).toHaveBeenCalledTimes(REALISTIC_PROPOSALS.length);
  });

  it('proposes from synchronized metadata and confirms what it proposed', async () => {
    const { repository, service } = build();
    const now = Date.now();
    repository.seedMessages(
      Array.from({ length: 40 }, (_, index) => ({
        id: `message-${index}`,
        gmail_thread_id: `thread-${index}`,
        internal_date: new Date(now - index * 60 * 60 * 1000),
        subject: index % 2 === 0 ? `Invoice ${index} is ready` : `Your statement for July`,
        sender_name: 'Stripe',
        sender_email: 'receipts@stripe.com',
        label_ids: ['INBOX'],
      })),
    );

    const proposed = await service.propose(USER_ID);
    expect(proposed.proposals.length).toBeGreaterThan(0);

    const confirmed = await service.confirm(
      USER_ID,
      proposed.proposals.map((proposal) => ({
        leafName: proposal.leafName,
        source: 'AI_PROPOSED' as const,
      })),
    );
    expect(confirmed.labels.length).toBe(proposed.proposals.length);
    expect(confirmed.labels.every((label) => label.gmailLabelId !== null)).toBe(true);
  });

  it('does not treat any pair in a realistic proposal set as too similar', () => {
    const rejected: string[] = [];
    for (let index = 0; index < REALISTIC_PROPOSALS.length; index += 1) {
      for (let other = index + 1; other < REALISTIC_PROPOSALS.length; other += 1) {
        const left = REALISTIC_PROPOSALS[index]!;
        const right = REALISTIC_PROPOSALS[other]!;
        if (labelsAreSimilar(left, right)) rejected.push(`${left} <-> ${right}`);
      }
    }
    expect(rejected).toEqual([]);
  });
});

/**
 * Regression cover for the defect that kept user_labels empty: propose returned nothing,
 * so the web confirm button never enabled. Sender candidates must now be scored on their
 * live signals rather than on the retired category taxonomy.
 */
describe('label proposal discovery', () => {
  const SENDERS = [
    { name: 'Chase', email: 'alerts@chase.com', subject: 'Your statement is ready' },
    { name: 'GitHub', email: 'noreply@github.com', subject: 'New pull request opened' },
    { name: 'Greenhouse', email: 'no-reply@greenhouse.io', subject: 'Your application arrived' },
    { name: 'Coursera', email: 'no-reply@coursera.org', subject: 'Your course starts Monday' },
  ];

  function corpus(category: string | null): DiscoveryMessage[] {
    const now = Date.parse('2026-08-09T00:00:00.000Z');
    return SENDERS.flatMap((sender, senderIndex) =>
      Array.from({ length: 12 }, (_, index) => ({
        id: `m-${senderIndex}-${index}`,
        gmailThreadId: `t-${senderIndex}-${index}`,
        internalDate: new Date(now - index * 36 * 60 * 60 * 1000),
        subject: `${sender.subject} ${index}`,
        senderName: sender.name,
        senderEmail: sender.email,
        gmailLabels: ['INBOX'],
        category,
        correctedCategory: null,
      })),
    );
  }

  const preferences: DiscoveryPreferences = {
    minMessages: 3,
    lookbackDays: 90,
    maxCandidates: 25,
    allowedCandidateTypes: [...LABEL_CANDIDATE_TYPES],
    preferOrganizations: true,
    preferTopics: true,
  };
  const options = {
    minSourceAgreement: 0.7,
    minimumConfidence: 0.75,
    existingLabelNames: [] as string[],
  };

  it('discovers every sender even though propose passes category: null', () => {
    const result = discoverDeterministicCandidates(corpus(null), preferences, options);

    expect(result.rejectedByRules).toBe(0);
    expect(result.groups.map((group) => group.suggestedLeafName)).toEqual(
      expect.arrayContaining(['Chase', 'GitHub', 'Greenhouse', 'Coursera']),
    );
  });

  it('scores sender candidates identically whether or not a category is present', () => {
    // Categories still steer which topic regexes match, but they no longer move a score.
    const senderScores = (messages: DiscoveryMessage[]) =>
      Object.fromEntries(
        discoverDeterministicCandidates(messages, preferences, options)
          .groups.filter((group) => group.candidateType !== 'TOPIC')
          .map((group) => [group.suggestedLeafName, group.confidence] as const),
      );

    expect(senderScores(corpus(null))).toEqual(senderScores(corpus('WORK')));
  });

  it('keeps existing-label similarity live: the candidate is dropped outright', () => {
    // finishGroup treats it as a hard rejection, so the -0.18 confidence penalty never
    // decides anything on this path. Both are left as they are.
    const namesFor = (existingLabelNames: string[]) =>
      discoverDeterministicCandidates(corpus(null), preferences, {
        ...options,
        existingLabelNames,
      }).groups.map((group) => group.suggestedLeafName);

    expect(namesFor([])).toContain('GitHub');
    expect(namesFor(['GitHub'])).not.toContain('GitHub');
    expect(namesFor(['MailMind/Sources/GitHub'])).not.toContain('GitHub');
    expect(namesFor(['GitHub'])).toContain('Chase');
  });

  it('does not match a two-level MailMind path, which normalization never strips', () => {
    // normalizeLabelForComparison only strips MailMind/<namespace>/, but labelPathFor now
    // builds MailMind/<leaf>. Gmail labels stored in that shape escape the penalty.
    expect(labelsAreSimilar('MailMind/GitHub', 'GitHub')).toBe(false);
    expect(labelsAreSimilar('MailMind/Sources/GitHub', 'GitHub')).toBe(true);
  });
});

describe('POST /api/labels/confirm over HTTP', () => {
  beforeEach(() => {
    mocks.auditRecord.mockReset();
    mocks.auditRecord.mockResolvedValue(undefined);
    mocks.authenticate.mockReset();
    mocks.authenticate.mockResolvedValue({ user: { id: USER_ID }, session: { id: 'session-1' } });
  });

  it('accepts the payload the web client sends and persists the labels', async () => {
    const { repository } = build();
    repository.seedProposals(REALISTIC_PROPOSALS);

    const response = await request(httpApp())
      .post('/api/labels/confirm')
      .set('Origin', ORIGIN)
      .send({
        labels: REALISTIC_PROPOSALS.map((leafName) => ({ leafName, source: 'AI_PROPOSED' })),
      });

    expect(response.status).toBe(200);
    expect(repository.labels).toHaveLength(REALISTIC_PROPOSALS.length);
    expect(repository.labels.every((label) => label.gmail_label_id !== null)).toBe(true);
  });

  it('reports the failing label name when a name is rejected', async () => {
    const { repository } = build();
    repository.seedProposals(REALISTIC_PROPOSALS);

    const response = await request(httpApp())
      .post('/api/labels/confirm')
      .set('Origin', ORIGIN)
      .send({ labels: [{ leafName: 'Notifications', source: 'AI_PROPOSED' }] });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('LABEL_NAME_INVALID');
    expect(response.body.error.message).toContain('Notifications');
    expect(repository.labels).toHaveLength(0);
  });
});
