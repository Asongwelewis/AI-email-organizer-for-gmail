export type LabelSource = 'AI_PROPOSED' | 'USER_CREATED';

export interface UserLabel {
  id: string;
  leafName: string;
  fullPath: string;
  source: LabelSource;
  gmailLabelId: string | null;
  createdAt: string;
}

export interface LabelProposal {
  id: string;
  leafName: string;
  fullPath: string;
  confidence: number;
  messageCount: number;
  reasonCodes: string[];
}

export interface LabelsOverview {
  maxLabels: number;
  labels: UserLabel[];
  proposals: LabelProposal[];
}

export interface ConfirmLabelInput {
  leafName: string;
  source: LabelSource;
}
