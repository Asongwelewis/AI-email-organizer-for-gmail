import MockAdapter from 'axios-mock-adapter';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  __refreshTesting,
  getBackendRedirectUrl,
  http,
  setAuthenticationFailureHandler,
} from './http';

const apiMock = new MockAdapter(http);
const refreshMock = new MockAdapter(__refreshTesting.client);

afterEach(() => {
  apiMock.reset();
  refreshMock.reset();
  __refreshTesting.reset();
});

describe('session refresh interceptor', () => {
  it('uses one refresh request for concurrent 401 responses and retries both requests', async () => {
    let protectedCalls = 0;
    apiMock.onGet('/protected').reply(() => {
      protectedCalls += 1;
      return protectedCalls <= 2 ? [401] : [200, { ok: true }];
    });
    refreshMock.onPost('/auth/refresh').reply(200, { user: { id: 'user-1' } });

    const [first, second] = await Promise.all([http.get('/protected'), http.get('/protected')]);

    expect(first.data).toEqual({ ok: true });
    expect(second.data).toEqual({ ok: true });
    expect(refreshMock.history.post).toHaveLength(1);
  });

  it('notifies auth failure once when a shared refresh fails', async () => {
    const onFailure = vi.fn();
    setAuthenticationFailureHandler(onFailure);
    apiMock.onGet('/protected').reply(401);
    refreshMock.onPost('/auth/refresh').reply(401);

    const results = await Promise.allSettled([http.get('/protected'), http.get('/protected')]);

    expect(results.every((result) => result.status === 'rejected')).toBe(true);
    expect(refreshMock.history.post).toHaveLength(1);
    expect(onFailure).toHaveBeenCalledTimes(1);
  });

  it('does not refresh forbidden responses', async () => {
    apiMock.onGet('/protected').reply(403);

    await expect(http.get('/protected')).rejects.toBeDefined();

    expect(refreshMock.history.post).toHaveLength(0);
  });

  it('always sends browser credentials', () => {
    expect(http.defaults.withCredentials).toBe(true);
    expect(__refreshTesting.client.defaults.withCredentials).toBe(true);
  });

  it('constructs safe backend navigation URLs from the API base', () => {
    const apiBaseUrl = http.defaults.baseURL;

    expect(getBackendRedirectUrl('/auth/google')).toBe(
      `${apiBaseUrl}/auth/google?redirect=%2Fauth%2Fcallback`,
    );
    expect(getBackendRedirectUrl('/integrations/google/connect')).toBe(
      `${apiBaseUrl}/integrations/google/connect?redirect=%2Fauth%2Fcallback`,
    );
  });
});
