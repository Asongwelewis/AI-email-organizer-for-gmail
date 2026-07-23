# Stage 3 Gmail synchronization and labels

## Scope and security boundary

Stage 3 adds a backend-only Gmail client and request-driven synchronization. It does not change the
Stage 2 MailMind session or OAuth architecture and does not use Supabase Auth. Google tokens are
decrypted only inside the trusted API client factory and are never returned to the browser, logged,
or stored in plaintext.

MailMind stores message IDs, thread/history IDs, dates, selected decoded headers, a bounded snippet,
label IDs, size, flags, and whether a MIME part references an attachment. It never stores message
bodies, attachment content, or raw MIME. The UI exposes only aggregate sync state and counts.

The exact managed label namespace is:

- `MailMind`
- `MailMind/Processed`
- `MailMind/Needs Review`

Initialization reuses exact existing names and never renames or deletes Gmail labels.

## Environment

The Session Pooler and dedicated `prisma` role setup remains documented in
[Stage 2 setup](stage-2-setup.md). Stage 3 adds bounded operational controls:

```dotenv
GMAIL_INITIAL_SYNC_MAX_MESSAGES=250
GMAIL_SYNC_PAGE_SIZE=100
GMAIL_SYNC_BATCH_SIZE=10
GMAIL_SYNC_MAX_RETRIES=3
GMAIL_SYNC_RETRY_BASE_MS=250
GMAIL_SYNC_LEASE_SECONDS=300
```

The initial limit is deliberately finite. Page size is at most Gmail's 500-message maximum. Batch
size bounds concurrent metadata reads. Retry applies only to rate limits, network failures, and
upstream 5xx responses. The database lease prevents overlapping operations for one connected
account across API instances and expires for crash recovery. Gmail network calls never run inside a
database transaction.

## Migration

The same timestamped SQL is tracked in both Prisma and Supabase migration directories. It creates
`gmail_sync_states`, `gmail_message_metadata`, `gmail_labels`, and `gmail_sync_runs`, plus the three
sync enums. All four tables have forced RLS, no direct `PUBLIC`, `anon`, or `authenticated` DML
privileges, account foreign keys with cascade cleanup, and lookup/uniqueness indexes.

Always prove the migration against an empty disposable PostgreSQL database before deploying it:

```sh
npm exec --workspace @mailmind/api -- prisma migrate deploy
npm exec --workspace @mailmind/api -- prisma migrate status
npm run audit:database --workspace @mailmind/api
```

Never run reset, truncate, or destructive integration tests against the shared Supabase project.
Deploy remotely only with the Session Pooler URL for the dedicated Prisma role and confirm the
existing Stage 2 data remains intact.

## API

All routes require a MailMind session. POST routes additionally require a trusted browser origin
and use the stricter Gmail sync limiter.

- `GET /api/gmail/profile`
- `GET /api/gmail/labels`
- `GET /api/gmail/sync/status`
- `POST /api/gmail/labels/initialize`
- `POST /api/gmail/sync/initial`
- `POST /api/gmail/sync/incremental`

The initial sync validates the Gmail profile identity, synchronizes labels, lists a bounded set of
messages, requests only Gmail's metadata representation, persists idempotent upserts, and advances
the history checkpoint only after successful processing. Incremental sync consumes Gmail history,
refetches changed metadata, marks deleted messages, and advances the checkpoint only on success.
An expired history ID sets `HISTORY_EXPIRED`; it preserves prior data and directs the user to run a
fresh initial sync. Repeated POSTs while a lease is active return a safe 409 conflict.

## Verification

Automated tests mock Google and must not call a real Gmail account:

```sh
npm run prisma:validate --workspace @mailmind/api
npm run prisma:generate --workspace @mailmind/api
npm test
npm run typecheck
npm run lint
npm run format:check
npm run build
```

For an isolated migrated database only:

```sh
set RUN_DATABASE_INTEGRATION=true
npm run test:database --workspace @mailmind/api
npm run audit:database --workspace @mailmind/api
```

The database tests clean Gmail child tables before connected accounts and clean all generated rows
in `afterAll`. The audit verifies migrations, the dedicated Prisma role, RLS/forced RLS, revoked Data
API privileges, indexes, foreign keys, triggers, enum types, absence of `citext`, and absence of
known test artifacts.

Optional manual Gmail verification requires a Google test user. Connect Gmail, prepare labels, run
an initial sync, modify labels/read state in Gmail, run incremental sync, then confirm counts and
timestamps update without any body/token appearing in browser responses or logs. This manual check
must be reported as unperformed unless it was actually completed.
