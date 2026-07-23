import { useState, type ReactNode } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  ChevronDown,
  Link2Off,
  RefreshCw,
} from 'lucide-react';
import { toast } from 'sonner';

import { ConfirmDialog } from '@web/components/ConfirmDialog';
import { MagneticButton } from '@web/components/MagneticButton';
import { RouteLoader } from '@web/components/RouteLoader';
import { useAuth } from '@web/context/useAuth';
import { getSafeErrorMessage } from '@web/services/errorMessages';
import { useGmailSyncActions, useGmailSyncStatusQuery } from '@web/queries/gmailQueries';

export function ConnectionsPage() {
  const { gmailConnection, connectGmail, disconnectGmail, isDisconnecting, isRedirecting } =
    useAuth();
  const [confirmOpen, setConfirmOpen] = useState(false);

  if (!gmailConnection) return <RouteLoader label="Checking your Gmail connection" />;

  const handleDisconnect = async () => {
    try {
      await disconnectGmail();
      setConfirmOpen(false);
      toast.success('Gmail disconnected. Your MailMind account is still active.');
    } catch (error) {
      toast.error(getSafeErrorMessage(error, 'Gmail could not be disconnected. Please try again.'));
    }
  };

  return (
    <div className="connections-page">
      <header className="page-heading">
        <span className="eyebrow">Settings / Connections</span>
        <h1>
          One account.
          <br />
          <em>Your call.</em>
        </h1>
        <p>
          MailMind login and Gmail access are deliberately separate. Change this connection without
          changing who you are.
        </p>
      </header>

      <section className="connection-stage" aria-live="polite">
        {gmailConnection.status === 'CONNECTED' && gmailConnection.connected ? (
          <ConnectedState
            email={gmailConnection.email}
            connectedAt={gmailConnection.connectedAt ?? null}
            scopes={gmailConnection.grantedScopes}
            onDisconnect={() => setConfirmOpen(true)}
          />
        ) : gmailConnection.status === 'REAUTH_REQUIRED' ? (
          <ActionState
            tone="warning"
            icon={<RefreshCw />}
            eyebrow="Connection needs attention"
            title="A fresh Google approval is needed."
            copy="Access may have expired or been revoked. Your MailMind login remains active."
            action="Reconnect Gmail"
            onAction={connectGmail}
            busy={isRedirecting}
          />
        ) : gmailConnection.status === 'REVOKED' ? (
          <ActionState
            tone="warning"
            icon={<Link2Off />}
            eyebrow="Google access revoked"
            title="Gmail is no longer available."
            copy="Reconnect whenever you want to restore the Gmail permission."
            action="Reconnect Gmail"
            onAction={connectGmail}
            busy={isRedirecting}
          />
        ) : gmailConnection.status === 'ERROR' ? (
          <ActionState
            tone="error"
            icon={<AlertTriangle />}
            eyebrow="Connection problem"
            title="Gmail could not be reached."
            copy="No internal error details were exposed. Try the connection again safely."
            action="Try again"
            onAction={connectGmail}
            busy={isRedirecting}
          />
        ) : (
          <DisconnectedState onConnect={connectGmail} busy={isRedirecting} />
        )}
      </section>

      <ConfirmDialog
        open={confirmOpen}
        title="Disconnect Gmail?"
        description="This will stop MailMind from accessing Gmail. Your MailMind account will remain active."
        confirmLabel="Disconnect Gmail"
        destructive
        busy={isDisconnecting}
        onCancel={() => setConfirmOpen(false)}
        onConfirm={() => void handleDisconnect()}
      />
    </div>
  );
}

function DisconnectedState({ onConnect, busy }: { onConnect: () => void; busy: boolean }) {
  return (
    <div className="disconnected-state">
      <span className="connection-orbit" aria-hidden="true">
        <i />
        <i />
      </span>
      <div>
        <span className="eyebrow">Gmail is not connected</span>
        <h2>Keep it separate until you’re ready.</h2>
        <p>
          Future MailMind tools will use Gmail permission to read messages required for
          organization, create or modify labels, and apply labels. Those tools are not operating
          yet.
        </p>
        <MagneticButton onClick={onConnect} disabled={busy}>
          {busy ? 'Opening Google…' : 'Connect Gmail'} <ArrowRight />
        </MagneticButton>
      </div>
    </div>
  );
}

function ConnectedState({
  email,
  connectedAt,
  scopes,
  onDisconnect,
}: {
  email: string | null;
  connectedAt?: string | null;
  scopes: string[];
  onDisconnect: () => void;
}) {
  const syncStatus = useGmailSyncStatusQuery(true);
  const actions = useGmailSyncActions();
  const busy =
    Boolean(syncStatus.data?.syncRunning) ||
    actions.labels.isPending ||
    actions.initial.isPending ||
    actions.incremental.isPending;

  const run = async (
    action: () => Promise<unknown>,
    successMessage: string,
    failureMessage: string,
  ) => {
    try {
      await action();
      toast.success(successMessage);
    } catch (error) {
      toast.error(getSafeErrorMessage(error, failureMessage));
      await syncStatus.refetch();
    }
  };

  return (
    <div className="connected-state">
      <div className="connected-state__status">
        <CheckCircle2 /> Connected
      </div>
      <span className="eyebrow">Gmail connection</span>
      <h2>{email ?? 'Connected Gmail account'}</h2>
      <p>
        {connectedAt
          ? `Connected on ${new Intl.DateTimeFormat(undefined, { dateStyle: 'long' }).format(new Date(connectedAt))}.`
          : 'Your Gmail permission is active.'}
      </p>
      <div className="permission-summary">
        <strong>Permission summary</strong>
        <span>MailMind can modify Gmail labels when future organization tools are enabled.</span>
      </div>
      <details>
        <summary>
          Technical permission details <ChevronDown />
        </summary>
        <ul>
          {scopes.map((scope) => (
            <li key={scope}>{scope}</li>
          ))}
        </ul>
      </details>
      <div className="gmail-sync-panel">
        <div>
          <strong>Gmail synchronization</strong>
          {syncStatus.isLoading ? (
            <span>Checking sync state…</span>
          ) : syncStatus.isError ? (
            <span>Sync status is temporarily unavailable.</span>
          ) : (
            <span>
              {syncStatus.data?.messageCount ?? 0} message records
              {syncStatus.data?.lastSuccessfulSyncAt
                ? ` · Last synced ${new Intl.DateTimeFormat(undefined, {
                    dateStyle: 'medium',
                    timeStyle: 'short',
                  }).format(new Date(syncStatus.data.lastSuccessfulSyncAt))}`
                : ' · Not synced yet'}
            </span>
          )}
          {syncStatus.data?.status === 'HISTORY_EXPIRED' && (
            <span>The Gmail history window expired. Run a fresh initial sync.</span>
          )}
          {syncStatus.data?.status === 'REAUTH_REQUIRED' && (
            <span>Reconnect Gmail before synchronizing again.</span>
          )}
          {syncStatus.data?.status === 'FAILED' && (
            <span>The last sync failed safely. Your previous checkpoint was preserved.</span>
          )}
        </div>
        <div className="gmail-sync-panel__actions">
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              void run(
                actions.labels.mutateAsync,
                'MailMind labels are ready.',
                'Labels could not be initialized.',
              )
            }
          >
            Prepare labels
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              void run(
                syncStatus.data?.initialSyncCompleted
                  ? actions.incremental.mutateAsync
                  : actions.initial.mutateAsync,
                'Gmail synchronization completed.',
                'Gmail could not be synchronized.',
              )
            }
          >
            {busy
              ? 'Syncing…'
              : syncStatus.data?.initialSyncCompleted
                ? 'Sync now'
                : 'Start initial sync'}
          </button>
        </div>
      </div>
      <MagneticButton variant="danger" onClick={onDisconnect}>
        Disconnect Gmail
      </MagneticButton>
    </div>
  );
}

function ActionState({
  icon,
  eyebrow,
  title,
  copy,
  action,
  onAction,
  busy,
  tone,
}: {
  icon: ReactNode;
  eyebrow: string;
  title: string;
  copy: string;
  action: string;
  onAction: () => void;
  busy: boolean;
  tone: 'warning' | 'error';
}) {
  return (
    <div className={`action-state action-state--${tone}`}>
      <div className="action-state__icon">{icon}</div>
      <span className="eyebrow">{eyebrow}</span>
      <h2>{title}</h2>
      <p>{copy}</p>
      <MagneticButton onClick={onAction} disabled={busy}>
        {busy ? 'Opening Google…' : action} <ArrowRight />
      </MagneticButton>
    </div>
  );
}
