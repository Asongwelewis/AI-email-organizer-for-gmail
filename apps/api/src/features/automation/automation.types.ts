/** Returned when a message fits none of the account's approved labels. */
export const NO_LABEL = 'NONE';

export interface AutomationMessageInput {
  key: string;
  subject: string;
  sender: string;
  senderDomain: string;
  snippet: string;
  isUnread: boolean;
  isImportant: boolean;
  hasAttachments: boolean;
  learnedPattern?: {
    labelName: string;
    confidence: number;
  };
}

export interface AutomationClassification {
  key: string;
  /** An approved leaf name, or NO_LABEL when the message fits none of them. */
  labelName: string;
  confidence: number;
  explanation: string;
  reasonCodes: string[];
}

export interface AutomationUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

export interface AutomationProviderResult {
  classifications: AutomationClassification[];
  usage: AutomationUsage;
}

export interface AutomationClassifyOptions {
  /** The account's approved leaf names; the model may return only these or NO_LABEL. */
  labelNames: string[];
  maxOutputTokens?: number;
}

export interface AutomationClassifier {
  classify(
    messages: AutomationMessageInput[],
    options: AutomationClassifyOptions,
  ): Promise<AutomationProviderResult>;
}

/**
 * A cluster of mail that fitted no approved folder, offered as a candidate leaf.
 *
 * Nothing here is created. The gap report describes what automation kept declining so a person can
 * decide whether it deserves a folder, which is the same human gate every other folder passes.
 */
export interface AutomationGapCluster {
  kind: 'SENDER_DOMAIN' | 'SUBJECT_CONTAINS';
  /** The rule value that would route this cluster, were it approved. */
  value: string;
  messageCount: number;
  sampleSubjects: string[];
  /** Derived mechanically from `value`. A starting point for naming, not a decision. */
  suggestedName: string;
}

export interface AutomationGapReport {
  /** Messages recorded as fitting no folder that the report considered. */
  analyzedCount: number;
  /** How many of those fall inside a cluster big enough to propose. */
  clusteredCount: number;
  clusters: AutomationGapCluster[];
}
