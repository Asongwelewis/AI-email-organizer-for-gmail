export const queryKeys = {
  authMe: ['auth', 'me'] as const,
  gmailConnection: ['integrations', 'google', 'status'] as const,
  gmailSyncStatus: ['gmail', 'sync', 'status'] as const,
  labels: ['labels'] as const,
  automationStatus: ['automation', 'status'] as const,
  automationReview: ['automation', 'review'] as const,
  activityRuns: ['activity', 'runs'] as const,
  activityRun: (runId: string) => ['activity', 'runs', runId] as const,
  folderMessages: (labelId: string) => ['labels', labelId, 'messages'] as const,
  pivotSettings: ['facets', 'pivot'] as const,
  pivotPlan: ['facets', 'pivot', 'plan'] as const,
  pivotView: (order: string[], range = '24h') =>
    ['facets', 'pivot', 'view', order.join(','), range] as const,
  facetMessages: (facetKey: string, range = '24h') =>
    ['facets', 'messages', facetKey, range] as const,
  facetVocabulary: ['facets', 'vocabulary'] as const,
  facetSearch: (
    query: string,
    filters: { entity?: string; domain?: string; intent?: string },
    order: string[],
  ) =>
    [
      'facets',
      'search',
      query,
      filters.entity ?? '',
      filters.domain ?? '',
      filters.intent ?? '',
      order.join(','),
    ] as const,
};
