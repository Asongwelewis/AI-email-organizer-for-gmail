import { createHash, randomUUID } from 'node:crypto';
import type { gmail_message_metadata } from '@prisma/client';

import { env } from '@api/config/env.js';
import { logger, safeErrorDetails } from '@api/config/logger.js';
import { prisma } from '@api/database/prisma.js';
import { AppError } from '@api/errors/AppError.js';
import { entityFor } from '@api/features/label-discovery/entity.js';
import { emailIdentity } from '@api/features/label-discovery/label-normalization.js';
import {
  facetVocabularyRepository,
  type FacetVocabularyRepository,
} from '@api/features/label-discovery/facet-vocabulary.repository.js';
import { captureApiException } from '@api/observability/sentry.js';
import { forEachWithConcurrency } from '@api/utils/concurrency.js';
import { invalidatePivotViews } from '@api/features/labels/pivot-cache.js';
import {
  normalizeRuleValue,
  resolveFacetRules,
  stableSubjectPhrase,
  type FacetRoutingRule,
} from '@api/features/label-discovery/routing-rules.js';
import {
  GeminiProviderError,
  estimatedCostMicroUsd,
} from '@api/integrations/gemini/gemini.client.js';
import type { AutomationUsage } from './automation.types.js';
import { geminiRequestCeiling, geminiRequestsToday, type GeminiPriority } from './usage-ledger.js';
import {
  accountPolicies,
  type AccountPolicySource,
} from '@api/features/accounts/account-policy.js';
import { heuristicFacets } from '@api/features/label-discovery/heuristics.js';
import {
  referenceRules,
  type ReferenceRule,
} from '@api/features/label-discovery/reference-rules.js';
import {
  facetPromptVersion,
  geminiFacetClassifier,
  type FacetClassification,
  type FacetClassifier,
  type FacetClassifierInput,
} from './facet-classifier.js';

/**
 * Assigns facets to stored mail. Rules first, then one Gemini call per batch for the remainder.
 *
 * This pass never touches Gmail. It reads metadata, writes `message_facets`, and stops — turning a
 * facet combination into a folder is the pivot's job, and until that lands the filing path files
 * exactly as it did before. Keeping the two apart means the expensive, resumable classification
 * can be re-run over the whole mailbox as often as needed without a single remote mutation.
 */

export interface FacetRunCounters {
  messagesSeen: number;
  ruleDecided: number;
  modelDecided: number;
  domainAssigned: number;
  intentAssigned: number;
  entityAssigned: number;
  /** Rule hits where the rule was learned on a different sender than the one it fired for. */
  crossEntityRuleHits: number;
  rulesLearned: number;
  /** Left for a later pass because the model gate said the queue was not worth a call yet. */
  deferred: number;
  /** Decided by the built-in heuristics alone, with no rule behind either facet. */
  heuristicDecided: number;
  failed: number;
  providerCalls: number;
  usage: AutomationUsage;
  costMicrousd: number;
  stoppedReason: string | null;
  lastErrorCode: string | null;
}

const emptyCounters = (): FacetRunCounters => ({
  messagesSeen: 0,
  ruleDecided: 0,
  modelDecided: 0,
  domainAssigned: 0,
  intentAssigned: 0,
  entityAssigned: 0,
  crossEntityRuleHits: 0,
  rulesLearned: 0,
  deferred: 0,
  heuristicDecided: 0,
  failed: 0,
  providerCalls: 0,
  usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
  costMicrousd: 0,
  stoppedReason: null,
  lastErrorCode: null,
});

const MAX_CONSECUTIVE_BATCH_FAILURES = 3;

/** Messages a rules-only run reads per page, and the most it sorts in one run. */
const RULES_PAGE_SIZE = 500;
const RULES_RUN_LIMIT = 50_000;

/** What a heuristic decision is worth beside a learned rule's measured confidence. */
const HEURISTIC_CONFIDENCE = 0.6;

/** Sender groups written at once after a batch. The pool holds five connections. */
const PERSIST_CONCURRENCY = 3;

/**
 * How far back "new mail" reaches for the watcher. Anything older that was never classified is
 * backlog, and backlog belongs to the full runs: a freshly connected mailbox holds thousands of
 * unclassified messages, and draining them ten at a time every few minutes would spend the free
 * tier's daily requests before any new mail arrived.
 */
export const NEW_MAIL_WINDOW_MS = 48 * 60 * 60 * 1000;

export interface ClassifyOptions {
  limit?: number;
  /**
   * `backlog`, the default: everything unclassified or stale, newest first — what a full run does.
   * `new`: only mail never classified that arrived inside NEW_MAIL_WINDOW_MS — what the watcher
   * sorts as it lands.
   */
  scope?: 'backlog' | 'new';
  /**
   * Asked once the rules have run: should what they could not settle go to the model now? Absent
   * means yes. The watcher answers no until enough is queued to be worth a call, and the messages
   * stay unclassified — a `message_facets` row is the checkpoint, so nothing is lost by waiting.
   */
  modelGate?: (undecided: gmail_message_metadata[]) => boolean;
  /**
   * Whose share of the shared Gemini key this run spends. Defaults to `new` for the watcher's
   * scope and `backlog` otherwise; onboarding passes its own.
   */
  priority?: GeminiPriority;
  /** Messages per Gemini call. Defaults to AUTOMATION_BATCH_SIZE. */
  batchSize?: number;
  /** Gemini calls in flight at once. Defaults to one. */
  concurrency?: number;
  /** Called after the rules pass and after every model batch, with the counters so far. */
  onProgress?: (counters: FacetRunCounters) => Promise<void>;
}

/**
 * Output tokens a facet result needs. A facet decision is two short strings and two numbers, where
 * a label decision also carried a sentence of prose and up to three reason codes — which is where
 * most of the old output budget went.
 */
const MIN_OUTPUT_TOKENS_PER_MESSAGE = 40;

/**
 * Every message field a facet decision is derived from, and therefore everything `input_hash`
 * covers. Declared once so the hash and the staleness sweep cannot disagree about what "the same
 * input" means.
 *
 * Anything new the classifier is given to read belongs here as well. Sending it a snippet or a
 * sender host without adding it would leave the checkpoint calling a decision current that was
 * made without ever seeing the field.
 */
export const HASHED_MESSAGE_FIELDS = [
  'gmail_message_id',
  'subject',
  'sender_email',
  'snippet',
] as const;

type HashableMessage = Pick<gmail_message_metadata, (typeof HASHED_MESSAGE_FIELDS)[number]>;

function hashMessage(message: HashableMessage, promptVersion: string): string {
  return createHash('sha256')
    .update(
      [...HASHED_MESSAGE_FIELDS.map((field) => message[field] ?? ''), promptVersion].join('|'),
    )
    .digest('hex');
}

function errorCode(error: unknown): string {
  return error instanceof AppError ? error.code : 'INTERNAL_SERVER_ERROR';
}

/**
 * Prisma error codes worth retrying: the connection went away, the pool timed out, a transaction
 * was aborted. Every one is about REACHING the database, not about what was asked of it.
 */
const TRANSIENT_DATABASE_CODES = new Set([
  'P1001', // can't reach the database server
  'P1002', // server reached but timed out
  'P1008', // operation timed out
  'P1011', // TLS error
  'P1017', // server has closed the connection
  'P2024', // timed out fetching a connection from the pool
  'P2028', // transaction API error
  'P2034', // write conflict or deadlock, safe to retry
]);

/**
 * Whether a failure is a TRANSIENT database problem — one that retrying might get past.
 *
 * The distinction decides both what a run reports and whether it tries again, so getting it wrong
 * is expensive in both directions. Matching every `PrismaClient*` error was far too broad: a
 * check-constraint violation is a permanent fact about the data, and treating it as a dropped
 * connection made the runner retry the same doomed message forever while its lease kept renewing.
 * The run looked alive, said DATABASE_UNAVAILABLE, and classified nothing for half an hour.
 */
export function isTransientDatabaseFailure(error: unknown): boolean {
  const name = (error as { name?: unknown } | null)?.name;
  if (name === 'PrismaClientInitializationError' || name === 'PrismaClientRustPanicError') {
    return true;
  }
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && TRANSIENT_DATABASE_CODES.has(code);
}

interface StoredFacetRule extends FacetRoutingRule {
  id: string;
  confidence: number;
  /** The sender the rule was learned from, so a hit on a different one is visibly cross-entity. */
  learnedFromEntity: string | null;
}

export class FacetClassificationService {
  constructor(
    private readonly classifier: FacetClassifier = geminiFacetClassifier,
    private readonly vocabularies: FacetVocabularyRepository = facetVocabularyRepository,
    private readonly policies: AccountPolicySource = accountPolicies,
    private readonly references: () => Promise<ReferenceRule[]> = referenceRules,
  ) {}

  /**
   * Classifies unclassified mail for one account.
   *
   * Resumable by construction: a `message_facets` row IS the checkpoint, so a run that stops on a
   * spent quota simply picks up where it left off, and a message is never classified twice.
   */
  async classifyAccount(
    accountId: string,
    options: ClassifyOptions = {},
  ): Promise<FacetRunCounters> {
    /*
     * Who this mailbox is decides how it is sorted. Only the owner's mail may reach Gemini;
     * everyone else's is sorted by rules and heuristics inside their history window, and the
     * model path below is never entered for them. Without a key the owner is sorted by rules too.
     */
    const policy = await this.policies.forAccount(accountId);
    /*
     * The vocabulary this mailbox approved, resolved before the lease and before a single token is
     * spent. There is no default to fall back to: "career, development, education" describes one
     * person's life, and classifying a second mailbox against it would file that person's mail
     * into a stranger's taxonomy. An account that has approved nothing is refused here.
     */
    const vocabulary = await this.vocabularies.requireApproved(accountId);
    const approvedValues = {
      domain: new Set(vocabulary.domain.map((value) => value.name)),
      intent: new Set(vocabulary.intent.map((value) => value.name)),
    };
    const promptVersion = facetPromptVersion(vocabulary);
    const counters = emptyCounters();
    const now = new Date();
    const token = randomUUID();
    await prisma.automation_states.upsert({
      where: { connected_google_account_id: accountId },
      create: { connected_google_account_id: accountId },
      update: {},
    });
    // The same account-scoped lease the filing run takes, so the two can never run at once against
    // one mailbox and multiple API instances still share one database safely.
    const acquired = await prisma.automation_states.updateMany({
      where: {
        connected_google_account_id: accountId,
        OR: [{ lease_expires_at: null }, { lease_expires_at: { lt: now } }],
      },
      data: {
        lease_token: token,
        lease_expires_at: new Date(now.getTime() + env.AUTOMATION_LEASE_SECONDS * 1000),
      },
    });
    if (acquired.count !== 1) {
      throw new AppError('AUTOMATION_ALREADY_RUNNING', 'Mail automation is already running.', 409);
    }

    try {
      if (policy.mode === 'RULES') {
        return await this.classifyByRules(
          accountId,
          token,
          approvedValues,
          promptVersion,
          policy.windowStart,
          options,
          counters,
        );
      }
      /*
       * The token and cost caps are daily and cumulative since 00:00 UTC, not per run — the
       * scheduler can start several runs in a day after a backoff, and each one taking a fresh
       * full allowance would multiply the ceiling by however many times it retried. The retired
       * taxonomy engine did this accounting; when it went, the accounting had to come here.
       */
      const spentToday = await prisma.automation_runs.aggregate({
        where: {
          connected_google_account_id: accountId,
          started_at: { gte: new Date(new Date().setUTCHours(0, 0, 0, 0)) },
        },
        _sum: { input_tokens: true, output_tokens: true, estimated_cost_microusd: true },
      });
      const inputTokensBefore = spentToday._sum.input_tokens ?? 0;
      const priority = options.priority ?? (options.scope === 'new' ? 'new' : 'backlog');
      const sharedRequestsBefore = await geminiRequestsToday();
      const sharedCeiling = geminiRequestCeiling(priority);
      const batchSize = options.batchSize ?? env.AUTOMATION_BATCH_SIZE;
      const outputTokensBefore = spentToday._sum.output_tokens ?? 0;
      const costBefore = spentToday._sum.estimated_cost_microusd ?? 0;

      const messages =
        options.scope === 'new'
          ? await this.newMessages(accountId, policy.windowStart, options.limit)
          : await this.unclassifiedMessages(
              accountId,
              promptVersion,
              policy.windowStart,
              options.limit,
            );
      counters.messagesSeen = messages.length;
      const rules = await this.facetRules(accountId);

      // Rules before AI. Every message both facets are covered for is decided here, with no model
      // call and no token budget spent; only the remainder reaches Gemini.
      const undecided: Array<{ message: gmail_message_metadata; known: KnownFacets }> = [];
      for (const [index, message] of messages.entries()) {
        if (index % env.AUTOMATION_BATCH_SIZE === 0) await this.renewLease(accountId, token);
        const resolved = resolveFacetRules(rules, {
          subject: message.subject,
          senderEmail: message.sender_email,
        });
        // Rules survive vocabulary changes for auditability, but a removed value must never be
        // allowed to re-enter a new classification run.
        const domainRule =
          resolved.domain && approvedValues.domain.has(resolved.domain.value)
            ? resolved.domain
            : null;
        const intentRule =
          resolved.intent && approvedValues.intent.has(resolved.intent.value)
            ? resolved.intent
            : null;
        const entity = entityFor(message.sender_email);
        for (const hit of [domainRule, intentRule]) {
          if (!hit) continue;
          // The rule generalised past the sender it was learned on. This is the number that says
          // whether facets are earning their keep.
          if (hit.rule.learnedFromEntity && hit.rule.learnedFromEntity !== entity) {
            counters.crossEntityRuleHits += 1;
          }
        }
        if (domainRule && intentRule) {
          counters.ruleDecided += 1;
          await this.persist(
            accountId,
            message,
            entity,
            'RULE',
            {
              domain: domainRule.value,
              domainConfidence: domainRule.rule.confidence,
              intent: intentRule.value,
              intentConfidence: intentRule.rule.confidence,
            },
            promptVersion,
          );
          this.countAssignments(counters, entity, domainRule.value, intentRule.value);
          continue;
        }
        undecided.push({
          message,
          known: {
            domain: domainRule?.value,
            intent: intentRule?.value,
          },
        });
      }
      if (rules.length > 0) {
        await prisma.learned_classification_patterns.updateMany({
          where: { id: { in: rules.map((rule) => rule.id) } },
          data: { last_used_at: new Date() },
        });
      }
      await options.onProgress?.(counters);

      if (
        undecided.length > 0 &&
        options.modelGate &&
        !options.modelGate(undecided.map((entry) => entry.message))
      ) {
        counters.deferred = undecided.length;
        return counters;
      }

      let consecutiveBatchFailures = 0;
      const batches: Array<typeof undecided> = [];
      for (let index = 0; index < undecided.length; index += batchSize) {
        batches.push(undecided.slice(index, index + batchSize));
      }
      let nextBatch = 0;
      /*
       * Up to `concurrency` batches in flight. A call spends most of its time waiting on Gemini —
       * eight seconds for ten messages, against a four-second pacing interval — so one at a time
       * left the shared quota half used while somebody watched a progress bar. The pacer still
       * spaces the request starts, so this never asks faster than the free tier allows.
       */
      const lane = async (): Promise<void> => {
        while (!counters.stoppedReason && nextBatch < batches.length) {
          const batch = batches[nextBatch]!;
          nextBatch += 1;
          // The key's day is shared by every mailbox, so this is checked before the account's own.
          if (sharedRequestsBefore + counters.providerCalls >= sharedCeiling) {
            counters.stoppedReason = 'SHARED_DAILY_LIMIT_REACHED';
            return;
          }
          const roughTokens = Math.ceil(
            batch.reduce(
              (total, entry) =>
                total +
                (entry.message.subject?.length ?? 0) +
                (entry.message.sender_email?.length ?? 0),
              0,
            ) / 4,
          );
          const remainingOutputTokens =
            env.AUTOMATION_MAX_OUTPUT_TOKENS - outputTokensBefore - counters.usage.outputTokens;
          const outputTokenReserve = Math.min(2000, remainingOutputTokens);
          if (
            inputTokensBefore + counters.usage.inputTokens + roughTokens >
              env.AUTOMATION_MAX_INPUT_TOKENS ||
            remainingOutputTokens < batch.length * MIN_OUTPUT_TOKENS_PER_MESSAGE ||
            costBefore +
              counters.costMicrousd +
              estimatedCostMicroUsd({
                inputTokens: roughTokens,
                cachedInputTokens: 0,
                outputTokens: Math.max(0, outputTokenReserve),
              }) >
              env.AUTOMATION_MAX_COST_MICRO_USD
          ) {
            counters.stoppedReason = 'DAILY_BUDGET_REACHED';
            return;
          }
          try {
            await this.renewLease(accountId, token);
            const inputs: FacetClassifierInput[] = batch.map((entry, batchIndex) => ({
              key: `m${batchIndex + 1}`,
              subject: (entry.message.subject ?? '').slice(0, 300),
              sender: (entry.message.sender_email ?? '').slice(0, 320),
              // The real host, not the brand slug: `entityFor` is the entity facet the code already
              // derived, so sending it back duplicated a decided answer and discarded the evidence.
              senderHost: emailIdentity(entry.message.sender_email).senderDomain,
              // Bounded deliberately. Input is the budget that binds a day's filing — every
              // message's metadata is sent whether it ends up filed or not — so this buys the
              // intent signal without doubling what a batch costs to read.
              snippet: (entry.message.snippet ?? '').slice(0, 200),
              ...(entry.known.domain ? { knownDomain: entry.known.domain } : {}),
              ...(entry.known.intent ? { knownIntent: entry.known.intent } : {}),
            }));
            counters.providerCalls += 1;
            const result = await this.classifier.classify(inputs, {
              vocabulary,
              maxOutputTokens: outputTokenReserve,
            });
            counters.usage.inputTokens += result.usage.inputTokens;
            counters.usage.cachedInputTokens += result.usage.cachedInputTokens;
            counters.usage.outputTokens += result.usage.outputTokens;
            counters.costMicrousd += estimatedCostMicroUsd(result.usage);
            const byKey = new Map(result.classifications.map((item) => [item.key, item]));
            // Grouped by sender, one lane each, so two messages that would teach the same rule
            // are learned one after the other while unrelated senders are written side by side.
            const senders = new Map<
              string,
              Array<{ entry: (typeof batch)[number]; key: string }>
            >();
            for (const [batchIndex, entry] of batch.entries()) {
              const sender = senderDomainOf(entry.message);
              senders.set(sender, [
                ...(senders.get(sender) ?? []),
                { entry, key: `m${batchIndex + 1}` },
              ]);
            }
            const written = await forEachWithConcurrency(
              [...senders.values()],
              PERSIST_CONCURRENCY,
              async (group) => {
                for (const { entry, key } of group) {
                  const decision = byKey.get(key)!;
                  // A rule already settled an axis; the model's answer for it is context, not a
                  // vote.
                  const filled = heuristicFacets(
                    {
                      subject: entry.message.subject,
                      senderEmail: entry.message.sender_email,
                      snippet: entry.message.snippet,
                      labelIds: entry.message.label_ids,
                    },
                    approvedValues,
                  );
                  const domain = entry.known.domain ?? decision.domain ?? filled.domain;
                  const intent = entry.known.intent ?? decision.intent ?? filled.intent;
                  const entity = entityFor(entry.message.sender_email);
                  // Each message is written on its own. The model answered for all of them and
                  // those tokens are already spent, so letting one unwritable row discard the
                  // twenty-four beside it throws away work that was paid for and correct.
                  try {
                    await this.persist(
                      accountId,
                      entry.message,
                      entity,
                      'MODEL',
                      {
                        domain,
                        domainConfidence: entry.known.domain ? 1 : decision.domainConfidence,
                        intent,
                        intentConfidence: entry.known.intent ? 1 : decision.intentConfidence,
                      },
                      promptVersion,
                    );
                    counters.modelDecided += 1;
                    this.countAssignments(counters, entity, domain, intent);
                    counters.rulesLearned += await this.learn(
                      accountId,
                      entry.message,
                      decision,
                      entity,
                    );
                  } catch (error) {
                    // A transient fault is the whole batch's problem, and the outer handler
                    // owns it.
                    if (isTransientDatabaseFailure(error)) throw error;
                    counters.failed += 1;
                    captureApiException(error, { operation: 'facet_classification_persist' });
                    logger.warn(
                      { ...safeErrorDetails(error), accountId },
                      'facet classification could not record one message',
                    );
                  }
                }
              },
            );
            const unreachable = written.find((outcome) => outcome.status === 'rejected');
            if (unreachable) throw unreachable.reason;
          } catch (error) {
            counters.failed += batch.length;
            counters.lastErrorCode = errorCode(error);
            if (isTransientDatabaseFailure(error)) {
              // Nothing can be checkpointed while the database is unreachable, so continuing would
              // spend model quota on work that cannot be recorded. Stop, and say so accurately.
              counters.stoppedReason = 'DATABASE_UNAVAILABLE';
            } else if (
              error instanceof GeminiProviderError &&
              error.code === 'PROVIDER_RATE_LIMITED'
            ) {
              counters.stoppedReason = 'PROVIDER_RATE_LIMITED';
            }
            captureApiException(error, { operation: 'facet_classification_batch' });
            logger.error(
              { ...safeErrorDetails(error), accountId },
              'facet classification batch failed',
            );
            if (counters.stoppedReason) return;
            consecutiveBatchFailures += 1;
            if (consecutiveBatchFailures >= MAX_CONSECUTIVE_BATCH_FAILURES) {
              counters.stoppedReason = 'PROVIDER_UNUSABLE';
              return;
            }
            continue;
          }
          consecutiveBatchFailures = 0;
          await options.onProgress?.(counters);
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(options.concurrency ?? 1, batches.length) }, lane),
      );
      return counters;
    } finally {
      invalidatePivotViews(accountId);
      // Releasing the lease is a courtesy, not a correctness requirement — it expires on its own,
      // which is why a crashed run never wedges an account. Letting this throw would replace the
      // real failure with a second one about the same dead connection, so it only ever logs.
      try {
        await prisma.automation_states.updateMany({
          where: { connected_google_account_id: accountId, lease_token: token },
          data: { lease_token: null, lease_expires_at: null },
        });
      } catch (error) {
        logger.warn(
          { ...safeErrorDetails(error), accountId },
          'facet classification could not release its lease; it will expire on its own',
        );
      }
    }
  }

  /**
   * Sorts a mailbox with no model at all: the mailbox's own rules, then the reference rules, then
   * the built-in heuristics, for each facet independently.
   *
   * Nothing here can stop on a budget or a provider, so it is run to the end: every message in the
   * window gets a decision in the same pass, which is what "no unclassified mail" rests on. A
   * decision may still leave a facet empty — a personal note from a friend has no area of life a
   * keyword can name — and the row exists anyway, so the message is in its sender's folder rather
   * than nowhere. Pages are written one statement each: a two-year mailbox is tens of thousands of
   * rows, and a round trip per row would be most of an hour on the free plan.
   */
  private async classifyByRules(
    accountId: string,
    token: string,
    approvedValues: { domain: Set<string>; intent: Set<string> },
    promptVersion: string,
    windowStart: Date | null,
    options: ClassifyOptions,
    counters: FacetRunCounters,
  ): Promise<FacetRunCounters> {
    const own = await this.facetRules(accountId);
    const reference = (await this.references()).map((rule) => ({
      ...rule,
      id: `reference:${rule.kind}:${rule.value}`,
      confidence: rule.share,
      learnedFromEntity: null,
    }));
    const approved = (value: string | null, axis: 'domain' | 'intent') =>
      value && approvedValues[axis].has(value) ? value : null;
    const limit = options.limit ?? RULES_RUN_LIMIT;

    while (counters.messagesSeen < limit) {
      await this.renewLease(accountId, token);
      const page = Math.min(RULES_PAGE_SIZE, limit - counters.messagesSeen);
      const messages =
        options.scope === 'new'
          ? await this.newMessages(accountId, windowStart, page)
          : await this.unclassifiedMessages(accountId, promptVersion, windowStart, page);
      if (messages.length === 0) break;
      counters.messagesSeen += messages.length;

      const rows = messages.map((message) => {
        const routable = { subject: message.subject, senderEmail: message.sender_email };
        const mine = resolveFacetRules(own, routable);
        const borrowed = resolveFacetRules(reference, routable);
        const guessed = heuristicFacets(
          {
            subject: message.subject,
            senderEmail: message.sender_email,
            snippet: message.snippet,
            labelIds: message.label_ids,
          },
          approvedValues,
        );
        const pick = (axis: 'domain' | 'intent') => {
          for (const hit of [mine[axis], borrowed[axis]]) {
            const value = approved(hit?.value ?? null, axis);
            if (value && hit) return { value, confidence: hit.rule.confidence, fromRule: true };
          }
          const value = guessed[axis];
          return value
            ? { value, confidence: HEURISTIC_CONFIDENCE, fromRule: false }
            : { value: null, confidence: 0, fromRule: false };
        };
        const domain = pick('domain');
        const intent = pick('intent');
        const entity = entityFor(message.sender_email);
        const source: 'RULE' | 'HEURISTIC' =
          domain.fromRule || intent.fromRule ? 'RULE' : 'HEURISTIC';
        this.countAssignments(counters, entity, domain.value, intent.value);
        if (source === 'HEURISTIC') counters.heuristicDecided += 1;
        return {
          gmail_message_id: message.id,
          entity,
          domain: domain.value,
          domain_confidence: domain.value ? domain.confidence : null,
          intent: intent.value,
          intent_confidence: intent.value ? intent.confidence : null,
          source,
          prompt_version: promptVersion,
          input_hash: hashMessage(message, promptVersion),
        };
      });
      await this.persistMany(accountId, rows);
      counters.ruleDecided += rows.length;
      await options.onProgress?.(counters);
      if (messages.length < page) break;
    }
    return counters;
  }

  /** One statement for a page of decisions; see `classifyByRules` for why. */
  private async persistMany(
    accountId: string,
    rows: Array<{
      gmail_message_id: string;
      entity: string | null;
      domain: string | null;
      domain_confidence: number | null;
      intent: string | null;
      intent_confidence: number | null;
      source: 'RULE' | 'HEURISTIC';
      prompt_version: string;
      input_hash: string;
    }>,
  ): Promise<void> {
    if (rows.length === 0) return;
    const payload = JSON.stringify(rows);
    await prisma.$executeRaw`
      insert into public.message_facets (
        connected_google_account_id, gmail_message_id, entity, domain, domain_confidence, intent,
        intent_confidence, source, prompt_version, input_hash, classified_at
      )
      select ${accountId}::uuid, r.gmail_message_id, r.entity, r.domain, r.domain_confidence,
        r.intent, r.intent_confidence, r.source::public.facet_source, r.prompt_version,
        r.input_hash, now()
      from jsonb_to_recordset(${payload}::jsonb) as r(
        gmail_message_id uuid, entity text, domain text, domain_confidence double precision,
        intent text, intent_confidence double precision, source text, prompt_version text,
        input_hash text
      )
      on conflict (gmail_message_id) do update set
        entity = excluded.entity,
        domain = excluded.domain,
        domain_confidence = excluded.domain_confidence,
        intent = excluded.intent,
        intent_confidence = excluded.intent_confidence,
        source = excluded.source,
        prompt_version = excluded.prompt_version,
        input_hash = excluded.input_hash,
        classified_at = excluded.classified_at
    `;
  }

  private countAssignments(
    counters: FacetRunCounters,
    entity: string | null,
    domain: string | null,
    intent: string | null,
  ): void {
    if (entity) counters.entityAssigned += 1;
    if (domain) counters.domainAssigned += 1;
    if (intent) counters.intentAssigned += 1;
  }

  private async persist(
    accountId: string,
    message: gmail_message_metadata,
    entity: string | null,
    source: 'RULE' | 'MODEL',
    facets: FacetPair,
    promptVersion: string,
  ): Promise<void> {
    const data = {
      entity,
      domain: facets.domain,
      domain_confidence: facets.domain ? facets.domainConfidence : null,
      intent: facets.intent,
      intent_confidence: facets.intent ? facets.intentConfidence : null,
      source,
      prompt_version: promptVersion,
      input_hash: hashMessage(message, promptVersion),
      classified_at: new Date(),
    };
    await prisma.message_facets.upsert({
      where: { gmail_message_id: message.id },
      create: {
        connected_google_account_id: accountId,
        gmail_message_id: message.id,
        ...data,
      },
      update: data,
    });
  }

  /**
   * Promotes a confident model decision into a routing rule so the next message like it costs no
   * tokens at all.
   *
   * Subject patterns are preferred, and the preference is the point. A sender-domain rule can only
   * ever say what one organisation's mail is about, so it can never fire for a sender it was not
   * learned on. A subject phrase carries an intent across every brand alive: learn "insufficient
   * funds -> payment-failed" from one broker and it files the bank and the streaming service too.
   * The domain axis goes the other way — what a brand's mail is ABOUT is stable per brand and not
   * readable from a phrase — so it is learned onto the sender domain.
   */
  private async learn(
    accountId: string,
    message: gmail_message_metadata,
    decision: FacetClassification,
    entity: string | null,
  ): Promise<number> {
    const confident = (confidence: number) => confidence >= env.AUTOMATION_PATTERN_MIN_CONFIDENCE;
    let learned = 0;

    if (decision.intent && confident(decision.intentConfidence)) {
      const phrase = stableSubjectPhrase(message.subject);
      if (phrase) {
        learned += await this.upsertRule(accountId, 'SUBJECT_CONTAINS', phrase, {
          facet_intent: decision.intent,
          confidence: decision.intentConfidence,
          entity,
        });
      } else {
        // No phrase generalises, so fall back to the narrower rule rather than learning nothing.
        const domain = normalizeRuleValue('SENDER_DOMAIN', senderDomainOf(message));
        if (domain) {
          learned += await this.upsertRule(accountId, 'SENDER_DOMAIN', domain, {
            facet_intent: decision.intent,
            confidence: decision.intentConfidence,
            entity,
          });
        }
      }
    }

    if (decision.domain && confident(decision.domainConfidence)) {
      const domain = normalizeRuleValue('SENDER_DOMAIN', senderDomainOf(message));
      if (domain) {
        learned += await this.upsertRule(accountId, 'SENDER_DOMAIN', domain, {
          facet_domain: decision.domain,
          confidence: decision.domainConfidence,
          entity,
        });
      }
    }
    return learned;
  }

  /**
   * Writes one facet onto a rule, leaving every other column — including the label columns a
   * pre-facet rule already carries — exactly as it found them.
   *
   * A rule that already resolves the same facet to a DIFFERENT value has been contradicted by the
   * mail itself, so it is deactivated rather than flipped: one disagreement is not evidence for
   * the new answer, only against the old one. A planner rule is the user's own decision and is
   * never touched.
   */
  private async upsertRule(
    accountId: string,
    kind: 'SUBJECT_CONTAINS' | 'SENDER_DOMAIN',
    value: string,
    facet: {
      facet_domain?: string;
      facet_intent?: string;
      confidence: number;
      entity: string | null;
    },
  ): Promise<number> {
    const key = {
      connected_google_account_id: accountId,
      rule_kind: kind,
      match_value: value,
    };
    const existing = await prisma.learned_classification_patterns.findUnique({
      where: { connected_google_account_id_rule_kind_match_value: key },
    });
    const conflicts =
      existing &&
      ((facet.facet_domain &&
        existing.facet_domain &&
        existing.facet_domain !== facet.facet_domain) ||
        (facet.facet_intent &&
          existing.facet_intent &&
          existing.facet_intent !== facet.facet_intent));
    if (conflicts) {
      if (existing.rule_source === 'PLANNER') return 0;
      await prisma.learned_classification_patterns.update({
        where: { id: existing.id },
        data: { active: false },
      });
      return 0;
    }
    const assignment = {
      ...(facet.facet_domain ? { facet_domain: facet.facet_domain } : {}),
      ...(facet.facet_intent ? { facet_intent: facet.facet_intent } : {}),
    };
    await prisma.learned_classification_patterns.upsert({
      where: { connected_google_account_id_rule_kind_match_value: key },
      create: {
        ...key,
        ...assignment,
        rule_source: 'LEARNED',
        learned_from_entity: facet.entity,
        confidence: facet.confidence,
        successful_apply_count: 1,
      },
      update: {
        ...assignment,
        sample_count: { increment: 1 },
        confidence: Math.max(existing?.confidence ?? 0, facet.confidence),
      },
    });
    return existing ? 0 : 1;
  }

  /** Active rules that resolve at least one facet. Rules with no facet belong to the filing path. */
  private async facetRules(accountId: string): Promise<StoredFacetRule[]> {
    const stored = await prisma.learned_classification_patterns.findMany({
      where: {
        connected_google_account_id: accountId,
        active: true,
        OR: [{ facet_domain: { not: null } }, { facet_intent: { not: null } }],
        AND: [
          {
            OR: [
              { rule_source: 'PLANNER' },
              {
                confidence: { gte: env.AUTOMATION_PATTERN_MIN_CONFIDENCE },
                sample_count: { gte: env.AUTOMATION_PATTERN_MIN_SAMPLES },
              },
            ],
          },
        ],
      },
    });
    return stored.map((rule) => ({
      id: rule.id,
      kind: rule.rule_kind,
      value: rule.match_value,
      domain: rule.facet_domain,
      intent: rule.facet_intent,
      confidence: rule.confidence,
      // A SENDER_DOMAIN rule is by definition tied to the sender it names, so it can never fire
      // anywhere else; only a subject rule can, and only its origin is worth recording.
      learnedFromEntity: rule.rule_kind === 'SUBJECT_CONTAINS' ? rule.learned_from_entity : null,
    }));
  }

  /** Mail this account is willing to classify at all. Spam and drafts are never facetted. */
  private classifiableWhere(accountId: string, windowStart: Date | null = null) {
    return {
      connected_google_account_id: accountId,
      deleted_at: null,
      // Outside the window is outside the mailbox, as far as sorting is concerned.
      ...(windowStart ? { internal_date: { gte: windowStart } } : {}),
      is_draft: false,
      is_sent: false,
      is_trashed: false,
      NOT: { label_ids: { hasSome: ['SPAM', 'TRASH', 'DRAFT'] } },
    };
  }

  /** Mail that has never been classified and arrived recently, newest first. */
  private newMessages(accountId: string, windowStart: Date | null, limit?: number) {
    return prisma.gmail_message_metadata.findMany({
      where: {
        ...this.classifiableWhere(accountId, windowStart),
        facets: null,
        internal_date: {
          gte: new Date(Math.max(Date.now() - NEW_MAIL_WINDOW_MS, windowStart?.getTime() ?? 0)),
        },
      },
      orderBy: { internal_date: 'desc' },
      take: limit ?? env.AUTOMATION_MAX_MESSAGES_PER_RUN,
    });
  }

  private async unclassifiedMessages(
    accountId: string,
    promptVersion: string,
    windowStart: Date | null,
    limit?: number,
  ) {
    const take = limit ?? env.AUTOMATION_MAX_MESSAGES_PER_RUN;
    const fresh = await prisma.gmail_message_metadata.findMany({
      where: {
        ...this.classifiableWhere(accountId, windowStart),
        // Never classified, or classified under a vocabulary that has since changed. Recording
        // prompt_version was pointless while nothing acted on it: bumping the vocabulary left
        // every existing message describing itself in terms that no longer existed. Re-running
        // now picks those up, and `persist` upserts, so a re-classification replaces in place.
        OR: [{ facets: null }, { facets: { prompt_version: { not: promptVersion } } }],
      },
      orderBy: { internal_date: 'desc' },
      take,
    });
    if (fresh.length >= take) return fresh;

    // Room left in the run, so spend it re-checking decisions against the input they were made
    // from. Newest mail first, and never more than the run's own ceiling.
    const stale = await this.staleByInput(
      accountId,
      promptVersion,
      windowStart,
      take - fresh.length,
    );
    return [...fresh, ...stale];
  }

  /**
   * Mail whose facets were derived from input that has since changed.
   *
   * `input_hash` records exactly what a decision was made from, and until now nothing ever read
   * it — the same dead-column mistake `prompt_version` made before it. Sync upserts `subject` and
   * `sender_email` on every pass, so a corrected subject would otherwise keep the facets chosen
   * from text the message no longer carries, and stay filed under them forever.
   *
   * Ordered by `last_synced_at` because an incremental sync only writes the messages that
   * actually changed, which makes recently-touched mail exactly where drift lives. It is a
   * bounded sweep, not a full scan: a wholesale resync is worked through over successive runs
   * rather than in one, and it only ever uses budget a run was not going to spend anyway.
   */
  private async staleByInput(
    accountId: string,
    promptVersion: string,
    windowStart: Date | null,
    limit: number,
  ) {
    if (limit <= 0) return [];
    // Asked of the decisions rather than of the mail: the question is whether each recorded
    // decision still matches the message it was made from.
    const decided = await prisma.message_facets.findMany({
      where: {
        connected_google_account_id: accountId,
        prompt_version: promptVersion,
        message: this.classifiableWhere(accountId, windowStart),
      },
      orderBy: { message: { last_synced_at: 'desc' } },
      take: limit,
      select: {
        input_hash: true,
        message: {
          select: {
            id: true,
            gmail_message_id: true,
            subject: true,
            sender_email: true,
            snippet: true,
          },
        },
      },
    });
    const staleIds = decided
      .filter((row) => row.input_hash !== hashMessage(row.message, promptVersion))
      .map((row) => row.message.id);
    if (staleIds.length === 0) return [];
    return prisma.gmail_message_metadata.findMany({
      where: { id: { in: staleIds } },
      orderBy: { internal_date: 'desc' },
    });
  }

  private async renewLease(accountId: string, token: string): Promise<void> {
    const renewed = await prisma.automation_states.updateMany({
      where: { connected_google_account_id: accountId, lease_token: token },
      data: {
        lease_expires_at: new Date(Date.now() + env.AUTOMATION_LEASE_SECONDS * 1000),
      },
    });
    if (renewed.count !== 1) {
      throw new AppError('AUTOMATION_ALREADY_RUNNING', 'The automation lease was replaced.', 409);
    }
  }
}

/** Facets a rule already settled, so the model's answer for them is context rather than a vote. */
interface KnownFacets {
  domain?: string | undefined;
  intent?: string | undefined;
}

interface FacetPair {
  domain: string | null;
  domainConfidence: number;
  intent: string | null;
  intentConfidence: number;
}

function senderDomainOf(message: gmail_message_metadata): string {
  return (message.sender_email ?? '').split('@').at(-1) ?? '';
}

export const facetClassificationService = new FacetClassificationService();
