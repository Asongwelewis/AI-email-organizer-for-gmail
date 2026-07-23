# Stage 2 setup, security, and release readiness

## Architecture

MailMind uses Google OpenID Connect only to establish application identity. The API issues an
opaque, database-backed MailMind session in an HttpOnly cookie. Gmail authorization is a separate,
authenticated OAuth flow requesting `gmail.modify`; Google credentials are encrypted with
AES-256-GCM before persistence. The browser talks only to the Express API and never receives a
database credential, Supabase key, MailMind session token, or Google token.

The backend-only tables are `users`, `sessions`, `oauth_states`,
`connected_google_accounts`, and `audit_logs`. RLS is enabled and forced. `anon`, `authenticated`,
and `PUBLIC` have no direct table privileges. The dedicated `prisma` login role deliberately has
`BYPASSRLS`; it is a server secret and must never be used in a browser.

## Prerequisites and environment

- Node.js 22+, npm 10+, Docker Desktop, and Supabase CLI 2.x
- A Supabase project and Google Cloud OAuth web client

Copy `apps/api/.env.example` to `apps/api/.env` and `apps/web/.env.example` to
`apps/web/.env`. Never commit either real file. Generate the encryption key privately as 32 random
bytes encoded with Base64. The API rejects any other decoded length.

MailMind uses Supabase's shared Session Pooler on port 5432 for the persistent API and Prisma
migrations. This is the documented IPv4-compatible alternative to a direct connection for
persistent backends. The username format is `prisma.PROJECT_REF`. URL-encode the database password;
it is not a Supabase API key. The direct database endpoint is normally IPv6 and may be unreachable
from IPv4-only networks.

The URL includes conservative `connection_limit`, `connect_timeout`, and `pool_timeout` values.
The API also bounds interactive-transaction wait and execution time. Cold projects can take several
seconds to wake, and the process establishes and warms Prisma before accepting traffic.

Transaction pooling on port 6543 is best suited to transient/serverless clients and requires
prepared statements to be disabled with Prisma's `pgbouncer=true` URL option. MailMind is a
persistent API, so changing pool modes is a deployment decision rather than a default setup step.

## Supabase role and migrations

Create the role from the Supabase SQL editor as an administrator. Substitute a new private password
locally; never save the executed statement in source control.

```sql
create role prisma with login bypassrls password 'REPLACE_PRIVATELY';
grant usage, create on schema public to prisma;
```

`BYPASSRLS` is intentional: forced RLS blocks direct Data API access while the trusted backend must
operate across application users. Protect this credential like a service credential.

```sh
npm run prisma:validate --workspace @mailmind/api
npm run prisma:generate --workspace @mailmind/api
npm exec --workspace @mailmind/api -- prisma migrate deploy
npm exec --workspace @mailmind/api -- prisma migrate status
```

Verify that the role retains only intended application DML access outside migration windows.
Schema ownership may be required for later migrations; consider separate runtime and migration
roles before public deployment if policy requires stricter DDL separation.

Never run `prisma migrate reset`, `supabase db reset`, table truncation, or destructive tests against
a shared Supabase project. `citext` is not required: normalized email is protected by a check and a
unique index. UUID defaults use `gen_random_uuid()`.

## Google Cloud OAuth

Create a Web Application OAuth client. Configure the exact redirect URIs stored in the API
environment, normally:

```text
http://localhost:4000/api/auth/google/callback
http://localhost:4000/api/integrations/google/callback
```

Enable the Gmail API. Configure the consent screen, app name, support email, and test users while
the app is in testing mode. Login requests only `openid email profile`. Gmail connection separately
requests `https://www.googleapis.com/auth/gmail.modify`, incremental authorization, and offline
access. A `redirect_uri_mismatch` means the Google and backend values differ exactly—including
scheme, host, port, path, or trailing slash.

## Startup and health

```sh
npm install
npm run prisma:generate --workspace @mailmind/api
npm run dev
```

- Liveness: `GET http://localhost:4000/health` (legacy `GET /api/health` remains supported)
- Readiness: `GET http://localhost:4000/ready` (also `GET /api/ready`)
- Web: `http://localhost:5173`

Liveness reports process status. Readiness performs a bounded PostgreSQL check and returns 503 when
the dependency is unavailable. Neither exposes environment or connection details.

## Manual OAuth checklist

Automated tests mock Google and must never call real Google APIs.

1. Open `/login`, continue with Google, and confirm the dashboard loads.
2. Confirm the cookie is HttpOnly, `Path=/`, `SameSite=Lax`, and Secure in production.
3. Confirm one user, one active hashed session, and safe audit events exist; no plaintext Google
   credential should exist.
4. Connect Gmail and approve `gmail.modify`. Confirm `CONNECTED`, the stored scope, and unreadable
   ciphertext/IV/tag credential fields.
5. Deny a fresh Gmail request. Confirm the MailMind session survives and state cannot be reused.
6. Log out and confirm only the current session is revoked and the cookie clears.
7. If practical, create two sessions, use logout-all, and confirm both are revoked.
8. Disconnect Gmail. Confirm Google revocation is attempted, local credential material clears,
   Gmail becomes disconnected, and the MailMind session survives.

Do not paste authorization codes, states, cookies, tokens, or credentials into tickets or logs.

## Security behavior

- OAuth state uses at least 32 random bytes, is hashed before storage, expires, is purpose-bound,
  and is atomically consumed. Gmail state is bound to both initiating user and session.
- Session tokens use at least 32 random bytes; only SHA-256 hashes are stored. Refresh rotation has
  one database winner, and `last_used_at` writes are throttled.
- Google tokens use AES-256-GCM with a fresh 12-byte IV, separate authentication tag, and key
  version. Missing refresh credentials force reauthorization.
- Token refresh uses an expiry compare-and-update. Multiple instances may make one redundant Google
  request, but only one persistence update wins; no transaction remains open during Google I/O.
- Credentialed CORS permits only `WEB_APP_URL`. Cookie-authenticated mutations reject a present
  untrusted Origin; absent Origin remains available to trusted non-browser tooling.
- Rate limits are process-local in Stage 2. Horizontal production needs a shared store.
- Logs have request IDs and redaction. Responses never include Prisma, Google, or encryption internals.

## Cleanup and retention

Stage 2 adds no queue. Run cleanup from a controlled job in small batches. Repeat each statement
until zero rows are affected; never delete active sessions.

```sql
with expired as (
  select id from public.oauth_states
  where expires_at < now() or used_at < now() - interval '1 day'
  order by created_at limit 500
)
delete from public.oauth_states where id in (select id from expired);

with expired as (
  select id from public.sessions
  where expires_at < now() or revoked_at < now() - interval '30 days'
  order by created_at limit 500
)
delete from public.sessions where id in (select id from expired);

with expired as (
  select id from public.audit_logs
  where created_at < now() - interval '180 days'
  order by created_at limit 500
)
delete from public.audit_logs where id in (select id from expired);
```

Approve the audit-retention period before public deployment.

## Verification and CI

```sh
npm run prisma:validate --workspace @mailmind/api
npm run prisma:generate --workspace @mailmind/api
npm test
npm run typecheck
npm run lint
npm run format:check
npm run build
```

For the guarded repository suite, use only an isolated, migrated database:

```sh
set RUN_DATABASE_INTEGRATION=true
npm run test:database --workspace @mailmind/api
```

CI provisions empty PostgreSQL 16, creates compatibility roles, applies Prisma migrations, verifies
status, runs database/backend/frontend tests, typecheck, lint, formatting, builds, and deterministic
built-server liveness/readiness probes. It has test-only credentials and makes no real Google call.

## Troubleshooting

- Cold pooler timeout: allow the configured timeout and retry after the project resumes.
- Direct endpoint unreachable: use Session Pooler on IPv4-only networks.
- Prepared-statement error on 6543: add `pgbouncer=true` or use Session Pooler.
- Migration permission error: restore the role's DDL permission for the migration window.
- Cookie missing locally: use `COOKIE_SECURE=false` only for HTTP localhost; production requires true.
- Cross-origin rejection: make `WEB_APP_URL` exactly match the browser origin and configure trusted
  proxy hops accurately.

## Release boundary

Required for local Stage 2 completion: migrated isolated database, exact local redirects, mocked
automated tests, encrypted token storage, protected tables, and passing liveness/readiness.

Required before public deployment: HTTPS/secure cookies; production URLs and redirects; OAuth app
verification; real Privacy Policy and Terms; secret-manager and encryption-key rotation; backups and
availability alerts; monitoring/error reporting; shared rate limiting; reviewed pool/proxy limits;
approved cleanup/retention; domain setup; and incident/recovery procedures.

Optional improvement: separate runtime/migration roles and a distributed Google-refresh lock.

Stage 3 now provides metadata-only Gmail synchronization and managed-label initialization; see
[Stage 3 Gmail synchronization](stage-3-gmail-sync.md). AI classification, background jobs/queues,
analytics, billing, and production email organization remain out of scope.
