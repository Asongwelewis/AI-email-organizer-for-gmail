import { env } from '@api/config/env.js';
import { prisma } from '@api/database/prisma.js';
import type { FacetRunCounters } from './facet-classification.service.js';

/**
 * What the one Gemini key has spent today, and who may spend what is left.
 *
 * Every mailbox shares a single key, and the free tier caps requests per day per project — not
 * per user. The per-account caps that already existed stop one mailbox from spending a fortune;
 * they cannot stop three hundred mailboxes from spending the key's whole day together, and the
 * first sign of that used to be a 429 in the middle of somebody's onboarding.
 *
 * So the day's requests are read back as a sum over every account's `automation_runs`, and each
 * kind of work may spend up to its own share of GEMINI_DAILY_REQUEST_LIMIT:
 *
 *   onboarding — all of it. Somebody is watching a progress bar.
 *   new        — all of it. New mail is the product.
 *   backlog    — GEMINI_BACKLOG_SHARE of it. Old mail can wait a day; the rest is held back.
 *
 * The sum lags the truth by whatever is in flight and not yet recorded, which is why onboarding
 * records as it goes rather than at the end. A small overshoot meets Gemini's own 429, which
 * stops a run cleanly; this exists so that is the exception rather than the plan.
 */

export type GeminiPriority = 'onboarding' | 'new' | 'backlog';

function startOfUtcDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/** Gemini requests recorded today across every mailbox. */
export async function geminiRequestsToday(now = new Date()): Promise<number> {
  const spent = await prisma.automation_runs.aggregate({
    where: { started_at: { gte: startOfUtcDay(now) } },
    _sum: { provider_call_count: true },
  });
  return spent._sum.provider_call_count ?? 0;
}

/** The most requests work of this priority may see recorded today before it stops. */
export function geminiRequestCeiling(priority: GeminiPriority): number {
  const limit = env.GEMINI_DAILY_REQUEST_LIMIT;
  return priority === 'backlog' ? Math.floor(limit * env.GEMINI_BACKLOG_SHARE) : limit;
}

/**
 * Adds what a pass did to one row per account, per source, per day.
 *
 * A row per pass would be 1,440 a day from the watcher alone. One per day is enough, and it has to
 * exist at all: both the per-account caps and the shared ceiling above are sums over today's rows,
 * so usage left unrecorded would hand every later run a fresh allowance.
 */
export async function recordDailyUsage(
  accountId: string,
  source: 'watch' | 'onboarding' | 'manual',
  counters: FacetRunCounters,
  now = new Date(),
): Promise<void> {
  const sorted = counters.ruleDecided + counters.modelDecided;
  if (sorted === 0 && counters.failed === 0 && counters.providerCalls === 0) return;
  const day = now.toISOString().slice(0, 10);
  const key = `${accountId}:${source}:${day}`;
  const status = counters.failed > 0 || counters.stoppedReason ? 'PARTIAL' : 'COMPLETED';
  const tally = {
    messages_seen: sorted + counters.failed,
    ai_classified_count: counters.modelDecided,
    pattern_reused_count: counters.ruleDecided,
    failed_count: counters.failed,
    provider_call_count: counters.providerCalls,
    input_tokens: counters.usage.inputTokens,
    cached_input_tokens: counters.usage.cachedInputTokens,
    output_tokens: counters.usage.outputTokens,
    estimated_cost_microusd: counters.costMicrousd,
  };
  await prisma.automation_runs.upsert({
    where: { idempotency_key: key },
    create: {
      connected_google_account_id: accountId,
      idempotency_key: key,
      trigger: source === 'manual' ? 'MANUAL' : 'SCHEDULED',
      status,
      // Both from this clock. Left to its default, started_at is the database's now(), which can
      // land a few milliseconds after this process's — and the table refuses a row that completed
      // before it started.
      started_at: now,
      completed_at: now,
      stopped_reason: counters.stoppedReason,
      last_error_code: counters.lastErrorCode,
      ...tally,
    },
    update: {
      status,
      completed_at: now,
      stopped_reason: counters.stoppedReason,
      last_error_code: counters.lastErrorCode,
      ...Object.fromEntries(
        Object.entries(tally).map(([field, value]) => [field, { increment: value }]),
      ),
    },
  });
}
