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

| Name                           | Deployment value or purpose                                                      |
| ------------------------------ | -------------------------------------------------------------------------------- |
| `NODE_ENV`                     | Set to `production`.                                                             |
| `PORT`                         | HTTP port supplied by the backend host; defaults to `4000`.                      |
| `WEB_APP_URL`                  | Public frontend origin, with no path, such as `https://app.example.com`.         |
| `API_BASE_URL`                 | Public backend origin, with no `/api` suffix, such as `https://api.example.com`. |
| `DATABASE_URL`                 | PostgreSQL connection string used by Prisma at runtime and for migrations.       |
| `GOOGLE_CLIENT_ID`             | Google OAuth client ID.                                                          |
| `GOOGLE_CLIENT_SECRET`         | Google OAuth client secret.                                                      |
| `GOOGLE_LOGIN_REDIRECT_URI`    | Absolute URL ending in `/api/auth/google/callback`.                              |
| `GOOGLE_GMAIL_REDIRECT_URI`    | Absolute URL ending in `/api/integrations/google/callback`.                      |
| `SESSION_SECRET`               | Private session secret of at least 16 characters.                                |
| `TOKEN_ENCRYPTION_KEY`         | Private Base64 value that decodes to exactly 32 bytes.                           |
| `TOKEN_ENCRYPTION_KEY_VERSION` | Positive integer identifying the active encryption key, such as `1`.             |
| `COOKIE_SECURE`                | Set to `true` in production.                                                     |

### Backend: optional or defaulted values

These names are supported by the production configuration. Values shown are application defaults
when the variable is omitted, except `COOKIE_DOMAIN` and the two optional external-provider
credentials.

| Name                                     | Default or condition                                                                         |
| ---------------------------------------- | -------------------------------------------------------------------------------------------- |
| `COOKIE_DOMAIN`                          | Optional cookie domain.                                                                      |
| `COOKIE_SAME_SITE`                       | `lax`; allowed values are `lax`, `strict`, and `none`. `none` requires `COOKIE_SECURE=true`. |
| `ACCESS_SESSION_TTL_MINUTES`             | `15`                                                                                         |
| `REFRESH_SESSION_TTL_DAYS`               | `14`                                                                                         |
| `OAUTH_STATE_TTL_MINUTES`                | `10`                                                                                         |
| `AUTH_RATE_LIMIT_WINDOW_MINUTES`         | `10`                                                                                         |
| `AUTH_RATE_LIMIT_MAX_REQUESTS`           | `30`                                                                                         |
| `GMAIL_INITIAL_SYNC_MAX_MESSAGES`        | `250`                                                                                        |
| `GMAIL_SYNC_PAGE_SIZE`                   | `100`                                                                                        |
| `GMAIL_SYNC_BATCH_SIZE`                  | `10`                                                                                         |
| `GMAIL_SYNC_MAX_RETRIES`                 | `3`                                                                                          |
| `GMAIL_SYNC_RETRY_BASE_MS`               | `250`                                                                                        |
| `GMAIL_SYNC_LEASE_SECONDS`               | `300`                                                                                        |
| `AI_CLASSIFIER_ENABLED`                  | `false`                                                                                      |
| `AI_CLASSIFIER_PROVIDER`                 | `disabled`; allowed values are `disabled`, `mock`, and `external`.                           |
| `AI_CLASSIFIER_MODEL`                    | `not-configured`                                                                             |
| `AI_CLASSIFIER_API_KEY`                  | Required only when the external classifier is enabled; keep backend-only.                    |
| `AI_CLASSIFIER_BASE_URL`                 | Required only when the external classifier is enabled.                                       |
| `AI_CLASSIFIER_TIMEOUT_MS`               | `15000`                                                                                      |
| `AI_CLASSIFIER_MAX_RETRIES`              | `2`                                                                                          |
| `AI_CLASSIFIER_BATCH_SIZE`               | `5`                                                                                          |
| `AI_CLASSIFIER_OUTPUT_MAX_TOKENS`        | `400`                                                                                        |
| `AI_CLASSIFICATION_MAX_MESSAGES_PER_RUN` | `20`                                                                                         |
| `AI_CLASSIFICATION_MIN_CONFIDENCE`       | `0.7`                                                                                        |
| `AI_CLASSIFICATION_REVIEW_THRESHOLD`     | `0.65`                                                                                       |
| `AI_CLASSIFICATION_INPUT_MAX_CHARS`      | `4000`                                                                                       |
| `AI_CLASSIFICATION_RULE_THRESHOLD`       | `0.9`                                                                                        |
| `AI_CLASSIFICATION_LEASE_SECONDS`        | `300`                                                                                        |
| `DYNAMIC_LABEL_DISCOVERY_ENABLED`        | `false`                                                                                      |
| `DYNAMIC_LABEL_MIN_MESSAGES`             | `3`                                                                                          |
| `DYNAMIC_LABEL_LOOKBACK_DAYS`            | `90`                                                                                         |
| `DYNAMIC_LABEL_MIN_CONFIDENCE`           | `0.75`                                                                                       |
| `DYNAMIC_LABEL_MIN_CATEGORY_AGREEMENT`   | `0.7`                                                                                        |
| `DYNAMIC_LABEL_MIN_SOURCE_AGREEMENT`     | `0.7`                                                                                        |
| `DYNAMIC_LABEL_MAX_CANDIDATES_PER_RUN`   | `20`                                                                                         |
| `DYNAMIC_LABEL_MAX_MESSAGES_PER_RUN`     | `1000`                                                                                       |
| `DYNAMIC_LABEL_MAX_PENDING_CANDIDATES`   | `50`                                                                                         |
| `DYNAMIC_LABEL_MAX_APPROVED_LABELS`      | `100`                                                                                        |
| `DYNAMIC_LABEL_REDISCOVERY_DAYS`         | `14`                                                                                         |
| `DYNAMIC_LABEL_AI_NAMING_ENABLED`        | `false`                                                                                      |
| `LOG_LEVEL`                              | `info`                                                                                       |
| `TRUST_PROXY_HOPS`                       | `0`; set to the backend host's trusted reverse-proxy hop count when applicable.              |

### Frontend

| Name                | Deployment value or purpose                                                                                                               |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `VITE_API_BASE_URL` | Public backend origin, such as `https://api.mailmindai.tech`. The frontend appends `/api`; this value is embedded at frontend build time. |

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
