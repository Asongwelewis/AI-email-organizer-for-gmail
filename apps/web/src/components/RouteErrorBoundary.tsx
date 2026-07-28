import { useEffect } from 'react';
import { isRouteErrorResponse, useRouteError } from 'react-router-dom';

import { captureRouteException, captureRouteFailure } from '@web/instrument';

export function RouteErrorBoundary() {
  const routeError = useRouteError();

  useEffect(() => {
    if (routeError instanceof Error) {
      captureRouteException(routeError);
      return;
    }

    if (isRouteErrorResponse(routeError)) captureRouteFailure(routeError.status);
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
