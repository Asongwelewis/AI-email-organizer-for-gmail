import { Link } from 'react-router-dom';

import { LegalDocument } from './LegalDocument';
import { LEGAL_CONTACT, LEGAL_ENTITY, LEGAL_UPDATED } from './legal-contact';

export function TermsOfService() {
  return (
    <LegalDocument
      title="Terms of Service"
      updated={LEGAL_UPDATED}
      summary={
        <p>
          AMO classifies your Gmail automatically from message headers and organizes it into folders
          — the body of your mail is never read. You keep your mail; AMO keeps a description of it,
          and your data stays yours: keep it or delete it whenever you sign out. It is offered
          as-is.
        </p>
      }
    >
      <h2>The agreement</h2>
      <p>
        These terms are between you and {LEGAL_ENTITY}. Using AMO means accepting them. If you do
        not, do not connect a mailbox.
      </p>

      <h2>What the service does</h2>
      <p>
        AMO reads the metadata of messages in a Gmail account you connect — sender, recipients,
        subject, date, labels and Gmail&rsquo;s preview line, never the body or attachments —
        classifies each one automatically along three axes, and organizes the result into browsable,
        searchable folders. On the free plan it covers the two years of mail before you first
        connected, plus everything that arrives after. It does not send mail, delete mail, or reply
        to anyone.
      </p>
      <p>
        By default AMO holds <strong>read-only</strong> access to your mailbox and changes nothing
        inside it. An optional export can mirror your folders into Gmail&rsquo;s own labels; it is
        off unless the deployment enables it and you grant the wider permission, and even then it
        only ever adds and removes AMO&rsquo;s own labels.
      </p>

      <h2>Your account</h2>
      <p>
        You are responsible for the Google account you sign in with and for the mailbox you connect.
        Connect only a mailbox you are entitled to.
      </p>

      <h2>Automated classification</h2>
      <p>
        Classification is performed by smart classification on AMO&rsquo;s own server — rules
        learned from AI-labelled examples, well-known senders and Gmail&rsquo;s own categories. No
        AI model reads your mail. It is accurate for most mail, but it is automated and{' '}
        <strong>not infallible</strong>: some messages will land in the wrong folder. AMO is an aid
        to finding mail, not a system of record: do not rely on it for anything where being wrong
        matters, and do not treat the absence of a message from a folder as evidence that the
        message does not exist.
      </p>

      <h2>Acceptable use</h2>
      <p>
        Do not attempt to use AMO to access a mailbox you do not control, to circumvent its rate
        limits, or to process mail on behalf of people who have not agreed to this.
      </p>

      <h2>Availability</h2>
      <p>
        There is no uptime commitment. The service depends on Google&rsquo;s APIs, which can be
        unavailable or can change their terms. Features can change or be withdrawn.
      </p>

      <h2>Ending it</h2>
      <p>
        You can disconnect Gmail at any time, or delete your account and everything stored about it
        when you sign out or from the <Link to="/data-deletion">data deletion page</Link>. We may
        suspend an account that is being used in breach of these terms.
      </p>

      <h2>No warranty, and the limit of liability</h2>
      <p>
        AMO is provided &ldquo;as is&rdquo;, without warranty of any kind. To the extent permitted
        by law, {LEGAL_ENTITY} is not liable for indirect or consequential loss, for lost profits,
        or for anything arising from a message being classified incorrectly or from mail you did not
        find.
      </p>

      <h2>Contact</h2>
      <p>
        <a href={`mailto:${LEGAL_CONTACT}`}>{LEGAL_CONTACT}</a>. See also the{' '}
        <Link to="/privacy">Privacy Policy</Link>, which forms part of these terms.
      </p>
    </LegalDocument>
  );
}
