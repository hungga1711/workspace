import type { Server, Socket } from "socket.io";
import type { Pool, PoolClient } from "pg";
import * as Y from "yjs";
import { newId, runWithContext, withTransaction, type Principal } from "@workspace/shared";
import { logger, PRINCIPAL_HEADER, serviceFetch, signInternalToken } from "@workspace/service-kit";

/**
 * Live co-editing of a docs page: a shared draft. The draft is a Yjs document kept in Postgres (collab_drafts,
 * collab_updates) as a list of updates (the first one seeds it from the published HTML); the server only relays,
 * stores and compacts them, so it never needs the editor schema. Rooms are joined only after the work module says
 * the caller may edit the page, never from client input alone.
 *
 *   doc:join {docId, version, clientId}  → {ok, updates[], base} | {ok:false, reason}
 *   doc:seed {docId, u}                   → the seed everyone uses (the first one sent wins)
 *   doc:update {docId, u}                 stored, relayed to the room
 *   doc:aw {docId, u}                     awareness (cursors, names): relayed only
 *   doc:published {docId, version, title} relayed; the draft's base moves to that version
 *   doc:leave {docId, discard}            the last one out with "discard" drops the draft
 *
 * A draft nobody has open is kept for a day, so closing the tab does not lose unpublished work (or a restart);
 * chat's `collab-prune` job deletes it after that.
 */
const KEEP = "24 hours";
const MAX_UPDATE = 512 * 1024;
const COMPACT_AT = 400;

const docRoom = (docId: string) => `d:${docId}`;

type Ack = (r: unknown) => void;
const isId = (v: unknown): v is string => typeof v === "string" && /^[0-9A-Za-z_-]{10,40}$/.test(v);
const bytes = (v: unknown): Buffer | null => {
  if (Buffer.isBuffer(v)) return v.length <= MAX_UPDATE ? v : null;
  if (v instanceof ArrayBuffer || ArrayBuffer.isView(v)) {
    const b = Buffer.from(v instanceof ArrayBuffer ? v : v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength));
    return b.length <= MAX_UPDATE ? b : null;
  }
  return null;
};

export class Collab {
  /** Updates stored per draft since it was last compacted (approximate; compaction recounts). */
  private readonly counts = new Map<string, number>();
  /** One seed or compaction per draft at a time (the server is one process, so a promise chain is the lock). */
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

  /** May this person edit the page, and which version is published (the work module decides). */
  private async access(p: Principal, docId: string): Promise<{ canEdit: boolean; version: number } | null> {
    const res = await serviceFetch(`${this.cfg.workUrl}/docs/${docId}/collab`, {
      signal: AbortSignal.timeout(5000),
      headers: { [PRINCIPAL_HEADER]: await signInternalToken({ principal: p, requestId: newId() }, this.cfg.internalSecret) },
    });
    return res.ok ? ((await res.json()) as { canEdit: boolean; version: number }) : null;
  }

  /** Called synchronously on connection, so events sent right after connecting are not missed. */
  attach(socket: Socket) {
    const p = socket.data.principal as Principal;
    // docId → this socket's Yjs client id, to clear its cursor for the others when it goes.
    const joined = new Map<string, number>();
    const inRoom = (docId: unknown): docId is string => isId(docId) && joined.has(docId);
    const safe = (fn: (m: Record<string, unknown>, ack: Ack) => Promise<void>) => (m: unknown, ack?: unknown) => {
      const reply: Ack = typeof ack === "function" ? (ack as Ack) : () => undefined;
      fn((m ?? {}) as Record<string, unknown>, reply).catch((err) => {
        logger.warn({ err }, "collab event failed");
        reply({ ok: false, reason: "error" });
      });
    };

    socket.on(
      "doc:join",
      safe(async (m, ack) => {
        const { docId, version, clientId } = m;
        if (!isId(docId) || typeof version !== "number" || typeof clientId !== "number") return ack({ ok: false, reason: "bad" });
        const a = await this.access(p, docId);
        if (!a?.canEdit) return ack({ ok: false, reason: "forbidden" });
        if (a.version !== version) return ack({ ok: false, reason: "stale", version: a.version });
        const room = docRoom(docId);
        const alone = (await this.io.in(room).fetchSockets()).length === 0;
        const updates = await this.db(p, async (c) => {
          const base = (await c.query<{ base_version: number }>("SELECT base_version FROM collab_drafts WHERE doc_id = $1", [docId])).rows[0]?.base_version;
          // A draft started from an older version (published or restored since, outside the session) is dropped.
          if (base !== undefined && base !== a.version && alone) await c.query("DELETE FROM collab_updates WHERE doc_id = $1", [docId]);
          await c.query(
            `INSERT INTO collab_drafts (doc_id, base_version, expires_at) VALUES ($1, $2, now() + interval '${KEEP}')
             ON CONFLICT (doc_id) DO UPDATE SET base_version = EXCLUDED.base_version, expires_at = EXCLUDED.expires_at`,
            [docId, a.version],
          );
          return (await c.query<{ u: Buffer }>("SELECT u FROM collab_updates WHERE doc_id = $1 ORDER BY seq", [docId])).rows.map((r) => r.u);
        });
        this.counts.set(docId, updates.length);
        await socket.join(room);
        joined.set(docId, clientId);
        socket.to(room).emit("doc:hello", { docId });
        ack({ ok: true, updates, resumed: alone && updates.length > 1 });
      }),
    );

    socket.on(
      "doc:seed",
      safe(async (m, ack) => {
        const u = bytes(m.u);
        if (!inRoom(m.docId) || !u) return ack({ ok: false, reason: "bad" });
        const docId = m.docId;
        // The first seed wins: everyone starts from the same document.
        const seed = await this.serial(docId, () =>
          this.db(p, async (c) => {
            const first = (await c.query<{ u: Buffer }>("SELECT u FROM collab_updates WHERE doc_id = $1 ORDER BY seq LIMIT 1", [docId])).rows[0]?.u;
            if (first) return first;
            await c.query("INSERT INTO collab_updates (doc_id, u) VALUES ($1, $2)", [docId, u]);
            return u;
          }),
        );
        ack({ ok: true, u: seed });
      }),
    );

    socket.on(
      "doc:update",
      safe(async (m) => {
        const u = bytes(m.u);
        if (!inRoom(m.docId) || !u) return;
        const docId = m.docId;
        socket.to(docRoom(docId)).emit("doc:update", { docId, u });
        await this.db(p, async (c) => {
          await c.query("INSERT INTO collab_updates (doc_id, u) VALUES ($1, $2)", [docId, u]);
          // An open session keeps the draft alive, renewed at most once an hour rather than on every keystroke.
          await c.query(`UPDATE collab_drafts SET expires_at = now() + interval '${KEEP}' WHERE doc_id = $1 AND expires_at < now() + interval '23 hours'`, [docId]);
        });
        const k = docId;
        const n = (this.counts.get(k) ?? 0) + 1;
        this.counts.set(k, n);
        if (n >= COMPACT_AT) await this.compact(p, docId);
      }),
    );

    socket.on("doc:aw", (m: { docId?: unknown; u?: unknown }) => {
      const u = bytes(m?.u);
      if (inRoom(m?.docId) && u && u.length < 16 * 1024) socket.to(docRoom(m.docId)).emit("doc:aw", { docId: m.docId, u });
    });

    socket.on(
      "doc:published",
      safe(async (m) => {
        const { docId, version, title } = m;
        if (!inRoom(docId) || typeof version !== "number") return;
        // The draft now sits on the version just published (checked, not trusted).
        const a = await this.access(p, docId);
        if (a?.version !== version) return;
        await this.db(p, (c) => c.query(`UPDATE collab_drafts SET base_version = $2, expires_at = now() + interval '${KEEP}' WHERE doc_id = $1`, [docId, version]));
        socket.to(docRoom(docId)).emit("doc:published", { docId, version, title: typeof title === "string" ? title.slice(0, 300) : "", by: p.id });
      }),
    );

    const leave = async (docId: string, discard: boolean) => {
      const clientId = joined.get(docId);
      joined.delete(docId);
      const room = docRoom(docId);
      await socket.leave(room);
      socket.to(room).emit("doc:gone", { docId, clientId });
      if ((await this.io.in(room).fetchSockets()).length > 0) return;
      this.counts.delete(docId);
      await this.db(p, (c) =>
        discard
          ? c.query("DELETE FROM collab_drafts WHERE doc_id = $1", [docId])
          : c.query(`UPDATE collab_drafts SET expires_at = now() + interval '${KEEP}' WHERE doc_id = $1`, [docId]),
      );
    };
    socket.on(
      "doc:leave",
      safe(async (m, ack) => {
        if (inRoom(m.docId)) await leave(m.docId, m.discard === true);
        ack({ ok: true });
      }),
    );
    socket.on("disconnect", () => {
      for (const docId of [...joined.keys()]) void leave(docId, false).catch(() => undefined);
    });
  }

  /**
   * Renews the drafts someone still has open. A tab left open a day without typing is never renewed by doc:update,
   * and pruning its draft under it would lose what it types next (the updates' draft row is gone) and let the next
   * person seed a second copy of the page. The prune job calls this first.
   */
  async renewOpen(): Promise<number> {
    const docIds: string[] = [];
    for (const [room, sockets] of this.io.of("/").adapter.rooms) {
      const m = /^d:([^:]+)$/.exec(room);
      if (m && sockets.size) docIds.push(m[1]!);
    }
    if (!docIds.length) return 0;
    return runWithContext({ actorId: "service:collab", requestId: newId() }, () =>
      withTransaction(
        this.pool,
        async (c) => (await c.query(`UPDATE collab_drafts SET expires_at = now() + interval '${KEEP}' WHERE doc_id = ANY($1::text[])`, [docIds])).rowCount ?? 0,
      ),
    );
  }

  /** Folds the stored updates into one, so joining stays one small read however long a session runs. */
  private async compact(p: Principal, docId: string) {
    const k = docId;
    this.counts.set(k, 1);
    await this.serial(k, () =>
      this.db(p, async (c) => {
        const all = (await c.query<{ seq: string; u: Buffer }>("SELECT seq, u FROM collab_updates WHERE doc_id = $1 ORDER BY seq", [docId])).rows;
        if (all.length < 2) return;
        const merged = Buffer.from(Y.mergeUpdates(all.map((r) => new Uint8Array(r.u))));
        // Replace exactly what was merged; updates stored meanwhile stay (Yjs updates apply in any order).
        await c.query("DELETE FROM collab_updates WHERE doc_id = $1 AND seq = ANY($2::bigint[])", [docId, all.map((r) => r.seq)]);
        await c.query("INSERT INTO collab_updates (doc_id, u) VALUES ($1, $2)", [docId, merged]);
      }),
    );
  }
}

/** Deletes drafts nobody reopened within a day (chat's `collab-prune` job), in batches. */
export async function pruneCollabDrafts(pool: Pool, batch = 1000, maxBatches = 50): Promise<number> {
  let total = 0;
  for (let i = 0; i < maxBatches; i++) {
    const n = (await pool.query<{ n: number }>("SELECT chat_collab_prune($1) AS n", [batch])).rows[0]?.n ?? 0;
    total += n;
    if (n < batch) break;
  }
  return total;
}
