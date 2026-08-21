import { describe, expect, it } from 'vitest';

import {
  FACET_LIMITS,
  FACET_NAME_PATTERN,
  auditApprovedVocabulary,
  normalizeSubject,
  sampleFacetEvidence,
  validateFacetGrounding,
  type FacetEvidenceMessage,
} from '../src/features/label-discovery/facet-vocabulary.js';
import {
  APPROVED_FACET_VOCABULARY,
  MODEL_FACET_NAMES,
  facetValueNames,
  isApprovedFacetValue,
} from '../src/features/label-discovery/facets.js';

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
    subject: 'Update on your Zipline application',
    senderEmail: 'jobs-noreply@linkedin.com',
    filedPath: 'Job hunt/Alerts',
  }),
  message({ id: '4', subject: 'Welcome to Miro', senderEmail: 'no-reply@miro.com' }),
  message({ id: '5', subject: '009522 is your verification code', senderEmail: 'a@github.com' }),
];

type RawValue = { name: string; estimatedMessageCount: number; exampleSubjects: string[] };

/** A grounding covering every approved value, so a test can perturb exactly one thing. */
function fullResponse(): { domain: RawValue[]; intent: RawValue[] } {
  const build = (facet: 'domain' | 'intent'): RawValue[] =>
    APPROVED_FACET_VOCABULARY[facet].map((value, index) => ({
      name: value.name,
      estimatedMessageCount: 500 - index,
      exampleSubjects: [`${facet} example ${index} for ${value.name}`],
    }));
  return { domain: build('domain'), intent: build('intent') };
}

function pick(values: RawValue[], name: string): RawValue {
  const found = values.find((value) => value.name === name);
  if (!found) throw new Error(`no grounding for ${name}`);
  return found;
}

function ground(raw: unknown, context: FacetEvidenceMessage[] = sample) {
  return validateFacetGrounding(raw, { sample: context });
}

describe('the approved vocabulary', () => {
  it('satisfies its own structural rules', () => {
    expect(auditApprovedVocabulary()).toEqual([]);
  });

  it('stays inside the per-facet ceilings', () => {
    expect(APPROVED_FACET_VOCABULARY.domain).toHaveLength(7);
    expect(APPROVED_FACET_VOCABULARY.intent).toHaveLength(13);
    for (const facet of MODEL_FACET_NAMES) {
      expect(APPROVED_FACET_VOCABULARY[facet].length).toBeLessThanOrEqual(
        FACET_LIMITS.maxValues[facet],
      );
    }
  });

  it('holds the amendments the mailbox owner approved', () => {
    const domains = facetValueNames('domain');
    expect(domains).toContain('shopping');
    expect(domains).not.toContain('marketing');
    expect(domains).toContain('entertainment');
    expect(domains).not.toContain('gaming');
    const intents = facetValueNames('intent');
    expect(intents).toContain('application-outcome');
    expect(intents).toContain('application-received');
  });

  it('draws verification and welcome apart on whether an action is required', () => {
    const definitionOf = (name: string) =>
      APPROVED_FACET_VOCABULARY.intent.find((value) => value.name === name)!.definition;
    expect(definitionOf('verification')).toMatch(/action is required/i);
    expect(definitionOf('welcome')).toMatch(/no action is required/i);
    expect(definitionOf('welcome')).not.toMatch(/verif/i);
  });

  it('uses kebab-case names only', () => {
    for (const facet of MODEL_FACET_NAMES) {
      for (const value of APPROVED_FACET_VOCABULARY[facet]) {
        expect(value.name).toMatch(FACET_NAME_PATTERN);
        expect(isApprovedFacetValue(facet, value.name)).toBe(true);
      }
    }
  });
});

describe('facet grounding validation', () => {
  it('rejects a response that is not two arrays of grounded values', () => {
    expect(() => ground({ facets: [] })).toThrowError(/unusable facet grounding/i);
  });

  it('returns every approved value in declaration order', () => {
    const { domain, intent } = ground(fullResponse());
    expect(domain.map((value) => value.name)).toEqual(facetValueNames('domain'));
    expect(intent.map((value) => value.name)).toEqual(facetValueNames('intent'));
  });

  it('discards a value the model invented rather than adopting it', () => {
    const response = fullResponse();
    response.domain.push({
      name: 'marketing',
      estimatedMessageCount: 900,
      exampleSubjects: ['Your New Go-To Tees'],
    });
    const { domain, findings } = ground(response);
    expect(domain.map((value) => value.name)).not.toContain('marketing');
    expect(findings).toContain(
      'Discarded domain "marketing": not a value of the approved vocabulary.',
    );
  });

  it('reports a value the model failed to ground and keeps it with no evidence', () => {
    const response = fullResponse();
    response.intent = response.intent.filter((value) => value.name !== 'application-outcome');
    const { intent, findings } = ground(response);
    expect(intent.find((value) => value.name === 'application-outcome')).toMatchObject({
      estimatedWeight: 0,
      exampleSubjects: [],
    });
    expect(findings).toContain(
      'intent "application-outcome": the model returned no grounding for it.',
    );
  });

  it('reports a weight below the threshold instead of dropping the value', () => {
    const response = fullResponse();
    pick(response.intent, 'application-outcome').estimatedMessageCount = 12;
    const { intent, findings } = ground(response);
    expect(intent.map((value) => value.name)).toContain('application-outcome');
    expect(
      findings.some((finding) => /weight 12 is below the 20 reporting threshold/.test(finding)),
    ).toBe(true);
  });

  it('reports two values of one facet claiming the same subject', () => {
    const response = fullResponse();
    const shared = 'Welcome to Miro';
    pick(response.intent, 'verification').exampleSubjects = [shared];
    pick(response.intent, 'welcome').exampleSubjects = [shared];
    const { intent, findings } = ground(response);
    expect(
      findings.some((finding) =>
        /Mutual exclusivity: intent "welcome" and "verification" both claim/.test(finding),
      ),
    ).toBe(true);
    // The value declared first keeps the subject; the other loses that example only.
    expect(intent.find((value) => value.name === 'verification')?.exampleSubjects).toEqual([
      shared,
    ]);
    expect(intent.find((value) => value.name === 'welcome')?.exampleSubjects).toEqual([]);
  });

  it('lets one subject ground a domain value and an intent value at once', () => {
    const response = fullResponse();
    const shared = 'Your payment could not be processed';
    pick(response.domain, 'finance').exampleSubjects = [shared];
    pick(response.intent, 'payment-failed').exampleSubjects = [shared];
    const { domain, intent, findings } = ground(response);
    expect(domain.find((value) => value.name === 'finance')?.exampleSubjects).toEqual([shared]);
    expect(intent.find((value) => value.name === 'payment-failed')?.exampleSubjects).toEqual([
      shared,
    ]);
    expect(findings.some((finding) => finding.startsWith('Mutual exclusivity'))).toBe(false);
  });

  it('counts an example as grounded despite case and punctuation', () => {
    expect(normalizeSubject('  Your PAYMENT could not be processed! ')).toBe(
      'your payment could not be processed',
    );
    const response = fullResponse();
    pick(response.intent, 'payment-failed').exampleSubjects = [
      'your payment could NOT be processed.',
    ];
    const { intent } = ground(response);
    expect(intent.find((value) => value.name === 'payment-failed')?.groundedExampleCount).toBe(1);
  });

  it('reports an example that appears nowhere in the sample', () => {
    const response = fullResponse();
    pick(response.intent, 'payment-failed').exampleSubjects = [
      'A subject nobody in this mailbox ever received',
    ];
    const { intent, findings } = ground(response);
    expect(intent.find((value) => value.name === 'payment-failed')?.groundedExampleCount).toBe(0);
    expect(
      findings.some((finding) =>
        /intent "payment-failed": 1 of 1 example subjects were not found/.test(finding),
      ),
    ).toBe(true);
  });

  it('keeps at most three examples per value', () => {
    const response = fullResponse();
    pick(response.domain, 'finance').exampleSubjects = [
      'one subject here',
      'two subject here',
      'three subject here',
      'four subject here',
    ];
    const { domain } = ground(response);
    expect(domain.find((value) => value.name === 'finance')?.exampleSubjects).toHaveLength(
      FACET_LIMITS.exampleSubjects,
    );
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

  it('draws most of the sample from mail the previous classifier could not file', () => {
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
