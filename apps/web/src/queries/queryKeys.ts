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
};
