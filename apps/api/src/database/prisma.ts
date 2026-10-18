import { PrismaClient } from '@prisma/client';

import { env } from '../config/env.js';
import { logger } from '../config/logger.js';

const databaseUrl = new URL(env.DATABASE_URL);

/*
 * The pool used to be pinned to one connection, to avoid opening several cold ones against
 * Supabase's session pooler at once. The price was that every query in the process shared that
 * one connection: a person opening the app waited behind whatever the nightly classification was
 * doing, for up to `pool_timeout`. Five lets a page load run beside a background run; the
 * heartbeat below is what keeps them from going cold instead.
 */
const DEFAULT_CONNECTION_LIMIT = 5;

if (env.DATABASE_CONNECTION_LIMIT !== undefined) {
  databaseUrl.searchParams.set('connection_limit', String(env.DATABASE_CONNECTION_LIMIT));
} else if (!databaseUrl.searchParams.has('connection_limit')) {
  databaseUrl.searchParams.set('connection_limit', String(DEFAULT_CONNECTION_LIMIT));
}
if (!databaseUrl.searchParams.has('pool_timeout')) {
  databaseUrl.searchParams.set('pool_timeout', '60');
}
if (!databaseUrl.searchParams.has('connect_timeout')) {
  databaseUrl.searchParams.set('connect_timeout', '30');
}

/**
 * Prisma codes that mean the connection failed, not the query: the server could not be reached or
 * timed out, TLS failed, or the server closed a connection the pool still thought was open. They
 * say nothing about the data, so the same read a moment later on a fresh connection succeeds.
 */
const TRANSIENT_CONNECTION_CODES = new Set(['P1001', 'P1002', 'P1008', 'P1011', 'P1017']);

/** Operations that change nothing, and so can always be asked twice. */
const READ_OPERATIONS = new Set([
  'findUnique',
  'findUniqueOrThrow',
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'count',
  'aggregate',
  'groupBy',
]);

const RETRY_DELAY_MS = 250;

export function isTransientConnectionError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && TRANSIENT_CONNECTION_CODES.has(code);
}

/**
 * Retries a read once when its connection dropped underneath it.
 *
 * The pool keeps up to five connections, and the pooler can close one that sat idle while the pool
 * still holds it. The next query to draw it fails — on 18 Oct 2026 that was the first `GET` of the
 * notifications feed and the favourite keys, a few minutes after a deploy, both answered 500. Writes
 * are never retried: a write that may already have landed is not safe to repeat blind.
 */
export async function retryTransientRead<T>(
  operation: string,
  run: () => Promise<T>,
  delayMs = RETRY_DELAY_MS,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (!READ_OPERATIONS.has(operation) || !isTransientConnectionError(error)) throw error;
    logger.warn(
      { operation, code: (error as { code: string }).code },
      'retrying a read after a dropped database connection',
    );
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    return run();
  }
}

function createClient() {
  return new PrismaClient({
    datasources: {
      db: {
        url: databaseUrl.toString(),
      },
    },
    transactionOptions: {
      maxWait: 30_000,
      timeout: 60_000,
    },
  }).$extends({
    name: 'retry-transient-reads',
    query: {
      $allModels: {
        $allOperations({ operation, args, query }) {
          return retryTransientRead(operation, () => query(args));
        },
      },
    },
  });
}

type Client = ReturnType<typeof createClient>;

const globalForPrisma = globalThis as unknown as { mailmindPrisma?: Client };

export const prisma = globalForPrisma.mailmindPrisma ?? createClient();

if (env.NODE_ENV !== 'production') globalForPrisma.mailmindPrisma = prisma;

let heartbeat: NodeJS.Timeout | null = null;

/**
 * Keeps the pool's connections from going stale while the process is awake.
 *
 * The pooler closes a connection nobody has used for a while, and the next request then pays for
 * opening a new one — that is the request a person is waiting on. A `select 1` every few minutes
 * costs nothing and keeps that cost out of the request path. It cannot keep a sleeping instance
 * awake and does not try to: the timer is unref'd, and Render only counts inbound traffic.
 */
export function startDatabaseHeartbeat(intervalSeconds = env.DATABASE_HEARTBEAT_SECONDS): void {
  if (heartbeat || intervalSeconds <= 0) return;
  heartbeat = setInterval(() => {
    prisma.$queryRaw`select 1`.catch((error: unknown) => {
      // A missed beat is not an outage: the next real query reconnects on its own.
      logger.warn(
        { errorType: error instanceof Error ? error.name : 'UnknownError' },
        'database heartbeat failed',
      );
    });
  }, intervalSeconds * 1000);
  heartbeat.unref();
}

export function stopDatabaseHeartbeat(): void {
  if (heartbeat) clearInterval(heartbeat);
  heartbeat = null;
}
