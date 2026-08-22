# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

MailMind AI — a human-in-the-loop Gmail organization app. npm-workspaces monorepo: `apps/web`
(React 19 + Vite SPA), `apps/api` (Express 5 + Prisma), `packages/shared`, `packages/ui`,
`packages/config`. Requires Node.js 22+ / npm 10+.

## Commands

Run from the repository root. Node 22+ / npm 10+.

| Purpose                    | Command                                                                  |
| -------------------------- | ------------------------------------------------------------------------ |
| Dev (web + api)            | `npm run dev` (or `npm run dev:web` / `npm run dev:api`)                 |
| All tests                  | `npm test`                                                               |
| API tests only             | `npm test --workspace @mailmind/api`                                     |
| Web tests only             | `npm test --workspace @mailmind/web`                                     |
| Single test file           | `npm exec --workspace @mailmind/api -- vitest run test/security.test.ts` |
| Single test by name        | add `-t "partial name"` to the vitest command                            |
| Watch a file               | same as above with `vitest watch` instead of `vitest run`                |
| Database lifecycle tests   | `npm run test:database --workspace @mailmind/api`                        |
| Database invariant audit   | `npm run audit:database --workspace @mailmind/api`                       |
| E2E (Playwright)           | `npm run test:e2e`                                                       |
| Typecheck (all workspaces) | `npm run typecheck` (root `tsc -b --force` over project references)      |
| Lint / format              | `npm run lint`, `npm run format`, `npm run format:check`                 |
| Build all                  | `npm run build`                                                          |
| Prisma client / validate   | `npm run prisma:generate` / `prisma:validate --workspace @mailmind/api`  |
| Apply migrations           | `npm exec --workspace @mailmind/api -- prisma migrate deploy`            |

Notes:

- `test/database.integration.test.ts` self-skips unless `RUN_DATABASE_INTEGRATION=true` **and**
  `DATABASE_URL` points at localhost/127.0.0.1/::1. It truncates every table, so it will never run
  against a remote project.
- `npm run test:e2e` boots a Vite dev server on 127.0.0.1:4174 via `e2e/run-e2e.mjs` and then runs
  Playwright — do not invoke `playwright test` directly.
- Vitest path aliases: `@api` → `apps/api/src`, `@web` → `apps/web/src`.
- `npm run build` wraps the workspace builds in `scripts/with-app-version.mjs`, which derives a
  single release id and exports it as `APP_VERSION`, `VITE_APP_VERSION`, and `SENTRY_RELEASE`. If
  any two of those are already set to different values the build fails by design.
- CI (`.github/workflows/ci.yml`) runs migrations against a disposable Postgres 16, then lint,
  format check, typecheck, tests, database tests, build, and a liveness/readiness probe of the
  built API. It never uses production Supabase credentials or calls Google.

## Architecture

Full detail lives in [docs/](docs/) — [architecture.md](docs/architecture.md),
[backend.md](docs/backend.md), [frontend.md](docs/frontend.md), [api.md](docs/api.md), plus the
per-stage design notes. Read those before non-trivial work; the key invariants:

**Trust boundary.** Only `apps/api` touches PostgreSQL, Google, or Gemini. The SPA gets DTOs and an
HttpOnly `mailmind_session` cookie — never OAuth tokens, secrets, or direct Supabase access. Any
`VITE_`-prefixed value ends up in the browser bundle and must not be a secret.

**API layering.** routes/middleware → controllers (Zod transport validation) → services (business
and privacy rules) → repositories (Prisma, always scoped to the authenticated user's connected
account). Feature code lives under `src/features/{labels,automation}`; Google/Gmail/Gemini adapters
under `src/integrations`. `src/features/label-discovery` is engine-only — the taxonomy planner,
name normalization, and the routing-rule vocabulary — consumed by the labels and automation
features; it has no routes of its own.

**Identity vs. Gmail authorization are separate flows** with separate callbacks
(`/api/auth/google/callback` vs `/api/integrations/google/callback`). Signing in must never grant
Gmail access. OAuth state is hashed, single-use, purpose-bound, and expiring; Google tokens are
encrypted with a versioned key.

**Metadata-only Gmail boundary.** Sync requests `format: "metadata"` with Subject/From/To/Cc/Date
and stores IDs, a truncated snippet, label ids, flags, size, and attachment presence. Never fetch
or persist full bodies, raw MIME, or attachment content.

**Approved labels are the only vocabulary.** `user_labels` holds the tree the user confirmed —
`parent_id`, `depth` 1–3, `full_path` equal to `MailMind/` plus the joined ancestor chain, enforced
by a database trigger. Automation files each message into exactly one approved leaf or records
`NONE` and leaves the message in the inbox — it never invents a label. New folders arrive only
through `POST /api/labels/propose` (one Gemini call designs the whole tree; nothing is created) →
`POST /api/labels/confirm` (the human approves; only then does Gmail change). Automation refuses to
run (`AUTOMATION_NO_APPROVED_LABELS`) until at least one is confirmed.

**Gmail nesting is cosmetic, so only leaves exist there.** `A/B` is one Gmail label whose name
contains a slash: applying it does not apply `A`, and `label:A` does not return its mail. The tree
lives in the database; only a leaf's `full_path` is created in Gmail. Renaming a folder renames
every Gmail label beneath it.

**Facets are the classification vocabulary; folders are a view of them.** A message carries three
orthogonal facets in `message_facets`: `entity` (the sending brand, derived from the sender domain
in code — never asked of a model), plus `domain` and `intent` from two closed vocabularies the user
approved, held as a checked-in constant in `features/label-discovery/facets.ts`. The classifier may
return only those values. A single tree could express one ordering of these at a time, which is why
most of a real mailbox had no leaf to go in; facets are assigned independently and pivoted into
folders afterwards.

**One pivot is materialised; the rest are computed on read.** `facet_pivot_settings` holds an
ordered `canonical_pivot` (default `["entity", "intent"]`) and `min_messages`. `buildPivot` is a
pure function of the facet rows, so the tree can be built and reviewed before any remote call. Only
that ordering becomes `user_labels` rows and Gmail labels — a message carries one MailMind label
and no more. Any other ordering is answered from `message_facets` without touching Gmail.
`user_labels.facet_key` is a folder's identity, so re-applying a pivot keeps an existing row and its
`gmail_label_id`. Folder names are unique among **siblings**, not per account: a pivot repeats its
lower levels by construction.

**Rules before AI.** `learned_classification_patterns` holds routing rules — `SENDER_DOMAIN`,
`SENDER_ADDRESS`, or `SUBJECT_CONTAINS`, never regular expressions — installed when a plan is
approved and learned from mail that was actually filed. Automation applies matching rules with no
model call and sends only the remainder to Gemini.

**Gmail mutation is confined to three paths.** `src/features/automation` applies labels via
`messages.modify` — the legacy leaf-path filer and `facet-filing.service`, whose apply is
_exclusive_ so a re-filed message never wears two MailMind labels; the labels feature and
`pivot.service` create/rename leaf paths on confirm, rename, and pivot apply. Deleting a label never
unlabels mail, so a pivot never deletes folders — it reports the ones that no longer match and
leaves them alone. Nothing else may mutate Gmail.

**Concurrency and idempotency.** Every long-running per-account operation (sync, automation) takes
an expiring account-scoped DB lease and writes checkpoints, so multiple API instances can share one
database. External calls (Google, Gemini) happen _outside_ database transactions so partial work
stays durable and resumable.

**Frontend state.** TanStack Query owns server state with retries and refetch-on-focus disabled by
default; feature hooks poll every 2s only while a run is active. `AuthProvider` treats
`GET /api/auth/me` as source of truth. The Axios client attempts one shared session refresh on 401,
retries once, then clears local auth state.

## Database

Prisma schema at [apps/api/prisma/schema.prisma](apps/api/prisma/schema.prisma). Migrations are
ordered directories in `apps/api/prisma/migrations` **with a matching flat `.sql` copy in
`supabase/migrations` using the same timestamp name** — add both when writing a migration.

Migrations carry rules Prisma's schema syntax can't express: enabled+forced RLS on application
tables, revoked privileges for `PUBLIC`/`anon`/`authenticated`, extra constraints and indexes. The
API connects through its own dedicated database role.

Never run `prisma migrate reset` or `supabase db reset` against a shared or remote project; those
are only for the disposable local `supabase start` stack.

## Configuration

`.env.example` at the root plus `apps/api/.env.example` and `apps/web/.env.example`. API config is
parsed by Zod at startup — invalid config aborts the process and reports field names without
values. `docs/backend.md` documents every variable; `WEB_APP_URL` + deployed frontend origins form
the shared CORS and trusted-Origin (CSRF) allowlist.

Deployment: API on Render ([render.yaml](render.yaml), health check `/health`, `prisma migrate
deploy` as pre-deploy), SPA on Vercel ([vercel.json](vercel.json), history fallback to
`index.html`).

## Conventions

- ESM throughout; API relative imports use explicit `.js` extensions.
- Husky + lint-staged run Prettier and `eslint --fix` on staged files.
- Structured Pino logging with secret redaction — keep tokens, cookies, OAuth codes, database URLs,
  and message content out of logs and out of error responses (500s stay generic).
