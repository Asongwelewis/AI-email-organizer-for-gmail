import { ClassificationError } from '../classification.errors.js';
import type {
  ClassificationInput,
  EmailClassifierProvider,
  ProviderContext,
  ProviderClassificationResult,
} from '../classification.types.js';

export class DisabledClassifierProvider implements EmailClassifierProvider {
  readonly name = 'disabled';
  readonly model = null;
  readonly enabled = false;

  classify(
    _input: ClassificationInput,
    _context: ProviderContext,
  ): Promise<ProviderClassificationResult> {
    return Promise.reject(
      new ClassificationError(
        'CLASSIFICATION_DISABLED',
        'External classification is disabled. High-confidence rules remain available.',
        503,
        false,
      ),
    );
  }
}
