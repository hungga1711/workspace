# backend/

The server side of workspace: one process (`server/`) hosting nine modules, each with its own folder, Postgres schema
and role (in one database), migrations and HTTP API, and the shared packages they build on
([ADR-0021](../docs/adr/0021-one-server-no-valkey.md)). Modules never import each other's code (lint-enforced); they
talk over HTTP with the caller's principal for reads (handed over in memory) and over events (transactional outbox →
relay → the consuming modules, same process) for side effects.

```
server/src/main.ts         composes the modules; :4000 public (gateway, Socket.IO, /storage), :4001 module APIs (127.0.0.1)
server/src/modules/
  gateway                  sessions, routing, rate limits, realtime tickets (public)
  identity                 users, roles, permissions, sign-in, API keys, audit
  platform                 workspace, first-run setup, configuration, webhooks
  search                   events → Postgres search schema (no HTTP)
  chat                     channels, messages, threads, Socket.IO, calls
  home                     notifications, Home feed, briefs, reminders, digests
  work                     tasks, projects, goals, follow-up & outcomes, docs, drive, calendar, meetings, approvals
  employee                 directory, departments, attendance, leave
  ai                       AI gateway & connections, assistant, metering, costs & budgets, AI oversight
server/migrations/<module> forward-only SQL per schema (plus `web`, the web app's sessions)
server/test/<module>       integration tests against real Postgres and S3
packages/contracts         event envelope & catalog types
packages/shared            request context, transactions, authorization, outbox, ids
packages/service-kit       Nest middleware, migrations, event bus, relay and consumers, module hosting, storage, mailer
packages/testkit           integration-test helpers
```

- How to work here: [AGENTS.md](AGENTS.md)
- Design: [system design](../docs/architecture/system-design.md) · [database](../docs/database/README.md) · [events](../docs/events/README.md)
