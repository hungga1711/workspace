# backend/ — guide for agents

Node 22, TypeScript (ESM), NestJS 10, `pg`, zod. One package and process, `server/`, hosts nine modules; each module
owns one Postgres schema of the single `workspace` database, reached through its own role
([ADR-0021](../docs/adr/0021-one-server-no-valkey.md)). No Valkey/Redis: events are delivered in process, short-lived
state lives in `service-kit`'s in-memory store (`kv.ts`), what must survive a restart in Postgres. Read [docs/architecture/system-design.md](../docs/architecture/system-design.md) for the big picture.

## Layout

```
backend/
  server/                             @workspace/server: one package, one process, the image's `server` command
    src/main.ts                       composes the modules: starts each, opens the event bus, listens on :4000
                                      (gateway, Socket.IO, /storage) and :4001 (moduleRouter, 127.0.0.1)
    src/modules/<module>/
      start.ts                        migrate, build the Nest app, start the outbox relay (startEvents), consumers and
                                      jobs; returns the module's HTTP handler
      app.ts                          createXApp(deps): Nest module wiring (testable without start)
      *.controller.ts | http/         HTTP surface: parse (zod) → authorize → domain function → DTO
                                      (work, chat, employee: http/<area>.controller.ts on a shared base class,
                                      http/index.ts lists them in registration order)
      <domain>.ts                     domain logic as plain functions over a PoolClient (no Nest)
    migrations/<module>/NNN_*.sql     forward-only changes to the module's schema, applied at boot (001_baseline.sql first)
    test/<module>/*.test.ts           integration tests against real Postgres/S3
  packages/
    contracts/             EventEnvelope + payload schemas (the event catalog's source of truth)
    shared/                request context, withTransaction, authorize(), appendToOutbox, newId
    service-kit/           principal middleware, migrate, EventBus + startEvents + startConsumer, kv (in-memory
                           store), storage, ServiceClient + serviceFetch (in-process calls), moduleRouter, moduleUrl,
                           mailer, ErrorFilter
    testkit/               helpers for integration tests
```

| Port | Module | Schema (role) | Owns |
|---|---|---|---|
| 4000 | gateway | — | edge, sessions, rate limits, Socket.IO tickets |
| 4001 `/identity` | identity | identity (`workspace_identity`) | sign-in (passwords, tokens, two-step), users, roles, permissions, API keys, audit |
| 4001 `/platform` | platform | platform (`workspace_platform`) | the workspace, `/setup`, configuration, module toggles, webhooks |
| — | search | search (`workspace_search`) | the search index (events → Postgres full-text), `reindex` |
| 4001 `/chat` | chat | chat (`workspace_chat`; reads search) | channels, messages, threads, Socket.IO, calls |
| 4001 `/home` | home | home (`workspace_home`) | notifications, Home feed, briefs (event projections) |
| 4001 `/work` | work | work (`workspace_work`) | tasks, projects, boards, Gantt, goals, follow-up/outcomes, docs, drive, calendar, meetings, approvals |
| 4001 `/employee` | employee | employee (`workspace_employee`) | directory, departments, reporting lines, attendance, leave |
| 4001 `/ai` | ai | ai (`workspace_ai`) | AI gateway + connections, assistant, metering, AI oversight, extension intake |

## Rules

1. **One workspace** ([ADR-0023](../docs/adr/0023-one-workspace-data-model.md)): no workspace column, no
   row-level security, no workspace id in principals, events, keys or caches. Writes that belong together run in
   `withTransaction(pool, fn)`. A table with one row per installation is keyed by `singleton` (see
   docs/database/README.md). Never query with the owner role at runtime. Never schema-qualify your own module's
   objects, and never reach another module's schema: its role cannot (by design).
2. **Authorization in the module**, not only the gateway: `assertAllowed(principal, "<permission>", resource)`.
   Permissions are declared in `server/src/modules/identity/catalog.ts`.
3. **Cross-module reads** use `ServiceClient` at `moduleUrl("<module>")` *as the caller's principal* (scope can't
   widen); a module never imports another module's code (the `workspace/module-boundaries` lint rule refuses it; the call
   stays in memory, `serviceFetch`). Shared code belongs in `packages/`. Cross-module writes/side effects go through events: `appendToOutbox` in the same transaction.
4. **Events** are versioned (`domain.entity.verb.v1`) and registered with their payload schema in
   `packages/contracts/src/events` (`appendToOutbox` refuses anything else); consumers use `startConsumer`
   (idempotent via `processed_events`) and narrow with `asKnown(e)`. A new consumer group is listed with its
   streams in `packages/contracts/src/events/groups.ts` (startConsumer refuses a mismatch). There is no ordering
   between events. Regenerate the catalog with `pnpm events:catalog`. See [docs/events/README.md](../docs/events/README.md).
5. **Validation** with zod at the controller edge; domain functions take typed input and throw `NotFound`,
   `Forbidden`, `Invalid`, `Conflict` (mapped to HTTP by the controller's `guard`).
6. **Migrations** are forward-only, idempotent where possible (`IF NOT EXISTS`).
7. **AI** goes through the ai module only (`meteredGenerate` → `WorkspaceGateway`); no other module calls a model vendor directly.
8. **Periodic jobs** go through `scheduleJob(name, everyMs, fn, { pool })` in the module's `start.ts`: one replica runs a job at
   a time (Postgres advisory lock), with its own request id and error handling. Never a bare `setInterval`.
9. **No AI required.** Endpoints that need a model return 503 `ai_not_configured` when none is connected (`server/src/modules/ai/status.ts`).
10. **Optional features** (`docs`, `whiteboards`, `calendar`, `time`, `ai`) can be left out with `DISABLED_FEATURES`
    ([ADR-0026](../docs/adr/0026-deploy-time-feature-flags.md)): the list and parser live in
    `packages/shared/src/deploy-features.ts`, platform publishes them in the workspace's `features`, and the gateway
    answers 404 for their routes (`DEPLOY_ROUTES` in `gateway.ts`: add a new feature route there). A module asks
    `featureDisabled("time")` before scheduling a job that only serves that feature.

## Adding an endpoint (checklist)

- Domain function in `src/<domain>.ts` taking `PoolClient` + `Principal`; unit-test pure parts.
- Controller method: `requirePrincipal` → `parse(schema, body)` → `assertAllowed` → `withTransaction(pool, c => …)`.
- If other modules must react: register the event in `packages/contracts/src/events`, emit it with the module's
  `emit()` helper (typed by the registry), add the consumer and its group in `CONSUMER_GROUPS`, `pnpm events:catalog`.
- Integration test in `test/` (real infra), including a negative authorization case.
- Web: call it through `/api/<module>/…` (`gw()` on the server, `api()` in the client).

## Commands

```bash
pnpm build:packages                                  # after changing backend/packages/*
pnpm --filter @workspace/server typecheck
pnpm --filter @workspace/server test        # needs `pnpm infra:up`; runs on workspace_test, some tests need `pnpm test:server`
pnpm --filter @workspace/server exec vitest run test/work   # one module's tests
sh tooling/scripts/new-module.sh <module>            # scaffold a module
```
