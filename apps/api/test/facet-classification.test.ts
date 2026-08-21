import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  stateUpsert: vi.fn(),
  stateUpdateMany: vi.fn(),
  messageFindMany: vi.fn(),
  patternFindMany: vi.fn(),
  patternFindUnique: vi.fn(),
  patternUpsert: vi.fn(),
  patternUpdate: vi.fn(),
  patternUpdateMany: vi.fn(),
  facetUpsert: vi.fn(),
  classify: vi.fn(),
}));

vi.mock('../src/config/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
  safeErrorDetails: () => ({}),
}));

vi.mock('../src/database/prisma.js', () => ({
  prisma: {
    automation_states: { upsert: mocks.stateUpsert, updateMany: mocks.stateUpdateMany },
    gmail_message_metadata: { findMany: mocks.messageFindMany },
    learned_classification_patterns: {
      findMany: mocks.patternFindMany,
      findUnique: mocks.patternFindUnique,
      upsert: mocks.patternUpsert,
      update: mocks.patternUpdate,
      updateMany: mocks.patternUpdateMany,
    },
    message_facets: { upsert: mocks.facetUpsert },
  },
}));

const { entityFor } = await import('../src/features/label-discovery/entity.js');
const { resolveFacetRules, matchesRule } =
  await import('../src/features/label-discovery/routing-rules.js');
const { FacetClassificationService, stableSubjectPhrase } =
  await import('../src/features/automation/facet-classification.service.js');

const ACCOUNT = '11111111-1111-4111-8111-111111111111';

function message(input: { id: string; subject: string; sender: string }) {
  return {
    id: input.id,
    gmail_message_id: `g-${input.id}`,
    subject: input.subject,
    sender_email: input.sender,
    sender_name: null,
    snippet: null,
    internal_date: new Date('2026-08-01T00:00:00.000Z'),
  } as never;
}

function facetRule(input: {
  id: string;
  kind: 'SUBJECT_CONTAINS' | 'SENDER_DOMAIN' | 'SENDER_ADDRESS';
  value: string;
  domain?: string | null;
  intent?: string | null;
  learnedFrom?: string | null;
}) {
  return {
    id: input.id,
    rule_kind: input.kind,
    match_value: input.value,
    facet_domain: input.domain ?? null,
    facet_intent: input.intent ?? null,
    learned_from_entity: input.learnedFrom ?? null,
    confidence: 0.95,
    rule_source: 'LEARNED',
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.stateUpsert.mockResolvedValue({});
  mocks.stateUpdateMany.mockResolvedValue({ count: 1 });
  mocks.patternFindMany.mockResolvedValue([]);
  mocks.patternFindUnique.mockResolvedValue(null);
  mocks.patternUpsert.mockResolvedValue({});
  mocks.patternUpdate.mockResolvedValue({});
  mocks.patternUpdateMany.mockResolvedValue({ count: 0 });
  mocks.facetUpsert.mockResolvedValue({});
  mocks.messageFindMany.mockResolvedValue([]);
});

describe('the entity facet', () => {
  it('derives a brand from the sender domain with no model call', () => {
    expect(entityFor('info@netflix.com')).toBe('netflix');
    expect(entityFor('notifications@mail.github.com')).toBe('github');
    expect(entityFor('jobs-noreply@linkedin.com')).toBe('linkedin');
  });

  it('folds a brand`s bulk-mail domain onto the brand itself', () => {
    expect(entityFor('noreply@redditmail.com')).toBe('reddit');
    expect(entityFor('x@facebookmail.com')).toBe('facebook');
    expect(entityFor('x@googlemail.com')).toBe('google');
  });

  it('keeps a brand whose name merely ends in a mail word', () => {
    expect(entityFor('x@fastmail.com')).toBe('fastmail');
    expect(entityFor('x@mailchimp.com')).toBe('mailchimp');
  });

  it('returns null rather than inventing a brand for an unusable sender', () => {
    expect(entityFor(null)).toBeNull();
    expect(entityFor('not-an-address')).toBeNull();
  });
});

describe('facet routing rules', () => {
  it('fires a subject intent rule across three sender domains it was never learned on', () => {
    const rule = {
      kind: 'SUBJECT_CONTAINS' as const,
      value: 'insufficient funds',
      domain: null,
      intent: 'payment-failed',
    };
    const senders = ['alerts@exness.com', 'billing@netflix.com', 'no-reply@coursera.org'];
    for (const sender of senders) {
      const resolved = resolveFacetRules([rule], {
        subject: 'Payment with insufficient funds on your account',
        senderEmail: sender,
      });
      expect(resolved.intent?.value).toBe('payment-failed');
    }
    // Three different brands, one rule: the entity axis is orthogonal to the intent axis, which is
    // exactly what a rule resolving to a leaf path could never express.
    expect(new Set(senders.map((sender) => entityFor(sender))).size).toBe(3);
  });

  it('resolves domain and intent independently rather than letting one rule win outright', () => {
    const rules = [
      { kind: 'SENDER_DOMAIN' as const, value: 'exness.com', domain: 'finance', intent: null },
      {
        kind: 'SUBJECT_CONTAINS' as const,
        value: 'insufficient funds',
        domain: null,
        intent: 'payment-failed',
      },
    ];
    const resolved = resolveFacetRules(rules, {
      subject: 'Payment with insufficient funds',
      senderEmail: 'alerts@exness.com',
    });
    expect(resolved.domain?.value).toBe('finance');
    expect(resolved.intent?.value).toBe('payment-failed');
  });

  it('gives a facet to the most specific rule that names it', () => {
    const rules = [
      { kind: 'SENDER_DOMAIN' as const, value: 'exness.com', intent: 'newsletter', domain: null },
      {
        kind: 'SENDER_ADDRESS' as const,
        value: 'alerts@exness.com',
        intent: 'security-alert',
        domain: null,
      },
    ];
    const resolved = resolveFacetRules(rules, {
      subject: 'Anything at all',
      senderEmail: 'alerts@exness.com',
    });
    expect(resolved.intent?.value).toBe('security-alert');
  });

  it('leaves a facet undecided when no rule names it', () => {
    const resolved = resolveFacetRules(
      [{ kind: 'SENDER_DOMAIN' as const, value: 'exness.com', domain: 'finance', intent: null }],
      { subject: 'Anything', senderEmail: 'alerts@exness.com' },
    );
    expect(resolved.intent).toBeNull();
  });
});

describe('subject phrases learned as rules', () => {
  it('produces a phrase that literally matches the subject it came from', () => {
    const subject = 'Update on your Zipline application';
    const phrase = stableSubjectPhrase(subject);
    expect(phrase).not.toBeNull();
    expect(
      matchesRule({ kind: 'SUBJECT_CONTAINS', value: phrase! }, { subject, senderEmail: null }),
    ).toBe(true);
  });

  it('prefers a three-word phrase and skips digits that make a subject unique', () => {
    expect(stableSubjectPhrase('Payment with insufficient funds declined')).toBe(
      'insufficient funds declined',
    );
    expect(stableSubjectPhrase('Invoice 4821 payment receipt available')).toBe(
      'payment receipt available',
    );
  });

  it('returns null when a subject has nothing distinctive to learn from', () => {
    expect(stableSubjectPhrase('re: you and me')).toBeNull();
    expect(stableSubjectPhrase(null)).toBeNull();
  });
});

describe('the facet classification pass', () => {
  function service(classifications: unknown[]) {
    mocks.classify.mockResolvedValue({
      classifications,
      usage: { inputTokens: 120, cachedInputTokens: 0, outputTokens: 40 },
    });
    return new FacetClassificationService({ classify: mocks.classify });
  }

  it('decides by rule with no model call when both facets are covered', async () => {
    mocks.messageFindMany.mockResolvedValue([
      message({
        id: 'a',
        subject: 'Payment with insufficient funds',
        sender: 'alerts@exness.com',
      }),
    ]);
    mocks.patternFindMany.mockResolvedValue([
      facetRule({ id: 'r1', kind: 'SENDER_DOMAIN', value: 'exness.com', domain: 'finance' }),
      facetRule({
        id: 'r2',
        kind: 'SUBJECT_CONTAINS',
        value: 'insufficient funds',
        intent: 'payment-failed',
      }),
    ]);
    const counters = await service([]).classifyAccount(ACCOUNT);
    expect(mocks.classify).not.toHaveBeenCalled();
    expect(counters.ruleDecided).toBe(1);
    expect(mocks.facetUpsert).toHaveBeenCalledTimes(1);
    expect(mocks.facetUpsert.mock.calls[0]![0].create).toMatchObject({
      entity: 'exness',
      domain: 'finance',
      intent: 'payment-failed',
      source: 'RULE',
    });
  });

  it('counts a subject rule firing on an entity it was not learned on', async () => {
    mocks.messageFindMany.mockResolvedValue([
      message({
        id: 'a',
        subject: 'Payment with insufficient funds',
        sender: 'billing@netflix.com',
      }),
    ]);
    mocks.patternFindMany.mockResolvedValue([
      facetRule({ id: 'r1', kind: 'SENDER_DOMAIN', value: 'netflix.com', domain: 'finance' }),
      facetRule({
        id: 'r2',
        kind: 'SUBJECT_CONTAINS',
        value: 'insufficient funds',
        intent: 'payment-failed',
        learnedFrom: 'exness',
      }),
    ]);
    const counters = await service([]).classifyAccount(ACCOUNT);
    expect(counters.crossEntityRuleHits).toBe(1);
  });

  it('asks the model only for the axis no rule covered, and keeps the rule`s answer', async () => {
    mocks.messageFindMany.mockResolvedValue([
      message({ id: 'a', subject: 'Your invoice is available', sender: 'billing@vercel.com' }),
    ]);
    mocks.patternFindMany.mockResolvedValue([
      facetRule({ id: 'r1', kind: 'SENDER_DOMAIN', value: 'vercel.com', domain: 'development' }),
    ]);
    const counters = await service([
      {
        key: 'm1',
        domain: 'finance',
        domainConfidence: 0.6,
        intent: 'invoice-receipt',
        intentConfidence: 0.93,
      },
    ]).classifyAccount(ACCOUNT);

    expect(mocks.classify.mock.calls[0]![0][0]).toMatchObject({ knownDomain: 'development' });
    expect(counters.modelDecided).toBe(1);
    // The rule settled the domain, so the model's competing answer is context, not a vote.
    expect(mocks.facetUpsert.mock.calls[0]![0].create).toMatchObject({
      domain: 'development',
      domain_confidence: 1,
      intent: 'invoice-receipt',
      source: 'MODEL',
    });
  });

  it('learns intent onto a subject phrase and domain onto the sender', async () => {
    mocks.messageFindMany.mockResolvedValue([
      message({
        id: 'a',
        subject: 'Payment with insufficient funds declined',
        sender: 'alerts@exness.com',
      }),
    ]);
    await service([
      {
        key: 'm1',
        domain: 'finance',
        domainConfidence: 0.97,
        intent: 'payment-failed',
        intentConfidence: 0.96,
      },
    ]).classifyAccount(ACCOUNT);

    const written = mocks.patternUpsert.mock.calls.map((call) => call[0].create);
    expect(written).toContainEqual(
      expect.objectContaining({
        rule_kind: 'SUBJECT_CONTAINS',
        match_value: 'insufficient funds declined',
        facet_intent: 'payment-failed',
        learned_from_entity: 'exness',
      }),
    );
    expect(written).toContainEqual(
      expect.objectContaining({
        rule_kind: 'SENDER_DOMAIN',
        match_value: 'exness.com',
        facet_domain: 'finance',
      }),
    );
    // The intent never became a sender-domain rule: that is the rule that would not generalise.
    expect(written.filter((rule) => rule.facet_intent)).toHaveLength(1);
  });

  it('falls back to a sender rule for intent when no phrase generalises', async () => {
    mocks.messageFindMany.mockResolvedValue([
      message({ id: 'a', subject: 're: you and me', sender: 'alerts@exness.com' }),
    ]);
    await service([
      {
        key: 'm1',
        domain: null,
        domainConfidence: 0,
        intent: 'security-alert',
        intentConfidence: 0.98,
      },
    ]).classifyAccount(ACCOUNT);
    const written = mocks.patternUpsert.mock.calls.map((call) => call[0].create);
    expect(written).toContainEqual(
      expect.objectContaining({
        rule_kind: 'SENDER_DOMAIN',
        match_value: 'exness.com',
        facet_intent: 'security-alert',
      }),
    );
  });

  it('does not learn from an unconfident decision', async () => {
    mocks.messageFindMany.mockResolvedValue([
      message({ id: 'a', subject: 'Some distinctive subject line', sender: 'a@example.com' }),
    ]);
    await service([
      {
        key: 'm1',
        domain: 'finance',
        domainConfidence: 0.4,
        intent: 'newsletter',
        intentConfidence: 0.5,
      },
    ]).classifyAccount(ACCOUNT);
    expect(mocks.patternUpsert).not.toHaveBeenCalled();
  });

  it('deactivates a learned rule the mail has contradicted rather than flipping it', async () => {
    mocks.messageFindMany.mockResolvedValue([
      message({
        id: 'a',
        subject: 'Payment with insufficient funds declined',
        sender: 'alerts@exness.com',
      }),
    ]);
    mocks.patternFindUnique.mockResolvedValue({
      id: 'existing',
      rule_source: 'LEARNED',
      facet_intent: 'invoice-receipt',
      facet_domain: null,
      confidence: 0.9,
    });
    await service([
      {
        key: 'm1',
        domain: null,
        domainConfidence: 0,
        intent: 'payment-failed',
        intentConfidence: 0.96,
      },
    ]).classifyAccount(ACCOUNT);
    expect(mocks.patternUpdate).toHaveBeenCalledWith({
      where: { id: 'existing' },
      data: { active: false },
    });
    expect(mocks.patternUpsert).not.toHaveBeenCalled();
  });

  it('never overwrites a rule the user approved through a plan', async () => {
    mocks.messageFindMany.mockResolvedValue([
      message({
        id: 'a',
        subject: 'Payment with insufficient funds declined',
        sender: 'alerts@exness.com',
      }),
    ]);
    mocks.patternFindUnique.mockResolvedValue({
      id: 'planner',
      rule_source: 'PLANNER',
      facet_intent: 'invoice-receipt',
      facet_domain: null,
      confidence: 0.9,
    });
    await service([
      {
        key: 'm1',
        domain: null,
        domainConfidence: 0,
        intent: 'payment-failed',
        intentConfidence: 0.99,
      },
    ]).classifyAccount(ACCOUNT);
    expect(mocks.patternUpdate).not.toHaveBeenCalled();
    expect(mocks.patternUpsert).not.toHaveBeenCalled();
  });

  it('refuses to run while the account is already leased', async () => {
    mocks.stateUpdateMany.mockResolvedValueOnce({ count: 0 });
    await expect(service([]).classifyAccount(ACCOUNT)).rejects.toMatchObject({
      code: 'AUTOMATION_ALREADY_RUNNING',
    });
  });
});
