import { useRegisterSW } from 'virtual:pwa-register/react';

/**
 * A new build waits behind this rather than swapping itself in. Reloading mid-approval would
 * discard a selection the person was part-way through making, so the choice stays theirs.
 */
export function UpdatePrompt() {
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW();

  if (!needRefresh) return null;

  return (
    <div className="update-toast" role="status">
      <p>A new version of MailMind is ready.</p>
      <span className="screen__actions">
        <button className="button" type="button" onClick={() => setNeedRefresh(false)}>
          Later
        </button>
        <button
          className="button button--primary"
          type="button"
          onClick={() => void updateServiceWorker(true)}
        >
          Reload
        </button>
      </span>
    </div>
  );
}
