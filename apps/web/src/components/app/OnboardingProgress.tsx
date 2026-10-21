import { Check } from 'lucide-react';
import { Link } from 'react-router-dom';

import { formatCount } from '@web/lib/format';
import { getBackendRedirectUrl } from '@web/services/http';
import type { OnboardingStage, OnboardingStatus } from '@web/types/onboarding';

/**
 * A new mailbox being set up, shown while it happens.
 *
 * The first person to sign up after the owner connected Gmail and saw nothing: no folders, no
 * progress, and an error about a server key that meant nothing to them. Setup now runs on its own
 * from the moment Gmail is connected, and this is what they watch instead — what is happening,
 * how far along it is, and, if it has paused, why and that it will carry on by itself.
 */

const STAGES: Array<{ stage: Exclude<OnboardingStage, 'DONE'>; title: string; detail: string }> = [
  {
    stage: 'SYNCING',
    title: 'Reading your recent mail',
    detail: 'Sender, subject and date only — never the body of an email or an attachment.',
  },
  {
    stage: 'LEARNING',
    title: 'Setting up your categories',
    detail: 'Areas like finance, travel and work, and what each email is asking of you.',
  },
  {
    stage: 'SORTING',
    title: 'Sorting your newest mail into folders',
    detail:
      'Folders appear in your inbox as they fill. After this, new mail is sorted as it lands.',
  },
];

const ORDER: Record<OnboardingStage, number> = { SYNCING: 0, LEARNING: 1, SORTING: 2, DONE: 3 };

/** Stop reasons that no button here can fix, so none is offered. */
const NOT_RETRYABLE = new Set([
  'SORTING_NOT_CONFIGURED',
  'GMAIL_REAUTH_REQUIRED',
  'GMAIL_PERMISSION_DENIED',
]);

/** Stop reasons about the Gmail grant itself, answered by connecting again. */
const NEEDS_RECONNECT = new Set(['GMAIL_REAUTH_REQUIRED', 'GMAIL_PERMISSION_DENIED']);

function StageProgress({ status }: { status: OnboardingStatus }) {
  const total = status.total ?? 0;
  const known = total > 0;
  const percent = known ? Math.min(100, Math.round((status.processed / total) * 100)) : null;
  return (
    <div className="onboarding__progress">
      <div
        className={`onboarding__bar${known ? '' : ' onboarding__bar--working'}`}
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={known ? total : undefined}
        aria-valuenow={known ? status.processed : undefined}
        aria-label="Progress"
      >
        <span style={percent === null ? undefined : { width: `${percent}%` }} />
      </div>
      {known ? (
        <span className="onboarding__count">
          {formatCount(status.processed)} of {formatCount(total)}
        </span>
      ) : null}
    </div>
  );
}

export function OnboardingProgress({
  status,
  onRetry,
  retrying = false,
  showWhenDone = false,
}: {
  status: OnboardingStatus;
  onRetry?: () => void;
  retrying?: boolean;
  /** The setup screen says "ready"; the inbox, which is already showing the folders, does not. */
  showWhenDone?: boolean;
}) {
  if (status.state === 'DONE') {
    if (!showWhenDone) return null;
    return (
      <section className="onboarding onboarding--done" aria-label="Setup">
        <p className="onboarding__title">Your folders are ready</p>
        <p className="onboarding__lede">
          New mail is sorted within a minute or two of arriving. Older mail is sorted in the
          background over the next day.
        </p>
        <Link className="button button--primary" to="/inbox">
          Open my inbox
        </Link>
      </section>
    );
  }

  const current = ORDER[status.stage ?? 'SYNCING'];
  const paused = status.state === 'STOPPED' || status.state === 'FAILED';
  const reconnect = NEEDS_RECONNECT.has(status.stopReason ?? '');
  const canRetry = paused && !NOT_RETRYABLE.has(status.stopReason ?? '');

  return (
    <section className="onboarding" aria-label="Setting up your inbox">
      <p className="onboarding__title">Setting up your inbox</p>
      <p className="onboarding__lede">
        This takes a minute or two. You can leave this page — it carries on without you.
      </p>
      <ol className="onboarding__stages" aria-live="polite">
        {STAGES.map((entry, index) => {
          const state = index < current ? 'done' : index === current ? 'current' : 'waiting';
          return (
            <li key={entry.stage} className={`onboarding__stage onboarding__stage--${state}`}>
              <span className="onboarding__marker" aria-hidden="true">
                {state === 'done' ? <Check strokeWidth={2.5} /> : index + 1}
              </span>
              <div className="onboarding__body">
                <p className="onboarding__stage-title">
                  {entry.title}
                  {state === 'done' ? <span className="sr-only"> — done</span> : null}
                </p>
                {state === 'current' ? (
                  <>
                    <p className="onboarding__detail">{entry.detail}</p>
                    {paused ? null : <StageProgress status={status} />}
                  </>
                ) : null}
              </div>
            </li>
          );
        })}
      </ol>
      {paused && status.message ? (
        <div className="notice" role="status">
          <p className="notice__message">{status.message}</p>
          {reconnect ? (
            <a
              className="button button--quiet"
              href={getBackendRedirectUrl('/integrations/google/connect')}
            >
              Reconnect Gmail
            </a>
          ) : null}
          {canRetry && onRetry ? (
            <button
              type="button"
              className="button button--quiet"
              disabled={retrying}
              onClick={onRetry}
            >
              {retrying ? 'Starting…' : 'Try again now'}
            </button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
