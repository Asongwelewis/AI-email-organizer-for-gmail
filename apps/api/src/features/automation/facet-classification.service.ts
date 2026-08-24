import { createHash, randomUUID } from 'node:crypto';
import type { gmail_message_metadata } from '@prisma/client';

import { env } from '@api/config/env.js';
import { logger, safeErrorDetails } from '@api/config/logger.js';
import { prisma } from '@api/database/prisma.js';
import { AppError } from '@api/errors/AppError.js';
import { entityFor } from '@api/features/label-discovery/entity.js';
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
import {
  FACET_CLASSIFIER_PROMPT_VERSION,
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
  failed: 0,
  providerCalls: 0,
  usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
  costMicrousd: 0,
  stoppedReason: null,
  lastErrorCode: null,
});

const MAX_CONSECUTIVE_BATCH_FAILURES = 3;

/**
 * Output tokens a facet result needs. A facet decision is two short strings and two numbers, where
 * a label decision also carried a sentence of prose and up to three reason codes — which is where
 * most of the old output budget went.
 */
const MIN_OUTPUT_TOKENS_PER_MESSAGE = 40;

function hashMessage(message: gmail_message_metadata): string {
  return createHash('sha256')
    .update(
      [
        message.gmail_message_id,
        message.subject ?? '',
        message.sender_email ?? '',
        FACET_CLASSIFIER_PROMPT_VERSION,
      ].join('|'),
    )
    .digest('hex');
}

function errorCode(error: unknown): string {
  return error instanceof AppError ? error.code : 'INTERNAL_SERVER_ERROR';
}

interface StoredFacetRule extends FacetRoutingRule {
  id: string;
  confidence: number;
  /** The sender the rule was learned from, so a hit on a different one is visibly cross-entity. */
  learnedFromEntity: string | null;
}

export class FacetClassificationService {
  constructor(private readonly classifier: FacetClassifier = geminiFacetClassifier) {}

  /**
   * Classifies unclassified mail for one account.
   *
   * Resumable by construction: a `message_facets` row IS the checkpoint, so a run that stops on a
   * spent quota simply picks up where it left off, and a message is never classified twice.
   */
  async classifyAccount(
    accountId: string,
    options: { limit?: number } = {},
  ): Promise<FacetRunCounters> {
    if (!env.GEMINI_API_KEY) {
      throw new AppError('AUTOMATION_NOT_CONFIGURED', 'Gemini is not configured.', 503);
    }
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
      const messages = await this.unclassifiedMessages(accountId, options.limit);
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
        const entity = entityFor(message.sender_email);
        for (const hit of [resolved.domain, resolved.intent]) {
          if (!hit) continue;
          // The rule generalised past the sender it was learned on. This is the number that says
          // whether facets are earning their keep.
          if (hit.rule.learnedFromEntity && hit.rule.learnedFromEntity !== entity) {
            counters.crossEntityRuleHits += 1;
          }
        }
        if (resolved.domain && resolved.intent) {
          counters.ruleDecided += 1;
          await this.persist(accountId, message, entity, 'RULE', {
            domain: resolved.domain.value,
            domainConfidence: resolved.domain.rule.confidence,
            intent: resolved.intent.value,
            intentConfidence: resolved.intent.rule.confidence,
          });
          this.countAssignments(counters, entity, resolved.domain.value, resolved.intent.value);
          continue;
        }
        undecided.push({
          message,
          known: {
            domain: resolved.domain?.value,
            intent: resolved.intent?.value,
          },
        });
      }
      if (rules.length > 0) {
        await prisma.learned_classification_patterns.updateMany({
          where: { id: { in: rules.map((rule) => rule.id) } },
          data: { last_used_at: new Date() },
        });
      }

      let consecutiveBatchFailures = 0;
      for (let index = 0; index < undecided.length; index += env.AUTOMATION_BATCH_SIZE) {
        const batch = undecided.slice(index, index + env.AUTOMATION_BATCH_SIZE);
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
          env.AUTOMATION_MAX_OUTPUT_TOKENS - counters.usage.outputTokens;
        const outputTokenReserve = Math.min(2000, remainingOutputTokens);
        if (
          counters.usage.inputTokens + roughTokens > env.AUTOMATION_MAX_INPUT_TOKENS ||
          remainingOutputTokens < batch.length * MIN_OUTPUT_TOKENS_PER_MESSAGE ||
          counters.costMicrousd +
            estimatedCostMicroUsd({
              inputTokens: roughTokens,
              cachedInputTokens: 0,
              outputTokens: Math.max(0, outputTokenReserve),
            }) >
            env.AUTOMATION_MAX_COST_MICRO_USD
        ) {
          counters.stoppedReason = 'DAILY_BUDGET_REACHED';
          break;
        }
        try {
          await this.renewLease(accountId, token);
          const inputs: FacetClassifierInput[] = batch.map((entry, batchIndex) => ({
            key: `m${batchIndex + 1}`,
            subject: (entry.message.subject ?? '').slice(0, 300),
            sender: (entry.message.sender_email ?? '').slice(0, 320),
            senderDomain: entityFor(entry.message.sender_email) ?? '',
            ...(entry.known.domain ? { knownDomain: entry.known.domain } : {}),
            ...(entry.known.intent ? { knownIntent: entry.known.intent } : {}),
          }));
          counters.providerCalls += 1;
          const result = await this.classifier.classify(inputs, {
            maxOutputTokens: outputTokenReserve,
          });
          counters.usage.inputTokens += result.usage.inputTokens;
          counters.usage.cachedInputTokens += result.usage.cachedInputTokens;
          counters.usage.outputTokens += result.usage.outputTokens;
          counters.costMicrousd += estimatedCostMicroUsd(result.usage);
          const byKey = new Map(result.classifications.map((item) => [item.key, item]));
          for (const [batchIndex, entry] of batch.entries()) {
            const decision = byKey.get(`m${batchIndex + 1}`)!;
            // A rule already settled an axis; the model's answer for it is context, not a vote.
            const domain = entry.known.domain ?? decision.domain;
            const intent = entry.known.intent ?? decision.intent;
            const entity = entityFor(entry.message.sender_email);
            counters.modelDecided += 1;
            await this.persist(accountId, entry.message, entity, 'MODEL', {
              domain,
              domainConfidence: entry.known.domain ? 1 : decision.domainConfidence,
              intent,
              intentConfidence: entry.known.intent ? 1 : decision.intentConfidence,
            });
            this.countAssignments(counters, entity, domain, intent);
            counters.rulesLearned += await this.learn(accountId, entry.message, decision, entity);
          }
        } catch (error) {
          counters.failed += batch.length;
          counters.lastErrorCode = errorCode(error);
          if (error instanceof GeminiProviderError && error.code === 'PROVIDER_RATE_LIMITED') {
            counters.stoppedReason = 'PROVIDER_RATE_LIMITED';
          }
          logger.error(
            { ...safeErrorDetails(error), accountId },
            'facet classification batch failed',
          );
          if (counters.stoppedReason) break;
          consecutiveBatchFailures += 1;
          if (consecutiveBatchFailures >= MAX_CONSECUTIVE_BATCH_FAILURES) {
            counters.stoppedReason = 'PROVIDER_UNUSABLE';
            break;
          }
          continue;
        }
        consecutiveBatchFailures = 0;
      }
      return counters;
    } finally {
      await prisma.automation_states.updateMany({
        where: { connected_google_account_id: accountId, lease_token: token },
        data: { lease_token: null, lease_expires_at: null },
      });
    }
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
  ): Promise<void> {
    const data = {
      entity,
      domain: facets.domain,
      domain_confidence: facets.domain ? facets.domainConfidence : null,
      intent: facets.intent,
      intent_confidence: facets.intent ? facets.intentConfidence : null,
      source,
      prompt_version: FACET_CLASSIFIER_PROMPT_VERSION,
      input_hash: hashMessage(message),
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

  private async unclassifiedMessages(accountId: string, limit?: number) {
    return prisma.gmail_message_metadata.findMany({
      where: {
        connected_google_account_id: accountId,
        deleted_at: null,
        is_draft: false,
        is_sent: false,
        is_trashed: false,
        sender_email: { not: null },
        NOT: { label_ids: { hasSome: ['SPAM', 'TRASH', 'DRAFT'] } },
        facets: null,
      },
      orderBy: { internal_date: 'desc' },
      take: limit ?? env.AUTOMATION_MAX_MESSAGES_PER_RUN,
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
