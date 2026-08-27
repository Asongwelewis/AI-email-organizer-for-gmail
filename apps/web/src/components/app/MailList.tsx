import { ExternalLink } from 'lucide-react';

import { formatTimestamp } from '@web/lib/format';
import { gmailMessageUrl } from '@web/lib/gmailLink';

/**
 * A list of mail, and the one place a message becomes a link.
 *
 * MailMind never renders a message body — the Gmail boundary is metadata-only, so there is nothing
 * here to render. Every row opens the message in Gmail instead, addressed by id, which resolves
 * whether the message is filed, archived or still in the inbox. That deep link is why folders
 * never needed to be written to Gmail at all.
 */

export interface MailListItem {
  id: string;
  gmailMessageId: string;
  subject: string | null;
  senderName: string | null;
  senderEmail: string | null;
  receivedAt: string | null;
  /** Where it sits, when the caller knows and the reader does not. Search shows it; a folder does not. */
  folder?: { fullPath: string; leafName: string } | null;
}

/** `MailMind/Netflix/Payment failed` reads as `Netflix / Payment failed` to a person. */
function readablePath(fullPath: string): string {
  return fullPath
    .replace(/^MailMind\//, '')
    .split('/')
    .join(' / ');
}

export function MailList({
  messages,
  connectedEmail,
}: {
  messages: MailListItem[];
  connectedEmail: string | null;
}) {
  return (
    <ul className="mail-list">
      {messages.map((message) => (
        <li key={message.id}>
          <a
            className="mail-row"
            href={gmailMessageUrl(connectedEmail, message.gmailMessageId)}
            target="_blank"
            rel="noreferrer noopener"
          >
            <span className="mail-row__from">{message.senderName ?? message.senderEmail}</span>
            <span className="mail-row__subject">{message.subject ?? 'No subject'}</span>
            {message.folder !== undefined ? (
              <span className="mail-row__folder">
                {message.folder ? readablePath(message.folder.fullPath) : 'No folder'}
              </span>
            ) : null}
            <span className="mail-row__date">
              {message.receivedAt ? formatTimestamp(message.receivedAt) : '—'}
            </span>
            <ExternalLink className="mail-row__open" aria-hidden="true" strokeWidth={1.5} />
            <span className="sr-only">Open in Gmail</span>
          </a>
        </li>
      ))}
    </ul>
  );
}
