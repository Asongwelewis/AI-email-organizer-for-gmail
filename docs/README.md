# MailMind AI documentation

This directory documents the current MailMind AI MVP implementation.

## Start here

- [Architecture](architecture.md) — system boundaries, components, data flows, storage, and
  security model.
- [Backend](backend.md) — API workspace setup, configuration, modules, database, tests, and
  operations.
- [Frontend](frontend.md) — web workspace structure, routes, authentication, server state, and
  production build.
- [API reference](api.md) — HTTP conventions and the implemented endpoint contracts.

## Stage-specific design notes

- [Stage 2 setup and security](stage-2-setup.md)
- [Stage 3 Gmail synchronization](stage-3-gmail-sync.md)
- [Stage 5 daily automation](stage-5-daily-automation.md) — current automation behavior, including
  the approved-label vocabulary and the backfill.

The stage 4 classification and stage 4.5 label-discovery notes were removed: those workflows no
longer exist. The discovery engine survives as the source of label proposals, described in
[Architecture](architecture.md) and [API reference](api.md).

These documents describe the current implementation. Daily automatic Gmail labeling is
implemented with bounded OpenAI usage and human review; billing and attachment or full-body
ingestion are not implemented.
