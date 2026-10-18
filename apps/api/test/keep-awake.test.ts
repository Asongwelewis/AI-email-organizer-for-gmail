import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ warn: vi.fn(), info: vi.fn() }));
vi.mock('../src/config/logger.js', () => ({
  logger: { warn: mocks.warn, info: mocks.info, error: vi.fn() },
}));

import { env } from '../src/config/env.js';
import {
  keepAwakeUrl,
  pingSelf,
  startKeepAwake,
  stopKeepAwake,
} from '../src/services/keepAwake.js';

/**
 * On the free plan only inbound requests keep the instance up, and asleep, new mail sits unsorted.
 * The ping has to go out to the public address — the one Render's edge sees — and it must never
 * fire from a developer's machine, where API_BASE_URL may well be production.
 */
describe('keeping the free instance awake', () => {
  const originalNodeEnv = env.NODE_ENV;

  afterEach(() => {
    stopKeepAwake();
    env.NODE_ENV = originalNodeEnv;
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('pings the configured public address, where Render counts it as inbound', () => {
    expect(keepAwakeUrl()).toBe(new URL('/health', env.API_BASE_URL).toString());
  });

  it('pings on its interval in production', async () => {
    env.NODE_ENV = 'production';
    vi.useFakeTimers();
    const fetcher = vi.fn().mockResolvedValue({ ok: true, status: 200 });

    startKeepAwake(10, fetcher as never);
    startKeepAwake(10, fetcher as never); // a second start must not double the pings
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[0]).toBe(keepAwakeUrl());

    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('never pings outside production', async () => {
    env.NODE_ENV = 'development';
    vi.useFakeTimers();
    const fetcher = vi.fn();

    startKeepAwake(10, fetcher as never);
    await vi.advanceTimersByTimeAsync(60 * 60_000);

    expect(fetcher).not.toHaveBeenCalled();
  });

  it('shrugs off a failed ping and says so', async () => {
    const fetcher = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
    await expect(pingSelf(fetcher as never)).resolves.toBe(false);
    expect(mocks.warn).toHaveBeenCalledWith({ errorType: 'TypeError' }, 'keep-awake ping failed');
  });
});
