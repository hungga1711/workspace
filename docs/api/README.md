# Public HTTP API

[`openapi.json`](openapi.json) is the OpenAPI 3.1 description of the routes an integration may call: tasks,
projects, agent workflows and their runs, requests for approval, the calendar and meetings, documents, whiteboards,
chat, people, "my day" and the inbox, search, team workload and outcomes, and the AI Insights aggregates. It is
generated from `PUBLIC_API` in `backend/packages/contracts/src/api/public-api.ts`, whose request schemas are the
ones the modules parse, so a body the document describes is the body the server accepts. CI fails when the file is
stale, and a test (`gateway/mcp-tools.test.ts`) fails when an MCP tool calls a route, a query parameter or a body
that `PUBLIC_API` does not describe.

```bash
pnpm build:packages && pnpm api:openapi          # rewrite docs/api/openapi.json
node tooling/scripts/openapi.mjs --check          # what CI runs
```

## Calling it

- Base URL: `https://<API_DOMAIN>` (or the gateway at `http://localhost:4000` in development). Paths start with `/api/`.
- `Authorization: Bearer wos_…`: an API key. A workspace key (Admin › Integrations) acts as a service with the
  permissions you picked; a personal key (Me › Profile › Sign-in and security) acts as the person who made it,
  within their own scopes. Every call is checked by the owning module exactly as in the web app.
- Rate limit: `RATE_USER_PER_MIN` requests per credential per minute (600 by default). Every answer carries
  `RateLimit-Limit`, `RateLimit-Remaining` and `RateLimit-Reset` (seconds until the count starts again); past the
  limit the answer is `429` with `Retry-After`.
- Retries: send `Idempotency-Key: <8 to 128 characters of your own>` with a `POST` made with an API key. A retry with
  the same key and the same body within 24 hours gets the first answer back (`Idempotency-Replayed: true`) instead of
  a second task, message or run; the same key with another body is `422 idempotency_key_reused`; a retry that
  arrives while the first call still runs is `409 idempotency_in_progress`. Only successes are kept, and a server
  restart forgets them (they live in memory, like the rate limits). Chat messages also take `clientMsgId`.
- Errors: `{ "error": "…", "message": …, "requestId": "…" }`. `error` is a stable word to branch on (`not_found`,
  `conflict`, `invalid`, `feature_off`…); `message` is for people: a sentence, or a list of what is wrong with the
  request's fields. Quote `requestId` when asking for help. Updates take `expectedVersion` and answer `409` on a
  concurrent edit.
- Lists: tasks and people page with `cursor` / `after` and answer `nextCursor`; a channel's messages go back with
  `before` and answer `nextBefore`; projects take `limit` (200 at most); documents, approvals and a task's runs
  return the newest (200, 100 and 20); the calendar is read by window (`from`, `to`, 500 events at most).
- Reading one task, project or document takes its code as shown in the app (`GET /api/work/tasks/T-041`, any
  case) as well as its id; a code from another workspace is a `404`. Writes take the id the read returns.

## Following an agent workflow run

```bash
curl -s -X POST $API/api/work/tasks/T-041/runs -H "authorization: Bearer $KEY" -H "content-type: application/json" \
  -H "idempotency-key: run-T-041-2026-11-13" -d '{"inputs":{"tone":"warm"}}'          # → the run, with its id
curl -s $API/api/work/runs/$RUN -H "authorization: Bearer $KEY"                           # status, steps, asks, doing
curl -s "$API/api/work/runs/$RUN/activity?step=0&after=$LAST" -H "authorization: Bearer $KEY"   # what the agent did since
```

Or do not poll: Admin › Integrations › Webhooks offers `work.run.started.v1`, `work.run.asked.v1` (the AI asks
people something), `work.run.waiting.v1` (an approval step waits), `work.run.finished.v1` (`status` `done` or
`failed`, with `error`) and `work.run.cancelled.v1`. Each carries `runId`, `taskId`, the task's `code` and the
workflow's name.

## Browsing it

Set `API_DOCS=1` on the server and open `/api/docs` (a viewer of the same document, loaded from a pinned CDN
script) or `/api/docs/openapi.json`. Off by default: nothing is served at `/api/docs` otherwise.

## Adding a route

Add the operation to `PUBLIC_API` (and, when it takes a body, move the controller's zod schema into
`backend/packages/contracts/src/api/` and import it from there), then `pnpm build:packages && pnpm api:openapi`.
AI agents use the same operations through MCP: [docs/integrations/mcp.md](../integrations/mcp.md).
