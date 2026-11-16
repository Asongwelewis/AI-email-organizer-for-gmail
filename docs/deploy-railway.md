# Deploying the API on Railway

The API runs on Railway as one always-on service, built from the root [`Dockerfile`](../Dockerfile)
on every push to `main`. The website stays on Vercel and the database on Supabase; only the API is
on Railway.

## What the repository provides

| File                                  | What Railway does with it                                                                                                                                                                                                                                                                                                 |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Dockerfile`                          | Railway always builds a root Dockerfile when one exists. The build stage installs everything (the compiler, Prisma's CLI and Sentry's CLI are devDependencies), generates the Prisma client and compiles `@mailmind/shared` and the API. The runtime stage keeps production dependencies, the compiled API, and `prisma/` |
| `.dockerignore`                       | Keeps `node_modules`, builds, docs, tests, the intro videos and every `.env` file out of the build context                                                                                                                                                                                                                |
| `apps/api/src/database/migrations.ts` | Runs `prisma migrate deploy` at boot when a shipped migration is missing, so no pre-deploy step is needed                                                                                                                                                                                                                 |
| `env.IS_DEPLOYED`                     | True with `NODE_ENV=production` (set by the Dockerfile) or when Railway's `RAILWAY_ENVIRONMENT_NAME` is present                                                                                                                                                                                                           |

Railway sets `PORT`; the API listens on it. The release id is `mailmind@<RAILWAY_GIT_COMMIT_SHA>`,
the same at build and at runtime, so Sentry source maps match the running code.

## One-time setup

1. **Create the service.** In Railway: New Project → Deploy from GitHub repo → choose
   `AI-email-organizer-for-gmail`. Leave the root directory empty, so the repository root and its
   `Dockerfile` are used. Put the service in an EU region, next to Supabase (`eu-central-1`).
2. **Copy the variables.** Settings → Variables → Raw Editor. Paste the API's environment (see
   [backend.md](backend.md) for every variable):
   - the URLs: `API_BASE_URL`, `WEB_APP_URL`, `GOOGLE_LOGIN_REDIRECT_URI`,
     `GOOGLE_GMAIL_REDIRECT_URI`;
   - the secrets: `DATABASE_URL`, `SESSION_SECRET`, `TOKEN_ENCRYPTION_KEY`,
     `TOKEN_ENCRYPTION_KEY_VERSION`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GEMINI_API_KEY`,
     `WEB_PUSH_VAPID_PUBLIC_KEY`, `WEB_PUSH_VAPID_PRIVATE_KEY`, `WEB_PUSH_SUBJECT`;
   - `OWNER_ACCOUNT_EMAILS`, plus any limits that were tuned;
   - `COOKIE_SECURE=true`, `COOKIE_SAME_SITE=none`, `TRUST_PROXY_HOPS=1`;
   - for Sentry: `SENTRY_DSN`, `SENTRY_AUTH_TOKEN`, `SENTRY_ORG`, `SENTRY_PROJECT`,
     `SENTRY_ENVIRONMENT=production`, `SENTRY_TRACES_SAMPLE_RATE=0.1`. Then add
     `SENTRY_REQUIRE_CONFIG=true` so a build without them fails instead of shipping unsymbolicated.
3. **Deploy settings.** Settings → Deploy:
   - **Healthcheck Path** `/ready`. It answers only once the database is reachable and the schema is
     current, so a deploy whose migration did not apply never takes traffic.
   - **Restart policy** "On failure".
   - **Serverless / App Sleeping** off. Mail is sorted as it arrives only while the process runs.
4. **Automatic deploys.** Settings → Source:
   - **Branch** `main`.
   - Turn on **Wait for CI**, so a commit deploys only after GitHub Actions passes.
   - Add **Watch Paths** so documentation and web-only commits do not rebuild the API:
     `apps/api/**`, `packages/shared/**`, `package.json`, `package-lock.json`, `Dockerfile`,
     `scripts/**`.
5. **Check the first deploy** on its Railway domain (Settings → Networking → Generate Domain).
   `https://<service>.up.railway.app/ready` must answer `200` with `dependencies.schema` `current`.
   The deploy log should show `AMO API is ready`, then `automation scheduler started`.
6. **Move the domain.** Settings → Networking → **Custom Domain** → `api.mailmindai.tech`. Railway
   shows a CNAME and a TXT record. Create **both** at the DNS host for `mailmindai.tech`: the domain
   does not verify with the CNAME alone. The certificate is issued within about an hour of the DNS
   resolving. The URLs, the Google sign-in settings and Vercel's `VITE_API_BASE_URL` stay as they are,
   because the domain does not change.

A custom domain needs the Trial or a paid plan. On a plan without one, set `API_BASE_URL`, both
Google redirect URIs (in the Google Cloud console too) and Vercel's `VITE_API_BASE_URL` to the
`up.railway.app` address, and allow that host in `vercel.json`'s `connect-src` and `img-src`.

## After it is live

- Every push to `main` that touches the API deploys by itself. The previous version keeps serving
  until `/ready` answers on the new one.
- Roll back from the Deployments tab (⋮ on an earlier deployment → Redeploy).
- Usage is billed on memory, CPU and outbound data. The API idles at about 250–300 MB. Keep an eye
  on egress: in November 2026 the API sent about 30 MB an hour while idle, which is worth
  reducing.
