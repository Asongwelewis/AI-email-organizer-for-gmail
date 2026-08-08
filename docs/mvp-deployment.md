# MVP deployment

Run every command in this document from the repository root.

## Deployment values

| Setting                   | Exact value                                                   |
| ------------------------- | ------------------------------------------------------------- |
| Install command           | `npm ci`                                                      |
| Backend build command     | `npm run build --workspace @mailmind/api`                     |
| Backend start command     | `npm run start --workspace=apps/api`                          |
| Frontend build command    | `npm run build --workspace @mailmind/web`                     |
| Frontend output directory | `apps/web/dist`                                               |
| Migration command         | `npm exec --workspace @mailmind/api -- prisma migrate deploy` |

Apply the migration before starting a newly deployed backend. The migration command reads
`DATABASE_URL` and applies the ordered migrations in `apps/api/prisma/migrations`. The matching SQL
copies in `supabase/migrations` are retained for Supabase tooling; do not run both migration paths
against the same deployment.

The frontend output is a static single-page application. Configure its host to serve
`apps/web/dist` and rewrite unknown frontend routes to `index.html`.

## Environment-variable names

### Backend: required deployment values

| Name                           | Deployment value or purpose                                                                   |
| ------------------------------ | --------------------------------------------------------------------------------------------- |
| `NODE_ENV`                     | Set to `production`.                                                                          |
| `PORT`                         | HTTP port supplied by the backend host; defaults to `4000`.                                   |
| `WEB_APP_URL`                  | Primary public frontend origin used for OAuth redirects.                                      |
| `API_BASE_URL`                 | Public backend origin, with no `/api` suffix, such as `https://api.example.com`.              |
| `DATABASE_URL`                 | PostgreSQL connection string used by Prisma at runtime and for migrations.                    |
| `GOOGLE_CLIENT_ID`             | Google OAuth client ID.                                                                       |
| `GOOGLE_CLIENT_SECRET`         | Google OAuth client secret.                                                                   |
| `GOOGLE_LOGIN_REDIRECT_URI`    | Absolute URL ending in `/api/auth/google/callback`.                                           |
| `GOOGLE_GMAIL_REDIRECT_URI`    | Absolute URL ending in `/api/integrations/google/callback`.                                   |
| `SESSION_SECRET`               | Private session secret of at least 16 characters.                                             |
| `TOKEN_ENCRYPTION_KEY`         | Private Base64 value that decodes to exactly 32 bytes.                                        |
| `TOKEN_ENCRYPTION_KEY_VERSION` | Positive integer identifying the active encryption key, such as `1`.                          |
| `COOKIE_SECURE`                | Set to `true` in production. Production cookies are always secure.                            |
| `SENTRY_DSN`                   | Public DSN for backend errors and traces. Leave empty only outside guarded production builds. |

### Backend: optional or defaulted values

These names are supported by the production configuration. Values shown are application defaults
when the variable is omitted, except `COOKIE_DOMAIN` and the two optional external-provider
credentials.

| Name                                   | Default or condition                                                                       |
| -------------------------------------- | ------------------------------------------------------------------------------------------ |
| `COOKIE_DOMAIN`                        | Optional cookie domain.                                                                    |
| `COOKIE_SAME_SITE`                     | `lax` outside production. Production session cookies use `none` for cross-origin requests. |
| `ACCESS_SESSION_TTL_MINUTES`           | `15`                                                                                       |
| `REFRESH_SESSION_TTL_DAYS`             | `14`                                                                                       |
| `OAUTH_STATE_TTL_MINUTES`              | `10`                                                                                       |
| `AUTH_RATE_LIMIT_WINDOW_MINUTES`       | `10`                                                                                       |
| `AUTH_RATE_LIMIT_MAX_REQUESTS`         | `30`                                                                                       |
| `GMAIL_SYNC_PAGE_SIZE`                 | `100`                                                                                      |
| `GMAIL_SYNC_BATCH_SIZE`                | `10`                                                                                       |
| `GMAIL_SYNC_MAX_RETRIES`               | `3`                                                                                        |
| `GMAIL_SYNC_RETRY_BASE_MS`             | `250`                                                                                      |
| `GMAIL_SYNC_LEASE_SECONDS`             | `300`                                                                                      |
| `DYNAMIC_LABEL_DISCOVERY_ENABLED`      | `true`                                                                                     |
| `DYNAMIC_LABEL_MIN_MESSAGES`           | `3`                                                                                        |
| `DYNAMIC_LABEL_LOOKBACK_DAYS`          | `90`                                                                                       |
| `DYNAMIC_LABEL_MIN_CONFIDENCE`         | `0.75`                                                                                     |
| `DYNAMIC_LABEL_MIN_CATEGORY_AGREEMENT` | `0.7`                                                                                      |
| `DYNAMIC_LABEL_MIN_SOURCE_AGREEMENT`   | `0.7`                                                                                      |
| `DYNAMIC_LABEL_MAX_CANDIDATES_PER_RUN` | `20`                                                                                       |
| `DYNAMIC_LABEL_MAX_MESSAGES_PER_RUN`   | `1000`                                                                                     |
| `DYNAMIC_LABEL_MAX_PENDING_CANDIDATES` | `50`                                                                                       |
| `DYNAMIC_LABEL_MAX_APPROVED_LABELS`    | `100`                                                                                      |
| `DYNAMIC_LABEL_REDISCOVERY_DAYS`       | `14`                                                                                       |
| `DYNAMIC_LABEL_AI_NAMING_ENABLED`      | `false`                                                                                    |
| `LOG_LEVEL`                            | `info`                                                                                     |
| `TRUST_PROXY_HOPS`                     | `0`; set to the backend host's trusted reverse-proxy hop count when applicable.            |
| `APP_VERSION`                          | Shared immutable release. Render derives `mailmind@<RENDER_GIT_COMMIT>` when omitted.      |
| `SENTRY_ENVIRONMENT`                   | Defaults to `NODE_ENV`. Use `production` on Render.                                        |
| `SENTRY_TRACES_SAMPLE_RATE`            | `1` outside production and `0.1` in production when omitted by the preloader.              |
| `SENTRY_DEBUG`                         | `false`; enable only while diagnosing SDK transport.                                       |

### Frontend

| Name                | Deployment value or purpose                                                                                                               |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `VITE_API_BASE_URL` | Public backend origin, such as `https://api.mailmindai.tech`. The frontend appends `/api`; this value is embedded at frontend build time. |
| `VITE_SENTRY_DSN`   | Public DSN for the Sentry React project. Leave empty to disable the SDK.                                                                  |
| `VITE_APP_VERSION`  | Immutable release identifier shared by both SDKs and source-map uploads, such as `mailmind@<commit-sha>`.                                 |
| `SENTRY_ORG`        | Sentry organization slug used only by the Vite source-map upload plugin.                                                                  |
| `SENTRY_PROJECT`    | Sentry project slug used only by the Vite source-map upload plugin.                                                                       |
| `SENTRY_AUTH_TOKEN` | Secret build token used to upload source maps. Never expose it with a `VITE_` prefix.                                                     |

Set all three `SENTRY_*` build values together. When they are present, the production build creates
hidden source maps, uploads them to the matching Sentry release, and removes the map files from
`apps/web/dist` before deployment.

The Vercel and Render production commands set `SENTRY_REQUIRE_CONFIG=true`, so a missing DSN or
partial upload configuration fails before deployment. Both builds derive `mailmind@<commit-sha>`
from their host-provided Git commit value. The API build also uploads TypeScript source maps and
removes them from its deploy artifact. See [Sentry operations](sentry.md) for exact dashboard values,
commands, privacy controls, and verification.

## Callback paths

Register these two exact authorized redirect URLs in the Google Cloud OAuth client, using the
public backend origin:

```text
https://<backend-origin>/api/auth/google/callback
https://<backend-origin>/api/integrations/google/callback
```

Set the corresponding backend values:

```text
GOOGLE_LOGIN_REDIRECT_URI=https://<backend-origin>/api/auth/google/callback
GOOGLE_GMAIL_REDIRECT_URI=https://<backend-origin>/api/integrations/google/callback
```

The frontend post-OAuth route is `/auth/callback`. It is an application route, not a Google
authorized redirect URI. The static host's SPA fallback must therefore cover `/auth/callback`.
