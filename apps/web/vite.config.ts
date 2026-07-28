import { fileURLToPath, URL } from 'node:url';

import { sentryVitePlugin } from '@sentry/vite-plugin';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

const sentrySourceMapsEnabled = Boolean(
  process.env.SENTRY_AUTH_TOKEN && process.env.SENTRY_ORG && process.env.SENTRY_PROJECT,
);

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    sentrySourceMapsEnabled &&
      sentryVitePlugin({
        authToken: process.env.SENTRY_AUTH_TOKEN,
        org: process.env.SENTRY_ORG,
        project: process.env.SENTRY_PROJECT,
        release: {
          name: process.env.VITE_APP_VERSION,
        },
        sourcemaps: {
          filesToDeleteAfterUpload: ['./dist/**/*.map'],
        },
      }),
  ],
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
});
