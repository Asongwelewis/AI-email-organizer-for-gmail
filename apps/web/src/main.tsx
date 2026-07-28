import './instrument';

import React from 'react';
import ReactDOM from 'react-dom/client';
import * as Sentry from '@sentry/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { App } from './App';
import '@web/styles/index.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: false,
    },
  },
});

const sentryReactErrorHandler = Sentry.reactErrorHandler();
const reportReactError = (error: unknown, errorInfo: { componentStack?: string | undefined }) => {
  sentryReactErrorHandler(error, {
    componentStack: errorInfo.componentStack ?? null,
  });
};

ReactDOM.createRoot(document.getElementById('root') as HTMLElement, {
  onUncaughtError: reportReactError,
  onCaughtError: reportReactError,
  onRecoverableError: reportReactError,
}).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </React.StrictMode>,
);
