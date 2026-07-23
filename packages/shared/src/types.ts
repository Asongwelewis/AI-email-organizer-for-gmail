export type Environment = 'development' | 'test' | 'production';

export interface HealthResponse {
  status: 'ok';
  service: string;
  timestamp: string;
}

export interface GmailLabelSuggestion {
  id: string;
  name: string;
  parentLabelId: string | null;
  confidence: number;
  reason: string;
}

export interface EmailOrganizationSnapshot {
  inboxEmailCount: number;
  suggestedLabels: GmailLabelSuggestion[];
  requiresApproval: boolean;
}
