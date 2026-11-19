# Runbook: local development

Brings up the full stack on a laptop: infrastructure in Docker, the backend server and the web app on the host with hot reload. Grounded in `package.json`, `tooling/scripts/*`, `infra/local/docker-compose.yml`, `.env.example`, `.github/workflows/ci.yml`.

## 1. Prerequisites

| Tool | Version | Why |
|---|---|---|
| Node.js | ≥ 22 (`engines.node`; `process.loadEnvFile` is used by `dev-server.mjs`) | server, web, scripts |
| pnpm | 10.33.0 (`packageManager`) | workspace install — `corepack enable` picks it up |
| Docker Desktop / Engine + Compose v2 | Docker VM with **≥ 4 GB RAM** and **≥ 20 GB free disk** | `infra/local` |
| `psql` (optional) | any | inspecting the database |
| Chrome/Edge (optional) | — | loading the AI browser extension |

## 2. First start

Run from the repository root.

```bash
pnpm install
cp .env.example .env                 # optional values: AI keys, LiveKit, limits (dev-server loads it)
pnpm infra:up                        # docker compose -f infra/local/docker-compose.yml up -d
pnpm build:packages                  # contracts, shared, service-kit, testkit → dist/ (the server imports dist)
pnpm migrate                         # tooling/scripts/migrate-all.mjs: every module's schema as workspace_owner
pnpm dev:server                      # the backend: all nine modules in one process (:4000, :4001), auto-restart on change
cd frontend/web && pnpm dev          # http://localhost:3000   (second terminal; Turbopack, then warms the main screens so first visits are quick)
```

Then:

1. Open http://localhost:3000 → **/setup**: company name, owner name, e-mail, password. Remember the e-mail and password: the demo seed signs in as this owner (`SEED_OWNER_EMAIL` / `SEED_OWNER_PASSWORD`).
2. E-mails (invites, resets, digests) go out through `SMTP_URL` in `.env` (your company's SMTP server). Test with
   an address at [yopmail.com](https://yopmail.com) and open its inbox there. Without `SMTP_URL` nothing is sent and
   invites hand back an activation link.

Order matters: `build:packages` before typecheck/the server (otherwise "cannot find module @workspace/…"); `migrate` before `dev:server` (the web app's `web` schema is only created there; the modules migrate their own on start too); infrastructure healthy before `dev:server` (`docker compose -f infra/local/docker-compose.yml ps`). Re-run `pnpm build:packages` after changing anything in `backend/packages/*` if you run typecheck or tests (dev-server itself watches package sources).

`pnpm infra:db` starts only Postgres (enough for some unit tests). PgBouncer is optional: `docker compose -f infra/local/docker-compose.yml --profile pgbouncer up -d pgbouncer`.

## 3. Demo data

```bash
pnpm seed:demo
```

`tooling/scripts/seed-demo.mjs` signs in as the owner (`SEED_OWNER_EMAIL`, `SEED_OWNER_PASSWORD`: the account from `/setup`), then through the public API creates the Workspace open-source team in English (`seed-demo-company.mjs`): five members (invited with a temporary password that each one changes, so no email is sent), two departments, three projects with their tasks, goals, leave, announcements, approvals, documents, meetings and chat. Last, it writes the history straight into the database (the API never backdates): eight weeks of finished work and AI Insights (`seed-demo-ai.mjs`) and four weeks of attendance, so AI › AI adoption has something to compare. Needs the whole stack running (server, web). Re-running is safe: it stops once the first demo project exists. The members use `@example.com` addresses and one generated password, printed at the end and kept in `.seed-demo.json` (gitignored) so re-runs can sign in again.

To see the workspace:

```bash
docker compose -f infra/local/docker-compose.yml exec postgres psql -U postgres -d workspace -c "SELECT name, status FROM platform.workspace"
```

## 4. Optional features locally

- **AI**: easiest is Admin › AI connections in the web app (API key, OpenAI-compatible URL, or Ollama at `http://localhost:11434`). Or set `GEMINI_API_KEY` / `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `OPENAI_BASE_URL` and `AI_*` routing in `.env`, then restart dev-server. Without any, AI UI is hidden and generative endpoints return `503 ai_not_configured`.
- **Browser extension**: `chrome://extensions` → Developer mode → Load unpacked → `frontend/browser-extension`; create a connection code in Me › My AI and paste it in the extension options. `pnpm --filter @workspace/web ext:zip` builds the download zip.
- **Meetings**: LiveKit runs on :7880 with the dev key in `.env.example` (`LIVEKIT_*`, uncomment). Recording: `LIVEKIT_CONFIG=livekit-recording.yaml docker compose -f infra/local/docker-compose.yml --profile recording up -d` (Egress needs a Redis of its own, which that profile adds) and `MEET_RECORDING=on`.
- **Logs**: the server logs JSON lines to the terminal, each with `requestId` (also in every error body and the `x-request-id` header): search the output for it. Who did what in a workspace is in Admin › Activity log (the audit log).

## 5. Ports

| Port | What | Notes |
|---|---|---|
| 3000 | web (Next.js) | `pnpm dev` in `frontend/web` |
| 4000 | server: gateway, Socket.IO, local files | `/health`; the public API (`/api/<module>/…`), `/socket.io` (WebSocket only), `/storage/…` |
| 4001 | server: module APIs (127.0.0.1) | `/identity/…`, `/platform/…`, `/chat/…`, `/home/…`, `/work/…`, `/employee/…`, `/ai/…`; `/health` lists the modules. The search module has no HTTP API |
| 5432 | Postgres | database `workspace`, a schema per module; superuser `postgres/postgres`, `workspace_owner/owner_pw`, module roles `workspace_<module>/app_pw` and `workspace_web/app_pw` (the web app's sessions) |
| 6432 | PgBouncer | optional (`--profile pgbouncer`), transaction pooling |
| 8333 | SeaweedFS S3 | |
| 7880 / 7881 / 50000–50060 udp | LiveKit | |

## 6. Tests

```bash
pnpm lint && pnpm format:check && pnpm -r typecheck
pnpm -r test                                # unit + integration on the test database (CI uses --workspace-concurrency=1)
cd frontend/web && pnpm test                # web unit tests
cd frontend/web && pnpm build && pnpm budget   # route JS budgets
cd frontend/web && E2E_BASE_URL=http://localhost:3002 npx playwright test   # E2E (headless) against the test installation
```

**Tests never touch the development database.** An installation holds exactly one workspace (ADR 0005, ADR 0023). The suites run on their own installation, `workspace_test`, and a suite
that needs first-run setup empties it first (`resetTestDatabase` in `tooling/scripts/test-db.mjs`):

- `pnpm test:db` creates and migrates it (`--reset` recreates it); the server's vitest config does this itself and
  points every module at it.
- `pnpm test:server` empties it and runs the server on it at :4100 (modules on :4101) with `TEST_FIXTURES=1`. Some backend
  integration tests (chat search, the employee master data) and every E2E spec need it running. For E2E add
  `AI_LOCAL_MODEL=1` (the built-in extractive model stands in for a provider), `WEBHOOK_ALLOW_PRIVATE=1`
  (local test servers), `RATE_SIGNUP_PER_HOUR=1000` and `MAIL_OUTBOX_DIR=/tmp/workspace-mail`
  (emails as files for `auth.spec.ts`; run Playwright with it too).
- The web app for E2E: build with `GATEWAY_URL=http://localhost:4100 NEXT_PUBLIC_CHAT_URL=http://localhost:4100 STORAGE_PUBLIC_ORIGIN="http://localhost:8333 http://localhost:4100" LIVEKIT_URL=ws://localhost:7880`
  (the production build's content security policy only lets the browser reach the origins named at build, and its
  rewrites of `/api/mcp`, the runner and the connect program to the server are fixed at build too), then
  `GATEWAY_URL=http://localhost:4100 WEB_DATABASE_URL=postgres://workspace_web:app_pw@localhost:5432/workspace_test pnpm start -p 3002`.
- Playwright itself needs `GATEWAY_URL=http://localhost:4100` too (`integrations.spec.ts` calls the API directly).

CI does the same. `e2e/ai-connections.spec.ts` starts its own OpenAI-compatible stand-in, so it needs no provider either. `TEST_FIXTURES=1` (also on the web app for E2E) keeps invite passwords as typed and starts AI switched on; never set it or `AI_LOCAL_MODEL` outside tests.

## 7. Restarting things

- **The backend**: dev-server restarts the server automatically when files under `backend/server/src/` or `backend/packages/*/src` change; to force it, `touch backend/server/src/main.ts`. `WATCH=0 pnpm dev:server` disables watching; then Ctrl-C and re-run.
- **One container**: `docker compose -f infra/local/docker-compose.yml restart <service>` (e.g. `postgres`).
- **Fresh database**: `pnpm infra:down`, `docker volume rm workspace_pgdata` (only this project's volume), `pnpm infra:up`, `pnpm migrate`, redo `/setup`.

## 8. Common problems

| Symptom | Cause | Fix |
|---|---|---|
| `Cannot find module '@workspace/shared'` / typecheck errors in the server | packages not built | `pnpm build:packages` |
| Containers exit, Postgres "No space left on device" | Docker VM disk full | `docker system df`; remove **this project's** stopped containers/volumes (`pnpm infra:down`, `docker volume ls \| grep workspace`). Do not prune other projects' images or volumes without checking with their owners. Increase the Docker Desktop disk size. |
| Home feed / search / employee profiles never update | the server is not running (relays and consumers live in it), or events are dead-lettered | `pnpm ops:dlq list`; integration tests that create apps in-process start their own relay (`startOutboxRelay`) and open the bus (`eventBus().start()`) |
| Gateway 401 `session_revoked` / `token_stale` | signed out elsewhere, password changed, or the server restarted while identity was unreachable | sign in again; check the server is up (`curl localhost:4001/identity/health`) |
| `/setup` redirects to `/login` | a workspace already exists | sign in, or reset the database (section 7) |
| `next dev` fails with `EMFILE: too many open files` | file-watcher exhaustion | dev-server already uses Node watch on a few folders; do not use `WATCH=tsx`; do not run two `next dev` processes on the same checkout; raise the limit with `ulimit -n 65536` in that shell |
| A screen is slow the first time you open it in dev | Next compiles a route on its first request | `pnpm dev` (Turbopack) warms the main screens after start (`scripts/dev.mjs`); `DEV_WARM=0` skips that, `DEV_BUNDLER=webpack` uses webpack (about 2× slower per cold route) |
| Upload fails with signature mismatch | S3 endpoint host differs between presign and browser | keep `S3_ENDPOINT=http://localhost:8333` locally |
| AI endpoints `503 ai_not_configured` | no provider | by design; configure one (section 4) |
| AI connection test error after changing `.env` secrets | `AI_SECRETS_KEY`/`INTERNAL_TOKEN_SECRET` changed | re-enter keys in Admin › AI connections |
| 429 on signup during E2E | `RATE_SIGNUP_PER_HOUR` default 10 | start the server with `RATE_SIGNUP_PER_HOUR=1000` |

## 9. Adding a module

`sh tooling/scripts/new-module.sh <module>` scaffolds `backend/server/src/modules/<module>/start.ts`, `migrations/<module>/` and `test/<module>/`. Then: add it to `MODULE_URLS` (`backend/packages/service-kit/src/config.ts`; the gateway routes `/api/<module>/…` from it), start it in `backend/server/src/main.ts` and list it in its `moduleRouter([...])`; its role in `infra/local/postgres/init.sql`, `infra/production/postgres/init.sh` (and the PgBouncer userlists); a `001_baseline.sql` that grants to `workspace_<module>_rw` (copy the schema-access and default-privileges blocks of an existing baseline); list it in `migrate-all.mjs` and `DLQ_SCHEMAS` (`service-kit/src/ops/dlq.ts`); set `<MODULE>_DATABASE_URL` for the `app` service in `infra/production/docker-compose.yml` and the templates. It must not import another module's code (`pnpm lint` enforces it). Add an ADR if it changes a boundary ([ADR-0021](../adr/0021-one-server-no-valkey.md)).
