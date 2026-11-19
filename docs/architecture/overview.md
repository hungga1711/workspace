# workspace — Architecture Overview

workspace is the self-hosted, single-workspace edition: **one installation = one company workspace**, created once at `/setup`. It lets a business owner see who does what, progress per person and department, and what staff do with AI (the company's own AI and ChatGPT/Claude/Gemini/Copilot via a browser extension). AI is optional and brought by the company; every feature works without it. Licence: MIT (see [ADR 0019](../adr/0019-license-mit.md)).

```
 Browser ──► Caddy ──┬─► app: web (Next.js 15 BFF, :3000) ──► app: server :4000 gateway ──in memory──► every module
   │                 │     sessions in Postgres (web)           JWT (identity) → principal            identity, platform,
   │                 │     tokens never in browser JS           → signed internal token (60s)         chat, home, work,
   │                 │                                                                                employee, ai, search
   │                 ├─► server :4000 /socket.io (WebSocket only, ticket from the gateway), /storage (local files),
   │                 │     /api/mcp (+ OAuth), API-key calls, workflow runner and hooks
   │                 └─► files domain ─► S3 (SeaweedFS/R2, optional), presigned URLs only
   │
   │  each module: own Postgres schema and role + outbox ─► relay ─► the consuming modules, same process
   │                                                              ├─► home projector, employee, chat, work, ai, platform webhooks + audit
   │                                                              └─► search module ─► Postgres (search)
   └── meetings: browser ⇄ LiveKit SFU (join tokens signed by the work module)
```

## Where things live

| Path | What |
|---|---|
| `backend/server` | The backend: one process ([ADR-0021](../adr/0021-one-server-no-valkey.md)); `src/main.ts` composes the modules and listens on :4000 (public) and :4001 (modules' own APIs, loopback only); `migrations/<module>/`, `test/<module>/`, `evals/` |
| `backend/server/src/modules/<module>` | A module: its NestJS app (the gateway is plain Express), domain code and `start.ts`; one Postgres schema each (one database): gateway, identity, platform, search, chat, home, work, employee, ai. A lint rule keeps modules from importing each other |
| `backend/packages/{contracts,shared,service-kit,testkit}` | Event envelope, event registry and consumer groups, public API schemas; authz, transactions, outbox, audit, deploy-time features; Nest/event bus/in-memory store/storage (S3 or local disk)/mail kit; test helpers |
| `frontend/web` | Next.js 15 app and BFF (Tailwind v4, tokens per `DESIGN.md`) |
| `frontend/desktop` | Tauri desktop app that loads the company's server (the same web app) |
| `frontend/browser-extension` | MV3 extension recording AI-tool use under the company policy |
| `infra/local` | Development Docker Compose (Postgres, optional PgBouncer, SeaweedFS, LiveKit) |
| `infra/production`, `infra/docker` | Production compose (postgres, app, Caddy; profiles `s3`, `meet`, `pgbouncer`), install/backup/restore/upgrade scripts, single Alpine image |
| `infra/templates`, `infra/demo` | One-click templates (Coolify, Portainer, CasaOS, Unraid, Railway); the public demo |
| `tooling/scripts` | `dev-server`, `migrate-all`, `seed-demo`, `new-module`, `test-db`, `events-catalog`, `openapi`, `bundle-backend` |

## Read next

- **[System design](system-design.md)** — goals, quality attributes, containers, request path, authorization, realtime, search, files, meetings, AI gateway and oversight, observability, security, failure modes, deployment, testing.
- **[Architecture decision records](../adr/README.md)** — why one database with a schema and role per module (first a database per service), one workspace in the data model, the outbox (Debezium, then Valkey Streams, now delivered in process), BFF + gateway, Keycloak (superseded by own authentication), single-workspace, optional AI, AI oversight, Socket.IO, LiveKit, one server process hosting every module, no OpenTelemetry, deploy-time feature flags, the audit trail, nobody but the person reads their prompts.
- **[Database](../database/README.md)** — one database, a schema per module, roles, migrations (baselines).
- **[Events](../events/README.md)** — envelope, topics, producers and consumers.
- **Runbooks** — [local development](../runbooks/local-development.md), [operations](../runbooks/operations.md); production install guide [infra/production/README.md](../../infra/production/README.md).
- Product and design: [README](../../README.md), [DESIGN.md](../../DESIGN.md), [TODOS.md](../../TODOS.md), [CONTRIBUTING.md](../../CONTRIBUTING.md).

## Six rules that shape every change

1. **No module reads another module's schema** (its Postgres role cannot). Cross-module data moves over each module's HTTP API (as the caller's principal, handed over in memory) or events (outbox → relay → consumers), never by importing another module's code.
2. **One workspace.** No workspace column, row-level security or workspace id anywhere ([ADR-0023](../adr/0023-one-workspace-data-model.md)); writes that belong together run in `withTransaction()`.
3. **Authorization is `authorize(principal, permission, resource)`** (`backend/packages/shared/src/authz.ts`, called through `assertAllowed`) in the owning module, for users, API keys and AI agents alike.
4. **State changes that others care about go through the outbox**, in the same transaction, with a request id.
5. **Nothing may require AI.** Generative endpoints answer `503 ai_not_configured` and the UI hides them; monitoring and oversight always work.
6. **Chat and tasks are the product.** Docs, whiteboards, calendar, time and AI can be left out with `DISABLED_FEATURES` ([ADR-0026](../adr/0026-deploy-time-feature-flags.md)); the gateway answers 404 for their routes (`DEPLOY_ROUTES` in `backend/server/src/modules/gateway/gateway.ts`) and every screen still makes sense without them.
