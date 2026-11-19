# ADR-0016: Four services hosting modules (core, work, realtime, ai)

- Status: Superseded by [ADR-0021](0021-one-server-no-valkey.md) (one server process)
- Date: 2026-10-15
- Amends: [ADR-0003](0003-bff-gateway-internal-principal-token.md) (the gateway is now a module of core) and
  [ADR-0008](0008-socketio-realtime-chat-service.md) (Socket.IO lives in the realtime service).

## Context

The backend ran nine Node processes: the gateway, seven NestJS services and the search indexer. Each process
costs 110–130 MB of RAM at idle (compiled, measured) whatever it does, so the backend alone needed about 1.1 GB
before serving anyone, which is most of a 2 GB server. Several hops crossed the network for every request or on
hot paths although the two sides always run together: gateway → identity to resolve the principal and the
session, gateway → platform for the workspace's modules, work → employee for reporting lines.

The user wants a light self-hosted product that still keeps microservice boundaries: separate deployable
services, separate data, calls that could cross a network.

## Decision

- **Four services**, each one process and one image command:

  | Service | Modules | Port(s) | Why together |
  |---|---|---|---|
  | core | gateway, identity, platform, search | 4000 (gateway, public), 4001 (identity, platform; internal) | every request passes the gateway, which needs identity and platform on each one |
  | work | work, employee | 4003 | follow-up, outcomes and approvals read reporting lines and departments |
  | realtime | chat, home | 4002 (+ Socket.IO) | long-lived connections; scaled on their own |
  | ai | ai | 4006 | model calls are slow and bursty; kept apart so they never slow the rest |

- **Modules stay modules.** Each keeps its folder (`backend/services/<service>/src/modules/<module>/`), its
  migrations (`migrations/<module>/`), its schema and Postgres role ([ADR-0015](0015-single-database-schema-per-module.md)),
  its Nest app, its outbox relay, consumers and jobs, and its HTTP API at `<service URL>/<module>/…` with the
  same paths as before. `start.ts` in each module migrates, builds the app, starts events and jobs, and returns
  the request handler; the service's `main.ts` only composes modules.
- **No module imports another module's code.** Modules call each other through `ServiceClient` with a base URL
  (`<MODULE>_URL`, defaults in `service-kit`'s `moduleUrl()`), carrying the caller's principal or a service
  principal, and re-authorize on arrival exactly as before. When the target module lives in the same process
  (`moduleRouter` registers it), `serviceFetch` hands the request to its handler in memory (a real
  `IncomingMessage` and `ServerResponse` with the output captured, no socket): same middleware, same signed token,
  no connection. Moving a module to another service is a configuration change. (`light-my-request` was tried and
  rejected: it re-parents Express's shared request prototype, which breaks every other Express app in the process.)
- Calls between the four services stay HTTP (with the caller's principal) or events.
- Socket.IO accepts WebSocket only (no long-polling), so any realtime node can take any connection and no
  sticky sessions are needed. Production starts Node without `--enable-source-maps`.

## Consequences

- Backend RAM at idle (compiled, `OTEL_SDK_DISABLED=true`, after a minute of warm-up, measured 2026-10-15): 9
  processes 1,087 MB → 4 processes 506 MB (core 120, realtime 125, work 137, ai 124). Fewer containers to run,
  monitor and upgrade.
- Requests skip the network hop to identity and platform (principal, session state, workspace modules) and work
  skips it to employee.
- A service is the unit of scaling: scaling realtime for connections also scales home's jobs (which take a lock,
  so they still run once). A module that needs its own scaling can be moved to its own service.
- A crash in one module takes down its siblings in the same process. The groups were chosen so that siblings
  already depended on each other.
- `<MODULE>_URL` must end in `/<module>`; `<MODULE>_DATABASE_URL` replaces the per-service `DATABASE_URL`.
