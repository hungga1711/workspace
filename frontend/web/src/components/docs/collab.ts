"use client";

import { generateJSON, getSchema, type AnyExtension } from "@tiptap/core";
import Collaboration from "@tiptap/extension-collaboration";
import CollaborationCursor from "@tiptap/extension-collaboration-cursor";
import { prosemirrorJSONToYXmlFragment } from "y-prosemirror";
import { applyAwarenessUpdate, Awareness, encodeAwarenessUpdate, removeAwarenessStates } from "y-protocols/awareness";
import * as Y from "yjs";
import type { Socket } from "socket.io-client";
import { connectRealtime, releaseRealtime } from "@/lib/realtime";
import { pageExtensions } from "./RichEditor";

/**
 * Live co-editing of a page (a shared draft), loaded only when someone presses "Sửa".
 * The draft is a Yjs document relayed and kept by the chat module (see backend/server/src/modules/chat/collab.ts)
 * over the app's shared realtime connection (lib/realtime.ts). The first person in seeds the draft
 * from the published page; everyone after gets what is stored. Local changes go out in small batches.
 */
type Handler = NonNullable<Parameters<Socket["off"]>[1]>;

export interface Peer {
  id: string;
  name: string;
  color: string;
}
export interface LiveSession {
  extensions: AnyExtension[];
  /** A draft someone left unpublished was picked up again. */
  resumed: boolean;
  title: () => string;
  setTitle: (title: string) => void;
  /** Tells the others a new version is out (they stay in the editor on it). */
  published: (version: number, title: string) => void;
  /** Leaves; with discard, the draft is dropped when nobody else is in it. */
  close: (discard: boolean) => Promise<void>;
}
export interface LiveEvents {
  onPeers: (peers: Peer[]) => void;
  onTitle: (title: string) => void;
  onPublished: (e: { version: number; title: string; by: string }) => void;
  onConnection: (online: boolean) => void;
  /** The page moved on outside the session (a restore, say): reload it before editing. */
  onStale: () => void;
}

// Design-token colours (the label text is white on them); one per person, picked from their id.
const COLORS = ["var(--sky-text)", "var(--violet-text)", "var(--tangerine-text)", "var(--rose-text)", "var(--accent-text)", "var(--ok)", "var(--brand-text)"];
const colorFor = (id: string) => COLORS[[...id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % COLORS.length]!;

const REMOTE = "remote";
const withTimeout = <T>(p: Promise<T>, ms: number) => Promise.race([p, new Promise<never>((_, no) => setTimeout(() => no(new Error("timeout")), ms))]);

/** The draft's first state: the published page (and its title) as a fresh Yjs document. */
function seedFrom(html: string, title: string): Uint8Array {
  const exts = pageExtensions({ editable: true, placeholder: "" });
  const doc = new Y.Doc();
  prosemirrorJSONToYXmlFragment(getSchema(exts), generateJSON(html || "<p></p>", exts), doc.getXmlFragment("default"));
  doc.getMap("meta").set("title", title);
  return Y.encodeStateAsUpdate(doc);
}

type JoinReply = { ok: true; updates: ArrayBuffer[]; resumed: boolean } | { ok: false; reason: string; version?: number };

/**
 * Opens the shared draft, or answers why not: "stale" (reload the page first) or null when live editing
 * is unavailable (no connection within a few seconds): the caller then edits on its own, as before.
 */
export async function openLive(
  opts: { docId: string; version: number; html: string; title: string; me: { id: string; name: string } },
  events: LiveEvents,
): Promise<LiveSession | "stale" | null> {
  const doc = new Y.Doc();
  const awareness = new Awareness(doc);
  let version = opts.version;
  const socket = await connectRealtime();
  // The connection is shared with chat and calls: everything this session adds to it is taken off again on close.
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
  const join = async () => {
    const r = (await withTimeout(socket.timeout(5000).emitWithAck("doc:join", { docId: opts.docId, version, clientId: doc.clientID }), 6000)) as JoinReply;
    if (!r.ok) return r;
    Y.transact(doc, () => r.updates.forEach((u) => Y.applyUpdate(doc, new Uint8Array(u))), REMOTE);
    return r;
  };

  // Reconnecting: join again (picking up what was missed) and send everything this copy has.
  const rejoin = () =>
    join()
      .then((r) => {
        if (!r.ok) return r.reason === "stale" ? events.onStale() : events.onConnection(false);
        socket.emit("doc:update", { docId: opts.docId, u: Y.encodeStateAsUpdate(doc) });
        socket.emit("doc:aw", { docId: opts.docId, u: encodeAwarenessUpdate(awareness, [doc.clientID]) });
        events.onConnection(true);
      })
      .catch(() => events.onConnection(false));

  let first: JoinReply;
  try {
    if (!socket.connected)
      await withTimeout(
        new Promise<void>((resolve, reject) => {
          socket.once("connect", () => resolve());
          socket.once("connect_error", reject);
        }),
        2500,
      );
    first = await join();
  } catch {
    fail();
    return null;
  }
  if (!first.ok) {
    fail();
    return first.reason === "stale" ? "stale" : null;
  }
  if (!first.updates.length) {
    // Several people may arrive at once: the server keeps the first seed and hands it to everyone.
    try {
      const won = (await socket.timeout(5000).emitWithAck("doc:seed", { docId: opts.docId, u: seedFrom(opts.html, opts.title) })) as { ok: boolean; u: ArrayBuffer };
      if (!won.ok) throw new Error("seed");
      Y.applyUpdate(doc, new Uint8Array(won.u), REMOTE);
    } catch {
      fail();
      return null;
    }
  }

  // Outgoing: this person's changes, batched (one message per ~50 ms of typing).
  let queue: Uint8Array[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = () => {
    timer = undefined;
    if (!queue.length || !socket.connected) return;
    socket.emit("doc:update", { docId: opts.docId, u: queue.length === 1 ? queue[0] : Y.mergeUpdates(queue) });
    queue = [];
  };
  doc.on("update", (u: Uint8Array, origin: unknown) => {
    if (origin === REMOTE) return;
    queue.push(u);
    timer ??= setTimeout(flush, 50);
  });

  // Incoming.
  on("doc:update", (m: { docId: string; u: ArrayBuffer }) => m.docId === opts.docId && Y.applyUpdate(doc, new Uint8Array(m.u), REMOTE));
  on("doc:aw", (m: { docId: string; u: ArrayBuffer }) => m.docId === opts.docId && applyAwarenessUpdate(awareness, new Uint8Array(m.u), REMOTE));
  on("doc:hello", (m: { docId: string }) => {
    if (m.docId === opts.docId && awareness.getLocalState()) socket.emit("doc:aw", { docId: opts.docId, u: encodeAwarenessUpdate(awareness, [doc.clientID]) });
  });
  on("doc:gone", (m: { docId: string; clientId?: number }) => {
    if (m.docId === opts.docId && typeof m.clientId === "number") removeAwarenessStates(awareness, [m.clientId], REMOTE);
  });
  on("doc:published", (m: { docId: string; version: number; title: string; by: string }) => {
    if (m.docId !== opts.docId) return;
    version = m.version;
    events.onPublished(m);
  });
  awareness.on("update", ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
    if (origin !== REMOTE && socket.connected) socket.emit("doc:aw", { docId: opts.docId, u: encodeAwarenessUpdate(awareness, [...added, ...updated, ...removed]) });
  });
  awareness.on("change", () => {
    const seen = new Map<string, Peer>();
    awareness.getStates().forEach((s, clientId) => {
      const u = (s as { user?: Peer }).user;
      if (u && clientId !== doc.clientID && u.id !== opts.me.id) seen.set(u.id, u);
    });
    events.onPeers([...seen.values()]);
  });
  const meta = doc.getMap<string>("meta");
  meta.observe((e) => {
    if (e.transaction.origin === REMOTE) events.onTitle(meta.get("title") ?? "");
  });

  // Reconnecting: join again (rejoin above).
  on("disconnect", () => events.onConnection(false));
  socket.io.on("reconnect", onReconnect);

  const me: Peer = { id: opts.me.id, name: opts.me.name, color: colorFor(opts.me.id) };
  return {
    resumed: first.resumed,
    extensions: [Collaboration.configure({ document: doc }), CollaborationCursor.configure({ provider: { awareness }, user: me })],
    title: () => meta.get("title") ?? opts.title,
    setTitle: (t) => meta.set("title", t),
    published: (v, title) => {
      version = v;
      socket.emit("doc:published", { docId: opts.docId, version: v, title });
    },
    close: async (discard) => {
      if (timer) {
        clearTimeout(timer);
        flush();
      }
      awareness.setLocalState(null);
      await withTimeout(socket.timeout(1500).emitWithAck("doc:leave", { docId: opts.docId, discard }), 2000).catch(() => undefined);
      fail();
    },
  };
}
