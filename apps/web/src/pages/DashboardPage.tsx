import { useState } from 'react';
import { ArrowRight, CheckCircle2, Link2, LogOut, ShieldCheck } from 'lucide-react';
import { Link, useOutletContext } from 'react-router-dom';

import { Avatar } from '@web/components/Avatar';
import { ConfirmDialog } from '@web/components/ConfirmDialog';
import { MagneticButton } from '@web/components/MagneticButton';
import { useAuth } from '@web/context/useAuth';

interface OutletContext {
  openLogoutAll: () => void;
}

export function DashboardPage() {
  const { user, gmailConnection, logout } = useAuth();
  const { openLogoutAll } = useOutletContext<OutletContext>();
  const [logoutOpen, setLogoutOpen] = useState(false);

  if (!user) return null;
  const connected = gmailConnection?.connected === true;

  return (
    <div className="dashboard-page">
      <section className="dashboard-welcome">
        <div>
          <span className="eyebrow">Signed in securely</span>
          <h1>
            Good to see you,
            <br />
            <em>{user.displayName?.split(' ')[0] ?? 'there'}.</em>
          </h1>
          <p>
            Your MailMind identity is active. Gmail access remains a separate connection you
            control.
          </p>
        </div>
        <Avatar name={user.displayName} email={user.email} src={user.avatarUrl} size="large" />
      </section>

      <section className="dashboard-grid">
        <article className="identity-card">
          <span className="card-index">01 / Identity</span>
          <div className="identity-card__status">
            <CheckCircle2 /> MailMind session active
          </div>
          <h2>{user.displayName ?? 'MailMind member'}</h2>
          <p>{user.email}</p>
          <div className="identity-card__actions">
            <MagneticButton variant="outline" onClick={() => setLogoutOpen(true)}>
              <LogOut /> Log out here
            </MagneticButton>
            <button type="button" className="text-button" onClick={openLogoutAll}>
              Log out all devices
            </button>
          </div>
        </article>

        <article className={`connection-card ${connected ? 'connection-card--connected' : ''}`}>
          <span className="card-index">02 / Gmail connection</span>
          <div className="connection-card__symbol">
            <Link2 aria-hidden="true" />
          </div>
          <h2>{connected ? 'Gmail connected' : 'Gmail stays separate'}</h2>
          <p>
            {connected
              ? `${gmailConnection.email ?? 'Your Gmail account'} is connected for future organization tools.`
              : 'Connect Gmail when you are ready. Signing in never grants inbox access automatically.'}
          </p>
          <Link className="inline-link" to="/settings/connections">
            Manage connection <ArrowRight aria-hidden="true" />
          </Link>
        </article>

        <article className="stage-card">
          <ShieldCheck aria-hidden="true" />
          <div>
            <span className="card-index">Stage 2</span>
            <h2>The secure foundation is ready.</h2>
            <p>Inbox organization, labels, and analysis are intentionally not active yet.</p>
          </div>
        </article>
      </section>

      <ConfirmDialog
        open={logoutOpen}
        title="Log out on this device?"
        description="This browser session will end. Other MailMind sessions will remain active."
        confirmLabel="Log out"
        onCancel={() => setLogoutOpen(false)}
        onConfirm={() => void logout()}
      />
    </div>
  );
}
