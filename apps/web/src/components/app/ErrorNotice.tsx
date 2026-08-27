import {
  getApiErrorCode,
  getApiErrorDetail,
  getSafeErrorMessage,
} from '@web/services/errorMessages';

/**
 * Every API failure is shown where it happened, with the code the server sent.
 *
 * The reason this component exists at all: a proposal run that returned nothing used to surface as
 * a success toast over an empty screen. A toast is the wrong shape for a failure — it leaves, and
 * it does not say which call broke. This stays on the screen and carries the code, so a report is
 * a screenshot rather than a description.
 */
export function ErrorNotice({
  error,
  title = 'That did not work',
  onRetry,
}: {
  error: unknown;
  title?: string;
  onRetry?: () => void;
}) {
  const code = getApiErrorCode(error);
  // The server's own message when it sent one, so the screen never invents a friendlier story
  // than what actually happened.
  const message = getApiErrorDetail(error) ?? getSafeErrorMessage(error);

  return (
    <div className="notice notice--error" role="alert">
      <div className="notice__body">
        <p className="notice__title">{title}</p>
        <p className="notice__message">{message}</p>
        {code ? <code className="notice__code">{code}</code> : null}
      </div>
      {onRetry ? (
        <button className="button button--quiet" type="button" onClick={onRetry}>
          Try again
        </button>
      ) : null}
    </div>
  );
}
