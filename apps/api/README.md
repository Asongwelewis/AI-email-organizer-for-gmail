# MailMind API authentication testing

Stage 2 implements backend-only Google identity login, opaque MailMind sessions, and a separate incremental Gmail authorization flow. Frontend callback handling belongs to Prompt 4.

## Start and inspect

Copy `.env.example` to `.env`, supply values privately, generate Prisma Client, and start the API:

```sh
npm run prisma:generate --workspace @mailmind/api
npm run dev:api
```

Required configuration names are `NODE_ENV`, `PORT`, `WEB_APP_URL`, `API_BASE_URL`, `DATABASE_URL`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_LOGIN_REDIRECT_URI`, `GOOGLE_GMAIL_REDIRECT_URI`, `SESSION_SECRET`, `TOKEN_ENCRYPTION_KEY`, `TOKEN_ENCRYPTION_KEY_VERSION`, `COOKIE_SECURE`, `COOKIE_DOMAIN`, `COOKIE_SAME_SITE`, `ACCESS_SESSION_TTL_MINUTES`, `REFRESH_SESSION_TTL_DAYS`, `OAUTH_STATE_TTL_MINUTES`, `AUTH_RATE_LIMIT_WINDOW_MINUTES`, `AUTH_RATE_LIMIT_MAX_REQUESTS`, and `LOG_LEVEL`. `DATABASE_URL` must use Supabase's shared session pooler on port 5432 for this long-running API. Prisma uses it for runtime queries and migrations, and the API establishes the connection before accepting requests. Never commit secret values. `TOKEN_ENCRYPTION_KEY` must be a Base64-encoded 32-byte key.

- Health: `http://localhost:4000/api/health`
- Google login: `http://localhost:4000/api/auth/google`
- Gmail connection (after login): `http://localhost:4000/api/integrations/google/connect`
- Current user: `http://localhost:4000/api/auth/me`
- Gmail status: `http://localhost:4000/api/integrations/google/status`

Google Cloud OAuth redirect URIs must exactly match the two configured callback URIs. Login requests only `openid email profile`; Gmail connection separately requests those identity scopes plus `https://www.googleapis.com/auth/gmail.modify` and offline access.

Use browser developer tools to confirm `mailmind_session` is HttpOnly and has the configured Secure/SameSite/domain attributes. Confirm Google codes, state, session values, and Google tokens never appear in redirect URLs after callbacks, local storage, session storage, JSON responses, or logs. API response inspection should show only the safe user and connection status DTOs.

The MVP permits one active Gmail account per MailMind user, including an account different from the login identity. Connecting a different Gmail identity disconnects and clears local credentials for the previous connection without changing the MailMind login identity or session.

## Verification

```sh
npm run prisma:validate --workspace @mailmind/api
npm run prisma:generate --workspace @mailmind/api
npm run typecheck --workspace @mailmind/api
npm run lint --workspace @mailmind/api
npm test --workspace @mailmind/api
npm run build --workspace @mailmind/api
```

Database repository tests are skipped during an ordinary local test run. To enable them, point
`DATABASE_URL` at an isolated, migrated PostgreSQL test database, set
`RUN_DATABASE_INTEGRATION=true`, and run:

```sh
npm run test:database --workspace @mailmind/api
```

Never point this test command at a development, staging, or production database because the suite
clears authentication tables between cases. CI provisions a disposable PostgreSQL service and
applies the existing Supabase authentication migration automatically.

Rate limits use the process-local store in Stage 2. A shared external store is required before horizontally scaled production deployment. Token refresh uses a database expiry compare-and-update: multiple instances may make a redundant Google refresh request, but only one result wins persistence and callers reload the winner.

No Gmail inbox reading, labels, analysis, AI classification, or queue processing is part of Stage 2.
