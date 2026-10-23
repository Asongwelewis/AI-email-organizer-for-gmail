import { Mail } from 'lucide-react';

import { getBackendRedirectUrl } from '@web/services/http';

/**
 * What every mailbox screen shows to someone who is signed in but has not connected Gmail.
 *
 * Signing in and reading mail are two separate Google permissions, on purpose: signing in only
 * tells MailMind who you are, and never lets it read anything. Someone who had just signed in with
 * a new address landed on an Inbox that said "Loading folders" forever and an Activity page full
 * of `GMAIL_ACCOUNT_NOT_CONNECTED`, because every screen asked for a mailbox that was not there.
 * This is the one step they were missing, said plainly, with the button that does it.
 */
export function ConnectGmailScreen({ reconnect = false }: { reconnect?: boolean }) {
  return (
    <section className="screen">
      <div className="connect-gmail">
        <div className="connect-gmail__icon" aria-hidden="true">
          <Mail strokeWidth={1.5} />
        </div>
        <h1 className="connect-gmail__title">
          {reconnect ? 'Reconnect Gmail to carry on' : 'One more step: connect Gmail'}
        </h1>
        <p className="connect-gmail__lede">
          {reconnect
            ? 'AMO’s access to your Gmail has expired. Reconnect it and your folders pick up where they left off.'
            : 'Signing in only tells AMO who you are. To sort your mail it needs your permission to read it — Google asks for that separately.'}
        </p>
        <a
          className="button button--primary"
          href={getBackendRedirectUrl('/integrations/google/connect')}
        >
          {reconnect ? 'Reconnect Gmail' : 'Connect Gmail'}
        </a>
        <p className="connect-gmail__detail">
          Read-only, and only the sender, subject and date of each email — never the body or an
          attachment. Once connected, AMO reads your recent mail and builds your folders on its own;
          it takes a minute or two.
        </p>
      </div>
    </section>
  );
}
