import { afterEach, describe, expect, it } from 'vitest';

import {
  forgetSession,
  recall,
  remember,
  rememberSession,
  rememberedQuery,
  rememberedSession,
} from './sessionSnapshot';

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

afterEach(() => {
  window.localStorage.clear();
});

describe('what the app remembers between launches', () => {
  it('opens on a remembered session that has not expired', () => {
    rememberSession({ user, sessionExpiresAt: inAWeek() });
    expect(rememberedSession()?.user.email).toBe('person@example.com');
  });

  /*
   * The case that matters on a shared device: the session ran out without anybody logging out.
   * Whoever opens the app next must get the sign-in screen, not the last person's folders.
   */
  it('forgets a session the moment it has expired, and everything remembered under it', () => {
    rememberSession({ user, sessionExpiresAt: new Date(Date.now() - 1000).toISOString() });
    remember('pivotView', 'entity,intent', { nodes: ['Netflix'] });

    expect(rememberedSession()).toBeUndefined();
    expect(recall('pivotView', 'entity,intent')).toBeUndefined();
    expect(window.localStorage.length).toBe(0);
  });

  it('refuses to remember a session whose lifetime it was not told', () => {
    rememberSession({ user });
    expect(rememberedSession()).toBeUndefined();
  });

  it('recalls nothing at all without a remembered session', () => {
    remember('pivotSettings', 'account', { canonicalPivot: ['entity', 'intent'] });
    expect(recall('pivotSettings', 'account')).toBeUndefined();
  });

  it('answers only the request it was stored for', () => {
    rememberSession({ user, sessionExpiresAt: inAWeek() });
    remember('pivotView', '["entity","intent"]', { nodes: 1 });

    expect(recall('pivotView', '["entity","intent"]')).toEqual({ nodes: 1 });
    expect(recall('pivotView', '["domain","intent"]')).toBeUndefined();
  });

  it('forgets everything on logout and leaves other settings alone', () => {
    window.localStorage.setItem('mailmind_time_range', '7d');
    rememberSession({ user, sessionExpiresAt: inAWeek() });
    remember('pivotView', 'v', { nodes: 1 });

    forgetSession();

    expect(rememberedSession()).toBeUndefined();
    expect(window.localStorage.getItem('mailmind_time_range')).toBe('7d');
  });

  it('stores each fresh answer as the next launch’s starting point', async () => {
    rememberSession({ user, sessionExpiresAt: inAWeek() });
    const query = rememberedQuery('pivotSettings', 'account', async () => ({ minMessages: 3 }));

    expect(query.placeholderData()).toBeUndefined();
    expect(await query.queryFn()).toEqual({ minMessages: 3 });
    expect(query.placeholderData()).toEqual({ minMessages: 3 });
  });
});
