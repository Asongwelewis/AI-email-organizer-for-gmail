import { fileURLToPath, URL } from 'node:url';

import { sentryVitePlugin } from '@sentry/vite-plugin';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig, loadEnv } from 'vite';

const uploadVariableNames = ['SENTRY_AUTH_TOKEN', 'SENTRY_ORG', 'SENTRY_PROJECT'] as const;

export default defineConfig(({ mode }) => {
  const environment = { ...loadEnv(mode, process.cwd(), ''), ...process.env };
  const configured = (name: string) => Boolean(environment[name]?.trim());
  const configuredUploadVariables = uploadVariableNames.filter(configured);
  const sentrySourceMapsEnabled = configuredUploadVariables.length === uploadVariableNames.length;
  const sentryRequired = environment.SENTRY_REQUIRE_CONFIG === 'true';
  const sentryDsnConfigured = configured('VITE_SENTRY_DSN');
  const appVersion = environment.VITE_APP_VERSION?.trim();

  if (configuredUploadVariables.length > 0 && !sentrySourceMapsEnabled) {
    throw new Error(
      `Incomplete Sentry source-map configuration. Missing: ${uploadVariableNames
        .filter((name) => !configured(name))
        .join(', ')}`,
    );
  }
  if ((sentryDsnConfigured || sentrySourceMapsEnabled) && !appVersion) {
    throw new Error('VITE_APP_VERSION is required when frontend Sentry is configured.');
  }
  if (sentryRequired && !sentryDsnConfigured) {
    throw new Error('VITE_SENTRY_DSN is required for this production frontend build.');
  }
  if (sentryRequired && !sentrySourceMapsEnabled) {
    throw new Error(
      'SENTRY_AUTH_TOKEN, SENTRY_ORG, and SENTRY_PROJECT are required for this production frontend build.',
    );
  }

  if (!sentryDsnConfigured) {
    console.log('[sentry] browser SDK disabled: VITE_SENTRY_DSN is not configured.');
  }
  if (!sentrySourceMapsEnabled) {
    console.log(
      '[sentry] frontend source-map upload disabled: upload credentials are not configured.',
    );
  }

  return {
    plugins: [
      react(),
      tailwindcss(),
      sentrySourceMapsEnabled &&
        sentryVitePlugin({
          authToken: environment.SENTRY_AUTH_TOKEN,
          org: environment.SENTRY_ORG,
          project: environment.SENTRY_PROJECT,
          telemetry: false,
          release: {
            name: appVersion,
          },
          sourcemaps: {
            filesToDeleteAfterUpload: ['./dist/**/*.map'],
          },
        }),
    ],
    define: appVersion
      ? {
          'import.meta.env.VITE_APP_VERSION': JSON.stringify(appVersion),
        }
      : undefined,
    resolve: {
      alias: {
        '@web': fileURLToPath(new URL('./src', import.meta.url)),
      },
    },
    build: {
      sourcemap: sentrySourceMapsEnabled ? 'hidden' : false,
      rollupOptions: {
        output: {
          manualChunks: {
            react: ['react', 'react-dom', 'react-router-dom'],
            data: ['@tanstack/react-query', 'axios'],
            motion: ['motion'],
            interface: ['lucide-react', 'sonner'],
          },
        },
      },
    },
  };
});
