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
    "gmailConnected": false
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

```json
{ "success": true, "revokedSessions": 3 }
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

## Classification

All endpoints require a session. Mutations require trusted Origin. Classification operates on
stored metadata and creates recommendations only.

Categories:

`PRIMARY`, `WORK`, `FINANCE`, `RECEIPTS`, `ORDERS`, `TRAVEL`, `EDUCATION`, `NEWSLETTERS`,
`PROMOTIONS`, `SOCIAL`, `NOTIFICATIONS`, `SECURITY`, `SUPPORT`, `PERSONAL`, `SPAM_SUSPECTED`,
`OTHER`.

Recommended actions:

`KEEP_IN_INBOX`, `ARCHIVE_RECOMMENDED`, `REVIEW_REQUIRED`, `IMPORTANT_RECOMMENDED`,
`MUTE_RECOMMENDED`, `UNSUBSCRIBE_CANDIDATE`.

### `GET /api/classification/status`

Returns provider state, counts, latest run, distributions, and version identifiers.

```json
{
  "enabled": true,
  "provider": "external",
  "model": "configured-model",
  "running": false,
  "activeRunId": null,
  "classifiedCount": 120,
  "reviewRequiredCount": 8,
  "lastClassifiedAt": "2026-07-23T20:00:00.000Z",
  "lastErrorCode": null,
  "latestRun": {
    "id": "00000000-0000-4000-8000-000000000010",
    "status": "COMPLETED",
    "requestedMessageCount": 20,
    "processedMessageCount": 20,
    "reusedResultCount": 5,
    "ruleClassifiedCount": 10,
    "aiClassifiedCount": 5,
    "reviewRequiredCount": 2,
    "failedCount": 0
  },
  "categoryDistribution": { "WORK": 30, "RECEIPTS": 15 },
  "recommendationDistribution": { "KEEP_IN_INBOX": 30 },
  "versions": {
    "classifier": "version-string",
    "prompt": "version-string",
    "taxonomy": "version-string"
  }
}
```

### `GET /api/classification/results`

Cursor-paginated results. Query parameters:

| Parameter           | Rules                                                             |
| ------------------- | ----------------------------------------------------------------- |
| `category`          | One category listed above                                         |
| `recommendedAction` | One recommended action listed above                               |
| `requiresReview`    | `true` or `false`                                                 |
| `status`            | `PENDING`, `COMPLETED`, `FAILED`, `NEEDS_REVIEW`, or `SUPERSEDED` |
| `cursor`            | Result UUID returned as `nextCursor`                              |
| `limit`             | Integer 1–50; default 20                                          |

```json
{
  "results": [
    {
      "id": "00000000-0000-4000-8000-000000000020",
      "messageId": "00000000-0000-4000-8000-000000000021",
      "message": {
        "subject": "Your receipt",
        "sender": "Example Store",
        "senderDomain": "store.example",
        "snippet": "Thanks for your order...",
        "gmailLabels": ["INBOX"],
        "date": "2026-07-23T19:00:00.000Z"
      },
      "recommendedCategory": "RECEIPTS",
      "suggestedAction": "ARCHIVE_RECOMMENDED",
      "confidence": 0.95,
      "requiresReview": false,
      "explanation": "Receipt metadata signals matched.",
      "reasonCodes": ["RECEIPT_TERMS"],
      "source": "RULE",
      "status": "COMPLETED",
      "versions": {
        "classifier": "version-string",
        "prompt": "version-string",
        "taxonomy": "version-string"
      },
      "classifiedAt": "2026-07-23T20:00:00.000Z",
      "correction": null
    }
  ],
  "nextCursor": null
}
```

### `GET /api/classification/results/:id`

Returns one result DTO from the list contract. The UUID must belong to the connected account.

### `POST /api/classification/run`

Runs classification for a configured maximum number of eligible messages. The response includes:

```json
{
  "success": true,
  "runId": "00000000-0000-4000-8000-000000000010",
  "provider": "external",
  "model": "configured-model",
  "requested": 20,
  "processed": 20,
  "reused": 5,
  "rule": 10,
  "ai": 5,
  "providerCalls": 5,
  "review": 2,
  "failed": 0
}
```

### `POST /api/classification/messages/:messageId/reclassify`

Forces one eligible stored message through the pipeline. `messageId` is the internal metadata UUID,
not Gmail’s string message ID. It uses the run response contract.

### `POST /api/classification/results/:id/correct`

Stores an immutable correction. Request:

```json
{
  "category": "ORDERS",
  "recommendedAction": "KEEP_IN_INBOX",
  "feedbackReason": "This is an active order."
}
```

`feedbackReason` is optional and limited to 500 trimmed characters. Returns 201:

```json
{
  "id": "00000000-0000-4000-8000-000000000030",
  "classificationResultId": "00000000-0000-4000-8000-000000000020",
  "correctedCategory": "ORDERS",
  "correctedRecommendedAction": "KEEP_IN_INBOX",
  "feedbackReason": "This is an active order.",
  "createdAt": "2026-07-23T20:00:00.000Z"
}
```

## Dynamic-label discovery

All endpoints require a session. Mutations require trusted Origin. These endpoints store
suggestions and decisions; they do not create a Gmail label or apply one to a message.

Candidate types are `SOURCE`, `ORGANIZATION`, `TOPIC`, `SUBSCRIPTION`, `PROJECT`, and `WORKFLOW`.

### `GET /api/label-discovery/status`

```json
{
  "enabled": true,
  "running": false,
  "activeRunId": null,
  "pendingCount": 4,
  "approvedCount": 2,
  "maxPendingCandidates": 50,
  "maxApprovedLabels": 100,
  "gmailLabelCreationSupported": false,
  "lastErrorCode": null,
  "latestRun": {
    "id": "00000000-0000-4000-8000-000000000040",
    "status": "COMPLETED",
    "messagesAnalyzed": 120,
    "groupsDiscovered": 8,
    "candidatesCreated": 4,
    "candidatesReused": 2,
    "candidatesRejectedByRules": 2,
    "providerCalls": 0,
    "completedAt": "2026-07-23T20:00:00.000Z"
  },
  "versions": {
    "discovery": "version-string",
    "naming": "version-string",
    "confidence": "version-string"
  }
}
```

### `POST /api/label-discovery/run`

All body fields are optional:

```json
{
  "minMessages": 3,
  "lookbackDays": 90,
  "maxCandidates": 20,
  "allowedCandidateTypes": ["SOURCE", "ORGANIZATION"],
  "preferOrganizations": true,
  "preferTopics": true
}
```

Limits: `minMessages` 3–100, `lookbackDays` 7–365, `maxCandidates` 1–50, and one through six
allowed types. Returns run counts:

```json
{
  "success": true,
  "runId": "00000000-0000-4000-8000-000000000040",
  "messagesAnalyzed": 120,
  "groupsDiscovered": 8,
  "candidatesCreated": 4,
  "candidatesReused": 2,
  "candidatesRejectedByRules": 2,
  "providerCalls": 0,
  "discoveryVersion": "version-string"
}
```

### `GET /api/label-discovery/candidates`

Query parameters:

| Parameter       | Rules                                                                                         |
| --------------- | --------------------------------------------------------------------------------------------- |
| `status`        | `PENDING`, `APPROVED`, `REJECTED`, `DEFERRED`, `MERGED`, `CREATED`, `SUPERSEDED`, or `FAILED` |
| `candidateType` | One candidate type listed above                                                               |
| `cursor`        | Candidate UUID returned as `nextCursor`                                                       |
| `limit`         | Integer 1–50; default 20                                                                      |

```json
{
  "candidates": [
    {
      "id": "00000000-0000-4000-8000-000000000050",
      "candidateType": "ORGANIZATION",
      "suggestedLeafName": "Example Store",
      "suggestedFullPath": "MailMind/Organizations/Example Store",
      "status": "PENDING",
      "confidence": 0.88,
      "confidenceLevel": "HIGH",
      "messageCount": 12,
      "threadCount": 8,
      "firstMessageAt": "2026-06-01T00:00:00.000Z",
      "lastMessageAt": "2026-07-23T00:00:00.000Z",
      "dominantCategory": "ORDERS",
      "categoryAgreement": 0.8,
      "sourceAgreement": 0.95,
      "reasonCodes": ["SOURCE_VOLUME"],
      "reasons": ["Frequent source"],
      "discoveryVersion": "version-string",
      "existingLabelConflict": false,
      "mergeSuggestion": null,
      "decision": null,
      "lastDiscoveredAt": "2026-07-23T20:00:00.000Z"
    }
  ],
  "nextCursor": null
}
```

### `GET /api/label-discovery/candidates/:id`

Returns one candidate DTO from the list contract.

### `POST /api/label-discovery/candidates/:id/approve`

Optional rename request:

```json
{ "leafName": "Example Orders" }
```

`leafName` is 2–60 trimmed characters and is checked against controlled naming and duplicate
rules. Returns 201:

```json
{
  "id": "00000000-0000-4000-8000-000000000051",
  "candidateId": "00000000-0000-4000-8000-000000000050",
  "status": "APPROVED",
  "finalLeafName": "Example Orders",
  "finalFullPath": "MailMind/Organizations/Example Orders",
  "gmailLabelCreated": false,
  "message": "Suggestion approved. Gmail was not changed."
}
```

### `POST /api/label-discovery/candidates/:id/reject`

Optional body `{ "reason": "..." }`, limited to 500 trimmed characters. Returns 201 with decision
ID, candidate ID, `status: "REJECTED"`, and a Gmail-unchanged message.

### `POST /api/label-discovery/candidates/:id/defer`

Optional body `{ "reason": "..." }`, limited to 500 trimmed characters. Returns 201 with decision
ID, candidate ID, `status: "DEFERRED"`, and a Gmail-unchanged message.

### `POST /api/label-discovery/candidates/:id/merge`

Request:

```json
{
  "targetCandidateId": "00000000-0000-4000-8000-000000000060"
}
```

Returns 201:

```json
{
  "candidateId": "00000000-0000-4000-8000-000000000050",
  "status": "MERGED",
  "mergedIntoCandidateId": "00000000-0000-4000-8000-000000000060",
  "mergedIntoPath": "MailMind/Organizations/Example",
  "message": "Candidates merged. Gmail was not changed."
}
```

## Privacy boundary

API response examples use fabricated identifiers and values. The implemented Gmail sync consumes a
metadata projection, selected headers, and snippets. Full bodies, raw MIME, and attachment content
are not fetched or returned. External classifier processing, when explicitly enabled, receives a
normalized and size-bounded metadata input; credentials remain backend-only.
