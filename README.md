# MailMind AI

MailMind AI provides the Stage 2 authentication foundation, Stage 3 metadata-only Gmail
synchronization, and the Stage 4 AI classification and recommendation pipeline. Automatic Gmail
organization, distributed background jobs, and billing are not implemented.

## Monorepo

- `apps/web` — React, Vite, and TypeScript frontend
- `apps/api` — Express, Prisma, and TypeScript API
- `packages/shared` — shared types, constants, and utilities
- `packages/config` — shared ESLint, Prettier, and TypeScript configuration
- `packages/ui` — shared React UI primitives

## Setup

Prerequisites are Node.js 22+, npm 10+, Docker Desktop, and Supabase CLI 2.x.

```powershell
npm install
Copy-Item .env.example .env
Copy-Item apps/api/.env.example apps/api/.env
Copy-Item apps/web/.env.example apps/web/.env
npm run dev
```

See [Stage 2 setup and release readiness](docs/stage-2-setup.md) for Supabase role/pooler setup,
Prisma migrations, Google OAuth, security behavior, cleanup, CI, manual verification, and public
deployment requirements.

See [Stage 3 Gmail synchronization](docs/stage-3-gmail-sync.md) for the metadata boundary, managed
labels, sync lifecycle, retry/checkpoint behavior, environment controls, and verification steps.

See [Stage 4 AI classification](docs/stage-4-ai-classification.md) for the rules-first
recommendation architecture, privacy boundary, review queue, corrections, and no-Gmail-mutation
guarantee.

## Commands

- `npm run dev` — run frontend and API
- `npm test` — run backend and frontend tests
- `npm run typecheck` — typecheck all workspaces
- `npm run lint` — lint the repository
- `npm run format:check` — verify formatting
- `npm run build` — build all packages and apps

## API probes

- Liveness: `GET /health` or legacy `GET /api/health`
- Readiness: `GET /ready` or `GET /api/ready`

## Local Supabase

For the local Supabase stack only, run `supabase start` and use the development database URL shown
by `supabase status`. `supabase db reset` is destructive and is permitted only for that disposable
local stack—never for the configured remote project.

Application tables are backend-only. RLS is enabled and forced; `PUBLIC`, `anon`, and
`authenticated` have no direct table privileges. The API connects through a dedicated Prisma role.

## CI

GitHub Actions migrates disposable PostgreSQL, runs backend/database/frontend tests, typecheck,
lint, format checks, production builds, and built-API probes. It does not use production Supabase
credentials or call Google.
