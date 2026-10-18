import type { PivotFacet } from './facets';

export interface NotificationItem {
  id: string;
  kind: 'NEW_MAIL';
  createdAt: string;
  readAt: string | null;
  message: {
    gmailMessageId: string;
    subject: string;
    senderName: string | null;
    senderEmail: string | null;
    snippet: string | null;
    receivedAt: string | null;
  };
  /** The folder it was sorted into, once it has been. */
  folder: { facetKey: string; path: string; order: PivotFacet[] } | null;
}

export interface NotificationFeed {
  items: NotificationItem[];
  unreadCount: number;
  nextCursor: string | null;
}

export interface PushConfig {
  /** Whether this server can send to devices at all. */
  configured: boolean;
  publicKey: string | null;
  /** Devices this person has turned notifications on for. */
  subscriptions: number;
}
