# Realtime (Socket.IO)

Live updates to the browser come from **the chat module over Socket.IO**, not from domain events. Domain events
(see [README.md](README.md)) feed projections and are seconds behind; Socket.IO is the low-latency,
best-effort path for chat, calls and shared document drafts.

Server: `backend/server/src/modules/chat/realtime.ts` (chat, presence, calls), `backend/server/src/modules/chat/collab.ts`
(document co-editing). Client: `frontend/web/src/lib/realtime.ts` (shared connection),
`frontend/web/src/components/chat/useRealtime.ts`, `frontend/web/src/components/docs/collab.ts` (on the same connection),
`frontend/web/src/components/call/CallListener.tsx`, `CallSession.tsx`.

## Design rules (from `realtime.ts`)

- **Best effort.** No event log, no persistence. Clients recover gaps by re-fetching after
  their last `seq` when the server says `ready` again (`useRealtime.ts`, `onReconnect`).
- **Rooms are joined server-side from the database, never from client input.**
- **One process holds every connection** ([ADR-0021](../adr/0021-one-server-no-valkey.md)), so Socket.IO's
  in-memory adapter is the whole fan-out. Membership changes and disconnects use
  `io.in(room).socketsJoin/socketsLeave/disconnectSockets`.

## Connection and auth (ticket flow)

```
browser ──POST /api/realtime/ticket (session cookie / bearer)──► gateway
gateway: authenticate + resolveWorkspace ──► signInternalToken({principal, requestId}, INTERNAL_TOKEN_SECRET, 60 s)
browser ──WebSocket /socket.io  auth: { ticket }──► chat module (server :4000)
chat module io.use(): verifyInternalToken(ticket) ──► socket.data.principal
```

| Step | Where |
|---|---|
| Ticket endpoint, 60 s TTL | `backend/server/src/modules/gateway/gateway.ts` |
| JWT: HS256, issuer `workspace-gateway`, audience `workspace-services`, claims `principal`, `rid` | `backend/packages/service-kit/src/internal-token.ts` |
| Handshake check; `unauthenticated` / `invalid ticket` errors | `realtime.ts` |
| Client fetches a **fresh ticket on every (re)connect** via the `auth` callback | `frontend/web/src/lib/realtime.ts` |
| Transport `websocket` only, `reconnectionDelayMax` 10 s | `lib/realtime.ts` |
| One shared connection per tab, closed 5 s after the last user releases it | `lib/realtime.ts` |
| Reverse proxy: `/socket.io/*` goes to the server (`app:4000`, WebSocket upgrade) | `infra/production/caddy/Caddyfile`; `NEXT_PUBLIC_CHAT_URL` on the web side |
| Server limits: `path: /socket.io`, CORS = configured origins, `maxHttpBufferSize` 2 MB | `realtime.ts` |

Offboarding: on `identity.member.disabled.v1` (event, group `chat-onboarding`) chat module calls
`realtime.disconnectUser` (`backend/server/src/modules/chat/start.ts`, `realtime.ts`), closing every socket of that user. Reconnecting needs a new ticket, which the gateway no longer issues for a disabled member.

## Rooms

| Room | Pattern | Joined when |
|---|---|---|
| User | `u:{userId}`  | On connect; all of a user's sockets (multi-device) |
| Channel | `c:{channelId}`  | On connect, from `channel_members`; on `rooms:sync`; server-side `joinChannel` when a channel/DM is created or members are added (`backend/server/src/modules/chat/http/channels.controller.ts`); `leaveChannel` on removal |
| Document | `d:{docId}` (`collab.ts`) | After `doc:join` and a work module check that the caller can edit (`GET /docs/:id/collab`, `collab.ts`) |
| Whiteboard | `w:{boardId}` (`whiteboard-collab.ts`) | After `wb:join` and a work module check that the caller can open the board (`GET internal/whiteboards/:id/access` → `{view, edit}`); viewers join to watch ([ADR-0024](../adr/0024-whiteboards.md)) |

Presence: in-memory key `presence:{userId}` (`service-kit/src/kv.ts`) with 90 s TTL, refreshed by `heartbeat` (client
every 30 s, `lib/realtime.ts`); deleted when the user's last socket disconnects.
Read via `Realtime.presence()` for HTTP callers.

## Client → server events

| Event | Payload | Server behaviour | Source |
|---|---|---|---|
| `rooms:sync` | none | Re-reads the user's channels and joins their rooms (at most once per 5 s per socket; a request inside the window runs when it ends) | `realtime.ts`; sent by `useRealtime.ts` |
| `typing` | `{ channelId }` | Relayed as `typing` to that channel room, only if the socket is already in it | `realtime.ts`; sent by `Conversation.tsx` |
| `heartbeat` | none | Refresh presence TTL | `realtime.ts` |
| `doc:join` | `{ docId, version, clientId }`, ack | Checks edit rights and published version; replies `{ok, updates[], resumed}` or `{ok:false, reason: bad/forbidden/stale}` | `collab.ts` |
| `doc:seed` | `{ docId, u }`, ack | First seed wins, returns it | `collab.ts` |
| `doc:update` | `{ docId, u }` (Yjs update ≤ 512 KB) | Relayed to the room, appended to the draft in Postgres (`chat.collab_drafts` and its updates, kept a day, renewed while open); compacted at 400 entries | `collab.ts` |
| `doc:aw` | `{ docId, u }` (≤ 16 KB) | Awareness (cursors), relay only | `collab.ts` |
| `doc:published` | `{ docId, version, title }` | Verified against work module, moves draft base, relayed | `collab.ts` |
| `doc:leave` | `{ docId, discard }`, ack | Leaves room; last one out deletes the draft if `discard`, else keeps it 24 h | `collab.ts` |
| `wb:join` | `{ boardId, clientId }`, ack | Checks the caller may open the board; replies `{ok, updates[], canEdit}` or `{ok:false, reason: bad/forbidden}` | `whiteboard-collab.ts` |
| `wb:seed` | `{ boardId, u }` (≤ 1.9 MB), ack | First editor's seed wins and is returned `{ok, u}` (and relayed as `wb:update` to the room); a viewer gets the seed once there is one, else `{ok:false, reason:"forbidden"}`; too big: `reason:"too_large"` (edit without a live session) | `whiteboard-collab.ts` |
| `wb:update` | `{ boardId, u }` (Yjs update ≤ 512 KB) | Editors only (viewers' updates are dropped): relayed, appended to the draft (`chat.whiteboard_drafts`, `whiteboard_updates`, kept a day, renewed while open); compacted at 400 entries | `whiteboard-collab.ts` |
| `wb:aw` | `{ boardId, u }` (≤ 16 KB, ≤ 60/s per socket) | Awareness (cursor, selection, name, colour), relay only; viewers too | `whiteboard-collab.ts` |
| `wb:leave` | `{ boardId }`, ack | Leaves the room; the draft stays 24 h after the last one leaves | `whiteboard-collab.ts` |

## Server → client events

All are emitted **after** the HTTP handler's transaction commits, directly from the request path (not from domain events).

| Event | Target room | Payload | Emitted at | Web handler |
|---|---|---|---|---|
| `ready` | the socket | `{ channels: number }` | `realtime.ts` | `useRealtime.ts` (triggers gap recovery on reconnect) |
| `message.created` | channel | Message DTO | `backend/server/src/modules/chat/http/messages.controller.ts` (post, poll, forward), `backend/server/src/modules/chat/http/agent.controller.ts` (agent message, `POST internal/agent-messages`), `calls.ts` (call note), `backend/server/src/modules/chat/start.ts` (scheduled send) | `Conversation.tsx` |
| `message.updated` | channel | Message DTO | `backend/server/src/modules/chat/http/messages.controller.ts` | `Conversation.tsx` |
| `message.deleted` | channel | `{ id, channelId }` | `backend/server/src/modules/chat/http/messages.controller.ts` | `Conversation.tsx` |
| `thread.updated` | channel | `{ rootId, channelId }` | `backend/server/src/modules/chat/http/messages.controller.ts` | `Conversation.tsx` |
| `reaction.updated` | channel | `{ messageId, channelId, userId, emoji }` | `backend/server/src/modules/chat/http/messages.controller.ts` | `Conversation.tsx` (refetch message) |
| `poll.updated` | channel | `{ messageId, channelId, votes[{option,count}], voters }` | `backend/server/src/modules/chat/http/messages.controller.ts` | `Conversation.tsx` |
| `pins.updated` | channel | `{ channelId, messageId, pinned }` | `backend/server/src/modules/chat/http/saved.controller.ts` | `Conversation.tsx` (the pin flag and the pinned list) |
| `channel.updated` | channel | channel DTO `{ id, kind, name, topic, archived, autoJoin }` | `backend/server/src/modules/chat/http/channels.controller.ts` | `Conversation.tsx` |
| `read.cursor` | channel (DM/group only) | `{ channelId, userId, seq }` | `backend/server/src/modules/chat/http/inbox.controller.ts` | `Conversation.tsx` |
| `read.updated` | user | `{ channelId, lastReadSeq, unread }` | `backend/server/src/modules/chat/http/inbox.controller.ts` | `Conversation.tsx` (read on another device: sidebar counts) |
| `read.all` | user | `{}` | `backend/server/src/modules/chat/http/inbox.controller.ts` | `Conversation.tsx` (sidebar counts) |
| `typing` | channel (excl. sender) | `{ channelId, userId }` | `realtime.ts` | `Conversation.tsx` ("… đang nhập") |
| `call:ring` | callee's user room | call DTO `{ id, from, to, video, code, channelId, state, startedAt, acceptedAt }` (`calls.ts`) | `calls.ts` | `CallListener.tsx` |
| `call:accepted`, `call:declined`, `call:missed`, `call:cancelled`, `call:ended` | both parties' user rooms | call DTO | `calls.ts` via `tell()` | `CallListener.tsx`, `CallSession.tsx` |
| `doc:hello` | doc room (excl. sender) | `{ docId }` | `collab.ts` | `components/docs/collab.ts` |
| `doc:update`, `doc:aw` | doc room (excl. sender) | `{ docId, u }` | `collab.ts` | `components/docs/collab.ts` |
| `doc:published` | doc room (excl. sender) | `{ docId, version, title, by }` | `collab.ts` | `components/docs/collab.ts` |
| `doc:gone` | doc room | `{ docId, clientId }` | `collab.ts` | `components/docs/collab.ts` |
| `wb:hello` | board room (excl. sender) | `{ boardId }` (someone joined: send your awareness) | `whiteboard-collab.ts` | `components/whiteboard/collab.ts` |
| `wb:update`, `wb:aw` | board room (excl. sender) | `{ boardId, u }` | `whiteboard-collab.ts` | `components/whiteboard/collab.ts` |
| `wb:gone` | board room | `{ boardId, clientId }` | `whiteboard-collab.ts` | `components/whiteboard/collab.ts` |

## Relationship to domain events

The same user action often produces both: e.g. posting a message emits `message.created` on Socket.IO
to the channel room **and** `chat.message.created.v1` to the outbox (`backend/server/src/modules/chat/domain.ts`), which Home
(mentions, DM items, pushes) and search consume. Membership changes are applied to live sockets
synchronously (`joinChannel` / `leaveChannel`), while `chat.channel.member_added/removed.v1` go to
the outbox only (no consumer group reads them).

## Delivery

Live events are a convenience on top of the API, not a log: a client that misses some while connected catches up on
the next reconnect (`ready` makes every open screen reload what it shows). Chat, calls and document co-editing share
one Socket.IO connection per browser tab (`frontend/web/src/lib/realtime.ts`).
