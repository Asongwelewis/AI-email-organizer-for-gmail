import { describe, expect, it } from 'vitest';

import {
  isGenericLabelName,
  labelsAreSimilar,
  normalizeLabelForComparison,
  validateLeafName,
} from '../src/features/label-discovery/label-normalization.js';
import {
  countRuleMatches,
  findMatchingRule,
  matchesRule,
  normalizeRuleValue,
} from '../src/features/label-discovery/routing-rules.js';
import {
  TAXONOMY_LIMITS,
  sampleMessages,
  validateTaxonomyPlan,
  type PlannerMessage,
} from '../src/features/label-discovery/taxonomy-planner.js';

function message(input: Partial<PlannerMessage> & { id: string }): PlannerMessage {
  return {
    subject: 'Your application was received',
    senderName: 'LinkedIn Jobs',
    senderEmail: 'jobs-noreply@linkedin.com',
    internalDate: new Date('2026-08-01T00:00:00.000Z'),
    ...input,
  };
}

const sample: PlannerMessage[] = [
  message({ id: '1', subject: 'Your application was sent to Acme' }),
  message({
    id: '2',
    subject: 'Application received',
    senderEmail: 'no-reply@greenhouse.io',
    senderName: 'Greenhouse',
  }),
  message({
    id: '3',
    subject: 'Update on your application: not moving forward',
    senderEmail: 'notifications@jobright.ai',
    senderName: 'Jobright',
  }),
  message({
    id: '4',
    subject: 'Payment failed for your subscription',
    senderEmail: 'billing@vercel.com',
    senderName: 'Vercel',
  }),
];

function node(input: Record<string, unknown>) {
  return {
    name: 'Job hunt',
    depth: 1,
    parentPath: '',
    kind: 'CATEGORY',
    rationale: 'Mail about finding work arrives from many unrelated senders.',
    estimatedMessageCount: 40,
    rules: [],
    ...input,
  };
}

function plan(nodes: Array<Record<string, unknown>>) {
  return validateTaxonomyPlan(
    { nodes },
    { sample, existingGmailLabelNames: ['Receipts', 'Travel'] },
  );
}

describe('routing rules', () => {
  it('normalizes only values it can safely replay', () => {
    expect(normalizeRuleValue('SENDER_DOMAIN', '@LinkedIn.com')).toBe('linkedin.com');
    expect(normalizeRuleValue('SENDER_ADDRESS', 'Jobs-NoReply@linkedin.com')).toBe(
      'jobs-noreply@linkedin.com',
    );
    expect(normalizeRuleValue('SUBJECT_CONTAINS', '  Payment   FAILED ')).toBe('payment failed');
    // A bare public suffix would swallow the whole mailbox.
    expect(normalizeRuleValue('SENDER_DOMAIN', 'com')).toBeNull();
    expect(normalizeRuleValue('SUBJECT_CONTAINS', 'ok')).toBeNull();
  });

  it('matches subdomains for a domain rule but keeps an address rule exact', () => {
    const candidate = { subject: 'anything', senderEmail: 'alerts@mail.github.com' };
    expect(matchesRule({ kind: 'SENDER_DOMAIN', value: 'github.com' }, candidate)).toBe(true);
    expect(matchesRule({ kind: 'SENDER_ADDRESS', value: 'alerts@github.com' }, candidate)).toBe(
      false,
    );
  });

  it('resolves the most specific rule first', () => {
    const rules = [
      { kind: 'SUBJECT_CONTAINS' as const, value: 'application' },
      { kind: 'SENDER_ADDRESS' as const, value: 'jobs-noreply@linkedin.com' },
      { kind: 'SENDER_DOMAIN' as const, value: 'linkedin.com' },
    ].sort(
      (left, right) =>
        ({ SENDER_ADDRESS: 10, SENDER_DOMAIN: 20, SUBJECT_CONTAINS: 30 })[left.kind] -
        { SENDER_ADDRESS: 10, SENDER_DOMAIN: 20, SUBJECT_CONTAINS: 30 }[right.kind],
    );
    expect(findMatchingRule(rules, sample[0]!)?.kind).toBe('SENDER_ADDRESS');
  });

  it('counts matches across the sample', () => {
    expect(countRuleMatches({ kind: 'SUBJECT_CONTAINS', value: 'application' }, sample)).toBe(3);
  });
});

describe('taxonomy plan validation', () => {
  it('accepts a three-level tree and keeps the rules that match sampled mail', () => {
    const { nodes, warnings } = plan([
      node({}),
      node({
        name: 'Applications sent',
        depth: 2,
        parentPath: 'Job hunt',
        kind: 'TOPIC',
        estimatedMessageCount: 20,
        rules: [
          { kind: 'SENDER_DOMAIN', value: 'linkedin.com' },
          { kind: 'SENDER_DOMAIN', value: 'greenhouse.io' },
        ],
      }),
      node({
        name: 'Applications rejected',
        depth: 3,
        parentPath: 'Job hunt/Applications sent',
        kind: 'STATE',
        estimatedMessageCount: 5,
        rules: [{ kind: 'SUBJECT_CONTAINS', value: 'not moving forward' }],
      }),
    ]);

    expect(warnings).toEqual([]);
    expect(nodes.map((item) => item.path)).toEqual([
      'Job hunt',
      'Job hunt/Applications sent',
      'Job hunt/Applications sent/Applications rejected',
    ]);
    expect(nodes[0]?.isLeaf).toBe(false);
    expect(nodes[2]?.isLeaf).toBe(true);
    expect(nodes[1]?.matchedMessageCount).toBe(2);
  });

  it('rejects a state node whose subject pattern is absent from the sample', () => {
    const { nodes, warnings } = plan([
      node({}),
      node({
        name: 'Offers received',
        depth: 2,
        parentPath: 'Job hunt',
        kind: 'STATE',
        estimatedMessageCount: 9,
        rules: [{ kind: 'SUBJECT_CONTAINS', value: 'we are delighted to offer' }],
      }),
    ]);

    expect(nodes.map((item) => item.path)).toEqual(['Job hunt']);
    expect(warnings.join(' ')).toContain('matches no sampled mail');
    expect(warnings.join(' ')).toContain('no subject pattern');
  });

  it('rejects a level-3 node the model mislabels as a topic', () => {
    const { nodes } = plan([
      node({}),
      node({ name: 'Applications sent', depth: 2, parentPath: 'Job hunt', kind: 'TOPIC' }),
      node({
        name: 'Interview stage',
        depth: 3,
        parentPath: 'Job hunt/Applications sent',
        kind: 'TOPIC',
        estimatedMessageCount: 12,
        rules: [{ kind: 'SENDER_DOMAIN', value: 'linkedin.com' }],
      }),
    ]);

    expect(nodes.some((item) => item.name === 'Interview stage')).toBe(false);
  });

  it('drops names that are not sentence case, too long, or a person', () => {
    const { nodes, warnings } = plan([
      node({ name: 'Job Hunt' }),
      node({ name: 'Mail about looking for work' }),
      node({ name: 'Linkedin Jobs' }),
      node({ name: 'Notifications' }),
      node({ name: 'Receipts' }),
      node({ name: 'Money in' }),
    ]);

    expect(nodes.map((item) => item.name)).toEqual(['Money in']);
    expect(warnings.join(' ')).toContain('not sentence case');
    expect(warnings.join(' ')).toContain('longer than 3 words');
    expect(warnings.join(' ')).toContain('too generic');
    expect(warnings.join(' ')).toContain('Gmail already has a label named "Receipts"');
  });

  it('refuses a deeper tree than three levels', () => {
    const { nodes } = plan([
      node({}),
      node({ name: 'Applications sent', depth: 2, parentPath: 'Job hunt' }),
      node({
        name: 'Applications rejected',
        depth: 3,
        parentPath: 'Job hunt/Applications sent',
        kind: 'STATE',
        rules: [{ kind: 'SUBJECT_CONTAINS', value: 'not moving forward' }],
      }),
      node({
        name: 'Rejected early',
        depth: 4,
        parentPath: 'Job hunt/Applications sent/Applications rejected',
        kind: 'STATE',
        rules: [{ kind: 'SUBJECT_CONTAINS', value: 'not moving forward' }],
      }),
    ]);

    expect(nodes.every((item) => item.depth <= TAXONOMY_LIMITS.maxDepth)).toBe(true);
    expect(nodes.some((item) => item.name === 'Rejected early')).toBe(false);
  });

  it('drops a leaf that too little mail would reach', () => {
    const { nodes, warnings } = plan([node({ name: 'Side gigs', estimatedMessageCount: 2 })]);

    expect(nodes).toEqual([]);
    expect(warnings.join(' ')).toContain('below the 3 a folder needs');
  });

  it('reuses a name only once across the whole tree', () => {
    const { nodes } = plan([
      node({}),
      node({ name: 'Money', estimatedMessageCount: 30 }),
      node({
        name: 'Rejected',
        depth: 2,
        parentPath: 'Job hunt',
        kind: 'STATE',
        rules: [{ kind: 'SUBJECT_CONTAINS', value: 'not moving forward' }],
      }),
      node({
        name: 'Rejected',
        depth: 2,
        parentPath: 'Money',
        kind: 'STATE',
        rules: [{ kind: 'SUBJECT_CONTAINS', value: 'payment failed' }],
      }),
    ]);

    expect(nodes.filter((item) => item.name === 'Rejected')).toHaveLength(1);
  });

  it('gives a rule value to exactly one folder', () => {
    const { nodes, warnings } = plan([
      node({
        name: 'Job hunt',
        rules: [{ kind: 'SENDER_DOMAIN', value: 'linkedin.com' }],
      }),
      node({
        name: 'Money in',
        rules: [{ kind: 'SENDER_DOMAIN', value: 'linkedin.com' }],
      }),
    ]);

    expect(nodes.find((item) => item.name === 'Job hunt')?.rules).toHaveLength(1);
    expect(nodes.find((item) => item.name === 'Money in')?.rules).toHaveLength(0);
    expect(warnings.join(' ')).toContain('already routes it');
  });

  it('keeps at most the leaf limit, preferring folders real mail reaches', () => {
    const nodes = Array.from({ length: TAXONOMY_LIMITS.maxLeaves + 5 }, (_, index) =>
      node({
        name: `Topic ${index}`,
        estimatedMessageCount: 10,
        rules: index === 0 ? [{ kind: 'SUBJECT_CONTAINS', value: 'payment failed' }] : [],
      }),
    );
    const result = plan(nodes);

    expect(result.nodes).toHaveLength(TAXONOMY_LIMITS.maxLeaves);
    expect(result.nodes.some((item) => item.name === 'Topic 0')).toBe(true);
    expect(result.warnings.join(' ')).toContain('exceeded the 40-folder limit');
  });

  it('rejects output that is not shaped like a plan', () => {
    expect(() => plan([node({ name: 42 as unknown as string })])).toThrow(
      'Gemini returned an unusable taxonomy.',
    );
  });
});

describe('sampling', () => {
  it('covers every sender before taking a second message from any of them', () => {
    const messages = [
      ...Array.from({ length: 30 }, (_, index) =>
        message({ id: `bulk-${index}`, senderEmail: 'news@bulk.com' }),
      ),
      message({ id: 'rare', senderEmail: 'someone@rare.com' }),
    ];

    const sampled = sampleMessages(messages, 5);

    expect(sampled).toHaveLength(5);
    expect(sampled.some((item) => item.senderEmail === 'someone@rare.com')).toBe(true);
  });

  it('never returns more than the limit', () => {
    const messages = Array.from({ length: 40 }, (_, index) => message({ id: `m-${index}` }));
    expect(sampleMessages(messages, 12)).toHaveLength(12);
  });
});

describe('label naming helpers kept for duplicate detection', () => {
  it('still rejects reserved, nested, and pictographic names', () => {
    expect(() => validateLeafName('INBOX')).toThrow('LABEL_CANDIDATE_NAME_INVALID');
    expect(() => validateLeafName('Unsafe/Child')).toThrow('LABEL_CANDIDATE_NAME_INVALID');
    expect(() => validateLeafName('🔐 Security')).toThrow('LABEL_CANDIDATE_NAME_INVALID');
  });

  it('detects near-duplicate names on confirm', () => {
    expect(normalizeLabelForComparison('MailMind/Job hunt')).toBe('jobhunt');
    expect(labelsAreSimilar('Job hunt', 'Job hunts')).toBe(true);
    expect(labelsAreSimilar('Job hunt', 'Money in')).toBe(false);
    expect(isGenericLabelName('Notifications')).toBe(true);
  });
});
