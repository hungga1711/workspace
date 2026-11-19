# ADR-0021: One server process for every module, no Valkey, one app container behind Caddy

- Status: Accepted
- Date: 2026-10-26
- Supersedes: [ADR-0016](0016-four-services-hosting-modules.md) (four services) and
  [ADR-0012](0012-valkey-streams-events.md) (Valkey Streams; the outbox and its relay stay). Amends
  [ADR-0008](0008-socketio-realtime-chat-service.md) (no Redis adapter) and
  [ADR-0017](0017-nginx-and-lean-image.md) (Caddy instead of nginx + certbot; the lean image stays).

## Context

The goal is the smallest possible infrastructure: a demo people can try before downloading, and installs that
run on one small server or one platform service. After ADR-0016 a default installation was still eight containers
(Postgres, Valkey, core, realtime, work, web, nginx, certbot) and four backend processes of 70–90 MB each. Most of
the extra weight came from splitting what always runs together: every request already crossed the gateway, identity
and platform in one process, and the modules of different services only reached each other over loopback HTTP and
Valkey Streams on the same machine.

The code stays organised as modules, as before: one folder, one schema and Postgres role, one Nest app, one outbox,
its own consumers, jobs and HTTP API each.

## Decision

- **One backend package and process**: `backend/server` (`@workspace/server`). `src/main.ts` only composes the
  modules (gateway, identity, platform, search, chat, home, work, employee, ai); each keeps
  `src/modules/<module>/`, `migrations/<module>/` and `test/<module>/`. One public port (4000): the gateway (`/api`),
  Socket.IO (`/socket.io`) and local files (`/storage/`). The modules' own APIs listen on an internal port (4001) on
  the loopback interface only, for tools and tests.
- **Boundaries are enforced, not just agreed**: an ESLint rule (`workspace/module-boundaries`) refuses an import
  from one module's folder into another's. Modules call each other through `ServiceClient` at `moduleUrl()` (handed
  over in memory by `serviceFetch`, same signed principal and authorization as before) or through events. Shared
  code lives in `backend/packages`.
- **No Valkey.** Events: the producer's transaction writes the outbox row as before; the module's relay hands each
  committed row to the consumer groups of this process and marks it published once they all handled or
  dead-lettered it. The outbox is the durable copy (at-least-once delivery, consumers dedupe through
  `processed_events`); dead letters and replays stay in Postgres (`dlq` requests a replay, the running server
  performs it). Caches, rate limits, presence and call state live in the server's memory with TTLs; what must
  survive a restart moved to Postgres (web sign-in sessions in a `web` schema with its own role, live document
  drafts in `chat`). Socket.IO uses its in-memory adapter.
- **One `app` container**: the image's `app` command runs migrations, then the server and the Next.js web app side
  by side (either stopping stops the container, so the restart policy brings both back). `server` and `web` remain
  as separate commands.
- **Caddy instead of nginx + certbot**: automatic Let's Encrypt certificates and renewal in one container; the
  production compose is `postgres`, `app`, `caddy` (+ optional `s3`, `meet`, `pgbouncer` profiles). The one-click
  templates use a plain-HTTP Caddy behind the platform's proxy.

## Consequences

- Fewer moving parts to install, back up and upgrade: three containers by default, one image, one log to read. No
  broker to size, persist or flush. Memory at idle has not been measured for this layout yet (ADR-0016's four
  processes plus Valkey were about 520 MB of the 530 MB total).
- **No horizontal scaling of the app.** Events, caches, rate limits and live connections are in one process's
  memory: two `app` replicas would split Socket.IO rooms and caches and each relay would deliver only to its own
  process. Scaling out again means reintroducing a shared bus (Valkey Streams or similar) and the Socket.IO adapter;
  the outbox, the consumer groups and `serviceFetch`'s URL indirection were kept so that remains a contained change.
  One process is enough for the sizes measured so far (infra/production/README.md §10).
- A crash in any module restarts everything, and a CPU-heavy request in one module delays the others on the same
  event loop. Model calls and bcrypt are asynchronous (network, libuv threads), so the expected hot spots are large
  JSON responses and document co-editing.
- Events are handed over while the relay's claim transaction stays open, so a slow consumer delays marking its
  batch (not other modules' relays); the batch is kept small.
- Restarting the server clears caches and in-memory call state (calls in progress end); sign-in sessions,
  documents being co-edited and every event survive in Postgres.
