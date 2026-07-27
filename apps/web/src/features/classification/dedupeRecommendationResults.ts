import type { ClassificationResult } from '@web/types/classification';

export function dedupeRecommendationResults(results: ClassificationResult[]) {
  return Array.from(new Map(results.map((result) => [result.messageId, result])).values());
}
