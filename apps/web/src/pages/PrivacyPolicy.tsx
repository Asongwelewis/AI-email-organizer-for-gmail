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
          AMO reads the <strong>headers</strong> of your Gmail — subject, sender, recipients, date,
          labels and Gmail&rsquo;s own short preview line — and classifies and organizes every
          message into folders for you, automatically. It never reads the body of an email or any
          attachment, because it never asks Gmail for them, and{' '}
          <strong>no AI model ever reads your mail</strong>. Your data stays yours: when you sign
          out you choose whether AMO keeps it for next time or deletes every trace of it. Nothing is
          sold, advertised against, or shared with anyone to read.
        </p>
      }
    >
      <h2>Who this is</h2>
      <p>
        AMO is operated by {LEGAL_ENTITY}. Questions about this policy, or about the data held about
        you, go to <a href={`mailto:${LEGAL_CONTACT}`}>{LEGAL_CONTACT}</a>.
      </p>

      <h2>What is collected</h2>
      <p>
        When you sign in with Google, AMO stores your Google account id, email address and display
        name, and the profile picture URL Google supplies. That is what an account is.
      </p>
      <p>
        When you connect Gmail, AMO requests <code>gmail.readonly</code> — read-only access — and
        asks Gmail only for message <em>metadata</em>. For each message it stores:
      </p>
      <ul>
        <li>Gmail&rsquo;s message and thread identifiers.</li>
        <li>Subject line, sender name and address, and a summary of the recipients.</li>
        <li>The date, the Gmail labels already on it, and flags such as read, starred or draft.</li>
        <li>
          The short snippet Gmail itself generates, truncated. This is the only text from inside a
          message that AMO ever holds.
        </li>
        <li>
          Whether the message has attachments, and its approximate size. Never the attachments.
        </li>
      </ul>
      <p>
        <strong>
          AMO never requests, receives or stores the body of an email, its raw MIME, or any
          attachment.
        </strong>{' '}
        This is not a promise about restraint; it is what the request to Gmail asks for.
      </p>
      <p>
        Separately, if you use the <Link to="/feedback">feedback form</Link>, AMO stores what you
        typed, which of the four kinds you picked, and the route you were on. It stores an email
        address only if you enter one, and leaving that blank is a real choice: nothing else is
        recorded either way — not your IP address, not your browser, not where you came from. You do
        not need an account to send feedback, and if you have one it is attached so a reply can find
        you.
      </p>

      <h2>What it is used for</h2>
      <p>
        Each message is <strong>classified automatically</strong> along three axes — the sending
        brand, an area of life such as finance or career, and what the message is for, such as a
        receipt or a security alert — and organized into the folders you browse and search. When you
        connect Gmail, AMO classifies the last two years of your mail; after that, every new email
        is classified within about a minute of arriving. Mail older than two years before you first
        connected is never synchronized or stored.
      </p>
      <p>
        <strong>How the classification works.</strong> AMO&rsquo;s classifier is smart
        classification that runs entirely on AMO&rsquo;s own server: routing rules learned from
        AI-labelled examples, well-known senders, and the category Gmail itself already put the
        message in. It works only from the header details listed above — the body of your mail is
        never read — and on a real 11,000-email mailbox it classified 11,244 of 11,245 messages. No
        part of your mail is sent to an AI model or to any other service to be classified, and
        nothing about your mail is used to train any model.
      </p>

      <h2>Who it is shared with</h2>
      <p>
        <strong>No AI provider.</strong> Your mail is classified on AMO&rsquo;s own server and is
        not sent to Google Gemini, to any other AI service, or to anyone else to be read. (The
        operator&rsquo;s own mailbox is the one exception: it is classified with Google Gemini, and
        the examples it produced are what AMO&rsquo;s rules were learned from. No other user&rsquo;s
        mail ever reaches it.)
      </p>
      <p>
        <strong>Your browser&rsquo;s push service.</strong> If you turn on notifications for a
        device, each new-mail alert &mdash; the sender and the subject &mdash; is delivered through
        that browser&rsquo;s push service (Google&rsquo;s for Chrome, Microsoft&rsquo;s for Edge,
        Mozilla&rsquo;s for Firefox). It is encrypted so that only your browser can read it, and
        nothing is sent to a device you have not turned notifications on for. Turn them off at any
        time under Menu &rarr; Notifications; logging out turns them off for that device.
      </p>
      <p>
        <strong>Infrastructure.</strong> The application runs on Vercel (the web app) and Render
        (the API), with the database hosted on Supabase. Errors are reported to Sentry with message
        content, tokens and cookies redacted before they leave the server.
      </p>
      <p>Nothing is sold, and nothing is shared for advertising.</p>

      <h2>Google API Services User Data Policy</h2>
      <p>
        AMO&rsquo;s use of information received from Google APIs adheres to the{' '}
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
        <strong>Your data stays with you, and you decide how long.</strong> Message metadata is kept
        while your account exists, because it is what the folders are built from, and only for the
        two years of mail AMO sorts. Every time you sign out, AMO asks whether to keep your data so
        your folders are waiting when you sign in again with the same Google account, or to delete
        everything permanently — the same deletion as below. Audit records of security-relevant
        events — sign-ins, permission changes, deletions — are kept without your identifier
        attached, which is what lets us show that a deletion happened without holding on to you
        afterwards.
      </p>
      <p>
        Feedback sent while signed in is deleted with your account. Feedback sent without an account
        has nothing to attach it to, so it stays — it is what you wrote and, if you left one, the
        address you asked to be answered at.
      </p>

      <h2>Deleting your data</h2>
      <p>
        You can disconnect Gmail at any time, which revokes AMO&rsquo;s access to your mailbox. You
        can delete your account and everything stored about it when you sign out, or at any time
        from the <Link to="/data-deletion">data deletion page</Link>. It revokes AMO&rsquo;s Google
        access first, then removes every message, folder and decision from AMO&rsquo;s systems. It
        is immediate and it is not recoverable.
      </p>

      <h2>Security</h2>
      <p>
        Google tokens are encrypted at rest with a versioned key and are never sent to the browser.
        Sessions are opaque HttpOnly cookies. The API is the only thing that talks to Google or to
        the database, and your mail never leaves it for an AI service.
      </p>

      <h2>Changes</h2>
      <p>
        If this policy changes materially, the date at the top changes and connected users are told
        before the change takes effect.
      </p>
    </LegalDocument>
  );
}
