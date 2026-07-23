import { z } from 'zod';

import {
  CLASSIFICATION_CATEGORIES,
  REASON_CODES,
  RECOMMENDED_ACTIONS,
} from './classification-taxonomy.js';
import type { ClassificationOutput } from './classification.types.js';
import { ClassificationError } from './classification.errors.js';

const outputSchema = z
  .object({
    category: z.enum(CLASSIFICATION_CATEGORIES),
    recommendedAction: z.enum(RECOMMENDED_ACTIONS),
    confidence: z.number().finite().min(0).max(1),
    reasonCodes: z.array(z.enum(REASON_CODES)).max(8),
    explanation: z.string().trim().min(1).max(400),
    requiresReview: z.boolean(),
  })
  .strict();

export function validateClassificationOutput(value: unknown): ClassificationOutput {
  let candidate = value;
  if (typeof value === 'string') {
    try {
      candidate = JSON.parse(value);
    } catch {
      throw invalidResponse();
    }
  }
  const parsed = outputSchema.safeParse(candidate);
  if (!parsed.success) throw invalidResponse();
  return parsed.data;
}

function invalidResponse(): ClassificationError {
  return new ClassificationError(
    'CLASSIFICATION_INVALID_RESPONSE',
    'The classifier returned an invalid structured response.',
    502,
    false,
  );
}
