# Stage 5 daily automation

MailMind runs account-scoped Gmail organization once per UTC day and on demand from
`/dashboard/automation`. It refreshes synchronized metadata, files new or unprocessed messages into
the account's **approved label set**, and applies the matching `MailMind/<leaf>` Gmail label to
confident matches. Low-confidence results never change Gmail and enter the review queue.

Automation cannot start until the user has confirmed at least one label on `/labels`; a run
attempted before that fails with `AUTOMATION_NO_APPROVED_LABELS`. The model is constrained to the
approved leaf names plus the literal `NONE`. A `NONE` result — or any name outside the approved set
— is recorded as a skipped action and the message is left in the inbox. Automation never creates a
label outside the proposal-and-approval flow.

When synchronized mail predates automation, the run drains that backlog oldest-first in the same
bounded batches, spanning as many runs as the daily budget requires; `backlogRemaining` on the run
and status responses reports what is left.

OpenAI is the primary classifier for every new or unprocessed message. A learned sender-domain
pattern becomes context only after at least two consistent successful outcomes at 90% confidence
or above; it never bypasses OpenAI. A contradictory applied outcome deactivates the pattern.

## Run lifecycle

1. Acquire and renew an expiring account lease, recovering a stale `RUNNING` record as `PARTIAL`.
2. Refresh Gmail from its history checkpoint, resuming the full paginated backfill when required.
3. Retry durable failed Gmail actions before purchasing new classifications.
4. Select messages without an automation action, excluding drafts, sent, trashed, and deleted
   records.
5. Send every selected message to OpenAI in bounded batches with the approved label names,
   including qualified patterns as untrusted historical hints.
6. Validate strict structured output and persist one durable action per message.
7. Hold uncertain actions for review; apply confident actions with Gmail `messages.modify`.
8. Persist usage, cost, counters, completion state, and audit events before releasing the lease.

The unique message action is the idempotency boundary. A failed Gmail write resumes from its stored
classification without another OpenAI request. Scheduled runs use an account/date/attempt
idempotency key so a completed daily attempt is not duplicated while a failed attempt can recover.

## Limits, privacy, and recovery

Message, input-token, output-token, and estimated-cost caps are enforced. Reaching a cap ends the
run as `PARTIAL` with `DAILY_BUDGET_REACHED`; completed actions remain committed. OpenAI and Gmail
adapters retry transient failures with bounded exponential backoff. Per-message failures have an
attempt cap and `next_retry_at`.

OpenAI requests use the Responses API, strict JSON Schema output, low reasoning effort, and
`store: false`. Only synchronized subject, sender, bounded snippet, state flags, and a qualified
pattern hint are sent.
OAuth tokens, API keys, full bodies, raw MIME, and attachments are never included.

Operational logs contain safe error types/codes, OpenAI request IDs, and opaque run/action/account
IDs. A provider status, sanitized provider code, and request ID are checkpointed on the run;
provider response text is never stored. Pino redaction
covers authorization, cookies, OAuth material, provider tokens, database URLs, and encryption
secrets. Audit metadata contains counters, never message content or credentials.

`OPENAI_INSUFFICIENT_QUOTA` means the configured project needs billing or a higher usage limit.
MailMind does not retry that condition inside the batch and schedules a later recovery attempt.
Transient rate limits and upstream failures use bounded retries.

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
