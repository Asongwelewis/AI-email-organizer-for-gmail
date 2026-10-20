/**
 * Several hundred mailboxes against a local Postgres, through the real repositories and the real
 * HTTP stack. Not part of `npm test`: it seeds hundreds of thousands of rows and takes minutes.
 *
 *   RUN_SCALE_TEST=true NODE_ENV=test DATABASE_URL=postgresql://…@127.0.0.1:5432/… \
 *     npm run test:scale --workspace @mailmind/api
 *
 * It truncates the tables it fills, so it refuses any database that is not on this machine — the
 * same guard as the database integration suite.
 *
 * What it answers:
 *   1. How fast a first sync writes, now that a page is one statement instead of two per message.
 *   2. What a mailbox costs in storage, and so how many fit in the free 500 MB.
 *   3. How the queries the scheduler runs every minute behave with every mailbox present.
 *   4. What several hundred people opening the app at once see: latency and errors, cold and warm.
 */
import { createHash, randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';

import request from 'supertest';

const USERS = Number(process.env['SCALE_USERS'] ?? 300);
const MESSAGES_PER_USER = Number(process.env['SCALE_MESSAGES'] ?? 1000);
const PAGE = 25;

const databaseUrl = new URL(process.env['DATABASE_URL'] ?? '');
if (
  process.env['RUN_SCALE_TEST'] !== 'true' ||
  !['localhost', '127.0.0.1', '::1', '[::1]'].includes(databaseUrl.hostname)
) {
  console.error('Refusing: set RUN_SCALE_TEST=true and point DATABASE_URL at a local database.');
  process.exit(1);
}

const { prisma } = await import('../src/database/prisma.js');
const { gmailRepository } = await import('../src/integrations/gmail/gmail.repository.js');
const { mailWatchService } = await import('../src/features/automation/mail-watch.service.js');
const { onboardingService } = await import('../src/features/onboarding/onboarding.service.js');
const { geminiRequestsToday } = await import('../src/features/automation/usage-ledger.js');
const { pivotService } = await import('../src/features/labels/pivot.service.js');
const { app } = await import('../src/app.js');

type Timing = { median: number; p95: number; max: number };

function summarize(samples: number[]): Timing {
  const sorted = [...samples].sort((left, right) => left - right);
  const at = (share: number) =>
    sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * share))]!;
  return { median: at(0.5), p95: at(0.95), max: sorted.at(-1)! };
}

const ms = (value: number) => `${value.toFixed(1)} ms`;

async function time<T>(label: string, runs: number, work: () => Promise<T>): Promise<void> {
  const samples: number[] = [];
  for (let index = 0; index < runs; index += 1) {
    const started = performance.now();
    await work();
    samples.push(performance.now() - started);
  }
  const { median, p95 } = summarize(samples);
  console.log(`  ${label.padEnd(52)} median ${ms(median)}  p95 ${ms(p95)}`);
}

const SENDERS = [
  'netflix.com',
  'github.com',
  'linkedin.com',
  'amazon.com',
  'paypal.com',
  'uber.com',
];
const DOMAINS = ['finance', 'development', 'career', 'shopping', 'travel'];
const INTENTS = ['receipt', 'newsletter', 'security-alert', 'job-match', 'promotion'];

async function reset(): Promise<void> {
  await prisma.$executeRawUnsafe(`
    truncate table public.notifications, public.message_facets, public.gmail_message_metadata,
      public.gmail_labels, public.gmail_sync_states, public.automation_runs, public.activity_runs,
      public.sessions, public.audit_logs, public.facet_vocabularies, public.facet_pivot_settings,
      public.connected_google_accounts, public.users restart identity cascade
  `);
}

async function seed(): Promise<{ tokens: string[]; accountIds: string[] }> {
  console.log(`\nSeeding ${USERS} mailboxes × ${MESSAGES_PER_USER} messages`);
  const tokens: string[] = [];
  const accountIds: string[] = [];
  const now = new Date();
  for (let index = 0; index < USERS; index += 1) {
    const user = await prisma.users.create({
      data: {
        google_subject: `scale-${index}`,
        email: `person${index}@example.com`,
        normalized_email: `person${index}@example.com`,
        email_verified: true,
      },
    });
    // Most are set up; the last sixth are still onboarding, which the sweep has to find.
    const onboarded = index < USERS - Math.floor(USERS / 6);
    const account = await prisma.connected_google_accounts.create({
      data: {
        user_id: user.id,
        google_subject: `scale-google-${index}`,
        email: `person${index}@gmail.com`,
        gmail_connected: true,
        connection_status: 'CONNECTED',
        onboarding_stage: onboarded ? 'DONE' : 'SYNCING',
        onboarding_completed_at: onboarded ? now : null,
      },
    });
    accountIds.push(account.id);
    await prisma.gmail_sync_states.create({
      data: {
        connected_google_account_id: account.id,
        status: 'READY',
        initial_sync_completed_at: onboarded ? now : null,
        last_history_id: '1000',
      },
    });
    const token = randomBytes(32).toString('base64url');
    tokens.push(token);
    await prisma.sessions.create({
      data: {
        user_id: user.id,
        session_token_hash: createHash('sha256').update(token).digest('hex'),
        expires_at: new Date(now.getTime() + 30 * 86_400_000),
      },
    });
    await prisma.automation_runs.create({
      data: {
        connected_google_account_id: account.id,
        idempotency_key: `${account.id}:watch:${now.toISOString().slice(0, 10)}`,
        trigger: 'SCHEDULED',
        status: 'COMPLETED',
        provider_call_count: 2,
        started_at: now,
        completed_at: now,
      },
    });
  }

  // The real write path a first sync takes, a page at a time.
  let statements = 0;
  const started = performance.now();
  for (const [accountIndex, accountId] of accountIds.entries()) {
    for (let offset = 0; offset < MESSAGES_PER_USER; offset += PAGE) {
      const page = Array.from({ length: Math.min(PAGE, MESSAGES_PER_USER - offset) }, (_, step) => {
        const n = offset + step;
        const sender = SENDERS[(n + accountIndex) % SENDERS.length]!;
        return {
          gmail_message_id: `m-${accountIndex}-${n}`,
          gmail_thread_id: `t-${accountIndex}-${Math.floor(n / 3)}`,
          history_id: String(1000 + n),
          internal_date: new Date(now.getTime() - n * 3_600_000),
          subject: `Your ${sender.split('.')[0]} update number ${n} — something worth reading`,
          sender_name: sender.split('.')[0]!,
          sender_email: `no-reply@${sender}`,
          recipient_summary: `person${accountIndex}@gmail.com`,
          snippet:
            'A stored preview of the first part of the message, truncated as the sync stores it, long enough to be realistic.',
          label_ids:
            n % 4 === 0 ? ['INBOX', 'UNREAD', 'CATEGORY_UPDATES'] : ['INBOX', 'CATEGORY_UPDATES'],
          has_attachments: n % 10 === 0,
          size_estimate: 12_000 + n,
          is_unread: n % 4 === 0,
          is_starred: false,
          is_important: n % 7 === 0,
          is_draft: false,
          is_sent: false,
          is_trashed: false,
        };
      });
      await gmailRepository.upsertMessages(accountId, page);
      statements += 1;
    }
  }
  const seconds = (performance.now() - started) / 1000;
  const total = USERS * MESSAGES_PER_USER;
  console.log(
    `  wrote ${total.toLocaleString()} messages in ${statements.toLocaleString()} statements, ` +
      `${seconds.toFixed(1)} s (${Math.round(total / seconds).toLocaleString()} messages/s)`,
  );
  console.log(
    `  the per-message upsert this replaced would have taken ${(total * 2).toLocaleString()} round trips; ` +
      `at Render→Supabase's ~120 ms each, ${((total * 2 * 0.12) / USERS / 60).toFixed(1)} minutes per mailbox ` +
      `against ${((statements / USERS) * 0.12).toFixed(1)} s now`,
  );

  // Classify most of it, the way the classifier's rows look.
  await prisma.$executeRawUnsafe(`
    insert into public.message_facets (connected_google_account_id, gmail_message_id, entity, domain,
      intent, domain_confidence, intent_confidence, source, prompt_version, input_hash)
    select m.connected_google_account_id, m.id, split_part(split_part(m.sender_email, '@', 2), '.', 1),
      (array['${DOMAINS.join("','")}'])[1 + (abs(hashtext(m.gmail_message_id)) % ${DOMAINS.length})],
      (array['${INTENTS.join("','")}'])[1 + (abs(hashtext(m.gmail_message_id || 'i')) % ${INTENTS.length})],
      0.9, 0.9, 'MODEL', 'scale', md5(m.gmail_message_id)
    from public.gmail_message_metadata m
    where abs(hashtext(m.gmail_message_id)) % 10 < 9
  `);
  return { tokens, accountIds };
}

async function storage(): Promise<void> {
  const rows = await prisma.$queryRawUnsafe<Array<{ relation: string; bytes: bigint }>>(`
    select relname as relation, pg_total_relation_size(c.oid) as bytes
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and relname in ('gmail_message_metadata', 'message_facets')
  `);
  const bytes = rows.reduce((total, row) => total + Number(row.bytes), 0);
  const perMessage = bytes / (USERS * MESSAGES_PER_USER);
  const budget = 450 * 1024 * 1024; // leave ~50 MB of the 500 for everything else
  console.log('\nStorage');
  for (const row of rows) {
    console.log(`  ${row.relation.padEnd(28)} ${(Number(row.bytes) / 1024 / 1024).toFixed(1)} MB`);
  }
  console.log(`  ≈ ${(perMessage / 1024).toFixed(2)} KB per stored message, indexes included`);
  for (const perUser of [500, 1000, 2000]) {
    console.log(
      `  at ${perUser.toString().padStart(4)} messages per mailbox, ~${Math.floor(budget / (perMessage * perUser))} mailboxes fit in the free tier`,
    );
  }
}

async function scheduler(): Promise<void> {
  console.log('\nWhat the scheduler asks every minute');
  await time('watcher: every onboarded mailbox', 20, () => mailWatchService.eligibleAccounts());
  await time('onboarding sweep: pending mailboxes', 20, () => onboardingService.pendingAccounts());
  await time('shared Gemini budget: requests today', 20, () => geminiRequestsToday());
  const watched = await mailWatchService.eligibleAccounts();
  const pending = await onboardingService.pendingAccounts();
  console.log(
    `  (${watched.length} watched, ${pending.length} pending onboarding handed to free slots)`,
  );
}

async function folders(accountId: string): Promise<void> {
  console.log('\nOne inbox');
  await time(`folder tree over ${MESSAGES_PER_USER} messages`, 20, () =>
    pivotService.view(accountId, ['entity', 'intent'], undefined, 'all'),
  );
}

async function crowd(tokens: string[], round: string, spreadMs = 0): Promise<void> {
  const paths = [
    '/api/auth/me',
    '/api/onboarding',
    '/api/notifications',
    '/api/facets/pivot/view?order=entity,intent&range=all',
  ];
  const byPath = new Map<string, number[]>(paths.map((path) => [path, []]));
  const failures = new Map<number, number>();
  const started = performance.now();
  await Promise.all(
    tokens.map(async (token) => {
      // Spread arrivals evenly over the window, the way people actually open an app.
      if (spreadMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, Math.random() * spreadMs));
      }
      for (const path of paths) {
        const begun = performance.now();
        const response = await request(app).get(path).set('Cookie', `mailmind_session=${token}`);
        byPath.get(path)!.push(performance.now() - begun);
        if (response.status >= 400) {
          failures.set(response.status, (failures.get(response.status) ?? 0) + 1);
        }
      }
    }),
  );
  const elapsed = (performance.now() - started) / 1000;
  const all = [...byPath.values()].flat();
  const { median, p95, max } = summarize(all);
  const failed = [...failures.entries()].map(([status, count]) => `${count}×${status}`).join(', ');
  console.log(
    `  ${round.padEnd(22)} ${all.length} requests in ${elapsed.toFixed(1)} s · ` +
      `median ${ms(median)} · p95 ${ms(p95)} · max ${ms(max)} · ${failed || 'no errors'}`,
  );
  for (const [path, samples] of byPath) {
    const timing = summarize(samples);
    console.log(
      `      ${path.split('?')[0]!.padEnd(28)} median ${ms(timing.median)}  p95 ${ms(timing.p95)}`,
    );
  }
}

/** SCALE_REUSE=true: keep the seeded mail and only sign everyone in again, to rerun the crowd. */
async function reuse(): Promise<{ tokens: string[]; accountIds: string[] }> {
  const accounts = await prisma.connected_google_accounts.findMany({
    select: { id: true, user_id: true },
    orderBy: { created_at: 'asc' },
  });
  const tokens: string[] = [];
  for (const account of accounts) {
    const token = randomBytes(32).toString('base64url');
    tokens.push(token);
    await prisma.sessions.create({
      data: {
        user_id: account.user_id,
        session_token_hash: createHash('sha256').update(token).digest('hex'),
        expires_at: new Date(Date.now() + 30 * 86_400_000),
      },
    });
  }
  return { tokens, accountIds: accounts.map((account) => account.id) };
}

try {
  const reusing = process.env['SCALE_REUSE'] === 'true';
  if (!reusing) await reset();
  const { tokens, accountIds } = reusing ? await reuse() : await seed();
  if (!reusing) await storage();
  await scheduler();
  await folders(accountIds[0]!);
  console.log(`\n${tokens.length} people opening the app (4 screens each)`);
  if (process.env['SCALE_ONLY_STAGGERED'] !== 'true') {
    await crowd(tokens, 'all in the same instant');
    await crowd(tokens, 'again, sessions warm');
  }
  await crowd(tokens, 'arriving over 60 s', 60_000);
} finally {
  await prisma.$disconnect();
}
