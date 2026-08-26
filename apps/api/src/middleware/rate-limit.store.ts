import type { ClientRateLimitInfo, Options, Store } from 'express-rate-limit';

import { logger } from '@api/config/logger.js';
import { prisma } from '@api/database/prisma.js';

/**
 * A rate-limit counter every API instance shares.
 *
 * The limiters used the default in-memory store while the deployment docs claimed multi-instance
 * capability, and both halves of that were wrong: with two instances each keeps its own counter,
 * so every limit is effectively doubled, and a restart clears them — which made a deploy the
 * cheapest way past an auth limit.
 *
 * The window is part of the key rather than a value inside the row. That is what makes the whole
 * thing safe under concurrency: a new window is a new row, so two instances incrementing the same
 * client at the same moment both land on one atomic `on conflict do update` instead of racing over
 * a count they each read a moment earlier.
 *
 * Expired rows are swept opportunistically rather than on a timer. An expired row is already
 * invisible to the increment path — a different window is a different key — so the sweep is
 * housekeeping, and running it on a fraction of requests keeps it off the hot path.
 */

/** One sweep per this many increments, on average. Cheap, and nothing depends on its promptness. */
const SWEEP_EVERY = 200;

export class PrismaRateLimitStore implements Store {
  private windowMs = 60_000;
  private sinceSweep = 0;

  /**
   * False, and it matters: express-rate-limit uses this to detect double-counting
   * misconfigurations, and claiming otherwise is exactly the lie this store exists to stop
   * telling.
   */
  readonly localKeys = false;

  init(options: Options): void {
    this.windowMs = options.windowMs;
  }

  /** The floor of the window `now` falls in. Aligned, so every instance agrees on the boundary. */
  private windowStart(now = Date.now()): Date {
    return new Date(Math.floor(now / this.windowMs) * this.windowMs);
  }

  private resetTime(windowStart: Date): Date {
    return new Date(windowStart.getTime() + this.windowMs);
  }

  async increment(key: string): Promise<ClientRateLimitInfo> {
    const windowStart = this.windowStart();
    const resetTime = this.resetTime(windowStart);
    const row = await prisma.rate_limit_hits.upsert({
      where: {
        key_window_start_window_ms: { key, window_start: windowStart, window_ms: this.windowMs },
      },
      create: {
        key,
        window_start: windowStart,
        window_ms: this.windowMs,
        hits: 1,
        expires_at: resetTime,
      },
      update: { hits: { increment: 1 } },
      select: { hits: true },
    });
    void this.maybeSweep();
    return { totalHits: row.hits, resetTime };
  }

  async decrement(key: string): Promise<void> {
    const windowStart = this.windowStart();
    // `updateMany` rather than `update`: a decrement for a window that has already rolled over has
    // nothing to decrement, and that is not an error.
    await prisma.rate_limit_hits.updateMany({
      where: { key, window_start: windowStart, window_ms: this.windowMs, hits: { gt: 0 } },
      data: { hits: { decrement: 1 } },
    });
  }

  async resetKey(key: string): Promise<void> {
    await prisma.rate_limit_hits.deleteMany({ where: { key } });
  }

  async get(key: string): Promise<ClientRateLimitInfo | undefined> {
    const windowStart = this.windowStart();
    const row = await prisma.rate_limit_hits.findUnique({
      where: {
        key_window_start_window_ms: { key, window_start: windowStart, window_ms: this.windowMs },
      },
      select: { hits: true },
    });
    return row ? { totalHits: row.hits, resetTime: this.resetTime(windowStart) } : undefined;
  }

  async resetAll(): Promise<void> {
    await prisma.rate_limit_hits.deleteMany({});
  }

  /**
   * Housekeeping, and never a reason to fail a request.
   *
   * A sweep that throws must not turn into a 500 on a login: the counter it was tidying is already
   * correct, and the row it failed to delete is already ignored.
   */
  private async maybeSweep(): Promise<void> {
    this.sinceSweep += 1;
    if (this.sinceSweep < SWEEP_EVERY) return;
    this.sinceSweep = 0;
    try {
      await prisma.rate_limit_hits.deleteMany({ where: { expires_at: { lt: new Date() } } });
    } catch (error) {
      logger.warn(
        { errorType: error instanceof Error ? error.name : 'UnknownError' },
        'rate limit sweep failed',
      );
    }
  }
}

export const prismaRateLimitStore = new PrismaRateLimitStore();
