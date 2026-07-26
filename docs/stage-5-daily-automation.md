# Stage 5 daily automation

MailMind runs account-scoped Gmail organization once per UTC day and on demand from
`/dashboard/automation`. It refreshes synchronized metadata, classifies new or unprocessed
messages, creates or reuses a controlled `MailMind/<Category>` Gmail label, and applies that label
to confident matches. Low-confidence results never change Gmail and enter the review queue.

OpenAI is the primary classifier. A learned sender-domain pattern bypasses OpenAI only after at
least two consistent successful outcomes at 90% confidence or above. A contradictory outcome
deactivates the pattern.

## Run lifecycle

1. Acquire an expiring account lease and recover a stale `RUNNING` record as `PARTIAL`.
2. Refresh Gmail from its history checkpoint, using the bounded initial sync when required.
3. Retry durable failed Gmail actions before purchasing new classifications.
4. Select messages without an automation action, excluding drafts, sent, trashed, and deleted
   records.
5. Reuse qualified patterns, then send remaining metadata to OpenAI in bounded batches.
6. Validate strict structured output and persist one durable action per message.
7. Hold uncertain actions for review; apply confident actions with Gmail `messages.modify`.
8. Persist usage, cost, counters, completion state, and audit events before releasing the lease.

The unique message action is the idempotency boundary. A failed Gmail write resumes from its stored
classification without another OpenAI request. Scheduled runs also have an account/date
idempotency key.

## Limits, privacy, and recovery

Message, input-token, output-token, and estimated-cost caps are enforced. Reaching a cap ends the
run as `PARTIAL` with `DAILY_BUDGET_REACHED`; completed actions remain committed. OpenAI and Gmail
adapters retry transient failures with bounded exponential backoff. Per-message failures have an
attempt cap and `next_retry_at`.

OpenAI requests use the Responses API, strict JSON Schema output, low reasoning effort, and
`store: false`. Only synchronized subject, sender, bounded snippet, and state flags are sent.
OAuth tokens, API keys, full bodies, raw MIME, and attachments are never included.

Operational logs contain safe error types/codes and opaque run/action/account IDs. Pino redaction
covers authorization, cookies, OAuth material, provider tokens, database URLs, and encryption
secrets. Audit metadata contains counters, never message content or credentials.

## Configuration

Set `OPENAI_API_KEY` privately. `OPENAI_MODEL` defaults to `gpt-5.6-sol`; token-price environment
variables are explicit and must be reviewed when changing models.

The controls are the `AUTOMATION_*` and `OPENAI_*` variables in `apps/api/.env.example`. The
in-process scheduler polls every 15 minutes and catches up after restart. Database leases make it
safe across multiple API instances. A platform that suspends every instance cannot provide an
exact wall-clock guarantee, so keep one API instance available during the configured hour.

## Verification

```powershell
npm exec --workspace @mailmind/api -- prisma migrate deploy
npm run prisma:validate --workspace @mailmind/api
npm test
npm run typecheck
npm run lint
npm run build
```

Then use a test Gmail account: run automation manually, confirm `MailMind/<Category>` appears on a
confident message, and approve one uncertain item from the automation page.
