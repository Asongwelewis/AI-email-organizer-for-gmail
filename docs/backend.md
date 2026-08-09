# Backend documentation

## Overview

The MailMind API is an Express 5 and TypeScript service in `apps/api`. It owns authentication,
encrypted Google credentials, metadata-only Gmail synchronization, the user-approved label set,
daily Gemini/Gmail automation, audit records, and all PostgreSQL access through Prisma.

The backend is the only application component allowed to access the database, Google client secret,
Gmail OAuth tokens, session secrets, token-encryption key, or an external classifier credential.
The browser communicates with it through `/api`.

## Workspace and commands

Prerequisites are Node.js 22+, npm 10+, and PostgreSQL 16 or a compatible Supabase PostgreSQL
project.

From the repository root:

```powershell
npm ci
npm run prisma:generate --workspace @mailmind/api
npm run dev:api
```

The real workspace commands are:

| Purpose                        | Command                                                       |
| ------------------------------ | ------------------------------------------------------------- |
| Development server             | `npm run dev --workspace @mailmind/api`                       |
| Prisma validation              | `npm run prisma:validate --workspace @mailmind/api`           |
| Prisma client generation       | `npm run prisma:generate --workspace @mailmind/api`           |
| Apply pending migrations       | `npm exec --workspace @mailmind/api -- prisma migrate deploy` |
| Type-check source and tests    | `npm run typecheck --workspace @mailmind/api`                 |
| Run API tests                  | `npm test --workspace @mailmind/api`                          |
| Run database integration tests | `npm run test:database --workspace @mailmind/api`             |
| Audit database invariants      | `npm run audit:database --workspace @mailmind/api`            |
| Production build               | `npm run build --workspace @mailmind/api`                     |
| Start the built API            | `npm run start --workspace @mailmind/api`                     |

The production build is emitted to `apps/api/dist`. `src/index.ts` loads `server.ts`, which connects
Prisma before starting the HTTP listener. `SIGINT` and `SIGTERM` stop accepting requests, disconnect
Prisma, and have a ten-second forced-shutdown fallback.

## Configuration

Copy `apps/api/.env.example` to `apps/api/.env` for local development. Configuration is parsed by
Zod at process startup; invalid configuration stops startup and reports field names without
printing their values.

### Core, security, and OAuth

| Variable                       | Purpose                                                                       |
| ------------------------------ | ----------------------------------------------------------------------------- |
| `NODE_ENV`                     | `development`, `test`, or `production`. Production requires secure cookies.   |
| `PORT`                         | HTTP port; defaults to `4000`.                                                |
| `WEB_APP_URL`                  | Primary frontend origin used for redirects and added to the origin allowlist. |
| `API_BASE_URL`                 | Public backend URL used when constructing OAuth flows.                        |
| `DATABASE_URL`                 | PostgreSQL connection string used by both Prisma runtime and migrations.      |
| `SESSION_SECRET`               | At least 16 characters; signs cookies and protects session handling.          |
| `TOKEN_ENCRYPTION_KEY`         | Base64-encoded key that must decode to exactly 32 bytes.                      |
| `TOKEN_ENCRYPTION_KEY_VERSION` | Positive integer stored with encrypted OAuth tokens.                          |
| `COOKIE_SECURE`                | Must be `true` in production and whenever SameSite is `none`.                 |
| `COOKIE_SAME_SITE`             | `lax`, `strict`, or `none`.                                                   |
| `COOKIE_DOMAIN`                | Optional shared cookie domain; omit for a host-only cookie.                   |
| `GOOGLE_CLIENT_ID`             | Backend-only Google OAuth client identifier.                                  |
| `GOOGLE_CLIENT_SECRET`         | Backend-only Google OAuth client secret.                                      |
| `GOOGLE_LOGIN_REDIRECT_URI`    | Callback for identity login: `/api/auth/google/callback`.                     |
| `GOOGLE_GMAIL_REDIRECT_URI`    | Separate callback for Gmail connection: `/api/integrations/google/callback`.  |
| `LOG_LEVEL`                    | Pino log level.                                                               |
| `TRUST_PROXY_HOPS`             | Number of trusted reverse-proxy hops, from 0 through 3.                       |

Session lifetime and rate-limit controls:

- `REFRESH_SESSION_TTL_DAYS`
- `OAUTH_STATE_TTL_MINUTES`
- `AUTH_RATE_LIMIT_WINDOW_MINUTES`
- `AUTH_RATE_LIMIT_MAX_REQUESTS`

### Gmail synchronization

- `GMAIL_SYNC_PAGE_SIZE`
- `GMAIL_SYNC_BATCH_SIZE`
- `GMAIL_SYNC_MAX_RETRIES`
- `GMAIL_SYNC_RETRY_BASE_MS`
- `GMAIL_SYNC_LEASE_SECONDS`

The sync boundary is metadata-only. The API requests Gmail messages with `format: "metadata"` and
the `Subject`, `From`, `To`, `Cc`, and `Date` headers. It stores those fields, Gmail IDs, a truncated
snippet, label IDs, state flags, estimated size, and whether an attachment exists. It does not
request or store full message bodies, raw MIME, or attachment content.

### Labels

The label set is proposed by the deterministic discovery engine, edited by the user, and confirmed
once. Only confirmed labels exist in `user_labels`, and only those may be applied by automation.

- `AUTOMATION_MAX_LABELS` caps proposals plus approved labels per account (default `25`).
- `DYNAMIC_LABEL_MIN_MESSAGES`, `DYNAMIC_LABEL_LOOKBACK_DAYS`, `DYNAMIC_LABEL_MIN_CONFIDENCE`,
  `DYNAMIC_LABEL_MIN_CATEGORY_AGREEMENT`, `DYNAMIC_LABEL_MIN_SOURCE_AGREEMENT`, and
  `DYNAMIC_LABEL_MAX_MESSAGES_PER_RUN` tune the engine that produces proposals.

Names are validated with `validateLeafName`, rejected when `isGenericLabelName` matches, and
compared with `labelsAreSimilar` so an account cannot hold two near-duplicate labels. Confirmation
creates `MailMind/<leafName>` in Gmail through the automation Gmail adapter and stores the returned
Gmail label id. Deleting a label removes only MailMind's record; the Gmail label and the mail
already filed under it are never touched.

Proposals take the account's automation lease, so a proposal and an automation run can never
overlap for the same account.

### Daily automation

Stage 5 configuration is documented in [Stage 5 daily automation](stage-5-daily-automation.md).
Without `GEMINI_API_KEY`, automation remains unavailable without preventing the existing API from
starting. The scheduler starts only after Prisma connects and stops during graceful shutdown.
Provider and Gmail errors are logged
through safe structured fields; request bodies, tokens, secrets, and message content are excluded.

The classifier is Google Gemini (`GEMINI_MODEL`, default `gemini-2.5-flash-lite`). Requests are
paced by `GEMINI_MIN_REQUEST_INTERVAL_MS` rather than driven into 429s, and cost accounting is
notional — the free tier bills nothing, but the provider computes micro-USD from Gemini's published
paid rates so `AUTOMATION_MAX_COST_MICRO_USD` still bounds a runaway run.

> **Free-tier data use.** On Google's **free** Gemini tier, submitted content may be used to
> improve Google's products. MailMind sends only bounded Gmail _metadata_ — subject, sender,
> truncated snippet, and state flags — never bodies, raw MIME, or attachments. That trade-off is
> acceptable for **single-user personal use only**. Before any third party's mail flows through
> this provider, move the project to a **paid** tier, where submitted content is not used that way.
> See <https://ai.google.dev/gemini-api/docs/pricing> (checked 2026-08-09).

## Request pipeline

Requests pass through:

1. Helmet security headers and optional trusted-proxy configuration.
2. Compression and structured request logging.
3. Exact-origin CORS with credentials.
4. Bounded JSON and URL-encoded parsers (1 MiB).
5. Signed cookie parsing.
6. Route-specific rate limiting, session authentication, and trusted-Origin checks.
7. Controllers, services, and repositories.
8. A centralized JSON error handler.

Mutating cookie-authenticated endpoints use `requireTrustedOrigin`. Browser requests with an
`Origin` outside the shared frontend allowlist receive `403 CSRF_ORIGIN_INVALID`. CORS likewise
permits only requests without an Origin or requests from an allowlisted origin; wildcard
credentialed CORS is not used.

The `mailmind_session` cookie is HttpOnly, has path `/`, uses the configured Secure, SameSite, and
optional Domain attributes, and expires after `REFRESH_SESSION_TTL_DAYS`. Clearing the cookie uses
the same attributes.

Production logs are JSON and redact authorization headers, cookies, OAuth codes/state, Google
tokens, session tokens, passwords, database URLs, and the token-encryption key.

## Modules

| Area                  | Main location                            | Responsibility                                         |
| --------------------- | ---------------------------------------- | ------------------------------------------------------ |
| Application/bootstrap | `src/app.ts`, `src/server.ts`            | Middleware, routes, startup, shutdown                  |
| Configuration/logging | `src/config`                             | Environment validation and redacted Pino logging       |
| Authentication        | `src/auth`, `src/sessions`               | Google login, opaque sessions, cookie lifecycle        |
| Google connection     | `src/integrations/google`                | Separate Gmail consent, encrypted tokens, revocation   |
| Gmail sync            | `src/integrations/gmail`                 | Labels, initial sync, history-based incremental sync   |
| Labels                | `src/features/labels`                    | Proposal, approval, rename, delete of the label set    |
| Discovery engine      | `src/features/label-discovery`           | Engine-only: normalization, confidence, candidates     |
| Daily automation      | `src/features/automation`                | Scheduler, Gemini, Gmail apply, budgets, review        |
| Persistence           | `src/repositories`, feature repositories | Account-scoped Prisma queries and leases               |
| Security              | `src/security`, `src/middleware`         | Encryption, hashing, safe redirects, CORS/CSRF, limits |
| Audit                 | `src/audit`                              | Security and user-action audit records                 |

Controllers validate transport input and delegate to services. Services enforce business rules and
privacy boundaries. Repositories own Prisma access and account scoping.

## Database and migrations

The Prisma schema is `apps/api/prisma/schema.prisma`. Ordered migrations are stored in
`apps/api/prisma/migrations`, with matching SQL copies under `supabase/migrations`:

1. `20260720022901_create_app_auth_schema`
2. `20260720224458_stage2_security_hardening`
3. `20260723162227_gmail_sync_foundation`
4. `20260723195408_ai_classification_pipeline`
5. `20260723203016_dynamic_label_discovery`
6. `20260726102117_daily_automation`
7. `20260726121553_account_scoped_tutorial`
8. `20260726181430_gmail_full_backfill_coverage`
9. `20260726210000_ai_automation_recovery`
10. `20260729090000_remove_classification_and_discovery_workflow`
11. `20260731090000_stage2_user_labels`

The schema groups data into identity/session/audit records, connected Google credentials, Gmail
metadata and sync state, the approved `user_labels` set, discovery candidates, and automation
settings/state/runs/actions plus learned patterns. Foreign-key cascades keep account-owned data
bounded. Migrations add database
constraints, indexes, privileges, and forced RLS that Prisma schema syntax cannot fully express.

Use `prisma migrate deploy` for non-development migration application. Do not use
`prisma migrate reset` against a shared or remote Supabase project.

## Health and operations

| Probe                   | Behavior                                                                                  |
| ----------------------- | ----------------------------------------------------------------------------------------- |
| `GET /health`           | Process liveness; returns 200 without querying PostgreSQL.                                |
| `GET /ready`            | Runs `select 1` with a five-second bound; returns 200 when ready or 503 when unavailable. |
| `GET /api/health`       | Prefixed liveness alias.                                                                  |
| `GET /api/health/ready` | Prefixed readiness alias.                                                                 |
| `GET /api/ready`        | Prefixed readiness alias.                                                                 |

The process connects to Prisma before it listens. A failed initial database connection exits with a
non-zero status. Readiness responses expose only dependency state, not connection details.

See [API reference](api.md) for endpoint contracts and [Architecture](architecture.md) for
cross-component data flow.
