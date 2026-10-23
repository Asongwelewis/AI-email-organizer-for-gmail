import type { gmail_message_metadata } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  stateUpsert: vi.fn(),
  stateUpdateMany: vi.fn(),
  messageFindMany: vi.fn(),
  patternFindMany: vi.fn(),
  patternUpdateMany: vi.fn(),
  facetFindMany: vi.fn(),
  executeRaw: vi.fn(),
  accountCount: vi.fn(),
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
      updateMany: mocks.patternUpdateMany,
    },
    message_facets: { findMany: mocks.facetFindMany },
    connected_google_accounts: { count: mocks.accountCount },
    $executeRaw: mocks.executeRaw,
  },
}));

const { env } = await import('../src/config/env.js');
const { policyFor } = await import('../src/features/accounts/account-policy.js');
const { mayConnectMailbox } = await import('../src/features/accounts/beta-capacity.js');
const { heuristicFacets } = await import('../src/features/label-discovery/heuristics.js');
const { buildReferenceRules, DEFAULT_REFERENCE_OPTIONS } =
  await import('../src/features/label-discovery/reference-rules.js');
const { APPROVED_FACET_VOCABULARY } = await import('../src/features/label-discovery/facets.js');
const { FacetClassificationService } =
  await import('../src/features/automation/facet-classification.service.js');

const APPROVED = {
  domain: new Set(APPROVED_FACET_VOCABULARY.domain.map((value) => value.name)),
  intent: new Set(APPROVED_FACET_VOCABULARY.intent.map((value) => value.name)),
};
const DAY = 86_400_000;

beforeEach(() => {
  vi.clearAllMocks();
  env.OWNER_ACCOUNT_EMAILS = ['owner@example.com'];
  env.GEMINI_API_KEY = 'test-gemini-key';
  env.MAIL_HISTORY_DAYS = 730;
  env.BETA_MAX_MAILBOXES = 10;
});

describe('who a mailbox is', () => {
  const created = new Date('2026-10-23T00:00:00.000Z');

  it('sorts the owner with the model and over their whole mailbox', () => {
    expect(
      policyFor({ email: 'Owner@Example.com', created_at: created, mail_history_days: null }),
    ).toEqual({ owner: true, mode: 'MODEL', windowStart: null });
  });

  it('sorts everyone else by rules, two years back from their first connection', () => {
    expect(
      policyFor({ email: 'friend@example.com', created_at: created, mail_history_days: null }),
    ).toEqual({
      owner: false,
      mode: 'RULES',
      windowStart: new Date(created.getTime() - 730 * DAY),
    });
  });

  // What a subscription will buy: a longer window for one mailbox, with nothing else changing.
  it('honours a mailbox`s own history length', () => {
    expect(
      policyFor({ email: 'friend@example.com', created_at: created, mail_history_days: 3650 })
        .windowStart,
    ).toEqual(new Date(created.getTime() - 3650 * DAY));
  });

  it('sorts even the owner by rules when there is no key', () => {
    env.GEMINI_API_KEY = undefined;
    expect(
      policyFor({ email: 'owner@example.com', created_at: created, mail_history_days: null }).mode,
    ).toBe('RULES');
  });
});

describe('the beta cap', () => {
  it('lets a newcomer in while there is room, and turns them away when there is none', async () => {
    mocks.accountCount.mockResolvedValueOnce(0).mockResolvedValueOnce(9);
    await expect(mayConnectMailbox('user-new', 'new@example.com')).resolves.toBe(true);

    mocks.accountCount.mockResolvedValueOnce(0).mockResolvedValueOnce(10);
    await expect(mayConnectMailbox('user-new', 'new@example.com')).resolves.toBe(false);
  });

  it('never turns away someone already in, or the owner', async () => {
    mocks.accountCount.mockResolvedValueOnce(1);
    await expect(mayConnectMailbox('user-in', 'in@example.com')).resolves.toBe(true);
    await expect(mayConnectMailbox('user-owner', 'owner@example.com')).resolves.toBe(true);
    expect(mocks.accountCount).toHaveBeenCalledTimes(1);
  });

  it('does not count the owner`s mailbox against the beta', async () => {
    mocks.accountCount.mockResolvedValueOnce(0).mockResolvedValueOnce(3);
    await mayConnectMailbox('user-new', 'new@example.com');
    expect(mocks.accountCount.mock.calls[1]![0].where).toMatchObject({
      gmail_connected: true,
      NOT: { email: { in: ['owner@example.com'], mode: 'insensitive' } },
    });
  });
});

describe('the heuristics', () => {
  const facets = (subject: string, sender: string, labelIds: string[] = []) =>
    heuristicFacets({ subject, senderEmail: sender, snippet: null, labelIds }, APPROVED);

  it.each([
    ['Your verification code is 123456', 'no-reply@accounts.example.com', 'verification'],
    ['Security alert: new sign-in on Windows', 'no-reply@accounts.google.com', 'security-alert'],
    ['Payment with insufficient funds', 'billing@paysika.co', 'payment-failed'],
    ['Your receipt from Example Store', 'receipts@store.example.com', 'invoice-receipt'],
    ['Acme is hiring for a Java role', 'jobs@acme.example.com', 'job-match'],
    ['Welcome to Notion', 'team@notion.so', 'welcome'],
    ['Join our webinar on Thursday', 'events@cisco.com', 'webinar-event'],
    ['50% off everything this weekend', 'deals@shop.example.com', 'promotional'],
    ['Your weekly digest', 'digest@substack.com', 'newsletter'],
    [
      'Royal wants to be friends on Facebook',
      'notification@facebookmail.com',
      'system-notification',
    ],
  ])('reads "%s" as %s', (subject, sender, intent) => {
    expect(facets(subject, sender).intent).toBe(intent);
  });

  it('knows well-known senders` areas of life', () => {
    expect(facets('anything', 'jobs-noreply@linkedin.com').domain).toBe('career');
    expect(facets('anything', 'noreply@github.com').domain).toBe('development');
    expect(facets('anything', 'info@mail.netflix.com').domain).toBe('entertainment');
    expect(facets('anything', 'admissions@uni.edu').domain).toBe('education');
  });

  // Gmail already decided what kind of mail this is; that is better than leaving it blank.
  it('falls back to the tab Gmail put the message in', () => {
    expect(facets('Hello there', 'someone@unknown.example', ['CATEGORY_PROMOTIONS']).intent).toBe(
      'promotional',
    );
    expect(facets('Hello there', 'someone@unknown.example', ['CATEGORY_SOCIAL'])).toEqual({
      domain: 'social',
      intent: 'system-notification',
    });
  });

  it('never answers with a value the mailbox did not approve', () => {
    const narrow = { domain: new Set(['finance']), intent: new Set(['newsletter']) };
    expect(
      heuristicFacets(
        {
          subject: 'Your verification code',
          senderEmail: 'x@github.com',
          snippet: null,
          labelIds: [],
        },
        narrow,
      ),
    ).toEqual({ domain: null, intent: null });
  });
});

describe('the reference rules', () => {
  const sample = (
    subject: string,
    sender: string,
    domain: string | null,
    intent: string | null,
  ) => ({
    subject,
    senderEmail: sender,
    domain,
    intent,
  });
  const options = { ...DEFAULT_REFERENCE_OPTIONS, excludedWords: new Set(['asongwe', 'lewis']) };

  it('turns a consistent sender into a rule and leaves an inconsistent one out', () => {
    const rules = buildReferenceRules(
      [
        ...Array.from({ length: 5 }, () =>
          sample('x', 'a@github.com', 'development', 'system-notification'),
        ),
        sample('x', 'a@canva.com', 'development', 'promotional'),
        sample('x', 'a@canva.com', 'shopping', 'promotional'),
        sample('x', 'a@canva.com', 'career', 'promotional'),
      ],
      options,
    );
    const github = rules.find((rule) => rule.value === 'github.com');
    expect(github).toMatchObject({
      kind: 'SENDER_DOMAIN',
      domain: 'development',
      intent: 'system-notification',
    });
    // Canva's area of life was split three ways; its consistent intent still counts.
    expect(rules.find((rule) => rule.value === 'canva.com')).toMatchObject({
      domain: null,
      intent: 'promotional',
    });
  });

  // A person on a free mail provider is a person, and a rule about them describes the reference
  // mailbox's owner to everyone else.
  it('never makes a rule of a personal address', () => {
    const rules = buildReferenceRules(
      Array.from({ length: 6 }, () => sample('Lunch?', 'friend@gmail.com', 'social', 'newsletter')),
      options,
    );
    expect(rules.filter((rule) => rule.kind === 'SENDER_DOMAIN')).toEqual([]);
  });

  it('keeps a phrase only when several senders agree on what it means, and never a name', () => {
    const senders = ['a.com', 'b.com', 'c.com', 'd.com', 'e.com'];
    const rules = buildReferenceRules(
      [
        ...senders.map((site) =>
          sample('Your verification code inside', `x@${site}`, null, 'verification'),
        ),
        ...senders.map((site) =>
          sample('Asongwe lewis offer inside', `x@${site}`, null, 'promotional'),
        ),
      ],
      options,
    );
    const phrases = rules
      .filter((rule) => rule.kind === 'SUBJECT_CONTAINS')
      .map((rule) => rule.value);
    expect(phrases).toContain('verification code');
    expect(phrases.some((phrase) => phrase.includes('asongwe') || phrase.includes('lewis'))).toBe(
      false,
    );
  });
});

describe('which answer wins', () => {
  // A reference rule was learned from one person's mailbox, where amazon.com sent AWS webinars.
  // For most people it sends orders; what is true for everyone goes first.
  it('lets a well-known brand and the subject outrank a rule learned from one mailbox', async () => {
    const { decideWithoutModel } =
      await import('../src/features/label-discovery/rules-decision.js');
    const reference = [
      {
        kind: 'SENDER_DOMAIN' as const,
        value: 'amazon.com',
        domain: 'development',
        intent: 'webinar-event',
        confidence: 0.9,
      },
    ];
    const decision = decideWithoutModel(
      {
        subject: 'Limited-time: 50% off your next order',
        senderEmail: 'store-news@amazon.com',
        snippet: null,
        labelIds: ['CATEGORY_PROMOTIONS'],
      },
      [],
      reference,
      APPROVED,
    );
    expect(decision.domain.value).toBe('shopping');
    expect(decision.intent.value).toBe('promotional');
    expect(decision.source).toBe('HEURISTIC');
  });

  it('still uses the reference rule where nothing public says otherwise', async () => {
    const { decideWithoutModel } =
      await import('../src/features/label-discovery/rules-decision.js');
    const decision = decideWithoutModel(
      {
        subject: 'Something new',
        senderEmail: 'news@digitaltrends.com',
        snippet: null,
        labelIds: [],
      },
      [],
      [
        {
          kind: 'SENDER_DOMAIN' as const,
          value: 'digitaltrends.com',
          domain: 'entertainment',
          intent: 'newsletter',
          confidence: 0.9,
        },
      ],
      APPROVED,
    );
    expect(decision).toMatchObject({
      domain: { value: 'entertainment', fromRule: true },
      intent: { value: 'newsletter', fromRule: true },
      source: 'RULE',
    });
  });

  // Proton the company writes from news.proton.me; a person on Proton writes from proton.me.
  it('files a provider`s own newsletters under the provider, and only people as personal', async () => {
    const { entityFor } = await import('../src/features/label-discovery/entity.js');
    expect(entityFor('friend@proton.me')).toBe('personal');
    expect(entityFor('newsletter@news.proton.me')).toBe('proton');
    expect(entityFor('no-reply@gmail.com')).not.toBe('personal');
  });
});

describe('sorting a beta mailbox', () => {
  const ACCOUNT = '33333333-3333-4333-8333-333333333333';
  const WINDOW = new Date('2024-10-23T00:00:00.000Z');
  const BETA = {
    forAccount: async () => ({ owner: false, mode: 'RULES' as const, windowStart: WINDOW }),
  };

  const message = (id: string, subject: string, sender: string, labelIds: string[] = []) =>
    ({
      id,
      gmail_message_id: `g-${id}`,
      subject,
      sender_email: sender,
      sender_name: null,
      snippet: null,
      label_ids: labelIds,
      internal_date: new Date('2026-01-01T00:00:00.000Z'),
      created_at: new Date('2026-01-01T00:00:00.000Z'),
    }) as unknown as gmail_message_metadata;

  function service(reference: unknown[] = []) {
    return new FacetClassificationService(
      { classify: mocks.classify },
      { requireApproved: async () => APPROVED_FACET_VOCABULARY } as never,
      BETA,
      async () => reference as never,
    );
  }

  function written(): Array<Record<string, unknown>> {
    return mocks.executeRaw.mock.calls.flatMap((call) => {
      const payload = call
        .slice(1)
        .find((value) => typeof value === 'string' && value.startsWith('['));
      return payload ? (JSON.parse(payload as string) as Array<Record<string, unknown>>) : [];
    });
  }

  beforeEach(() => {
    mocks.stateUpsert.mockResolvedValue({});
    mocks.stateUpdateMany.mockResolvedValue({ count: 1 });
    mocks.patternFindMany.mockResolvedValue([]);
    mocks.facetFindMany.mockResolvedValue([]);
    mocks.executeRaw.mockResolvedValue(2);
  });

  it('decides every message without the model, and writes them in one statement', async () => {
    mocks.messageFindMany
      .mockResolvedValueOnce([
        message('a', 'Your verification code', 'no-reply@github.com'),
        message('b', 'Lunch on Friday?', 'friend@gmail.com'),
      ])
      .mockResolvedValue([]);

    const counters = await service().classifyAccount(ACCOUNT);

    expect(mocks.classify).not.toHaveBeenCalled();
    expect(mocks.executeRaw).toHaveBeenCalledTimes(1);
    expect(counters.ruleDecided).toBe(2);
    expect(counters.modelDecided).toBe(0);
    const rows = written();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      domain: 'development',
      intent: 'verification',
      source: 'HEURISTIC',
    });
    // A personal note no keyword can name still gets a row: it sits in its sender's folder.
    expect(rows[1]).toMatchObject({ entity: 'personal', domain: null, intent: null });
  });

  it('reads nothing older than the window', async () => {
    mocks.messageFindMany.mockResolvedValue([]);

    await service().classifyAccount(ACCOUNT);

    expect(mocks.messageFindMany.mock.calls[0]![0].where).toMatchObject({
      internal_date: { gte: WINDOW },
    });
  });

  it('prefers a reference rule over a guess, and says so', async () => {
    mocks.messageFindMany
      .mockResolvedValueOnce([message('a', 'Something new', 'news@digitaltrends.com')])
      .mockResolvedValue([]);

    await service([
      {
        kind: 'SENDER_DOMAIN',
        value: 'digitaltrends.com',
        domain: 'entertainment',
        intent: 'newsletter',
        sampleCount: 150,
        share: 0.9,
      },
    ]).classifyAccount(ACCOUNT);

    expect(written()[0]).toMatchObject({
      domain: 'entertainment',
      intent: 'newsletter',
      source: 'RULE',
      domain_confidence: 0.9,
    });
  });

  it('keeps reading pages until the window is empty', async () => {
    const page = Array.from({ length: 1000 }, (_, index) =>
      message(`m${index}`, 'Weekly digest', 'news@substack.com'),
    );
    mocks.messageFindMany
      .mockResolvedValueOnce(page)
      .mockResolvedValueOnce([message('last', 'Weekly digest', 'news@substack.com')])
      .mockResolvedValue([]);

    const counters = await service().classifyAccount(ACCOUNT);

    expect(counters.ruleDecided).toBe(1001);
    expect(mocks.executeRaw).toHaveBeenCalledTimes(2);
  });
});
