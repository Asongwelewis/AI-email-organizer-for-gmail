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
in code — never asked of a model), plus `domain` and `intent` from two closed vocabularies the
account's owner approved. The classifier may return only those values. A single tree could express one ordering of these at a time, which is why
most of a real mailbox had no leaf to go in; facets are assigned independently and pivoted into
folders afterwards.

**Every ordering at once; one of them is the remembered default.** `facet_pivot_settings` holds an
ordered `canonical_pivot` (default `["entity", "intent"]`) and `min_messages`. `buildPivot` is a
pure function of the facet rows, so any ordering is answered from `message_facets` with no remote
call, and the PWA offers them side by side with the ordering in the URL. The saved one decides
which arrangement Sorted opens on, and is the only one that can be mirrored into Gmail — a message
carries one MailMind label and no more, which is a Gmail limit rather than a product requirement.
`user_labels.facet_key` is a folder's identity, so re-applying a pivot keeps an existing row and its
`gmail_label_id`. Folder names are unique among **siblings**, not per account: a pivot repeats its
lower levels by construction.

**A folder says where the new mail is.** `buildPivot` counts unread mail per node twice: its own,
and its whole subtree. The subtree number is what a folder tile shows, because unread mail three
levels down is still mail nobody has seen and a parent that stayed quiet about it would send a
person hunting. It is read from `gmail_message_metadata.is_unread`, so it tracks Gmail rather than
anything MailMind decided.

**Findability is folders plus search.** `GET /api/facets/search` matches subject and sender across
the whole mailbox with Postgres full text (`simple`, and the sender address split on punctuation on
both sides of the match), narrowed by any combination of `entity`, `domain` and `intent`, with the
folder each hit sits in attached. A facet filter joins `message_facets`; a phrase alone does not,
so mail that was never classified stays findable. No model call, no Gmail call.

**A vocabulary belongs to a mailbox, not to the repository.** `facet_vocabularies` holds the
domains and intents one account approved, through the same propose → confirm shape as the folder
tree: `POST /api/facets/vocabulary/propose` grounds a candidate set in that mailbox's own mail and
writes it where the classifier cannot see it; `POST /api/facets/vocabulary/confirm` is the human
approval. Until one exists, classification refuses with `FACET_VOCABULARY_NOT_APPROVED` — there is
no default, because "career, development, education" describes one person's life. The checked-in
constant in `features/label-discovery/facets.ts` is now a _starter set_ offered to a new mailbox
and the seed the existing accounts were migrated with, never a fallback. `prompt_version` carries a
fingerprint of the vocabulary, so approving a change re-classifies the affected mail through the
staleness machinery that already exists.

**Rules before AI.** `learned_classification_patterns` holds routing rules — `SENDER_DOMAIN`,
`SENDER_ADDRESS`, or `SUBJECT_CONTAINS`, never regular expressions — installed when a plan is
approved and learned from mail that was actually filed. Automation applies matching rules with no
model call and sends only the remainder to Gemini.

**Gmail is the source, not the store.** The PWA builds its folders from `message_facets` and a
message's deep link addresses it by id — `#all/<id>` resolves whether the message is filed,
archived or still in the inbox — so nothing a person sees depends on a Gmail label existing.
Writing them is therefore an **export**, opt-in behind `GMAIL_WRITE_ENABLED` and **off by
default**: with it off, `facetFilingService.fileAccount` and `pivotService.apply` answer
`503 GMAIL_WRITE_DISABLED` and the daily run classifies without filing. The filing code is kept,
not deleted — it is that export path.

**When the export is on, Gmail mutation is confined to three paths.** `facet-filing.service`
applies labels via `messages.modify`, and its apply is _exclusive_ — the new label goes on and every
other MailMind label comes off in the same call, so a re-filed message never wears two;
`automation.service` applies one on a reviewer's approval, through the same exclusive path; the
labels feature and `pivot.service` create/rename leaf paths on confirm, rename, and pivot apply.
**Every one of those three checks `GMAIL_WRITE_ENABLED` itself** — the flag is not a property of
one entry point. With the export off, a reviewer's approval and a folder confirm both still record
their decision in MailMind and write nothing to the mailbox; what they must never do is write a
label id into `gmail_message_metadata.label_ids`, which mirrors what Gmail actually holds.
Deleting a label never unlabels mail, so a pivot never deletes folders — it reports the ones that no
longer match and leaves them alone. `npm run sweep:labels` is the deliberate exception, and it
strips a label from its mail before deleting it. Nothing else may mutate Gmail.

**One filing engine.** `automation.service` orchestrates and owns no classification of its own: a
run refreshes the mailbox and calls `facetClassificationService.classifyAccount`, then
`facetFilingService.fileAccount` only when the Gmail export is enabled. `POST /api/automation/run`
and the scheduler both go through it. A classification-only run opens its own `automation_runs`
row, because the daily token and cost caps are read back as a sum over today's rows and filing used
to be what opened it.
The taxonomy classifier that used to live here — a Gemini call per batch choosing a leaf of the
approved tree, applied through an _additive_ `messages.modify` — is gone. Two engines writing the
same table and the same labels could always undo each other, and the retired one was the one
running unattended.

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
