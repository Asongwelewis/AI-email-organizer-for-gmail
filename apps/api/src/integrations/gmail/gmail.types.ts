import type { gmail_v1 } from 'googleapis';

export type GmailClient = gmail_v1.Gmail;

export interface GmailMessageRecord {
  gmail_message_id: string;
  gmail_thread_id: string | null;
  history_id: string | null;
  internal_date: Date | null;
  subject: string | null;
  sender_name: string | null;
  sender_email: string | null;
  recipient_summary: string | null;
  snippet: string | null;
  label_ids: string[];
  has_attachments: boolean;
  size_estimate: number | null;
  is_unread: boolean;
  is_starred: boolean;
  is_important: boolean;
  is_draft: boolean;
  is_sent: boolean;
  is_trashed: boolean;
}

export interface SyncCounts {
  messagesExamined: number;
  messagesUpserted: number;
  messagesDeleted: number;
  labelsUpserted: number;
}

export const emptySyncCounts = (): SyncCounts => ({
  messagesExamined: 0,
  messagesUpserted: 0,
  messagesDeleted: 0,
  labelsUpserted: 0,
});
