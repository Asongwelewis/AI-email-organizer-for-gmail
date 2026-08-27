import { useReducedMotion, type MotionProps } from 'motion/react';

/**
 * One rhythm for the whole public surface.
 *
 * Motion reads as quality only when everything moves to the same beat. Before this, the landing
 * page had a 1.15s clip-path wipe next to an 0.8s heading next to library-default fades, with
 * stagger at 80ms and 100ms in two places — every piece defensible alone, and together a page that
 * feels assembled rather than designed.
 *
 * The numbers come from the platform guidance rather than taste: micro-interactions land at
 * 150–300ms, anything more elaborate stays at or under 400ms, and list stagger sits at 30–50ms —
 * enough to read as a sequence, not enough to make the last item feel late.
 */
export const MOTION = {
  duration: {
    /** Presses, hovers, and anything that must feel instant. */
    fast: 0.18,
    /** The default for a single element arriving. */
    base: 0.28,
    /** Larger or more elaborate moves. The ceiling, not a starting point. */
    slow: 0.4,
  },
  ease: {
    /** Entering. Decelerating, so an element settles rather than stops. */
    out: [0.22, 1, 0.36, 1],
    /** Leaving. Accelerating away, and shorter than the entrance it reverses. */
    in: [0.55, 0, 1, 0.45],
  },
  /** 40ms between siblings. */
  stagger: 0.04,
} as const;

/**
 * How far something travels on its way in.
 *
 * Small on purpose. A long slide reads as decoration; a short one reads as the element taking its
 * place, which is the only thing the movement is meant to say.
 */
const TRAVEL = 20;

/**
 * Reveal-on-scroll props, or nothing at all when the reader asked for less motion.
 *
 * Returning an empty object under `prefers-reduced-motion` is the whole point of routing every
 * animation through here. A CSS media query cannot reach a transform driven by JavaScript, so the
 * page previously animated regardless of the system setting — the parallax included, which is the
 * one most likely to make somebody feel ill.
 *
 * `once: true` because a section that re-animates every time it scrolls past stops being feedback
 * and becomes noise. The negative bottom margin starts the reveal slightly before the element is
 * fully in view, so it is already settled by the time it is being read.
 */
export function useReveal(): (index?: number) => MotionProps {
  const reduceMotion = useReducedMotion();

  return (index = 0) => {
    if (reduceMotion) return {};
    return {
      initial: { opacity: 0, y: TRAVEL },
      whileInView: { opacity: 1, y: 0 },
      viewport: { once: true, amount: 0.25, margin: '0px 0px -8% 0px' },
      transition: {
        duration: MOTION.duration.slow,
        ease: MOTION.ease.out,
        delay: index * MOTION.stagger,
      },
    };
  };
}

/**
 * The same thing for content already on screen at load, where there is nothing to scroll into.
 *
 * The hero uses this. Its delays are deliberately short: the primary action used to arrive half a
 * second after the page did, which is half a second of a visitor looking at a page they cannot yet
 * act on.
 */
export function useEntrance(): (index?: number) => MotionProps {
  const reduceMotion = useReducedMotion();

  return (index = 0) => {
    if (reduceMotion) return {};
    return {
      initial: { opacity: 0, y: TRAVEL },
      animate: { opacity: 1, y: 0 },
      transition: {
        duration: MOTION.duration.slow,
        ease: MOTION.ease.out,
        delay: index * MOTION.stagger,
      },
    };
  };
}
