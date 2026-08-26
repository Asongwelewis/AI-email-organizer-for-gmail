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
          MailMind organises your Gmail by reading message headers and showing you folders built
          from them. You keep your mail; MailMind keeps a description of it. You can disconnect or
          delete everything at any time, and it is offered as-is.
        </p>
      }
    >
      <h2>The agreement</h2>
      <p>
        These terms are between you and {LEGAL_ENTITY}. Using MailMind means accepting them. If you
        do not, do not connect a mailbox.
      </p>

      <h2>What the service does</h2>
      <p>
        MailMind reads the metadata of messages in a Gmail account you connect, classifies each one
        along three axes, and presents the result as browsable, searchable folders. It does not send
        mail, delete mail, or reply to anyone.
      </p>
      <p>
        By default MailMind holds <strong>read-only</strong> access to your mailbox and changes
        nothing inside it. An optional export can mirror your folders into Gmail&rsquo;s own labels;
        it is off unless the deployment enables it and you grant the wider permission, and even then
        it only ever adds and removes MailMind&rsquo;s own labels.
      </p>

      <h2>Your account</h2>
      <p>
        You are responsible for the Google account you sign in with and for the mailbox you connect.
        Connect only a mailbox you are entitled to.
      </p>

      <h2>Automated classification</h2>
      <p>
        Classification is performed by a large language model and is <strong>not reliable</strong>.
        Messages will be put in the wrong folder. MailMind is an aid to finding mail, not a system
        of record: do not rely on it for anything where being wrong matters, and do not treat the
        absence of a message from a folder as evidence that the message does not exist.
      </p>

      <h2>Acceptable use</h2>
      <p>
        Do not attempt to use MailMind to access a mailbox you do not control, to circumvent its
        rate limits, or to process mail on behalf of people who have not agreed to this.
      </p>

      <h2>Availability</h2>
      <p>
        There is no uptime commitment. The service depends on Google&rsquo;s APIs and on a
        third-party AI provider, and either can be unavailable or can change its terms. Features can
        change or be withdrawn.
      </p>

      <h2>Ending it</h2>
      <p>
        You can disconnect Gmail at any time, or delete your account and everything stored about it
        from the <Link to="/data-deletion">data deletion page</Link>. We may suspend an account that
        is being used in breach of these terms.
      </p>

      <h2>No warranty, and the limit of liability</h2>
      <p>
        MailMind is provided &ldquo;as is&rdquo;, without warranty of any kind. To the extent
        permitted by law, {LEGAL_ENTITY} is not liable for indirect or consequential loss, for lost
        profits, or for anything arising from a message being classified incorrectly or from mail
        you did not find.
      </p>

      <h2>Contact</h2>
      <p>
        <a href={`mailto:${LEGAL_CONTACT}`}>{LEGAL_CONTACT}</a>. See also the{' '}
        <Link to="/privacy">Privacy Policy</Link>, which forms part of these terms.
      </p>
    </LegalDocument>
  );
}
