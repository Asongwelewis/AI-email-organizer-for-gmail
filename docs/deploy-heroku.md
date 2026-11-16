# Moving the API to Heroku

The API runs on Render's free plan, which sleeps after 15 idle minutes, so new mail waits for the
next wake-up (every three hours, see `.github/workflows/wake-api.yml`). Heroku's GitHub Student
offer pays $13 a month for 24 months. That covers a **Basic** dyno ($7/month), which is always on,
so mail can be sorted within a minute again. The website stays on Vercel and the database stays on
Supabase; only the API moves.

**Do not deploy before the student credits show on the account.** Heroku has no free plan: a dyno
started earlier bills the card on file from its first minute, and credits that arrive later do not
refund it. Avoid **Eco** dynos ($5/month): they sleep after 30 minutes, exactly like Render.

## What the repository already provides

| File                                         | What Heroku does with it                                                                                                                                        |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `package.json` → `engines.node` (`>=22 <25`) | Picks the newest Node 24. Without a pin, Heroku would follow the latest LTS, which may be an untested release                                                   |
| `package.json` → `heroku-postbuild`          | Generates the Prisma client and runs `build:api`, which uploads source maps to Sentry. This runs instead of `npm run build`, so the website is never built here |
| `Procfile` → `release`                       | Runs `prisma migrate deploy` before each version takes traffic, so a deploy whose migration fails never goes live                                               |
| `Procfile` → `web`                           | Starts the compiled API. Heroku sets `PORT`, and the API already listens on it                                                                                  |
| `.slugignore`                                | Leaves documentation, end-to-end tests, the flat Supabase migration copies and the intro videos out of the slug                                                 |

After the build, Heroku removes development dependencies. `prisma` and `@prisma/client` survive
that (npm treats them as production), so the release step and the boot-time migration check still
work.

## Going live

All commands run from the repository root with the Heroku CLI (`npm install -g heroku`), after
`heroku login`.

1. **Claim the credits.** Open https://www.heroku.com/github-students. Confirm the $13 credit shows
   under Account → Billing before going further.
2. **Create the app in the EU region**, next to Supabase (`eu-central-1`):
   ```bash
   heroku create amo-api --region eu
   heroku buildpacks:set heroku/nodejs -a amo-api
   ```
   If `amo-api` is taken, pick another name and use it in every command below.
3. **Copy the configuration from Render.** Every variable on the Render service's Environment tab
   carries over unchanged, including:
   - the URLs: `API_BASE_URL`, `WEB_APP_URL` and both Google redirect URIs;
   - the secrets: `DATABASE_URL`, `SESSION_SECRET`, `TOKEN_ENCRYPTION_KEY(_VERSION)`,
     `GOOGLE_CLIENT_ID/SECRET`, `GEMINI_API_KEY`, `WEB_PUSH_VAPID_*`, `SENTRY_*`;
   - `OWNER_ACCOUNT_EMAILS`, plus any limits that were tuned.

   The URLs stay valid because the API keeps the `api.mailmindai.tech` domain. Set them in one
   command from a local file that is never committed:

   ```bash
   heroku config:set -a amo-api $(grep -v '^#' .env.heroku | xargs)
   ```

   Make sure these values are set:
   - `NODE_ENV=production`. Heroku sets it by default; it makes the app count as deployed and turns
     on the startup cookie checks.
   - `COOKIE_SECURE=true` and `COOKIE_SAME_SITE=none`. The site and the API are on different
     hosts.
   - `TRUST_PROXY_HOPS=1`. Heroku's router is one hop.
   - `SENTRY_REQUIRE_CONFIG=true` and `SENTRY_ENVIRONMENT=production`.
   - `KEEP_AWAKE_INTERVAL_MINUTES=0`. A Basic dyno never sleeps, so the self-ping has nothing to do.

4. **Deploy from GitHub.** In the Heroku dashboard, go to Deploy → GitHub and connect the
   repository. Turn on **automatic deploys from `main`** with **"Wait for CI to pass"**. Then click
   **Deploy Branch** once for the first build, or push directly:
   ```bash
   git push https://git.heroku.com/amo-api.git main
   ```
5. **Run one always-on dyno:**
   ```bash
   heroku ps:type web=basic -a amo-api
   heroku ps:scale web=1 -a amo-api
   ```
6. **Check it before moving any traffic.** The `herokuapp.com` address works straight away:
   ```bash
   curl https://amo-api-<id>.herokuapp.com/ready   # dependencies.schema must be "current"
   heroku logs --tail -a amo-api                   # "AMO API is ready", then the scheduler
   ```
7. **Move the domain:**
   ```bash
   heroku domains:add api.mailmindai.tech -a amo-api   # prints a DNS target
   heroku certs:auto:enable -a amo-api
   ```
   At the DNS host for `mailmindai.tech`, change the `api` CNAME from Render to the printed target.
   Once it resolves, `https://api.mailmindai.tech/ready` answers from Heroku. Sessions, cookies and
   the Google sign-in settings are unaffected, because the domain did not change.
8. **Return to minute-by-minute sorting.** In one change:
   - put back the "within a minute or two" wording that was softened when the API began sleeping;
   - restore the "Mail is sorted as it arrives" paragraph in `CLAUDE.md`;
   - set `wake-api.yml` back to a health check only, or remove it.
9. **Retire Render** after a day without errors: suspend the Render service, and keep it until
   you are confident, since it is the rollback.

## Rollback

Point the `api` CNAME back at Render and resume the Render service. Both deployments share the
same database and the same domain, so nothing else changes.

## Cost guardrails

- One Basic dyno ($7) is the only paid resource. It sits inside the $13 credit, and unused credit
  does not roll over.
- Do not add Heroku Postgres or add-ons. Supabase stays the database.
- The credit ends after 24 months. Before then, decide what the API runs on next.
