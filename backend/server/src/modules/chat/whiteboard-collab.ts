import type { Server, Socket } from "socket.io";
import type { Pool, PoolClient } from "pg";
import * as Y from "yjs";
import { newId, runWithContext, withTransaction, type Principal } from "@workspace/shared";
import { logger, PRINCIPAL_HEADER, serviceFetch, signInternalToken } from "@workspace/service-kit";

/**
 * Live whiteboards (ADR 0024): the docs relay (collab.ts) for Excalidraw scenes. Everyone in a board's room shares
 * one Yjs document (a Y.Map of elements by id and a Y.Map of files, built by the browser); the server only checks
 * who may join, relays, stores and compacts the updates (whiteboard_drafts, whiteboard_updates), so it never parses
 * a scene. The work module decides access; the snapshot people save there is what lasts, this draft only bridges a
 * restart or a closed tab.
 *
 *   wb:join {boardId, clientId}  → {ok, updates[], canEdit} | {ok:false, reason}   viewers may join (they watch)
 *   wb:seed {boardId, u}         → {ok, u}: the seed everyone uses (the first editor's wins); viewers get it or
 *                                  {ok:false, reason:"forbidden"} while there is none. The winning seed is also
 *                                  relayed as wb:update, so people who joined before it was sent receive it.
 *   wb:update {boardId, u}       editors only: stored, relayed to the room as wb:update
 *   wb:aw {boardId, u}           awareness (cursor, selection, name, colour): relayed only, viewers too
 *   wb:leave {boardId}           → {ok}
 * The room hears wb:hello {boardId} when someone joins (send your awareness again) and wb:gone {boardId, clientId}
 * when someone leaves (drop their cursor).
 */
const KEEP = "24 hours";
/** One live change; a pasted drawing is the biggest. */
const MAX_UPDATE = 512 * 1024;
/** The whole scene at once (Socket.IO's buffer is 2 MB); bigger boards are edited without a live session. */
const MAX_SEED = 1_900_000;
const MAX_AWARENESS = 16 * 1024;
const COMPACT_AT = 400;
/**
 * Awareness messages per socket per second before the rest are dropped (a moving cursor sends a few dozen). Only
 * awareness: a dropped document update would leave later ones unappliable for everyone, so updates are limited by
 * size, like docs.
 */
const MAX_AW_RATE = 60;

const room = (boardId: string) => `w:${boardId}`;

type Ack = (r: unknown) => void;
const isId = (v: unknown): v is string => typeof v === "string" && /^[0-9A-Za-z]{10,40}$/.test(v);
const bytes = (v: unknown, max: number): Buffer | null => {
  let b: Buffer | null = null;
  if (Buffer.isBuffer(v)) b = v;
  else if (v instanceof ArrayBuffer || ArrayBuffer.isView(v)) b = Buffer.from(v instanceof ArrayBuffer ? v : v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength));
  return b && b.length > 0 && b.length <= max ? b : null;
};

export class WhiteboardCollab {
  private readonly counts = new Map<string, number>();
  /** One seed or compaction per board at a time (one process, so a promise chain is the lock). */
  private readonly chains = new Map<string, Promise<unknown>>();

  constructor(
    private readonly io: Server,
    private readonly pool: Pool,
    private readonly cfg: { workUrl: string; internalSecret: string },
  ) {}

  private db<T>(p: Principal, fn: (c: PoolClient) => Promise<T>): Promise<T> {
    return runWithContext({ actorId: `user:${p.id}`, requestId: newId() }, () => withTransaction(this.pool, fn));
  }

  private serial<T>(k: string, fn: () => Promise<T>): Promise<T> {
    const run = (this.chains.get(k) ?? Promise.resolve()).catch(() => undefined).then(fn);
    const tail = run.finally(() => {
      if (this.chains.get(k) === tail) this.chains.delete(k);
    });
    this.chains.set(k, tail);
    return run;
  }

  /** May this person watch / edit the board (the work module decides, asked as them). */
  private async access(p: Principal, boardId: string): Promise<{ view: boolean; edit: boolean }> {
    const res = await serviceFetch(`${this.cfg.workUrl}/internal/whiteboards/${boardId}/access`, {
      signal: AbortSignal.timeout(5000),
      headers: { [PRINCIPAL_HEADER]: await signInternalToken({ principal: p, requestId: newId() }, this.cfg.internalSecret) },
    });
    if (!res.ok) return { view: false, edit: false };
    const a = (await res.json()) as { view?: unknown; edit?: unknown };
    return { view: a.view === true, edit: a.view === true && a.edit === true };
  }

  /** Called synchronously on connection, so events sent right after connecting are not missed. */
  attach(socket: Socket) {
    const p = socket.data.principal as Principal;
    // boardId → this socket's Yjs client id and whether it may edit (decided at join, like docs).
    const joined = new Map<string, { clientId: number; edit: boolean }>();
    let windowStart = 0;
    let inWindow = 0;
    const underRate = () => {
      const now = Date.now();
      if (now - windowStart >= 1000) {
        windowStart = now;
        inWindow = 0;
      }
      return ++inWindow <= MAX_AW_RATE;
    };
    const safe = (fn: (m: Record<string, unknown>, ack: Ack) => Promise<void>) => (m: unknown, ack?: unknown) => {
      const reply: Ack = typeof ack === "function" ? (ack as Ack) : () => undefined;
      fn((m ?? {}) as Record<string, unknown>, reply).catch((err) => {
        logger.warn({ err }, "whiteboard collab event failed");
        reply({ ok: false, reason: "error" });
      });
    };

    socket.on(
      "wb:join",
      safe(async (m, ack) => {
        const { boardId, clientId } = m;
        if (!isId(boardId) || typeof clientId !== "number") return ack({ ok: false, reason: "bad" });
        const a = await this.access(p, boardId);
        if (!a.view) return ack({ ok: false, reason: "forbidden" });
        const updates = await this.db(p, async (c) => {
          await c.query(
            `INSERT INTO whiteboard_drafts (board_id, expires_at) VALUES ($1, now() + interval '${KEEP}')
             ON CONFLICT (board_id) DO UPDATE SET expires_at = EXCLUDED.expires_at`,
            [boardId],
          );
          return (await c.query<{ u: Buffer }>("SELECT u FROM whiteboard_updates WHERE board_id = $1 ORDER BY seq", [boardId])).rows.map((r) => r.u);
        });
        this.counts.set(boardId, updates.length);
        await socket.join(room(boardId));
        joined.set(boardId, { clientId, edit: a.edit });
        socket.to(room(boardId)).emit("wb:hello", { boardId });
        ack({ ok: true, updates, canEdit: a.edit });
      }),
    );

    socket.on(
      "wb:seed",
      safe(async (m, ack) => {
        const me = isId(m.boardId) ? joined.get(m.boardId) : undefined;
        const u = bytes(m.u, MAX_SEED);
        if (!me || !u) return ack({ ok: false, reason: m.u && !u ? "too_large" : "bad" });
        const boardId = m.boardId as string;
        // The first editor's seed wins, so everyone starts from the same scene. A viewer cannot start the shared
        // document (that would be an edit); it gets the seed once there is one.
        const out = await this.serial(boardId, () =>
          this.db(p, async (c) => {
            const first = (await c.query<{ u: Buffer }>("SELECT u FROM whiteboard_updates WHERE board_id = $1 ORDER BY seq LIMIT 1", [boardId])).rows[0]?.u;
            if (first) return { u: first, won: false };
            if (!me.edit) return null;
            await c.query("INSERT INTO whiteboard_updates (board_id, u) VALUES ($1, $2)", [boardId, u]);
            return { u, won: true };
          }),
        );
        if (!out) return ack({ ok: false, reason: "forbidden" });
        if (out.won) socket.to(room(boardId)).emit("wb:update", { boardId, u: out.u });
        ack({ ok: true, u: out.u });
      }),
    );

    socket.on(
      "wb:update",
      safe(async (m) => {
        const me = isId(m.boardId) ? joined.get(m.boardId) : undefined;
        const u = bytes(m.u, MAX_UPDATE);
        // Viewers' and oversized updates are dropped, not relayed: nobody sees an edit that was not allowed.
        if (!me?.edit || !u) return;
        const boardId = m.boardId as string;
        // Stored before it is relayed: someone joining in between reads it from the draft instead of missing it.
        await this.db(p, async (c) => {
          await c.query("INSERT INTO whiteboard_updates (board_id, u) VALUES ($1, $2)", [boardId, u]);
          await c.query(`UPDATE whiteboard_drafts SET expires_at = now() + interval '${KEEP}' WHERE board_id = $1 AND expires_at < now() + interval '23 hours'`, [boardId]);
        });
        socket.to(room(boardId)).emit("wb:update", { boardId, u });
        const n = (this.counts.get(boardId) ?? 0) + 1;
        this.counts.set(boardId, n);
        if (n >= COMPACT_AT) await this.compact(p, boardId);
      }),
    );

    socket.on("wb:aw", (m: { boardId?: unknown; u?: unknown }) => {
      const u = bytes(m?.u, MAX_AWARENESS);
      if (isId(m?.boardId) && joined.has(m.boardId) && u && underRate()) socket.to(room(m.boardId)).emit("wb:aw", { boardId: m.boardId, u });
    });

    const leave = async (boardId: string) => {
      const me = joined.get(boardId);
      joined.delete(boardId);
      await socket.leave(room(boardId));
      socket.to(room(boardId)).emit("wb:gone", { boardId, clientId: me?.clientId });
      if ((await this.io.in(room(boardId)).fetchSockets()).length > 0) return;
      this.counts.delete(boardId);
      await this.db(p, (c) => c.query(`UPDATE whiteboard_drafts SET expires_at = now() + interval '${KEEP}' WHERE board_id = $1`, [boardId]));
    };
    socket.on(
      "wb:leave",
      safe(async (m, ack) => {
        if (isId(m.boardId) && joined.has(m.boardId)) await leave(m.boardId);
        ack({ ok: true });
      }),
    );
    socket.on("disconnect", () => {
      for (const boardId of [...joined.keys()]) void leave(boardId).catch(() => undefined);
    });
  }

  /** Renews the drafts of boards someone still has open (the prune job calls this first; see Collab.renewOpen). */
  async renewOpen(): Promise<number> {
    const ids: string[] = [];
    for (const [name, sockets] of this.io.of("/").adapter.rooms) {
      const m = /^w:([^:]+)$/.exec(name);
      if (m && sockets.size) ids.push(m[1]!);
    }
    if (!ids.length) return 0;
    return runWithContext({ actorId: "service:collab", requestId: newId() }, () =>
      withTransaction(
        this.pool,
        async (c) => (await c.query(`UPDATE whiteboard_drafts SET expires_at = now() + interval '${KEEP}' WHERE board_id = ANY($1::text[])`, [ids])).rowCount ?? 0,
      ),
    );
  }

  /** Folds the stored updates into one, so joining stays one small read however long a session runs. */
  private async compact(p: Principal, boardId: string) {
    this.counts.set(boardId, 1);
    await this.serial(boardId, () =>
      this.db(p, async (c) => {
        const all = (await c.query<{ seq: string; u: Buffer }>("SELECT seq, u FROM whiteboard_updates WHERE board_id = $1 ORDER BY seq", [boardId])).rows;
        if (all.length < 2) return;
        const merged = Buffer.from(Y.mergeUpdates(all.map((r) => new Uint8Array(r.u))));
        // Replace exactly what was merged; updates stored meanwhile stay (Yjs updates apply in any order).
        await c.query("DELETE FROM whiteboard_updates WHERE board_id = $1 AND seq = ANY($2::bigint[])", [boardId, all.map((r) => r.seq)]);
        await c.query("INSERT INTO whiteboard_updates (board_id, u) VALUES ($1, $2)", [boardId, merged]);
      }),
    );
  }
}

/** Deletes whiteboard drafts nobody reopened within a day (chat's `collab-prune` job), in batches. */
export async function pruneWhiteboardDrafts(pool: Pool, batch = 1000, maxBatches = 50): Promise<number> {
  let total = 0;
  for (let i = 0; i < maxBatches; i++) {
    const n =
      (await pool.query("DELETE FROM whiteboard_drafts WHERE board_id IN (SELECT board_id FROM whiteboard_drafts WHERE expires_at < now() ORDER BY expires_at LIMIT $1)", [batch]))
        .rowCount ?? 0;
    total += n;
    if (n < batch) break;
  }
  return total;
}
