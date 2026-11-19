import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { io as ioClient, type Socket } from "socket.io-client";
import pg from "pg";
import * as Y from "yjs";
import { clearInProcess, serveInProcess, signInternalToken, verifyInternalToken, PRINCIPAL_HEADER } from "@workspace/service-kit";
import { newId, withTransaction, type Principal } from "@workspace/shared";
import { createChatApp, depsFromEnv } from "../../src/modules/chat/app.js";
import { pruneWhiteboardDrafts } from "../../src/modules/chat/whiteboard-collab.js";
import type { Realtime } from "../../src/modules/chat/realtime.js";

/**
 * Live whiteboards (whiteboard-collab.ts): the room shares one Yjs document (a map of elements by id); work (faked
 * here) decides who may watch and who may edit; the relay stores the updates as a draft kept a day.
 */
const SECRET = "dev-internal-secret-change-me-32bytes!";
const user = (id: string): Principal => ({ type: "user", id, teamIds: [], departmentId: null, grants: [] });
const BOARD = newId();
const boards: Record<string, { editors: string[]; viewers: string[] }> = { [BOARD]: { editors: ["minh", "lan"], viewers: ["huy"] } };

let server: { url: string; close: () => Promise<void> };
let rt: Realtime;
const sockets: Socket[] = [];
const pool = new pg.Pool({ connectionString: process.env.CHAT_DATABASE_URL ?? "postgres://workspace_chat:app_pw@localhost:5432/workspace_test", max: 2 });
const db = <R>(fn: (c: pg.PoolClient) => Promise<R>) => withTransaction(pool, fn);
const stored = () => db(async (c) => (await c.query<{ u: Buffer }>("SELECT u FROM whiteboard_updates WHERE board_id = $1 ORDER BY seq", [BOARD])).rows.map((r) => r.u));
const draftLeft = () =>
  db(
    async (c) =>
      (await c.query<{ left: number }>("SELECT extract(epoch FROM expires_at - now())::int AS left FROM whiteboard_drafts WHERE board_id = $1", [BOARD])).rows[0]?.left ?? null,
  );

beforeAll(async () => {
  const workUrl = "http://work.invalid/work";
  serveInProcess(workUrl, async (req, res) => {
    const m = req.url?.match(/^\/internal\/whiteboards\/([^/]+)\/access$/);
    if (!m) return void res.writeHead(404).end();
    const { principal } = await verifyInternalToken(String(req.headers[PRINCIPAL_HEADER]), SECRET);
    const b = boards[m[1]!];
    const edit = !!b?.editors.includes(principal.id);
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ view: edit || !!b?.viewers.includes(principal.id), edit }));
  });
  const { app, listen, realtime } = await createChatApp({ ...depsFromEnv(), workUrl });
  rt = realtime;
  server = { url: `http://127.0.0.1:${await listen(0)}`, close: () => app.close() };
});

afterAll(async () => {
  sockets.forEach((s) => s.disconnect());
  await server?.close();
  clearInProcess();
  await pool.end();
});

async function connect(id: string) {
  const socket = ioClient(server.url, {
    auth: { ticket: await signInternalToken({ principal: user(id), requestId: newId() }, SECRET) },
    transports: ["websocket"],
    forceNew: true,
  });
  sockets.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", () => resolve());
    socket.once("connect_error", reject);
  });
  return socket;
}

const ask = (s: Socket, event: string, data: unknown): Promise<any> => s.timeout(5000).emitWithAck(event, data);
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (pred: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await pause(25);
  }
};

/** A browser's copy of the board: joins, seeds from the snapshot when the room is empty, applies what others send. */
async function client(id: string, snapshot: Record<string, unknown>) {
  const s = await connect(id);
  const doc = new Y.Doc();
  const elements = doc.getMap<Record<string, unknown>>("elements");
  s.on("wb:update", (m: { u: ArrayBuffer }) => Y.applyUpdate(doc, new Uint8Array(m.u), "remote"));
  const r = await ask(s, "wb:join", { boardId: BOARD, clientId: doc.clientID });
  expect(r.ok).toBe(true);
  for (const u of r.updates as ArrayBuffer[]) Y.applyUpdate(doc, new Uint8Array(u), "remote");
  if (!r.updates.length) {
    const seed = new Y.Doc();
    for (const [k, v] of Object.entries(snapshot)) seed.getMap("elements").set(k, v);
    const won = await ask(s, "wb:seed", { boardId: BOARD, u: Y.encodeStateAsUpdate(seed) });
    if (won.ok) Y.applyUpdate(doc, new Uint8Array(won.u), "remote");
  }
  doc.on("update", (u: Uint8Array, origin: unknown) => origin !== "remote" && s.emit("wb:update", { boardId: BOARD, u }));
  return { s, doc, elements, canEdit: r.canEdit as boolean, ids: () => [...elements.keys()].sort() };
}

describe("whiteboard relay", () => {
  it("refuses people who cannot open the board and drops viewers' edits", async () => {
    const out = await connect("outsider");
    expect(await ask(out, "wb:join", { boardId: BOARD, clientId: 1 })).toEqual({ ok: false, reason: "forbidden" });
    expect(await ask(out, "wb:join", { boardId: "../x", clientId: 1 })).toEqual({ ok: false, reason: "bad" });
    // Not joined: nothing is stored or relayed.
    out.emit("wb:update", { boardId: BOARD, u: new Uint8Array([0, 0]) });
    await pause(200);
    expect(await stored()).toHaveLength(0);

    // A viewer may join (to watch) but cannot start the shared document nor change it.
    const v = await client("huy", { a: { id: "a", version: 1 } });
    expect(v.canEdit).toBe(false);
    expect(await ask(v.s, "wb:seed", { boardId: BOARD, u: new Uint8Array([1, 2, 3]) })).toEqual({ ok: false, reason: "forbidden" });
    v.elements.set("vandal", { id: "vandal", version: 1 });
    await pause(200);
    expect(await stored()).toHaveLength(0);
    await ask(v.s, "wb:leave", { boardId: BOARD });
    v.s.disconnect();
  });

  it("two editors draw on one board, a viewer watches, a late joiner gets everything", async () => {
    // The viewer is there first: it receives the editors' seed when it is made.
    const watcher = await client("huy", {});
    const [a, b] = await Promise.all([client("minh", { s1: { id: "s1", version: 1 } }), client("lan", { s1: { id: "s1", version: 1 } })]);
    await until(() => a.ids().join() === "s1" && b.ids().join() === "s1" && watcher.ids().join() === "s1");
    a.elements.set("m1", { id: "m1", version: 1, text: "Minh" });
    b.elements.set("l1", { id: "l1", version: 1, text: "Lan" });
    await until(() => [a, b, watcher].every((c) => c.ids().join() === "l1,m1,s1"));

    // Cursors reach the others (viewers too), relayed only.
    const seen: unknown[] = [];
    a.s.on("wb:aw", (m) => seen.push(m));
    watcher.s.emit("wb:aw", { boardId: BOARD, u: new Uint8Array([7]) });
    await until(() => seen.length === 1);

    const late = await client("lan", { other: { id: "other", version: 1 } });
    expect(late.ids()).toEqual(["l1", "m1", "s1"]);

    // Leaving tells the room whose cursor to drop; the draft is kept a day after the last one goes.
    const gone: { clientId: number }[] = [];
    a.s.on("wb:gone", (m) => gone.push(m));
    await ask(late.s, "wb:leave", { boardId: BOARD });
    await until(() => gone.length === 1);
    expect(gone[0]!.clientId).toBe(late.doc.clientID);
    for (const c of [a, b, watcher, late]) c.s.disconnect();
    await pause(300);
    expect((await stored()).length).toBeGreaterThan(0);
    expect(await draftLeft()).toBeGreaterThan(24 * 3600 - 60);
  });

  it("keeps open boards' drafts and prunes the ones nobody reopened within a day", async () => {
    const a = await client("minh", {});
    expect(a.ids()).toEqual(["l1", "m1", "s1"]);
    await db((c) => c.query("UPDATE whiteboard_drafts SET expires_at = now() - interval '1 minute' WHERE board_id = $1", [BOARD]));
    expect(await rt.whiteboards!.renewOpen()).toBeGreaterThanOrEqual(1);
    await pruneWhiteboardDrafts(pool);
    expect(await draftLeft()).toBeGreaterThan(24 * 3600 - 60);
    a.s.disconnect();
    await pause(300);
    await db((c) => c.query("UPDATE whiteboard_drafts SET expires_at = now() - interval '1 minute' WHERE board_id = $1", [BOARD]));
    expect(await pruneWhiteboardDrafts(pool)).toBe(1);
    expect(await stored()).toHaveLength(0);
  });

  it("compacts a long session into one stored update with the same content", async () => {
    const a = await client("minh", {});
    for (let i = 0; i < 450; i++) a.elements.set(`e${i % 20}`, { id: `e${i % 20}`, version: i });
    const content = async () => {
      const copy = new Y.Doc();
      const all = await stored();
      for (const u of all) Y.applyUpdate(copy, new Uint8Array(u));
      return { n: all.length, v: (copy.getMap("elements").get("e9") as { version?: number } | undefined)?.version };
    };
    const end = Date.now() + 10_000;
    let last = await content();
    while (last.v !== 449 && Date.now() < end) {
      await pause(100);
      last = await content();
    }
    expect(last.v).toBe(449);
    expect(last.n).toBeLessThan(100);
    a.s.disconnect();
  });
});
