import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check } from 'lucide-react';

import { ErrorNotice } from '@web/components/app/ErrorNotice';
import { LoadingState } from '@web/components/app/StateViews';
import { OnboardingProgress } from '@web/components/app/OnboardingProgress';
import { useOnboarding } from '@web/queries/onboarding';
import { queryKeys } from '@web/queries/queryKeys';
import { api, getBackendRedirectUrl } from '@web/services/http';

/**
 * The first-run path: one button, then progress.
 *
 * This used to be three manual steps — connect, "Start reading", "Sort my mail" — and the last one
 * failed for anybody but the owner, because sorting needs an approved vocabulary and there was no
 * screen to approve one on. Everything after connecting Gmail now runs on the server by itself
 * (see the API's onboarding service), and this screen shows it happening.
 */

type StepState = 'done' | 'current' | 'waiting';

function Step({
  index,
  title,
  description,
  state,
  children,
}: {
  index: number;
  title: string;
  description: string;
  state: StepState;
  children?: React.ReactNode;
}) {
  return (
    <li className={`setup-step setup-step--${state}`}>
      <span className="setup-step__marker" aria-hidden="true">
        {state === 'done' ? <Check strokeWidth={2.5} /> : index}
      </span>
      <div className="setup-step__body">
        <p className="setup-step__title">
          {title}
          {state === 'done' ? <span className="sr-only"> — done</span> : null}
        </p>
        <p className="setup-step__description">{description}</p>
        {state === 'current' && children ? (
          <div className="setup-step__action">{children}</div>
        ) : null}
      </div>
    </li>
  );
}

export function SetupPage() {
  const queryClient = useQueryClient();

  const connectionQuery = useQuery({
    queryKey: queryKeys.gmailConnection,
    queryFn: () => api.getGmailStatus(),
  });
  const connection = connectionQuery.data;
  const connected = Boolean(connection?.connected);
  const onboarding = useOnboarding(connected);

  /*
   * Card 25. Google's grants are cumulative per client, so asking for less does not take the wider
   * scope back — an account connected before the read-only downgrade keeps `gmail.modify` until
   * the grant is revoked and made again. Revoking is exactly what disconnecting does, so narrowing
   * is a disconnect followed by a fresh connect rather than a new endpoint.
   */
  const narrowMutation = useMutation({
    mutationFn: () => api.disconnectGmail(),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.gmailConnection });
      window.location.assign(getBackendRedirectUrl('/integrations/google/connect'));
    },
  });

  if (connectionQuery.isPending) return <LoadingState label="Checking your mailbox…" />;

  return (
    <section className="screen">
      <header className="screen__head">
        <h1 className="screen__title">Set up</h1>
      </header>
      <p className="screen__lede">
        Connect Gmail and AMO does the rest: it reads your recent mail, sets up your categories and
        sorts your newest mail into folders. After that, new mail is sorted as it arrives.
      </p>

      {connectionQuery.isError ? (
        <ErrorNotice error={connectionQuery.error} onRetry={() => void connectionQuery.refetch()} />
      ) : null}

      {!connected || connection?.requiresReauthentication ? (
        <ol className="setup-steps">
          <Step
            index={1}
            state="current"
            title="Connect Gmail"
            description={
              connection?.requiresReauthentication
                ? 'Your Gmail access expired. Reconnect to carry on.'
                : 'AMO asks for read-only access and reads message headers only — never the body of an email, and never an attachment.'
            }
          >
            <a
              className="button button--primary"
              href={getBackendRedirectUrl('/integrations/google/connect')}
            >
              {connection?.requiresReauthentication ? 'Reconnect Gmail' : 'Connect Gmail'}
            </a>
          </Step>
        </ol>
      ) : onboarding.status ? (
        <OnboardingProgress
          status={onboarding.status}
          onRetry={onboarding.retry}
          retrying={onboarding.retrying}
          showWhenDone
        />
      ) : onboarding.error ? (
        <ErrorNotice error={onboarding.error} />
      ) : (
        <LoadingState label="Checking setup…" />
      )}

      {/*
        AMO cannot write to a mailbox it only reads, and it no longer needs to. Holding an
        unused permission to alter someone's mail is worth offering to give back rather than
        quietly keeping.
      */}
      {connection?.holdsUnusedWriteScope ? (
        <div className="notice" role="status">
          <div className="notice__body">
            <p className="notice__title">AMO can still change your mail</p>
            <p className="notice__message">
              This mailbox was connected when AMO wrote labels into Gmail, so it still holds
              permission to alter and delete your mail. It does not use it. Narrowing reconnects you
              with read-only access — your folders are built here and are unaffected.
            </p>
          </div>
          <button
            className="button button--quiet"
            type="button"
            disabled={narrowMutation.isPending}
            onClick={() => narrowMutation.mutate()}
          >
            {narrowMutation.isPending ? 'Narrowing…' : 'Narrow to read-only'}
          </button>
        </div>
      ) : null}

      {narrowMutation.isError ? <ErrorNotice error={narrowMutation.error} /> : null}
    </section>
  );
}
