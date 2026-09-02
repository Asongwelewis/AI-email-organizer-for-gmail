import { CheckCircle2, LockKeyhole, ShieldCheck } from 'lucide-react';
import { Link } from 'react-router-dom';

import { LegalDocument } from './LegalDocument';
import { LEGAL_UPDATED } from './legal-contact';

const controls = [
  [
    'Credentials stay server-side',
    'Google access and refresh tokens are encrypted at rest and never sent to the browser.',
  ],
  [
    'Sessions are opaque',
    'The browser receives an HttpOnly, Secure session cookie; the frontend never reads or stores the session value.',
  ],
  [
    'Browser mutations are origin-checked',
    'State-changing API requests require a trusted web origin and use SameSite protections.',
  ],
  [
    'Errors are privacy-scrubbed',
    'Sentry telemetry removes users, cookies, authorization values, message content, email addresses, and sensitive URL paths.',
  ],
  [
    'The UI escapes untrusted text',
    'Message subjects, senders, snippets, labels, and error responses render through React text nodes rather than raw HTML.',
  ],
  [
    'Deployment headers are restrictive',
    'The app uses CSP, frame protections, HSTS, referrer limits, and a restrictive Permissions-Policy.',
  ],
] as const;

export function SecurityPage() {
  return (
    <LegalDocument
      title="Security at MailMind"
      updated={LEGAL_UPDATED}
      summary={
        <p>
          Mail is sensitive. The safest product boundary is the one that makes the browser hold as
          little power and as little information as possible.
        </p>
      }
    >
      <div className="security-banner">
        <LockKeyhole aria-hidden="true" />
        <div>
          <strong>Read-only by default.</strong>
          <p>MailMind’s standard Gmail connection cannot change your messages or labels.</p>
        </div>
      </div>

      <h2>Controls in place</h2>
      <div className="security-list">
        {controls.map(([title, copy]) => (
          <article key={title}>
            <CheckCircle2 aria-hidden="true" />
            <div>
              <h3>{title}</h3>
              <p>{copy}</p>
            </div>
          </article>
        ))}
      </div>

      <h2>What we cannot promise</h2>
      <p>
        A browser extension with permission to inspect pages can see information rendered on any
        website. MailMind cannot override that browser-level authority. We reduce the impact by
        keeping tokens out of JavaScript storage and the DOM, but only install extensions you trust.
      </p>

      <h2>Your controls</h2>
      <p>
        Disconnect Gmail to revoke access and remove stored tokens. Use the in-app account controls
        or the <Link to="/data-deletion">data deletion page</Link> to remove synchronized metadata
        and account data. Report a suspected vulnerability through{' '}
        <Link to="/support">Support</Link>.
      </p>

      <div className="trust-callout">
        <ShieldCheck aria-hidden="true" />
        <p>
          Security is a living process. If a claim here stops matching the product, please report it
          so the page and the implementation can be corrected together.
        </p>
      </div>
    </LegalDocument>
  );
}
