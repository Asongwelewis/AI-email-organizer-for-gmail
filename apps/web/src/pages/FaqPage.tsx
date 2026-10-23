import { Link } from 'react-router-dom';

import { LegalDocument } from './LegalDocument';
import { LEGAL_UPDATED } from './legal-contact';

const questions = [
  {
    question: 'Does AMO read my email body or attachments?',
    answer:
      'No. AMO requests read-only Gmail access and stores message metadata plus Gmail’s short snippet. It does not request or store raw MIME, full message bodies, or attachments, and no AI model ever reads your mail: classification runs on AMO’s own server.',
  },
  {
    question: 'What does Google sign-in authorize?',
    answer:
      'Google sign-in creates your AMO account from your basic profile. Gmail access is a second, explicit step so you can understand and decline that permission independently.',
  },
  {
    question: 'Can AMO change my Gmail?',
    answer:
      'The normal connection is read-only. Optional label export is a separate capability, disabled unless the deployment enables it and you grant the wider permission. AMO never sends, deletes, or replies to messages.',
  },
  {
    question: 'Do I have to sort or approve anything?',
    answer:
      'No. AMO classifies the last two years of your mail as soon as you connect Gmail, and every new email within about a minute of arriving, then organizes it into folders. Classification is automated and accurate for most mail, but not infallible, so use Gmail itself as the source of truth for anything important.',
  },
  {
    question: 'What happens when I disconnect Gmail?',
    answer:
      'AMO revokes the Gmail grant and removes the stored connection tokens. Your AMO account and synchronized metadata remain until you choose account deletion.',
  },
  {
    question: 'What happens to my data when I sign out?',
    answer:
      'You choose. Keep it, and your folders are waiting when you sign in again with the same Google account; or delete it, and everything AMO stores about you is removed permanently and its Google access revoked.',
  },
  {
    question: 'How do I delete everything AMO stores?',
    answer:
      'Choose “delete my data” when you sign out, or use the public data-deletion page at any time. Signed-out users can follow the support instructions. Account deletion is immediate and not recoverable.',
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
