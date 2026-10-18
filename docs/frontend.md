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

The client sets `withCredentials: true`. A 401 ends the session locally: the interceptor clears
authentication state and makes no second request. There is no client-side refresh — the API
answers 401 only for a session that is missing, expired or revoked, which is exactly what a refresh
would have failed on. Sessions stay alive by being used: the API slides the expiry forward on
authenticated requests and re-issues the cookie itself. `skipAuthFailure` marks the two requests
whose 401 says nothing about the session (logout and the public feedback form).

### Time windows

"Last 24 hours", "7 days", "30 days" and "All mail" filter the same folders: the tree is shaped by
the whole mailbox on the server, and the window decides which mail each folder counts and which
folders have anything in it. A level shows its 24 newest folders first, with "Show all N folders"
for the rest — the grid used to stop at ten with no way past it. (Until October 2026 "Last 24
hours" also reached back only one hour.)

### Live mail

There is no "Run now" or "Check for new mail" button. The API checks Gmail every minute and sorts new
mail as it lands, and the full job runs twice a day, so the automation panel on Activity says what
is happening instead: "Watching for new mail · checks every minute · last checked 2 min ago", the
next full run, and what was sorted today. It refreshes itself every 30 seconds while on screen.
Sorted's folder tree and the open folder's mail refetch every minute while the tab is visible.

Brand folders show the brand's logo on a small white plate (logos are drawn for white). The image
comes from `GET /api/facets/icons/:domain`, never from a logo service directly, which is why the CSP
allows `img-src https://api.mailmindai.tech`. A logo that fails to load gives way to the folder icon.

### Opening fast on a sleeping server

The API runs on a free plan that sleeps when idle and takes up to a minute to wake. So the app
does not wait for it to start rendering:

- `lib/sessionSnapshot.ts` remembers the `/auth/me` answer, the pivot settings and the last folder
  tree in `localStorage`, and the queries use them as `placeholderData`. A returning user lands on
  their folders immediately while the real requests run, and settings and tree are fetched side by
  side instead of one after the other.
- Only the profile and folder names/counts are kept — never subjects, senders or message ids, and
  never the mail inside a folder. The service worker's ban on caching API responses still holds.
- Everything is forgotten on logout, on any 401, and is never read back once `sessionExpiresAt`
  (returned by `/auth/me`) has passed — so a shared device whose session ran out shows the sign-in
  screen, not the previous person's folders.
- A failed session check that is not a 401/403 (a timeout or 502 while the server wakes) is
  retried rather than treated as signed out.
- After four seconds of continuous loading, `ServerWakeNotice` (and the session loader) say the
  server is waking up, so a long wait does not read as broken.

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

| Location         | Responsibility                                                      |
| ---------------- | ------------------------------------------------------------------- |
| `src/router`     | Public and protected route definitions                              |
| `src/pages`      | Route-level screens                                                 |
| `src/layouts`    | Public layout and authenticated application shell                   |
| `src/components` | Shared visual, navigation, dialog, and route-guard components       |
| `src/context`    | Authentication, Gmail connection orchestration, and the theme       |
| `src/services`   | Axios client and user-facing API error translation                  |
| `src/queries`    | TanStack Query keys, reads, mutations, invalidation, and polling    |
| `src/types`      | API response and feature taxonomy types                             |
| `src/lib`        | Folder colour hashing, Gmail deep links, and display formatting     |
| `src/styles`     | `theme.css` palette tokens, `index.css` public pages, `app.css` app |
| `src/test`       | Vitest and Testing Library setup                                    |

## Routes

### Public routes

| Route            | Screen                                                   |
| ---------------- | -------------------------------------------------------- |
| `/`              | Product landing page                                     |
| `/login`         | Google identity login                                    |
| `/auth/callback` | Handles safe status values after backend OAuth redirects |
| `/about`         | Product purpose and operating principles                 |
| `/faq`           | Public answers about Gmail, classification, and deletion |
| `/security`      | Browser, credential, telemetry, and deployment controls  |
| `/cookies`       | Necessary cookies and local preference storage           |
| `/privacy`       | Privacy policy and Google API data-use disclosure        |
| `/terms`         | Terms of service                                         |
| `/support`       | Support and vulnerability-reporting guidance             |
| `/feedback`      | Public feedback form                                     |
| `/data-deletion` | Account and data deletion flow                           |

Unknown routes redirect to `/`.

### Protected routes

Everything you _watch_ happen was removed; what remains are the screens where a decision gets made
or a message gets found. All of them render inside `ProtectedRoute` and `AppShell`:

| Route            | Purpose                                                                      |
| ---------------- | ---------------------------------------------------------------------------- |
| `/inbox`         | The folders, in any arrangement of the facets; star, drill in, open in Gmail |
| `/find`          | Search subject and sender across the mailbox, filtered by facet              |
| `/favorites`     | The starred folders, with live counts over all mail                          |
| `/folders`       | Shape an arrangement, preview its tree, keep it as the default               |
| `/activity`      | Run records, newest first, with state, progress, stop reasons, error codes   |
| `/menu`          | Behind the menu icon on the left of every screen: notifications and the rest |
| `/notifications` | New-mail feed, and turning device notifications on or off                    |
| `/account`       | Signed-in connection, session, logout, and deletion controls                 |

The tab bar holds the five everyday screens: Inbox, Find, Favourites, Folders, Activity. The menu
icon, top left at every width, carries the unread notification count.

`/setup` is reachable but deliberately absent from the navigation: it is a path you walk once,
linked to from wherever an account turns out not to be ready.

`/sorted` redirects to `/inbox` keeping its query string, so an old link still opens the same
folder. `/review`, `/approve`, `/labels`, `/dashboard/*` and `/settings/*` redirect to `/inbox` —
Review and Approve are gone for now and will be redesigned — and `/automation` to `/activity`.
Unknown routes redirect to `/`.

## Theme

The interface is macOS-shaped: layered graphite that is never pure black, translucent chrome over
the content behind it, an inner top highlight that makes a panel read as milled rather than
printed, and one system blue spent only on focus, selection, and the single primary action per
screen. Radii sit on Apple's 6/10/14/18 scale.

`src/styles/theme.css` is the only file that defines a colour. It carries three states, because a
theme has three and not two:

| Selector                                                                  | Meaning                                         |
| ------------------------------------------------------------------------- | ----------------------------------------------- |
| `:root`                                                                   | the complete **light** palette, unconditionally |
| `@media (prefers-color-scheme: dark) { :root:not([data-theme='light']) }` | dark, when no explicit choice was made          |
| `:root[data-theme='dark']`                                                | dark again, so an explicit choice beats the OS  |

Every token is defined once on bare `:root`; the dark blocks only ever redefine. A colour whose
only definition lives inside a media query disappears when the query stops matching.

`ThemeProvider` owns the preference — `dark` (the default), `light`, or `system` — persists it to
`localStorage` inside `try/catch`, and stamps `data-theme` on the document element. **`system`
removes the attribute rather than stamping a value**: that is the contract the CSS is written
against, and stamping one would work once and then stop following the OS. An inline script in
`index.html` applies the same rule before first paint so a dark-on-a-light-machine load has no
white flash; it duplicates the storage key and the default deliberately, and has to be changed
alongside `src/context/useTheme.ts`.

`folderColor` returns a **hue and nothing else**. Saturation and lightness are the theme's business,
so `FolderTile` sets one `--tile-hue` and the `hsl()` is composed on the tile itself — a custom
property is substituted against the element that declares it, so composing the colour on `:root`
would resolve the hue against `:root`, where it is never set, and paint every folder the same
fallback blue. The result is that a folder keeps the hue the eye learned across renders, sessions,
and a theme switch, while staying readable in both.

The system font stack carries UI text and every numeral — on a Mac that resolves to San Francisco,
which is the point — with Manrope as the fallback elsewhere and DM Mono for timestamps and codes.
Fraunces is the wordmark alone.

`AppShell` is one layout with one breakpoint at 768px: a bottom tab bar and a two-column tile grid
below it, a left nav rail and a four-column grid inside a max-width column above it. A phone layout
stretched across a desktop is the failure mode this avoids. The editorial atmosphere still runs on
the landing and sign-in pages; it does not follow you through the door.

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

## The screens

### Favourites and notifications

Every folder tile carries a star in its bottom-left corner — a second button beside the tile's own,
since buttons cannot nest. `useFavorites` fills it the moment it is tapped and reverts only if the
server refuses. A favourite opens in the arrangement it was starred from and over all mail, so it
always lands on the folder it names.

New-mail notifications come from one shared query, polled every minute: the menu badge, the
Notifications screen and `NotificationCenter` all read it. `NotificationCenter` toasts with Sonner
for anything that arrived while the app is open — never for what was already there at launch — and
keeps the installed app's taskbar badge in step. Device notifications are Web Push: `lib/push.ts`
asks the browser for permission and subscribes it with the server's VAPID public key, and
`public/push-handler.js` (imported into the generated service worker) shows each push in the OS
notification centre unless a MailMind window is focused, in which case it tells that window to
refresh instead. Logging out unsubscribes the device first.

### Inbox

`GET /api/facets/pivot/view` returns the tree flat, with `parentFacetKey` and `depth`; the grid
renders one level at a time and the breadcrumb walks back up. The open folder is held in the
`?folder=` search parameter, so the browser's back button and an installed app's back gesture both
work.

**Every arrangement, not one canonical one.** A folder is a facet combination, and `buildPivot` is
a pure function of the facet rows, so `Netflix > Payment failed` and `Finance > Payment failed >
Netflix` are two views of the same mail. The ordering is held in `?order=`, which is what makes a
view a link; switching costs no reclassification and no remote call, and returns to the top level
because a facet key names a combination in one ordering only. `facet_pivot_settings` remains the
remembered default — which arrangement the screen opens on, and the only one that can be mirrored
into Gmail.

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

### Find

`GET /api/facets/search`, over subject and sender across the whole mailbox, with any combination of
facet filters. Query and filters live in the URL, so a search worth keeping is a link, and typing
is debounced because the interesting searches here are half-remembered sentences rather than words.

The facet filters are the part a Gmail label tree cannot do: `intent=payment-failed` across every
brand at once is a question no single tree can be arranged to answer. Every hit carries the folder
it sits in — "it was under Finance all along" is half of what was being asked — and, like Sorted,
opens the message in Gmail rather than rendering it.

Nothing here spends anything: no model call, no Gmail call, just Postgres full text over metadata
the sync already stored.

### Folders

Reorder the facets, set the folder floor, and preview the tree the arrangement produces — all
computed on read. Saving decides which arrangement Sorted opens on and nothing else.

Mirroring into Gmail is a collapsed, optional section, because it is opt-in on the server and off
by default. Only the saved arrangement can be mirrored: a message wears one Gmail label and no
more, which is the constraint that used to make "canonical" a real word here. A refusal comes back
as `GMAIL_WRITE_DISABLED` and is rendered as a setting rather than a failure.

### Activity

`GET /api/activity/runs` in reverse chronological order. Each run shows its kind, state, progress
against its total, duration, per-kind counters, and the reason it ended. `STOPPED` is presented as
its own state rather than as a failure: the run did what it could and quit for a stated reason,
such as the daily Gemini budget. The list polls every two seconds only while a run is `RUNNING`.

## Running it as an installed app

`npm run pwa` builds the SPA against a local API and serves it on `http://localhost:5173`, which is
the origin `WEB_APP_URL` and the OAuth callbacks already point at. Run `npm run dev:api` beside it.

The build step matters: `devOptions.enabled` is false, so `npm run dev` serves no service worker and
a browser will not offer to install it. `vite preview` serves the real build, and `localhost` counts
as a secure context, so the install control appears there.

In Chrome or Edge, the install icon sits at the right-hand end of the address bar (or ⋮ → Cast, save
and share → Install). The manifest asks for `display: standalone` and opens on `/sorted`, so it gets
its own window with no browser chrome — the same shape as an app added to a phone's home screen. In
Safari 17+ it is File → Add to Dock.

## Installable app

`vite-plugin-pwa` generates the manifest and service worker.

- Standalone display, `#1c1c1e` theme and background — the dark window ground, because a manifest
  colour is fixed at install time and follows the app's default theme rather than the viewer's
  current one. Icons at 192, 512, and 512 maskable. The
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
