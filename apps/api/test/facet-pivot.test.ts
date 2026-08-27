import { describe, expect, it } from 'vitest';

import {
  ALTERNATE_PIVOT,
  DEFAULT_PIVOT,
  buildPivot,
  pivotLeafFor,
  pivotLeafName,
  type FacetedMessage,
} from '../src/features/label-discovery/pivot.js';

let counter = 0;
function facets(
  entity: string | null,
  domain: string | null,
  intent: string | null,
  times = 1,
): FacetedMessage[] {
  return Array.from({ length: times }, () => ({
    id: `m${(counter += 1)}`,
    entity,
    domain,
    intent,
  }));
}

const mailbox: FacetedMessage[] = [
  ...facets('netflix', 'entertainment', 'payment-failed', 8),
  ...facets('netflix', 'entertainment', 'promotional', 12),
  ...facets('coursera', 'education', 'payment-failed', 6),
  ...facets('coursera', 'education', 'newsletter', 9),
  ...facets('github', 'development', 'security-alert', 7),
];

describe('pivot names', () => {
  it('opens a facet value out into a folder name', () => {
    expect(pivotLeafName('payment-failed')).toBe('Payment failed');
    expect(pivotLeafName('netflix')).toBe('Netflix');
    expect(pivotLeafName('system-notification')).toBe('System notification');
  });

  it('spells a brand the way the brand spells it', () => {
    expect(pivotLeafName('linkedin', 'entity')).toBe('LinkedIn');
    expect(pivotLeafName('github', 'entity')).toBe('GitHub');
    expect(pivotLeafName('openai', 'entity')).toBe('OpenAI');
    // Only the entity facet is a brand; an intent of the same spelling is not.
    expect(pivotLeafName('linkedin')).toBe('Linkedin');
  });

  it('refuses a value Gmail cannot carry as a label', () => {
    expect(pivotLeafName('inbox')).toBeNull();
    expect(pivotLeafName('a')).toBeNull();
    expect(pivotLeafName('')).toBeNull();
  });
});

describe('the entity-first pivot', () => {
  const result = buildPivot(mailbox, DEFAULT_PIVOT, { minMessages: 5 });

  it('puts the brand on top and the intent beneath it', () => {
    expect(result.order).toEqual(['entity', 'intent']);
    const paths = result.nodes.filter((node) => node.isLeaf).map((node) => node.path);
    expect(paths).toContain('Netflix/Payment failed');
    expect(paths).toContain('Coursera/Newsletter');
  });

  it('makes a folder for each level and roots them under MailMind', () => {
    const netflix = result.nodes.find((node) => node.path === 'Netflix');
    expect(netflix).toMatchObject({ depth: 1, isLeaf: false, subtreeMessageCount: 20 });
    const failed = result.nodes.find((node) => node.path === 'Netflix/Payment failed');
    expect(failed).toMatchObject({ depth: 2, isLeaf: true, messageCount: 8 });
    expect(failed?.fullPath).toBe('MailMind/Netflix/Payment failed');
  });

  it('repeats a lower-level name under two different parents', () => {
    const failing = result.nodes.filter((node) => node.leafName === 'Payment failed');
    expect(failing.map((node) => node.path).sort()).toEqual([
      'Coursera/Payment failed',
      'Netflix/Payment failed',
    ]);
  });

  it('files every message that has both facets', () => {
    const filed = result.nodes.reduce((total, node) => total + node.messageCount, 0);
    expect(filed).toBe(mailbox.length);
    expect(result.unfiled.total).toBe(0);
  });
});

describe('the domain-first pivot', () => {
  it('describes the same mail arranged by what it is about', () => {
    const result = buildPivot(mailbox, ALTERNATE_PIVOT, { minMessages: 5 });
    expect(result.order).toEqual(['domain', 'intent', 'entity']);
    const paths = result.nodes.map((node) => node.path);
    expect(paths).toContain('Entertainment');
    expect(paths).toContain('Entertainment/Payment failed');
    // Depth 3 only survives where one brand carries the whole combination, which is the point:
    // the third level exists to separate brands, not to repeat a single one.
    expect(paths).toContain('Entertainment/Payment failed/Netflix');
  });

  it('never goes deeper than the tree allows, whatever the ordering asks for', () => {
    const result = buildPivot(mailbox, ['domain', 'intent', 'entity'], { minMessages: 1 });
    expect(Math.max(...result.nodes.map((node) => node.depth))).toBeLessThanOrEqual(3);
  });
});

describe('collapsing small folders', () => {
  const sparse: FacetedMessage[] = [
    ...facets('netflix', 'entertainment', 'promotional', 12),
    // Two messages: a folder of its own would be clutter.
    ...facets('netflix', 'entertainment', 'survey-feedback', 2),
    // A brand with barely any mail at all.
    ...facets('tinyvendor', 'shopping', 'invoice-receipt', 2),
  ];

  it('leaves a below-threshold intent out of the tree', () => {
    const result = buildPivot(sparse, DEFAULT_PIVOT, { minMessages: 5 });
    expect(result.nodes.map((node) => node.path)).not.toContain('Netflix/Survey feedback');
    expect(result.collapsed).toBeGreaterThan(0);
  });

  it('keeps mail out of a folder that has children, rather than inventing one', () => {
    const result = buildPivot(sparse, DEFAULT_PIVOT, { minMessages: 5 });
    const netflix = result.nodes.find((node) => node.path === 'Netflix')!;
    expect(netflix.isLeaf).toBe(false);
    expect(netflix.messageCount).toBe(0);
    // The two collapsed messages stay in the inbox and are counted, not hidden.
    expect(result.unfiled.belowThreshold).toBe(4);
  });

  it('drops a brand too small to deserve a folder at all', () => {
    const result = buildPivot(sparse, DEFAULT_PIVOT, { minMessages: 5 });
    expect(result.nodes.map((node) => node.path)).not.toContain('Tinyvendor');
  });

  it('honours a lower threshold, which is what makes N configurable', () => {
    const result = buildPivot(sparse, DEFAULT_PIVOT, { minMessages: 2 });
    const paths = result.nodes.map((node) => node.path);
    expect(paths).toContain('Netflix/Survey feedback');
    expect(paths).toContain('Tinyvendor/Invoice receipt');
    expect(result.unfiled.total).toBe(0);
  });
});

describe('messages missing a facet', () => {
  it('files a message one level up when its deeper facet is unknown', () => {
    const messages = [...facets('netflix', 'entertainment', null, 6)];
    const result = buildPivot(messages, DEFAULT_PIVOT, { minMessages: 5 });
    const netflix = result.nodes.find((node) => node.path === 'Netflix')!;
    expect(netflix.isLeaf).toBe(true);
    expect(netflix.messageCount).toBe(6);
  });

  it('leaves a message in the inbox when the top facet is unknown', () => {
    const messages = [...facets(null, 'finance', 'payment-failed', 9)];
    const result = buildPivot(messages, DEFAULT_PIVOT, { minMessages: 5 });
    expect(result.nodes).toHaveLength(0);
    expect(result.unfiled.noFacetValue).toBe(9);
  });
});

describe('resolving one message to its folder', () => {
  const result = buildPivot(mailbox, DEFAULT_PIVOT, { minMessages: 5 });

  it('returns the deepest surviving leaf', () => {
    const leaf = pivotLeafFor(
      { id: 'x', entity: 'netflix', domain: 'entertainment', intent: 'payment-failed' },
      result,
    );
    expect(leaf?.fullPath).toBe('MailMind/Netflix/Payment failed');
  });

  it('returns nothing when the message would land on a branch', () => {
    const leaf = pivotLeafFor(
      { id: 'x', entity: 'netflix', domain: 'entertainment', intent: 'survey-feedback' },
      result,
    );
    expect(leaf).toBeNull();
  });

  it('returns nothing for a brand with no folder', () => {
    expect(
      pivotLeafFor({ id: 'x', entity: 'unknownbrand', domain: null, intent: null }, result),
    ).toBeNull();
  });
});

/**
 * Knowing where the new mail is, without opening anything.
 *
 * The subtree number is the one that matters on a collapsed parent: unread mail three levels down
 * is still mail you have not seen, and a folder that stayed quiet about it would send you hunting
 * through every child.
 */
describe('unread counts', () => {
  const mail = (id: string, intent: string, unread: boolean) => ({
    id,
    entity: 'netflix',
    domain: 'finance',
    intent,
    unread,
  });

  it('rolls unread mail up to every ancestor, not just the folder it sits in', () => {
    const pivot = buildPivot(
      [
        mail('a', 'payment-failed', true),
        mail('b', 'payment-failed', false),
        mail('c', 'payment-failed', true),
      ],
      ['entity', 'intent'],
      { minMessages: 3 },
    );

    const brand = pivot.nodes.find((node) => node.facetKey === 'entity=netflix')!;
    const leaf = pivot.nodes.find((node) => node.facetKey.includes('intent='))!;
    expect(leaf.unreadCount).toBe(2);
    expect(brand.subtreeUnreadCount).toBe(2);
  });

  // A message with no `unread` field is treated as read, so an older caller keeps working.
  it('treats an unspecified message as read rather than as new', () => {
    const pivot = buildPivot(
      [
        { id: 'a', entity: 'netflix', domain: null, intent: null },
        { id: 'b', entity: 'netflix', domain: null, intent: null },
      ],
      ['entity'],
      { minMessages: 1 },
    );

    expect(pivot.nodes[0]!.unreadCount).toBe(0);
  });

  /**
   * A branch cannot hold mail of its own — only leaves exist in Gmail — so its own mail goes to
   * the inbox and its own unread count goes with it. What is unread beneath it is untouched.
   */
  it('moves a branch’s own unread count to the inbox with its mail', () => {
    const pivot = buildPivot(
      [
        mail('a', 'payment-failed', true),
        mail('b', 'payment-failed', true),
        { id: 'c', entity: 'netflix', domain: 'finance', intent: null, unread: true },
      ],
      ['entity', 'intent'],
      { minMessages: 2 },
    );

    const brand = pivot.nodes.find((node) => node.facetKey === 'entity=netflix')!;
    expect(brand.isLeaf).toBe(false);
    expect(brand.messageCount).toBe(0);
    expect(brand.unreadCount).toBe(0);
    // Still three unread beneath it, including the one that had nowhere of its own to go.
    expect(brand.subtreeUnreadCount).toBe(3);
  });
});
