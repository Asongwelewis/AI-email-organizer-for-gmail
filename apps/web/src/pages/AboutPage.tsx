import { ArrowRight, Eye, FolderKanban, Hand } from 'lucide-react';
import { Link } from 'react-router-dom';

import { LegalDocument } from './LegalDocument';
import { LEGAL_UPDATED } from './legal-contact';

const promises = [
  {
    Icon: Eye,
    title: 'Classified for you',
    copy: 'Every email is classified automatically from its sender, subject, date and Gmail’s preview line. The body is never read.',
  },
  {
    Icon: FolderKanban,
    title: 'Organized into folders',
    copy: 'Sender, area of life and purpose become folders you can reorder, search, and filter by recency — kept up to date every minute.',
  },
  {
    Icon: Hand,
    title: 'Your data stays yours',
    copy: 'Read-only access you can revoke at any time. When you sign out, keep your data for next time or delete all of it.',
  },
] as const;

export function AboutPage() {
  return (
    <LegalDocument
      title="About AMO"
      updated={LEGAL_UPDATED}
      summary={
        <p>
          AMO is a quieter way to understand a crowded Gmail account: a private working view of your
          mailbox, built from the smallest useful amount of information.
        </p>
      }
    >
      <div className="trust-grid" aria-label="AMO principles">
        {promises.map(({ Icon, title, copy }) => (
          <article className="trust-card" key={title}>
            <Icon aria-hidden="true" />
            <h2>{title}</h2>
            <p>{copy}</p>
          </article>
        ))}
      </div>

      <h2>Built for useful restraint</h2>
      <p>
        AMO does not send mail, answer mail, or change your Gmail. It separates Google identity from
        Gmail permission, keeps the session in an HttpOnly cookie, and classifies and organizes your
        mail on its own server — no AI model ever reads it.
      </p>
      <p>
        The product is an assistant, not a record of truth. Automated classification can be wrong;
        Gmail remains the source of truth and every folder is a view over synchronized metadata.
      </p>

      <div className="trust-callout">
        <span className="eyebrow">Read before connecting</span>
        <p>
          See exactly what is collected, shared, retained, and deleted in the{' '}
          <Link to="/privacy">Privacy Policy</Link>. For the security boundary, read the{' '}
          <Link to="/security">Security page</Link>.
        </p>
        <Link className="button button--primary" to="/login">
          Start with Google <ArrowRight aria-hidden="true" />
        </Link>
      </div>
    </LegalDocument>
  );
}
