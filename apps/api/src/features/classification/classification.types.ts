import type {
  ClassificationCategory,
  ReasonCode,
  RecommendedAction,
} from './classification-taxonomy.js';

export interface ClassificationInput {
  subject: string;
  senderDisplayName: string;
  senderDomain: string;
  senderLocalPartCategory: 'automated' | 'role' | 'person-like' | 'unknown';
  recipientRoleSummary: string;
  snippet: string;
  gmailLabels: string[];
  isUnread: boolean;
  isImportant: boolean;
  isStarred: boolean;
  hasAttachments: boolean;
  messageDate: string | null;
  sameDomain: boolean;
}

export interface RuleSignal {
  category: ClassificationCategory;
  recommendedAction: RecommendedAction;
  confidence: number;
  reasonCodes: ReasonCode[];
  explanation: string;
}

export interface ClassificationOutput {
  category: ClassificationCategory;
  recommendedAction: RecommendedAction;
  confidence: number;
  reasonCodes: ReasonCode[];
  explanation: string;
  requiresReview: boolean;
}

export interface ProviderClassificationResult {
  output: unknown;
  inputUnits?: number;
  outputUnits?: number;
}

export interface ProviderContext {
  ruleSignals: RuleSignal[];
  prompt: string;
}

export interface EmailClassifierProvider {
  readonly name: string;
  readonly model: string | null;
  readonly enabled: boolean;
  classify(
    input: ClassificationInput,
    context: ProviderContext,
  ): Promise<ProviderClassificationResult>;
}
