import axios, { type AxiosError, type InternalAxiosRequestConfig } from 'axios';

import { apiBaseUrl } from '@web/config/env';
import type { AuthMeResponse, GmailConnectionStatus, GmailSyncStatus } from '@web/types/auth';
import type { ActivityRun, ActivityRunsResponse, StartedRun } from '@web/types/activity';
import type {
  FacetVocabulary,
  FolderMessages,
  PivotApplyResult,
  PivotFacet,
  PivotPlan,
  PivotSettings,
  PivotView,
  SearchFilters,
  SearchResults,
} from '@web/types/facets';
import type { EmailTimeRange } from '@web/types/facets';
import type { AutomationStatus } from '@web/types/automation';
import type { FavoriteFolder } from '@web/types/favorites';
import type { FeedbackInput } from '@web/types/feedback';
import type { NotificationFeed, PushConfig } from '@web/types/notifications';

declare module 'axios' {
  export interface AxiosRequestConfig {
    /** A 401 on this request is about the request, not a sign that the session ended. */
    skipAuthFailure?: boolean;
  }

  export interface InternalAxiosRequestConfig {
    skipAuthFailure?: boolean;
  }
}

export const http = axios.create({
  baseURL: apiBaseUrl,
  withCredentials: true,
});

let authenticationFailureHandler: (() => void) | null = null;

export function setAuthenticationFailureHandler(handler: (() => void) | null): void {
  authenticationFailureHandler = handler;
}

/*
 * A 401 means the session is over, and the app forgets it.
 *
 * This used to call `POST /auth/refresh` and retry, and that could never work: the API answers 401
 * only when the session is missing, expired or revoked, and refresh begins by checking that same
 * session, so it failed for the same reason every time. All it did was put a second doomed request
 * in front of every signed-out visit. Sessions now stay alive by being used — the API slides the
 * expiry forward and re-issues the cookie as part of any authenticated request.
 */
http.interceptors.response.use(
  (response) => response,
  (error: AxiosError) => {
    const config = error.config as InternalAxiosRequestConfig | undefined;
    if (error.response?.status === 401 && !config?.skipAuthFailure) {
      authenticationFailureHandler?.();
    }
    return Promise.reject(error);
  },
);

export const api = {
  async getCurrentUser(): Promise<AuthMeResponse> {
    const response = await http.get<AuthMeResponse>('/auth/me');
    return response.data;
  },

  async logout(): Promise<void> {
    await http.post('/auth/logout', undefined, { skipAuthFailure: true });
  },

  async logoutAll(): Promise<void> {
    await http.post('/auth/logout-all');
  },

  /**
   * Deletes the account and everything stored about it. Irreversible, and the server clears the
   * session cookie in the same response.
   */
  async deleteAccount(): Promise<{ success: boolean; connectedAccounts: number }> {
    const response = await http.delete<{ success: boolean; connectedAccounts: number }>('/auth/me');
    return response.data;
  },

  async completeTutorial(
    decision: 'COMPLETED' | 'SKIPPED',
  ): Promise<{ success: boolean; tutorialCompletedAt: string }> {
    const response = await http.post<{ success: boolean; tutorialCompletedAt: string }>(
      '/auth/tutorial/complete',
      { decision },
    );
    return response.data;
  },

  async getGmailStatus(): Promise<GmailConnectionStatus> {
    const response = await http.get<GmailConnectionStatus>('/integrations/google/status');
    return response.data;
  },

  async disconnectGmail(): Promise<void> {
    await http.post('/integrations/google/disconnect');
  },

  async getGmailSyncStatus(): Promise<GmailSyncStatus> {
    const response = await http.get<GmailSyncStatus>('/gmail/sync/status');
    return response.data;
  },

  async initializeGmailLabels(): Promise<{ success: boolean; labelsUpserted: number }> {
    const response = await http.post<{ success: boolean; labelsUpserted: number }>(
      '/gmail/labels/initialize',
    );
    return response.data;
  },

  /** 202: the backfill outlives the request, so this returns a run id to poll. */
  async initialGmailSync(): Promise<StartedRun> {
    const response = await http.post<StartedRun>('/gmail/sync/initial');
    return response.data;
  },

  async getActivityRuns(limit = 20): Promise<ActivityRunsResponse> {
    const response = await http.get<ActivityRunsResponse>('/activity/runs', { params: { limit } });
    return response.data;
  },

  async getAutomationStatus(): Promise<AutomationStatus> {
    const response = await http.get<AutomationStatus>('/automation/status');
    return response.data;
  },

  async getPivotSettings(): Promise<PivotSettings> {
    const response = await http.get<PivotSettings>('/facets/pivot');
    return response.data;
  },

  /** Changes which ordering is canonical. Writes nothing to Gmail until `applyPivot`. */
  async setPivotSettings(input: {
    canonicalPivot: PivotFacet[];
    minMessages?: number;
  }): Promise<PivotSettings> {
    const response = await http.put<PivotSettings>('/facets/pivot', input);
    return response.data;
  },

  /** What applying the canonical ordering would do. Reads only. */
  async getPivotPlan(): Promise<PivotPlan> {
    const response = await http.get<PivotPlan>('/facets/pivot/plan');
    return response.data;
  },

  /**
   * Any ordering at all, materialised or not — the same facet rows arranged differently, with no
   * Gmail call and no model call behind it.
   */
  async getPivotView(
    order: PivotFacet[],
    minMessages?: number,
    range: EmailTimeRange = '24h',
  ): Promise<PivotView> {
    const response = await http.get<PivotView>('/facets/pivot/view', {
      params: {
        order: order.join(','),
        ...(minMessages === undefined ? {} : { minMessages }),
        range,
      },
    });
    return response.data;
  },

  /**
   * The mail inside one folder. Keyed by facet combination, not by a folder row, so it works
   * whether or not a pivot was ever applied to Gmail.
   */
  async getFacetMessages(
    facetKey: string,
    options: { limit?: number; cursor?: string; range?: EmailTimeRange } = {},
  ): Promise<FolderMessages> {
    const response = await http.get<FolderMessages>('/facets/messages', {
      params: {
        facetKey,
        ...(options.limit === undefined ? {} : { limit: options.limit }),
        ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
        range: options.range ?? '24h',
      },
    });
    return response.data;
  },

  /**
   * Subject and sender across the whole mailbox, narrowed by any combination of facets. No model
   * call and no Gmail call behind it — Postgres full text over stored metadata.
   */
  async searchMessages(
    query: string,
    filters: SearchFilters = {},
    options: { order?: PivotFacet[]; limit?: number; cursor?: string } = {},
  ): Promise<SearchResults> {
    const response = await http.get<SearchResults>('/facets/search', {
      params: {
        ...(query ? { q: query } : {}),
        ...(filters.entity ? { entity: filters.entity } : {}),
        ...(filters.domain ? { domain: filters.domain } : {}),
        ...(filters.intent ? { intent: filters.intent } : {}),
        ...(filters.unread ? { unread: 'true' } : {}),
        ...(options.order?.length ? { order: options.order.join(',') } : {}),
        ...(options.limit === undefined ? {} : { limit: options.limit }),
        ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
      },
    });
    return response.data;
  },

  /** What there is to filter by, and how much mail sits behind each value. */
  async getFacetVocabulary(): Promise<FacetVocabulary> {
    const response = await http.get<FacetVocabulary>('/facets/vocabulary');
    return response.data;
  },

  async applyPivot(): Promise<PivotApplyResult> {
    const response = await http.post<PivotApplyResult>('/facets/pivot/apply', {});
    return response.data;
  },

  /** 202: classifying a mailbox is thousands of paced Gemini calls. */
  async classifyFacets(): Promise<StartedRun> {
    const response = await http.post<StartedRun>('/facets/classify', {});
    return response.data;
  },

  /** 202: filing is one Gmail call per message. */
  async fileFacets(): Promise<StartedRun> {
    const response = await http.post<StartedRun>('/facets/file', {});
    return response.data;
  },

  /** Starred folders with their counts over all mail. */
  async getFavorites(): Promise<FavoriteFolder[]> {
    const response = await http.get<{ items: FavoriteFolder[] }>('/favorites');
    return response.data.items;
  },

  /** Just the starred keys, for filling in the stars on folder tiles. */
  async getFavoriteKeys(): Promise<string[]> {
    const response = await http.get<{ keys: string[] }>('/favorites/keys');
    return response.data.keys;
  },

  async addFavorite(facetKey: string, order: PivotFacet[]): Promise<FavoriteFolder> {
    const response = await http.post<FavoriteFolder>('/favorites', { facetKey, order });
    return response.data;
  },

  async removeFavorite(facetKey: string): Promise<void> {
    await http.delete(`/favorites/${encodeURIComponent(facetKey)}`);
  },

  async getNotifications(cursor?: string): Promise<NotificationFeed> {
    const response = await http.get<NotificationFeed>('/notifications', {
      params: cursor ? { cursor } : {},
    });
    return response.data;
  },

  /** Marks the given notifications read, or all of them when none are given. */
  async markNotificationsRead(ids?: string[]): Promise<void> {
    await http.post('/notifications/read', ids ? { ids } : {});
  },

  async getPushConfig(): Promise<PushConfig> {
    const response = await http.get<PushConfig>('/notifications/push');
    return response.data;
  },

  async subscribePush(subscription: PushSubscriptionJSON): Promise<void> {
    await http.post('/notifications/push/subscribe', subscription);
  },

  /**
   * `skipAuthFailure`, because this runs on the way out of a session — at logout — and a 401 there
   * is the session already being gone, not news.
   */
  async unsubscribePush(endpoint: string): Promise<void> {
    await http.post('/notifications/push/unsubscribe', { endpoint }, { skipAuthFailure: true });
  },

  async getActivityRun(runId: string): Promise<ActivityRun> {
    const response = await http.get<ActivityRun>(`/activity/runs/${runId}`);
    return response.data;
  },

  /**
   * The one call that works signed out — it is for whoever was handed the link.
   *
   * `skipAuthFailure`, because the interceptor treats a 401 as the end of a session, and this one
   * never needed a session to begin with.
   */
  async sendFeedback(input: FeedbackInput): Promise<void> {
    await http.post('/feedback', input, { skipAuthFailure: true });
  },
};

export function getBackendRedirectUrl(path: '/auth/google' | '/integrations/google/connect') {
  const url = new URL(`${apiBaseUrl}${path}`);
  url.searchParams.set('redirect', '/auth/callback');
  return url.toString();
}
