# The API image. Railway builds this on every push to `main` (a Dockerfile at the root always
# wins over its own builder), and so can any other container host. The web app is not in it:
# Vercel builds and serves that.
#
# Two stages. The build stage installs everything, devDependencies included, because the
# compiler, Prisma's CLI and Sentry's CLI are all devDependencies. The runtime stage keeps only
# production dependencies plus what the API reads at runtime: its compiled code, the Prisma
# schema and migrations (applied on boot, see apps/api/src/database/migrations.ts) and
# @mailmind/shared.

FROM node:22-bookworm-slim AS build
WORKDIR /app
# A dropped connection retries instead of failing the whole build.
ENV NPM_CONFIG_FETCH_RETRIES=5 NPM_CONFIG_FETCH_RETRY_MAXTIMEOUT=120000
# Prisma's engines link against OpenSSL.
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Manifests first, so a change to source alone reuses the installed dependencies.
COPY package.json package-lock.json ./
COPY .husky/install.mjs .husky/install.mjs
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/config/package.json packages/config/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/ui/package.json packages/ui/package.json
RUN npm ci --include=dev --no-audit --no-fund

COPY . .

# Railway passes service variables to a Docker build only when they are declared here. The
# commit names the release, so Sentry source maps match the running code. Source maps upload
# only when all three Sentry upload variables are set; with SENTRY_REQUIRE_CONFIG=true the build
# fails instead of shipping without them.
ARG RAILWAY_GIT_COMMIT_SHA
ARG SENTRY_REQUIRE_CONFIG=false
ARG SENTRY_DSN
ARG SENTRY_AUTH_TOKEN
ARG SENTRY_ORG
ARG SENTRY_PROJECT
RUN npm run prisma:generate --workspace @mailmind/api \
  && npm run build --workspace @mailmind/shared \
  && node scripts/with-app-version.mjs npm run build --workspace @mailmind/api \
  && npm prune --omit=dev --no-audit --no-fund

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production

COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
# Whole workspace folders, so a dependency npm nested inside one is not left behind.
COPY --from=build /app/packages/shared ./packages/shared
COPY --from=build /app/apps/api ./apps/api

USER node
WORKDIR /app/apps/api
# Node itself, not npm, is the main process, so the platform's stop signal reaches the API's
# graceful shutdown. Railway sets PORT; the API listens on it.
CMD ["node", "--import", "./dist/instrument.js", "dist/index.js"]
