import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `useReducedMotion` is mocked rather than driven through `matchMedia`, because motion/react reads
 * the media query once into module state — the first test to render would decide the answer for
 * every test after it. What is under test here is our own branch anyway: given the reader has asked
 * for less motion, what do these hooks hand to a component?
 */
const reduceMotion = vi.hoisted(() => ({ value: false }));

vi.mock('motion/react', () => ({
  useReducedMotion: () => reduceMotion.value,
}));

import { MOTION, useEntrance, useReveal } from './motion';

beforeEach(() => {
  reduceMotion.value = false;
});

describe('the shared motion rhythm', () => {
  /**
   * The reason every animation on the public pages is routed through these hooks. A CSS media query
   * cannot reach a transform driven by JavaScript, so `prefers-reduced-motion` has to be honoured
   * in the props themselves — and returning an empty object, rather than a shorter animation, is
   * the only version that guarantees nothing moves.
   */
  it('returns no animation props at all when less motion is asked for', () => {
    reduceMotion.value = true;

    const reveal = renderHook(() => useReveal()).result.current;
    const entrance = renderHook(() => useEntrance()).result.current;

    expect(reveal(0)).toEqual({});
    expect(reveal(3)).toEqual({});
    expect(entrance(0)).toEqual({});
    expect(entrance(4)).toEqual({});
  });

  it('animates ordinarily when it has not been', () => {
    const props = renderHook(() => useReveal()).result.current(0);

    expect(props.initial).toEqual({ opacity: 0, y: 20 });
    expect(props.whileInView).toEqual({ opacity: 1, y: 0 });
    // Once. A section that re-animates every time it scrolls past is noise, not feedback.
    expect(props.viewport).toMatchObject({ once: true });
  });

  it('staggers siblings by the shared step rather than an ad-hoc delay', () => {
    const reveal = renderHook(() => useReveal()).result.current;

    expect(reveal(0).transition).toMatchObject({ delay: 0 });
    expect(reveal(3).transition).toMatchObject({ delay: 3 * MOTION.stagger });
  });

  /**
   * The guidance the durations came from: micro-interactions at 150-300ms, anything more elaborate
   * capped at 400ms. The landing page previously ran an 0.8s heading and a 1.15s image wipe, so
   * this is pinned rather than left to the next person's judgement.
   */
  it('keeps every duration inside the ceiling', () => {
    for (const duration of Object.values(MOTION.duration)) {
      expect(duration).toBeGreaterThan(0);
      expect(duration).toBeLessThanOrEqual(0.4);
    }
    // 30-50ms between items: readable as a sequence without making the last one feel late.
    expect(MOTION.stagger).toBeGreaterThanOrEqual(0.03);
    expect(MOTION.stagger).toBeLessThanOrEqual(0.05);
  });
});
