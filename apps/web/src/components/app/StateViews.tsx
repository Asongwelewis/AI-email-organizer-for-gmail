import type { ReactNode } from 'react';

/**
 * An explicit empty state, never a success message over nothing. If a run produced no folders,
 * the screen says so and says what to do next — that silence is the exact failure this rebuild is
 * meant to remove.
 */
export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <p className="empty-state__title">{title}</p>
      <p className="empty-state__description">{description}</p>
      {action ? <div className="empty-state__action">{action}</div> : null}
    </div>
  );
}

export function LoadingState({ label }: { label: string }) {
  return (
    <p className="loading-state" role="status">
      {label}
    </p>
  );
}
