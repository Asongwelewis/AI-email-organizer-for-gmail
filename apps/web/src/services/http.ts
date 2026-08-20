import axios, { type AxiosError, type InternalAxiosRequestConfig } from 'axios';

import { apiBaseUrl } from '@web/config/env';
import type {
  AuthMeResponse,
  GmailConnectionStatus,
  GmailSyncResult,
  GmailSyncStatus,
  SessionRefreshResponse,
} from '@web/types/auth';
import type { ActivityRunsResponse, StartedRun } from '@web/types/activity';
import type { AutomationReviewQueue, AutomationStatus } from '@web/types/automation';
import type {
  ApprovePlanInput,
  ConfirmLabelInput,
  FolderMessagesResponse,
  LabelsOverview,
  UserLabel,
} from '@web/types/labels';

declare module 'axios' {
  export interface AxiosRequestConfig {
    skipAuthRefresh?: boolean;
  }

  export interface InternalAxiosRequestConfig {
    skipAuthRefresh?: boolean;
    authRetryAttempted?: boolean;
  }
}

export const http = axios.create({
  baseURL: apiBaseUrl,
  withCredentials: true,
});

const refreshClient = axios.create({
  baseURL: apiBaseUrl,
  withCredentials: true,
});

let refreshPromise: Promise<void> | null = null;
let authenticationFailureHandler: (() => void) | null = null;

export function setAuthenticationFailureHandler(handler: (() => void) | null): void {
  authenticationFailureHandler = handler;
}

async function refreshSessionOnce(): Promise<void> {
  refreshPromise ??= refreshClient
    .post('/auth/refresh')
    .then(() => undefined)
    .catch((error: unknown) => {
      authenticationFailureHandler?.();
      throw error;
    })
    .finally(() => {
      refreshPromise = null;
    });
  return refreshPromise;
}

http.interceptors.response.use(
  (response) => response,
  async (error: AxiosError) => {
    const status = error.response?.status;
    const config = error.config as InternalAxiosRequestConfig | undefined;
    if (
      status !== 401 ||
      !config ||
      config.skipAuthRefresh ||
      config.authRetryAttempted ||
      config.url?.includes('/auth/refresh')
    ) {
      return Promise.reject(error);
    }

    config.authRetryAttempted = true;
    try {
      await refreshSessionOnce();
      return await http(config);
    } catch (refreshError) {
      return Promise.reject(refreshError);
    }
  },
);

export const api = {
  async getCurrentUser(): Promise<AuthMeResponse> {
    const response = await http.get<AuthMeResponse>('/auth/me');
    return response.data;
  },

  async refreshSession(): Promise<SessionRefreshResponse> {
    const response = await refreshClient.post<SessionRefreshResponse>('/auth/refresh');
    return response.data;
  },

  async logout(): Promise<void> {
    await http.post('/auth/logout', undefined, { skipAuthRefresh: true });
  },

  async logoutAll(): Promise<void> {
    await http.post('/auth/logout-all');
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

  async incrementalGmailSync(): Promise<GmailSyncResult> {
    const response = await http.post<GmailSyncResult>('/gmail/sync/incremental');
    return response.data;
  },

  async getLabels(): Promise<LabelsOverview> {
    const response = await http.get<LabelsOverview>('/labels');
    return response.data;
  },

  async proposeLabels(): Promise<LabelsOverview> {
    const response = await http.post<LabelsOverview>('/labels/propose', {});
    return response.data;
  },

  async confirmLabels(labels: ConfirmLabelInput[]): Promise<LabelsOverview> {
    const response = await http.post<LabelsOverview>('/labels/confirm', { labels });
    return response.data;
  },

  /** Approves a proposed tree. Omitting nodeIds approves all of it. */
  async approvePlan(input: ApprovePlanInput): Promise<LabelsOverview> {
    const response = await http.post<LabelsOverview>('/labels/confirm', input);
    return response.data;
  },

  /** The mail filed into one folder, for the drill-in list on Sorted. */
  async getFolderMessages(labelId: string): Promise<FolderMessagesResponse> {
    const response = await http.get<FolderMessagesResponse>(`/labels/${labelId}/messages`);
    return response.data;
  },

  async getActivityRuns(limit = 20): Promise<ActivityRunsResponse> {
    const response = await http.get<ActivityRunsResponse>('/activity/runs', { params: { limit } });
    return response.data;
  },

  async renameLabel(id: string, leafName: string): Promise<UserLabel> {
    const response = await http.patch<UserLabel>(`/labels/${id}`, { leafName });
    return response.data;
  },

  async deleteLabel(id: string): Promise<void> {
    await http.delete(`/labels/${id}`);
  },

  async getAutomationStatus(): Promise<AutomationStatus> {
    const response = await http.get<AutomationStatus>('/automation/status');
    return response.data;
  },

  async getAutomationReview(): Promise<AutomationReviewQueue> {
    const response = await http.get<AutomationReviewQueue>('/automation/review');
    return response.data;
  },

  /** 202: filing outlives the request, so this returns a run id to poll. */
  async runAutomation(): Promise<StartedRun> {
    const response = await http.post<StartedRun>('/automation/run', {});
    return response.data;
  },

  async approveAutomationReview(id: string, labelName: string): Promise<void> {
    await http.post(`/automation/review/${id}/approve`, { labelName });
  },

  async skipAutomationReview(id: string): Promise<void> {
    await http.post(`/automation/review/${id}/skip`, {});
  },
};

export function getBackendRedirectUrl(path: '/auth/google' | '/integrations/google/connect') {
  const url = new URL(`${apiBaseUrl}${path}`);
  url.searchParams.set('redirect', '/auth/callback');
  return url.toString();
}

export const __refreshTesting = {
  client: refreshClient,
  reset() {
    refreshPromise = null;
    authenticationFailureHandler = null;
  },
};
