/** Why somebody wrote. The four the server accepts, in the order the form offers them. */
export const FEEDBACK_KINDS = ['PROBLEM', 'IDEA', 'PRAISE', 'OTHER'] as const;

export type FeedbackKind = (typeof FEEDBACK_KINDS)[number];

export interface FeedbackInput {
  kind: FeedbackKind;
  message: string;
  /** Only if they want a reply. Absent, not empty, when they do not. */
  contact?: string;
  /** The route they were on. Path only — the server rejects anything with a query string. */
  page?: string;
}
