import { useEffect } from 'react';
import * as Sentry from '@sentry/react';
import { isRouteErrorResponse, useRouteError } from 'react-router-dom';

export function RouteErrorBoundary() {
  const routeError = useRouteError();

  useEffect(() => {
    if (routeError instanceof Error) {
      Sentry.captureException(routeError, {
        tags: { source: 'react-router-error-element' },
      });
      return;
    }

    Sentry.captureMessage('React Router handled a non-Error route failure', {
      level: 'error',
      tags: { source: 'react-router-error-element' },
      extra: { routeError },
    });
  }, [routeError]);

  const message =
    routeError instanceof Error
      ? routeError.message
      : isRouteErrorResponse(routeError)
        ? `${routeError.status} ${routeError.statusText}`
        : 'An unexpected error occurred.';

  return (
    <main role="alert">
      <h1>Something went wrong</h1>
      <p>{message}</p>
      <button type="button" onClick={() => window.location.reload()}>
        Reload page
      </button>
    </main>
  );
}
