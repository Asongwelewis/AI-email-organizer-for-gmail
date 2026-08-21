import { describe, expect, it } from 'vitest';

import {
  FACET_LIMITS,
  normalizeSubject,
  sampleFacetEvidence,
  validateFacetVocabularies,
  type FacetEvidenceMessage,
} from '../src/features/label-discovery/facet-vocabulary.js';

function message(input: Partial<FacetEvidenceMessage> & { id: string }): FacetEvidenceMessage {
  return {
    subject: 'Your payment could not be processed',
    senderName: 'Netflix',
    senderEmail: 'info@netflix.com',
    internalDate: new Date('2026-08-01T00:00:00.000Z'),
    filedPath: null,
    ...input,
  };
}

const sample: FacetEvidenceMessage[] = [
  message({ id: '1', subject: 'Your payment could not be processed' }),
  message({
    id: '2',
    subject: 'Insufficient funds on your account',
    senderEmail: 'noreply@exness.com',
  }),
  message({
    id: '3',
    subject: 'A new job matching Backend Engineer',
    senderEmail: 'jobs-noreply@linkedin.com',
    filedPath: 'Job hunt/Alerts',
  }),
  message({
    id: '4',
    subject: 'Your invoice for August is ready',
    senderEmail: 'billing@vercel.com',
  }),
];

function value(input: Record<string, unknown>) {
  return {
    name: 'payment-failed',
    definition: 'A charge the sender attempted did not go through.',
    estimatedMessageCount: 120,
    exampleSubjects: ['Your payment could not be processed'],
    ...input,
  };
}

function validate(
  input: { domain?: unknown[]; intent?: unknown[] },
  context: FacetEvidenceMessage[] = sample,
) {
  return validateFacetVocabularies(
    { domain: input.domain ?? [], intent: input.intent ?? [] },
    { sample: context },
  );
}

describe('facet vocabulary validation', () => {
  it('rejects a response that is not two arrays of facet values', () => {
    expect(() => validateFacetVocabularies({ facets: [] }, { sample })).toThrowError(
      /unusable facet vocabulary/i,
    );
  });

  it('accepts a grounded value and reports how much of it was verified', () => {
    const { intent, warnings } = validate({ intent: [value({})] });
    expect(intent).toHaveLength(1);
    expect(intent[0]).toMatchObject({ name: 'payment-failed', groundedExampleCount: 1 });
    expect(warnings).toHaveLength(0);
  });

  it('matches an example against the sample despite case and punctuation', () => {
    expect(normalizeSubject('  Your PAYMENT could not be processed! ')).toBe(
      'your payment could not be processed',
    );
    const { intent } = validate({
      intent: [value({ exampleSubjects: ['your payment could NOT be processed.'] })],
    });
    expect(intent[0]?.groundedExampleCount).toBe(1);
  });

  it('drops a name that is not lower-case kebab-case', () => {
    const { intent, warnings } = validate({ intent: [value({ name: 'Payment_Failed' })] });
    expect(intent).toHaveLength(0);
    expect(warnings).toContain(
      'Dropped intent "Payment_Failed": the name is not lower-case kebab-case.',
    );
  });

  it('drops a value with too little mail behind it', () => {
    const { intent, warnings } = validate({
      intent: [value({ estimatedMessageCount: FACET_LIMITS.minEstimatedMessages - 1 })],
    });
    expect(intent).toHaveLength(0);
    expect(warnings[0]).toMatch(/is below the 20 a facet value needs/);
  });

  it('drops a value whose examples appear nowhere in the sample', () => {
    const { intent, warnings } = validate({
      intent: [value({ exampleSubjects: ['A subject nobody in this mailbox ever received'] })],
    });
    expect(intent).toHaveLength(0);
    expect(warnings[0]).toMatch(/none of its example subjects appear in the sample/);
  });

  it('warns, but keeps the value, when only some examples are grounded', () => {
    const { intent, warnings } = validate({
      intent: [
        value({
          exampleSubjects: ['Your payment could not be processed', 'Invented subject line here'],
        }),
      ],
    });
    expect(intent).toHaveLength(1);
    expect(intent[0]?.groundedExampleCount).toBe(1);
    expect(warnings[0]).toMatch(/1 of 2 example subjects were not found in the sample/);
  });

  it('drops the smaller of two values that claim the same example', () => {
    const { intent, warnings } = validate({
      intent: [
        value({ name: 'billing-problem', estimatedMessageCount: 40 }),
        value({ name: 'payment-failed', estimatedMessageCount: 300 }),
      ],
    });
    expect(intent.map((entry) => entry.name)).toEqual(['payment-failed']);
    expect(warnings[0]).toMatch(
      /Dropped intent "billing-problem": its example .* is already an example of intent "payment-failed", so the two are not mutually exclusive/,
    );
  });

  it('lets the same subject ground one domain value and one intent value', () => {
    const { domain, intent } = validate({
      domain: [value({ name: 'finance', definition: 'Money moving in or out.' })],
      intent: [value({})],
    });
    expect(domain).toHaveLength(1);
    expect(intent).toHaveLength(1);
  });

  it('drops a duplicate name', () => {
    const { intent, warnings } = validate({
      intent: [
        value({ estimatedMessageCount: 300 }),
        value({
          estimatedMessageCount: 100,
          exampleSubjects: ['Insufficient funds on your account'],
        }),
      ],
    });
    expect(intent).toHaveLength(1);
    expect(warnings[0]).toMatch(/another value already uses that name/);
  });

  it('truncates each facet to its own limit, keeping the values with the most mail', () => {
    // Every value needs an example of its own, or the exclusivity check would drop it first.
    const wide = Array.from({ length: 40 }, (_, index) =>
      message({ id: `wide-${index}`, subject: `Distinct sample subject number ${index}` }),
    );
    const many = (count: number, prefix: string, offset: number) =>
      Array.from({ length: count }, (_, index) =>
        value({
          name: `${prefix}-${index}`,
          estimatedMessageCount: 1000 - index,
          exampleSubjects: [wide[offset + index]!.subject],
        }),
      );
    const { domain, intent, warnings } = validate(
      {
        domain: many(FACET_LIMITS.maxValues.domain + 2, 'd', 0),
        intent: many(FACET_LIMITS.maxValues.intent + 3, 'i', 20),
      },
      wide,
    );
    expect(domain).toHaveLength(FACET_LIMITS.maxValues.domain);
    expect(intent).toHaveLength(FACET_LIMITS.maxValues.intent);
    expect(domain[0]?.name).toBe('d-0');
    expect(warnings.some((warning) => warning.includes('exceeded its 8-value limit'))).toBe(true);
    expect(warnings.some((warning) => warning.includes('exceeded its 14-value limit'))).toBe(true);
  });
});

describe('facet evidence sampling', () => {
  const population: FacetEvidenceMessage[] = [
    // One newsletter that would swallow a uniform sample on its own.
    ...Array.from({ length: 200 }, (_, index) =>
      message({
        id: `bulk-${index}`,
        senderEmail: 'news@substack.com',
        subject: `Daily digest ${index}`,
      }),
    ),
    // The long tail the cap exists to protect: fourteen invoices from one small sender.
    ...Array.from({ length: 14 }, (_, index) =>
      message({
        id: `invoice-${index}`,
        senderEmail: 'billing@smallvendor.io',
        subject: `Invoice ${index}`,
      }),
    ),
    ...Array.from({ length: 40 }, (_, index) =>
      message({ id: `tail-${index}`, senderEmail: `hello@tail${index}.com` }),
    ),
    ...Array.from({ length: 60 }, (_, index) =>
      message({
        id: `filed-${index}`,
        senderEmail: `sender${index}@filed${index}.com`,
        filedPath: 'Job hunt/Alerts',
      }),
    ),
  ];

  it('caps every sender domain and keeps the long tail in the sample', () => {
    const { sample: drawn, stats } = sampleFacetEvidence(population, {
      limit: 100,
      perDomainCap: 3,
      unfiledShare: 0.8,
    });
    const bySender = new Map<string, number>();
    for (const entry of drawn) {
      bySender.set(entry.senderEmail!, (bySender.get(entry.senderEmail!) ?? 0) + 1);
    }
    expect(Math.max(...bySender.values())).toBeLessThanOrEqual(3);
    expect(bySender.get('billing@smallvendor.io')).toBe(3);
    expect(bySender.get('news@substack.com')).toBe(3);
    expect(stats.sampled).toBe(drawn.length);
  });

  it('draws most of the sample from mail the current classifier could not file', () => {
    const { stats } = sampleFacetEvidence(population, {
      limit: 20,
      perDomainCap: 4,
      unfiledShare: 0.8,
    });
    expect(stats.fromUnfiled).toBe(16);
    expect(stats.fromFiled).toBe(4);
  });

  it('gives the unfiled side the budget the filed side cannot fill', () => {
    const unfiledOnly = population.filter((entry) => !entry.filedPath);
    const { stats } = sampleFacetEvidence(unfiledOnly, {
      limit: 20,
      perDomainCap: 10,
      unfiledShare: 0.8,
    });
    expect(stats.fromFiled).toBe(0);
    expect(stats.fromUnfiled).toBe(20);
  });
});
