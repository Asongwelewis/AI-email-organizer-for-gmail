# Stage 3 — Swap OpenAI for Gemini (free tier)

Prerequisite: stage 2 merged into development. Read CLAUDE.md. Branch:

```
git checkout development && git pull
git checkout -b feature/stage3-gemini-provider
```

## Goal

Replace the OpenAI automation provider with a Google Gemini provider (Flash-class model,
generous free tier). Same provider interface, same guarantees: bounded batches, timeout,
retry, strict structured output, token and micro-USD cost accounting, external calls outside
database transactions.

## Backend changes

- Create `apps/api/src/features/automation/gemini-automation.provider.ts` mirroring the
  interface of `openai-automation.provider.ts`:
  - Endpoint: `POST https://generativelanguage.googleapis.com/v1beta/models/{GEMINI_MODEL}:generateContent`
    with header `x-goog-api-key: <GEMINI_API_KEY>`.
  - Structured output: `generationConfig.responseMimeType: "application/json"` +
    `generationConfig.responseSchema` expressing the same shape as the current JSON schema
    (labelName constrained to approved leaves + "NONE", confidence, explanation,
    reasonCodes). Validate the response with the existing Zod schema regardless — treat
    model output as untrusted.
  - Token accounting: read `usageMetadata.promptTokenCount` and
    `usageMetadata.candidatesTokenCount`; map into the existing counters. Recompute the
    micro-USD estimate from Gemini pricing for the configured model; put the per-token rates
    in named constants with a comment and date.
  - Reuse the existing timeout/retry helpers; also retry on Gemini 429 with backoff since
    the free tier is rate-limited. If a run hits sustained 429s, stop the run with the
    existing stop-reason mechanism (add `PROVIDER_RATE_LIMITED` if none fits) so the next
    scheduled run resumes from checkpoints.
- Delete `openai-automation.provider.ts` and remove the `openai` dependency from
  `apps/api/package.json` if present (check whether the classification external provider was
  already removed in stage 1; nothing else may import it).
- `automation.scheduler.ts`: the tick guard checks `env.OPENAI_API_KEY` — change to
  `env.GEMINI_API_KEY`.
- `apps/api/src/config/env.ts` (Zod): remove `OPENAI_API_KEY` and any OpenAI model/url vars;
  add `GEMINI_API_KEY` (optional string — automation disables itself when absent, matching
  current behavior) and `GEMINI_MODEL` (string, default a current Flash model, e.g.
  `gemini-flash-latest`; verify the exact identifier against Google's docs at
  implementation time).
- Search the whole repo for `OPENAI` / `openai` and update every reference: README.md,
  `docs/backend.md`, `docs/architecture.md`, `docs/stage-5-daily-automation.md`,
  `render.yaml` env var list, CI workflow if it stubs the key.

## Env files

- `apps/api/.env.example` and root `.env.example`: remove OpenAI entries; add
  `GEMINI_API_KEY=your-gemini-api-key-here` and `GEMINI_MODEL=gemini-flash-latest` with a
  one-line comment pointing to https://aistudio.google.com/apikey.
- If `apps/api/.env` exists locally, add the same placeholder lines there (never commit
  `.env`). The user will paste the real key.

## Tests

- Rename/rewrite `automation-openai.test.ts` → `automation-gemini.test.ts`: mock fetch;
  cover success, malformed JSON from model (Zod rejects → review queue path), timeout,
  429 retry-then-stop, and usageMetadata mapping.
- `env-validation.test.ts`: update for the new vars.
- Gates: `npm run typecheck`, `npm test`, `npm run lint`, `npm run build`. Boot `npm run dev`
  with a dummy key and confirm the API starts and the scheduler logs that automation is
  waiting/disabled rather than crashing.

## Commit

`feat: swap automation provider from OpenAI to Gemini` with a body noting the new env vars
and the pricing constants used. Do not merge; leave for review.
