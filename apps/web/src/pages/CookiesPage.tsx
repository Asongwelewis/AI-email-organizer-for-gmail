import { Cookie, Settings2 } from 'lucide-react';
import { Link } from 'react-router-dom';

import { LegalDocument } from './LegalDocument';
import { LEGAL_UPDATED } from './legal-contact';

export function CookiesPage() {
  return (
    <LegalDocument
      title="Cookies and local storage"
      updated={LEGAL_UPDATED}
      summary={
        <p>MailMind uses the smallest browser storage surface needed to keep the app usable.</p>
      }
    >
      <div className="security-list">
        <article>
          <Cookie aria-hidden="true" />
          <div>
            <h3>Strictly necessary session cookie</h3>
            <p>
              The API sets an opaque HttpOnly session cookie so the browser can stay signed in. It
              is Secure in production, scoped to the API, and unavailable to page JavaScript.
            </p>
          </div>
        </article>
        <article>
          <Settings2 aria-hidden="true" />
          <div>
            <h3>Local preferences</h3>
            <p>
              The interface stores only non-sensitive preferences such as theme and email time-range
              selection in local storage. No access token, refresh token, message, or account secret
              is stored there.
            </p>
          </div>
        </article>
      </div>
      <p>
        MailMind does not use advertising cookies or cross-site tracking cookies. Clearing site data
        resets preferences and signs you out; it does not delete server-side account data. Use the{' '}
        <Link to="/data-deletion">data deletion page</Link> for that.
      </p>
    </LegalDocument>
  );
}
