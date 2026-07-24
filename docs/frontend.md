# Frontend documentation

## Overview

The MailMind web application is a React 19, TypeScript, and Vite single-page application in
`apps/web`. React Router owns navigation, TanStack Query owns server state, Axios provides the
credentialed API client, Motion provides transitions, Sonner provides notifications, and
Tailwind CSS 4 is integrated through Vite.

The browser contains no Google client secret, Gmail token, session secret, database credential, or
classifier key. Its only environment setting is the public API URL.

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
frontend appends `/api`. It is the only frontend environment variable. Because all `VITE_` values
are embedded into the browser bundle, it must never contain a secret.

`src/services/http.ts` removes trailing slashes, appends `/api`, and uses the result as the Axios
`baseURL`. If it is not defined, development falls back to `http://localhost:4000/api`.

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
4. The custom cursor and toast region.

The query client disables automatic retries and refetch-on-window-focus by default. Individual
feature hooks add polling only while Gmail sync, classification, or label discovery is running.

### Directory guide

| Location         | Responsibility                                                   |
| ---------------- | ---------------------------------------------------------------- |
| `src/router`     | Public and protected route definitions                           |
| `src/pages`      | Route-level screens                                              |
| `src/layouts`    | Public layout and authenticated application shell                |
| `src/components` | Shared visual, navigation, dialog, and route-guard components    |
| `src/context`    | Authentication and Gmail connection orchestration                |
| `src/services`   | Axios client and user-facing API error translation               |
| `src/queries`    | TanStack Query keys, reads, mutations, invalidation, and polling |
| `src/types`      | API response and feature taxonomy types                          |
| `src/styles`     | Global Tailwind-driven design and component classes              |
| `src/test`       | Vitest and Testing Library setup                                 |

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

All protected routes render inside `ProtectedRoute` and `AppShell`:

| Route                        | Purpose                                                              |
| ---------------------------- | -------------------------------------------------------------------- |
| `/dashboard`                 | Session and Gmail connection summary                                 |
| `/settings/connections`      | Connect, inspect, disconnect, and synchronize Gmail                  |
| `/dashboard/classification`  | Run classification and review/correct recommendations                |
| `/dashboard/labels/discover` | Discover, approve, rename, reject, defer, or merge label suggestions |

The app shell provides primary tabs, user identity, logout, logout-all, route transitions, and the
nested route outlet.

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

## Feature data flows

### Gmail synchronization

The connections screen can initialize MailMind labels, run a bounded initial metadata sync, or run
an incremental history sync. The status query polls every two seconds only while `syncRunning` is
true. Successful mutations invalidate the status query.

### Classification review

The classification screen loads status plus a cursor-paginated review queue. It can start a run and
record a corrected category/action. Status polls every two seconds while `running` is true; run and
correction mutations invalidate both status and results.

### Label discovery

The label screen loads status plus cursor-paginated candidates. It supports discovery, approval
with an optional renamed leaf, rejection, deferral, and merge. Mutations refresh both candidate and
status data. These decisions do not apply labels in Gmail.

## Testing and build

Vitest runs in jsdom with Testing Library. Tests cover route protection, landing/login and OAuth
callback behavior, dashboard/connections/classification/label screens, visual atmosphere, and the
Axios refresh/retry contract.

Vite creates explicit vendor chunks for React/router, TanStack Query/Axios, Motion, and interface
dependencies. The resulting static SPA in `apps/web/dist` must be served with a history fallback so
direct navigation to client routes reaches `index.html`.

For HTTP details, see [API reference](api.md). For system boundaries and sequence diagrams, see
[Architecture](architecture.md).
