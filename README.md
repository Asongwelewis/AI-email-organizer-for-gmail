# MailMind AI

MailMind AI is a production-ready SaaS foundation for AI-powered Gmail organization. It uses Google OAuth to connect a mailbox, analyzes inbox patterns, proposes hierarchical Gmail labels with an LLM, and only applies changes after user approval.

## Monorepo Layout

- `apps/web` - React + Vite + TypeScript frontend
- `apps/api` - Express + TypeScript API
- `packages/shared` - Shared types, constants, and utilities
- `packages/config` - Shared ESLint, Prettier, and TypeScript configuration
- `packages/ui` - Shared React UI primitives

## Prerequisites

- Node.js 22+
- npm 10+
- PostgreSQL 16+

## Setup

1. Install dependencies.

   ```bash
   npm install
   ```

2. Create environment files from the examples.

   ```bash
   copy .env.example .env
   copy apps\api\.env.example apps\api\.env
   copy apps\web\.env.example apps\web\.env
   ```

3. Update the values for your local services and OAuth credentials.

4. Run the development stack.

   ```bash
   npm run dev
   ```

## Available Scripts

- `npm run dev` - Run web and API concurrently
- `npm run build` - Build all packages and apps
- `npm run lint` - Lint the entire workspace
- `npm run format` - Format the repository
- `npm run typecheck` - Run TypeScript project references

## API

- Health check: `GET /api/health`

## Frontend

The landing page includes a disabled `Connect Gmail` button until Gmail OAuth and onboarding are implemented.

## Environment Variables

The root `.env.example` contains the full set of environment variables used by the scaffold. API and web apps also include local examples in their own folders.

## Docker

Each app includes a Dockerfile for containerized builds. These are intended as production starting points and can be extended with runtime secrets injection and multi-stage deployment orchestration.

## CI

GitHub Actions runs install, lint, and build on push and pull request events.

## Next Steps

1. Implement Google OAuth and session handling in `apps/api`.
2. Add Prisma models for users, Gmail accounts, inbox snapshots, and label suggestions.
3. Build the approval workflow and label execution pipeline.# MailOrganizer AI

MailMind AI is an AI-powered Gmail organization platform that automatically analyzes a user's inbox, discovers meaningful email categories, creates hierarchical Gmail labels, and organizes emails without requiring manual filters.

Unlike traditional email filters that rely on static rules, MailMind AI uses large language models to understand the purpose of emails, identify relationships between senders, and build a personalized folder hierarchy for every user.

Example:

Newsletters
├── AI
│ ├── Hugging Face
│ ├── OpenAI
│ └── Anthropic
│
├── Technology
│ ├── GitHub
│ └── Stack Overflow
│
Subscriptions
├── Netflix
├── Spotify
└── Disney+

Education
├── Coursera
├── Udemy
└── ICT University

The generated hierarchy is synchronized directly with Gmail using Gmail Labels, making the organization instantly available across Gmail Web, Android, iPhone, tablets, and any Gmail client connected to the account.

Users remain in complete control by previewing AI-generated changes before they are applied.
