# Refactor spec: simplify MailMind into a self-labeling automation agent

**Goal.** Collapse MailMind to the product originally intended: a daily automated agent that
reads new Gmail metadata, asks AI to organize messages into labels **it generates itself**
(bounded and normalized), creates/applies those labels in Gmail, and queues only low-confidence
messages for review. The classification review workflow and the label-discovery approval
workflow stop being load-bearing.

**Strategy.** Freeze, don't delete. Classification and discovery are tested, working code —
remove them from navigation and stop invoking them, but keep the code and tables dormant so
they can return later. All changes concentrate in `apps/api/src/features/automation` plus one
migration and small frontend edits.

**Non-goals.** No new features, no new pages, no schema redesign, no changes to auth, sync,
security, or the metadata-only boundary. Automation remains the only Gmail mutator.

---

## Current behavior (verified against code)

- `apps/api/src/features/automation/automation.types.ts:3` defines `AUTOMATION_CATEGORIES`,
  a fixed list; the OpenAI provider (`openai-automation.provider.ts`) enforces it three ways:
  Zod response schema (`z.enum(AUTOMATION_CATEGORIES)`, line ~16), the prompt (`categories:
AUTOMATION_CATEGORIES`, line ~88), and the structured-output JSON schema (`enum:
AUTOMATION_CATEGORIES`, line ~111).
- `automation.controller.ts:9` validates manual review approvals against the same enum.
- `automation-gmail.service.ts` → `ensureLabel(accountId, labelPath)` already accepts **any**
  label path and creates it in Gmail if missing. No change needed here — this is why the
  refactor is small.
- `apps/api/prisma/schema.prisma` → `automation_message_actions.category` is the Postgres enum
  `classification_category` (line ~733); `label_path` is already `String`.
- Label hygiene utilities already exist in
  `apps/api/src/features/label-discovery/label-normalization.ts`:
  `validateLeafName`, `normalizeLabelForComparison`, `isGenericLabelName`, `labelsAreSimilar`,
  `buildControlledLabelPath`.

## Target behavior

1. Daily run (unchanged scheduling/leases/idempotency) collects unprocessed messages.
2. Learned sender patterns are applied first (unchanged), except patterns now store a label
   name string instead of a category enum value.
3. Remaining messages go to OpenAI with: bounded metadata (unchanged) **plus the account's
   current MailMind label names**. The model must either reuse an existing label or propose a
   new leaf name, with confidence and explanation.
4. Server-side validation (never trust model output):
   - `validateLeafName` passes; `isGenericLabelName` fails the proposal;
   - if `labelsAreSimilar(proposal, existing)` for any existing label → force reuse of the
     existing label;
   - enforce a per-account cap (`AUTOMATION_MAX_LABELS`, default 25): at the cap, the model
     may only reuse existing labels; proposals above cap → review queue.
5. Confident outcomes: `ensureLabel(accountId, 'MailMind/' + leaf)` then `messages.modify`
   (both already implemented). Uncertain outcomes: review queue (unchanged).
6. Review approval accepts a label name string (same validation path), not an enum.

---

## Step-by-step changes

### Step 1 — Database migration (do this first)

New migration in `apps/api/prisma/migrations/<timestamp>_automation_free_labels/` **and** a
flat copy with the same timestamp name in `supabase/migrations/` (repo convention — both are
required).

```sql
-- automation_message_actions: free-form label instead of enum
ALTER TABLE automation_message_actions ADD COLUMN label_name text;
UPDATE automation_message_actions SET label_name = category::text WHERE label_name IS NULL;
ALTER TABLE automation_message_actions ALTER COLUMN label_name SET NOT NULL;
ALTER TABLE automation_message_actions ALTER COLUMN category DROP NOT NULL; -- deprecated, kept for history

-- learned_classification_patterns: same treatment for its category column
ALTER TABLE learned_classification_patterns ADD COLUMN label_name text;
UPDATE learned_classification_patterns SET label_name = category::text WHERE label_name IS NULL;
ALTER TABLE learned_classification_patterns ALTER COLUMN label_name SET NOT NULL;
ALTER TABLE learned_classification_patterns ALTER COLUMN category DROP NOT NULL;
```

(Adjust the second block to the actual column name in `learned_classification_patterns` —
inspect the model in `schema.prisma` before writing it.) Update `schema.prisma` to match, run
`npm run prisma:generate`, and follow existing migrations' RLS/grant patterns. Do **not** drop
the enum or old columns yet — freeze, don't delete.

### Step 2 — Automation types

`automation.types.ts`: keep `AUTOMATION_CATEGORIES` exported (frozen consumers still import
it) but stop using it in new code. Add:

```ts
export const AUTOMATION_LABEL_PREFIX = 'MailMind/';
export interface AutomationLabelDecision {
  key: string;
  labelName: string; // leaf only, no prefix
  reusedExisting: boolean;
  confidence: number;
  explanation: string;
  reasonCodes: string[];
}
```

### Step 3 — OpenAI provider (`openai-automation.provider.ts`)

- Request payload: add `existingLabels: string[]` (leaf names of the account's current
  `MailMind/*` labels, from `gmail_labels` via the repository).
- Prompt (line ~59): replace "Classify each email metadata record into exactly one supplied
  category" with instructions to (a) prefer reusing an `existingLabels` entry, (b) otherwise
  propose a short, specific, human-friendly leaf name (1–3 words, no dates, no sender
  addresses), (c) return confidence and explanation as today.
- Zod schema and structured-output JSON schema: `category` enum → `labelName` string with
  `minLength: 2`, `maxLength: 40`. Keep every other field and the strict/required structure.
- Keep timeout/retry/batch bounds and token/cost accounting exactly as they are.

### Step 4 — Automation service (`automation.service.ts`)

- Fetch existing label leaves once per run; pass to the provider.
- After each provider batch, validate proposals with the label-normalization utilities as
  described in Target behavior #4. To avoid a features-cross-import, move
  `label-normalization.ts` to `apps/api/src/lib/label-normalization.ts` and re-export it from
  its old path (one-line file) so discovery code keeps compiling.
- Cap check: count distinct `MailMind/*` labels for the account; enforce
  `env.AUTOMATION_MAX_LABELS`.
- Persist `label_name` on `automation_message_actions`; keep writing `label_path`
  (`MailMind/<leaf>`) as today. Stop writing `category` (now nullable).
- Learned patterns: read/write `label_name`; the reuse threshold logic is unchanged.
- Add `AUTOMATION_MAX_LABELS` to `apps/api/src/config/env.ts` (Zod, int, default 25) and to
  both `.env.example` files and `docs/backend.md`.

### Step 5 — Controller and routes

`automation.controller.ts:9`: `approvalSchema` becomes
`z.object({ labelName: z.string().min(2).max(40) }).strict()`, validated server-side with the
same normalization pipeline before applying. Update the API docs entry in `docs/api.md`.

### Step 6 — Frontend

- `apps/web/src/types/automation.ts` and `automationQueries.ts`: `category` → `labelName`.
- `AutomationPage.tsx` review items: render the proposed label name; approval sends
  `labelName`. `groupAutomationReviewItems.ts` groups by `labelName` (update its test).
- Freeze navigation: remove Classification and Label discovery links from `AppShell.tsx` and
  their routes from `router/index.tsx` (keep page files). Redirect those paths to the
  dashboard.
- Dashboard: remove classification/discovery run buttons and their poll hooks if present;
  automation status stays.

### Step 7 — Freeze the backend surface of classification and discovery

In `apps/api/src/routes/index.ts`, stop mounting `classification.routes` and
`label-discovery.routes` (leave sync, auth, gmail, automation). Their services, repositories,
tables, and tests remain. If their HTTP tests fail because routes are unmounted, skip those
suites with a comment referencing this spec rather than deleting them.

### Step 8 — Tests and verification

- Update `automation-openai.test.ts` (schema change), `automation-service.test.ts` (validation
  - cap + reuse-vs-propose paths), `automation-http.test.ts` (approval payload),
    `contracts.test.ts` if it pins the automation DTOs.
- New unit tests: proposal rejected as generic; similar proposal coerced to existing label;
  cap reached → review queue; approval with invalid label name → 400.
- Green gates, in order: `npm run typecheck`, `npm test`, `npm run test:database --workspace
@mailmind/api` (local stack only), `npm run lint`, `npm run build`.
- Manual check: run automation against a test Gmail account; confirm new labels appear under
  `MailMind/` in Gmail, are reused on the next run, and the label count respects the cap.

---

## Sequencing and size

Steps 1–2 (migration + types) → 3–4 (provider + service, the core) → 5 (API) → 6–7
(frontend + freeze) → 8 (tests). Steps 3–4 are the only genuinely tricky ones. Net effect is
strongly code-negative in active surface area: one feature does the whole job, two features go
dormant, and roughly eight tables stop being written to.

## Guardrails for the implementing agent

- Never fetch or store message bodies; metadata boundary is inviolable.
- Automation stays the only code path that mutates Gmail.
- All external calls stay outside database transactions (existing convention).
- Every migration ships in both `apps/api/prisma/migrations` and `supabase/migrations`.
- Model output is untrusted input: every label proposal passes server-side validation.
- Do not delete frozen code or tables in this refactor.
