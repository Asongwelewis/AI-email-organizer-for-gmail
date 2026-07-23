# Stage 4 AI classification and recommendation pipeline

## Boundary

**Stage 4 produces recommendations only. It does not modify Gmail messages.**

The pipeline reads the metadata projection created by Stage 3. It does not request message bodies,
download attachments, apply or remove labels, archive, mute, mark important, or unsubscribe.
Corrections are MailMind records and likewise do not mutate Gmail. Automatic organization remains a
Stage 5 concern.

## Architecture and versions

The backend owns every provider call and uses these stable identifiers:

- Classifier: `mailmind-classifier-v1`
- Prompt: `mailmind-prompt-v1`
- Taxonomy: `mailmind-taxonomy-v1`

The provider-independent `EmailClassifierProvider` interface has disabled, deterministic mock, and
external HTTP adapters. The service chooses rules first, calls a provider only when needed,
schema-validates the result, then persists a recommendation. Provider responses never become SQL or
Gmail API parameters.

Categories are `PRIMARY`, `WORK`, `FINANCE`, `RECEIPTS`, `ORDERS`, `TRAVEL`, `EDUCATION`,
`NEWSLETTERS`, `PROMOTIONS`, `SOCIAL`, `NOTIFICATIONS`, `SECURITY`, `SUPPORT`, `PERSONAL`,
`SPAM_SUSPECTED`, and `OTHER`.

Actions are `KEEP_IN_INBOX`, `ARCHIVE_RECOMMENDED`, `REVIEW_REQUIRED`, `IMPORTANT_RECOMMENDED`,
`MUTE_RECOMMENDED`, and `UNSUBSCRIBE_CANDIDATE`. Category and action are separate.
`SPAM_SUSPECTED` is uncertain review advice and never a definitive spam decision.

## Privacy input and structured output

The normalized input may contain a bounded subject, sender display name, sender domain, local-part
category (automated, role, person-like, or unknown), redacted recipient summary, bounded snippet,
sorted Gmail label IDs, read/important/starred/attachment flags, message date, and same-domain flag.
Complete addresses are replaced where possible. Tokens, OAuth codes, cookies, sessions, encryption
material, raw Gmail responses, bodies, attachments, database IDs, and full MIME are never included.

Inputs default to 4,000 characters and are rejected above the configured bound. Output is strict
JSON with an allowlisted category, action, confidence in `[0,1]`, allowlisted reason codes, an
explanation of at most 400 characters, and a review flag. Invalid JSON, extra keys, unsupported
values, and out-of-range confidence fail safely. Prompts and raw responses are not exposed or
logged.

## Rules, confidence, and review

Deterministic rules cover Gmail category labels, receipt/payment language, order/delivery language,
automated security alerts, educational domains, and newsletter terminology. Each rule returns
reason codes, an explanation, and classifier confidence. Confidence is an operational classifier
score, not a calibrated probability.

By default, rules at `0.90` or higher finish without a provider. Medium rules become provider
signals and produce a `HYBRID` result. Messages without a useful rule use `AI`. If the provider is
disabled, high-confidence rules still work and medium-confidence rule results require review.
Results below the minimum-confidence or review threshold use `REVIEW_REQUIRED`.

## Hashing, deduplication, and concurrency

Canonical normalized metadata is serialized in fixed field order and hashed with SHA-256. The
service reuses an active result when metadata hash plus classifier, prompt, and taxonomy versions
match. Subject, sender, snippet, material label, or version changes generate a new result. Explicit
reclassification supersedes the previous active result while preserving it.

An expiring `classification_states` lease permits one active run per connected Gmail account while
different accounts run concurrently. Compare-and-set acquisition and token-bound release work
across API instances. Stale leases mark orphaned runs failed. Provider calls occur outside database
transactions; only short final writes are transactional.

## Persistence and security

The migration adds `classification_results`, `classification_runs`, `classification_states`, and
`user_classification_corrections`. Correction history is immutable and retains the original
recommendation. Account, message, result, and user foreign keys cascade during owning-record
cleanup, and every foreign-key/query path is indexed.

All four tables have RLS enabled and forced. `PUBLIC`, `anon`, and `authenticated` receive no table
privileges, matching the backend-only Stage 2/3 architecture. API queries resolve the active account
and enforce ownership. Mutation endpoints require trusted-origin CSRF checks and a stricter limiter.

## API and UI

- `GET /api/classification/status`
- `GET /api/classification/results`
- `GET /api/classification/results/:id`
- `POST /api/classification/run`
- `POST /api/classification/messages/:messageId/reclassify`
- `POST /api/classification/results/:id/correct`

Lists use bounded cursor pagination. Safe DTOs omit keys, prompts, raw responses, tokens, and full
sender addresses. `/dashboard/classification` shows status, distributions, rules-only/provider
state, confidence, explanations, and corrections. Wording consistently states Gmail is unchanged.

Corrections can later support transparent aggregate signals such as repeated choices per sender
domain or category. Stage 4 does not train, fine-tune, transmit corrections, or automatically
override a recommendation after one correction.

## Cost, retry, and environment controls

Maximum messages, batch size, input/output limits, timeout, retry count, rule-first execution, hash
reuse, and the enable switch bound usage. Retryable timeout, rate-limit, network, and upstream 5xx
errors use bounded exponential backoff. Invalid output and configuration errors are not retried.
Runs track messages, provider calls, and provider-reported input/output units; no cost is invented.

```dotenv
AI_CLASSIFIER_ENABLED=false
AI_CLASSIFIER_PROVIDER=disabled
AI_CLASSIFIER_MODEL=not-configured
AI_CLASSIFIER_API_KEY=
AI_CLASSIFIER_BASE_URL=
AI_CLASSIFIER_TIMEOUT_MS=15000
AI_CLASSIFIER_MAX_RETRIES=2
AI_CLASSIFIER_BATCH_SIZE=5
AI_CLASSIFIER_OUTPUT_MAX_TOKENS=400
AI_CLASSIFICATION_MAX_MESSAGES_PER_RUN=20
AI_CLASSIFICATION_MIN_CONFIDENCE=0.70
AI_CLASSIFICATION_REVIEW_THRESHOLD=0.65
AI_CLASSIFICATION_INPUT_MAX_CHARS=4000
AI_CLASSIFICATION_RULE_THRESHOLD=0.90
AI_CLASSIFICATION_LEASE_SECONDS=300
```

`AI_CLASSIFIER_API_KEY` is a backend-only secret. Never create a `VITE_` AI key. Tests use `mock`
or `disabled` and never make real provider requests.

## Manual release gates and limitations

The Stage 3 real-Gmail flow is still **not performed**. Before release, use a dedicated Google test
account with `GMAIL_INITIAL_SYNC_MAX_MESSAGES=20` and verify login, session, Gmail connect, profile,
managed labels, initial sync, incremental sync, and disconnect. Do not use a primary Gmail account
without explicit authorization.

The external-provider test is also **not performed**. With a small test dataset and
`AI_CLASSIFICATION_MAX_MESSAGES_PER_RUN=10`, verify storage, review, correction, and unchanged Gmail
labels. Do not report either manual gate as passed until a person actually completes it.

The v1 rules are intentionally conservative, confidence is not statistically calibrated, thread
context and `List-Unsubscribe` are not stored by Stage 3, and personalization is only a future data
foundation. Stage 5 was not started.
