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

Gemini is the primary classifier for every new or unprocessed message. A learned sender-domain
pattern becomes context only after at least two consistent successful outcomes at 90% confidence
or above; it never bypasses Gemini. A contradictory applied outcome deactivates the pattern.

## Run lifecycle

1. Acquire and renew an expiring account lease, recovering a stale `RUNNING` record as `PARTIAL`.
2. Refresh Gmail from its history checkpoint, resuming the full paginated backfill when required.
3. Retry durable failed Gmail actions before purchasing new classifications.
4. Select messages without an automation action, excluding drafts, sent, trashed, and deleted
   records.
5. Send every selected message to Gemini in bounded batches with the approved label names,
   including qualified patterns as untrusted historical hints.
6. Validate strict structured output and persist one durable action per message.
7. Hold uncertain actions for review; apply confident actions with Gmail `messages.modify`.
8. Persist usage, cost, counters, completion state, and audit events before releasing the lease.

The unique message action is the idempotency boundary. A failed Gmail write resumes from its stored
classification without another Gemini request. Scheduled runs use an account/date/attempt
idempotency key so a completed daily attempt is not duplicated while a failed attempt can recover.

## Limits, privacy, and recovery

Message, input-token, output-token, and estimated-cost caps are enforced. Reaching a cap ends the
run as `PARTIAL` with `DAILY_BUDGET_REACHED`; completed actions remain committed. Gemini and Gmail
adapters retry transient failures with bounded exponential backoff. Per-message failures have an
attempt cap and `next_retry_at`.

Gemini requests use `models/<GEMINI_MODEL>:generateContent` with `responseMimeType:
"application/json"` and a `responseSchema` that constrains `labelName` to the approved leaves plus
`NONE`. The response is still validated with Zod: constrained generation is a guardrail, not a
guarantee, and model output stays untrusted. Only synchronized subject, sender, bounded snippet,
state flags, and a qualified pattern hint are sent.
OAuth tokens, API keys, full bodies, raw MIME, and attachments are never included.

Operational logs contain safe error types/codes, provider request IDs, and opaque run/action/account
IDs. A provider status, sanitized provider code, and request ID are checkpointed on the run;
provider response text is never stored. Pino redaction
covers authorization, cookies, OAuth material, provider tokens, database URLs, and encryption
secrets. Audit metadata contains counters, never message content or credentials.

`PROVIDER_RATE_LIMITED` means Gemini refused the request after the paced attempt and its bounded
retries. Because pacing already respects the per-minute cap, a surviving 429 almost always means
the daily request cap, so the run stops with `stopped_reason = PROVIDER_RATE_LIMITED`, backs off
for an hour, and the next scheduled run resumes from the checkpoints. Completed actions stay
committed. Other upstream failures use bounded retries.

## Configuration

Set `GEMINI_API_KEY` privately; automation stays unavailable while it is absent. `GEMINI_MODEL`
defaults to the `gemini-flash-lite-latest` **alias** rather than a pinned id. This is deliberate:
`gemini-2.5-flash-lite` was retired and began returning `404 — no longer available to new users`,
which would silently break an unattended daily scheduler. Flash-Lite is preferred over Flash
because Flash-class free quota is far lower and it burns roughly twice the output tokens on the
same batch. Google no longer publishes per-model free-tier limits; check the live figures for your
project at <https://aistudio.google.com/rate-limit>.

Rate limiting is handled proactively: `GEMINI_MIN_REQUEST_INTERVAL_MS` (default `4000`) paces
requests to a 15/minute ceiling rather than relying on 429 retries.

Cost accounting is notional. The free tier bills nothing, but per-token rates taken from Gemini's
published paid pricing are held as constants in `gemini-automation.provider.ts` so
`AUTOMATION_MAX_COST_MICRO_USD` still bounds a runaway run. Because the alias can be repointed
without a code change, those constants deliberately hold the **higher** current Flash-Lite rates
(input $0.30, cached $0.03, output $2.50 per 1M): over-estimating makes the cap stop a run early,
whereas under-estimating would let one overshoot. Re-check them whenever `GEMINI_MODEL` is pinned
to a specific model.

### What actually bounds a full-mailbox backfill

Measured over real runs on `gemini-flash-lite-latest` against a 9,525-message mailbox, a batch of
10 messages costs about **1,280 input and 650 output tokens** (~2,000 µUSD notional). The token
budgets are **daily and cumulative across every run since 00:00 UTC**, not per run, so successive
runs share one allowance. Extrapolating to 9,436 unfiled messages — 944 batches:

| Budget                            | Default   | Schema max    | Needed for 9,436 | Binds?         |
| --------------------------------- | --------- | ------------- | ---------------- | -------------- |
| `AUTOMATION_MAX_MESSAGES_PER_RUN` | `250`     | `1000`        | 9,436            | **yes, first** |
| `AUTOMATION_MAX_OUTPUT_TOKENS`    | `10000`   | `1000000`     | ~613,000         | **yes**        |
| `AUTOMATION_MAX_INPUT_TOKENS`     | `100000`  | `10000000`    | ~1,208,000       | **yes**        |
| `AUTOMATION_MAX_COST_MICRO_USD`   | `5000000` | `20000000000` | ~1,900,000       | no             |

So a default run files **250 messages**, not the whole mailbox, and stops `PARTIAL` with
`DAILY_BUDGET_REACHED`. That is the intended bounded-batch design: the backlog drains across
successive runs, newest mail first so each run works on the window the planner designed the tree
from. Input is the budget that binds in practice: every message's metadata is sent whether the model
ends up filing it or not, at roughly 128 tokens each. Output is spent only on the answer and runs
about a third of that, so a day's filing is bounded by how much mail can be read, not written.

The output budget is what usually binds, and it is spent on prose: each classification carries an
explanation and reason codes, so those are capped at one short sentence and three codes. A batch is
refused unless the remaining output budget can answer it in full — a reserve smaller than one
result per message returns a truncated body, which reads as a provider fault rather than the
budget stop it really is.

The controls are the `AUTOMATION_*` and `GEMINI_*` variables in `apps/api/.env.example`. The
in-process scheduler polls every 15 minutes and catches up after restart. Database leases make it
safe across multiple API instances. A platform that suspends every instance cannot provide an
exact wall-clock guarantee, so keep one API instance available during the configured hour.

### Which model actually answered

`requestGeminiJson` returns the `modelVersion` Google reports on every `generateContent` response,
and logs it the first time it is seen and again whenever it changes:

```
gemini resolved model version changed
  { configuredModel: 'gemini-flash-lite-latest',
    modelVersion: '…', previousModelVersion: '…' }
```

`GEMINI_MODEL` defaults to an alias that Google repoints without notice, so an unattended
scheduler can start filing against a different model with no code change and no deploy. The only
symptom would be classification quality shifting for a reason nobody can name. It is logged on
change rather than per response because a backfill makes thousands of calls a day and an identical
line per call would bury the one line that matters.

## What the unattended path guarantees

`test/automation-scheduler.test.ts` covers the parts of a nightly run that nobody is awake to
watch:

| Guarantee                                                                  | Why it matters overnight                                                      |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `AUTOMATION_ENABLED=false` starts no timer at all                          | The kill switch for unattended filing                                         |
| Boot ticks immediately, then on `AUTOMATION_POLL_INTERVAL_MINUTES`         | A deploy must not cost a whole interval of catch-up                           |
| A tick that overlaps a run in flight is skipped                            | Ticks are 15 minutes apart; a backfill is longer                              |
| One account's failure does not stop the others, and reaches Sentry         | No response is open, so the log and the run row are the only trace            |
| A failed tick releases its guard and ticks again                           | Otherwise one bad tick ends the day silently                                  |
| A held lease refuses the run, and an expired one is taken over             | Two API instances share one database; a killed process must not wedge it      |
| A long run keeps renewing its lease, scoped to one still live              | A backfill outlives a single lease term                                       |
| The mailbox is refreshed before it is read, and a stale history id resyncs | Otherwise a nightly run files yesterday's mail and looks healthy doing it     |
| A scheduled slot already used reports that run instead of filing twice     | The idempotency key is account/date/attempt                                   |
| Success clears the backoff and schedules `AUTOMATION_SCHEDULE_HOUR_UTC`    | The daily promise                                                             |
| `PROVIDER_RATE_LIMITED` backs off an hour; other faults, fifteen minutes   | A spent daily quota would otherwise re-fail every tick until midnight Pacific |
| `DAILY_BUDGET_REACHED` waits for the next scheduled hour, not the tick     | The token budgets are daily and cumulative; a retry would reach the same wall |
| The `retry_at` a stopped run writes is one a later tick selects on         | Each half can pass on its own while the join between them is broken           |
| A hard failure closes the run `FAILED` and releases the lease              | A stuck lease locks out every later tick                                      |
| Only mail with no action row is read, newest first                         | A run interrupted mid-flight resumes instead of re-classifying and re-billing |

What these cannot establish is that three consecutive nights actually ran: that needs elapsed time
on a real mailbox. One filing engine now remains, so that wait is over — see card 05.

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
