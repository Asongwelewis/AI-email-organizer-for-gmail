# MailMind AI architecture

## Context and goals

MailMind AI is a human-in-the-loop Gmail organization MVP. It securely separates identity login
from optional Gmail access, synchronizes a bounded metadata projection, produces explainable
a proposed label set for explicit user approval, and files mail into exactly those labels. Daily
automation applies confident results while preserving human review for uncertainty.

The current architecture prioritizes:

- No Gmail access as a side effect of signing in.
- No storage of full message bodies, raw MIME, or attachment content.
- No Gmail label is created or applied until the user confirms the label set.
- Backend-only secrets and Google tokens.
- Account-scoped persistence, auditability, bounded work, and recoverable sync checkpoints.
- A deployable static frontend and a single stateless HTTP API backed by PostgreSQL.

## System view

```mermaid
flowchart LR
    U[User browser]
    W[React/Vite SPA]
    A[Express API]
    P[(PostgreSQL / Supabase)]
    G[Google OAuth and Gmail API]
    C[Gemini generateContent API]

    U --> W
    W -->|HTTPS JSON + HttpOnly cookie| A
    A -->|Prisma| P
    A -->|OAuth, metadata sync, label create/apply| G
    A -->|Bounded metadata, strict structured output| C
```

Only the API crosses the PostgreSQL, Google, and classifier trust boundaries. The SPA receives
application DTOs and never receives OAuth tokens or service credentials.

## Monorepo boundaries

| Workspace             | Role                                                                         |
| --------------------- | ---------------------------------------------------------------------------- |
| `apps/web`            | React SPA, protected navigation, user actions, and server-state presentation |
| `apps/api`            | HTTP API, business rules, OAuth, Gmail sync, labels, automation, persistence |
| `packages/shared`     | Application name, API prefix, shared types, and utilities                    |
| `packages/ui`         | Reusable React UI primitives                                                 |
| `packages/config`     | Shared TypeScript, ESLint, and Prettier configuration                        |
| `supabase/migrations` | Supabase-facing copies of the ordered SQL migrations                         |

The API follows a route/controller/service/repository layering convention:

```mermaid
flowchart LR
    R[Express routes and middleware] --> CT[Controllers and Zod transport validation]
    CT --> S[Domain services]
    S --> RP[Prisma repositories]
    RP --> DB[(PostgreSQL)]
    S --> EX[Google or classifier adapters]
```

Routes compose authentication, rate limits, and trusted-Origin checks. Controllers translate HTTP
input/output. Services enforce business and privacy rules. Repositories scope persistence to the
authenticated user’s connected account.

## Identity and Gmail authorization

Identity login and Gmail authorization are intentionally separate.

```mermaid
sequenceDiagram
    actor User
    participant Web
    participant API
    participant Google
    participant DB

    User->>Web: Choose Sign in
    Web->>API: GET /api/auth/google
    API->>DB: Store hashed, expiring LOGIN OAuth state
    API->>Google: Redirect for openid/email/profile
    Google->>API: Login callback
    API->>Google: Exchange code and verify identity
    API->>DB: Upsert user and opaque session
    API-->>Web: Set HttpOnly cookie and redirect
    User->>Web: Choose Connect Gmail
    Web->>API: GET /api/integrations/google/connect
    API->>DB: Store CONNECT_GMAIL state tied to user/session
    API->>Google: Redirect for Gmail consent
    Google->>API: Gmail callback
    API->>DB: Encrypt and store credentials
    API-->>Web: Redirect with safe status
```

OAuth state is hashed, single-use, purpose-specific, and expiring. PKCE verifier material and
Google tokens are encrypted with AES-GCM-compatible ciphertext/IV/auth-tag fields and a stored key
version. Sessions use random opaque tokens; only their hashes are persisted.

Disconnect attempts Google credential revocation, clears stored token material, and retains a
disconnected account record for status and audit history.

## Gmail synchronization

The API uses the Gmail modify scope because the MVP can explicitly initialize the three managed
labels `MailMind`, `MailMind/Processed`, and `MailMind/Needs Review`. Message synchronization itself
is read-only.

```mermaid
flowchart TD
    Start[User starts sync] --> Lease[Acquire account-scoped expiring lease]
    Lease --> Labels[List/upsert Gmail label metadata]
    Labels --> Kind{Initial or incremental?}
    Kind -->|Initial| List[List bounded message IDs]
    Kind -->|Incremental| History[Read Gmail history from checkpoint]
    List --> Fetch[Fetch format=metadata in bounded batches]
    History --> Fetch
    Fetch --> Store[Upsert metadata projection / mark deletions]
    Store --> Checkpoint[Commit counts and history checkpoint]
```

Stored message data includes Gmail message/thread/history identifiers, selected headers, a
truncated snippet, label identifiers, dates, boolean state signals, estimated size, and attachment
presence. The API does not fetch or persist full bodies, raw MIME, or attachments.

An initial sync is bounded by configuration. Incremental sync uses Gmail history IDs and reports an
expired checkpoint as a recoverable requirement for another initial sync. Each sync type uses a
database lease to prevent overlapping work across API instances.

## Label proposal and approval

The label set is the contract between the user and automation.

```mermaid
flowchart TD
    Sync[Synchronized metadata] --> Sample[Stratified sample, up to 500 messages]
    Sample --> Planner[One Gemini call: taxonomy planner]
    Planner --> Validate[Enforce depth 3, 40 leaves, naming, subject evidence]
    Validate --> Plan[(taxonomy_plans + nodes + rules)]
    Plan --> Review[User reviews the tree with counts]
    Review --> Confirm[POST /api/labels/confirm]
    Confirm --> Store[(user_labels tree)]
    Confirm --> Rules[(learned_classification_patterns)]
    Store --> Gmail[ensureLabel for leaves only]
```

One planning call designs a three-level tree of folders Gmail search cannot already produce: a
folder per sender is worthless next to `from:`, while an activity spanning many senders is not.
Model output is untrusted, so depth, the leaf ceiling, the minimum mail per folder, naming, and the
requirement that a state folder cite a subject pattern present in the sample are enforced in code
after parsing. Whatever fails is dropped and reported alongside the tree.

Plans are bounded by `AUTOMATION_MAX_LABELS` leaves and take the account's automation lease, so a
proposal never overlaps an automation run. Nothing reaches Gmail until confirmation, and then only
leaf paths. Deleting a folder removes only MailMind's record — the Gmail label and the mail
already under it stay.

## Daily automation

The scheduler and manual endpoint share one resumable service. Account leases prevent overlap;
scheduled account/date keys and unique message actions provide idempotency. Routing rules run
first and cost nothing: rules installed by an approved plan are authoritative, while rules learned
from applied mail are reused only after repeated, consistent successful applications. Only messages
no rule matches use Gemini, in bounded batches. Confident outcomes reuse an approved leaf path and
call Gmail `messages.modify`; uncertain outcomes enter a review queue.

Run records store counters, tokens, cached input, estimated micro-USD cost, stop reason, and safe
error codes. Message actions store the chosen label name, evidence, and retry state. A message that
fits no approved label is recorded as a skipped action and left in the inbox; automation never
invents a label outside the proposal flow. An existing backlog of synchronized mail is filed
oldest-first across as many runs as the daily budget requires. External calls occur
outside database transactions, so partial work remains durable and recoverable.

## Data architecture

The main relational groups are:

| Group                 | Tables                                                                                                                         |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Identity and security | `users`, `sessions`, `oauth_states`, `audit_logs`                                                                              |
| Google connection     | `connected_google_accounts`                                                                                                    |
| Gmail projection      | `gmail_labels`, `gmail_message_metadata`, `gmail_sync_states`, `gmail_sync_runs`                                               |
| Labels                | `user_labels`, `taxonomy_plans`, `taxonomy_plan_nodes`, `taxonomy_plan_node_rules`                                             |
| Daily automation      | `automation_settings`, `automation_states`, `automation_runs`, `automation_message_actions`, `learned_classification_patterns` |

State tables contain one account-scoped lease/checkpoint row. Run tables retain bounded operational
history. Results and decisions retain explainability and user intent. Foreign keys cascade
account-owned data, while merge targets use restrictive deletion semantics.

Database migrations enable and force RLS on application tables and remove direct table privileges
from `PUBLIC`, `anon`, and `authenticated`. The backend connects using its dedicated database role;
the browser does not query Supabase directly.

## Security architecture

- Exact frontend-origin CORS with credentials; no wildcard.
- Trusted-Origin validation on cookie-authenticated mutations.
- HttpOnly session cookie, Secure required in production, configurable SameSite and Domain.
- Matching attributes for cookie set and clear.
- OAuth state, PKCE, purpose binding, safe redirect paths, and separate callbacks.
- Encrypted Google token material with key versioning.
- Hashed session tokens and privacy-preserving IP handling.
- Helmet headers, 1 MiB request limits, endpoint-specific rate limits, and request IDs.
- Structured production logs with secret redaction.
- Generic 500 responses and safe readiness output.
- Forced RLS and least-privilege database grants.

## Runtime and deployment shape

The web application compiles to static files in `apps/web/dist`. The API compiles to Node.js ESM in
`apps/api/dist`, reads `PORT`, connects Prisma before listening, and handles graceful termination.
Liveness is independent of the database; readiness performs a database query with a five-second
timeout.

The API is stateless apart from PostgreSQL-backed sessions, OAuth state, checkpoints, and leases, so
multiple instances can share the database. Daily work is initiated by an in-process poller and can
also be triggered manually.

## Current boundaries and trade-offs

- The deployed frontend origins and `WEB_APP_URL` form the shared CORS and CSRF allowlist. Adding
  another frontend requires updating that shared configuration.
- Automation uses an in-process scheduler. A larger deployment may move the same lease-protected
  service behind a durable queue without changing message idempotency.
- Gmail modify scope supports automation label writes; label proposal and approval remain
  non-mutating.
- The legal pages are placeholders in the current router, and `/support` and `/data-deletion` are
  not implemented.
- `API_BASE_URL` and both OAuth callback URIs are explicit configuration, keeping provider URLs out
  of source code.

See [Backend](backend.md), [Frontend](frontend.md), and [API reference](api.md) for implementation
details.
