import { describe, expect, it } from 'vitest';

import { parseGoldenSet, goldenSetCoverage } from '../src/features/evaluation/golden-set.js';
import {
  calibrationError,
  confusionMatrix,
  facetReport,
  perValueMetrics,
  reliabilityCurve,
  thresholdSweep,
  type LabelledDecision,
} from '../src/features/evaluation/metrics.js';

const decision = (
  expected: string | null,
  actual: string | null,
  confidence = 1,
  id = `${expected}-${actual}-${confidence}`,
): LabelledDecision => ({ id, expected, actual, confidence });

/**
 * Card 27. `report-facets.ts` prints distributions, and a distribution is not correctness — a
 * classifier that answers "newsletter" to everything produces a perfectly plausible one. These are
 * the numbers that can tell those apart, so the arithmetic is what has to be right.
 */
describe('precision and recall per facet value', () => {
  it('separates being right often from being right about this value', () => {
    // Nine of ten are `newsletter` and the classifier says `newsletter` to everything. Accuracy is
    // 90%; recall on `payment-failed` is zero. This is the exact failure a distribution hides.
    const decisions = [
      ...Array.from({ length: 9 }, (_, index) =>
        decision('newsletter', 'newsletter', 1, `n${index}`),
      ),
      decision('payment-failed', 'newsletter', 1, 'p0'),
    ];

    const metrics = perValueMetrics(decisions);
    const newsletter = metrics.find((value) => value.value === 'newsletter')!;
    const failed = metrics.find((value) => value.value === 'payment-failed')!;

    expect(newsletter.recall).toBe(1);
    expect(newsletter.precision).toBeCloseTo(0.9);
    expect(failed.support).toBe(1);
    expect(failed.recall).toBe(0);
    expect(failed.f1).toBe(0);
    // Macro rather than weighted, so failing every rare value cannot be averaged away.
    expect(facetReport('intent', decisions).macroF1).toBeLessThan(0.5);
  });

  /**
   * A value nothing is ever filed into looks identical to a value that does not exist, unless the
   * report keeps it. That is the most important row on the page and the easiest one to drop.
   */
  it('keeps a value the classifier never returns, at recall zero', () => {
    const metrics = perValueMetrics([decision('security-alert', 'newsletter')]);

    expect(metrics.map((value) => value.value)).toContain('security-alert');
    expect(metrics.find((value) => value.value === 'security-alert')).toMatchObject({
      support: 1,
      predicted: 0,
      recall: 0,
      precision: 0,
    });
  });

  // "No value fits" is an answer, not missing data, so it is scored as a value like any other.
  it('scores a correct UNKNOWN as correct', () => {
    const report = facetReport('domain', [decision(null, null)]);

    expect(report.accuracy).toBe(1);
    expect(report.perValue[0]).toMatchObject({ value: 'UNKNOWN', truePositives: 1 });
  });
});

describe('the confusion matrix', () => {
  it('names what was mistaken for what, commonest first', () => {
    const cells = confusionMatrix([
      decision('education', 'finance', 1, 'a'),
      decision('education', 'finance', 1, 'b'),
      decision('education', 'education', 1, 'c'),
    ]);

    expect(cells[0]).toEqual({ expected: 'education', actual: 'finance', count: 2 });
    expect(cells).toContainEqual({ expected: 'education', actual: 'education', count: 1 });
  });
});

/**
 * The reliability curve is what the card exists for. `AUTOMATION_CONFIDENCE_THRESHOLD = 0.8` is a
 * guess against an unmeasured distribution and it is choosing the review-queue volume by accident:
 * 916 messages are held on it.
 */
describe('the reliability curve', () => {
  it('catches a classifier that is confident and wrong', () => {
    // Ten decisions all claiming 0.95; six are right. Claimed 95%, observed 60%.
    const decisions = [
      ...Array.from({ length: 6 }, (_, index) => decision('finance', 'finance', 0.95, `r${index}`)),
      ...Array.from({ length: 4 }, (_, index) =>
        decision('finance', 'education', 0.95, `w${index}`),
      ),
    ];

    const bin = reliabilityCurve(decisions).find((candidate) => candidate.count > 0)!;

    expect(bin.meanConfidence).toBeCloseTo(0.95);
    expect(bin.accuracy).toBeCloseTo(0.6);
    // Negative is the dangerous direction: it claims more than it delivers.
    expect(bin.gap).toBeLessThan(0);
    expect(calibrationError(reliabilityCurve(decisions))).toBeCloseTo(0.35);
  });

  // The top bin closes at 1 rather than being half-open, or a confidence of exactly 1.0 — which
  // every rule-decided facet carries — would fall out of the curve entirely.
  it('counts a confidence of exactly 1.0', () => {
    const bins = reliabilityCurve([decision('finance', 'finance', 1)]);

    expect(bins.at(-1)).toMatchObject({ count: 1, accuracy: 1 });
    expect(bins.reduce((sum, bin) => sum + bin.count, 0)).toBe(1);
  });

  it('lets an empty bin contribute nothing rather than a zero', () => {
    const bins = reliabilityCurve([decision('finance', 'finance', 0.95)]);

    expect(bins.filter((bin) => bin.count === 0).every((bin) => bin.gap === 0)).toBe(true);
    expect(calibrationError(bins)).toBeCloseTo(0.05);
  });
});

/**
 * The threshold sweep turns "916 held for review" from a number nobody chose into one somebody
 * can. Each row says what filing unattended at that bar would actually cost.
 */
describe('what a threshold would cost', () => {
  const decisions = [
    decision('finance', 'finance', 0.95, 'a'),
    decision('finance', 'finance', 0.85, 'b'),
    decision('finance', 'education', 0.75, 'c'),
    decision('finance', 'finance', 0.55, 'd'),
  ];

  it('reports what each bar files, and how much of that is wrong', () => {
    const sweep = thresholdSweep(decisions, [0.5, 0.8]);

    expect(sweep[0]).toMatchObject({
      threshold: 0.5,
      autoFiled: 4,
      heldForReview: 0,
      // One of four filed was wrong.
      precisionOfAutoFiled: 0.75,
    });
    expect(sweep[1]).toMatchObject({ threshold: 0.8, autoFiled: 2, precisionOfAutoFiled: 1 });
  });

  /**
   * The cost of a high bar is correct work sent to a person anyway. Reporting only what the
   * threshold catches, and never what it wastes, is how a threshold ratchets upward forever.
   */
  it('counts the correct decisions a threshold holds back', () => {
    const [strict] = thresholdSweep(decisions, [0.9]);

    expect(strict).toMatchObject({ autoFiled: 1, heldForReview: 3, correctHeldBack: 2 });
  });
});

describe('the golden set itself', () => {
  const entry = {
    gmailMessageId: 'g-1',
    subject: 'A subject',
    senderEmail: 'a@example.com',
    snippet: '',
    expectedDomain: 'finance',
    expectedIntent: 'payment-failed',
  };

  it('accepts a labelled set and reports what it covers', () => {
    const set = parseGoldenSet({ entries: [entry] });

    expect(goldenSetCoverage(set)).toMatchObject({ entries: 1, unlabelled: 0 });
  });

  /**
   * An empty set, or one labelling the same message twice, produces a confident-looking report
   * about nothing. Both are likelier than a malformed file and neither would throw on its own.
   */
  it('refuses a set that would measure nothing', () => {
    expect(() => parseGoldenSet({ entries: [] })).toThrow();
    expect(() => parseGoldenSet({ entries: [entry, entry] })).toThrow();
  });

  // A drawn-but-unfilled row scores as "no value fits", which is almost never what was meant.
  it('counts rows nobody has labelled yet', () => {
    const set = parseGoldenSet({
      entries: [{ ...entry, expectedDomain: null, expectedIntent: null }],
    });

    expect(goldenSetCoverage(set).unlabelled).toBe(1);
  });

  it('refuses a facet value that is not one', () => {
    expect(() =>
      parseGoldenSet({ entries: [{ ...entry, expectedDomain: 'Finance Ltd' }] }),
    ).toThrow();
  });
});
