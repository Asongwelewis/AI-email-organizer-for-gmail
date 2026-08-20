const GMAIL_BASE = 'https://mail.google.com/mail/';

/**
 * Opens one message in Gmail.
 *
 * Two details decide whether this lands on the message or on someone's empty inbox:
 *
 * `#all/` rather than `#inbox/`, because a filed message has left the inbox — `#inbox/<id>` for a
 * message that is no longer there resolves to nothing.
 *
 * `?authuser=<email>` rather than `/u/0/`, because the `/u/N` index is per-browser-profile ordering.
 * With several Google accounts signed in, `/u/0/` is whichever account happens to be first, which
 * is how a link opens the wrong mailbox. Addressing the account by email removes the guess.
 */
export function gmailMessageUrl(connectedEmail: string | null, gmailMessageId: string): string {
  const url = new URL(GMAIL_BASE);
  if (connectedEmail) url.searchParams.set('authuser', connectedEmail);
  return `${url.toString()}#all/${encodeURIComponent(gmailMessageId)}`;
}

/** The same addressing for a label's own view in Gmail. */
export function gmailLabelUrl(connectedEmail: string | null, labelPath: string): string {
  const url = new URL(GMAIL_BASE);
  if (connectedEmail) url.searchParams.set('authuser', connectedEmail);
  return `${url.toString()}#label/${encodeURIComponent(labelPath)}`;
}
