import type { ReactElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

/** Screens under test get a fresh cache and no retries, so a failure surfaces on the first pass. */
export function renderScreen(ui: ReactElement, initialEntry = '/') {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialEntry]}>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

/** An axios-shaped rejection, so the screen's error handling sees what the client would give it. */
export function apiError(code: string, message: string, status = 400) {
  return Object.assign(new Error(message), {
    isAxiosError: true,
    toJSON: () => ({}),
    response: { status, data: { error: { code, message } } },
  });
}
