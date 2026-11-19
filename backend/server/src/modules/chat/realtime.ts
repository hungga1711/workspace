import type { Server as HttpServer } from "node:http";
import { Server, type Socket } from "socket.io";
import type { Pool } from "pg";
import { runWithContext, withTransaction, type Principal, featureDisabled } from "@workspace/shared";
import { kv, logger, verifyInternalToken } from "@workspace/service-kit";
import { Collab } from "./collab.js";
import { WhiteboardCollab } from "./whiteboard-collab.js";

/**
 * Socket.IO realtime. Rooms are joined server-side from the database, never from client input:
 *   u:{user}      every socket of a user (multi-device)
 *   c:{channel}   every member of a channel
 * One process holds every connection (ADR 0021), so Socket.IO's in-memory adapter is the whole fan-out. Delivery
 * is best-effort: clients recover gaps by fetching messages after their last seq.
 */
const userRoom = (userId: string) => `u:${userId}`;
const channelRoom = (channelId: string) => `c:${channelId}`;

export class Realtime {
  readonly io: Server;
  /** Live co-editing of docs pages (null without the work module's URL). */
  readonly collab: Collab | null;
  /** Live whiteboards (null without the work module's URL). */
  readonly whiteboards: WhiteboardCollab | null;

  constructor(
    http: HttpServer,
    private readonly pool: Pool,
    secret: string,
    corsOrigin: string[],
    collab?: { workUrl: string; internalSecret: string },
  ) {
    // 2 MB: a docs page's first draft (its whole content) arrives in one message. WebSocket only, no long-polling.
    this.io = new Server(http, {
      path: "/socket.io",
      transports: ["websocket"],
      cors: { origin: corsOrigin, credentials: true },
      serveClient: false,
      maxHttpBufferSize: 2e6,
    });
    const live = (this.collab = collab ? new Collab(this.io, pool, collab) : null);
    const boards = (this.whiteboards = collab ? new WhiteboardCollab(this.io, pool, collab) : null);

    this.io.use(async (socket, next) => {
      try {
        const ticket = (socket.handshake.auth as { ticket?: string }).ticket;
        if (!ticket) return next(new Error("unauthenticated"));
        const { principal } = await verifyInternalToken(ticket, secret);
        socket.data.principal = principal;
        next();
      } catch {
        next(new Error("invalid ticket"));
      }
    });

    this.io.on("connection", (socket) => {
      // Live editing belongs to its feature: left out at deploy time (DISABLED_FEATURES), nothing answers its events.
      if (!featureDisabled("docs")) live?.attach(socket);
      if (!featureDisabled("whiteboards")) boards?.attach(socket);
      this.onConnect(socket).catch((err) => {
        logger.error({ err }, "socket setup failed");
        socket.disconnect(true);
      });
    });
  }

  /** The person's conversations, as rooms (read from the database, never from the client). */
  private async channelRooms(p: Principal, requestId: string) {
    const channels = await runWithContext({ actorId: `user:${p.id}`, requestId }, () =>
      withTransaction(this.pool, async (c) =>
        (await c.query<{ channel_id: string }>("SELECT channel_id FROM channel_members WHERE user_id = $1", [p.id])).rows.map((r) => r.channel_id),
      ),
    );
    return channels.map((ch) => channelRoom(ch));
  }

  private async onConnect(socket: Socket) {
    const p = socket.data.principal as Principal;
    // The app keeps one connection from the start (calls ring anywhere); chat asks again when it opens,
    // so conversations made meanwhile by something else (a new workspace's #general) are joined too.
    // At most one lookup every 5 s per socket, so a client cannot turn it into a stream of queries; a request inside
    // the window runs once when it ends rather than being dropped (a conversation just made must still be joined).
    let lastSync = 0;
    let queued: NodeJS.Timeout | null = null;
    const sync = () => {
      queued = null;
      lastSync = Date.now();
      void this.channelRooms(p, socket.id)
        .then((rooms) => socket.join(rooms))
        .catch(() => undefined);
    };
    socket.on("rooms:sync", () => {
      if (queued) return;
      const wait = lastSync + 5000 - Date.now();
      if (wait <= 0) sync();
      else queued = setTimeout(sync, wait);
    });
    socket.on("disconnect", () => queued && clearTimeout(queued));
    const channels = await this.channelRooms(p, socket.id);
    await socket.join([userRoom(p.id), ...channels]);
    await this.setPresence(p, true);
    socket.emit("ready", { channels: channels.length });

    socket.on("typing", (msg: { channelId?: unknown }) => {
      const ch = typeof msg?.channelId === "string" ? msg.channelId : null;
      const room = ch ? channelRoom(ch) : null;
      // Only rooms the server already joined for this socket: no client-chosen rooms.
      if (room && socket.rooms.has(room)) socket.to(room).emit("typing", { channelId: ch, userId: p.id });
    });

    socket.on("heartbeat", () => void this.setPresence(p, true));
    socket.on("disconnect", async () => {
      const remaining = await this.io.in(userRoom(p.id)).fetchSockets();
      if (remaining.length === 0) await this.setPresence(p, false);
    });
  }

  private async setPresence(p: Principal, online: boolean) {
    const key = `presence:${p.id}`;
    if (online) kv().set(key, "1", { ttlMs: 90_000 });
    else kv().del(key);
  }

  async presence(userIds: string[]): Promise<Record<string, boolean>> {
    if (userIds.length === 0) return {};
    const vals = kv().mget(userIds.map((u) => `presence:${u}`));
    return Object.fromEntries(userIds.map((u, i) => [u, vals[i] === "1"]));
  }

  toChannel(channelId: string, event: string, data: unknown) {
    this.io.to(channelRoom(channelId)).emit(event, data);
  }

  toUser(userId: string, event: string, data: unknown) {
    this.io.to(userRoom(userId)).emit(event, data);
  }

  /** Offboarding: closes the person's open sockets (reconnecting needs a ticket, which the gateway then refuses). */
  disconnectUser(userId: string) {
    this.io.in(userRoom(userId)).disconnectSockets(true);
  }

  /** Membership changes take effect on live sockets, and the person's sidebar learns about the conversation without a reload. */
  joinChannel(userIds: string[], channelId: string) {
    for (const u of userIds) {
      this.io.in(userRoom(u)).socketsJoin(channelRoom(channelId));
      this.io.to(userRoom(u)).emit("channel.joined", { channelId });
    }
  }

  leaveChannel(userId: string, channelId: string) {
    this.io.in(userRoom(userId)).socketsLeave(channelRoom(channelId));
  }
}
