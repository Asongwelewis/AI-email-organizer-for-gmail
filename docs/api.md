# MailMind AI API reference

## Conventions

The primary API base path is `/api`. Examples below assume:

```text
http://localhost:4000/api
```

Responses use JSON except OAuth start/callback endpoints, which redirect. Authentication uses the
HttpOnly `mailmind_session` cookie; there is no browser-visible bearer token. Browser clients must
send credentials.

Example:

```bash
curl --include \
  --cookie cookie.txt \
  --header "Origin: http://localhost:5173" \
  http://localhost:4000/api/auth/me
```

Cookie-authenticated mutations validate `Origin` when it is present. It must exactly match the
backend `WEB_APP_URL`. OAuth endpoints and feature groups also have endpoint-specific rate limits.

Errors have one stable envelope:

```json
{
  "error": {
    "code": "SOME_ERROR_CODE",
    "message": "A safe user-facing message."
  }
}
```

Common statuses are `400` validation failure, `401` missing/expired session, `403` denied Origin,
`404` missing account-scoped resource, `409` invalid state or active lease conflict, `422`
insufficient eligible data, `429` rate limit, and `500` unexpected failure.

## Health

### `GET /health`

Unprefixed liveness probe. `GET /api/health` is the prefixed equivalent.

```json
{
  "status": "ok",
  "service": "MailMind AI",
  "timestamp": "2026-07-23T20:00:00.000Z"
}
```

### `GET /ready`

Unprefixed database readiness probe. `GET /api/ready` and `GET /api/health/ready` are aliases.
Returns 200 when PostgreSQL responds or 503 after a failure/its five-second timeout.

```json
{
  "status": "ready",
  "service": "MailMind AI",
  "dependencies": { "database": "up" },
  "timestamp": "2026-07-23T20:00:00.000Z"
}
```

Unavailable response:

```json
{
  "status": "unavailable",
  "service": "MailMind AI",
  "dependencies": { "database": "down" },
  "timestamp": "2026-07-23T20:00:00.000Z"
}
```

## Authentication

### `GET /api/auth/google`

Starts Google identity login for `openid`, `email`, and `profile`. Optional query:

- `redirect` — safe frontend path used after login; unsafe/external paths are rejected.

Returns an HTTP redirect to Google. No session is required.

### `GET /api/auth/google/callback`

Google identity callback configured by `GOOGLE_LOGIN_REDIRECT_URI`. The API consumes the one-time
OAuth state, exchanges the code, verifies identity, creates an opaque session, sets the session
cookie, and redirects to the frontend. Query values are supplied by Google.

### `GET /api/auth/me`

Requires a session.

```json
{
  "user": {
    "id": "00000000-0000-4000-8000-000000000001",
    "email": "person@example.com",
    "displayName": "Example Person",
    "avatarUrl": null,
    "status": "ACTIVE",
    "gmailConnected": false,
    "tutorialCompletedAt": null
  }
}
```

### `POST /api/auth/refresh`

Rotates a valid session token and resets the session cookie. Requires trusted Origin. Returns the
session user:

```json
{
  "user": {
    "id": "00000000-0000-4000-8000-000000000001",
    "email": "person@example.com",
    "displayName": "Example Person",
    "avatarUrl": null,
    "status": "ACTIVE"
  }
}
```

### `POST /api/auth/logout`

Revokes the current session when present and clears the cookie. Requires trusted Origin.

```json
{ "success": true }
```

### `POST /api/auth/logout-all`

Requires a session and trusted Origin. Revokes all sessions for the current user and clears the
cookie.

### `POST /api/auth/tutorial/complete`

Requires a session and trusted Origin. New accounts have `tutorialCompletedAt: null` in
`GET /api/auth/me`. Send `{ "decision": "COMPLETED" }` after the final tutorial step or
`{ "decision": "SKIPPED" }` when the user chooses Skip. The idempotent response contains
`success: true` and `tutorialCompletedAt`; no tutorial content or email data is stored.

```json
{
  "success": true,
  "tutorialCompletedAt": "2026-07-26T12:30:00.000Z"
}
```

## Google/Gmail connection

Login and Gmail consent are separate flows.

### `GET /api/integrations/google/connect`

Requires a session. Starts Gmail authorization using identity scopes plus
`https://www.googleapis.com/auth/gmail.modify`. Optional `redirect` is a safe frontend path.
Returns an HTTP redirect to Google.

### `GET /api/integrations/google/callback`

Google Gmail-consent callback configured by `GOOGLE_GMAIL_REDIRECT_URI`. It consumes account-bound
OAuth state, encrypts received credentials, records connection state, and redirects to the
frontend.

### `GET /api/integrations/google/status`

Requires a session.

```json
{
  "connected": true,
  "email": "person@gmail.com",
  "status": "CONNECTED",
  "grantedScopes": ["openid", "email", "profile", "https://www.googleapis.com/auth/gmail.modify"],
  "requiresReauthentication": false,
  "connectedAt": "2026-07-23T20:00:00.000Z",
  "updatedAt": "2026-07-23T20:00:00.000Z"
}
```

`status` is one of `CONNECTED`, `REAUTH_REQUIRED`, `REVOKED`, `DISCONNECTED`, or `ERROR`.

### `POST /api/integrations/google/disconnect`

Requires a session and trusted Origin. Attempts credential revocation, removes stored token
material, and marks the connection disconnected.

```json
{ "success": true }
```

## Gmail metadata and synchronization

All endpoints require a session and an active Gmail connection. Mutations also require trusted
Origin.

### `GET /api/gmail/profile`

Loads the connected Gmail profile.

```json
{
  "emailAddress": "person@gmail.com",
  "messagesTotal": 1250,
  "threadsTotal": 900,
  "historyId": "123456"
}
```

### `GET /api/gmail/labels`

Lists Gmail labels and marks the three labels managed by MailMind.

```json
{
  "labels": [
    {
      "id": "Label_1",
      "name": "MailMind",
      "type": "user",
      "managed": true
    }
  ]
}
```

### `GET /api/gmail/sync/status`

```json
{
  "status": "READY",
  "initialSyncCompleted": true,
  "lastSuccessfulSyncAt": "2026-07-23T20:00:00.000Z",
  "lastErrorCode": null,
  "nextRetryAt": null,
  "messageCount": 250,
  "syncRunning": false
}
```

`status` is `NOT_STARTED`, `INITIAL_SYNC_RUNNING`, `READY`, `INCREMENTAL_SYNC_RUNNING`,
`LABEL_SYNC_RUNNING`, `FAILED`, `REAUTH_REQUIRED`, or `HISTORY_EXPIRED`.

### `POST /api/gmail/labels/initialize`

Creates missing managed Gmail labels and synchronizes label metadata.

```json
{ "success": true, "labelsUpserted": 14 }
```

### `POST /api/gmail/sync/initial`

Runs a configuration-bounded initial metadata sync.

```json
{
  "success": true,
  "messagesExamined": 250,
  "messagesUpserted": 250,
  "messagesDeleted": 0,
  "labelsUpserted": 14,
  "checkpointHistoryId": "123456",
  "messageCount": 250
}
```

### `POST /api/gmail/sync/incremental`

Applies changes after the saved Gmail history checkpoint. Uses the same response as initial sync.
Returns `409 GMAIL_INITIAL_SYNC_REQUIRED` without an initial checkpoint or
`409 GMAIL_HISTORY_EXPIRED` when a new initial sync is needed.

## Labels

All endpoints require a session; mutations require a trusted Origin. The approved folder tree is the
only vocabulary automation may use, and nothing is created in Gmail until the user confirms a plan.

### `GET /api/labels`

Returns the approved folder tree plus the plan awaiting review, if any. Sends `Cache-Control:
no-store`. Labels are flat with `parentId`/`depth`; `path` is the joined ancestor chain and
`fullPath` prefixes it with `MailMind/`.

```json
{
  "maxLabels": 40,
  "maxDepth": 3,
  "labels": [
    {
      "id": "00000000-0000-4000-8000-000000000010",
      "parentId": null,
      "depth": 1,
      "leafName": "Job hunt",
      "fullPath": "MailMind/Job hunt",
      "path": "Job hunt",
      "isLeaf": false,
      "rationale": "Job search mail arrives from many unrelated senders.",
      "source": "AI_PROPOSED",
      "gmailLabelId": null,
      "createdAt": "2026-08-20T09:00:00.000Z"
    }
  ],
  "plan": null
}
```

Only leaves carry a `gmailLabelId`: Gmail nesting is cosmetic, so `MailMind/Job hunt/Applications
sent` is one Gmail label whose name contains slashes, and the intermediate rows exist only here.

### `POST /api/labels/propose`

Samples up to `TAXONOMY_SAMPLE_SIZE` stored messages, spends one Gemini call to design the tree,
validates the result, and stores it as the account's pending plan. **Creates nothing in Gmail.**
Returns the same shape as `GET /api/labels`, with `plan` populated:

```json
{
  "plan": {
    "id": "00000000-0000-4000-8000-000000000020",
    "status": "PENDING",
    "model": "gemini-flash-lite-latest",
    "promptVersion": "mailmind-taxonomy-planner-v1",
    "sampledMessageCount": 500,
    "analyzedMessageCount": 596,
    "leafCount": 18,
    "warnings": [
      "Dropped \"Job hunt/Offers\": it is a state folder with no subject pattern present in the sample."
    ],
    "createdAt": "2026-08-20T09:00:00.000Z",
    "nodes": [
      {
        "id": "00000000-0000-4000-8000-000000000021",
        "parentId": "00000000-0000-4000-8000-000000000020",
        "depth": 2,
        "kind": "TOPIC",
        "name": "Applications sent",
        "fullPath": "MailMind/Job hunt/Applications sent",
        "path": "Job hunt/Applications sent",
        "rationale": "Confirmations that an application reached a company.",
        "estimatedMessageCount": 25,
        "matchedMessageCount": 12,
        "rolledUpMessageCount": 18,
        "isLeaf": false,
        "gmailLabelPath": null,
        "rules": [{ "kind": "SENDER_DOMAIN", "value": "greenhouse.io", "matchedMessageCount": 6 }]
      }
    ]
  }
}
```

`estimatedMessageCount` is the planner's estimate for the whole mailbox; `matchedMessageCount` is
what this node's own rules actually matched in the sample, and `rolledUpMessageCount` includes its
subtree. `warnings` lists every node and rule the validator rejected, so the review shows what the
model asked for and did not get.

A new proposal supersedes the previous pending plan and never touches approved folders or Gmail.

| Code                             | Status | Meaning                                               |
| -------------------------------- | ------ | ----------------------------------------------------- |
| `GMAIL_ACCOUNT_NOT_CONNECTED`    | 409    | Gmail is not connected for this user.                 |
| `LABEL_PROPOSAL_ALREADY_RUNNING` | 409    | A proposal or automation run holds the account lease. |
| `LABEL_PROPOSAL_NOT_ENOUGH_MAIL` | 422    | Too little synchronized mail to plan from.            |
| `LABEL_PLAN_EMPTY`               | 422    | No proposed folder survived validation.               |
| `PROVIDER_INVALID_RESPONSE`      | 502    | The model returned an unusable taxonomy.              |

### `POST /api/labels/confirm`

Either approves a proposed tree:

```json
{ "planId": "00000000-0000-4000-8000-000000000020" }
```

Omit `nodeIds` to approve the whole tree, or pass a subset - selecting a node implicitly selects the
ancestors it needs. Approval writes each node to `user_labels`, creates **only the leaves** in Gmail
at their full path, and installs the plan's routing rules into `learned_classification_patterns` so
automation can file matching mail with no model call.

Or creates folders by hand:

```json
{
  "labels": [
    { "leafName": "Money in", "source": "USER_CREATED" },
    {
      "leafName": "Applications sent",
      "parentId": "00000000-0000-4000-8000-000000000010",
      "source": "USER_CREATED"
    }
  ]
}
```

Each name is validated with the preserved normalization rules: 2-60 characters, no slashes or
control characters, no reserved Gmail name, and nothing generic. Names too similar to each other or
to an already approved folder are rejected. Returns the same shape as `GET /api/labels`.

| Code                        | Status | Meaning                                               |
| --------------------------- | ------ | ----------------------------------------------------- |
| `LABEL_VALIDATION_FAILED`   | 400    | The request body matches neither accepted shape.      |
| `LABEL_NAME_INVALID`        | 400    | A name is generic, malformed, reserved, or too deep.  |
| `LABEL_SET_EMPTY`           | 400    | No labels were supplied.                              |
| `LABEL_DUPLICATE`           | 409    | Two names are too similar to keep both.               |
| `LABEL_LIMIT_REACHED`       | 409    | Approval would exceed `AUTOMATION_MAX_LABELS` leaves. |
| `LABEL_PLAN_NOT_FOUND`      | 404    | No such plan for this account.                        |
| `LABEL_PLAN_NOT_PENDING`    | 409    | That plan was already reviewed.                       |
| `LABEL_PLAN_NODE_NOT_FOUND` | 404    | A selected node is not part of that plan.             |

### `PATCH /api/labels/:id`

Body `{ "leafName": "Job search" }`. Renames the folder in MailMind and rewrites the path of every
folder beneath it. Because a Gmail label's name is its whole path, every descendant that exists in
Gmail is renamed too. Rejects a name that collides with another approved folder (409).

### `DELETE /api/labels/:id`

Removes MailMind's record so automation stops using the folder, along with its descendants. The
Gmail labels and every message already filed under them are left untouched.

```json
{ "success": true, "gmailLabelRetained": true, "removedDescendants": 2 }
```

## Daily automation

All endpoints require a session; mutations require a trusted Origin. Status and review responses
send `Cache-Control: no-store`.

- `GET /api/automation/status` returns Gmail connection/reauthorization state, scheduler state,
  last-run counters/errors, today’s token and cost usage, configured limits, pending review count,
  `approvedLabelCount`/`labelsReady`, and `backlogRemaining` for an in-progress backfill.
- `POST /api/automation/run` performs a manual resumable run and returns `runId` plus
  `COMPLETED`, `PARTIAL`, or `FAILED` status. Returns `409 AUTOMATION_NO_APPROVED_LABELS` when the
  account has not confirmed any label yet.
- `GET /api/automation/review` returns uncertain results, each carrying the proposed `labelName`.
  It never includes OAuth or provider credentials.
- `POST /api/automation/review/:id/approve` accepts `{ "labelName": "Invoices" }`, validated against
  the account's approved labels (`400 AUTOMATION_LABEL_NOT_APPROVED` otherwise), applies that Gmail
  label, and teaches the sender pattern.
- `POST /api/automation/review/:id/skip` resolves the item without modifying Gmail.

A run applies routing rules first: every message a rule matches is filed with no model call, and
only the remainder is batched to Gemini. A run files each message into exactly one approved folder.
A message that fits none of them is
recorded as a skipped action and left in the inbox — automation never invents a label. When
unprocessed synchronized mail predates automation, runs drain that backlog oldest-first across as
many runs as the daily budget requires.

## Privacy boundary

API response examples use fabricated identifiers and values. The implemented Gmail sync consumes a
metadata projection, selected headers, and snippets. Full bodies, raw MIME, and attachment content
are not fetched or returned. External classifier processing, when explicitly enabled, receives a
normalized and size-bounded metadata input; credentials remain backend-only.
