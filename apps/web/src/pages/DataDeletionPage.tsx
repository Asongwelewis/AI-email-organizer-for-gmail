import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Link } from 'react-router-dom';

import { ErrorNotice } from '@web/components/app/ErrorNotice';
import { useAuth } from '@web/context/useAuth';
import { api } from '@web/services/http';

import { LegalDocument } from './LegalDocument';
import { LEGAL_CONTACT, LEGAL_UPDATED } from './legal-contact';

/**
 * Deleting an account, in the app.
 *
 * Google's restricted-scope policy requires this to exist and to be reachable without writing to
 * anybody, which is why it is a public URL rather than a settings screen — the page has to be
 * linkable from a policy document and from the Cloud Console.
 *
 * Signed out it explains what deletion does. Signed in it does it. The typed confirmation is not
 * decoration: this cascades through every message, folder and decision the account owns, and
 * nothing here is recoverable.
 */
const CONFIRMATION = 'delete my account';

export function DataDeletionPage() {
  const { user, logout } = useAuth();
  const [typed, setTyped] = useState('');

  const deleteMutation = useMutation({
    mutationFn: () => api.deleteAccount(),
    onSuccess: async () => {
      /*
       * The server already cleared the cookie, so this is the client catching up: it drops the
       * cached user and query data rather than leaving a signed-in shell over an account that no
       * longer exists. The logout call itself is expected to be a no-op.
       */
      await logout().catch(() => undefined);
    },
  });

  return (
    <LegalDocument
      title="Delete your data"
      updated={LEGAL_UPDATED}
      summary={
        <p>
          Deleting your MailMind account removes everything stored about you and revokes
          MailMind&rsquo;s access to your mailbox. Your mail itself is untouched: it is in Gmail,
          where it always was.
        </p>
      }
    >
      <h2>What is deleted</h2>
      <ul>
        <li>Your MailMind account, and every session signed in to it.</li>
        <li>The stored metadata for every message — subjects, senders, dates, snippets.</li>
        <li>Every facet, folder, routing rule and filing decision derived from them.</li>
        <li>
          Your Gmail connection, including the stored tokens, which are revoked with Google before
          anything is deleted so no live grant is left behind.
        </li>
      </ul>

      <h2>What is kept</h2>
      <p>
        A record that an account existed and was deleted, with no identifier attached — no user id,
        no session, no email address. That record is the evidence the deletion happened, and
        destroying it would destroy the proof.
      </p>

      <h2>What is not affected</h2>
      <p>
        Your email. MailMind holds a description of your mailbox, not a copy of it, and by default
        it cannot change anything in Gmail at all. If you used the optional Gmail label export, the
        labels it created stay in your mailbox — deleting a label in Gmail never unlabels the mail
        beneath it, so removing them is yours to do, in Gmail.
      </p>

      {user ? (
        <>
          <h2>Delete the account for {user.email}</h2>
          {deleteMutation.isSuccess ? (
            <p className="notice" role="status">
              Deleted. Nothing about that account remains. <Link to="/">Return home</Link>
            </p>
          ) : (
            <>
              <p>
                This is immediate and cannot be undone. Type <code>{CONFIRMATION}</code> to confirm.
              </p>
              <label className="legal-doc__confirm">
                <span className="sr-only">Type {CONFIRMATION} to confirm</span>
                <input
                  type="text"
                  value={typed}
                  autoComplete="off"
                  placeholder={CONFIRMATION}
                  onChange={(event) => setTyped(event.target.value)}
                />
              </label>
              <button
                className="button button--danger"
                type="button"
                disabled={typed.trim().toLowerCase() !== CONFIRMATION || deleteMutation.isPending}
                onClick={() => deleteMutation.mutate()}
              >
                {deleteMutation.isPending ? 'Deleting…' : 'Delete everything'}
              </button>
              {deleteMutation.isError ? <ErrorNotice error={deleteMutation.error} /> : null}
            </>
          )}
        </>
      ) : (
        <>
          <h2>Deleting your account</h2>
          <p>
            <Link to="/login">Sign in</Link> and return to this page to delete your account
            yourself. If you cannot sign in — because you have already removed MailMind from your
            Google account, for instance — write to{' '}
            <a href={`mailto:${LEGAL_CONTACT}`}>{LEGAL_CONTACT}</a> from the address the account was
            created with and it will be deleted for you.
          </p>
        </>
      )}
    </LegalDocument>
  );
}
