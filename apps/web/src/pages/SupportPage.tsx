import { Link } from 'react-router-dom';

import { LegalDocument } from './LegalDocument';
import { LEGAL_CONTACT, LEGAL_UPDATED } from './legal-contact';

/**
 * A support page that exists, which is itself a requirement: Google's OAuth verification asks for
 * a reachable support URL on the same domain as the app.
 */
export function SupportPage() {
  return (
    <LegalDocument
      title="Support"
      updated={LEGAL_UPDATED}
      summary={
        <p>
          Something wrong, or a question about what MailMind does with your mail?{' '}
          <Link to="/feedback">Send it straight through the app</Link> — no account needed — or
          write to <a href={`mailto:${LEGAL_CONTACT}`}>{LEGAL_CONTACT}</a>.
        </p>
      }
    >
      <h2>Before you write</h2>
      <p>
        Most reports are quicker to act on with the error code attached. MailMind shows the
        server&rsquo;s own code next to whatever failed — a short string like{' '}
        <code>GMAIL_REAUTH_REQUIRED</code> — rather than a generic apology, and a screenshot of that
        is usually enough.
      </p>

      <h2>Common things</h2>
      <h3>A message is in the wrong folder</h3>
      <p>
        Expected. Classification is a language model reading a subject line and a sender, and it is
        wrong sometimes. Folders are a view of the facets, so changing the arrangement on the
        Folders screen re-files everything instantly and costs nothing.
      </p>

      <h3>MailMind says my Gmail connection needs renewing</h3>
      <p>
        Google expires access periodically, and revokes it if you remove MailMind from your Google
        account&rsquo;s connected apps. Reconnect from the Set up screen.
      </p>

      <h3>Nothing is in my folders</h3>
      <p>
        Mail has to be read before it can be sorted, and sorted before folders exist. The Set up
        screen walks the three steps in order and tells you which one you are on.
      </p>

      <h3>I want it to stop</h3>
      <p>
        Disconnecting Gmail revokes MailMind&rsquo;s access immediately.{' '}
        <Link to="/data-deletion">Deleting your account</Link> removes everything stored about you.
      </p>

      <h2>Still stuck</h2>
      <p>
        <Link to="/feedback">Tell us what happened.</Link> It reaches whoever runs this deployment
        directly, works signed out, and stores nothing about you beyond what you type — an address
        only if you want a reply.
      </p>

      <h2>Reporting a security issue</h2>
      <p>
        Mail <a href={`mailto:${LEGAL_CONTACT}`}>{LEGAL_CONTACT}</a> with the details and please do
        not open a public issue first.
      </p>
    </LegalDocument>
  );
}
