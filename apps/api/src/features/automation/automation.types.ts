import type { classification_category } from '@prisma/client';

export const AUTOMATION_CATEGORIES = [
  'PRIMARY',
  'WORK',
  'FINANCE',
  'RECEIPTS',
  'ORDERS',
  'TRAVEL',
  'EDUCATION',
  'NEWSLETTERS',
  'PROMOTIONS',
  'SOCIAL',
  'NOTIFICATIONS',
  'SECURITY',
  'SUPPORT',
  'PERSONAL',
  'SPAM_SUSPECTED',
  'OTHER',
] as const satisfies readonly classification_category[];

export interface AutomationMessageInput {
  key: string;
  subject: string;
  sender: string;
  senderDomain: string;
  snippet: string;
  isUnread: boolean;
  isImportant: boolean;
  hasAttachments: boolean;
}

export interface AutomationClassification {
  key: string;
  category: classification_category;
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

export interface AutomationClassifier {
  classify(messages: AutomationMessageInput[]): Promise<AutomationProviderResult>;
}
