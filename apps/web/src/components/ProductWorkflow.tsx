import { Check, Info, LoaderCircle } from 'lucide-react';

import type { GmailSyncStatus } from '@web/types/auth';

const workflowSteps = [
  {
    id: 'sync',
    label: 'Sync',
    detail: 'Copy Gmail metadata into MailMind.',
    href: '/settings/connections',
  },
  {
    id: 'review',
    label: 'Classify & review',
    detail: 'Rules and AI categorize; you resolve uncertainty.',
    href: '/dashboard/classification',
  },
  {
    id: 'labels',
    label: 'Labels',
    detail: 'Discover recurring, evidence-backed groups.',
    href: '/dashboard/labels/discover',
  },
  {
    id: 'automate',
    label: 'Automate',
    detail: 'Create or reuse labels and apply them safely.',
    href: '/dashboard/automation',
  },
] as const;

export type WorkflowStep = (typeof workflowSteps)[number]['id'];

export function InfoTooltip({ label, children }: { label: string; children: string }) {
  const id = `tooltip-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
  return (
    <span className="info-tooltip">
      <button type="button" aria-label={`Explain ${label}`} aria-describedby={id}>
        <Info aria-hidden="true" />
      </button>
      <span id={id} role="tooltip">
        {children}
      </span>
    </span>
  );
}

export function WorkflowRail({
  current,
  sync,
}: {
  current: WorkflowStep;
  sync?: GmailSyncStatus | undefined;
}) {
  const currentIndex = workflowSteps.findIndex((step) => step.id === current);
  return (
    <nav className="workflow-rail" aria-label="MailMind workflow">
      <div className="workflow-rail__intro">
        <span className="eyebrow">Mailbox workflow</span>
        <strong>Four stages, one source of truth.</strong>
      </div>
      <ol>
        {workflowSteps.map((step, index) => {
          const complete =
            step.id === 'sync'
              ? Boolean(sync?.initialSyncCompleted)
              : step.id === 'review'
                ? Boolean(sync && sync.classifiedMessages > 0)
                : index < currentIndex;
          return (
            <li
              key={step.id}
              className={step.id === current ? 'is-current' : complete ? 'is-complete' : ''}
            >
              <a href={step.href} aria-current={step.id === current ? 'step' : undefined}>
                <span className="workflow-rail__number">
                  {sync?.syncRunning && step.id === 'sync' ? (
                    <LoaderCircle className="spin" aria-hidden="true" />
                  ) : complete ? (
                    <Check aria-hidden="true" />
                  ) : (
                    index + 1
                  )}
                </span>
                <span>
                  <strong>{step.label}</strong>
                  <small>{step.detail}</small>
                </span>
              </a>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

export function MetricCard({
  label,
  value,
  tooltip,
  accent = false,
}: {
  label: string;
  value: number | string;
  tooltip: string;
  accent?: boolean;
}) {
  return (
    <article className={`product-metric${accent ? ' product-metric--accent' : ''}`}>
      <span>
        {label}
        <InfoTooltip label={label}>{tooltip}</InfoTooltip>
      </span>
      <strong>{value}</strong>
    </article>
  );
}

export function CoveragePanel({
  sync,
  loading = false,
  compact = false,
}: {
  sync?: GmailSyncStatus | undefined;
  loading?: boolean;
  compact?: boolean;
}) {
  const total = sync?.totalGmailMessages ?? 0;
  const synced = sync?.syncedMessages ?? 0;
  const classified = sync?.classifiedMessages ?? 0;
  const unprocessed = sync?.unprocessedMessages ?? Math.max(0, synced - classified);
  const syncPercent = total > 0 ? Math.min(100, Math.round((synced / total) * 100)) : 0;
  const classificationPercent =
    synced > 0 ? Math.min(100, Math.round((classified / synced) * 100)) : 0;
  const backfillTotal = sync?.backfill.totalMessages ?? total;
  const backfillProcessed = sync?.backfill.messagesProcessed ?? synced;
  const backfillPercent =
    backfillTotal > 0 ? Math.min(100, Math.round((backfillProcessed / backfillTotal) * 100)) : 0;

  return (
    <section
      className={`coverage-panel${compact ? ' coverage-panel--compact' : ''}`}
      aria-labelledby="coverage-title"
      aria-busy={loading}
    >
      <div className="coverage-panel__heading">
        <div>
          <span className="eyebrow">Data coverage</span>
          <h2 id="coverage-title">What MailMind can act on</h2>
        </div>
        <span className="coverage-panel__status">
          {loading
            ? 'Checking mailbox…'
            : sync?.backfill.running
              ? 'Historical backfill running'
              : sync?.backfill.completed
                ? 'Mailbox history covered'
                : sync?.initialSyncCompleted
                  ? 'Checkpoint saved'
                  : 'Initial sync required'}
        </span>
      </div>
      <div className="coverage-metrics">
        <MetricCard
          label="Gmail total"
          value={total}
          tooltip="The mailbox total reported by Gmail. This can include messages MailMind intentionally excludes."
        />
        <MetricCard
          label="Synced"
          value={synced}
          tooltip="Unique Gmail message IDs whose metadata is stored in MailMind."
        />
        <MetricCard
          label="Classified"
          value={classified}
          tooltip="Synced messages with a current completed or review-required classification."
        />
        <MetricCard
          label="Unprocessed"
          value={unprocessed}
          accent={unprocessed > 0}
          tooltip="Synced messages that still need a current classification. These should be classified before judging label discovery."
        />
      </div>
      <div className="coverage-bars">
        <ProgressLine
          label="Mailbox sync coverage"
          value={syncPercent}
          detail={`${synced} of ${total || 0} Gmail messages synced`}
        />
        <ProgressLine
          label="Classification coverage"
          value={classificationPercent}
          detail={`${classified} of ${synced || 0} synced messages classified`}
        />
        {(sync?.backfill.running ||
          (sync?.backfill.checkpointedAt && !sync.backfill.completed)) && (
          <ProgressLine
            label="Historical backfill"
            value={backfillPercent}
            detail={`${backfillProcessed} of ${backfillTotal} messages · ${sync.backfill.pagesCompleted} pages checkpointed`}
          />
        )}
      </div>
    </section>
  );
}

export function ProgressLine({
  label,
  value,
  detail,
}: {
  label: string;
  value: number;
  detail: string;
}) {
  return (
    <div className="progress-line">
      <div>
        <span>{label}</span>
        <strong>{value}%</strong>
      </div>
      <div
        className="progress-line__track"
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={value}
      >
        <span style={{ width: `${value}%` }} />
      </div>
      <small>{detail}</small>
    </div>
  );
}
