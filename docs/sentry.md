# Sentry operations

MailMind uses one immutable release string for the React frontend and Express API. Production
deployments derive it as `mailmind@<git-commit-sha>` from `VERCEL_GIT_COMMIT_SHA` or
`RENDER_GIT_COMMIT`. `scripts/with-app-version.mjs` exports that exact value as `APP_VERSION`,
`VITE_APP_VERSION`, and `SENTRY_RELEASE` before the build command runs. An explicitly configured
value is also supported, but the three names must match.

The public DSN may be shared by both apps so browser-to-API traces appear in the same Sentry
project. If separate Sentry projects are used, keep the release string identical in both services
and configure each service's own DSN/project slug.

## Data handling

MailMind does not send Sentry request or response bodies, headers, cookies, query strings, IP/user
data, stack-frame variables, database values, GraphQL data, or AI inputs/outputs. Event processors
also:

- remove user and arbitrary extra context;
- retain only safe runtime/trace contexts;
- strip URL query strings and collapse sensitive Gmail/OAuth workflow paths before dynamic
  identifiers can be sent;
- drop breadcrumb text plus console and database breadcrumbs;
- retain only allow-listed HTTP performance attributes and custom tags; and
- replace runtime exception messages with generic text while retaining stack frames for
  symbolication.

Do not add Gmail subjects, snippets, sender addresses, OAuth codes/states, Google tokens, session
identifiers, request bodies, or authorization headers to Sentry tags, messages, breadcrumbs, or
custom context. Keep Sentry's server-side data scrubbing enabled as a second layer.

The SDKs do not initialize when their DSN is blank. Local and CI builds may therefore run without
Sentry. Hosted production builds set `SENTRY_REQUIRE_CONFIG=true`; those builds fail instead of
silently deploying without the DSN or source-map credentials.

## Required Sentry values

| Name                        | Scope                | Purpose                                                             |
| --------------------------- | -------------------- | ------------------------------------------------------------------- |
| `VITE_SENTRY_DSN`           | Vercel build/browser | Public React SDK DSN.                                               |
| `SENTRY_DSN`                | Render build/runtime | Express SDK DSN. It may be the same public DSN.                     |
| `SENTRY_AUTH_TOKEN`         | Build only, secret   | Uploads frontend and API source maps. Never prefix it with `VITE_`. |
| `SENTRY_ORG`                | Build only           | Sentry organization slug.                                           |
| `SENTRY_PROJECT`            | Build only           | Sentry project slug receiving the release artifacts.                |
| `SENTRY_ENVIRONMENT`        | Render runtime       | Normally `production`; defaults to `NODE_ENV`.                      |
| `SENTRY_TRACES_SAMPLE_RATE` | Render runtime       | `0.1` in the supplied production configuration.                     |

Create a Sentry organization/project auth token authorized to upload release artifacts for the
selected project. Store the token only in Vercel and Render secret storage. Never commit it or put it
in any `VITE_` variable.

## Vercel frontend

The repository-level `vercel.json` uses this production build command:

```text
npm exec cross-env SENTRY_REQUIRE_CONFIG=true node scripts/with-app-version.mjs npm run build --workspace @mailmind/web
```

The wrapper converts Vercel's `VERCEL_GIT_COMMIT_SHA` into `VITE_APP_VERSION` before Vite runs. Add
these values to the Vercel project for Production and Preview as appropriate:

- `VITE_API_BASE_URL`
- `VITE_SENTRY_DSN`
- `SENTRY_AUTH_TOKEN` (Sensitive)
- `SENTRY_ORG`
- `SENTRY_PROJECT`

Do not statically set `VITE_APP_VERSION` on Vercel unless there is a deliberate external release
orchestrator. The build wrapper supplies the commit-specific value. If it is set manually, it must
equal Render's `APP_VERSION`/`SENTRY_RELEASE`.

After saving environment variables, redeploy. A successful log contains:

```text
[sentry] shared release: mailmind@<commit-sha>
```

and Sentry Vite plugin upload output. A missing/partial setup fails with a named variable instead of
creating an uninstrumented production deployment. The plugin generates hidden source maps, uploads
them under the shared release, then deletes `apps/web/dist/**/*.map` before Vercel deploys the
artifact.

The Vercel project audited on 2026-07-28 (`ai-email-organizer-for-gmail-web`) successfully built
commit `cf6580a`, but its build log contained no Sentry upload output. Treat that deployment as
unsymbolicated and redeploy only after the five values above are present.

## Render API

`render.yaml` is the reproducible Blueprint configuration. Its build command generates Prisma,
injects the shared release from `RENDER_GIT_COMMIT`, compiles TypeScript with source maps, injects
Sentry debug IDs, uploads the maps, and removes map files from the deploy artifact. The start command
preloads `dist/instrument.js` before Express, Prisma, Google clients, or other application modules.

For a new Blueprint, Render prompts for every `sync: false` value. Supply all existing application
secrets plus:

- `SENTRY_DSN`
- `SENTRY_AUTH_TOKEN`
- `SENTRY_ORG`
- `SENTRY_PROJECT`

For an existing Render service, set the same variables in the dashboard and use the build,
pre-deploy, and start commands from `render.yaml`. Keep `SENTRY_REQUIRE_CONFIG=true`,
`SENTRY_ENVIRONMENT=production`, and `SENTRY_TRACES_SAMPLE_RATE=0.1`.

The API derives `APP_VERSION` and `SENTRY_RELEASE` from `RENDER_GIT_COMMIT` at both build and runtime.
If an external release process sets either variable explicitly, set both to the same value and use
the exact same `VITE_APP_VERSION` for Vercel.

## Verification

Before merging:

```powershell
npm run typecheck
npm test
npm run build
```

Test source-map guardrails without real upload credentials:

```powershell
$env:SENTRY_ORG = 'partial-config-test'
npm run build --workspace @mailmind/web
Remove-Item Env:SENTRY_ORG
```

The build must fail and name the missing `SENTRY_AUTH_TOKEN` and `SENTRY_PROJECT`.

For an end-to-end event check, add short-lived error/message triggers to the real frontend and API,
run the normal applications, and capture a unique timestamped marker. Confirm the issue and trace in
Sentry, verify the event contains the same `mailmind@<version>` release, inspect that original
TypeScript/TSX file names and line numbers are shown, and confirm Gmail/OAuth values are absent.
Remove the triggers before committing.

Sentry's authenticated event-query integration is required to automate the final dashboard
confirmation. A successful SDK transport response proves delivery but does not by itself prove
symbolication; inspect the received issue after the production source-map upload.

## What is reported, and what is not

A 5xx is the right shape for "this request could not be served", but it does not by itself mean
something went wrong. A feature the operator turned off answers `503` on purpose, on a path that
expects it, and the screen already shows the code so a person can act on it.

`shouldReportToSentry` therefore reads the error **code**, not only the status. The codes in
`CONFIGURATION_REFUSALS` — `AUTOMATION_DISABLED`, `AUTOMATION_NOT_CONFIGURED`,
`CLASSIFICATION_DISABLED`, `LABEL_DISCOVERY_DISABLED`, `PROVIDER_NOT_CONFIGURED` and
`GMAIL_WRITE_DISABLED` — are never reported. Without that, every click of a button belonging to a
disabled feature files a fresh issue, and since `GMAIL_WRITE_ENABLED` is off by default the Gmail
export buttons would do it on every press.

Provider failures are deliberately **not** in that set. `PROVIDER_UNAVAILABLE` is also a 503, but it
means Gemini broke, which is exactly the kind of thing Sentry is for. Filtering on status alone
cannot tell those two apart.
