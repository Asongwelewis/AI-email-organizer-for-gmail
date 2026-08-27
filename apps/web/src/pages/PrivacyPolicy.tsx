import { Link } from 'react-router-dom';

import { LegalDocument } from './LegalDocument';
import { LEGAL_CONTACT, LEGAL_ENTITY, LEGAL_UPDATED } from './legal-contact';

/**
 * What MailMind actually does with a mailbox.
 *
 * Written against the code rather than from a template, because Google's restricted-scope review
 * compares the two: metadata-only sync, read-only Gmail access, one third-party processor, and a
 * deletion path that exists. Every claim here is a claim the codebase can be checked against, and
 * the ones that would be untrue if a setting changed are worded to say so.
 */
export function PrivacyPolicy() {
  return (
    <LegalDocument
      title="Privacy Policy"
      updated={LEGAL_UPDATED}
      summary={
        <p>
          MailMind reads the <strong>headers</strong> of your Gmail — subject, sender, recipients,
          date, labels and Gmail&rsquo;s own short preview line — to work out what each message is
          about, and shows you the result as folders. It never reads the body of an email or any
          attachment, because it never asks Gmail for them. It does not sell anything, does not
          advertise, and does not share your mail with anyone except the one AI provider named
          below.
        </p>
      }
    >
      <h2>Who this is</h2>
      <p>
        MailMind AI is operated by {LEGAL_ENTITY}. Questions about this policy, or about the data
        held about you, go to <a href={`mailto:${LEGAL_CONTACT}`}>{LEGAL_CONTACT}</a>.
      </p>

      <h2>What is collected</h2>
      <p>
        When you sign in with Google, MailMind stores your Google account id, email address and
        display name, and the profile picture URL Google supplies. That is what an account is.
      </p>
      <p>
        When you connect Gmail, MailMind requests <code>gmail.readonly</code> — read-only access —
        and asks Gmail only for message <em>metadata</em>. For each message it stores:
      </p>
      <ul>
        <li>Gmail&rsquo;s message and thread identifiers.</li>
        <li>Subject line, sender name and address, and a summary of the recipients.</li>
        <li>The date, the Gmail labels already on it, and flags such as read, starred or draft.</li>
        <li>
          The short snippet Gmail itself generates, truncated. This is the only text from inside a
          message that MailMind ever holds.
        </li>
        <li>
          Whether the message has attachments, and its approximate size. Never the attachments.
        </li>
      </ul>
      <p>
        <strong>
          MailMind never requests, receives or stores the body of an email, its raw MIME, or any
          attachment.
        </strong>{' '}
        This is not a promise about restraint; it is what the request to Gmail asks for.
      </p>
      <p>
        Separately, if you use the <Link to="/feedback">feedback form</Link>, MailMind stores what
        you typed, which of the four kinds you picked, and the route you were on. It stores an email
        address only if you enter one, and leaving that blank is a real choice: nothing else is
        recorded either way — not your IP address, not your browser, not where you came from. You do
        not need an account to send feedback, and if you have one it is attached so a reply can find
        you.
      </p>

      <h2>What it is used for</h2>
      <p>
        Each message is assigned three labels — the sending brand, a subject area, and what the
        message wants — from a vocabulary you approve. Those become the folders you browse and
        search. Nothing else is done with your mail, and nothing is used to train any model of ours,
        because we do not train models.
      </p>

      <h2>Who it is shared with</h2>
      <p>
        <strong>Google Gemini.</strong> To assign a subject area and an intent, the subject line,
        the sender address, the sending domain and the truncated snippet of a message are sent to
        Google&rsquo;s Gemini API. Nothing else is sent — no body, no attachment, no recipient list.
        The sending brand is derived from the sender&rsquo;s domain in our own code and is never
        sent to a model.
      </p>
      <p>
        Google&rsquo;s terms for the <em>free</em> Gemini tier permit Google to use submitted
        content to improve its products. MailMind is not operated on the free tier for anyone other
        than its own author; if you are using a MailMind instance you did not deploy yourself and
        are unsure which tier it uses, ask before connecting a mailbox.
      </p>
      <p>
        <strong>Infrastructure.</strong> The application runs on Vercel (the web app) and Render
        (the API), with the database hosted on Supabase. Errors are reported to Sentry with message
        content, tokens and cookies redacted before they leave the server.
      </p>
      <p>Nothing is sold, and nothing is shared for advertising.</p>

      <h2>Google API Services User Data Policy</h2>
      <p>
        MailMind&rsquo;s use of information received from Google APIs adheres to the{' '}
        <a
          href="https://developers.google.com/terms/api-services-user-data-policy"
          target="_blank"
          rel="noreferrer noopener"
        >
          Google API Services User Data Policy
        </a>
        , including the Limited Use requirements.
      </p>

      <h2>How long it is kept</h2>
      <p>
        Message metadata is kept while your account exists, because it is what the folders are built
        from. Deleting your account deletes it. Audit records of security-relevant events —
        sign-ins, permission changes, deletions — are kept without your identifier attached, which
        is what lets us show that a deletion happened without holding on to you afterwards.
      </p>
      <p>
        Feedback sent while signed in is deleted with your account. Feedback sent without an account
        has nothing to attach it to, so it stays — it is what you wrote and, if you left one, the
        address you asked to be answered at.
      </p>

      <h2>Deleting your data</h2>
      <p>
        You can disconnect Gmail at any time, which revokes MailMind&rsquo;s access to your mailbox.
        You can delete your account and everything stored about it from the{' '}
        <Link to="/data-deletion">data deletion page</Link>. It is immediate and it is not
        recoverable.
      </p>

      <h2>Security</h2>
      <p>
        Google tokens are encrypted at rest with a versioned key and are never sent to the browser.
        Sessions are opaque HttpOnly cookies. The API is the only thing that talks to Google, to the
        database, or to Gemini.
      </p>

      <h2>Changes</h2>
      <p>
        If this policy changes materially, the date at the top changes and connected users are told
        before the change takes effect.
      </p>
    </LegalDocument>
  );
}
