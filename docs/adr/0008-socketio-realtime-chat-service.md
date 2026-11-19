# ADR-0008: Socket.IO realtime inside chat-service with the Redis adapter

- Status: Accepted (amended by [ADR-0021](0021-one-server-no-valkey.md): one server process, in-memory adapter, Caddy in front)
- Date: 2026-10-15

## Context

Chat, presence, typing, call ringing, notifications and live document co-editing need server push. Most realtime traffic originates in chat. Browsers cannot send the BFF's headers on a WebSocket upgrade, and tokens must not reach browser JavaScript ([ADR-0003](0003-bff-gateway-internal-principal-token.md)). Multiple instances must fan out to each other.

## Decision

- Run **Socket.IO** inside chat-service (`backend/services/chat/src/realtime.ts`) instead of a separate realtime service; other services reach users through chat (HTTP/internal endpoints or events).
- Use **`@socket.io/redis-adapter`** so emits reach sockets on every chat instance.
- Authenticate with a **ticket**: `POST /api/realtime/ticket` on the gateway returns a 60 s internal principal token, presented in `handshake.auth.ticket` and verified with `verifyInternalToken`.
- Rooms (`t:{tenant}:…`, per user and per channel) are joined **server-side only**, from the principal's memberships; typing relays only to joined rooms. Offboarding disconnects the person on every instance.
- Live doc co-editing relays Yjs updates stored in Redis, after work-service confirms edit permission (`collab.ts`).
- Reverse proxy routes `/socket.io/*` directly to chat:4002 (`infra/production/Caddyfile`); the web bundle loads the Socket.IO client lazily (forbidden on home/work initial chunks by the bundle budget).

## Consequences

- One fewer service; realtime shares chat's data access and authorization.
- chat-service carries long-lived connections and must be scaled with sticky sessions (or WebSocket-only transport) behind a load balancer when replicated.
- Redis becomes critical for realtime and co-editing; a Redis outage stops fan-out.
- CSP `connect-src` must include the chat origin (`NEXT_PUBLIC_CHAT_URL`, default `APP_URL`).
