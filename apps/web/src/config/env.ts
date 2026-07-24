const configuredApiBaseUrl = import.meta.env.VITE_API_BASE_URL;

if (!configuredApiBaseUrl) {
  throw new Error('VITE_API_BASE_URL is not configured');
}

const backendBaseUrl = configuredApiBaseUrl.replace(/\/+$/, '');
export const apiBaseUrl = backendBaseUrl.endsWith('/api')
  ? backendBaseUrl
  : `${backendBaseUrl}/api`;
