import { describe, expect, it } from 'vitest';

import { canonicalWatchKey, watchedFirst, watchStateOf } from './watches';

describe('watches', () => {
  it('names one watch the same way whichever arrangement it came from', () => {
    expect(canonicalWatchKey('intent=offer|entity=applyboard')).toBe(
      'entity=applyboard|intent=offer',
    );
  });

  it('tells a watched folder from one a broader watch covers and one on the way to a watch', () => {
    const watches = ['entity=applyboard'];
    expect(watchStateOf('entity=applyboard', watches)).toBe('watched');
    expect(watchStateOf('entity=applyboard|intent=offer', watches)).toBe('covered');
    expect(watchStateOf('intent=offer|entity=applyboard', watches)).toBe('covered');
    expect(watchStateOf('entity=netflix', watches)).toBeNull();

    const narrow = ['entity=applyboard|intent=offer'];
    expect(watchStateOf('entity=applyboard', narrow)).toBe('leads');
    expect(watchStateOf('intent=offer', narrow)).toBe('leads');
    expect(watchStateOf('intent=offer|entity=applyboard', narrow)).toBe('watched');
  });

  it('moves watched folders to the front and keeps the rest in order', () => {
    const nodes = ['entity=a', 'entity=b', 'entity=c'].map((facetKey) => ({ facetKey }));
    const { ordered, pinned } = watchedFirst(nodes, ['entity=c']);
    expect(ordered.map((node) => node.facetKey)).toEqual(['entity=c', 'entity=a', 'entity=b']);
    expect(pinned).toBe(1);
    expect(watchedFirst(nodes, []).ordered).toBe(nodes);
  });
});
