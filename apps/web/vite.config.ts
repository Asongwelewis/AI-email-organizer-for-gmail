import { fileURLToPath, URL } from 'node:url';

import { sentryVitePlugin } from '@sentry/vite-plugin';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig, loadEnv } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

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
      VitePWA({
        // 'prompt', not 'autoUpdate': a filing run or an approval in progress must not be swapped
        // out from under the person doing it. The new build waits behind a toast.
        registerType: 'prompt',
        includeAssets: ['icons/icon-192.png', 'icons/icon-512.png'],
        manifest: {
          name: 'MailMind AI',
          short_name: 'MailMind',
          description:
            'Approve a folder tree for your Gmail, then find filed mail by folder instead of by search.',
          start_url: '/sorted',
          scope: '/',
          display: 'standalone',
          orientation: 'portrait',
          theme_color: '#f3ecdf',
          background_color: '#f3ecdf',
          icons: [
            { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
            { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
            {
              src: '/icons/icon-512-maskable.png',
              sizes: '512x512',
              type: 'image/png',
              purpose: 'maskable',
            },
          ],
        },
        workbox: {
          // The shell only. The editorial artwork is large and non-essential, so it stays on the
          // network rather than in every installed copy.
          globPatterns: ['**/*.{js,css,html}', 'icons/*.png'],
          cleanupOutdatedCaches: true,
          navigateFallback: '/index.html',
          // A navigation request must never be answered from the shell for API paths, and the
          // OAuth return hop has to reach the network rather than a cached document.
          navigateFallbackDenylist: [/^\/api\//],
          runtimeCaching: [
            {
              // Every API response is authenticated by an HttpOnly session cookie. Caching one is
              // how a shared device shows one account's mail to the next person signed in, so the
              // service worker is forbidden from storing them at all.
              urlPattern: /^https?:\/\/[^/]+\/api\//,
              handler: 'NetworkOnly',
              method: 'GET',
            },
          ],
        },
        devOptions: { enabled: false },
      }),
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
