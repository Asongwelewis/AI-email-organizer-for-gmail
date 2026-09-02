import { ArrowRight, Eye, FolderKanban, Hand } from 'lucide-react';
import { Link } from 'react-router-dom';

import { LegalDocument } from './LegalDocument';
import { LEGAL_UPDATED } from './legal-contact';

const promises = [
  {
    Icon: Eye,
    title: 'See the pattern',
    copy: 'MailMind works from Gmail metadata: the subject, sender, date, labels, and short preview Gmail provides.',
  },
  {
    Icon: FolderKanban,
    title: 'Shape the view',
    copy: 'Three independent facets become a folder view you can reorder, search, and filter by recency.',
  },
  {
    Icon: Hand,
    title: 'Keep the say',
    copy: 'Suggestions are reviewable. Connecting Gmail and exporting labels are separate choices, and neither is hidden.',
  },
] as const;

export function AboutPage() {
  return (
    <LegalDocument
      title="About MailMind"
      updated={LEGAL_UPDATED}
      summary={
        <p>
          MailMind is a quieter way to understand a crowded Gmail account: a private working view of
          your mailbox, built from the smallest useful amount of information.
        </p>
      }
    >
      <div className="trust-grid" aria-label="MailMind principles">
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
        MailMind does not send mail, answer mail, or silently change your Gmail. It separates Google
        identity from Gmail permission, keeps the session in an HttpOnly cookie, and puts the
        organization decision in front of you.
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
