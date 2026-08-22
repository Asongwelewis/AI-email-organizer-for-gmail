import { randomUUID } from 'node:crypto';
import type { automation_action_status } from '@prisma/client';

import { env } from '@api/config/env.js';
import { logger, safeErrorDetails } from '@api/config/logger.js';
import { prisma } from '@api/database/prisma.js';
import { AppError } from '@api/errors/AppError.js';
import {
  buildPivot,
  pivotLeafFor,
  type PivotFacet,
  type PivotResult,
} from '@api/features/label-discovery/pivot.js';
import { pivotService, type PivotService } from '@api/features/labels/pivot.service.js';
import { automationGmailService, type AutomationGmailService } from './automation-gmail.service.js';
import { NO_LABEL } from './automation.types.js';

/**
 * Files mail into the folders the canonical pivot produced.
 *
 * The classification is already done and stored, so this pass spends no tokens and asks the model
 * nothing: it is a projection of `message_facets` through one facet ordering onto Gmail. That
 * separation is what makes re-filing cheap — changing the pivot re-files the mailbox without
 * re-classifying a single message.
 *
 * Every message ends with exactly one MailMind label or none, which is why the apply is exclusive:
 * a message filed under the old tree has its old label removed in the same call that adds its new
 * one.
 */

export interface FilingCounters {
  seen: number;
  filed: number;
  none: number;
  reviewRequired: number;
  failed: number;
  /** Decisions whose facets came from a routing rule rather than a model call. */
  fromRules: number;
  fromModel: number;
  labelsCreated: number;
  labelsReused: number;
  /** Messages whose stale MailMind label from the previous tree was removed. */
  staleLabelsRemoved: number;
}

const emptyCounters = (): FilingCounters => ({
  seen: 0,
  filed: 0,
  none: 0,
  reviewRequired: 0,
  failed: 0,
  fromRules: 0,
  fromModel: 0,
  labelsCreated: 0,
  labelsReused: 0,
  staleLabelsRemoved: 0,
});

interface FilingOptions {
  limit?: number;
  /** Resolve and record every decision, but make no Gmail call at all. */
  dryRun?: boolean;
}

/**
 * The confidence of a filing decision: the weakest facet the folder actually rests on.
 *
 * Only the facets the message was placed by are counted. A message that landed at depth 1 under
 * ["entity", "intent"] was placed by its entity alone, and its intent — however uncertain — had no
 * say in where it went, so holding the message for review over it would be reviewing a decision
 * nobody made.
 */
export function filingConfidence(
  order: PivotFacet[],
  depth: number,
  confidences: { entity: number; domain: number | null; intent: number | null },
): number {
  const used = order.slice(0, depth);
  const values = used.map((facet) => confidences[facet] ?? 0);
  return values.length === 0 ? 0 : Math.min(...values);
}

export class FacetFilingService {
  constructor(
    private readonly gmail: AutomationGmailService = automationGmailService,
    private readonly pivots: PivotService = pivotService,
  ) {}

  async fileAccount(
    accountId: string,
    userId: string,
    options: FilingOptions = {},
  ): Promise<FilingCounters & { pivot: PivotResult }> {
    const counters = emptyCounters();
    const now = new Date();
    const token = randomUUID();
    await prisma.automation_states.upsert({
      where: { connected_google_account_id: accountId },
      create: { connected_google_account_id: accountId },
      update: {},
    });
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
      const settings = await this.pivots.settings(accountId);
      const faceted = await this.pivots.facetedMessages(accountId);
      const pivot = buildPivot(faceted, settings.canonicalPivot, {
        minMessages: settings.minMessages,
      });
      if (pivot.nodes.length === 0) {
        throw new AppError(
          'AUTOMATION_NO_APPROVED_LABELS',
          'The pivot produced no folders; classify mail before filing.',
          409,
        );
      }

      // Every MailMind label that exists, so a message's stale one can be recognised and removed.
      const mailMindLabels = await prisma.gmail_labels.findMany({
        where: { connected_google_account_id: accountId, name: { startsWith: 'MailMind/' } },
        select: { gmail_label_id: true },
      });
      const mailMindLabelIds = new Set(mailMindLabels.map((label) => label.gmail_label_id));

      const rows = await prisma.message_facets.findMany({
        where: { connected_google_account_id: accountId },
        include: {
          message: {
            select: { id: true, gmail_message_id: true, label_ids: true, subject: true },
          },
        },
        orderBy: { classified_at: 'desc' },
        ...(options.limit ? { take: options.limit } : {}),
      });

      const runId = await this.openRun(accountId);
      for (const [index, row] of rows.entries()) {
        if (index % 25 === 0) await this.renewLease(accountId, token);
        counters.seen += 1;
        if (row.source === 'RULE') counters.fromRules += 1;
        else counters.fromModel += 1;

        const leaf = pivotLeafFor(
          {
            id: row.gmail_message_id,
            entity: row.entity,
            domain: row.domain,
            intent: row.intent,
          },
          pivot,
        );
        const stale = row.message.label_ids.filter((id) => mailMindLabelIds.has(id) && id !== null);

        if (!leaf) {
          await this.record(runId, accountId, userId, row.gmail_message_id, {
            status: 'SKIPPED',
            labelName: NO_LABEL,
            labelPath: null,
            confidence: 0,
            source: row.source,
            explanation: this.explain(row.entity, row.domain, row.intent, 'fits no folder'),
          });
          counters.none += 1;
          // A message the old tree filed is now unfiled, so its old label has to come off.
          if (stale.length > 0 && !options.dryRun) {
            await this.gmail.applyExclusiveLabel(
              accountId,
              row.message.gmail_message_id,
              null,
              stale,
            );
            counters.staleLabelsRemoved += 1;
            await this.forgetLabels(row.gmail_message_id, stale);
          }
          continue;
        }

        const confidence = filingConfidence(pivot.order, leaf.depth, {
          entity: row.entity_confidence,
          domain: row.domain_confidence,
          intent: row.intent_confidence,
        });
        if (confidence < env.AUTOMATION_CONFIDENCE_THRESHOLD) {
          await this.record(runId, accountId, userId, row.gmail_message_id, {
            status: 'REVIEW_REQUIRED',
            labelName: leaf.leafName,
            labelPath: leaf.fullPath,
            confidence,
            source: row.source,
            explanation: this.explain(row.entity, row.domain, row.intent, 'held for review'),
          });
          counters.reviewRequired += 1;
          continue;
        }

        if (options.dryRun) {
          counters.filed += 1;
          continue;
        }
        try {
          const label = await this.gmail.ensureLabel(accountId, leaf.fullPath);
          if (label.created) counters.labelsCreated += 1;
          else counters.labelsReused += 1;
          const toRemove = stale.filter((id) => id !== label.id);
          await this.gmail.applyExclusiveLabel(
            accountId,
            row.message.gmail_message_id,
            label.id,
            toRemove,
          );
          if (toRemove.length > 0) counters.staleLabelsRemoved += 1;
          await this.record(runId, accountId, userId, row.gmail_message_id, {
            status: 'APPLIED',
            labelName: leaf.leafName,
            labelPath: leaf.fullPath,
            confidence,
            source: row.source,
            explanation: this.explain(row.entity, row.domain, row.intent, 'filed'),
            gmailLabelId: label.id,
            appliedAt: new Date(),
          });
          await prisma.gmail_message_metadata.update({
            where: { id: row.gmail_message_id },
            data: {
              label_ids: [
                ...new Set([
                  ...row.message.label_ids.filter((id) => !toRemove.includes(id)),
                  label.id,
                ]),
              ],
            },
          });
          counters.filed += 1;
        } catch (error) {
          counters.failed += 1;
          logger.warn(
            { ...safeErrorDetails(error), accountId },
            'facet filing failed for one message',
          );
        }
      }
      await this.closeRun(runId, counters);
      return { ...counters, pivot };
    } finally {
      await prisma.automation_states.updateMany({
        where: { connected_google_account_id: accountId, lease_token: token },
        data: { lease_token: null, lease_expires_at: null },
      });
    }
  }

  /** Short, and built only from facet values — never from the message's own text. */
  private explain(
    entity: string | null,
    domain: string | null,
    intent: string | null,
    outcome: string,
  ): string {
    const parts = [
      entity ? `entity ${entity}` : null,
      domain ? `domain ${domain}` : null,
      intent ? `intent ${intent}` : null,
    ].filter(Boolean);
    return `${parts.join(', ') || 'no facets'} — ${outcome}`.slice(0, 120);
  }

  private async record(
    runId: string,
    accountId: string,
    userId: string,
    messageId: string,
    decision: {
      status: automation_action_status;
      labelName: string;
      labelPath: string | null;
      confidence: number;
      source: 'RULE' | 'MODEL';
      explanation: string;
      gmailLabelId?: string;
      appliedAt?: Date;
    },
  ): Promise<void> {
    // One action row per message, so re-filing REPLACES the previous decision rather than adding a
    // second one. The pre-pivot snapshot holds the decisions this overwrites.
    const data = {
      automation_run_id: runId,
      connected_google_account_id: accountId,
      user_id: userId,
      status: decision.status,
      label_name: decision.labelName,
      label_path: decision.labelPath,
      confidence: decision.confidence,
      source: decision.source === 'RULE' ? ('LEARNED_PATTERN' as const) : ('AI' as const),
      explanation: decision.explanation,
      reason_codes: ['FACET_PIVOT', decision.source],
      input_hash: `facet:${messageId}`,
      gmail_label_id: decision.gmailLabelId ?? null,
      applied_at: decision.appliedAt ?? null,
      last_error_code: null,
    };
    await prisma.automation_message_actions.upsert({
      where: { gmail_message_id: messageId },
      create: { gmail_message_id: messageId, ...data },
      update: data,
    });
  }

  private async forgetLabels(messageId: string, removed: string[]): Promise<void> {
    const message = await prisma.gmail_message_metadata.findUnique({
      where: { id: messageId },
      select: { label_ids: true },
    });
    if (!message) return;
    await prisma.gmail_message_metadata.update({
      where: { id: messageId },
      data: { label_ids: message.label_ids.filter((id) => !removed.includes(id)) },
    });
  }

  private async openRun(accountId: string): Promise<string> {
    const run = await prisma.automation_runs.create({
      data: {
        connected_google_account_id: accountId,
        idempotency_key: `${accountId}:facet-filing:${randomUUID()}`,
        trigger: 'MANUAL',
      },
    });
    return run.id;
  }

  private async closeRun(runId: string, counters: FilingCounters): Promise<void> {
    await prisma.automation_runs.update({
      where: { id: runId },
      data: {
        status: counters.failed > 0 ? 'PARTIAL' : 'COMPLETED',
        completed_at: new Date(),
        messages_seen: counters.seen,
        pattern_reused_count: counters.fromRules,
        // No model call happens here: the classification was done and stored by the facet pass.
        ai_classified_count: 0,
        review_required_count: counters.reviewRequired,
        no_label_skipped_count: counters.none,
        labels_created_count: counters.labelsCreated,
        labels_reused_count: counters.labelsReused,
        messages_labeled_count: counters.filed,
        failed_count: counters.failed,
      },
    });
  }

  private async renewLease(accountId: string, token: string): Promise<void> {
    const renewed = await prisma.automation_states.updateMany({
      where: { connected_google_account_id: accountId, lease_token: token },
      data: { lease_expires_at: new Date(Date.now() + env.AUTOMATION_LEASE_SECONDS * 1000) },
    });
    if (renewed.count !== 1) {
      throw new AppError('AUTOMATION_ALREADY_RUNNING', 'The automation lease was replaced.', 409);
    }
  }
}

export const facetFilingService = new FacetFilingService();
