import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check } from 'lucide-react';

import { ErrorNotice } from '@web/components/app/ErrorNotice';
import { LoadingState } from '@web/components/app/StateViews';
import { formatCount } from '@web/lib/format';
import { queryKeys } from '@web/queries/queryKeys';
import { api, getBackendRedirectUrl } from '@web/services/http';

/**
 * The first-run path, which until now did not exist.
 *
 * Signing in landed on an empty Sorted screen and the only route onwards was Approve, which
 * answered `409` because Gmail had never been connected and no mail had ever been synced. Every
 * call needed to get past that already existed on the HTTP client and no component called any of
 * them. This is those calls, in the order they have to happen.
 *
 * Each step is gated on the one before it rather than merely listed, because the failure this
 * replaces was a screen that offered an action the account was not ready for.
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

  const syncQuery = useQuery({
    queryKey: queryKeys.gmailSyncStatus,
    queryFn: () => api.getGmailSyncStatus(),
    enabled: connected,
    // Only while a sync is actually moving. A screen that polls a finished mailbox forever is a
    // battery cost for nothing.
    refetchInterval: (query) => (query.state.data?.syncRunning ? 2000 : false),
  });
  const sync = syncQuery.data;
  const synced = Boolean(sync?.initialSyncCompleted);

  const syncMutation = useMutation({
    mutationFn: async () => {
      // Labels first: a sync stores label ids per message, and without the label table those ids
      // are opaque numbers the rest of the app cannot render.
      await api.initializeGmailLabels();
      return api.initialGmailSync();
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.gmailSyncStatus });
      void queryClient.invalidateQueries({ queryKey: queryKeys.activityRuns });
    },
  });

  const classifyMutation = useMutation({
    mutationFn: () => api.classifyFacets(),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.activityRuns });
      void queryClient.invalidateQueries({ queryKey: queryKeys.pivotPlan });
    },
  });

  if (connectionQuery.isPending) return <LoadingState label="Checking your mailbox…" />;

  const step: 1 | 2 | 3 = !connected ? 1 : !synced ? 2 : 3;
  const stateOf = (index: number): StepState =>
    step > index ? 'done' : step === index ? 'current' : 'waiting';

  return (
    <section className="screen">
      <header className="screen__head">
        <h1 className="screen__title">Set up</h1>
      </header>
      <p className="screen__lede">
        Three steps, once. After this, new mail is filed on its own every day.
      </p>

      {connectionQuery.isError ? (
        <ErrorNotice error={connectionQuery.error} onRetry={() => void connectionQuery.refetch()} />
      ) : null}

      <ol className="setup-steps">
        <Step
          index={1}
          state={stateOf(1)}
          title="Connect Gmail"
          description={
            connection?.requiresReauthentication
              ? 'Your Gmail access expired. Reconnect to carry on.'
              : 'MailMind reads message headers only — never the body of an email, and never an attachment.'
          }
        >
          <a
            className="button button--primary"
            href={getBackendRedirectUrl('/integrations/google/connect')}
          >
            {connection?.requiresReauthentication ? 'Reconnect Gmail' : 'Connect Gmail'}
          </a>
        </Step>

        <Step
          index={2}
          state={stateOf(2)}
          title="Read the mailbox"
          description={
            sync?.syncRunning
              ? `Reading your mail — ${formatCount(sync.syncedMessages)} of ${formatCount(sync.totalGmailMessages)} so far. You can leave this page.`
              : 'A one-off pass over your mailbox to learn what is in it. Only headers are stored.'
          }
        >
          <button
            className="button button--primary"
            type="button"
            disabled={syncMutation.isPending || Boolean(sync?.syncRunning)}
            onClick={() => syncMutation.mutate()}
          >
            {sync?.syncRunning ? 'Reading…' : 'Start reading'}
          </button>
        </Step>

        <Step
          index={3}
          state={stateOf(3)}
          title="Sort it"
          description={
            'Every message gets a brand, a subject area and an intent. Nothing moves in Gmail yet — you choose the folder shape on the Folders screen first.'
          }
        >
          <button
            className="button button--primary"
            type="button"
            disabled={classifyMutation.isPending}
            onClick={() => classifyMutation.mutate()}
          >
            {classifyMutation.isPending ? 'Starting…' : 'Sort my mail'}
          </button>
        </Step>
      </ol>

      {syncMutation.isError ? <ErrorNotice error={syncMutation.error} /> : null}
      {classifyMutation.isError ? <ErrorNotice error={classifyMutation.error} /> : null}

      {classifyMutation.isSuccess ? (
        <p className="notice" role="status">
          Sorting started. It runs in the background — watch it on Activity, then shape the folders
          on Folders.
        </p>
      ) : null}
    </section>
  );
}
