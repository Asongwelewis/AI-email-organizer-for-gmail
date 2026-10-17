import MockAdapter from 'axios-mock-adapter';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { api, getBackendRedirectUrl, http, setAuthenticationFailureHandler } from './http';

const apiMock = new MockAdapter(http);

afterEach(() => {
  apiMock.reset();
  setAuthenticationFailureHandler(null);
});

describe('session failure interceptor', () => {
  /*
   * There is no refresh to try. The API answers 401 only for a session that is missing, expired
   * or revoked, and refreshing begins by checking that same session — so the old retry failed for
   * the same reason every time, and only added a request in front of every signed-out visit.
   */
  it('treats a 401 as the end of the session and makes no second request', async () => {
    const onFailure = vi.fn();
    setAuthenticationFailureHandler(onFailure);
    apiMock.onGet('/protected').reply(401);

    await expect(http.get('/protected')).rejects.toMatchObject({ response: { status: 401 } });

    expect(onFailure).toHaveBeenCalledOnce();
    expect(apiMock.history.get).toHaveLength(1);
    expect(apiMock.history.post).toHaveLength(0);
  });

  it('leaves the session alone on any other failure', async () => {
    const onFailure = vi.fn();
    setAuthenticationFailureHandler(onFailure);
    apiMock.onGet('/forbidden').reply(403);
    apiMock.onGet('/waking').reply(502);

    await expect(http.get('/forbidden')).rejects.toBeDefined();
    await expect(http.get('/waking')).rejects.toBeDefined();

    expect(onFailure).not.toHaveBeenCalled();
  });

  it('does not end the session over the requests that never needed one', async () => {
    const onFailure = vi.fn();
    setAuthenticationFailureHandler(onFailure);
    apiMock.onPost('/feedback').reply(401);
    apiMock.onPost('/auth/logout').reply(401);

    await expect(
      api.sendFeedback({ kind: 'IDEA', message: 'hello' } as never),
    ).rejects.toBeDefined();
    await expect(api.logout()).rejects.toBeDefined();

    expect(onFailure).not.toHaveBeenCalled();
  });

  it('always sends browser credentials', () => {
    expect(http.defaults.withCredentials).toBe(true);
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
