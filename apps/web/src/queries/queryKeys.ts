export const queryKeys = {
  authMe: ['auth', 'me'] as const,
  gmailConnection: ['integrations', 'google', 'status'] as const,
  gmailSyncStatus: ['gmail', 'sync', 'status'] as const,
  automationStatus: ['automation', 'status'] as const,
  activityRuns: ['activity', 'runs'] as const,
  activityRun: (runId: string) => ['activity', 'runs', runId] as const,
  pivotSettings: ['facets', 'pivot'] as const,
  pivotPlan: ['facets', 'pivot', 'plan'] as const,
  pivotView: (order: string[], range = '24h') =>
    ['facets', 'pivot', 'view', order.join(','), range] as const,
  facetMessages: (facetKey: string, range = '24h') =>
    ['facets', 'messages', facetKey, range] as const,
  facetVocabulary: ['facets', 'vocabulary'] as const,
  favorites: ['favorites'] as const,
  favoriteKeys: ['favorites', 'keys'] as const,
  notifications: ['notifications'] as const,
  pushConfig: ['notifications', 'push'] as const,
  facetSearch: (
    query: string,
    filters: { entity?: string; domain?: string; intent?: string; unread?: boolean },
    order: string[],
  ) =>
    [
      'facets',
      'search',
      query,
      filters.entity ?? '',
      filters.domain ?? '',
      filters.intent ?? '',
      filters.unread ? 'unread' : '',
      order.join(','),
    ] as const,
};
