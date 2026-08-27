import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * One table, standing in for the shared one.
 *
 * The store is backed by Postgres precisely so two API instances count the same client together,
 * and a test that gave each limiter its own map would prove the opposite of the claim. This map is
 * the database: every limiter built below reads and writes it, exactly as they would in
 * production.
 */
const table = new Map<string, { hits: number; expires_at: Date }>();
const rowKey = (key: string, windowStart: Date, windowMs: number) =>
  `${key}|${windowStart.toISOString()}|${windowMs}`;

const mocks = vi.hoisted(() => ({ rows: new Map<string, unknown>() }));

vi.mock('../src/database/prisma.js', () => ({
  prisma: {
    rate_limit_hits: {
      async upsert({
        where,
        create,
      }: {
        where: {
          key_window_start_window_ms: { key: string; window_start: Date; window_ms: number };
        };
        create: { hits: number; expires_at: Date };
      }) {
        const composite = where.key_window_start_window_ms;
        const id = rowKey(composite.key, composite.window_start, composite.window_ms);
        const existing = table.get(id);
        // The atomic half: an increment on a row that already exists never reads-then-writes.
        const row = existing
          ? { ...existing, hits: existing.hits + 1 }
          : { hits: create.hits, expires_at: create.expires_at };
        table.set(id, row);
        return { hits: row.hits };
      },
      async findUnique({
        where,
      }: {
        where: {
          key_window_start_window_ms: { key: string; window_start: Date; window_ms: number };
        };
      }) {
        const composite = where.key_window_start_window_ms;
        return (
          table.get(rowKey(composite.key, composite.window_start, composite.window_ms)) ?? null
        );
      },
      async updateMany() {
        return { count: 0 };
      },
      async deleteMany() {
        table.clear();
        return { count: 0 };
      },
    },
  },
}));

vi.mock('../src/config/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
  safeErrorDetails: () => ({}),
}));

const { oauthStartLimiter } = await import('../src/middleware/rateLimiters.js');
const { PrismaRateLimitStore } = await import('../src/middleware/rate-limit.store.js');

beforeEach(() => {
  table.clear();
  mocks.rows.clear();
});

describe('authentication rate limiting', () => {
  it('returns a typed 429 response after the configured OAuth-start limit', async () => {
    const limitedApp = express();
    limitedApp.get('/oauth-start', oauthStartLimiter, (_request, response) => {
      response.json({ ok: true });
    });
    for (let index = 0; index < 10; index += 1) {
      expect((await request(limitedApp).get('/oauth-start')).status).toBe(200);
    }
    const limited = await request(limitedApp).get('/oauth-start');
    expect(limited.status).toBe(429);
    expect(limited.body).toEqual({
      error: {
        code: 'RATE_LIMIT_EXCEEDED',
        message: 'Too many requests. Please try again later.',
      },
    });
  });
});

/**
 * Card 29, S4. The limiters used the in-memory store while the docs claimed multi-instance
 * capability. With two instances each kept its own counter, so every limit was effectively
 * doubled, and a restart cleared them — which made a deploy the cheapest way past an auth limit.
 */
describe('a rate limit shared across API instances', () => {
  /** Two stores over one table is what two API processes look like from the database's side. */
  const twoInstances = () => {
    const options = { windowMs: 60_000 } as never;
    const first = new PrismaRateLimitStore();
    const second = new PrismaRateLimitStore();
    first.init(options);
    second.init(options);
    return { first, second };
  };

  it('counts a client once across instances rather than once per instance', async () => {
    const { first, second } = twoInstances();

    await first.increment('198.51.100.7');
    await second.increment('198.51.100.7');
    const third = await first.increment('198.51.100.7');

    // Three requests, three hits. Per-instance counting would report two here, and the client
    // would get twice the allowance for having been load-balanced.
    expect(third.totalHits).toBe(3);
    expect(await second.get('198.51.100.7')).toMatchObject({ totalHits: 3 });
  });

  it('never lets one client’s counter reach another', async () => {
    const { first } = twoInstances();

    await first.increment('198.51.100.7');
    await first.increment('198.51.100.7');

    expect((await first.increment('203.0.113.9')).totalHits).toBe(1);
  });

  /**
   * The window is part of the key rather than a value inside the row, which is what makes the
   * increment safe under concurrency: a new window is a new row, so nothing has to be reset.
   */
  it('starts a fresh count when the window rolls over', async () => {
    const store = new PrismaRateLimitStore();
    store.init({ windowMs: 60_000 } as never);
    const start = new Date('2026-08-27T10:00:00.000Z').getTime();
    vi.useFakeTimers();
    try {
      vi.setSystemTime(start);
      await store.increment('198.51.100.7');
      expect((await store.increment('198.51.100.7')).totalHits).toBe(2);

      vi.setSystemTime(start + 60_001);
      const rolled = await store.increment('198.51.100.7');
      expect(rolled.totalHits).toBe(1);
      expect(rolled.resetTime!.getTime()).toBeGreaterThan(start + 60_000);
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * express-rate-limit reads this to detect double-counting misconfigurations. Claiming otherwise
   * is exactly the lie this store exists to stop telling.
   */
  it('declares that its keys are not local to one process', () => {
    expect(new PrismaRateLimitStore().localKeys).toBe(false);
  });
});
