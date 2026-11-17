# Deploying the API on Railway

The API runs on Railway as **two services built from the same root
[`Dockerfile`](../Dockerfile)** on every push to `main`. The website stays on Vercel and the
database on Supabase.

| Service                           | Role                                                                                                                                                 | Runs                                                                                                                     |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| **web** (`elegant-harmony` today) | Serves the API to the website                                                                                                                        | Only while someone is using AMO: Serverless is on, so it sleeps when idle and wakes in a few seconds on the next request |
| **cron**                          | Checks every mailbox for new mail and sorts it, starts a waiting first setup, runs the full runs that are due, and does housekeeping every six hours | Every five minutes, for about 10–60 seconds, then exits                                                                  |

Splitting them is what keeps the bill small. A web service that also ran the minute-by-minute
watcher could never sleep, because its own timers kept it busy. Railway bills memory and CPU only
while a container runs, so a sleeping web service plus a short job every five minutes costs a
fraction of one always-on process. The price is that new mail is sorted within about five minutes
instead of one.

## What the repository provides

- **`Dockerfile`.** Railway always builds a root Dockerfile when one exists. The build stage
  installs everything (the compiler, Prisma's CLI and Sentry's CLI are devDependencies), generates
  the Prisma client, and compiles `@mailmind/shared` and the API. The runtime stage keeps production
  dependencies, the compiled API and `prisma/`.
- **`AMO_PROCESS`.** `apps/api/src/index.ts` starts the web server, or, with
  `AMO_PROCESS=automation-job`, runs one automation pass (`src/jobs/automation-job.ts`) and exits.
  One image, two roles.
- **`AUTOMATION_RUN_IN_PROCESS=false`.** The web service then starts no scheduler, heartbeat or
  housekeeping timer, so it has nothing to do while idle.
- **`SIGN_IN_ALLOWED_EMAILS`.** Makes the deployment private (`src/auth/sign-in-policy.ts`): every
  other Google account is refused at sign-in and on every request of a session it already holds.
- **Migrations.** Pending migrations apply at boot of either service (`src/database/migrations.ts`),
  so no pre-deploy step is needed.

Railway sets `PORT`, and the web service listens on it. The release id is
`mailmind@<RAILWAY_GIT_COMMIT_SHA>`, the same at build and at runtime, so Sentry source maps match the
running code.

## Variables

Both services need the shared configuration. See [backend.md](backend.md) for every variable.

- **Secrets:** `DATABASE_URL`, `SESSION_SECRET`, `TOKEN_ENCRYPTION_KEY`,
  `TOKEN_ENCRYPTION_KEY_VERSION`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and `GEMINI_API_KEY`.
  Add `WEB_PUSH_VAPID_PUBLIC_KEY`, `WEB_PUSH_VAPID_PRIVATE_KEY` and `WEB_PUSH_SUBJECT` for device
  notifications.
- **URLs:** `API_BASE_URL=https://api.mailmindai.tech`, `WEB_APP_URL=https://www.mailmindai.tech`,
  and the two Google redirect URIs on `api.mailmindai.tech`.
- **Cookies and proxy:** `COOKIE_SECURE=true`, `COOKIE_SAME_SITE=none`, `TRUST_PROXY_HOPS=1`.
- **Owner and access:** `OWNER_ACCOUNT_EMAILS`, `SIGN_IN_ALLOWED_EMAILS` (the owner's address makes
  the server private) and `BETA_MAX_MAILBOXES=0` (no new mailboxes).
- **Sentry:** `SENTRY_DSN`, `SENTRY_AUTH_TOKEN`, `SENTRY_ORG`, `SENTRY_PROJECT`,
  `SENTRY_ENVIRONMENT=production`, `SENTRY_TRACES_SAMPLE_RATE=0.1`, then
  `SENTRY_REQUIRE_CONFIG=true` so a build without them fails instead of shipping unsymbolicated.

Each service also gets its own variables:

- **web:** `AUTOMATION_RUN_IN_PROCESS=false` and `AUTOMATION_CHECK_INTERVAL_SECONDS=300`. The
  second is what the Activity screen says checks happen every.
- **cron:** `AMO_PROCESS=automation-job`.

## One-time setup

1. **Web service.** New Project → Deploy from GitHub repo → `AI-email-organizer-for-gmail`. Leave
   the root directory empty, and put the service in an EU region next to Supabase (`eu-central-1`).
   Then in **Settings**:
   - **Deploy:** Healthcheck Path `/ready`, restart policy "On failure", and **Serverless on**.
   - **Source:** branch `main`, **Wait for CI** on, and Watch Paths `apps/api/**`,
     `packages/shared/**`, `package.json`, `package-lock.json`, `Dockerfile`, `scripts/**`.
2. **Cron service.** + New → GitHub Repo → the same repository, same EU region. Give it the
   variables above, then in **Settings**:
   - **Cron Schedule:** `*/5 * * * *`.
   - **Restart policy:** "Never". A run that fails waits for the next schedule instead of looping.
   - **Serverless off**, no healthcheck, no domain.
   - **Source:** the same branch, Wait for CI and Watch Paths.

   Railway does not start a run while the previous one is still going, and every long step holds a
   database lease, so a slow full run is never doubled.

3. **Check it.** On the web service's Railway domain (Networking → Generate Domain), `/ready` must
   answer `200` with `dependencies.schema` `current`. Each cron run's log ends with
   `automation job finished`.
4. **Move the domain.** Web service → Settings → Networking → **Custom Domain** →
   `api.mailmindai.tech`. Railway shows a CNAME and a TXT record. Create **both** at the DNS host for
   `mailmindai.tech`: the domain does not verify with the CNAME alone. The certificate is issued
   within about an hour of the DNS resolving. Nothing else changes, because the address stays the
   same.

A custom domain needs the Trial or a paid plan. On a plan without one, set `API_BASE_URL`, both
Google redirect URIs (in the Google Cloud console too) and Vercel's `VITE_API_BASE_URL` to the
`up.railway.app` address, and allow that host in `vercel.json`'s `connect-src` and `img-src`.

## After it is live

- Every push to `main` that touches the API rebuilds both services. The web service keeps serving
  the previous version until `/ready` answers on the new one.
- Roll back from a service's Deployments tab (⋮ on an earlier deployment → Redeploy).
- Usage is billed on memory, CPU and outbound data while a container runs. The web service uses
  about 130 MB awake. Check usage under Project → Usage. An always-on API sent about 30 MB an hour in
  November 2026; the job model sends far less, because nothing runs between passes.
