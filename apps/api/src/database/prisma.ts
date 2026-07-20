import { PrismaClient } from '@prisma/client';

import { env } from '../config/env.js';

const databaseUrl = new URL(env.DATABASE_URL);

// Supabase's session pooler can take several seconds to establish a cold connection.
// Keep one connection warm for this long-running API instead of opening competing cold
// connections, and allow queued work to wait for that connection during startup.
if (!databaseUrl.searchParams.has('connection_limit')) {
  databaseUrl.searchParams.set('connection_limit', '1');
}
if (!databaseUrl.searchParams.has('pool_timeout')) {
  databaseUrl.searchParams.set('pool_timeout', '60');
}

export const prisma = new PrismaClient({
  datasources: {
    db: {
      url: databaseUrl.toString(),
    },
  },
  transactionOptions: {
    maxWait: 30_000,
    timeout: 60_000,
  },
});
