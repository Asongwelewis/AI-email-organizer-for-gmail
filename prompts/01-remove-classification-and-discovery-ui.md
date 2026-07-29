# Stage 1 — Remove classification and the label-discovery workflow

You are working in the MailMind AI monorepo. Read CLAUDE.md first and obey all its invariants
(metadata-only boundary, dual-location migrations, never `prisma migrate reset` against remote).

## Branch

```
git checkout development && git pull
git checkout -b feature/stage1-remove-classification
```

## Goal

Delete the classification feature entirely (UI, API, database). Dismantle the label-discovery
_workflow_ (pages, routes, review queue) but **preserve its engine for reuse in stage 2**.

## What to DELETE

Backend:

- `apps/api/src/features/classification/` — the entire directory.
- The classification route mount in `apps/api/src/routes/index.ts`.
- The label-discovery route mount in `apps/api/src/routes/index.ts`, plus
  `label-discovery.routes.ts`, `label-discovery.controller.ts`, and the service methods that
  exist only for the review workflow (approve/reject/defer/merge endpoints). Keep the service
  file if stage-2-relevant logic lives there; otherwise delete it too.
- Tests: `classification.test.ts`, `classification-http.test.ts`,
  `label-discovery-http.test.ts`. Trim `contracts.test.ts` of classification/discovery DTOs.

Frontend:

- `apps/web/src/pages/ClassificationPage.tsx` + test, `apps/web/src/pages/LabelDiscoveryPage.tsx`
  - test, `apps/web/src/features/classification/`, `apps/web/src/queries/classificationQueries.ts`,
    `apps/web/src/queries/labelDiscoveryQueries.ts`, `apps/web/src/types/classification.ts`,
    `apps/web/src/types/labelDiscovery.ts`.
- Their routes in `apps/web/src/router/index.tsx` (redirect old paths to the dashboard), their
  tabs in `MotionTabs`, their entries in `queryKeys.ts`, and any references in the tutorial
  (`apps/web/src/features/tutorial/`) and dashboard.

Database — one migration (ordered directory in `apps/api/prisma/migrations/` AND a flat copy
with the same timestamp name in `supabase/migrations/`):

- Drop tables: `classification_results`, `classification_runs`, `classification_states`,
  `user_classification_corrections`, and discovery workflow tables `label_decisions`,
  `label_discovery_runs`, `label_discovery_states`.
- Drop the enums those tables used **EXCEPT `classification_category`** — it is still used by
  `automation_message_actions.category` and `learned_classification_patterns`. Stage 2
  migrates it; do not touch it now.
- Update `schema.prisma` to match; run `npm run prisma:generate`.

## What to KEEP (stage 2 depends on these — do not delete)

- `apps/api/src/features/label-discovery/label-discovery.engine.ts`
- `apps/api/src/features/label-discovery/label-normalization.ts`
- `apps/api/src/features/label-discovery/label-confidence.ts` and
  `label-discovery.taxonomy.ts` / `label-discovery.types.ts` if the engine imports them
- Tables `dynamic_label_candidates` and `dynamic_label_candidate_messages`
- The entire automation feature, Gmail sync, auth, sessions, security — untouched.

If keeping the engine leaves unused-import/dead-code lint errors, add minimal exports or a
`// stage-2 reuse` comment rather than deleting.

## Reverse regression test (verify the core still works)

Run in this order and fix failures before committing:

1. `npm run typecheck`
2. `npm test` — auth, sync, gmail, automation, security, session suites must all pass.
3. `npm run lint` and `npm run format:check`
4. `npm run build`
5. `npm run test:e2e` — if specs reference deleted pages, update the specs to the surviving
   flows (landing → login → dashboard → automation) rather than deleting assertions blindly.
6. Boot check: `npm run dev`, confirm the API `/health` and `/ready` respond and the SPA
   renders landing, login, dashboard, connections, and automation pages with no console errors.

## Commit

One commit: `refactor: remove classification and label-discovery workflow (stage 1)`.
List deleted tables and preserved engine files in the commit body. Do not merge; leave the
branch for review.
