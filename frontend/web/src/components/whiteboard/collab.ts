"use client";

import { applyAwarenessUpdate, Awareness, encodeAwarenessUpdate, removeAwarenessStates } from "y-protocols/awareness";
import * as Y from "yjs";
import type { Socket } from "socket.io-client";
import { connectRealtime, releaseRealtime } from "@/lib/realtime";
import { peerColor } from "./palette";
import { newer } from "./scene";
import type { SceneElement, SceneFile } from "./types";

/**
 * Live editing of one whiteboard, mirroring the docs draft (components/docs/collab.ts): a Yjs document relayed and
 * kept a day by the chat module over the app's shared realtime connection. The document holds two maps: "elements"
 * (element id → the element's JSON) and "files" (image id → where its bytes are). The first person in seeds it from
 * the saved scene; everyone after gets what is stored. Durability is still the REST snapshot (any editor saves it).
 *
 *   wb:join {boardId, clientId} → {ok, updates[]} | {ok:false, reason}     (view or edit, checked by the work module)
 *   wb:seed {boardId, u}  → the seed everyone uses       wb:update {boardId, u}  edit only, stored and relayed
 *   wb:aw {boardId, u}    awareness, relayed only        wb:leave {boardId}
 */
type Handler = NonNullable<Parameters<Socket["off"]>[1]>;

export interface LivePeer {
  /** The Yjs client id: one per open tab (the same person in two tabs is two cursors). */
  clientId: number;
  id: string;
  name: string;
  color: string;
  pointer?: { x: number; y: number; tool: "pointer" | "laser" };
  button?: "up" | "down";
  selected?: Record<string, true>;
}
export interface LiveEvents {
  /** Elements and files someone else changed. */
  onRemote: (elements: SceneElement[], files: SceneFile[]) => void;
  onPeers: (peers: LivePeer[]) => void;
  onConnection: (online: boolean) => void;
}
export interface LiveBoard {
  /** What the room holds after joining (the seed, or everything people did since). */
  elements: SceneElement[];
  files: SceneFile[];
  /** Sends this person's changed elements (only those newer than what the room has). */
  push: (elements: readonly SceneElement[], files?: readonly SceneFile[]) => void;
  /** Cursor, button and selection for the others. */
  presence: (p: Pick<LivePeer, "pointer" | "button" | "selected">) => void;
  close: () => Promise<void>;
}

const REMOTE = "remote";
const withTimeout = <T>(p: Promise<T>, ms: number) => Promise.race([p, new Promise<never>((_, no) => setTimeout(() => no(new Error("timeout")), ms))]);
type JoinReply = { ok: true; updates: ArrayBuffer[] } | { ok: false; reason: string };

/** The room's first state: the saved scene as a fresh Yjs document. */
export function seedUpdate(elements: readonly SceneElement[], files: readonly SceneFile[]): Uint8Array {
  const doc = new Y.Doc();
  doc.transact(() => {
    const els = doc.getMap<SceneElement>("elements");
    for (const e of elements) els.set(e.id, e);
    const fs = doc.getMap<SceneFile>("files");
    for (const f of files) fs.set(f.id, f);
  });
  const u = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return u;
}

/**
 * Joins the board's room, or answers null when live editing is unavailable (no connection within a few seconds, no
 * access): the board then works on its own and still saves.
 */
export async function openBoardLive(
  opts: { boardId: string; canEdit: boolean; me: { id: string; name: string }; elements: readonly SceneElement[]; files: readonly SceneFile[] },
  events: LiveEvents,
): Promise<LiveBoard | null> {
  const doc = new Y.Doc();
  const awareness = new Awareness(doc);
  const els = doc.getMap<SceneElement>("elements");
  const fls = doc.getMap<SceneFile>("files");
  const room = { boardId: opts.boardId };
  const socket = await connectRealtime();
  const listeners: [string, Handler][] = [];
  const on = (event: string, fn: Handler) => {
    socket.on(event, fn);
    listeners.push([event, fn]);
  };
  const onReconnect = () => void rejoin();
  let closed = false;
  const fail = () => {
    if (closed) return;
    closed = true;
    for (const [event, fn] of listeners) socket.off(event, fn);
    socket.io.off("reconnect", onReconnect);
    releaseRealtime();
    awareness.destroy();
    doc.destroy();
  };
  let unsynced = false;
  const join = async () => {
    const r = (await withTimeout(socket.timeout(5000).emitWithAck("wb:join", { ...room, clientId: doc.clientID }), 6000)) as JoinReply;
    if (r.ok) Y.transact(doc, () => r.updates.forEach((u) => Y.applyUpdate(doc, new Uint8Array(u))), REMOTE);
    return r;
  };
  const rejoin = () =>
    join()
      .then((r) => {
        if (!r.ok) return events.onConnection(false);
        // Whatever this copy did while away goes back to the room.
        if (opts.canEdit) socket.emit("wb:update", { ...room, u: Y.encodeStateAsUpdate(doc) });
        socket.emit("wb:aw", { ...room, u: encodeAwarenessUpdate(awareness, [doc.clientID]) });
        events.onConnection(true);
      })
      .catch(() => events.onConnection(false));

  try {
    if (!socket.connected)
      await withTimeout(
        new Promise<void>((resolve, reject) => {
          socket.once("connect", () => resolve());
          socket.once("connect_error", reject);
        }),
        2500,
      );
    const first = await join();
    if (!first.ok) {
      fail();
      return null;
    }
    // A viewer alone in an empty room has nothing to build on: the first change relayed to it fetches the room.
    unsynced = !first.updates.length && !opts.canEdit;
    if (!first.updates.length && opts.canEdit) {
      // Several people may arrive at once: the server keeps the first seed and hands it to everyone.
      const won = (await socket.timeout(5000).emitWithAck("wb:seed", { ...room, u: seedUpdate(opts.elements, opts.files) })) as { ok: boolean; u: ArrayBuffer };
      if (!won.ok) throw new Error("seed");
      Y.applyUpdate(doc, new Uint8Array(won.u), REMOTE);
    }
  } catch {
    fail();
    return null;
  }

  // Outgoing: this person's changes, batched (one message per ~50 ms of drawing).
  let queue: Uint8Array[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = () => {
    timer = undefined;
    if (!queue.length || !socket.connected) return;
    socket.emit("wb:update", { ...room, u: queue.length === 1 ? queue[0] : Y.mergeUpdates(queue) });
    queue = [];
  };
  doc.on("update", (u: Uint8Array, origin: unknown) => {
    if (origin === REMOTE || !opts.canEdit) return;
    queue.push(u);
    timer ??= setTimeout(flush, 50);
  });

  // Incoming: hand over only what changed.
  els.observe((e) => {
    if (e.transaction.origin !== REMOTE) return;
    const changed: SceneElement[] = [];
    e.keysChanged.forEach((k) => {
      const v = els.get(k);
      if (v) changed.push(v);
    });
    if (changed.length) events.onRemote(changed, []);
  });
  fls.observe((e) => {
    if (e.transaction.origin !== REMOTE) return;
    const changed: SceneFile[] = [];
    e.keysChanged.forEach((k) => {
      const v = fls.get(k);
      if (v) changed.push(v);
    });
    if (changed.length) events.onRemote([], changed);
  });
  on("wb:update", (m: { boardId: string; u: ArrayBuffer }) => {
    if (m.boardId !== opts.boardId) return;
    Y.applyUpdate(doc, new Uint8Array(m.u), REMOTE);
    if (unsynced) {
      unsynced = false;
      void join().catch(() => undefined);
    }
  });
  on("wb:aw", (m: { boardId: string; u: ArrayBuffer }) => m.boardId === opts.boardId && applyAwarenessUpdate(awareness, new Uint8Array(m.u), REMOTE));
  // Someone arrived: tell them who is here (their awareness starts empty).
  on("wb:hello", (m: { boardId: string }) => {
    if (m.boardId === opts.boardId && awareness.getLocalState()) socket.emit("wb:aw", { ...room, u: encodeAwarenessUpdate(awareness, [doc.clientID]) });
  });
  on("wb:gone", (m: { boardId: string; clientId?: number }) => {
    if (m.boardId === opts.boardId && typeof m.clientId === "number") removeAwarenessStates(awareness, [m.clientId], REMOTE);
  });
  awareness.on("update", ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
    if (origin !== REMOTE && socket.connected) socket.emit("wb:aw", { ...room, u: encodeAwarenessUpdate(awareness, [...added, ...updated, ...removed]) });
  });
  awareness.on("change", () => {
    const peers: LivePeer[] = [];
    awareness.getStates().forEach((s, clientId) => {
      const st = s as Partial<LivePeer> & { user?: { id: string; name: string; color: string } };
      if (clientId === doc.clientID || !st.user) return;
      peers.push({ clientId, ...st.user, pointer: st.pointer, button: st.button, selected: st.selected });
    });
    events.onPeers(peers);
  });
  on("disconnect", () => events.onConnection(false));
  socket.io.on("reconnect", onReconnect);

  const user = { id: opts.me.id, name: opts.me.name, color: peerColor(opts.me.id) };
  awareness.setLocalState({ user });
  let awTimer: ReturnType<typeof setTimeout> | undefined;
  let awNext: Pick<LivePeer, "pointer" | "button" | "selected"> | null = null;

  return {
    elements: [...els.values()],
    files: [...fls.values()],
    push: (elements, files = []) => {
      if (!opts.canEdit || closed) return;
      doc.transact(() => {
        for (const e of elements) {
          const have = els.get(e.id);
          // `newer` keeps the room's copy on a tie, so an echo of what the room already has is never sent back.
          if (!have || newer(have, e) === e) els.set(e.id, e);
        }
        for (const f of files) if (!fls.has(f.id)) fls.set(f.id, f);
      });
    },
    presence: (p) => {
      // Pointer moves arrive at frame rate; the others get at most ~20 a second.
      awNext = { ...awNext, ...p };
      awTimer ??= setTimeout(() => {
        awTimer = undefined;
        if (!closed && awNext) awareness.setLocalState({ user, ...awNext });
      }, 50);
    },
    close: async () => {
      if (timer) {
        clearTimeout(timer);
        flush();
      }
      clearTimeout(awTimer);
      awareness.setLocalState(null);
      await withTimeout(socket.timeout(1500).emitWithAck("wb:leave", room), 2000).catch(() => undefined);
      fail();
    },
  };
}
