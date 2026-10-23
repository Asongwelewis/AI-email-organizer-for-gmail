/**
 * Ten beta mailboxes sorted at once, against a local Postgres, through the real classifier — and a
 * check that nothing in any window is left unsorted and nothing outside one is touched.
 *
 *   RUN_SCALE_TEST=true NODE_ENV=test DATABASE_URL=postgresql://…@127.0.0.1:5432/… \
 *     npm run test:beta --workspace @mailmind/api
 *
 * Truncates what it fills, so it refuses any database not on this machine.
 *
 * Render's free instance has 0.1 CPU and 512 MB. CPU time is measured here and divided by 0.1 to
 * estimate wall time there; memory is the process's peak resident set. Gmail is not called: the
 * write path a sync takes is exercised for real, and Gmail's own speed (about 50 messages a second
 * per mailbox under its per-user quota) is reported as an estimate beside it.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

import request from 'supertest';

const MAILBOXES = Number(process.env['BETA_MAILBOXES'] ?? 10);
const IN_WINDOW = Number(process.env['BETA_MESSAGES'] ?? 6000);
const OUTSIDE_WINDOW = Number(process.env['BETA_OLD_MESSAGES'] ?? 800);
const OWNER = 'owner@sim.test';

const databaseUrl = new URL(process.env['DATABASE_URL'] ?? '');
if (
  process.env['RUN_SCALE_TEST'] !== 'true' ||
  !['localhost', '127.0.0.1', '::1', '[::1]'].includes(databaseUrl.hostname)
) {
  console.error('Refusing: set RUN_SCALE_TEST=true and point DATABASE_URL at a local database.');
  process.exit(1);
}
process.env['OWNER_ACCOUNT_EMAILS'] = OWNER;

const { env } = await import('../src/config/env.js');
env.OWNER_ACCOUNT_EMAILS = [OWNER];
const { prisma } = await import('../src/database/prisma.js');
const { gmailRepository } = await import('../src/integrations/gmail/gmail.repository.js');
const { facetClassificationService } =
  await import('../src/features/automation/facet-classification.service.js');
const { replaceReferenceRules, buildReferenceRules, DEFAULT_REFERENCE_OPTIONS } =
  await import('../src/features/label-discovery/reference-rules.js');
const { APPROVED_FACET_VOCABULARY, MODEL_FACET_NAMES } =
  await import('../src/features/label-discovery/facets.js');
const { facetVocabularyRepository } =
  await import('../src/features/label-discovery/facet-vocabulary.repository.js');
const { runHousekeeping } = await import('../src/services/housekeeping.js');
const { mayConnectMailbox } = await import('../src/features/accounts/beta-capacity.js');
const { forEachWithConcurrency } = await import('../src/utils/concurrency.js');
const { app } = await import('../src/app.js');

const DAY = 86_400_000;

/** Senders and subjects shaped like a real mailbox: brands, newsletters, people, alerts. */
const SENDERS = [
  [
    'jobs-noreply@linkedin.com',
    ['“software engineer”: Acme - Backend Intern', 'Acme is hiring', 'You appeared in 9 searches'],
    'CATEGORY_UPDATES',
  ],
  [
    'noreply@github.com',
    ['[org/repo] Fix login flow (#42)', 'Security alert: new sign-in', 'Your verification code'],
    'CATEGORY_UPDATES',
  ],
  [
    'digest@quora.com',
    ['Why is Rust so popular?', 'What happens when AI gets cheap?'],
    'CATEGORY_UPDATES',
  ],
  [
    'noreply@redditmail.com',
    ['"[OC] A map of every river"', 'Trending in r/programming'],
    'CATEGORY_SOCIAL',
  ],
  [
    'deals@shop.example.com',
    ['50% off everything this weekend', 'Flash sale ends tonight'],
    'CATEGORY_PROMOTIONS',
  ],
  [
    'info@mail.netflix.com',
    ['New on Netflix this week', 'Update required – account on hold'],
    'CATEGORY_UPDATES',
  ],
  [
    'billing@paysika.co',
    ['Payment with insufficient funds', 'Your receipt #4821'],
    'CATEGORY_UPDATES',
  ],
  [
    'team@coursera.org',
    ['Early bird offer: 50% off Coursera Plus', 'Welcome to Version Control'],
    'CATEGORY_PROMOTIONS',
  ],
  [
    'events@cisco.com',
    ['Join our webinar on Thursday', 'Save your seat: AI summit'],
    'CATEGORY_PROMOTIONS',
  ],
  [
    'notification@facebookmail.com',
    ['Royal wants to be friends on Facebook', 'Takang sent you a message'],
    'CATEGORY_SOCIAL',
  ],
  ['friend.one@gmail.com', ['Lunch on Friday?', 'Photos from the weekend'], null],
  ['someone@unknownstartup.io', ['Quick question about your project', 'Following up'], null],
] as const;

function messagesFor(mailbox: number, connectedAt: Date) {
  const windowStart = connectedAt.getTime() - env.MAIL_HISTORY_DAYS * DAY;
  const all = [];
  const total = IN_WINDOW + OUTSIDE_WINDOW;
  for (let n = 0; n < total; n += 1) {
    const [sender, subjects, category] = SENDERS[(n * 7 + mailbox) % SENDERS.length]!;
    const inside = n < IN_WINDOW;
    // Inside the window: spread over two years. Outside: up to a year before it starts.
    const at = inside
      ? connectedAt.getTime() - (n / IN_WINDOW) * (connectedAt.getTime() - windowStart - DAY)
      : windowStart - DAY - ((n - IN_WINDOW) / OUTSIDE_WINDOW) * 365 * DAY;
    all.push({
      gmail_message_id: `beta-${mailbox}-${n}`,
      gmail_thread_id: `t-${mailbox}-${Math.floor(n / 3)}`,
      history_id: String(1000 + n),
      internal_date: new Date(at),
      subject: subjects[n % subjects.length]!,
      sender_name: sender.split('@')[0]!,
      sender_email: sender,
      recipient_summary: `beta${mailbox}@gmail.com`,
      snippet: 'A short stored preview, as the sync keeps it.',
      label_ids: category ? ['INBOX', category] : ['INBOX'],
      has_attachments: false,
      size_estimate: 9000,
      is_unread: n % 5 === 0,
      is_starred: false,
      is_important: false,
      is_draft: false,
      is_sent: false,
      is_trashed: false,
    });
  }
  return all;
}

const ms = (value: number) => `${value.toFixed(0)} ms`;
/** Peak resident memory per phase, so seeding (which the server never does) is not counted. */
let peakRss = 0;
const sampler = setInterval(() => {
  peakRss = Math.max(peakRss, process.memoryUsage().rss);
}, 50);
const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(0)} MB`;
function phase(name: string): () => void {
  global.gc?.();
  const start = process.memoryUsage().rss;
  peakRss = start;
  return () => console.log(`  memory during ${name}: started ${mb(start)}, peaked ${mb(peakRss)}`);
}

async function reset() {
  await prisma.$executeRawUnsafe(`
    truncate table public.notifications, public.message_facets, public.gmail_message_metadata,
      public.gmail_sync_states, public.automation_runs, public.activity_runs, public.sessions,
      public.facet_vocabularies, public.reference_classification_rules, public.automation_states,
      public.connected_google_accounts, public.users restart identity cascade
  `);
}

async function seed() {
  const connectedAt = new Date();
  const accounts: Array<{ id: string; token: string }> = [];
  const vocabulary = MODEL_FACET_NAMES.flatMap((facet) =>
    APPROVED_FACET_VOCABULARY[facet].map((value) => ({
      facet,
      name: value.name,
      definition: value.definition,
    })),
  );
  let written = 0;
  const started = performance.now();
  for (let mailbox = 0; mailbox < MAILBOXES; mailbox += 1) {
    const user = await prisma.users.create({
      data: {
        google_subject: `beta-${mailbox}`,
        email: `beta${mailbox}@gmail.com`,
        normalized_email: `beta${mailbox}@gmail.com`,
        email_verified: true,
      },
    });
    const account = await prisma.connected_google_accounts.create({
      data: {
        user_id: user.id,
        google_subject: `beta-google-${mailbox}`,
        email: `beta${mailbox}@gmail.com`,
        gmail_connected: true,
        connection_status: 'CONNECTED',
        onboarding_stage: 'DONE',
        onboarding_completed_at: connectedAt,
      },
    });
    await facetVocabularyRepository.approve(account.id, vocabulary);
    const token = randomBytes(32).toString('base64url');
    await prisma.sessions.create({
      data: {
        user_id: user.id,
        session_token_hash: createHash('sha256').update(token).digest('hex'),
        expires_at: new Date(Date.now() + 30 * DAY),
      },
    });
    accounts.push({ id: account.id, token });
    const mail = messagesFor(mailbox, account.created_at);
    for (let offset = 0; offset < mail.length; offset += 25) {
      await gmailRepository.upsertMessages(account.id, mail.slice(offset, offset + 25));
      written += Math.min(25, mail.length - offset);
    }
  }
  const seconds = (performance.now() - started) / 1000;
  console.log(
    `seeded ${MAILBOXES} mailboxes, ${written.toLocaleString()} messages (${IN_WINDOW} in each window, ${OUTSIDE_WINDOW} older) in ${seconds.toFixed(1)} s`,
  );
  console.log(
    `  Gmail would take ~${Math.ceil(IN_WINDOW / 50 / 60)} min per mailbox to send its window (50 messages/s per user quota)`,
  );
  return accounts;
}

async function referenceFromOwnerLikeMail() {
  // A stand-in for the owner's checked mailbox: consistent senders with known facets.
  const samples = [
    ...Array.from({ length: 40 }, () => ({
      subject: 'Acme is hiring',
      senderEmail: 'jobs@linkedin.com',
      domain: 'career',
      intent: 'job-match',
    })),
    ...Array.from({ length: 40 }, () => ({
      subject: 'New on Netflix this week',
      senderEmail: 'info@netflix.com',
      domain: 'entertainment',
      intent: 'newsletter',
    })),
    ...Array.from({ length: 30 }, () => ({
      subject: 'Your receipt',
      senderEmail: 'billing@paysika.co',
      domain: 'finance',
      intent: 'invoice-receipt',
    })),
  ];
  const rules = buildReferenceRules(samples, {
    ...DEFAULT_REFERENCE_OPTIONS,
    excludedWords: new Set(),
  });
  await replaceReferenceRules(rules);
  return rules.length;
}

async function sortEveryone(accounts: Array<{ id: string }>) {
  const cpuBefore = process.cpuUsage();
  const started = performance.now();
  const results: Array<{ sorted: number; heuristic: number; ms: number }> = [];
  await forEachWithConcurrency(accounts, env.ONBOARDING_CONCURRENCY, async (account) => {
    const began = performance.now();
    const counters = await facetClassificationService.classifyAccount(account.id, {
      scope: 'backlog',
    });
    results.push({
      sorted: counters.ruleDecided,
      heuristic: counters.heuristicDecided,
      ms: performance.now() - began,
    });
  });
  const wall = performance.now() - started;
  const cpu = process.cpuUsage(cpuBefore);
  const cpuSeconds = (cpu.user + cpu.system) / 1e6;
  const sorted = results.reduce((total, result) => total + result.sorted, 0);
  console.log(
    `\nsorted ${sorted.toLocaleString()} messages across ${MAILBOXES} mailboxes, ${env.ONBOARDING_CONCURRENCY} at a time`,
  );
  console.log(
    `  wall ${ms(wall)} here · ${Math.round(sorted / (wall / 1000)).toLocaleString()} messages/s`,
  );
  console.log(`  per mailbox: ${results.map((result) => ms(result.ms)).join(', ')}`);
  console.log(
    `  ${results.reduce((t, r) => t + r.heuristic, 0).toLocaleString()} by heuristics alone, the rest by a rule`,
  );
  console.log(
    `  API CPU ${cpuSeconds.toFixed(1)} s -> on Render's 0.1 CPU ≈ ${(cpuSeconds / 0.1 / 60).toFixed(1)} min of CPU for all ten`,
  );
}

async function verify(accounts: Array<{ id: string }>) {
  let unsortedInWindow = 0;
  let sortedOutside = 0;
  for (const account of accounts) {
    const row = await prisma.connected_google_accounts.findUniqueOrThrow({
      where: { id: account.id },
    });
    const windowStart = new Date(row.created_at.getTime() - env.MAIL_HISTORY_DAYS * DAY);
    unsortedInWindow += await prisma.gmail_message_metadata.count({
      where: {
        connected_google_account_id: account.id,
        internal_date: { gte: windowStart },
        facets: null,
      },
    });
    sortedOutside += await prisma.message_facets.count({
      where: {
        connected_google_account_id: account.id,
        message: { internal_date: { lt: windowStart } },
      },
    });
  }
  console.log(`\nchecks`);
  console.log(
    `  messages in a window with no decision: ${unsortedInWindow} ${unsortedInWindow === 0 ? 'OK' : 'FAIL'}`,
  );
  console.log(
    `  messages outside a window that were sorted: ${sortedOutside} ${sortedOutside === 0 ? 'OK' : 'FAIL'}`,
  );
  const housekeeping = await runHousekeeping();
  const left = await prisma.gmail_message_metadata.count({
    where: { internal_date: { lt: new Date(Date.now() - env.MAIL_HISTORY_DAYS * DAY) } },
  });
  console.log(
    `  housekeeping removed ${housekeeping.outsideWindow} older messages; ${left} remain ${left === 0 ? 'OK' : 'FAIL'}`,
  );
  const full = await mayConnectMailbox(randomUUID(), 'someone-new@gmail.com');
  console.log(
    `  an 11th mailbox may connect: ${full} ${full ? 'FAIL' : 'OK (beta is full at 10)'}`,
  );
  return unsortedInWindow === 0 && sortedOutside === 0 && left === 0 && !full;
}

async function polling(accounts: Array<{ token: string }>) {
  // Ten people with the app open, each screen polling as the PWA does, for 30 seconds.
  const paths = [
    '/api/auth/me',
    '/api/onboarding',
    '/api/notifications',
    '/api/facets/pivot/view?order=entity,intent&range=all',
  ];
  // CPU per kind of request, measured one at a time with nothing else running: what Render's
  // 0.1 CPU multiplies by ten.
  for (const path of paths) {
    const runs = 10;
    const before = process.cpuUsage();
    const began = performance.now();
    for (let index = 0; index < runs; index += 1) {
      await request(app).get(path).set('Cookie', `mailmind_session=${accounts[0]!.token}`);
    }
    const cpu = process.cpuUsage(before);
    const cpuMs = (cpu.user + cpu.system) / 1000 / runs;
    console.log(
      `  ${path.split('?')[0]!.padEnd(26)} ${((performance.now() - began) / runs).toFixed(0).padStart(4)} ms here, ${cpuMs.toFixed(0).padStart(4)} ms CPU -> ~${(cpuMs / 0.1 / 1000).toFixed(1)} s on 0.1 CPU`,
    );
  }
  const samples: number[] = [];
  let failures = 0;
  const end = Date.now() + 30_000;
  await Promise.all(
    accounts.map(async (account) => {
      while (Date.now() < end) {
        for (const path of paths) {
          const began = performance.now();
          const response = await request(app)
            .get(path)
            .set('Cookie', `mailmind_session=${account.token}`);
          samples.push(performance.now() - began);
          if (response.status >= 400) failures += 1;
        }
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }),
  );
  samples.sort((a, b) => a - b);
  const at = (share: number) =>
    samples[Math.min(samples.length - 1, Math.floor(samples.length * share))]!;
  console.log(
    `\n${accounts.length} people using the app for 30 s: ${samples.length} requests, median ${ms(at(0.5))}, p95 ${ms(at(0.95))}, max ${ms(samples.at(-1)!)}, ${failures} errors`,
  );
}

let ok = false;
try {
  await reset();
  const accounts = await seed();
  console.log(`reference rules: ${await referenceFromOwnerLikeMail()}`);
  let done = phase('sorting');
  await sortEveryone(accounts);
  done();
  ok = await verify(accounts);
  console.log('\nrequests, one kind at a time');
  done = phase('ten people using the app');
  await polling(accounts);
  done();
} finally {
  clearInterval(sampler);
  await prisma.$disconnect();
}
process.exit(ok ? 0 : 1);
