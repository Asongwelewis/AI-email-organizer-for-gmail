import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';

/**
 * The layout the real legal documents are set in.
 *
 * `LegalPlaceholder` centred a huge title over one sentence, which was right for a page that said
 * "this will be published later" and wrong for a document somebody has to read. This is a reading
 * column: left-aligned, measured, with headings a person can scan.
 */
export function LegalDocument({
  title,
  updated,
  summary,
  children,
}: {
  title: string;
  /** ISO date. A policy without one cannot be told apart from a policy nobody has revisited. */
  updated: string;
  /** The honest one-paragraph version, before the detail. */
  summary: ReactNode;
  children: ReactNode;
}) {
  return (
    <main className="legal-doc">
      <div className="legal-doc__column">
        <Link className="legal-doc__back" to="/">
          ← MailMind AI
        </Link>
        <h1>{title}</h1>
        <p className="legal-doc__updated">Last updated {updated}</p>
        <div className="legal-doc__summary">{summary}</div>
        {children}
      </div>
    </main>
  );
}
