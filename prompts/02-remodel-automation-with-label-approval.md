# Stage 2 — Remodel automation: AI-proposed labels, user approval, full backfill

Prerequisite: stage 1 branch is merged into development. Read CLAUDE.md and
`docs/refactor-simple-agent.md` for conventions. Branch:

```
git checkout development && git pull
git checkout -b feature/stage2-automation-remodel
```

## Product behavior to implement

1. **Label proposal (one-time onboarding, re-runnable).** After Gmail sync, the user triggers
   "Propose labels". The API runs the preserved discovery engine
   (`label-discovery.engine.ts`) over synced metadata and returns a proposed label set sized
   by the quantity and type of email found.
2. **User approval.** A new simple Labels screen lists proposals. The user can approve,
   rename, delete, and add custom labels. Nothing touches Gmail until the user confirms the
   set. On confirm, each approved label is created in Gmail via the existing
   `ensureLabel(accountId, 'MailMind/<leaf>')` in `automation-gmail.service.ts`.
3. **Automation files everything.** Automation classifies each message into exactly one
   approved label (or no label). It first runs a **backfill** over the existing synced
   backlog in bounded batches, then continues with daily runs for new mail.
4. **Fallback rule.** A message that fits no approved label is left in the inbox untouched —
   no catch-all label, no silent new labels. Low-confidence results go to the existing
   review queue. The AI may propose _additional_ labels only through the proposal flow (#1),
   never during an automation run.

## Backend changes

Database (one migration, both locations, same timestamp name):

- New table `user_labels`: id, connected_google_account_id (FK, cascade), leaf_name,
  full_path (unique per account), source enum `AI_PROPOSED | USER_CREATED`, gmail_label_id
  (nullable until created), timestamps. RLS + grants per existing migration patterns.
- `automation_message_actions`: add `label_name text`; backfill from `category::text`; make
  `category` nullable (deprecated).
- `learned_classification_patterns`: same `label_name` treatment.
- After this migration, `classification_category` has no required consumers — drop it here
  along with the deprecated `category` columns.

API (feature `apps/api/src/features/labels/` or fold into automation):

- `POST /api/labels/propose` — runs the discovery engine, upserts into
  `dynamic_label_candidates`, returns proposals. Reuse the account lease pattern.
- `GET /api/labels` — approved labels + pending proposals.
- `POST /api/labels/confirm` — body: array of `{ leafName, source }`. Validate each with
  `validateLeafName`, `isGenericLabelName`, `labelsAreSimilar` (from
  `label-normalization.ts`); reject duplicates/similar pairs with 409. Persist to
  `user_labels`, then `ensureLabel` each and store `gmail_label_id`.
- `PATCH /api/labels/:id` (rename → also rename in Gmail via labels.update) and
  `DELETE /api/labels/:id` (delete row; leave the Gmail label in place — never mass-unlabel).

Automation service:

- Provider input: pass the account's approved leaf names. Structured-output schema: the
  model returns `labelName` constrained to an enum of approved leaves **plus** the literal
  `"NONE"` for no-fit. Keep confidence/explanation/reasonCodes and all timeout/retry/batch
  bounds and token/cost accounting.
- `NONE` → record a skipped action, leave the message in the inbox.
- Confident match → apply existing `gmail_label_id` via `messages.modify` (existing code).
- Learned patterns read/write `label_name`.
- Backfill: if unprocessed synced messages predate automation enablement, the run processes
  them oldest-first in the existing bounded-batch/checkpoint loop until exhausted, then
  daily incremental behavior resumes. Respect existing budget guards; a backfill may span
  multiple runs — that is fine, the checkpoints make it resumable.
- Approval endpoint in `automation.controller.ts`: `{ labelName }` validated against the
  account's approved labels (no free-form enum).
- Gate automation start: refuse to run (clear error code) until `user_labels` has at least
  one confirmed row.

## Frontend changes

- New `LabelsPage` (route `/labels`, tab in `MotionTabs`): propose button, editable list
  (approve / rename inline / delete / add custom), single "Confirm and create in Gmail"
  action with a ConfirmDialog. Follow the existing paper-and-ink styles in
  `src/styles/index.css`; no new design language.
- `AutomationPage`: review items show `labelName`; approval sends `labelName`; show
  backfill progress from run counters. Update `groupAutomationReviewItems` + test.
- Dashboard: guide the user through the new order — sync → propose labels → confirm →
  automation. Update tutorial scenario accordingly.
- Types/queries: new `labels` query module + queryKeys; remove remaining fixed-category
  types from `types/automation.ts`.

## Env and docs

- `AUTOMATION_MAX_LABELS` (Zod int, default 25) in `apps/api/src/config/env.ts`, both
  `.env.example` files, and `docs/backend.md`. Proposal endpoint caps proposals + existing
  approved labels at this number.
- Update `docs/architecture.md`, `docs/api.md`, and `docs/stage-5-daily-automation.md` to
  the new flow; delete or mark superseded the stage-4/4.5 docs.

## Tests

- New: labels HTTP tests (propose/confirm/rename/delete, validation 400s, similarity 409),
  automation service tests for NONE fallback, approved-enum constraint, backfill loop, gate
  when no labels confirmed.
- Update: `automation-openai.test.ts`, `automation-service.test.ts`, `automation-http.test.ts`,
  `contracts.test.ts`, e2e specs.
- Gates in order: `npm run typecheck`, `npm test`, `npm run lint`, `npm run build`,
  `npm run test:e2e`.

## Commit

Logical commits per layer (migration, API, automation, frontend, docs). Branch name above;
do not merge.
