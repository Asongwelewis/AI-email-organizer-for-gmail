# Frontend documentation

## Overview

The MailMind web application is a React 19, TypeScript, and Vite single-page application in
`apps/web`. React Router owns navigation, TanStack Query owns server state, Axios provides the
credentialed API client, Motion provides transitions, Sonner provides notifications, and
Tailwind CSS 4 is integrated through Vite.

The browser contains no Google client secret, Gmail token, session secret, database credential, or
classifier key. Its browser-visible environment settings are limited to the public API URL, public
Sentry DSN, and release identifier.

## Workspace and commands

From the repository root:

```powershell
npm ci
Copy-Item apps/web/.env.example apps/web/.env
npm run dev:web
```

| Purpose                  | Command                                       |
| ------------------------ | --------------------------------------------- |
| Development server       | `npm run dev --workspace @mailmind/web`       |
| Type-check               | `npm run typecheck --workspace @mailmind/web` |
| Tests                    | `npm test --workspace @mailmind/web`          |
| Lint app source          | `npm run lint --workspace @mailmind/web`      |
| Production build         | `npm run build --workspace @mailmind/web`     |
| Preview production build | `npm run preview --workspace @mailmind/web`   |

The production output directory is `apps/web/dist`.

## Environment and API client

`VITE_API_BASE_URL` is the public backend origin, for example `https://api.mailmindai.tech`. The
frontend appends `/api`. `VITE_SENTRY_DSN` enables browser error and performance reporting, while
`VITE_APP_VERSION` identifies the release attached to those events. Because all `VITE_` values are
embedded into the browser bundle, none of them may contain a secret. The Sentry SDK remains disabled
when `VITE_SENTRY_DSN` is empty.

`src/config/env.ts` requires the value at build time, removes trailing slashes, and appends `/api`.
`src/services/http.ts` uses the result as the Axios `baseURL`. A missing value stops the frontend
with `VITE_API_BASE_URL is not configured` instead of silently using the wrong backend.

`src/instrument.ts` initializes Sentry before the application, samples all development traces and
10% of production traces, propagates trace headers to the configured API origin, and does not send
default PII. React 19 root hooks and the React Router error boundary capture render and route errors.

Production source-map upload is enabled only when `SENTRY_AUTH_TOKEN`, `SENTRY_ORG`, and
`SENTRY_PROJECT` are present in the build environment. The auth token is a build secret and must
never use a `VITE_` prefix. Partial upload configuration fails the build. Hosted production builds
also require the public DSN and release. Uploaded maps are removed from `dist` before deployment.
See [Sentry operations](sentry.md) for the Vercel/Render release and verification procedure.

Both the normal client and the refresh client set `withCredentials: true`. On a 401 response, the
normal client attempts one shared session refresh, retries the original request once, and clears
local authentication state when refresh fails. Refresh calls are kept out of the interceptor loop.

OAuth starts by navigating the browser to backend endpoints rather than handling Google OAuth in
the SPA:

- Login: `/api/auth/google?redirect=/auth/callback`
- Optional Gmail connection: `/api/integrations/google/connect?redirect=/auth/callback`

The backend validates the redirect path, owns OAuth state and PKCE, receives the callback, sets the
HttpOnly session cookie, and redirects back to the frontend.

## Application composition

`src/main.tsx` creates the shared TanStack Query client. `src/App.tsx` composes:

1. Motion reduced-motion support.
2. `AuthProvider`.
3. React Router.
4. The service-worker update prompt and toast region.

The query client disables automatic retries and refetch-on-window-focus by default. Individual
feature hooks add polling only while a Gmail sync or automation run is active.

### Directory guide

| Location         | Responsibility                                                    |
| ---------------- | ----------------------------------------------------------------- |
| `src/router`     | Public and protected route definitions                            |
| `src/pages`      | Route-level screens                                               |
| `src/layouts`    | Public layout and authenticated application shell                 |
| `src/components` | Shared visual, navigation, dialog, and route-guard components     |
| `src/context`    | Authentication and Gmail connection orchestration                 |
| `src/services`   | Axios client and user-facing API error translation                |
| `src/queries`    | TanStack Query keys, reads, mutations, invalidation, and polling  |
| `src/types`      | API response and feature taxonomy types                           |
| `src/lib`        | Folder colour hashing, Gmail deep links, and display formatting   |
| `src/styles`     | `index.css` for the public pages, `app.css` for the three screens |
| `src/test`       | Vitest and Testing Library setup                                  |

## Routes

### Public routes

| Route            | Screen                                                   |
| ---------------- | -------------------------------------------------------- |
| `/`              | Product landing page                                     |
| `/login`         | Google identity login                                    |
| `/auth/callback` | Handles safe status values after backend OAuth redirects |
| `/privacy`       | Current privacy-policy placeholder page                  |
| `/terms`         | Current terms-of-service placeholder page                |

Unknown routes redirect to `/`.

### Protected routes

Three screens, and only three. Everything you _watch_ happen was removed; what remains are the
screens where a decision gets made. All of them render inside `ProtectedRoute` and `AppShell`:

| Route       | Purpose                                                                    |
| ----------- | -------------------------------------------------------------------------- |
| `/sorted`   | The approved folder tree as tiles; drill in and open a message in Gmail    |
| `/approve`  | Review a proposed folder tree and approve what you keep                    |
| `/activity` | Run records, newest first, with state, progress, stop reasons, error codes |

`/dashboard/*` and `/settings/*` redirect to `/sorted`, `/labels` to `/approve`, and `/automation`
to `/activity`. Unknown routes redirect to `/`.

`AppShell` is one layout with one breakpoint at 768px: a bottom tab bar and a two-column tile grid
below it, a left nav rail and a four-column grid inside a max-width column above it. A phone layout
stretched across a desktop is the failure mode this avoids.

The signed-in app is deliberately plain — no gradients, no shadows, no decorative motion. Depth
comes from hairlines and tint. Fraunces sets the app name and every numeral, Manrope sets UI text,
DM Mono sets timestamps and codes, at weights 400 and 500 only. The editorial treatment stays on
the landing and sign-in pages, where the atmosphere component still runs.

## Authentication state

`AuthProvider` treats `GET /api/auth/me` as the source of truth. A successful response establishes
the current user; a 401 leaves the user unauthenticated. Once a user exists, the provider loads the
separate Gmail connection status.

The exposed actions are:

- Begin Google login.
- Refresh the current session.
- Log out this session.
- Log out all sessions.
- Begin Gmail consent.
- Disconnect Gmail.

Login does not grant Gmail access. Gmail authorization is a separate, user-initiated flow. Logging
out clears query data and redirects to login. Disconnecting Gmail invalidates both user and Gmail
connection queries.

## The three screens

### Sorted

`GET /api/labels` returns the approved tree flat, with `parentId` and `depth`; the grid renders one
level at a time and the breadcrumb walks back up. The open folder is held in the `?folder=` search
parameter, so the browser's back button and an installed app's back gesture both work.

Each tile takes its colour from a hash of the folder's path, never from its position in the grid.
Sorting, filtering, or adding a folder must not repaint the rest: a folder you have learned to find
by colour keeps that colour between renders and between sessions. Tint, icon, and label share one
hue so the label reads as part of the tile.

Search looks through the whole tree rather than the level in view, because a folder you remember by
name should not require retracing the path you filed it under.

Opening a message hands off to Gmail rather than rendering mail here. Two details in that link
decide whether it lands:

- `#all/<id>`, not `#inbox/<id>` — filed mail has left the inbox, so an inbox fragment resolves to
  nothing.
- `?authuser=<connected email>`, not `/u/0/` — the `/u/N` index is per-browser-profile ordering, so
  with several Google accounts signed in `/u/0/` is whichever happens to be first.

### Approve

The pending plan arrives on `GET /api/labels` as `plan`. The tree is shown with each folder's
rolled-up count, its rationale, and the routing rules that will file mail into it, plus a
collapsed list of what the validator rejected. Unchecking a folder drops everything beneath it: a
child cannot be created without its parent.

Approval posts `{ planId }`, or `{ planId, nodeIds }` when part of the tree was dropped.

Every failure is rendered inline, next to what failed, carrying the server's own error code and
message. Nothing here uses a toast, and an empty proposal is an explicit empty state. Reporting a
proposal that produced nothing as a success is the exact defect that let a broken planner go
unnoticed for weeks.

### Activity

`GET /api/activity/runs` in reverse chronological order. Each run shows its kind, state, progress
against its total, duration, per-kind counters, and the reason it ended. `STOPPED` is presented as
its own state rather than as a failure: the run did what it could and quit for a stated reason,
such as the daily Gemini budget. The list polls every two seconds only while a run is `RUNNING`.

## Installable app

`vite-plugin-pwa` generates the manifest and service worker.

- Standalone display, `#f3ecdf` theme and background, icons at 192, 512, and 512 maskable. The
  icons are generated by `apps/web/scripts/generate-pwa-icons.mjs` so the mark stays reviewable as
  code rather than as opaque binaries.
- The service worker precaches the app shell only — JavaScript, CSS, HTML, and the icons. The
  editorial artwork is large and non-essential, so it stays on the network.
- API requests are `NetworkOnly`, and `/api/` is denied the navigation fallback. Every API response
  is authenticated by an HttpOnly session cookie, and caching one is how a shared device shows one
  account's mail to the next person who signs in.
- `registerType: 'prompt'`. A new build waits behind a toast rather than reloading underneath
  someone part-way through an approval.

Sign-in is a top-level `window.location.assign` to the backend, so the OAuth round trip stays in
the installed window rather than opening a detached browser context.

## Testing and build

Vitest runs in jsdom with Testing Library. Tests cover route protection, landing/login and OAuth
callback behavior, the three screens and their empty, error, and stopped states, the folder colour
hash, the Gmail deep-link contract, the visual atmosphere, and the Axios refresh/retry contract.
Playwright covers the signed-out and signed-in paths, the retired-route redirects, and every
surviving route rendering without console errors.

Vite creates explicit vendor chunks for React/router, TanStack Query/Axios, Motion, and interface
dependencies. The resulting static SPA in `apps/web/dist` must be served with a history fallback so
direct navigation to client routes reaches `index.html`.

For HTTP details, see [API reference](api.md). For system boundaries and sequence diagrams, see
[Architecture](architecture.md).
