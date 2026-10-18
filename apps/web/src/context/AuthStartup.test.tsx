import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import MockAdapter from 'axios-mock-adapter';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';

import { ProtectedRoute } from '@web/components/ProtectedRoute';
import { AuthProvider } from '@web/context/AuthContext';
import { rememberSession } from '@web/lib/sessionSnapshot';
import { http } from '@web/services/http';

const apiMock = new MockAdapter(http);

const user = {
  id: 'user-1',
  email: 'person@example.com',
  displayName: 'Person',
  avatarUrl: null,
  status: 'ACTIVE' as const,
  gmailConnected: true,
  tutorialCompletedAt: null,
};

const inAWeek = () => new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

function renderApp() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { gcTime: 0 } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <MemoryRouter initialEntries={['/inbox']}>
          <Routes>
            <Route
              path="/inbox"
              element={
                <ProtectedRoute>
                  <div>Folders</div>
                </ProtectedRoute>
              }
            />
            <Route path="/login" element={<div>Sign in</div>} />
          </Routes>
        </MemoryRouter>
      </AuthProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  apiMock.reset();
  window.localStorage.clear();
});

/**
 * The launch a person actually sees. It used to hold on "Checking your session" until the server
 * answered, and on the free plan the server is often asleep, so that was most of a minute.
 */
describe('opening the app', () => {
  it('opens straight onto the app when a live session is remembered', async () => {
    rememberSession({ user, sessionExpiresAt: inAWeek() });
    // The server has not answered yet, and need not have for the screen to render.
    apiMock.onGet('/auth/me').reply(() => new Promise(() => undefined));
    apiMock.onGet('/integrations/google/status').reply(() => new Promise(() => undefined));

    renderApp();

    expect(screen.getByText('Folders')).toBeInTheDocument();
    expect(screen.queryByRole('status', { name: 'Checking your session' })).toBeNull();
  });

  it('still sends a remembered session to sign in once the server says it is over', async () => {
    rememberSession({ user, sessionExpiresAt: inAWeek() });
    apiMock.onGet('/auth/me').reply(401, { error: { code: 'AUTH_SESSION_REVOKED' } });
    apiMock.onGet('/integrations/google/status').reply(401);

    renderApp();

    await waitFor(() => expect(screen.getByText('Sign in')).toBeInTheDocument());
    expect(window.localStorage.length).toBe(0);
  });

  it('checks with the server first when nothing is remembered', async () => {
    apiMock.onGet('/auth/me').reply(200, { user, sessionExpiresAt: inAWeek() });
    apiMock.onGet('/integrations/google/status').reply(200, { connected: true });

    renderApp();

    expect(screen.getByRole('status', { name: 'Checking your session' })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('Folders')).toBeInTheDocument());
  });
});
