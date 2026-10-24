import { AxiosError, AxiosHeaders, type AxiosResponse } from 'axios';
import { describe, expect, it } from 'vitest';

import { getSafeErrorMessage } from '@web/services/errorMessages';
import { retryWhenUnreachable, unreachableRetryDelay } from './queryRetry';

function responded(status: number, data: unknown = {}): AxiosError {
  const config = { headers: new AxiosHeaders() };
  const response = { status, data, statusText: '', headers: {}, config } as AxiosResponse;
  return new AxiosError('failed', 'ERR_BAD_RESPONSE', config, null, response);
}

const dropped = new AxiosError('Network Error', 'ERR_NETWORK', { headers: new AxiosHeaders() });

describe('retrying a read', () => {
  // The friend's screen: a dropped connection stayed an error until someone tapped Try again.
  it('asks again when the server never answered, three times at most', () => {
    expect(retryWhenUnreachable(0, dropped)).toBe(true);
    expect(retryWhenUnreachable(2, dropped)).toBe(true);
    expect(retryWhenUnreachable(3, dropped)).toBe(false);
  });

  it('asks again when Render answered for a server that was not ready', () => {
    expect(retryWhenUnreachable(0, responded(502, '<html>Bad gateway</html>'))).toBe(true);
    expect(retryWhenUnreachable(0, responded(503))).toBe(true);
  });

  // An answer from the API is a decision, not a blip.
  it('never repeats a request the API answered', () => {
    const conflict = responded(409, { error: { code: 'GMAIL_ACCOUNT_NOT_CONNECTED' } });
    expect(retryWhenUnreachable(0, conflict)).toBe(false);
    expect(
      retryWhenUnreachable(0, responded(500, { error: { code: 'INTERNAL_SERVER_ERROR' } })),
    ).toBe(false);
    expect(retryWhenUnreachable(0, responded(503, { error: { code: 'GMAIL_RATE_LIMITED' } }))).toBe(
      false,
    );
    expect(retryWhenUnreachable(0, new Error('boom'))).toBe(false);
  });

  it('waits a second, then two, then four', () => {
    expect([0, 1, 2].map(unreachableRetryDelay)).toEqual([1000, 2000, 4000]);
  });

  it('says the server could not be reached rather than that something went wrong', () => {
    expect(getSafeErrorMessage(dropped)).toMatch(/could not be reached/);
  });
});
