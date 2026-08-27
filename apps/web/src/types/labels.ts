export type LabelSource = 'AI_PROPOSED' | 'USER_CREATED';
export type RoutingRuleKind = 'SENDER_DOMAIN' | 'SENDER_ADDRESS' | 'SUBJECT_CONTAINS';
export type TaxonomyNodeKind = 'CATEGORY' | 'TOPIC' | 'STATE';

/**
 * An approved folder. The tree lives in MailMind; Gmail only ever receives the leaf's `fullPath`
 * as one label whose name happens to contain slashes.
 */
export interface UserLabel {
  id: string;
  parentId: string | null;
  depth: number;
  leafName: string;
  fullPath: string;
  /** The joined ancestor chain without the MailMind prefix. */
  path: string;
  isLeaf: boolean;
  rationale: string | null;
  /** Mail filed here. Null when the API build in use does not report counts. */
  messageCount?: number | null;
  source: LabelSource;
  gmailLabelId: string | null;
  createdAt: string;
}

export interface RoutingRule {
  kind: RoutingRuleKind;
  value: string;
  matchedMessageCount: number;
}

export interface TaxonomyPlanNode {
  id: string;
  parentId: string | null;
  depth: number;
  kind: TaxonomyNodeKind;
  name: string;
  fullPath: string;
  path: string;
  rationale: string;
  /** What the planner expects across the whole mailbox. */
  estimatedMessageCount: number;
  /** What this node's own rules actually matched in the sample. */
  matchedMessageCount: number;
  /** matchedMessageCount for this node and everything beneath it. */
  rolledUpMessageCount: number;
  isLeaf: boolean;
  gmailLabelPath: string | null;
  rules: RoutingRule[];
}

/** A proposed tree awaiting approval. Nothing in it exists in Gmail yet. */
export interface TaxonomyPlan {
  id: string;
  status: 'PENDING' | 'APPROVED' | 'SUPERSEDED';
  model: string;
  promptVersion: string;
  sampledMessageCount: number;
  analyzedMessageCount: number;
  leafCount: number;
  /** Nodes and rules the validator rejected, shown alongside the tree at review time. */
  warnings: string[];
  createdAt: string;
  nodes: TaxonomyPlanNode[];
}

/** One filed message, as the Sorted drill-in lists it. */
export interface FolderMessage {
  id: string;
  gmailMessageId: string;
  subject: string | null;
  senderName: string | null;
  senderEmail: string | null;
  receivedAt: string | null;
}

export interface FolderMessagesResponse {
  messages: FolderMessage[];
  total: number;
}

export interface LabelsOverview {
  maxLabels: number;
  maxDepth: number;
  labels: UserLabel[];
  plan: TaxonomyPlan | null;
}

/** Approving a proposed tree. Omitting nodeIds approves all of it. */
export interface ApprovePlanInput {
  planId: string;
  nodeIds?: string[];
}

/** Creating folders by hand instead of from a plan. */
export interface ConfirmLabelInput {
  leafName: string;
  parentId?: string | null;
  source: LabelSource;
}
