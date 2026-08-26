# Backend documentation

## Overview

The MailMind API is an Express 5 and TypeScript service in `apps/api`. It owns authentication,
encrypted Google credentials, metadata-only Gmail synchronization, the user-approved label set,
daily Gemini/Gmail automation, audit records, and all PostgreSQL access through Prisma.

The backend is the only application component allowed to access the database, Google client secret,
Gmail OAuth tokens, session secrets, token-encryption key, or an external classifier credential.
The browser communicates with it through `/api`.

## Workspace and commands

Prerequisites are Node.js 22+, npm 10+, and PostgreSQL 16 or a compatible Supabase PostgreSQL
project.

From the repository root:

```powershell
npm ci
npm run prisma:generate --workspace @mailmind/api
npm run dev:api
```

The real workspace commands are:

| Purpose                        | Command                                                       |
| ------------------------------ | ------------------------------------------------------------- |
| Development server             | `npm run dev --workspace @mailmind/api`                       |
| Prisma validation              | `npm run prisma:validate --workspace @mailmind/api`           |
| Prisma client generation       | `npm run prisma:generate --workspace @mailmind/api`           |
| Apply pending migrations       | `npm exec --workspace @mailmind/api -- prisma migrate deploy` |
| Type-check source and tests    | `npm run typecheck --workspace @mailmind/api`                 |
| Run API tests                  | `npm test --workspace @mailmind/api`                          |
| Run database integration tests | `npm run test:database --workspace @mailmind/api`             |
| Audit database invariants      | `npm run audit:database --workspace @mailmind/api`            |
| Production build               | `npm run build --workspace @mailmind/api`                     |
| Start the built API            | `npm run start --workspace @mailmind/api`                     |

The production build is emitted to `apps/api/dist`. `src/index.ts` loads `server.ts`, which connects
Prisma before starting the HTTP listener. `SIGINT` and `SIGTERM` stop accepting requests, disconnect
Prisma, and have a ten-second forced-shutdown fallback.

## Configuration

Copy `apps/api/.env.example` to `apps/api/.env` for local development. Configuration is parsed by
Zod at process startup; invalid configuration stops startup and reports field names without
printing their values.

### Core, security, and OAuth

| Variable                       | Purpose                                                                       |
| ------------------------------ | ----------------------------------------------------------------------------- |
| `NODE_ENV`                     | `development`, `test`, or `production`. Production requires secure cookies.   |
| `PORT`                         | HTTP port; defaults to `4000`.                                                |
| `WEB_APP_URL`                  | Primary frontend origin used for redirects and added to the origin allowlist. |
| `API_BASE_URL`                 | Public backend URL used when constructing OAuth flows.                        |
| `DATABASE_URL`                 | PostgreSQL connection string used by both Prisma runtime and migrations.      |
| `SESSION_SECRET`               | At least 16 characters; signs cookies and protects session handling.          |
| `TOKEN_ENCRYPTION_KEY`         | Base64-encoded key that must decode to exactly 32 bytes.                      |
| `TOKEN_ENCRYPTION_KEY_VERSION` | Positive integer stored with encrypted OAuth tokens.                          |
| `COOKIE_SECURE`                | Must be `true` in production and whenever SameSite is `none`.                 |
| `COOKIE_SAME_SITE`             | `lax`, `strict`, or `none`.                                                   |
| `COOKIE_DOMAIN`                | Optional shared cookie domain; omit for a host-only cookie.                   |
| `GOOGLE_CLIENT_ID`             | Backend-only Google OAuth client identifier.                                  |
| `GOOGLE_CLIENT_SECRET`         | Backend-only Google OAuth client secret.                                      |
| `GOOGLE_LOGIN_REDIRECT_URI`    | Callback for identity login: `/api/auth/google/callback`.                     |
| `GOOGLE_GMAIL_REDIRECT_URI`    | Separate callback for Gmail connection: `/api/integrations/google/callback`.  |
| `LOG_LEVEL`                    | Pino log level.                                                               |
| `TRUST_PROXY_HOPS`             | Number of trusted reverse-proxy hops, from 0 through 3.                       |

Session lifetime and rate-limit controls:

- `REFRESH_SESSION_TTL_DAYS`
- `OAUTH_STATE_TTL_MINUTES`
- `AUTH_RATE_LIMIT_WINDOW_MINUTES`
- `AUTH_RATE_LIMIT_MAX_REQUESTS`

### Gmail synchronization

- `GMAIL_SYNC_PAGE_SIZE`
- `GMAIL_SYNC_BATCH_SIZE`
- `GMAIL_SYNC_MAX_RETRIES`
- `GMAIL_SYNC_RETRY_BASE_MS`
- `GMAIL_SYNC_LEASE_SECONDS`
- `GMAIL_WRITE_ENABLED` — whether MailMind may write labels into the mailbox at all. It also
  decides **which Gmail scope the connect flow asks for**: `gmail.readonly` when off,
  `gmail.modify` when on. **Defaults to
  `false`.** The PWA builds its folders from `message_facets` and a message's deep link addresses it
  by id, so nothing a person sees depends on a Gmail label; labelling buys organisation visible
  inside the Gmail app and costs one `messages.modify` per message per run. With it off,
  `facetFilingService.fileAccount` and `pivotService.apply` refuse with
  `503 GMAIL_WRITE_DISABLED`, and the daily run classifies without filing. Turning it on is how
  someone asks for the export.

### Measuring the classifier

`npm run eval:facets --workspace @mailmind/api` scores the facet classifier against a labelled set
checked in at `apps/api/test/fixtures/golden-set.json`, and prints precision and recall per value,
a confusion matrix, the reliability curve, and a threshold sweep.

The threshold sweep is the point. `AUTOMATION_CONFIDENCE_THRESHOLD` decides how much mail a person
has to review by hand — 916 messages on the real mailbox — and it was picked without ever being
measured. Each row of the sweep says what filing unattended at that bar would file, how much of
that would be wrong, and how many correct decisions it would send to a reviewer anyway.

The labels are a **person's**. `npm run eval:facets --workspace @mailmind/api -- --draw 300` writes
a stratified, unlabelled draw — round-robin across facet combinations, so rare values are not
crowded out by the two that dominate a mailbox — for a human to fill in. Labelling with a second
model, or accepting the classifier's own answers, measures agreement rather than correctness.

A run is gated on the vocabulary: a label is only meaningful relative to the set of values it was
chosen from, so `vocabularyFingerprint` in the fixture is checked against the account's current one
and a mismatch refuses rather than scoring against labels that no longer mean the same thing.

### Gmail scope

The connect flow asks for **`gmail.readonly`**. `gmail.modify` is a Google _restricted_ scope — it
can alter and delete a person's mail, which is what pulls an app into verification plus an annual
CASA Tier 2 assessment — and with Gmail out of the write path the product does not use it. Turning
on `GMAIL_WRITE_ENABLED` widens the request to `gmail.modify`, because the label export genuinely
needs it.

Two separate questions, both of which must be yes before anything is written to a mailbox: does
this **deployment** offer the export (`GMAIL_WRITE_ENABLED`), and did this **person** grant it
(`gmail.modify` in `granted_scopes`). The second cannot be turned on from a config file.
`AutomationGmailService` is the single choke point every Gmail write passes through and checks it
before the first remote call, so a filing run refuses up front with `403 GMAIL_WRITE_SCOPE_MISSING`
rather than dying part-way and leaving a mailbox half in one tree and half in another.

`modify` implies read, so an account connected before the downgrade keeps working. Google's grants
are cumulative per client, though, so asking for less does not take the wider scope back: the
status route reports `holdsUnusedWriteScope`, and Setup offers to narrow it by revoking the grant
and reconnecting.

The sync boundary is metadata-only. The API requests Gmail messages with `format: "metadata"` and
the `Subject`, `From`, `To`, `Cc`, and `Date` headers. It stores those fields, Gmail IDs, a truncated
snippet, label IDs, state flags, estimated size, and whether an attachment exists. It does not
request or store full message bodies, raw MIME, or attachment content.

### Labels

One Gemini call designs the whole folder tree from a sample of stored metadata; the user approves
it; only then does anything reach Gmail. `POST /api/labels/propose` stores a `taxonomy_plans` row
with its nodes and proposed routing rules and creates nothing. `POST /api/labels/confirm` with a
`planId` writes the approved nodes into `user_labels` and installs the rules.

`user_labels` is a tree: `parent_id`, `depth` (1-3), and `full_path` equal to `MailMind/` plus the
joined ancestor chain. A database trigger rejects any row whose depth, owning account, or path does
not agree with its parent.

- `AUTOMATION_MAX_LABELS` caps approved **leaf** folders per account — the vocabulary automation
  may choose from (default `40`, matching the planner's leaf limit).
- `TAXONOMY_SAMPLE_SIZE`, `TAXONOMY_LOOKBACK_DAYS`, and `TAXONOMY_MAX_MESSAGES` decide how much
  mail the planner reads; `TAXONOMY_MAX_OUTPUT_TOKENS` bounds the tree it may return.
- Depth, the 40-leaf ceiling, the 3-message minimum per folder, and the 1-3 word naming rule are
  structural invariants enforced in `taxonomy-planner.ts` after parsing, not configuration.
- `FACET_LOOKBACK_DAYS`, `FACET_MAX_MESSAGES`, `FACET_SAMPLE_SIZE`, `FACET_SAMPLE_PER_DOMAIN_CAP`, and
  `FACET_SAMPLE_UNFILED_SHARE` decide the evidence the facet vocabulary is designed from;
  `FACET_MAX_OUTPUT_TOKENS` bounds the vocabulary it may return. The 8-value domain ceiling, the
  14-value intent ceiling, the 20-message minimum per value, kebab-case names, and mutual
  exclusivity are structural invariants enforced in `facet-vocabulary.ts` after parsing.

Names are validated with `validateLeafName`, rejected when `isGenericLabelName` matches, and
compared with `labelsAreSimilar` so an account cannot hold two near-duplicate folders. Names are
unique across the whole tree because a leaf name is the token automation classifies into.

**Gmail nesting is cosmetic.** `A/B` is a single Gmail label whose name contains a slash: applying
it does not apply `A`, and `label:A` does not return its mail. So the tree lives in the database and
only a leaf's `full_path` is created in Gmail, through the automation Gmail adapter. Renaming a
folder renames every Gmail label beneath it, since a Gmail label's name is its whole path. Deleting
a folder removes only MailMind's record; the Gmail label and the mail already filed under it are
never touched.

Proposals take the account's automation lease, so a proposal and an automation run can never
overlap for the same account.

### Routing rules

`learned_classification_patterns` holds both the rules an approved plan installed (`PLANNER`) and
the ones observed from mail that was actually filed (`LEARNED`). A rule is a `SENDER_DOMAIN`,
`SENDER_ADDRESS`, or `SUBJECT_CONTAINS` match — never a regular expression, because the values come
from an untrusted model and are replayed against every message.

Automation resolves rules most-specific-first (address, then domain, then subject) and files every
matching message with **no model call**; only what no rule covers is batched to Gemini. Planner
rules are authoritative; a learned rule must still clear `AUTOMATION_PATTERN_MIN_CONFIDENCE` and
`AUTOMATION_PATTERN_MIN_SAMPLES`, and a sender domain that turns out to feed two folders is
deactivated rather than flip-flopping.

Proposals take the account's automation lease, so a proposal and an automation run can never
overlap for the same account.

### Facets

A message carries three orthogonal facets, stored one row per message in `message_facets`:

- `entity` — the sending brand, derived from the sender domain by `entityFor` in
  `label-discovery/entity.ts`. No model call, so it costs nothing and cannot be wrong about a fact
  the envelope already states. Null when the sender carries no usable domain.
- `domain` and `intent` — the two closed vocabularies the mailbox owner approved, held as a
  checked-in constant in `label-discovery/facets.ts`. The classifier may return only these values;
  anything else is discarded per axis after parsing.

`facetClassificationService.classifyAccount` assigns them. It takes the same account-scoped
automation lease as the filing run, so the two can never overlap, and the `message_facets` row is
itself the checkpoint — a run stopped by a spent quota resumes exactly where it left off and no
message is ever classified twice. **It makes no Gmail call at all**: turning a facet combination
into a folder is the pivot's job.

The classifier is given the subject, the sender, the real sending **host** (`m.learn.coursera.org`,
not the brand slug — the brand is the entity facet, already derived in code) and a bounded snippet.
The prompt encodes the asymmetry between them: the host is **strong evidence for domain** and
**near-zero for intent**, because it says who is speaking and never what happened; the snippet is
the reverse. Where a host-to-domain mapping is reliable it belongs in a `SENDER_DOMAIN` rule
instead, which already supports subdomain granularity and prefers the longer, more specific value —
`learn.coursera.org → education` then costs no tokens at all and cannot be ignored.

The checkpoint is keyed on `prompt_version` and on an `input_hash` over the message fields a
decision is derived from, listed once as `HASHED_MESSAGE_FIELDS`. A run reads never-classified mail
first; if that does not fill the run, the remainder is spent re-checking existing decisions against
the input they were made from, newest-synced first, and re-queueing any that no longer match. Sync
upserts `subject` and `sender_email` on every pass, so without that check a corrected subject would
keep the facets chosen from text the message no longer carries. Anything new the classifier is
given to read belongs in `HASHED_MESSAGE_FIELDS` as well, or the checkpoint will call a decision
current that was made without ever seeing the field.

Routing rules resolve facets as well as folders. `facet_domain` and `facet_intent` are nullable, so
rules written before facets existed keep working, and `label_name`/`label_path` are nullable, so a
rule that resolves only to a facet does not have to name a folder that does not exist yet. The two
axes resolve independently — `resolveFacetRules` picks the most specific rule _per facet_ rather
than one winner — which is what lets `subject contains "insufficient funds" -> intent
payment-failed` fire for a bank, a broker, and a streaming service alike. `learned_from_entity`
records which brand taught a rule, so firing on a different one is countable.

### Pivoting facets into folders

Facets are orthogonal, so a folder tree is a _view_ of them rather than the thing itself. The same
mail is `Netflix > Payment failed` under `["entity", "intent"]` and `Finance > Payment failed >
Netflix` under `["domain", "intent", "entity"]`; switching between them recomputes nothing about the
mail, only the ordering.

`facet_pivot_settings` holds one account's `canonical_pivot` (ordered, default
`["entity", "intent"]`) and `min_messages` (default 5). **Exactly one ordering is materialised**,
because a message carries one MailMind label and no more. `pivotService.view()` computes any other
ordering from `message_facets` on read and never calls Gmail.

`buildPivot` in `label-discovery/pivot.ts` is a pure function of the facet rows, so the tree that
would be written can be built, printed, and reviewed without a remote call. A combination whose
subtree holds fewer than `min_messages` messages does not become a folder and its mail files one
level up; with no level up it stays in the inbox and is counted. A folder that has children cannot
also hold mail — only leaves exist in Gmail — so that mail stays in the inbox too, rather than
being pushed into an invented "Other" folder.

`user_labels.facet_key` (`"entity=netflix|intent=payment-failed"`) is a folder's identity; the path
is only how it is spelled. Both planning **and applying** match on it, so **an existing folder keeps
its row and its `gmail_label_id`** instead of being recreated. That distinction is load-bearing:
writing by path instead would meet the existing row's key on the partial unique index
`user_labels_account_facet_key_unique_idx` and fail the whole apply the first time a value's
spelling changed. A folder whose combination is unchanged but whose spelling is not is updated in
place and its Gmail label **renamed**, which keeps the label id and therefore keeps the mail already
under it; creating a second label at the new spelling would strand every message beneath the old
one. A folder the tree planner created carries no facet key, so it is matched by path instead and
adopted rather than duplicated.

Folder names are unique among **siblings** rather than across the account, because a pivot repeats
its lower levels by construction; Gmail's own requirement is full-path uniqueness, which
`user_labels_account_path_unique_idx` enforces.

Apply only ever _creates_ leaf labels, or renames one it already owns. It never deletes a label and
never unlabels mail: folders that match no current combination are reported and left alone, because
deleting a Gmail label does not unlabel the mail beneath it. `scripts/unapply-pivot.ts` reverses a pivot against a snapshot from
`scripts/backup-before-pivot.ts`.

### Filing through the pivot

`facetFilingService.fileAccount` projects `message_facets` through the canonical pivot onto Gmail.
It spends **no tokens and makes no model call** — the classification is already stored — so
re-filing after a pivot or threshold change costs one Gmail call per message and not a single
re-classification.

The apply is **exclusive**: `applyExclusiveLabel` adds the new label and removes every other
MailMind label in the same `messages.modify`, because "exactly one MailMind label or none" is only
true if there is no window in which a message wears both. A message that now fits no folder has its
old label stripped and stays in the inbox, recorded as `NONE`.

A decision's confidence is the **weakest facet the folder actually rests on**, counting only the
facets the message was placed by: a message that landed at depth 1 under `["entity", "intent"]` was
placed by its entity alone, so an uncertain intent is not grounds to hold it for review. Below
`AUTOMATION_CONFIDENCE_THRESHOLD` the decision is recorded as `REVIEW_REQUIRED` and Gmail is not
called at all.

One `automation_message_actions` row per message, upserted, so re-filing replaces the previous
decision rather than accumulating a second one — which is also what makes `unapply-pivot.ts` able to
reverse exactly what was applied.

### Long-running work

`POST /api/gmail/sync/initial` and `POST /api/automation/run` return `202` with a run id. A full
backfill walks every page of the mailbox and a filing run classifies up to
`AUTOMATION_MAX_MESSAGES_PER_RUN` messages at `GEMINI_MIN_REQUEST_INTERVAL_MS` apiece — roughly
twenty minutes of wall clock at the free tier's pacing. No browser holds that, and a timeout used
to read as failure while the work quietly succeeded.

`activity_runs` is one record per operation across sync, proposal, and filing: kind, state,
progress counts, stop reason, error code, error message, and timestamps. Durability never depended
on the request — leases and checkpoints already meant a dropped connection lost no work — so the
record exists to say _why_ something ended.

- A partial unique index keeps one `RUNNING` run per account per kind, so a double-clicked button
  joins the run in flight rather than racing it.
- `expires_at` is the run's heartbeat, pushed out every time work reports progress. A run whose
  process died is reclaimed by the next start and marked `FAILED` with `RUN_ABANDONED`.
- `STOPPED` is a first-class ending, not an error: the run did what it could and quit for a reason.
- Sentry still owns exceptions. The run record owns the endings that are not exceptions.
- Failures are written from `AppError` messages, which are already user-facing; anything else is
  recorded as `INTERNAL_SERVER_ERROR` with a generic message, exactly like a 500 response.

Status and activity routes use `activityPollLimiter`, sized per second rather than per window,
because a client polls them every two seconds for as long as a run lasts.

### Daily automation

Stage 5 configuration is documented in [Stage 5 daily automation](stage-5-daily-automation.md).
Without `GEMINI_API_KEY`, automation remains unavailable without preventing the existing API from
starting. The scheduler starts only after Prisma connects and stops during graceful shutdown.
Provider and Gmail errors are logged
through safe structured fields; request bodies, tokens, secrets, and message content are excluded.

The classifier is Google Gemini (`GEMINI_MODEL`, default `gemini-flash-lite-latest`). Requests are
paced by `GEMINI_MIN_REQUEST_INTERVAL_MS` rather than driven into 429s, and cost accounting is
notional — the free tier bills nothing, but the provider computes micro-USD from Gemini's published
paid rates so `AUTOMATION_MAX_COST_MICRO_USD` still bounds a runaway run.

> **Free-tier data use.** On Google's **free** Gemini tier, submitted content may be used to
> improve Google's products. MailMind sends only bounded Gmail _metadata_ — subject, sender,
> truncated snippet, and state flags — never bodies, raw MIME, or attachments. That trade-off is
> acceptable for **single-user personal use only**. Before any third party's mail flows through
> this provider, move the project to a **paid** tier, where submitted content is not used that way.
> See <https://ai.google.dev/gemini-api/docs/pricing> (checked 2026-08-09).

## Request pipeline

Requests pass through:

1. Helmet security headers and optional trusted-proxy configuration.
2. Compression and structured request logging.
3. Exact-origin CORS with credentials.
4. Bounded JSON and URL-encoded parsers (1 MiB).
5. Signed cookie parsing.
6. Route-specific rate limiting, session authentication, and trusted-Origin checks.
7. Controllers, services, and repositories.
8. A centralized JSON error handler.

Mutating cookie-authenticated endpoints use `requireTrustedOrigin`. Browser requests with an
`Origin` outside the shared frontend allowlist receive `403 CSRF_ORIGIN_INVALID`. CORS likewise
permits only requests without an Origin or requests from an allowlisted origin; wildcard
credentialed CORS is not used.

The `mailmind_session` cookie is HttpOnly, has path `/`, uses the configured Secure, SameSite, and
optional Domain attributes, and expires after `REFRESH_SESSION_TTL_DAYS`. Clearing the cookie uses
the same attributes.

Production logs are JSON and redact authorization headers, cookies, OAuth codes/state, Google
tokens, session tokens, passwords, database URLs, and the token-encryption key.

## Modules

| Area                  | Main location                            | Responsibility                                         |
| --------------------- | ---------------------------------------- | ------------------------------------------------------ |
| Application/bootstrap | `src/app.ts`, `src/server.ts`            | Middleware, routes, startup, shutdown                  |
| Configuration/logging | `src/config`                             | Environment validation and redacted Pino logging       |
| Authentication        | `src/auth`, `src/sessions`               | Google login, opaque sessions, cookie lifecycle        |
| Google connection     | `src/integrations/google`                | Separate Gmail consent, encrypted tokens, revocation   |
| Gmail sync            | `src/integrations/gmail`                 | Labels, initial sync, history-based incremental sync   |
| Activity              | `src/features/activity`                  | Run records for long work, progress, and stop reasons  |
| Labels                | `src/features/labels`                    | Plan proposal, approval, rename, delete of the tree    |
| Taxonomy planner      | `src/features/label-discovery`           | Engine-only: planning, normalization, routing rules    |
| Gemini transport      | `src/integrations/gemini`                | Shared paced/retried JSON calls and cost accounting    |
| Daily automation      | `src/features/automation`                | Scheduler, Gemini, Gmail apply, budgets, review        |
| Persistence           | `src/repositories`, feature repositories | Account-scoped Prisma queries and leases               |
| Security              | `src/security`, `src/middleware`         | Encryption, hashing, safe redirects, CORS/CSRF, limits |
| Audit                 | `src/audit`                              | Security and user-action audit records                 |

Controllers validate transport input and delegate to services. Services enforce business rules and
privacy boundaries. Repositories own Prisma access and account scoping.

## Database and migrations

The Prisma schema is `apps/api/prisma/schema.prisma`. Ordered migrations are stored in
`apps/api/prisma/migrations`, with matching SQL copies under `supabase/migrations`:

1. `20260720022901_create_app_auth_schema`
2. `20260720224458_stage2_security_hardening`
3. `20260723162227_gmail_sync_foundation`
4. `20260723195408_ai_classification_pipeline`
5. `20260723203016_dynamic_label_discovery`
6. `20260726102117_daily_automation`
7. `20260726121553_account_scoped_tutorial`
8. `20260726181430_gmail_full_backfill_coverage`
9. `20260726210000_ai_automation_recovery`
10. `20260729090000_remove_classification_and_discovery_workflow`
11. `20260731090000_stage2_user_labels`
12. `20260809120000_gemini_automation_provider`
13. `20260820120000_semantic_taxonomy_tree`
14. `20260820150000_activity_runs`

The schema groups data into identity/session/audit records, connected Google credentials, Gmail
metadata and sync state, the approved `user_labels` tree, proposed taxonomy plans, and automation
settings/state/runs/actions plus learned patterns. Foreign-key cascades keep account-owned data
bounded. Migrations add database
constraints, indexes, privileges, and forced RLS that Prisma schema syntax cannot fully express.

Use `prisma migrate deploy` for non-development migration application. Do not use
`prisma migrate reset` against a shared or remote Supabase project.

## Health and operations

| Probe                   | Behavior                                                                                  |
| ----------------------- | ----------------------------------------------------------------------------------------- |
| `GET /health`           | Process liveness; returns 200 without querying PostgreSQL.                                |
| `GET /ready`            | Runs `select 1` with a five-second bound; returns 200 when ready or 503 when unavailable. |
| `GET /api/health`       | Prefixed liveness alias.                                                                  |
| `GET /api/health/ready` | Prefixed readiness alias.                                                                 |
| `GET /api/ready`        | Prefixed readiness alias.                                                                 |

The process connects to Prisma before it listens. A failed initial database connection exits with a
non-zero status. Readiness responses expose only dependency state, not connection details.

See [API reference](api.md) for endpoint contracts and [Architecture](architecture.md) for
cross-component data flow.
