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
