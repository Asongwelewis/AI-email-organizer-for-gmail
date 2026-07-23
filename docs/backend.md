# Backend documentation

## Overview

The MailMind API is an Express 5 and TypeScript service in `apps/api`. It owns authentication,
encrypted Google credentials, metadata-only Gmail synchronization, classification recommendations,
dynamic-label suggestions, audit records, and all PostgreSQL access through Prisma.

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

| Variable                       | Purpose                                                                        |
| ------------------------------ | ------------------------------------------------------------------------------ |
| `NODE_ENV`                     | `development`, `test`, or `production`. Production requires secure cookies.    |
| `PORT`                         | HTTP port; defaults to `4000`.                                                 |
| `WEB_APP_URL`                  | Exact trusted frontend origin used by CORS, CSRF Origin checks, and redirects. |
| `API_BASE_URL`                 | Public backend URL used when constructing OAuth flows.                         |
| `DATABASE_URL`                 | PostgreSQL connection string used by both Prisma runtime and migrations.       |
| `SESSION_SECRET`               | At least 16 characters; signs cookies and protects session handling.           |
| `TOKEN_ENCRYPTION_KEY`         | Base64-encoded key that must decode to exactly 32 bytes.                       |
| `TOKEN_ENCRYPTION_KEY_VERSION` | Positive integer stored with encrypted OAuth tokens.                           |
| `COOKIE_SECURE`                | Must be `true` in production and whenever SameSite is `none`.                  |
| `COOKIE_SAME_SITE`             | `lax`, `strict`, or `none`.                                                    |
| `COOKIE_DOMAIN`                | Optional shared cookie domain; omit for a host-only cookie.                    |
| `GOOGLE_CLIENT_ID`             | Backend-only Google OAuth client identifier.                                   |
| `GOOGLE_CLIENT_SECRET`         | Backend-only Google OAuth client secret.                                       |
| `GOOGLE_LOGIN_REDIRECT_URI`    | Callback for identity login: `/api/auth/google/callback`.                      |
| `GOOGLE_GMAIL_REDIRECT_URI`    | Separate callback for Gmail connection: `/api/integrations/google/callback`.   |
| `LOG_LEVEL`                    | Pino log level.                                                                |
| `TRUST_PROXY_HOPS`             | Number of trusted reverse-proxy hops, from 0 through 3.                        |

Session lifetime and rate-limit controls:

- `ACCESS_SESSION_TTL_MINUTES`
- `REFRESH_SESSION_TTL_DAYS`
- `OAUTH_STATE_TTL_MINUTES`
- `AUTH_RATE_LIMIT_WINDOW_MINUTES`
- `AUTH_RATE_LIMIT_MAX_REQUESTS`

### Gmail synchronization

- `GMAIL_INITIAL_SYNC_MAX_MESSAGES`
- `GMAIL_SYNC_PAGE_SIZE`
- `GMAIL_SYNC_BATCH_SIZE`
- `GMAIL_SYNC_MAX_RETRIES`
- `GMAIL_SYNC_RETRY_BASE_MS`
- `GMAIL_SYNC_LEASE_SECONDS`

The sync boundary is metadata-only. The API requests Gmail messages with `format: "metadata"` and
the `Subject`, `From`, `To`, `Cc`, and `Date` headers. It stores those fields, Gmail IDs, a truncated
snippet, label IDs, state flags, estimated size, and whether an attachment exists. It does not
request or store full message bodies, raw MIME, or attachment content.

### Classification

The classifier is rules-first and supports `disabled`, deterministic `mock`, and `external`
providers:

- `AI_CLASSIFIER_ENABLED`
- `AI_CLASSIFIER_PROVIDER`
- `AI_CLASSIFIER_MODEL`
- `AI_CLASSIFIER_API_KEY`
- `AI_CLASSIFIER_BASE_URL`
- `AI_CLASSIFIER_TIMEOUT_MS`
- `AI_CLASSIFIER_MAX_RETRIES`
- `AI_CLASSIFIER_BATCH_SIZE`
- `AI_CLASSIFIER_OUTPUT_MAX_TOKENS`
- `AI_CLASSIFICATION_MAX_MESSAGES_PER_RUN`
- `AI_CLASSIFICATION_MIN_CONFIDENCE`
- `AI_CLASSIFICATION_REVIEW_THRESHOLD`
- `AI_CLASSIFICATION_INPUT_MAX_CHARS`
- `AI_CLASSIFICATION_RULE_THRESHOLD`
- `AI_CLASSIFICATION_LEASE_SECONDS`

When the provider is `external` and classification is enabled, both the API key and base URL are
required. Inputs are normalized from synchronized metadata and bounded before provider use.
Classification writes versioned recommendations and immutable user corrections; it does not mutate
Gmail.

### Dynamic-label discovery

- `DYNAMIC_LABEL_DISCOVERY_ENABLED`
- `DYNAMIC_LABEL_MIN_MESSAGES`
- `DYNAMIC_LABEL_LOOKBACK_DAYS`
- `DYNAMIC_LABEL_MIN_CONFIDENCE`
- `DYNAMIC_LABEL_MIN_CATEGORY_AGREEMENT`
- `DYNAMIC_LABEL_MIN_SOURCE_AGREEMENT`
- `DYNAMIC_LABEL_MAX_CANDIDATES_PER_RUN`
- `DYNAMIC_LABEL_MAX_MESSAGES_PER_RUN`
- `DYNAMIC_LABEL_MAX_PENDING_CANDIDATES`
- `DYNAMIC_LABEL_MAX_APPROVED_LABELS`
- `DYNAMIC_LABEL_REDISCOVERY_DAYS`
- `DYNAMIC_LABEL_AI_NAMING_ENABLED`

Discovery analyzes synchronized metadata and classification/correction signals. Approval, rename,
rejection, deferral, and merge operations only store user decisions. The current status contract
explicitly reports `gmailLabelCreationSupported: false`.

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
`Origin` other than `WEB_APP_URL` receive `403 CSRF_ORIGIN_INVALID`. CORS likewise permits only no
Origin or the exact configured frontend origin; wildcard credentialed CORS is not used.

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
| Classification        | `src/features/classification`            | Rules/provider pipeline, review queue, corrections     |
| Label discovery       | `src/features/label-discovery`           | Candidate discovery and human decisions                |
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

The schema groups data into identity/session/audit records, connected Google credentials, Gmail
metadata and sync state, classification results/runs/corrections, and label candidates/runs/
decisions. Foreign-key cascades keep account-owned data bounded. Migrations add database
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
