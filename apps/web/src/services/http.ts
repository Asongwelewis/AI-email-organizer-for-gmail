import axios, { type AxiosError, type InternalAxiosRequestConfig } from 'axios';

import type {
  AuthMeResponse,
  GmailConnectionStatus,
  GmailSyncResult,
  GmailSyncStatus,
  SessionRefreshResponse,
} from '@web/types/auth';
import type {
  ClassificationCategory,
  ClassificationResultsPage,
  ClassificationStatus,
  RecommendedAction,
} from '@web/types/classification';
import type { LabelCandidatesPage, LabelDiscoveryStatus } from '@web/types/labelDiscovery';

declare module 'axios' {
  export interface AxiosRequestConfig {
    skipAuthRefresh?: boolean;
  }

  export interface InternalAxiosRequestConfig {
    skipAuthRefresh?: boolean;
    authRetryAttempted?: boolean;
  }
}

const backendBaseUrl = (
  import.meta.env['VITE_API_BASE_URL'] ?? 'https://api.mailmindai.tech'
).replace(/\/+$/, '');
const apiBaseUrl = backendBaseUrl.endsWith('/api') ? backendBaseUrl : `${backendBaseUrl}/api`;

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

  async initialGmailSync(): Promise<GmailSyncResult> {
    const response = await http.post<GmailSyncResult>('/gmail/sync/initial');
    return response.data;
  },

  async incrementalGmailSync(): Promise<GmailSyncResult> {
    const response = await http.post<GmailSyncResult>('/gmail/sync/incremental');
    return response.data;
  },

  async getClassificationStatus(): Promise<ClassificationStatus> {
    const response = await http.get<ClassificationStatus>('/classification/status');
    return response.data;
  },

  async getClassificationResults(cursor?: string): Promise<ClassificationResultsPage> {
    const response = await http.get<ClassificationResultsPage>('/classification/results', {
      params: { requiresReview: true, limit: 20, ...(cursor ? { cursor } : {}) },
    });
    return response.data;
  },

  async runClassification(): Promise<{ success: boolean; runId: string }> {
    const response = await http.post<{ success: boolean; runId: string }>('/classification/run');
    return response.data;
  },

  async correctClassification(
    id: string,
    input: { category: ClassificationCategory; recommendedAction: RecommendedAction },
  ): Promise<void> {
    await http.post(`/classification/results/${id}/correct`, input);
  },

  async getLabelDiscoveryStatus(): Promise<LabelDiscoveryStatus> {
    const response = await http.get<LabelDiscoveryStatus>('/label-discovery/status');
    return response.data;
  },

  async getLabelCandidates(cursor?: string): Promise<LabelCandidatesPage> {
    const response = await http.get<LabelCandidatesPage>('/label-discovery/candidates', {
      params: { limit: 20, ...(cursor ? { cursor } : {}) },
    });
    return response.data;
  },

  async runLabelDiscovery(): Promise<{ success: boolean; runId: string }> {
    const response = await http.post<{ success: boolean; runId: string }>(
      '/label-discovery/run',
      {},
    );
    return response.data;
  },

  async approveLabelCandidate(id: string, leafName?: string): Promise<void> {
    await http.post(`/label-discovery/candidates/${id}/approve`, {
      ...(leafName ? { leafName } : {}),
    });
  },

  async rejectLabelCandidate(id: string): Promise<void> {
    await http.post(`/label-discovery/candidates/${id}/reject`, {});
  },

  async deferLabelCandidate(id: string): Promise<void> {
    await http.post(`/label-discovery/candidates/${id}/defer`, {});
  },

  async mergeLabelCandidate(id: string, targetCandidateId: string): Promise<void> {
    await http.post(`/label-discovery/candidates/${id}/merge`, { targetCandidateId });
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
