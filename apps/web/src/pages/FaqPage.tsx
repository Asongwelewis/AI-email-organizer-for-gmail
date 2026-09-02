import { Link } from 'react-router-dom';

import { LegalDocument } from './LegalDocument';
import { LEGAL_UPDATED } from './legal-contact';

const questions = [
  {
    question: 'Does MailMind read my email body or attachments?',
    answer:
      'No. MailMind requests read-only Gmail access and stores message metadata plus Gmail’s short snippet. It does not request or store raw MIME, full message bodies, or attachments.',
  },
  {
    question: 'What does Google sign-in authorize?',
    answer:
      'Google sign-in creates your MailMind account from your basic profile. Gmail access is a second, explicit step so you can understand and decline that permission independently.',
  },
  {
    question: 'Can MailMind change my Gmail?',
    answer:
      'The normal connection is read-only. Optional label export is a separate capability, disabled unless the deployment enables it and you grant the wider permission. MailMind never sends, deletes, or replies to messages.',
  },
  {
    question: 'Can I correct a classification?',
    answer:
      'Yes. Review and folder controls are designed for correction. The model is an aid, not a guarantee, so use Gmail itself as the source of truth for anything important.',
  },
  {
    question: 'What happens when I disconnect Gmail?',
    answer:
      'MailMind revokes the Gmail grant and removes the stored connection tokens. Your MailMind account and synchronized metadata remain until you choose account deletion.',
  },
  {
    question: 'How do I delete everything MailMind stores?',
    answer:
      'Use the public data-deletion page. Signed-in users can confirm deletion there; signed-out users can follow the support instructions. Account deletion is immediate and not recoverable.',
  },
] as const;

export function FaqPage() {
  return (
    <LegalDocument
      title="Frequently asked questions"
      updated={LEGAL_UPDATED}
      summary={
        <p>Plain answers to the questions that matter before an app is allowed near a mailbox.</p>
      }
    >
      <div className="faq-list">
        {questions.map(({ question, answer }) => (
          <details key={question}>
            <summary>{question}</summary>
            <p>{answer}</p>
          </details>
        ))}
      </div>

      <div className="trust-callout">
        <span className="eyebrow">Still unsure?</span>
        <p>
          Read the <Link to="/privacy">Privacy Policy</Link> or ask a question through{' '}
          <Link to="/feedback">feedback</Link> before connecting Gmail.
        </p>
      </div>
    </LegalDocument>
  );
}
