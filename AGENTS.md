# AGENTS.md

Guide for AI coding agents (Claude Code, Codex, Cursor, Copilot…) and new contributors. Read this first,
then the `AGENTS.md` of the area you are changing. Humans: [README.md](README.md) and [CONTRIBUTING.md](CONTRIBUTING.md).

## What this is

workspace is a **self-hosted, single-workspace** work-management app: one installation = one company,
created at `/setup`. A business owner sees who does what, progress per person and department, and what
staff do with AI: the company's own AI (connected in Admin › AI connections) and ChatGPT/Claude/Gemini/Copilot
(through the browser extension), and whether AI use goes with getting work done.

Non-negotiables:

1. **Every feature works without AI.** AI surfaces hide when no AI connection exists (`frontend/web/src/lib/ai.ts`).
2. **No SaaS concepts.** No public site, billing, plans, trials or platform admin.
3. **One workspace.** No workspace column, row-level security or workspace selector anywhere ([ADR-0023](docs/adr/0023-one-workspace-data-model.md)); a second company is a second installation.
4. **Fast and light.** Route JS budgets are gated in CI; heavy client code loads on demand.
5. **Chat and tasks are the product; the rest is optional.** A deployment can leave out docs, whiteboards, calendar, time (attendance and leave) and AI with `DISABLED_FEATURES` ([ADR-0026](docs/adr/0026-deploy-time-feature-flags.md)); every screen must still make sense without them.

## Repository map

| Path | What lives there | Area guide |
|---|---|---|
| `backend/server/` | The backend: one process hosting every module (`src/modules/<module>/`, one Postgres schema and role each, one database): gateway, identity, platform, search, chat, home, work, employee, ai. Modules never import each other's code (lint-enforced) | [backend/AGENTS.md](backend/AGENTS.md) |
| `backend/packages/` | `contracts` (events), `shared` (request context, transactions, authz, outbox), `service-kit` (Nest, event bus, storage, email), `testkit` | [backend/AGENTS.md](backend/AGENTS.md) |
| `frontend/web/` | Next.js 15 app (BFF + UI) | [frontend/web/AGENTS.md](frontend/web/AGENTS.md) |
| `frontend/desktop/` | Tauri desktop app: loads the company's server (the same web app), adds notifications, downloads, links in the browser, `workspace://` links from the web app. No UI of its own beyond the connect page | [frontend/desktop/README.md](frontend/desktop/README.md) |
| `frontend/browser-extension/` | MV3 extension that records AI prompts on ChatGPT/Claude/Gemini/Copilot, with a notice | [frontend/browser-extension/README.md](frontend/browser-extension/README.md) |
| `infra/local/` | Docker Compose for development (Postgres, S3, LiveKit; PgBouncer optional) | [infra/AGENTS.md](infra/AGENTS.md) |
| `infra/production/`, `infra/docker/` | Production compose (postgres, one `app` container, Caddy), backups; the single Dockerfile (Alpine, bundled server) | [infra/AGENTS.md](infra/AGENTS.md) |
| `tooling/` | Shared tsconfig, dev scripts (run the server, migrate, seed) | [tooling/README.md](tooling/README.md) |
| `docs/` | System design, database, events, ADRs, runbooks, diagrams | [docs/README.md](docs/README.md) |

## Commands

```bash
pnpm install && pnpm build:packages          # once per clone, and after changing backend/packages
pnpm infra:up && pnpm migrate
pnpm dev:server                              # the backend server (every module, one process) in watch mode
pnpm --filter @workspace/web dev             # web on :3000 (Turbopack, warms the main screens; DEV_BUNDLER=webpack to fall back)
pnpm typecheck && pnpm lint && pnpm format:check
pnpm -r test                                 # integration tests need infra running (own database: workspace_test)
```

## Conventions (all areas)

- TypeScript strict, ESM, Node 22. Prettier formats; ESLint must be clean.
- Comments explain *why* (constraints, product decisions), not what the next line does.
- Names: files `kebab-case.ts` in backend, `PascalCase.tsx` for React components; events `domain.entity.verb.v1`.
- User-facing text only in `frontend/web/src/lib/i18n/messages/`. English (`en.ts`) is the default locale and the source
  catalog (its keys are the type); `vi.ts`, `zh.ts` and `es.ts` translate it, and a missing key falls back to English.
  Add a key to `en.ts` first, then to the others.
- Tests sit next to the code (`*.test.ts`) for pure logic and in `test/` for integration against real infra.
- Never commit secrets. `.env` is gitignored; document new variables in `.env.example`.
- Database changes are new migration files (`NNN_name.sql` after the module's `001_baseline.sql`), never edits to applied ones.

## Where to find answers

- How the system fits together: [docs/architecture/system-design.md](docs/architecture/system-design.md)
- Tables and schemas: [docs/database/](docs/database/README.md) · Events and topics: [docs/events/](docs/events/README.md)
- Why it is built this way: [docs/adr/](docs/adr/README.md) · Running it: [docs/runbooks/](docs/runbooks/)
- UI rules: [DESIGN.md](DESIGN.md) · Roadmap: [TODOS.md](TODOS.md)
