import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import { AuthCallbackPage } from './AuthCallbackPage';

function renderCallback(entry: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="/auth/callback" element={<AuthCallbackPage />} />
          <Route path="/inbox" element={<div>Inbox destination</div>} />
          <Route path="/login" element={<div>Login destination</div>} />
          <Route path="/menu" element={<div>Menu destination</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('AuthCallbackPage', () => {
  it('shows a safe success message without rendering callback secrets', () => {
    renderCallback(
      '/auth/callback?status=login_success&code=secret-code&access_token=secret-token',
    );

    expect(screen.getByRole('heading', { name: 'Welcome to AMO.' })).toBeInTheDocument();
    expect(screen.queryByText(/secret-code|secret-token/)).not.toBeInTheDocument();
  });

  it('uses a generic message for unknown status values', () => {
    vi.useFakeTimers();
    renderCallback('/auth/callback?status=database_stack_trace');

    expect(
      screen.getByRole('heading', { name: 'We could not finish that step.' }),
    ).toBeInTheDocument();
    expect(screen.queryByText('database_stack_trace')).not.toBeInTheDocument();
    vi.useRealTimers();
  });

  it('redirects login success to the inbox after the transition', async () => {
    vi.useFakeTimers();
    renderCallback('/auth/callback?status=login_success');
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    expect(screen.getByText('Inbox destination')).toBeInTheDocument();
    vi.useRealTimers();
  });

  it('keeps Gmail denial inside the authenticated area', async () => {
    vi.useFakeTimers();
    renderCallback('/auth/callback?status=gmail_denied');
    expect(screen.getByRole('heading', { name: 'Gmail stayed private.' })).toBeInTheDocument();
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    expect(screen.getByText('Inbox destination')).toBeInTheDocument();
    vi.useRealTimers();
  });

  // Past the beta cap nothing was asked of Google; the person is told why and leaves when ready.
  it('explains a full beta and waits for the person to continue', async () => {
    vi.useFakeTimers();
    renderCallback('/auth/callback?status=beta_full');
    expect(screen.getByRole('heading', { name: 'The AMO beta is full.' })).toBeInTheDocument();
    expect(screen.getByText(/nothing was read/)).toBeInTheDocument();
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(screen.queryByText('Menu destination')).not.toBeInTheDocument();
    vi.useRealTimers();
  });
});
