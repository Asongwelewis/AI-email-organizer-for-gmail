import type { ClassificationResult } from '@web/types/classification';

export interface RecommendationGroup {
  key: string;
  primary: ClassificationResult;
  members: ClassificationResult[];
}

const normalize = (value: string | null | undefined) =>
  (value ?? '').trim().replace(/\s+/g, ' ').toLocaleLowerCase();

export function groupRecommendationResults(results: ClassificationResult[]): RecommendationGroup[] {
  const groups = new Map<string, ClassificationResult[]>();
  for (const result of results) {
    const visualKey = JSON.stringify([
      normalize(result.message.sender),
      normalize(result.message.senderDomain),
      normalize(result.message.subject),
      normalize(result.message.snippet),
      [...result.message.gmailLabels].sort(),
      result.recommendedCategory,
      result.suggestedAction,
      Math.round(result.confidence * 100),
      normalize(result.explanation),
      result.source,
    ]);
    const group = groups.get(visualKey);
    if (group) group.push(result);
    else groups.set(visualKey, [result]);
  }
  return [...groups.entries()].map(([key, members]) => ({
    key,
    primary: members[0]!,
    members,
  }));
}
