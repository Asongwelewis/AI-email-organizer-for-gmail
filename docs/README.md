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
- [Stage 4 AI classification](stage-4-ai-classification.md)
- [Stage 4.5 dynamic label discovery](stage-4.5-dynamic-label-discovery.md)

These documents describe the repository at the current MVP boundary. Automatic Gmail message
organization, automatic application of discovered labels, distributed background workers, billing,
and attachment or full-body ingestion are not implemented.
