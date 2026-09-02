import { randomUUID } from 'node:crypto';
import cookieParser from 'cookie-parser';
import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { env } from '../src/config/env.js';

/**
 * Exercises propose -> confirm end to end against an in-memory repository so the real service,
 * controller, routes and normalization run. Only Gmail, the planner's model call, the session and
 * the audit log are faked.
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
// The run record has its own suite; here it must only stay off the database.
vi.mock('../src/features/activity/activity.service.js', async () => {
  const actual = await vi.importActual<
    typeof import('../src/features/activity/activity.service.js')
  >('../src/features/activity/activity.service.js');
  return {
    ...actual,
    activityService: {
      start: () =>
        Promise.resolve({
          runId: '00000000-0000-4000-8000-0000000000ff',
          state: 'RUNNING',
          kind: 'LABEL_PROPOSAL',
          startedAt: '2026-08-20T00:00:00.000Z',
          alreadyRunning: false,
        }),
      finishRun: () => Promise.resolve(),
    },
  };
});

import type { user_label_source, user_labels } from '@prisma/client';

import type { LabelsRepository } from '../src/features/labels/labels.repository.js';
import { labelPathFor } from '../src/features/labels/labels.repository.js';
import { labelsRouter } from '../src/features/labels/labels.routes.js';
import { errorHandler } from '../src/middleware/errorHandler.js';
import { LabelsService } from '../src/features/labels/labels.service.js';
import {
  labelsAreSimilar,
  normalizeLabelForComparison,
} from '../src/features/label-discovery/label-normalization.js';
import {
  validateTaxonomyPlan,
  type PlannerMessage,
  type TaxonomyPlan,
  type TaxonomyPlanner,
} from '../src/features/label-discovery/taxonomy-planner.js';

const ACCOUNT_ID = 'account-1';
const USER_ID = 'user-1';

interface StoredNode {
  id: string;
  parent_id: string | null;
  depth: number;
  kind: string;
  name: string;
  full_path: string;
  normalized_name: string;
  rationale: string;
  estimated_message_count: number;
  matched_message_count: number;
  is_leaf: boolean;
  rules: Array<{ rule_kind: string; match_value: string; matched_message_count: number }>;
}

interface StoredPlan {
  id: string;
  status: 'PENDING' | 'APPROVED' | 'SUPERSEDED';
  model: string;
  prompt_version: string;
  sampled_message_count: number;
  analyzed_message_count: number;
  leaf_count: number;
  warnings: string[];
  created_at: Date;
  nodes: StoredNode[];
}

/** Minimal stand-in for the Prisma-backed repository: real data, no database. */
class InMemoryLabelsRepository {
  labels: user_labels[] = [];
  plans: StoredPlan[] = [];
  rules: Array<{ kind: string; value: string; labelId: string; labelName: string }> = [];
  messages: Array<{
    id: string;
    internal_date: Date | null;
    subject: string | null;
    sender_name: string | null;
    sender_email: string | null;
  }> = [];
  gmailLabelNames: string[] = [];
  private sequence = 0;

  /** Ids are real uuids because the controller validates them before the service sees them. */
  private next(_prefix: string): string {
    this.sequence += 1;
    return randomUUID();
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

  pendingPlan() {
    return Promise.resolve(this.plans.find((plan) => plan.status === 'PENDING') ?? null);
  }

  planForAccount(_accountId: string, planId: string) {
    return Promise.resolve(this.plans.find((plan) => plan.id === planId) ?? null);
  }

  storePlan(_accountId: string, plan: TaxonomyPlan) {
    for (const stored of this.plans) {
      if (stored.status === 'PENDING') stored.status = 'SUPERSEDED';
    }
    const idByPath = new Map<string, string>();
    const nodes: StoredNode[] = plan.nodes.map((node) => {
      const id = this.next('node');
      idByPath.set(node.path, id);
      return {
        id,
        parent_id: node.parentPath ? (idByPath.get(node.parentPath) ?? null) : null,
        depth: node.depth,
        kind: node.kind,
        name: node.name,
        full_path: `MailMind/${node.path}`,
        normalized_name: node.normalizedName,
        rationale: node.rationale,
        estimated_message_count: node.estimatedMessageCount,
        matched_message_count: node.matchedMessageCount,
        is_leaf: node.isLeaf,
        rules: node.rules.map((rule) => ({
          rule_kind: rule.kind,
          match_value: rule.value,
          matched_message_count: rule.matchedMessageCount,
        })),
      };
    });
    const stored: StoredPlan = {
      id: this.next('plan'),
      status: 'PENDING',
      model: plan.model,
      prompt_version: plan.promptVersion,
      sampled_message_count: plan.sampledMessageCount,
      analyzed_message_count: plan.analyzedMessageCount,
      leaf_count: nodes.filter((node) => node.is_leaf).length,
      warnings: plan.warnings,
      created_at: new Date('2026-08-20T00:00:00.000Z'),
      nodes,
    };
    this.plans.push(stored);
    return Promise.resolve(stored.id);
  }

  markPlanApproved(planId: string) {
    const plan = this.plans.find((stored) => stored.id === planId);
    if (plan) plan.status = 'APPROVED';
    return Promise.resolve();
  }

  createLabel(input: {
    accountId: string;
    name: string;
    treePath: string;
    depth: number;
    parentId: string | null;
    source: user_label_source;
    rationale?: string | null;
  }) {
    const row = {
      id: this.next('label'),
      connected_google_account_id: input.accountId,
      parent_id: input.parentId,
      depth: input.depth,
      leaf_name: input.name,
      full_path: labelPathFor(input.treePath),
      normalized_name: normalizeLabelForComparison(input.name),
      rationale: input.rationale ?? null,
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

  descendantsOf(label: user_labels) {
    return Promise.resolve(
      this.labels.filter((row) => row.full_path.startsWith(`${label.full_path}/`)),
    );
  }

  replacePlannerRules(
    _accountId: string,
    rules: Array<{ kind: string; value: string; labelId: string; labelName: string }>,
  ) {
    this.rules = [...rules];
    return Promise.resolve(rules.length);
  }
}

/** A planner that returns a fixed tree through the real validator, so no model call happens. */
function stubPlanner(nodes: Array<Record<string, unknown>>): TaxonomyPlanner {
  return {
    plan: ({ messages, existingGmailLabelNames }) => {
      const sample = messages as PlannerMessage[];
      const validated = validateTaxonomyPlan({ nodes }, { sample, existingGmailLabelNames });
      return Promise.resolve({
        ...validated,
        sampledMessageCount: sample.length,
        analyzedMessageCount: sample.length,
        model: 'stub-model',
        promptVersion: 'stub-v1',
        usage: { inputTokens: 100, cachedInputTokens: 0, outputTokens: 50 },
        estimatedCostMicrousd: 155,
      });
    },
  };
}

const JOB_HUNT_TREE = [
  {
    name: 'Job hunt',
    depth: 1,
    parentPath: '',
    kind: 'CATEGORY',
    rationale: 'Job search mail arrives from boards, tracking systems and recruiters alike.',
    estimatedMessageCount: 40,
    rules: [],
  },
  {
    name: 'Applications sent',
    depth: 2,
    parentPath: 'Job hunt',
    kind: 'TOPIC',
    rationale: 'Confirmations that an application reached a company.',
    estimatedMessageCount: 25,
    rules: [
      { kind: 'SENDER_DOMAIN', value: 'linkedin.com' },
      { kind: 'SENDER_DOMAIN', value: 'greenhouse.io' },
    ],
  },
  {
    name: 'Applications rejected',
    depth: 3,
    parentPath: 'Job hunt/Applications sent',
    kind: 'STATE',
    rationale: 'Rejections say so in the subject line.',
    estimatedMessageCount: 8,
    rules: [{ kind: 'SUBJECT_CONTAINS', value: 'not moving forward' }],
  },
];

function seedMail(repository: InMemoryLabelsRepository) {
  const senders = [
    { email: 'jobs-noreply@linkedin.com', name: 'LinkedIn', subject: 'Your application was sent' },
    { email: 'no-reply@greenhouse.io', name: 'Greenhouse', subject: 'Application received' },
    {
      email: 'notifications@jobright.ai',
      name: 'Jobright',
      subject: 'Update: not moving forward',
    },
  ];
  repository.messages = senders.flatMap((sender, senderIndex) =>
    Array.from({ length: 6 }, (_, index) => ({
      id: `message-${senderIndex}-${index}`,
      internal_date: new Date(Date.parse('2026-08-01T00:00:00.000Z') - index * 3_600_000),
      subject: `${sender.subject} ${index}`,
      sender_name: sender.name,
      sender_email: sender.email,
    })),
  );
}

function build(nodes: Array<Record<string, unknown>> = JOB_HUNT_TREE) {
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
    stubPlanner(nodes),
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

describe('labels propose -> confirm', () => {
  beforeEach(() => {
    mocks.auditRecord.mockReset();
    mocks.auditRecord.mockResolvedValue(undefined);
    // Mirroring the approved tree into Gmail is the export half; these exercise it on.
    env.GMAIL_WRITE_ENABLED = true;
  });

  it('proposes a tree with counts and creates nothing in Gmail', async () => {
    const { repository, gmail, service } = build();
    seedMail(repository);

    const overview = await service.propose(USER_ID);

    expect(gmail.ensureLabel).not.toHaveBeenCalled();
    expect(repository.labels).toHaveLength(0);
    expect(overview.plan?.nodes.map((node) => node.path)).toEqual([
      'Job hunt',
      'Job hunt/Applications sent',
      'Job hunt/Applications sent/Applications rejected',
    ]);
    const sent = overview.plan?.nodes.find((node) => node.name === 'Applications sent');
    expect(sent?.matchedMessageCount).toBe(12);
    expect(sent?.rules.map((rule) => rule.value)).toEqual(['greenhouse.io', 'linkedin.com']);
    // A parent shows what its whole subtree would receive.
    expect(overview.plan?.nodes[0]?.rolledUpMessageCount).toBe(18);
  });

  it('creates only the leaf in Gmail but keeps the whole chain in the database', async () => {
    const { repository, gmail, service } = build();
    seedMail(repository);
    const proposed = await service.propose(USER_ID);

    const confirmed = await service.approvePlan(USER_ID, { planId: proposed.plan!.id });

    expect(repository.labels.map((label) => label.full_path)).toEqual([
      'MailMind/Job hunt',
      'MailMind/Job hunt/Applications sent',
      'MailMind/Job hunt/Applications sent/Applications rejected',
    ]);
    // Gmail nesting is cosmetic, so only the leaf's full path becomes a Gmail label.
    expect(gmail.ensureLabel).toHaveBeenCalledTimes(1);
    expect(gmail.ensureLabel).toHaveBeenCalledWith(
      ACCOUNT_ID,
      'MailMind/Job hunt/Applications sent/Applications rejected',
    );
    expect(confirmed.labels.filter((label) => label.isLeaf)).toHaveLength(1);
    expect(repository.plans[0]?.status).toBe('APPROVED');
  });

  it('persists the planrules so automation can file mail without a model call', async () => {
    const { repository, service } = build();
    seedMail(repository);
    const proposed = await service.propose(USER_ID);

    await service.approvePlan(USER_ID, { planId: proposed.plan!.id });

    expect(repository.rules.map((rule) => `${rule.kind}:${rule.value}`).sort()).toEqual([
      'SENDER_DOMAIN:greenhouse.io',
      'SENDER_DOMAIN:linkedin.com',
      'SUBJECT_CONTAINS:not moving forward',
    ]);
    expect(new Set(repository.rules.map((rule) => rule.labelName))).toEqual(
      new Set(['Applications sent', 'Applications rejected']),
    );
  });

  it('approves a subset together with the ancestors it needs', async () => {
    const { repository, service } = build();
    seedMail(repository);
    const proposed = await service.propose(USER_ID);
    const leaf = proposed.plan!.nodes.find((node) => node.name === 'Applications rejected')!;

    await service.approvePlan(USER_ID, { planId: proposed.plan!.id, nodeIds: [leaf.id] });

    expect(repository.labels.map((label) => label.leaf_name)).toEqual([
      'Job hunt',
      'Applications sent',
      'Applications rejected',
    ]);
  });

  it('refuses to approve the same plan twice', async () => {
    const { service, repository } = build();
    seedMail(repository);
    const proposed = await service.propose(USER_ID);
    await service.approvePlan(USER_ID, { planId: proposed.plan!.id });

    await expect(service.approvePlan(USER_ID, { planId: proposed.plan!.id })).rejects.toMatchObject(
      { code: 'LABEL_PLAN_NOT_PENDING', statusCode: 409 },
    );
  });

  it('supersedes an earlier proposal instead of stacking two pending plans', async () => {
    const { repository, service } = build();
    seedMail(repository);

    await service.propose(USER_ID);
    await service.propose(USER_ID);

    expect(repository.plans).toHaveLength(2);
    expect(repository.plans.filter((plan) => plan.status === 'PENDING')).toHaveLength(1);
  });

  it('does not treat any pair in the proposed tree as too similar', async () => {
    const { repository, service } = build();
    seedMail(repository);
    const proposed = await service.propose(USER_ID);

    const names = proposed.plan!.nodes.map((node) => node.name);
    const rejected: string[] = [];
    for (let index = 0; index < names.length; index += 1) {
      for (let other = index + 1; other < names.length; other += 1) {
        if (labelsAreSimilar(names[index]!, names[other]!)) {
          rejected.push(`${names[index]} <-> ${names[other]}`);
        }
      }
    }
    expect(rejected).toEqual([]);
  });
});

describe('POST /api/labels/confirm over HTTP', () => {
  beforeEach(() => {
    mocks.auditRecord.mockReset();
    mocks.auditRecord.mockResolvedValue(undefined);
    // Mirroring the approved tree into Gmail is the export half; these exercise it on.
    env.GMAIL_WRITE_ENABLED = true;
    mocks.authenticate.mockReset();
    mocks.authenticate.mockResolvedValue({ user: { id: USER_ID }, session: { id: 'session-1' } });
  });

  it('accepts a plan approval and persists the tree', async () => {
    const { repository, service } = build();
    seedMail(repository);
    const proposed = await service.propose(USER_ID);

    const response = await request(httpApp())
      .post('/api/labels/confirm')
      .set('Origin', ORIGIN)
      .send({ planId: proposed.plan!.id });

    expect(response.status).toBe(200);
    expect(repository.labels).toHaveLength(3);
    expect(repository.labels.at(-1)?.gmail_label_id).toEqual(expect.stringMatching(/^Label_/));
  });

  it('accepts manual labels and reports the failing name when one is rejected', async () => {
    const { repository } = build();

    const created = await request(httpApp())
      .post('/api/labels/confirm')
      .set('Origin', ORIGIN)
      .send({ labels: [{ leafName: 'Money in', source: 'USER_CREATED' }] });
    expect(created.status).toBe(200);
    expect(repository.labels).toHaveLength(1);

    const rejected = await request(httpApp())
      .post('/api/labels/confirm')
      .set('Origin', ORIGIN)
      .send({ labels: [{ leafName: 'Notifications', source: 'AI_PROPOSED' }] });

    expect(rejected.status).toBe(400);
    expect(rejected.body.error.code).toBe('LABEL_NAME_INVALID');
    expect(rejected.body.error.message).toContain('Notifications');
    expect(repository.labels).toHaveLength(1);
  });

  it('rejects a payload that is neither a plan approval nor a label list', async () => {
    build();

    const response = await request(httpApp())
      .post('/api/labels/confirm')
      .set('Origin', ORIGIN)
      .send({ planId: 'not-a-uuid' });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('LABEL_VALIDATION_FAILED');
  });
});
