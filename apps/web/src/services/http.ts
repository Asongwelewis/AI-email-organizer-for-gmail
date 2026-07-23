import axios, { type AxiosError, type InternalAxiosRequestConfig } from 'axios';

import type {
  AuthMeResponse,
  GmailConnectionStatus,
  SessionRefreshResponse,
} from '@web/types/auth';

declare module 'axios' {
  export interface AxiosRequestConfig {
    skipAuthRefresh?: boolean;
  }

  export interface InternalAxiosRequestConfig {
    skipAuthRefresh?: boolean;
    authRetryAttempted?: boolean;
  }
}

const apiBaseUrl = (import.meta.env['VITE_API_URL'] ?? 'http://localhost:4000/api').replace(
  /\/$/,
  '',
);

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
