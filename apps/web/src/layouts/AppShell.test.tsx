import { screen } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({
  value: {} as Record<string, unknown>,
}));

vi.mock('@web/context/useAuth', () => ({ useAuth: () => auth.value }));
vi.mock('@web/services/http', () => ({
  api: { getNotifications: vi.fn() },
  getBackendRedirectUrl: () => 'https://api.example/integrations/google/connect',
}));
vi.mock('@web/components/app/NotificationCenter', () => ({ NotificationCenter: () => null }));
vi.mock('@web/components/app/ServerWakeNotice', () => ({ ServerWakeNotice: () => null }));

import { renderScreen } from '@web/test/renderScreen';
import { AppShell } from './AppShell';

function connection(overrides: Record<string, unknown> = {}) {
  return {
    connected: true,
    email: 'someone@gmail.com',
    status: 'CONNECTED',
    grantedScopes: [],
    requiresReauthentication: false,
    ...overrides,
  };
}

function renderAt(path: string) {
  return renderScreen(
    <Routes>
      <Route element={<AppShell />}>
        <Route path="/inbox" element={<p>Inbox content</p>} />
        <Route path="/activity" element={<p>Activity content</p>} />
        <Route path="/menu" element={<p>Menu content</p>} />
        <Route path="/setup" element={<p>Setup content</p>} />
      </Route>
    </Routes>,
    path,
  );
}

/*
 * Signing in and connecting Gmail are separate permissions. Someone who had only signed in landed
 * on an Inbox that said "Loading folders" forever and an Activity page of 409s; every mailbox
 * screen now shows the one missing step instead.
 */
describe('AppShell and a mailbox that is not connected', () => {
  beforeEach(() => {
    auth.value = {
      user: { displayName: 'Someone', email: 'someone@gmail.com', avatarUrl: null },
      logout: vi.fn(),
      gmailConnection: connection(),
    };
  });

  it('shows the mailbox screens once Gmail is connected', () => {
    renderAt('/inbox');
    expect(screen.getByText('Inbox content')).toBeInTheDocument();
    expect(screen.queryByText(/connect gmail/i)).not.toBeInTheDocument();
  });

  it.each(['/inbox', '/activity'])('asks for Gmail instead of showing %s', (path) => {
    auth.value = { ...auth.value, gmailConnection: connection({ connected: false }) };
    renderAt(path);

    expect(screen.getByRole('heading', { name: /connect gmail/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Connect Gmail' })).toHaveAttribute(
      'href',
      'https://api.example/integrations/google/connect',
    );
    expect(screen.queryByText(/content/)).not.toBeInTheDocument();
  });

  it('leaves the screens that need no mailbox alone', () => {
    auth.value = { ...auth.value, gmailConnection: connection({ connected: false }) };
    renderAt('/menu');
    expect(screen.getByText('Menu content')).toBeInTheDocument();
  });

  it('asks for a reconnect when access expired', () => {
    auth.value = {
      ...auth.value,
      gmailConnection: connection({ connected: false, requiresReauthentication: true }),
    };
    renderAt('/inbox');
    expect(screen.getByRole('link', { name: 'Reconnect Gmail' })).toBeInTheDocument();
  });

  // A status request that failed is not proof of anything; telling a connected person to connect
  // would be its own bug.
  it('does not gate on a status it could not read', () => {
    auth.value = {
      ...auth.value,
      gmailConnection: connection({ connected: false, status: 'ERROR' }),
    };
    renderAt('/inbox');
    expect(screen.getByText('Inbox content')).toBeInTheDocument();
  });
});
