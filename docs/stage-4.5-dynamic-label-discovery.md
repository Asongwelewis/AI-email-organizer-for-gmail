# Stage 4.5 dynamic label discovery

> Stage 4.5 discovers and approves labels. It does not apply labels to messages.

## Architecture and safety boundary

Discovery runs in the API against synchronized Gmail metadata and the latest Stage 4 classification
result/correction. It never reads bodies, attachments, tokens, raw Gmail responses, session
cookies, or unrestricted provider output. The deterministic engine runs first and is sufficient on
its own. The feature does not call Gmail, create Gmail labels, or modify messages. Empty-label
creation is deliberately deferred to Stage 5 to keep the current safety boundary simple and
auditable.

The lifecycle is:

```text
synchronized metadata
→ bounded deterministic grouping
→ validation, scoring, and duplicate checks
→ persisted PENDING candidate
→ explicit approve / rename / reject / defer / merge decision
→ APPROVED decision only (no Gmail write)
```

An account-scoped database lease prevents concurrent discovery runs. Expired leases mark stale runs
failed and can be recovered. External calls are absent in v1, and no long database transaction is
held around analysis.

## Candidate types and controlled hierarchy

The centralized types are `SOURCE`, `ORGANIZATION`, `TOPIC`, `SUBSCRIPTION`, `PROJECT`, and
`WORKFLOW`. Paths are constructed only by the backend:

| Type           | Namespace                       |
| -------------- | ------------------------------- |
| `SOURCE`       | `MailMind/Sources/<leaf>`       |
| `ORGANIZATION` | `MailMind/Organizations/<leaf>` |
| `TOPIC`        | `MailMind/Topics/<leaf>`        |
| `SUBSCRIPTION` | `MailMind/Subscriptions/<leaf>` |
| `PROJECT`      | `MailMind/Projects/<leaf>`      |
| `WORKFLOW`     | `MailMind/Workflows/<leaf>`     |

Paths have exactly three levels. Leaf names are 2–60 characters; full paths are at most 225
characters. Empty segments, slashes in leaf names, control characters, emoji, generic names, and
Gmail system-label names are rejected. The backend never accepts an arbitrary provider-built path.

## Source and domain normalization

`tldts` provides Public-Suffix-List-aware registrable domains, so `mail.company.co.uk` becomes
`company.co.uk` rather than `co.uk`. The dependency is exact-pinned, MIT-licensed, actively
maintained, TypeScript-native, and API-only, so it has no frontend bundle impact.

Email addresses are lowercased and parsed without retaining them in candidate DTOs or logs.
Automated local parts such as `noreply`, `notifications`, `alerts`, `newsletter`, and `updates` are
treated as low-value identity signals. Subdomains do not automatically become separate
organizations. Display names are whitespace/control-character normalized, automation terms and
safe legal suffixes are removed, and known brand capitalization is preserved.

## Deterministic discovery

Source/organization discovery groups messages by registrable domain and calculates message count,
unique threads, first/last seen time, sender-address diversity, dominant display name, dominant
classification, category agreement, Gmail category support, and correction support.

Subscription discovery uses repeated automated senders plus newsletter/promotion classifications or
Gmail promotional/update categories. Its interface does not require `List-Unsubscribe`, allowing
that metadata signal to be added later.

Topic discovery uses broad, versioned subject/category rules. V1 recognizes job applications,
receipts, security alerts, travel plans, and support requests. A topic requires multiple distinct
normalized subject patterns; one repeated exact subject cannot create a topic.

`PROJECT` and `WORKFLOW` are accepted, validated, stored, and rendered types, but v1 does not emit
them deterministically because reliable project/workflow evidence is not yet stored.

## Thresholds, agreement, and temporary events

Message volume is necessary but not sufficient. A group also needs classification/source
consistency, a valid stable name, sufficient confidence, and no duplicate or temporary-event
conflict. The defaults are:

```text
minimum messages: 3
lookback: 90 days
minimum confidence: 0.75
minimum category agreement: 0.70
minimum source agreement: 0.70
maximum messages per run: 1000
maximum candidates per run: 20
```

Category agreement is the dominant effective category count divided by all group messages. The
effective category uses the latest user correction when present. Source agreement is the dominant
registrable-domain share. Corrections are bounded support signals; a single correction cannot
dominate the score.

Temporary-event detection recognizes password resets, verification/security codes, one-time events,
short-lived campaigns, and groups confined to a short window with only one thread. Actual codes are
normalized away and never stored in candidate data. Stable broad security topics may still qualify
when evidence spans distinct subject patterns and threads.

## Confidence and reason codes

`mailmind-label-confidence-v1` is a deterministic usefulness score, not a calibrated probability:

```text
30% source consistency
20% message volume (saturates at 3× the minimum)
15% category agreement
10% recency
10% thread diversity
10% naming confidence
 5% user-correction support
```

Temporary events, generic names, existing-label similarity, and sparse time distribution apply
explicit penalties. Safe reason codes include `SOURCE_VOLUME`, `SOURCE_RECENCY`,
`DOMAIN_CONSISTENCY`, `DISPLAY_NAME_CONSISTENCY`, `CATEGORY_AGREEMENT`,
`SUBJECT_PATTERN_AGREEMENT`, `THREAD_DIVERSITY`, `EXISTING_GMAIL_CATEGORY`, and
`USER_CORRECTION_SUPPORT`. Private chain-of-thought and long provider reasoning are not stored.

## Optional AI naming

The structured-output contract permits only a leaf name, allowed candidate type, bounded
confidence, create/no-create flag, known merge-group keys, and allowed reason codes. Validation is
strict, and unknown group keys are discarded. V1 keeps provider calls at zero even when the
interface is enabled; external naming/clustering is a documented extension point, not a requirement
for deterministic discovery.

## Deduplication, similarity, and cooldown

`mailmind-label-discovery-v1` and `mailmind-label-naming-v1` feed a SHA-256 candidate identity hash
with candidate type and normalized group key. The same meaningful group reuses its candidate and
refreshes counts, confidence, dates, and associations. Candidate/message associations contain only
IDs, scores, and reason codes.

Exact comparison ignores case, punctuation, whitespace, and the controlled MailMind prefix. A
conservative Levenshtein threshold catches variants such as `Git Hub` and `GitHub`; uncertain
similarity is never auto-merged. Existing Gmail labels and active/approved candidates are checked
before approval.

Rejected candidates stay closed for the configured cooldown (14 days by default) and reopen only
after cooldown plus material message-count growth.

## Decisions and merge workflow

All decision rows are immutable:

- Approve stores `APPROVE` and the validated final path.
- Rename and approve stores `RENAME_AND_APPROVE`, original name, and final name/path.
- Reject stores `REJECT` and suppresses rediscovery during cooldown.
- Defer stores `DEFER` and leaves the suggestion available for later review.
- Merge stores `MERGE`, preserves the source candidate, combines ID-only associations into the
  target, and recomputes counts.

State changes use conditional updates, so concurrent or repeated decisions return conflicts.
Database triggers and service checks prevent self/cyclic merges, cross-account associations, and
inactive targets. Account deletion still cascades all related records.

## Label-explosion controls

Server-side bounds enforce minimum evidence, allowed types, maximum candidates per run, maximum
pending candidates (50), maximum approved labels (100), pagination limits, confidence thresholds,
controlled hierarchy, generic-name rejection, duplicate checks, temporary-event rejection, and
rejection cooldown. Frontend values cannot widen configured maxima.

## Data model and security

The additive migration creates:

- `dynamic_label_candidates`
- `dynamic_label_candidate_messages`
- `label_decisions`
- `label_discovery_runs`
- `label_discovery_states`

All tables have forced RLS. `PUBLIC`, `anon`, and `authenticated` have no DML privileges. Foreign
keys are indexed, associations are account-guarded, decisions are immutable, and account deletion
cascades cleanup. API ownership is always derived from the authenticated user's connected account.
Logs and audit records contain safe account/run/candidate identifiers, counts, versions, decision
types, duration, and safe error codes only.

## API and interface

Authenticated endpoints:

```text
GET  /api/label-discovery/status
POST /api/label-discovery/run
GET  /api/label-discovery/candidates
GET  /api/label-discovery/candidates/:id
POST /api/label-discovery/candidates/:id/approve
POST /api/label-discovery/candidates/:id/reject
POST /api/label-discovery/candidates/:id/defer
POST /api/label-discovery/candidates/:id/merge
```

Mutations require a trusted browser origin and use dedicated rate limits. Pagination and inputs are
bounded. DTOs contain no tokens, provider secrets, prompts, raw responses, full bodies, attachments,
full sender addresses, subjects, or snippets.

The frontend route is `/dashboard/labels/discover`. It shows safe aggregate evidence, confidence,
reason descriptions, status, and explicit `Approve suggestion` wording. It never uses “organize
emails” wording.

## Environment

All values are server-side:

```text
DYNAMIC_LABEL_DISCOVERY_ENABLED=false
DYNAMIC_LABEL_MIN_MESSAGES=3
DYNAMIC_LABEL_LOOKBACK_DAYS=90
DYNAMIC_LABEL_MIN_CONFIDENCE=0.75
DYNAMIC_LABEL_MIN_CATEGORY_AGREEMENT=0.70
DYNAMIC_LABEL_MIN_SOURCE_AGREEMENT=0.70
DYNAMIC_LABEL_MAX_CANDIDATES_PER_RUN=20
DYNAMIC_LABEL_MAX_MESSAGES_PER_RUN=1000
DYNAMIC_LABEL_MAX_PENDING_CANDIDATES=50
DYNAMIC_LABEL_MAX_APPROVED_LABELS=100
DYNAMIC_LABEL_REDISCOVERY_DAYS=14
DYNAMIC_LABEL_AI_NAMING_ENABLED=false
```

Discovery defaults to disabled until the additive migration is deployed. No value is a secret.

## Testing, limitations, and Stage 5

Unit tests cover normalization, public suffixes, grouping, thresholds, scoring, temporary/generic
rejection, controlled paths, hashing, duplicate similarity, provider validation, and candidate caps.
API tests cover authentication, CSRF, validation, bounded pagination, decisions, and sensitive-field
exclusion. Frontend tests cover status, candidate evidence, confidence, actions, and no-Gmail-action
wording. Database tests cover persistence, immutable decisions, account-scoped associations,
cycles, leases, stale recovery, and cascade cleanup. Tests use no real Gmail or AI provider.

Known limitations: v1 topic rules are deliberately small; semantic/fuzzy clustering is
conservative; preferences are request-scoped rather than persisted; provider naming is not invoked;
and approved Gmail label creation is deferred.

Stage 5 may add a separate explicit empty-label creation/application workflow. Stage 4.5 does not
create labels, apply labels to current or future messages, archive, delete, move, star, mute, mark
read/unread, or run background automation.
