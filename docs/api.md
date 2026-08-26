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

**Accepts** a full initial metadata sync and returns `202`. The backfill walks every page of the
mailbox, which no browser will hold a request open for, so the client polls
`GET /api/activity/runs/:id` from here.

```json
{
  "runId": "00000000-0000-4000-8000-000000000030",
  "state": "RUNNING",
  "kind": "GMAIL_INITIAL_SYNC",
  "startedAt": "2026-08-20T02:00:00.000Z",
  "alreadyRunning": false
}
```

`alreadyRunning: true` means this call joined a backfill already in flight instead of starting a
second one. Progress arrives on the run record as `processedCount` / `totalCount`, and on
`GET /api/gmail/sync/status` as the `backfill` block. The sync is resumable either way: leases and
per-page checkpoints mean a dropped connection or a restarted server loses no work.

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

## Facets and the pivot

A message carries three orthogonal facets, and a folder tree is a **view** of them. These routes
operate that pipeline: classify mail into facets, choose which ordering is materialised, preview
any ordering, and project the canonical one onto Gmail.

Every route requires a session. The two that spend a quota and the two that write take the
trusted-Origin check.

### `POST /api/facets/classify`

**202.** Classifies mail that has no facets yet, or whose facets were derived from input that has
since changed. Thousands of paced Gemini calls, so it answers with a run id to poll at
`GET /api/activity/runs/:id` rather than holding the request.

```json
{ "runId": "…", "state": "RUNNING", "kind": "FACET_CLASSIFICATION", "alreadyRunning": false }
```

Resumable by construction: the `message_facets` row is the checkpoint, so a run stopped by a spent
quota picks up where it left off and no message is classified twice.

### `POST /api/facets/file`

**202.** Projects stored facets onto Gmail through the canonical pivot. **Opt-in, and off by
default** — `503 GMAIL_WRITE_DISABLED` unless `GMAIL_WRITE_ENABLED` is set. Spends **no tokens and
makes no model call** — the classification is already stored — so re-filing after a pivot or
threshold change costs one Gmail call per message and not a single re-classification. The apply is
exclusive: the new label goes on and every other MailMind label comes off in the same
`messages.modify`.

### `GET /api/facets/pivot`

The account's canonical ordering and the folder floor.

```json
{ "canonicalPivot": ["entity", "intent"], "minMessages": 5 }
```

### `PUT /api/facets/pivot`

Changes which ordering is canonical. **Writes nothing to Gmail** — the tree only moves when
`apply` is called, which is what makes trying an ordering out safe.

```json
{ "canonicalPivot": ["domain", "intent", "entity"], "minMessages": 8 }
```

`400 FACET_VALIDATION_FAILED` if the ordering is empty, names a facet twice, or names something
that is not `entity`, `domain` or `intent`. A pivot is an order of **distinct** facets: repeating
one is not a deeper tree, it is the same level twice.

### `GET /api/facets/pivot/plan`

What applying the canonical pivot would do, without doing it. Every node with `KEEP` or `CREATE`,
the folders that match no current combination (`orphaned`), and how many Gmail labels would be
created. Nothing is written and Gmail is not called.

### `GET /api/facets/pivot/view?order=domain,intent,entity&minMessages=3`

Any ordering at all, materialised or not — the same facet rows arranged differently, computed from
`message_facets` with no Gmail call and no model call. `Netflix > Payment failed` and
`Finance > Payment failed > Netflix` are the same mail, reordered, with nothing reclassified. Both
parameters are optional and fall back to the account's settings.

### `GET /api/facets/messages?facetKey=entity%3Dnetflix%7Cintent%3Dpayment-failed`

The mail inside one folder, newest first. A folder **is** a facet combination, so this is keyed by
that combination rather than by a `user_labels` row — it works whether or not a pivot was ever
applied to Gmail, which is what lets the PWA be the folder view rather than a reflection of one.

**Subtree semantics.** `entity=netflix` returns every Netflix message, including the ones the pivot
placed deeper under `Payment failed`. `buildPivot` puts a message at its deepest surviving leaf
because a message wears one label; a person opening a parent folder is asking "everything under
here", and that is what comes back.

Metadata only — subject, sender, date, the stored snippet, and the Gmail id the deep link
addresses. Never a body.

```json
{
  "messages": [{ "id": "…", "gmailMessageId": "18f0abc", "subject": "…", "senderName": "…" }],
  "nextCursor": "…",
  "total": 1823
}
```

`limit` defaults to 50 and caps at 200; `cursor` is the previous page's `nextCursor`. One
combination in a real mailbox holds 1,823 messages, so a folder pages.

`400 FACET_VALIDATION_FAILED` if the key is not a facet combination. A key constraining nothing
would hand back the entire mailbox under a folder heading, so the shape is checked before it
reaches a query.

### `GET /api/facets/search?q=payment%20failed&intent=payment-failed&entity=netflix`

Subject and sender across the **whole mailbox**, narrowed by any combination of facets. No model
call and no Gmail call — Postgres full text over metadata the sync already stored, so there is no
body here to search and there never will be.

`intent=payment-failed` on its own is the thing a Gmail label tree genuinely cannot do: one intent
across every brand at once, because facets are orthogonal and a tree can only express one ordering
of them. `q` on its own searches mail that has never been classified too, which is exactly the mail
a person is most likely to be hunting for.

```json
{
  "query": "payment failed",
  "filters": { "entity": "netflix", "domain": null, "intent": null },
  "order": ["domain", "intent", "entity"],
  "results": [
    {
      "id": "…",
      "gmailMessageId": "18f0abc",
      "subject": "Your payment failed",
      "senderEmail": "billing@netflix.com",
      "entity": "netflix",
      "intent": "payment-failed",
      "folder": {
        "facetKey": "…",
        "fullPath": "MailMind/Netflix/Payment failed",
        "leafName": "Payment failed"
      }
    }
  ],
  "total": 3,
  "nextCursor": null
}
```

Every hit carries the folder it sits in under `order` (the account's saved ordering unless the
query names another) — "it was under Finance all along" is half the answer. `folder` is null for
mail in no folder: unclassified, or in a combination below the floor.

The address is split on punctuation on both sides of the match, so `netflix` finds
`billing@netflix.com` and pasting the whole address finds it too. Matching is `simple`, not
`english`: the vocabulary is brand names, order numbers and subject lines, and stemming _Coursera_
buys nothing while costing exact matches.

`limit` defaults to 50 and caps at 200; `cursor` is the previous page's `nextCursor`.

`400 FACET_VALIDATION_FAILED` when the query constrains nothing — a search with neither a phrase
nor a facet is the mailbox, not a search — or when a facet value is not one.

### `GET /api/facets/vocabulary/status`

The vocabulary this mailbox approved, any pending proposal, and whether the classifier can run at
all.

```json
{
  "approved": { "domain": [{ "name": "finance", "definition": "…" }], "intent": [] },
  "proposed": { "domain": [], "intent": [] },
  "ready": false
}
```

### `POST /api/facets/vocabulary/propose`

Grounds a candidate vocabulary in this mailbox's **own** mail — which of its values the mailbox
actually contains, roughly how much, and with which subjects — and records the result as a
proposal. One Gemini call. It writes nothing the classifier can read.

The candidate is the account's own approved set when it has one, so re-proposing measures how well
the current vocabulary still fits. A mailbox with nothing approved is offered the checked-in
starter set as a **starting point, not an inheritance**: values that fit nothing in this mailbox
come back at zero weight with no examples, which is exactly the signal for dropping them before
approving.

### `POST /api/facets/vocabulary/confirm`

The human approval, and the only step after which the classifier speaks differently.

```json
{ "values": [{ "facet": "domain", "name": "finance", "definition": "Banking, payments, …" }] }
```

Replaces the approved set rather than merging into it: a vocabulary is a closed set the model
chooses from, so a value left out has to stop being returnable. Mail already classified is not
touched — `prompt_version` carries a fingerprint of the vocabulary, so affected messages simply
read as stale and re-classify on the next pass instead of vanishing from their folders.

`422 FACET_VOCABULARY_EMPTY` when either axis would be left with no values.

Until a vocabulary is approved, `POST /api/facets/classify` and the daily run answer
`409 FACET_VOCABULARY_NOT_APPROVED`. There is no default to fall back to: "career, development,
education" describes one person's life, and classifying a second mailbox against it would file that
person's mail into a stranger's taxonomy.

### `GET /api/facets/vocabulary`

What there is to filter by, with how much mail sits behind each value. `entity` is derived from
senders so it is whatever this mailbox contains, commonest first; `domain` and `intent` are the
approved closed vocabularies, and every value appears even at zero, because a filter that hides its
own empty options makes the vocabulary look smaller than it is.

```json
{
  "entity": [{ "value": "netflix", "messageCount": 330 }],
  "domain": [{ "value": "finance", "messageCount": 812 }],
  "intent": [{ "value": "payment-failed", "messageCount": 9 }]
}
```

### `POST /api/facets/pivot/apply`

Writes the canonical pivot into `user_labels` and creates the missing **leaf** paths in Gmail.
Answers inline: this is bounded by the number of folders, which is tens, not by the number of
messages.

**Opt-in, and off by default.** This and `POST /api/facets/file` are the only two routes that
create or move anything in a real mailbox, and both answer `503 GMAIL_WRITE_DISABLED` unless
`GMAIL_WRITE_ENABLED` is set. The PWA builds its folders from `message_facets` and a message's deep
link addresses it by id, so nothing a person sees depends on a Gmail label; writing them is the
export path for someone who also wants the tree in Gmail's own sidebar.

`user_labels.facet_key` is a folder's identity and the path is only how it is spelled, so
re-applying keeps an existing row and its `gmail_label_id`. A folder whose combination survived a
spelling change is renamed rather than recreated, which keeps the mail already under it.

It **never deletes**. Folders that match no current combination come back in `orphaned` for a
person to decide about, because deleting a Gmail label does not unlabel the mail beneath it.

## Daily automation

All endpoints require a session; mutations require a trusted Origin. Status and review responses
send `Cache-Control: no-store`.

- `GET /api/automation/status` returns Gmail connection/reauthorization state, scheduler state,
  last-run counters/errors, today’s token and cost usage, configured limits, pending review count,
  `approvedLabelCount`/`labelsReady`, and `backlogRemaining` for an in-progress backfill.
- `POST /api/automation/run` **accepts** a manual resumable run and returns `202` with
  `{ runId, state: "RUNNING", kind, startedAt, alreadyRunning }`. The run syncs the mailbox and
  then classifies in paced Gemini batches, so the client polls `GET /api/activity/runs/:id` rather
  than holding the request open. `alreadyRunning: true` means this call joined a run already in
  flight instead of starting a second one. Preconditions the caller can act on are still checked
  before accepting: `409 AUTOMATION_NO_APPROVED_LABELS` when no label is confirmed,
  `503 AUTOMATION_DISABLED` or `503 AUTOMATION_NOT_CONFIGURED` when the feature is off. Everything
  else — a rate limit, the daily budget, a provider outage — ends up on the run record.
  A run classifies and stops there: filing is opt-in behind `GMAIL_WRITE_ENABLED` and off by
  default, so what runs unattended writes nothing into the mailbox. Mail classified tonight is in
  its folder tonight, because the folder is a view of `message_facets`.
- `GET /api/automation/gaps` groups the messages recorded as fitting no approved folder, by sending
  domain and by subject shape, and returns the clusters large enough to justify a folder as
  `{ analyzedCount, clusteredCount, clusters[] }`. Each cluster carries the `kind`/`value` of the
  rule that would route it, a `messageCount`, sample subjects, and a mechanically derived
  `suggestedName`. Read-only, and no model is called: turning a cluster into a folder still goes
  through `POST /api/labels/confirm` like any other.
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

## Activity runs

Work that outlives a request — a full mailbox backfill, a filing run — is started with `202` and a
run id, then polled here. Both endpoints require a session and send `Cache-Control: no-store`.

A run's `state` is one of:

| State       | Meaning                                                                         |
| ----------- | ------------------------------------------------------------------------------- |
| `RUNNING`   | In flight. Poll again.                                                          |
| `SUCCEEDED` | Finished everything it set out to do.                                           |
| `STOPPED`   | Did real work and quit for a reason: `stopReason` and `errorMessage` say which. |
| `FAILED`    | Ended on an error. `errorCode` and `errorMessage` are always set.               |

`STOPPED` is not a failure. Hitting the daily Gemini budget or a provider rate limit ends a run
that filed everything it could; the rest resumes on the next run from its checkpoints.

### `GET /api/activity/runs`

`?limit=` accepts 1-100 and defaults to 20. Newest first.

```json
{
  "runs": [
    {
      "id": "00000000-0000-4000-8000-000000000030",
      "kind": "AUTOMATION_FILING",
      "state": "STOPPED",
      "trigger": "SCHEDULED",
      "processedCount": 120,
      "totalCount": 250,
      "counts": { "messagesLabeled": 118, "reviewRequired": 6, "failed": 2 },
      "stopReason": "DAILY_BUDGET_REACHED",
      "errorCode": null,
      "errorMessage": "This run stopped at the daily Gemini budget. Everything filed so far is saved and the rest continues on the next run.",
      "featureRunId": "00000000-0000-4000-8000-000000000031",
      "startedAt": "2026-08-20T02:00:00.000Z",
      "finishedAt": "2026-08-20T02:04:00.000Z",
      "durationMs": 240000
    }
  ]
}
```

`kind` is one of `GMAIL_INITIAL_SYNC`, `GMAIL_INCREMENTAL_SYNC`, `GMAIL_LABEL_SYNC`,
`LABEL_PROPOSAL`, `AUTOMATION_FILING`. `counts` carries that kind's own counters; `featureRunId`
points at the feature's detailed record (`gmail_sync_runs` or `automation_runs`).

### `GET /api/activity/runs/:id`

The same object for one run, or `404 ACTIVITY_RUN_NOT_FOUND` when it belongs to another account.

| Code                         | Status | Meaning                           |
| ---------------------------- | ------ | --------------------------------- |
| `ACTIVITY_VALIDATION_FAILED` | 400    | The limit or run id is not valid. |
| `ACTIVITY_RUN_NOT_FOUND`     | 404    | No such run for this account.     |

## Privacy boundary

API response examples use fabricated identifiers and values. The implemented Gmail sync consumes a
metadata projection, selected headers, and snippets. Full bodies, raw MIME, and attachment content
are not fetched or returned. External classifier processing, when explicitly enabled, receives a
normalized and size-bounded metadata input; credentials remain backend-only.
