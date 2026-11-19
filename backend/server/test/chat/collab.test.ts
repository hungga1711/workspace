import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { io as ioClient, type Socket } from "socket.io-client";
import pg from "pg";
import * as Y from "yjs";
import { clearInProcess, serveInProcess, signInternalToken, verifyInternalToken, PRINCIPAL_HEADER } from "@workspace/service-kit";
import { newId, withTransaction, type Principal } from "@workspace/shared";
import { createChatApp, depsFromEnv } from "../../src/modules/chat/app.js";
import { pruneCollabDrafts } from "../../src/modules/chat/collab.js";
import type { Realtime } from "../../src/modules/chat/realtime.js";

/**
 * Live co-editing: people share one draft kept in Postgres (collab_drafts, collab_updates), so it survives the tab
 * and a restart; work (faked here) decides who may edit and which version is published.
 */
const SECRET = "dev-internal-secret-change-me-32bytes!";
const user = (id: string): Principal => ({ type: "user", id, teamIds: [], departmentId: null, grants: [] });
const DOC = newId();
const pages: Record<string, { version: number; editors: string[] }> = { [DOC]: { version: 3, editors: ["minh", "lan"] } };

let server: { url: string; close: () => Promise<void> };
let rt: Realtime;
const sockets: Socket[] = [];
const pool = new pg.Pool({ connectionString: process.env.CHAT_DATABASE_URL ?? "postgres://workspace_chat:app_pw@localhost:5432/workspace_test", max: 2 });
const db = <R>(fn: (c: pg.PoolClient) => Promise<R>) => withTransaction(pool, fn);
const stored = () => db(async (c) => (await c.query<{ u: Buffer }>("SELECT u FROM collab_updates WHERE doc_id = $1 ORDER BY seq", [DOC])).rows.map((r) => r.u));
const draft = () =>
  db(
    async (c) =>
      (
        await c.query<{ base: number; left: number }>("SELECT base_version AS base, extract(epoch FROM expires_at - now())::int AS left FROM collab_drafts WHERE doc_id = $1", [
          DOC,
        ])
      ).rows[0] ?? null,
  );

beforeAll(async () => {
  // Served in memory under a URL nothing listens on: chat must reach work through serviceFetch, as in the server
  // (where work's URL need not match INTERNAL_PORT).
  const workUrl = "http://work.invalid/work";
  serveInProcess(workUrl, async (req, res) => {
    const m = req.url?.match(/^\/docs\/([^/]+)\/collab$/);
    const page = m ? pages[m[1]!] : undefined;
    if (!page) return void res.writeHead(404).end();
    const { principal } = await verifyInternalToken(String(req.headers[PRINCIPAL_HEADER]), SECRET);
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ canEdit: page.editors.includes(principal.id), version: page.version }));
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
const until = async (pred: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 25));
  }
};

/** A browser-side copy of the draft: joins, seeds when empty, applies what others send. */
async function editor(id: string, seedText: string) {
  const s = await connect(id);
  const doc = new Y.Doc();
  s.on("doc:update", (m: { u: ArrayBuffer }) => Y.applyUpdate(doc, new Uint8Array(m.u), "remote"));
  const r = await ask(s, "doc:join", { docId: DOC, version: pages[DOC]!.version, clientId: doc.clientID });
  expect(r.ok).toBe(true);
  for (const u of r.updates as ArrayBuffer[]) Y.applyUpdate(doc, new Uint8Array(u), "remote");
  if (!r.updates.length) {
    const seed = new Y.Doc();
    seed.getText("t").insert(0, seedText);
    const won = await ask(s, "doc:seed", { docId: DOC, u: Y.encodeStateAsUpdate(seed) });
    Y.applyUpdate(doc, new Uint8Array(won.u), "remote");
  }
  doc.on("update", (u: Uint8Array, origin: unknown) => origin !== "remote" && s.emit("doc:update", { docId: DOC, u }));
  return { s, doc, text: () => doc.getText("t").toString() };
}

describe("collab", () => {
  it("refuses people who cannot edit, unknown pages and stale versions", async () => {
    const huy = await connect("huy");
    expect((await ask(huy, "doc:join", { docId: DOC, version: 3, clientId: 1 })).reason).toBe("forbidden");
    expect((await ask(huy, "doc:join", { docId: newId(), version: 1, clientId: 1 })).reason).toBe("forbidden");
    const minh = await connect("minh");
    expect(await ask(minh, "doc:join", { docId: DOC, version: 2, clientId: 1 })).toMatchObject({ ok: false, reason: "stale", version: 3 });
    // Not joined: updates are ignored, not stored.
    minh.emit("doc:update", { docId: DOC, u: new Uint8Array([0, 0]) });
    await new Promise((r) => setTimeout(r, 200));
    expect(await stored()).toHaveLength(0);
  });

  it("two people edit one draft; the first seed wins; a late joiner gets it all", async () => {
    // Both start from the published text at once: only one seed is kept, so it is never doubled.
    const [a, b] = await Promise.all([editor("minh", "Kế hoạch"), editor("lan", "Kế hoạch")]);
    await until(() => a.text() === "Kế hoạch" && b.text() === "Kế hoạch");
    a.doc.getText("t").insert(0, "[Minh] ");
    b.doc.getText("t").insert(b.text().length, " [Lan]");
    await until(() => a.text() === b.text() && a.text().includes("[Minh]") && a.text().includes("[Lan]"));
    expect(a.text()).toBe("[Minh] Kế hoạch [Lan]");

    const c = await editor("lan", "should not be used");
    expect(c.text()).toBe("[Minh] Kế hoạch [Lan]");

    // Minh publishes version 4: the others hear it, and the draft now sits on 4.
    const heard: unknown[] = [];
    b.s.on("doc:published", (m) => heard.push(m));
    pages[DOC]!.version = 4;
    a.s.emit("doc:published", { docId: DOC, version: 4, title: "Kế hoạch Q4" });
    await until(() => heard.length === 1);
    expect(heard[0]).toMatchObject({ version: 4, title: "Kế hoạch Q4", by: "minh" });
    await until(() => false, 200).catch(() => undefined);
    expect((await draft())?.base).toBe(4);

    // Closing the tab keeps the draft for a day; the last one choosing "discard" drops it.
    c.s.disconnect();
    b.s.disconnect();
    await until(() => false, 300).catch(() => undefined);
    expect((await stored()).length).toBeGreaterThan(0);
    expect(await ask(a.s, "doc:leave", { docId: DOC, discard: true })).toEqual({ ok: true });
    expect(await stored()).toHaveLength(0);
    expect(await draft()).toBeNull();
  });

  it("keeps an unpublished draft when everyone closes the tab, and drops it once the page moved on", async () => {
    const a = await editor("minh", "Bản nháp");
    a.doc.getText("t").insert(0, "Sửa dở: ");
    await until(() => false, 300).catch(() => undefined);
    a.s.disconnect();
    await until(() => false, 300).catch(() => undefined);
    expect((await draft())!.left).toBeGreaterThan(3600);
    const back = await editor("minh", "ignored");
    expect(back.text()).toBe("Sửa dở: Bản nháp");
    // Joining renews the day the draft is kept for.
    expect((await draft())!.left).toBeGreaterThan(24 * 3600 - 60);
    back.s.disconnect();
    await until(() => false, 300).catch(() => undefined);

    // Someone restored an old version outside the editor: the stale draft is not resumed.
    pages[DOC]!.version = 5;
    const fresh = await editor("lan", "Bản đã khôi phục");
    expect(fresh.text()).toBe("Bản đã khôi phục");
    await ask(fresh.s, "doc:leave", { docId: DOC, discard: true });
  });

  it("compacts a long session into one stored update with the same content", async () => {
    const a = await editor("minh", "");
    for (let i = 0; i < 450; i++) a.doc.getText("t").insert(a.text().length, "x");
    const content = async () => {
      const copy = new Y.Doc();
      const all = await stored();
      for (const u of all) Y.applyUpdate(copy, new Uint8Array(u));
      return { n: all.length, text: copy.getText("t").toString() };
    };
    const end = Date.now() + 10_000;
    let last = await content();
    while (last.text !== "x".repeat(450) && Date.now() < end) {
      await new Promise((r) => setTimeout(r, 100));
      last = await content();
    }
    expect(last.text).toBe("x".repeat(450));
    expect(last.n).toBeLessThan(100);
    await ask(a.s, "doc:leave", { docId: DOC, discard: true });
  });

  it("keeps the draft of a page still open however long nobody types, so later edits are stored", async () => {
    const a = await editor("minh", "Mở cả ngày");
    await until(() => false, 200).catch(() => undefined);
    // A day goes by without a keystroke: the draft would be due for pruning.
    await db((c) => c.query("UPDATE collab_drafts SET expires_at = now() - interval '1 minute' WHERE doc_id = $1", [DOC]));
    expect(await rt.collab!.renewOpen()).toBeGreaterThanOrEqual(1);
    await pruneCollabDrafts(pool);
    expect((await draft())!.left).toBeGreaterThan(24 * 3600 - 60);
    a.doc.getText("t").insert(0, "Sau: ");
    const text = async () => {
      const copy = new Y.Doc();
      for (const u of await stored()) Y.applyUpdate(copy, new Uint8Array(u));
      return copy.getText("t").toString();
    };
    const end = Date.now() + 5000;
    while ((await text()) !== "Sau: Mở cả ngày" && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
    expect(await text()).toBe("Sau: Mở cả ngày");
    await ask(a.s, "doc:leave", { docId: DOC, discard: true });
  });
});
