import type { LabelCandidateType, LabelReasonCode } from './label-discovery.taxonomy.js';

export interface DiscoveryMessage {
  id: string;
  gmailThreadId: string | null;
  internalDate: Date | null;
  subject: string | null;
  senderName: string | null;
  senderEmail: string | null;
  gmailLabels: string[];
  // Free-form since stage 2; the fixed classification taxonomy no longer exists.
  category: string | null;
  correctedCategory: string | null;
}

export interface CandidateGroup {
  candidateType: LabelCandidateType;
  sourceKey: string;
  suggestedLeafName: string;
  messageIds: string[];
  messageCount: number;
  threadCount: number;
  firstMessageAt: Date | null;
  lastMessageAt: Date | null;
  dominantCategory: string | null;
  categoryAgreement: number;
  sourceAgreement: number;
  displayNameAgreement: number;
  subjectPatternAgreement: number;
  userCorrectionSupport: number;
  recent: boolean;
  temporary: boolean;
  generic: boolean;
  reasonCodes: LabelReasonCode[];
  confidence: number;
  inputHash: string;
}

export interface LabelCandidateModelOutput {
  suggestedLeafName: string;
  candidateType: LabelCandidateType;
  confidence: number;
  shouldCreate: boolean;
  mergeGroupKeys: string[];
  reasonCodes: LabelReasonCode[];
}

export interface DiscoveryPreferences {
  minMessages: number;
  lookbackDays: number;
  maxCandidates: number;
  allowedCandidateTypes: LabelCandidateType[];
  preferOrganizations: boolean;
  preferTopics: boolean;
}

export interface DiscoveryPreferenceOverrides {
  minMessages?: number | undefined;
  lookbackDays?: number | undefined;
  maxCandidates?: number | undefined;
  allowedCandidateTypes?: LabelCandidateType[] | undefined;
  preferOrganizations?: boolean | undefined;
  preferTopics?: boolean | undefined;
}
