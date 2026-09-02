import { describe, expect, it } from 'vitest';

import { entityFor } from '../src/features/label-discovery/entity.js';

/**
 * The `entity` facet is derived from the envelope in code, never asked of a model, because a brand
 * is a fact rather than a judgement. These are the cases where reading the domain alone gets that
 * fact wrong.
 */
describe('the brand behind a sender', () => {
  /**
   * Found on a real mailbox: ByteByteGo, System Design Nuggets, Lenny's Newsletter and four other
   * publications had all collapsed into one `substack` folder holding a scattered pile of
   * unrelated newsletters. Every Substack publication sends from `<publication>@substack.com`, so
   * the registrable domain is the platform and the brand is the local part.
   */
  it('separates publications that share a hosting platform', () => {
    expect(entityFor('bytebytego@substack.com')).toBe('bytebytego');
    expect(entityFor('designgurus@substack.com')).toBe('designgurus');
    expect(entityFor('lenny@substack.com')).toBe('lenny');
    // Different publications, so different folders — which is the entire point.
    expect(entityFor('bytebytego@substack.com')).not.toBe(entityFor('lenny@substack.com'));
  });

  /**
   * Plus-addressing is one more send from the same publication, not a new one. Treating the tag as
   * part of the name would file every campaign into a folder of its own — the clutter this facet
   * exists to remove, arrived at from the other direction.
   */
  it('ignores a plus tag, which names a campaign rather than a sender', () => {
    expect(entityFor('nextplayso+should-you-join@substack.com')).toBe(
      entityFor('nextplayso@substack.com'),
    );
  });

  // `no-reply@substack.com` is Substack writing to you, and a folder called "No reply" is nonsense.
  it('leaves the platform speaking for itself under the platform', () => {
    expect(entityFor('no-reply@substack.com')).toBe('substack');
    expect(entityFor('post+the-weekender@substack.com')).toBe('substack');
    expect(entityFor('noreply@medium.com')).toBe('medium');
  });

  it('changes nothing for a domain that is its own brand', () => {
    expect(entityFor('jobs@linkedin.com')).toBe('linkedin');
    expect(entityFor('billing@netflix.com')).toBe('netflix');
    expect(entityFor('someone@bbc.co.uk')).toBe('bbc');
    // A subdomain still resolves through the registrable domain.
    expect(entityFor('no-reply@m.learn.coursera.org')).toBe('coursera');
  });

  it('still answers null when there is no usable sender', () => {
    expect(entityFor(null)).toBeNull();
    expect(entityFor('')).toBeNull();
    expect(entityFor('not-an-address')).toBeNull();
  });
});
