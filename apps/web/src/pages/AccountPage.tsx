import { useState } from 'react';
import { LogOut, Mail, ShieldCheck, Trash2, Unplug } from 'lucide-react';
import { Link } from 'react-router-dom';

import { ConfirmDialog } from '@web/components/ConfirmDialog';
import { ErrorNotice } from '@web/components/app/ErrorNotice';
import { useAuth } from '@web/context/useAuth';

export function AccountPage() {
  const { user, gmailConnection, disconnectGmail, logoutAll, isDisconnecting } = useAuth();
  const [disconnectOpen, setDisconnectOpen] = useState(false);
  const [actionError, setActionError] = useState<unknown>(null);

  if (!user) return null;

  async function confirmDisconnect() {
    setActionError(null);
    try {
      await disconnectGmail();
      setDisconnectOpen(false);
    } catch (error) {
      setActionError(error);
    }
  }

  return (
    <section className="screen account-screen">
      <header className="screen__head">
        <div>
          <span className="eyebrow">Private controls</span>
          <h1 className="screen__title">Account &amp; privacy</h1>
        </div>
      </header>
      <p className="screen__lede">
        See what is connected, end access, and remove your MailMind data without hunting through a
        settings maze.
      </p>

      <div className="account-grid">
        <article className="account-card">
          <div className="account-card__icon">
            <ShieldCheck aria-hidden="true" />
          </div>
          <span className="eyebrow">MailMind identity</span>
          <h2>{user.displayName || 'Your account'}</h2>
          <p>{user.email}</p>
          <dl className="account-facts">
            <div>
              <dt>Session</dt>
              <dd>HttpOnly cookie</dd>
            </div>
            <div>
              <dt>Browser tokens</dt>
              <dd>None stored</dd>
            </div>
          </dl>
        </article>

        <article className="account-card">
          <div className="account-card__icon">
            <Mail aria-hidden="true" />
          </div>
          <span className="eyebrow">Gmail connection</span>
          <h2>{gmailConnection?.connected ? 'Connected' : 'Not connected'}</h2>
          <p>
            {gmailConnection?.connected
              ? `Connected as ${gmailConnection.email ?? 'your Google account'}.`
              : 'Your MailMind sign-in does not grant Gmail access.'}
          </p>
          {gmailConnection?.connected ? (
            <button
              className="button button--quiet"
              type="button"
              onClick={() => setDisconnectOpen(true)}
            >
              <Unplug aria-hidden="true" /> Disconnect Gmail
            </button>
          ) : null}
        </article>
      </div>

      {actionError ? <ErrorNotice error={actionError} /> : null}

      <div className="account-actions">
        <div>
          <h2>End every session</h2>
          <p>
            Useful if you signed in on a shared machine or suspect an old session is still open.
          </p>
        </div>
        <button className="button" type="button" onClick={() => void logoutAll()}>
          <LogOut aria-hidden="true" /> Log out everywhere
        </button>
      </div>

      <div className="account-actions account-actions--danger">
        <div>
          <h2>Delete your MailMind data</h2>
          <p>
            This removes your account, synchronized metadata, folders, decisions, and stored Gmail
            tokens.
          </p>
        </div>
        <Link className="button button--danger" to="/data-deletion">
          <Trash2 aria-hidden="true" /> Delete data
        </Link>
      </div>

      <ConfirmDialog
        open={disconnectOpen}
        title="Disconnect Gmail?"
        description="MailMind will revoke the Gmail grant and remove stored connection tokens. Your MailMind account and existing synchronized view will remain."
        confirmLabel="Disconnect Gmail"
        busy={isDisconnecting}
        onConfirm={() => void confirmDisconnect()}
        onCancel={() => setDisconnectOpen(false)}
      />
    </section>
  );
}
