import { z } from 'zod';

import { LABEL_CANDIDATE_TYPES, LABEL_REASON_CODES } from './label-discovery.taxonomy.js';
import type { LabelCandidateModelOutput } from './label-discovery.types.js';
import { validateLeafName } from './label-normalization.js';

const schema = z
  .object({
    suggestedLeafName: z.string().trim().min(2).max(60),
    candidateType: z.enum(LABEL_CANDIDATE_TYPES),
    confidence: z.number().finite().min(0).max(1),
    shouldCreate: z.boolean(),
    mergeGroupKeys: z.array(z.string().min(1).max(300)).max(20),
    reasonCodes: z.array(z.enum(LABEL_REASON_CODES)).max(12),
  })
  .strict();

export function validateLabelCandidateModelOutput(
  value: unknown,
  allowedGroupKeys: ReadonlySet<string>,
): LabelCandidateModelOutput {
  let candidate = value;
  if (typeof value === 'string') {
    try {
      candidate = JSON.parse(value);
    } catch {
      throw new Error('LABEL_DISCOVERY_INVALID_PROVIDER_RESPONSE');
    }
  }
  const parsed = schema.safeParse(candidate);
  if (!parsed.success) throw new Error('LABEL_DISCOVERY_INVALID_PROVIDER_RESPONSE');
  validateLeafName(parsed.data.suggestedLeafName);
  return {
    ...parsed.data,
    mergeGroupKeys: parsed.data.mergeGroupKeys.filter((key) => allowedGroupKeys.has(key)),
  };
}
