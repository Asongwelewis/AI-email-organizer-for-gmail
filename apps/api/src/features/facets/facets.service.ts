import {
  activityRepository,
  type ActivityRepository,
} from '@api/features/activity/activity.repository.js';
import {
  activityService,
  type ActivityService,
  type StartedRun,
} from '@api/features/activity/activity.service.js';
import {
  facetClassificationService,
  type FacetClassificationService,
} from '@api/features/automation/facet-classification.service.js';
import {
  facetFilingService,
  type FacetFilingService,
} from '@api/features/automation/facet-filing.service.js';
import {
  pivotService,
  type PivotApplyResult,
  type PivotPlan,
  type PivotService,
} from '@api/features/labels/pivot.service.js';
import type { PivotFacet, PivotResult } from '@api/features/label-discovery/pivot.js';
import {
  messageSearchService,
  type FacetVocabulary,
  type MessageSearchService,
  type SearchFilters,
  type SearchResult,
} from './message-search.service.js';

/**
 * The HTTP surface of the facet pipeline.
 *
 * Every one of these already existed as a service and was reachable only from a `tsx` script, so
 * the pipeline that classifies and files a real mailbox could not be operated from a browser at
 * all. Nothing here decides anything: it resolves the caller's account, wraps the long-running
 * halves in an activity run so the client has something to poll, and hands the rest straight to
 * the service that owns it.
 *
 * The two long halves answer 202 for the same reason the initial sync does — classifying a
 * mailbox is thousands of paced Gemini calls and filing it is one Gmail call per message, both
 * far longer than a browser will hold a request. Reading and planning are pure functions of
 * stored facets, so they answer inline.
 */
export class FacetsService {
  constructor(
    private readonly classification: FacetClassificationService = facetClassificationService,
    private readonly filing: FacetFilingService = facetFilingService,
    private readonly pivots: PivotService = pivotService,
    private readonly activity: ActivityService = activityService,
    private readonly accounts: ActivityRepository = activityRepository,
    private readonly search_: MessageSearchService = messageSearchService,
  ) {}

  /** Classifies unclassified mail into facets. 202: the client polls the run id. */
  async startClassification(userId: string): Promise<StartedRun> {
    const account = await this.accounts.activeAccountForUser(userId);
    const started = await this.activity.start({
      accountId: account.id,
      kind: 'FACET_CLASSIFICATION',
      trigger: 'MANUAL',
    });
    if (!started.alreadyRunning) {
      this.activity.runDetached(started.runId, async (report) => {
        const counters = await this.classification.classifyAccount(account.id);
        const decided = counters.ruleDecided + counters.modelDecided;
        await report({ processed: decided, total: counters.messagesSeen });
        return {
          state: counters.stoppedReason ? 'STOPPED' : 'SUCCEEDED',
          stopReason: counters.stoppedReason,
          errorCode: counters.lastErrorCode,
          processed: decided,
          total: counters.messagesSeen,
          counts: {
            messagesSeen: counters.messagesSeen,
            ruleDecided: counters.ruleDecided,
            modelDecided: counters.modelDecided,
            crossEntityRuleHits: counters.crossEntityRuleHits,
            rulesLearned: counters.rulesLearned,
            failed: counters.failed,
            providerCalls: counters.providerCalls,
            estimatedCostMicrousd: counters.costMicrousd,
          },
        };
      });
    }
    return started;
  }

  /** Projects stored facets onto Gmail through the canonical pivot. 202: one call per message. */
  async startFiling(userId: string): Promise<StartedRun> {
    const account = await this.accounts.activeAccountForUser(userId);
    const started = await this.activity.start({
      accountId: account.id,
      kind: 'AUTOMATION_FILING',
      trigger: 'MANUAL',
    });
    if (!started.alreadyRunning) {
      this.activity.runDetached(started.runId, async (report) => {
        const counters = await this.filing.fileAccount(account.id, userId);
        await report({ processed: counters.filed, total: counters.seen });
        return {
          state: 'SUCCEEDED',
          processed: counters.filed,
          total: counters.seen,
          counts: {
            messagesSeen: counters.seen,
            messagesLabeled: counters.filed,
            reviewRequired: counters.reviewRequired,
            noLabelSkipped: counters.none,
            staleLabelsRemoved: counters.staleLabelsRemoved,
            labelsCreated: counters.labelsCreated,
            labelsReused: counters.labelsReused,
            failed: counters.failed,
          },
          featureRunId: counters.runId,
        };
      });
    }
    return started;
  }

  async settings(userId: string): Promise<{ canonicalPivot: PivotFacet[]; minMessages: number }> {
    const account = await this.accounts.activeAccountForUser(userId);
    return this.pivots.settings(account.id);
  }

  async setSettings(
    userId: string,
    order: PivotFacet[],
    minMessages?: number,
  ): Promise<{ canonicalPivot: PivotFacet[]; minMessages: number }> {
    const account = await this.accounts.activeAccountForUser(userId);
    await this.pivots.setPivot(account.id, order, minMessages);
    return this.pivots.settings(account.id);
  }

  /**
   * What applying the canonical pivot would do. Reads only — `buildPivot` is a pure function of
   * the facet rows, which is what makes a preview cheap enough to answer inline.
   */
  async plan(userId: string): Promise<PivotPlan> {
    const account = await this.accounts.activeAccountForUser(userId);
    return this.pivots.plan(account.id);
  }

  /**
   * Any ordering at all, materialised or not. This is the answer to "what would my mail look like
   * arranged the other way", and it costs no Gmail call and no model call — the same facet rows,
   * pivoted differently.
   */
  async view(userId: string, order?: PivotFacet[], minMessages?: number): Promise<PivotResult> {
    const account = await this.accounts.activeAccountForUser(userId);
    return this.pivots.view(account.id, order, minMessages);
  }

  /**
   * Writes the canonical pivot into folders and creates the missing leaf paths in Gmail.
   *
   * Answers inline rather than 202: this is bounded by the number of folders, which is tens, not
   * by the number of messages. It never deletes — folders that match no current combination come
   * back in `orphaned` for a person to decide about.
   */
  /**
   * The mail inside one folder. Reads `message_facets` directly, so it works whether or not a
   * pivot was ever applied to Gmail — which is what lets the PWA be the folder view rather than a
   * reflection of one.
   */
  async folderMessages(
    userId: string,
    facetKey: string,
    options: { limit?: number; cursor?: string } = {},
  ) {
    const account = await this.accounts.activeAccountForUser(userId);
    return this.pivots.folderMessages(account.id, facetKey, options);
  }

  async apply(userId: string): Promise<PivotApplyResult> {
    const account = await this.accounts.activeAccountForUser(userId);
    return this.pivots.apply(account.id, userId);
  }

  /**
   * Subject and sender across the whole mailbox, narrowed by any combination of facets. No model
   * call and no Gmail call — Postgres full text over metadata the sync already stored.
   */
  async search(
    userId: string,
    query: string | null,
    filters: SearchFilters,
    options: { limit?: number; cursor?: string; order?: PivotFacet[] } = {},
  ): Promise<SearchResult> {
    const account = await this.accounts.activeAccountForUser(userId);
    return this.search_.search(account.id, query, filters, options);
  }

  /** What there is to filter by, and how much mail sits behind each value. */
  async vocabulary(userId: string): Promise<FacetVocabulary> {
    const account = await this.accounts.activeAccountForUser(userId);
    return this.search_.vocabulary(account.id);
  }
}

export const facetsService = new FacetsService();
