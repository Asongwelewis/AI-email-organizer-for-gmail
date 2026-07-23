export const labelCandidateTypes = [
  'SOURCE',
  'ORGANIZATION',
  'TOPIC',
  'SUBSCRIPTION',
  'PROJECT',
  'WORKFLOW',
] as const;

export type LabelCandidateType = (typeof labelCandidateTypes)[number];
export type LabelCandidateStatus =
  'PENDING' | 'APPROVED' | 'REJECTED' | 'DEFERRED' | 'MERGED' | 'CREATED' | 'SUPERSEDED' | 'FAILED';

export interface LabelDiscoveryStatus {
  enabled: boolean;
  running: boolean;
  activeRunId: string | null;
  pendingCount: number;
  approvedCount: number;
  maxPendingCandidates: number;
  maxApprovedLabels: number;
  gmailLabelCreationSupported: false;
  lastErrorCode: string | null;
  latestRun: {
    id: string;
    status: 'RUNNING' | 'COMPLETED' | 'FAILED';
    messagesAnalyzed: number;
    groupsDiscovered: number;
    candidatesCreated: number;
    candidatesReused: number;
    candidatesRejectedByRules: number;
    providerCalls: number;
    completedAt: string | null;
  } | null;
  versions: { discovery: string; naming: string; confidence: string };
}

export interface LabelCandidate {
  id: string;
  candidateType: LabelCandidateType;
  suggestedLeafName: string;
  suggestedFullPath: string;
  status: LabelCandidateStatus;
  confidence: number;
  confidenceLevel: 'MEDIUM' | 'HIGH' | 'VERY_HIGH';
  messageCount: number;
  threadCount: number;
  firstMessageAt: string | null;
  lastMessageAt: string | null;
  dominantCategory: string | null;
  categoryAgreement: number;
  sourceAgreement: number;
  reasonCodes: string[];
  reasons: string[];
  discoveryVersion: string;
  existingLabelConflict: boolean;
  mergeSuggestion: { candidateId: string; path: string } | null;
  decision: {
    type: string;
    finalLeafName: string | null;
    finalFullPath: string | null;
    createdAt: string;
  } | null;
  lastDiscoveredAt: string;
}

export interface LabelCandidatesPage {
  candidates: LabelCandidate[];
  nextCursor: string | null;
}
