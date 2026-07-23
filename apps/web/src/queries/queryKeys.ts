export const queryKeys = {
  authMe: ['auth', 'me'] as const,
  gmailConnection: ['integrations', 'google', 'status'] as const,
  gmailSyncStatus: ['gmail', 'sync', 'status'] as const,
  classificationStatus: ['classification', 'status'] as const,
  classificationResults: ['classification', 'results'] as const,
  labelDiscoveryStatus: ['label-discovery', 'status'] as const,
  labelCandidates: ['label-discovery', 'candidates'] as const,
};
