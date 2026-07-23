import type {
  ClassificationInput,
  EmailClassifierProvider,
  ProviderContext,
  ProviderClassificationResult,
} from '../classification.types.js';

export class MockClassifierProvider implements EmailClassifierProvider {
  readonly name = 'mock';
  readonly model = 'deterministic-mock-v1';
  readonly enabled = true;

  classify(
    input: ClassificationInput,
    context: ProviderContext,
  ): Promise<ProviderClassificationResult> {
    const signal = context.ruleSignals[0];
    return Promise.resolve({
      output: signal
        ? { ...signal, confidence: Math.min(0.92, signal.confidence + 0.04), requiresReview: false }
        : {
            category: input.sameDomain ? 'WORK' : 'OTHER',
            recommendedAction: input.isImportant ? 'KEEP_IN_INBOX' : 'REVIEW_REQUIRED',
            confidence: input.sameDomain ? 0.76 : 0.45,
            reasonCodes: input.sameDomain ? ['MODEL_METADATA_EVIDENCE'] : ['INSUFFICIENT_EVIDENCE'],
            explanation: input.sameDomain
              ? 'Sender and recipient domains match, which is a useful work signal.'
              : 'The available metadata is insufficient for a confident recommendation.',
            requiresReview: !input.sameDomain,
          },
      inputUnits: JSON.stringify(input).length,
      outputUnits: 0,
    });
  }
}
