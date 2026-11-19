import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { migrate, signInternalToken, PRINCIPAL_HEADER } from "@workspace/service-kit";
import { newId, runWithContext, withTransaction, type Principal } from "@workspace/shared";
import type { EventEnvelope } from "@workspace/contracts";
import { createChatApp, depsFromEnv } from "../../src/modules/chat/app.js";
import { resetTestDatabase } from "../test-db.js";
import { extractLinks, fetchGuarded, handleUnfurlEvent, parseMeta, type LinkPreview } from "../../src/modules/chat/unfurl.js";

/** Link previews (unfurl.ts) against a local site, and who reacted. */
const SECRET = "dev-internal-secret-change-me-32bytes!";
const RUN = newId().slice(-6);
const EMP = ["channel.create", "channel.read", "message.post", "message.read"].map((permission) => ({ permission, scope: "WORKSPACE" as const }));
const user = (id: string): Principal => ({ type: "user", id, teamIds: [], departmentId: null, grants: EMP });
const minh = user("minh");
const lan = user("lan");
const huy = user("huy");

// A 1×1 PNG.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
let site: Server;
let origin = "";
let pageHits = 0;

let deps: ReturnType<typeof depsFromEnv>;
let server: { url: string; close: () => Promise<void> };
let general = "";
let secret = "";

async function call(p: Principal, method: string, path: string, body?: unknown) {
  const res = await fetch(`${server.url}${path}`, {
    method,
    headers: { "content-type": "application/json", [PRINCIPAL_HEADER]: await signInternalToken({ principal: p, requestId: newId() }, SECRET) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const type = res.headers.get("content-type") ?? "";
  const buf = Buffer.from(await res.arrayBuffer());
  return { status: res.status, type, headers: res.headers, buf, body: type.includes("json") && buf.length ? JSON.parse(buf.toString()) : null };
}

/** Runs the consumer for a posted message, as the `chat-unfurl` group would. */
async function unfurlPosted(m: { id: string; channelId: string; body: string }, channelKind: "public" | "private" = "public") {
  const pushed: { linkPreviews: LinkPreview[] }[] = [];
  const e = {
    eventId: newId(),
    eventType: "chat.message.created.v1",
    version: 1,
    aggregateType: "chat.message",
    aggregateId: m.id,
    actorId: "user:minh",
    occurredAt: new Date().toISOString(),
    payload: {
      messageId: m.id,
      channelId: m.channelId,
      channelKind,
      channelName: "general",
      seq: 1,
      threadRootId: null,
      authorId: "minh",
      authorType: "user",
      body: m.body,
      mentions: [],
      attachments: [],
      recipients: [],
      quiet: [],
      everyMessage: [],
    },
  } as EventEnvelope;
  await runWithContext({ actorId: "test", requestId: newId() }, () => withTransaction(deps.pool, (c) => handleUnfurlEvent(e, c, (_ch, d) => pushed.push(d))));
  return pushed;
}

beforeAll(async () => {
  site = createServer((req, res) => {
    const u = req.url ?? "/";
    if (u === "/page") {
      pageHits++;
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(
        `<!doctype html><html><head><title>Fallback</title><meta property="og:site_name" content="An Phát"><meta property="og:title" content="Báo giá &amp; hợp đồng Q4">` +
          `<meta name="description" content="Bản tóm tắt cho khách hàng"><meta property="og:image" content="/img.png"></head><body>${"x".repeat(1000)}</body></html>`,
      );
    } else if (u === "/img.png") {
      res.writeHead(200, { "content-type": "image/png" });
      res.end(PNG);
    } else if (u === "/svg-page") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<html><head><title>Có ảnh SVG</title><meta property="og:image" content="/x.svg"></head></html>`);
    } else if (u === "/x.svg") {
      res.writeHead(200, { "content-type": "image/svg+xml" });
      res.end("<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>");
    } else if (u === "/redirect") {
      res.writeHead(302, { location: "/page" });
      res.end();
    } else if (u === "/to-file") {
      res.writeHead(302, { location: "file:///etc/passwd" });
      res.end();
    } else if (u === "/json") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((r) => site.listen(0, "127.0.0.1", r));
  origin = `http://127.0.0.1:${(site.address() as { port: number }).port}`;

  await resetTestDatabase();
  await migrate("postgres://workspace_owner:owner_pw@localhost:5432/workspace_test", fileURLToPath(new URL("../../migrations/chat", import.meta.url)), "chat");
  const owner = new pg.Client("postgres://workspace_owner:owner_pw@localhost:5432/workspace_test?options=-c%20search_path%3Dchat");
  await owner.connect();
  for (const u of ["minh", "lan", "huy"]) await owner.query("INSERT INTO known_members (user_id) VALUES ($1) ON CONFLICT DO NOTHING", [u]);
  await owner.end();
  deps = depsFromEnv();
  const { app, listen } = await createChatApp(deps);
  server = { url: `http://127.0.0.1:${await listen(0)}`, close: () => app.close() };
  general = (await call(minh, "POST", "/channels", { kind: "public", name: `links-${RUN}`, memberIds: ["lan"] })).body.id;
  secret = (await call(minh, "POST", "/channels", { kind: "private", name: `links-private-${RUN}`, memberIds: [] })).body.id;
});

afterAll(async () => {
  await server?.close();
  await new Promise((r) => site?.close(r));
});

const env = { ...process.env };
afterEach(() => {
  process.env.WEBHOOK_ALLOW_PRIVATE = env.WEBHOOK_ALLOW_PRIVATE;
  if (env.WEBHOOK_ALLOW_PRIVATE === undefined) delete process.env.WEBHOOK_ALLOW_PRIVATE;
  process.env.NODE_ENV = env.NODE_ENV;
});

describe("finding links", () => {
  it("takes the first three distinct http(s) links, outside code, without trailing punctuation or links into the app", () => {
    const body =
      "Xem https://a.example/x, rồi (https://b.example/y). `https://code.example` ```https://block.example``` " +
      "https://a.example/x#top https://c.example/z?q=1 https://d.example ftp://e.example https://app.example/app/home";
    expect(extractLinks(body, "https://app.example")).toEqual(["https://a.example/x", "https://b.example/y", "https://c.example/z?q=1"]);
    expect(extractLinks("https://user:pw@a.example/")).toEqual([]);
  });

  it("reads OpenGraph first, then Twitter cards and the title", () => {
    const m = parseMeta(
      `<head><title>T</title><meta name="twitter:title" content="Tw"><meta content='OG' property='og:title'><meta name=description content=Mô&#x20;tả><meta property="og:image" content="../i.jpg"></head>`,
      "https://www.example.com/a/b",
    );
    expect(m).toEqual({ siteName: "example.com", title: "OG", description: "Mô tả", image: "https://www.example.com/i.jpg" });
  });
});

describe("the fetch fence", () => {
  it("refuses this machine's own network unless explicitly allowed outside production", async () => {
    delete process.env.WEBHOOK_ALLOW_PRIVATE;
    await expect(fetchGuarded(`${origin}/page`, 1e6, () => true)).rejects.toThrow(/private/);
    process.env.WEBHOOK_ALLOW_PRIVATE = "1";
    process.env.NODE_ENV = "production";
    await expect(fetchGuarded(`${origin}/page`, 1e6, () => true)).rejects.toThrow(/private/);
    process.env.NODE_ENV = "test";
    expect((await fetchGuarded(`${origin}/page`, 1e6, () => true)).type).toBe("text/html");
  });

  it("follows redirects only to http(s), and checks the content type", async () => {
    process.env.WEBHOOK_ALLOW_PRIVATE = "1";
    expect((await fetchGuarded(`${origin}/redirect`, 1e6, (t) => t === "text/html")).url).toBe(`${origin}/page`);
    await expect(fetchGuarded(`${origin}/to-file`, 1e6, () => true)).rejects.toThrow(/http/);
    await expect(fetchGuarded(`${origin}/json`, 1e6, (t) => t === "text/html")).rejects.toThrow(/content type/);
    await expect(fetchGuarded(`${origin}/img.png`, 10, () => true)).rejects.toThrow(/too large/);
  });
});

describe("previews on messages", () => {
  it("adds a card with a stored thumbnail, fetched once per workspace, readable by the conversation only", async () => {
    process.env.WEBHOOK_ALLOW_PRIVATE = "1";
    const posted = (await call(minh, "POST", `/channels/${general}/messages`, { body: `Gửi anh báo giá ${origin}/page nhé` })).body;
    const pushed = await unfurlPosted(posted);
    expect(pushed[0]!.linkPreviews).toMatchObject([
      { url: `${origin}/page`, siteName: "An Phát", title: "Báo giá & hợp đồng Q4", description: "Bản tóm tắt cho khách hàng", image: true },
    ]);
    const read = (await call(lan, "GET", `/channels/${general}/messages?limit=1`)).body.messages[0];
    const card = read.linkPreviews[0] as LinkPreview;
    expect(card.title).toBe("Báo giá & hợp đồng Q4");

    const img = await call(lan, "GET", `/messages/${posted.id}/previews/${card.id}/image`);
    expect(img.status).toBe(200);
    expect(img.type).toBe("image/png");
    expect(img.headers.get("x-content-type-options")).toBe("nosniff");
    expect(img.buf.equals(PNG)).toBe(true);
    expect((await call(lan, "GET", `/messages/${posted.id}/previews/${newId()}/image`)).status).toBe(404);

    // The same link again: from the cache, not the site.
    const hits = pageHits;
    const again = (await call(lan, "POST", `/channels/${general}/messages`, { body: `${origin}/page` })).body;
    expect((await unfurlPosted(again))[0]!.linkPreviews[0]!.id).toBe(card.id);
    expect(pageHits).toBe(hits);

    // A private channel's thumbnail is not for people outside it.
    const hidden = (await call(minh, "POST", `/channels/${secret}/messages`, { body: `${origin}/page` })).body;
    const hc = (await unfurlPosted(hidden, "private"))[0]!.linkPreviews[0]!;
    expect((await call(huy, "GET", `/messages/${hidden.id}/previews/${hc.id}/image`)).status).toBe(403);
  });

  it("never stores an SVG thumbnail, and the author can hide the cards for good", async () => {
    process.env.WEBHOOK_ALLOW_PRIVATE = "1";
    const posted = (await call(minh, "POST", `/channels/${general}/messages`, { body: `${origin}/svg-page` })).body;
    const [p] = await unfurlPosted(posted);
    expect(p!.linkPreviews).toMatchObject([{ title: "Có ảnh SVG", image: false }]);
    expect((await call(lan, "DELETE", `/messages/${posted.id}/previews`)).status).toBe(403);
    expect((await call(minh, "DELETE", `/messages/${posted.id}/previews`)).status).toBe(204);
    expect((await unfurlPosted(posted)).length).toBe(0);
    expect((await call(lan, "GET", `/channels/${general}/messages?limit=1`)).body.messages[0].linkPreviews).toEqual([]);
  });

  it("names who reacted, in order", async () => {
    const m = (await call(minh, "POST", `/channels/${general}/messages`, { body: "Chốt nhé" })).body;
    await call(lan, "POST", `/messages/${m.id}/reactions`, { emoji: "👍" });
    await call(minh, "POST", `/messages/${m.id}/reactions`, { emoji: "👍" });
    const r = (await call(lan, "GET", `/channels/${general}/messages?limit=1`)).body.messages[0].reactions;
    expect(r).toEqual([{ emoji: "👍", count: 2, mine: true, users: ["lan", "minh"] }]);
  });
});
