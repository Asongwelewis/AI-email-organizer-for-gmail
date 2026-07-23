import { LABEL_CONFIDENCE_WEIGHTS } from './label-discovery.taxonomy.js';

export interface ConfidenceSignals {
  sourceConsistency: number;
  messageCount: number;
  minimumMessages: number;
  categoryAgreement: number;
  recent: boolean;
  threadCount: number;
  namingConfidence: number;
  userCorrectionSupport: number;
  temporary: boolean;
  generic: boolean;
  existingLabelSimilarity: boolean;
  sparseDistribution: boolean;
}

const clamp = (value: number) => Math.max(0, Math.min(1, value));

export function calculateLabelConfidence(signals: ConfidenceSignals): number {
  const volume = clamp(signals.messageCount / Math.max(signals.minimumMessages * 3, 1));
  const threadDiversity = clamp(signals.threadCount / Math.max(signals.messageCount, 1) / 0.5);
  const weighted =
    clamp(signals.sourceConsistency) * LABEL_CONFIDENCE_WEIGHTS.sourceConsistency +
    volume * LABEL_CONFIDENCE_WEIGHTS.messageVolume +
    clamp(signals.categoryAgreement) * LABEL_CONFIDENCE_WEIGHTS.categoryAgreement +
    (signals.recent ? 1 : 0.35) * LABEL_CONFIDENCE_WEIGHTS.recency +
    threadDiversity * LABEL_CONFIDENCE_WEIGHTS.threadDiversity +
    clamp(signals.namingConfidence) * LABEL_CONFIDENCE_WEIGHTS.namingConfidence +
    clamp(signals.userCorrectionSupport) * LABEL_CONFIDENCE_WEIGHTS.userCorrectionSupport;
  const penalty =
    (signals.temporary ? 0.25 : 0) +
    (signals.generic ? 0.25 : 0) +
    (signals.existingLabelSimilarity ? 0.18 : 0) +
    (signals.sparseDistribution ? 0.08 : 0);
  return Number(clamp(weighted - penalty).toFixed(4));
}
