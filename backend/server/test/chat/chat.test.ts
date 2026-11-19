import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { io as ioClient, type Socket } from "socket.io-client";
import { migrate, signInternalToken, PRINCIPAL_HEADER } from "@workspace/service-kit";
import { newId, type Principal } from "@workspace/shared";
import { createChatApp, depsFromEnv } from "../../src/modules/chat/app.js";
import { resetTestDatabase } from "../test-db.js";
import { sendScheduled } from "../../src/modules/chat/scheduled.js";
import pg from "pg";

const SECRET = "dev-internal-secret-change-me-32bytes!";
const RUN = newId();
const EMP = ["channel.create", "channel.read", "message.post", "message.read"].map((permission) => ({ permission, scope: "WORKSPACE" as const }));
const user = (id: string): Principal => ({ type: "user", id, teamIds: [], departmentId: null, grants: EMP });
const minh = user("minh");
const lan = user("lan");
const huy = user("huy");

let server: { close: () => Promise<void>; url: string };
const sockets: Socket[] = [];

async function start() {
  const { app, listen } = await createChatApp(depsFromEnv());
  const port = await listen(0);
  return { url: `http://127.0.0.1:${port}`, close: () => app.close() };
}

async function call(base: string, p: Principal, method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json", [PRINCIPAL_HEADER]: await signInternalToken({ principal: p, requestId: newId() }, SECRET) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const t = await res.text();
  return { status: res.status, body: t ? JSON.parse(t) : null };
}

async function connect(base: string, p: Principal): Promise<{ socket: Socket; events: { name: string; data: any }[] }> {
  const socket = ioClient(base, { auth: { ticket: await signInternalToken({ principal: p, requestId: newId() }, SECRET) }, transports: ["websocket"], forceNew: true });
  sockets.push(socket);
  const events: { name: string; data: any }[] = [];
  socket.onAny((name, data) => events.push({ name, data }));
  await new Promise<void>((resolve, reject) => {
    socket.once("ready", () => resolve());
    socket.once("connect_error", reject);
  });
  return { socket, events };
}

const until = async (pred: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 25));
  }
};

let general: string;
let secret: string;

beforeAll(async () => {
  await resetTestDatabase();
  await migrate("postgres://workspace_owner:owner_pw@localhost:5432/workspace_test", fileURLToPath(new URL("../../migrations/chat", import.meta.url)), "chat");
  // Members chat knows about (normally from identity.member.joined events).
  const owner = new pg.Client("postgres://workspace_owner:owner_pw@localhost:5432/workspace_test?options=-c%20search_path%3Dchat");
  await owner.connect();
  for (const u of ["minh", "lan", "huy"]) await owner.query("INSERT INTO known_members (user_id) VALUES ($1) ON CONFLICT DO NOTHING", [u]);
  await owner.end();
  server = await start();
  general = (await call(server.url, minh, "POST", "/channels", { kind: "public", name: `general-${RUN.slice(-6)}`, memberIds: ["lan"] })).body.id;
  secret = (await call(server.url, minh, "POST", "/channels", { kind: "private", name: `finance-${RUN.slice(-6)}`, memberIds: [] })).body.id;
});

afterAll(async () => {
  sockets.forEach((s) => s.disconnect());
  await server?.close();
});

describe("chat", () => {
  it("only puts people from this workspace into conversations", { timeout: 40_000 }, async () => {
    const r = await call(server.url, minh, "POST", "/channels", { kind: "private", name: `ghost-${RUN.slice(-6)}`, memberIds: ["not-a-member"] });
    expect(r.status).toBe(400);
    expect((await call(server.url, minh, "POST", "/dms", { userId: "eve" })).status).toBe(400); // eve is not a member of this workspace
    expect((await call(server.url, minh, "POST", `/channels/${secret}/members`, { userIds: ["ghost"] })).status).toBe(400);
  });

  it("posts and reads messages with cursor pagination", async () => {
    for (let i = 1; i <= 120; i++) await call(server.url, minh, "POST", `/channels/${general}/messages`, { body: `msg ${i}` });
    const p1 = await call(server.url, lan, "GET", `/channels/${general}/messages?limit=50`);
    expect(p1.body.messages).toHaveLength(50);
    expect(p1.body.messages[0].body).toBe("msg 120");
    const p2 = await call(server.url, lan, "GET", `/channels/${general}/messages?limit=50&before=${p1.body.nextBefore}`);
    expect(p2.body.messages[0].body).toBe("msg 70");
    const p3 = await call(server.url, lan, "GET", `/channels/${general}/messages?limit=50&before=${p2.body.nextBefore}`);
    expect(p3.body.messages).toHaveLength(20);
    expect(p3.body.nextBefore).toBeNull();
  });

  it("exports a channel's history to workspace admins only, oldest first and paged", async () => {
    expect((await call(server.url, lan, "GET", `/channels/${general}/export`)).status).toBe(403);
    const admin = { ...minh, grants: [...minh.grants, { permission: "channel.manage", scope: "WORKSPACE" as const }] };
    const p1 = await call(server.url, admin, "GET", `/channels/${general}/export?limit=100`);
    expect(p1.status).toBe(200);
    expect(p1.body.channel.id).toBe(general);
    expect(p1.body.messages[0].body).toBe("msg 1");
    expect(p1.body.messages).toHaveLength(100);
    const p2 = await call(server.url, admin, "GET", `/channels/${general}/export?limit=100&after=${p1.body.nextAfter}`);
    expect(p2.body.messages[0].body).toBe("msg 101");
    expect(p2.body.nextAfter).toBeNull();
  });

  it("is idempotent on clientMsgId (double submit)", async () => {
    for (let round = 0; round < 10; round++) {
      const clientMsgId = newId();
      const [a, b] = await Promise.all([
        call(server.url, minh, "POST", `/channels/${general}/messages`, { body: "once", clientMsgId }),
        call(server.url, minh, "POST", `/channels/${general}/messages`, { body: "once", clientMsgId }),
      ]);
      expect([a.status, b.status]).toEqual([201, 201]);
      expect(a.body.id).toBe(b.body.id);
    }
    const recent = await call(server.url, minh, "GET", `/channels/${general}/messages?limit=20`);
    expect(recent.body.messages.filter((m: { body: string }) => m.body === "once")).toHaveLength(10);
  });

  it("assigns unique, ordered seq under concurrent posts", async () => {
    const posts = await Promise.all(Array.from({ length: 20 }, (_, i) => call(server.url, minh, "POST", `/channels/${general}/messages`, { body: `c${i}` })));
    const seqs = posts.map((p) => p.body.seq as number).sort((x, y) => x - y);
    expect(new Set(seqs).size).toBe(20);
    expect(seqs.at(-1)! - seqs[0]!).toBe(19);
  });

  it("threads, mentions, star/mute and mark-unread are per user and respect channel membership", async () => {
    const root = (await call(server.url, lan, "POST", `/channels/${general}/messages`, { body: "Ai chốt **bảng giá**?" })).body;
    await call(server.url, minh, "POST", `/channels/${general}/messages`, { body: "Mình chốt <@lan>", threadRootId: root.id });
    await call(server.url, minh, "POST", `/channels/${secret}/messages`, { body: "riêng tư <@lan>" });
    const threads = (await call(server.url, lan, "GET", "/threads")).body.threads;
    expect(threads[0].root.id).toBe(root.id);
    expect(threads[0].lastReply.authorId).toBe("minh");
    expect(threads[0].channel.id).toBe(general);
    expect(threads[0].participants).toContain("minh");
    const mentions = (await call(server.url, lan, "GET", "/mentions")).body.messages;
    expect(mentions.some((m: { body: string }) => m.body === "Mình chốt <@lan>")).toBe(true);
    expect(mentions.some((m: { channelId: string }) => m.channelId === secret)).toBe(false); // not a member of the private channel
    expect((await call(server.url, huy, "GET", "/threads")).body.threads).toEqual([]);

    expect((await call(server.url, lan, "PUT", `/channels/${general}/prefs`, { starred: true, muted: true })).body).toMatchObject({ starred: true, muted: true });
    // Mute for an hour, then turn notifications back on; or choose mentions only.
    const hour = (await call(server.url, lan, "PUT", `/channels/${general}/prefs`, { muteFor: "1h" })).body;
    expect(hour.muted).toBe(true);
    expect(Date.parse(hour.mutedUntil) - Date.now()).toBeGreaterThan(50 * 60_000);
    expect((await call(server.url, lan, "PUT", `/channels/${general}/prefs`, { muteFor: "off", notify: "mentions" })).body).toMatchObject({
      muted: false,
      mutedUntil: null,
      notify: "mentions",
    });
    expect((await call(server.url, lan, "PUT", `/channels/${general}/prefs`, { muted: true })).body.muted).toBe(true);
    const mine = (await call(server.url, lan, "GET", "/channels")).body.channels.find((c: { id: string }) => c.id === general);
    expect([mine.starred, mine.muted, mine.memberCount > 0, !!mine.lastMessageAt]).toEqual([true, true, true, true]);
    expect((await call(server.url, minh, "GET", "/channels")).body.channels.find((c: { id: string }) => c.id === general).starred).toBe(false);
    expect((await call(server.url, lan, "PUT", `/channels/${secret}/prefs`, { starred: true })).status).toBe(403);

    const last = (await call(server.url, lan, "GET", `/channels/${general}/messages?limit=1`)).body.messages[0];
    await call(server.url, lan, "POST", `/channels/${general}/read`, { seq: last.seq });
    const u = (await call(server.url, lan, "POST", `/channels/${general}/unread`, { seq: last.seq })).body;
    expect(u.lastReadSeq).toBe(last.seq - 1); // thread replies share the channel sequence, so unread may count them too
    expect(u.unread).toBeGreaterThanOrEqual(1);
  });

  it("keeps private channels member-only", async () => {
    expect((await call(server.url, lan, "GET", `/channels/${secret}/messages`)).status).toBe(403);
    expect((await call(server.url, lan, "POST", `/channels/${secret}/messages`, { body: "hi" })).status).toBe(403);
  });

  it("delivers realtime messages to members' sockets, and not to people outside the channel", async () => {
    const lanSock = await connect(server.url, lan);
    const huySock = await connect(server.url, huy);
    const posted = await call(server.url, minh, "POST", `/channels/${secret}/messages`, { body: "realtime hello" });
    const own = await call(server.url, minh, "POST", `/channels/${general}/messages`, { body: "realtime hello all" });
    await until(() => lanSock.events.some((e) => e.name === "message.created" && e.data.id === own.body.id));
    await new Promise((r) => setTimeout(r, 300));
    expect(huySock.events.some((e) => e.name === "message.created" && e.data.id === posted.body.id)).toBe(false);
  });

  it("joins live sockets when a member is added", async () => {
    const huySock = await connect(server.url, huy);
    await call(server.url, minh, "POST", `/channels/${secret}/members`, { userIds: ["huy"] });
    await new Promise((r) => setTimeout(r, 200));
    const posted = await call(server.url, minh, "POST", `/channels/${secret}/messages`, { body: "welcome huy" });
    await until(() => huySock.events.some((e) => e.name === "message.created" && e.data.id === posted.body.id));
  });

  it("relays typing only within rooms the socket belongs to", async () => {
    const minhSock = await connect(server.url, minh);
    const lanSock = await connect(server.url, lan);
    lanSock.socket.emit("typing", { channelId: secret }); // lan is not a member of secret
    lanSock.socket.emit("typing", { channelId: general });
    await until(() => minhSock.events.some((e) => e.name === "typing" && e.data.channelId === general));
    expect(minhSock.events.some((e) => e.name === "typing" && e.data.channelId === secret)).toBe(false);
  });

  it("threads: replies, reply count, no nested replies", async () => {
    const root = (await call(server.url, minh, "POST", `/channels/${general}/messages`, { body: "We should move the campaign deadline to October 18" })).body;
    await call(server.url, lan, "POST", `/channels/${general}/messages`, { body: "Agree", threadRootId: root.id });
    const reply = (await call(server.url, minh, "POST", `/channels/${general}/messages`, { body: "<@lan> please update the plan", threadRootId: root.id })).body;
    expect(reply.mentions).toEqual(["lan"]);
    const t = await call(server.url, lan, "GET", `/messages/${root.id}/thread`);
    expect(t.body.root.replyCount).toBe(2);
    expect(t.body.replies.map((r: { body: string }) => r.body)).toEqual(["Agree", "<@lan> please update the plan"]);
    expect((await call(server.url, lan, "POST", `/channels/${general}/messages`, { body: "nested", threadRootId: reply.id })).status).toBe(400);
  });

  it("tracks unread counts, mentions and monotonic read state across devices", async () => {
    const before = (await call(server.url, lan, "GET", "/channels")).body.channels.find((c: { id: string }) => c.id === general);
    expect(before.unread).toBeGreaterThan(0);
    expect(before.mentions).toBeGreaterThanOrEqual(1);
    const lanPhone = await connect(server.url, lan);
    const r = await call(server.url, lan, "POST", `/channels/${general}/read`, { seq: before.lastSeq });
    expect(r.body.unread).toBe(0);
    // Caught up: the list reports no unread and no unread mentions without walking the channel's history.
    const caughtUp = (await call(server.url, lan, "GET", "/channels")).body.channels.find((c: { id: string }) => c.id === general);
    expect([caughtUp.unread, caughtUp.mentions]).toEqual([0, 0]);
    await until(() => lanPhone.events.some((e) => e.name === "read.updated" && e.data.channelId === general));
    // A stale tab reporting an older seq does not move read state backwards.
    const stale = await call(server.url, lan, "POST", `/channels/${general}/read`, { seq: 1 });
    expect(stale.body.lastReadSeq).toBe(before.lastSeq);
  });

  it("recovers gaps after reconnect with ?after=seq", async () => {
    const last = (await call(server.url, lan, "GET", `/channels/${general}/messages?limit=1`)).body.messages[0].seq;
    await call(server.url, minh, "POST", `/channels/${general}/messages`, { body: "missed 1" });
    await call(server.url, minh, "POST", `/channels/${general}/messages`, { body: "missed 2" });
    const gap = await call(server.url, lan, "GET", `/channels/${general}/messages?after=${last}`);
    expect(gap.body.messages.map((m: { body: string }) => m.body)).toEqual(["missed 1", "missed 2"]);
  });

  it("toggles reactions and only members can react", async () => {
    const m = (await call(server.url, minh, "POST", `/channels/${general}/messages`, { body: "react to me" })).body;
    expect((await call(server.url, lan, "POST", `/messages/${m.id}/reactions`, { emoji: "👍" })).body.reactions).toEqual([{ emoji: "👍", count: 1, mine: true, users: ["lan"] }]);
    expect((await call(server.url, lan, "POST", `/messages/${m.id}/reactions`, { emoji: "👍" })).body.reactions).toEqual([]);
    expect((await call(server.url, huy, "POST", `/messages/${m.id}/reactions`, { emoji: "👍" })).status).toBe(403);
  });

  it("DMs converge to one channel when opened concurrently", async () => {
    const [x, y] = await Promise.all([call(server.url, minh, "POST", "/dms", { userId: "huy" }), call(server.url, huy, "POST", "/dms", { userId: "minh" })]);
    expect(x.body.id).toBe(y.body.id);
    expect((await call(server.url, lan, "GET", `/channels/${x.body.id}/messages`)).status).toBe(403);
    // "Đã xem": in a DM each side sees how far the other has read; public channels never expose it.
    const m = (await call(server.url, minh, "POST", `/channels/${x.body.id}/messages`, { body: "Chiều nay họp nhé" })).body;
    expect((await call(server.url, minh, "GET", `/channels/${x.body.id}`)).body.readers).toEqual([{ userId: "huy", seq: 0 }]);
    await call(server.url, huy, "POST", `/channels/${x.body.id}/read`, { seq: m.seq });
    expect((await call(server.url, minh, "GET", `/channels/${x.body.id}`)).body.readers).toEqual([{ userId: "huy", seq: m.seq }]);
    expect((await call(server.url, minh, "GET", `/channels/${general}`)).body.readers).toEqual([]);
  });

  it("forwards a message with where it came from; only from conversations you can read, into ones you belong to", async () => {
    const dm = (await call(server.url, minh, "POST", "/dms", { userId: "huy" })).body.id;
    const src = (await call(server.url, lan, "POST", `/channels/${general}/messages`, { body: "Hạn nộp báo cáo là thứ Sáu <@minh>" })).body;
    const r = await call(server.url, minh, "POST", `/messages/${src.id}/forward`, { channelId: dm, note: "Anh xem giúp" });
    expect(r.status).toBe(201);
    expect(r.body.messages.map((m: { body: string }) => m.body)).toEqual(["Anh xem giúp", "Hạn nộp báo cáo là thứ Sáu <@minh>"]);
    expect(r.body.messages[1]).toMatchObject({ authorId: "minh", mentions: [], forwardOf: { messageId: src.id, channelId: general, authorId: "lan", channelKind: "public" } });
    const seen = (await call(server.url, huy, "GET", `/channels/${dm}/messages?limit=1`)).body.messages[0];
    expect(seen.forwardOf.authorId).toBe("lan");
    // lan is not in the minh–huy DM: she can neither forward out of it nor into it.
    expect((await call(server.url, lan, "POST", `/messages/${seen.id}/forward`, { channelId: general })).status).toBe(403);
    expect((await call(server.url, lan, "POST", `/messages/${src.id}/forward`, { channelId: dm })).status).toBe(403);
  });

  it("Gửi sau: a scheduled message is posted once at its time, as its author; only the author sees or cancels it", async () => {
    const at = new Date(Date.now() + 3600_000).toISOString();
    expect((await call(server.url, minh, "POST", `/channels/${general}/scheduled`, { body: "x", at: "2020-01-01T00:00:00Z" })).status).toBe(400);
    const s = (await call(server.url, minh, "POST", `/channels/${general}/scheduled`, { body: "Nhắc cả nhà: họp 9h sáng mai", at })).body;
    expect((await call(server.url, minh, "GET", `/scheduled?channelId=${general}`)).body.scheduled.map((x: { id: string }) => x.id)).toEqual([s.id]);
    expect((await call(server.url, lan, "GET", "/scheduled")).body.scheduled).toEqual([]);
    const other = (await call(server.url, minh, "POST", `/channels/${general}/scheduled`, { body: "huỷ tin này", at })).body;
    expect((await call(server.url, lan, "DELETE", `/scheduled/${other.id}`)).status).toBe(204); // not hers: nothing happens
    expect((await call(server.url, minh, "GET", "/scheduled")).body.scheduled).toHaveLength(2);
    await call(server.url, minh, "DELETE", `/scheduled/${other.id}`);
    // Its time comes.
    const owner = new pg.Client("postgres://workspace_owner:owner_pw@localhost:5432/workspace_test?options=-c%20search_path%3Dchat");
    await owner.connect();
    await owner.query("UPDATE scheduled_messages SET send_at = now() - interval '1 minute' WHERE id = $1", [s.id]);
    await owner.end();
    const emitted: string[] = [];
    const pool = depsFromEnv().pool;
    await sendScheduled(pool, (_c, m) => void emitted.push(m.body));
    await sendScheduled(pool, (_c, m) => void emitted.push(m.body));
    await pool.end();
    expect(emitted).toEqual(["Nhắc cả nhà: họp 9h sáng mai"]);
    const last = (await call(server.url, lan, "GET", `/channels/${general}/messages?limit=1`)).body.messages[0];
    expect(last).toMatchObject({ body: "Nhắc cả nhà: họp 9h sáng mai", authorId: "minh" });
    expect((await call(server.url, minh, "GET", "/scheduled")).body.scheduled).toEqual([]);
  });

  it("deletes messages (author only) and hides the body", async () => {
    const m = (await call(server.url, minh, "POST", `/channels/${general}/messages`, { body: "oops secret" })).body;
    expect((await call(server.url, lan, "DELETE", `/messages/${m.id}`)).status).toBe(403);
    expect((await call(server.url, minh, "DELETE", `/messages/${m.id}`)).status).toBe(204);
    const t = await call(server.url, lan, "GET", `/channels/${general}/messages?limit=3`);
    const gone = t.body.messages.find((x: { id: string }) => x.id === m.id);
    expect(gone.body).toBe("");
    expect(gone.deletedAt).not.toBeNull();
  });

  it("saves and pins messages", async () => {
    const m = (await call(server.url, minh, "POST", `/channels/${general}/messages`, { body: "pin me" })).body;
    expect((await call(server.url, lan, "POST", `/messages/${m.id}/save`)).status).toBe(204);
    expect((await call(server.url, lan, "GET", "/saved")).body.messages.map((x: { id: string }) => x.id)).toContain(m.id);
    expect((await call(server.url, lan, "POST", `/messages/${m.id}/pin`)).status).toBe(204);
    expect((await call(server.url, lan, "GET", `/channels/${general}/pins`)).body.messages[0].id).toBe(m.id);
  });

  it("rejects socket connections with an invalid ticket", async () => {
    const s = ioClient(server.url, { auth: { ticket: "garbage" }, transports: ["websocket"], forceNew: true });
    sockets.push(s);
    const err = await new Promise<Error>((resolve) => s.once("connect_error", resolve));
    expect(err.message).toBe("invalid ticket");
  });

  it("validates input", async () => {
    expect((await call(server.url, minh, "POST", `/channels/${general}/messages`, { body: "" })).status).toBe(400);
    expect((await call(server.url, minh, "POST", "/channels", { kind: "public", name: "bad name!" })).status).toBe(400);
  });
});

describe("attachments", () => {
  const up = (p: Principal) => ({ ...p, grants: [...p.grants, { permission: "file.upload", scope: "WORKSPACE" as const }] });
  async function upload(p: Principal, channelId: string, name: string, content: string, type = "text/plain") {
    const r = await call(server.url, up(p), "POST", `/channels/${channelId}/files`, { name, contentType: type, size: Buffer.byteLength(content) });
    expect(r.status).toBe(201);
    expect((await fetch(r.body.uploadUrl, { method: "PUT", headers: { "content-type": type }, body: content })).ok).toBe(true);
    return r.body.fileId as string;
  }

  it("uploads directly to storage, binds to one message, and only channel readers can download", async () => {
    const ch = (await call(server.url, minh, "POST", "/channels", { kind: "private", name: `files-${newId().slice(-6).toLowerCase()}`, memberIds: ["lan"] })).body.id;
    const fileId = await upload(minh, ch, "Báo cáo quý 3.txt", "doanh thu tăng 12%");
    expect((await call(server.url, minh, "POST", `/files/${fileId}/confirm`)).body).toMatchObject({ name: "Báo cáo quý 3.txt", size: Buffer.byteLength("doanh thu tăng 12%") });
    // Client-supplied metadata is ignored: the server's record wins.
    const m = await call(server.url, minh, "POST", `/channels/${ch}/messages`, {
      body: "",
      attachments: [{ fileId, name: "fake.exe", size: 1, contentType: "application/x-msdownload" }],
    });
    expect(m.status).toBe(201);
    expect(m.body.attachments).toEqual([{ fileId, name: "Báo cáo quý 3.txt", size: Buffer.byteLength("doanh thu tăng 12%"), contentType: "text/plain" }]);
    // A file can be attached once, by its uploader, in its channel.
    expect((await call(server.url, minh, "POST", `/channels/${ch}/messages`, { body: "again", attachments: [fileId] })).status).toBe(400);
    const dl = await call(server.url, lan, "GET", `/files/${fileId}/download`);
    expect(dl.status).toBe(200);
    const got = await fetch(dl.body.url);
    expect(await got.text()).toBe("doanh thu tăng 12%");
    expect(got.headers.get("content-disposition")).toContain("filename*=UTF-8''B%C3%A1o%20c%C3%A1o");
    expect((await call(server.url, huy, "GET", `/files/${fileId}/download`)).status).toBe(404);
    expect((await call(server.url, lan, "GET", `/channels/${ch}/files`)).body.files.map((f: { name: string }) => f.name)).toEqual(["Báo cáo quý 3.txt"]);
  });

  it("refuses non-members, bad types, oversize files and someone else's upload", async () => {
    const ch = (await call(server.url, minh, "POST", "/channels", { kind: "private", name: `nope-${newId().slice(-6).toLowerCase()}`, memberIds: ["lan"] })).body.id;
    expect((await call(server.url, up(huy), "POST", `/channels/${ch}/files`, { name: "a.txt", contentType: "text/plain", size: 3 })).status).toBe(403);
    expect((await call(server.url, up(minh), "POST", `/channels/${ch}/files`, { name: "a.exe", contentType: "application/x-msdownload", size: 3 })).status).toBe(400);
    expect((await call(server.url, up(minh), "POST", `/channels/${ch}/files`, { name: "a.txt", contentType: "text/plain", size: 60 * 1024 * 1024 })).status).toBe(400);
    expect((await call(server.url, minh, "POST", `/channels/${ch}/files`, { name: "a.txt", contentType: "text/plain", size: 3 })).status).toBe(403); // no file.upload
    const fileId = await upload(minh, ch, "a.txt", "abc");
    await call(server.url, minh, "POST", `/files/${fileId}/confirm`);
    expect((await call(server.url, lan, "POST", `/channels/${ch}/messages`, { body: "steal", attachments: [fileId] })).status).toBe(400);
    expect((await call(server.url, lan, "POST", `/files/${fileId}/confirm`)).status).toBe(404);
    // Unconfirmed uploads cannot be attached.
    const pending = (await call(server.url, up(minh), "POST", `/channels/${ch}/files`, { name: "b.txt", contentType: "text/plain", size: 3 })).body.fileId;
    expect((await call(server.url, minh, "POST", `/channels/${ch}/messages`, { body: "x", attachments: [pending] })).status).toBe(400);
  });
});

describe("thread links", () => {
  it("members link a thread to its project; outsiders cannot; links come back with the thread", async () => {
    const ch = (await call(server.url, minh, "POST", "/channels", { kind: "private", name: `link-${newId().slice(-6).toLowerCase()}`, memberIds: ["lan"] })).body.id;
    const root = (await call(server.url, minh, "POST", `/channels/${ch}/messages`, { body: "Dời deadline chiến dịch sang 18/10?" })).body;
    const project = newId();
    expect((await call(server.url, lan, "POST", `/messages/${root.id}/links`, { kind: "project", refId: project, title: "Chiến dịch quý 4" })).status).toBe(204);
    expect((await call(server.url, huy, "POST", `/messages/${root.id}/links`, { kind: "project", refId: project, title: "x" })).status).toBe(403);
    const t = (await call(server.url, lan, "GET", `/messages/${root.id}/thread`)).body;
    expect(t.links).toEqual([{ kind: "project", refId: project, title: "Chiến dịch quý 4", createdBy: "lan" }]);
    expect((await call(server.url, minh, "DELETE", `/messages/${root.id}/links/project/${project}`)).status).toBe(204);
    expect((await call(server.url, lan, "GET", `/messages/${root.id}/thread`)).body.links).toEqual([]);
  });
});

describe("channel settings", () => {
  it("channel admins rename, change topic, archive (read-only, no edits) and restore; others cannot", async () => {
    const id = (await call(server.url, minh, "POST", "/channels", { kind: "public", name: `du-an-${RUN.slice(-6)}`, memberIds: ["lan"] })).body.id;
    const mine = (await call(server.url, lan, "POST", `/channels/${id}/messages`, { body: "tin của Lan" })).body;
    await call(server.url, minh, "POST", `/channels/${id}/messages`, { body: "lịch sử giữ nguyên" });
    expect((await call(server.url, lan, "GET", `/channels/${id}`)).body).toMatchObject({ canManage: false, archived: false, member: true });
    expect((await call(server.url, lan, "PATCH", `/channels/${id}`, { topic: "x" })).status).toBe(403);
    expect((await call(server.url, minh, "PATCH", `/channels/${id}`, { name: "có dấu cách" })).status).toBe(400);
    expect((await call(server.url, minh, "PATCH", `/channels/${id}`, { name: `general-${RUN.slice(-6)}` })).status).toBe(409); // name taken

    const renamed = (await call(server.url, minh, "PATCH", `/channels/${id}`, { name: `ra-mat-${RUN.slice(-6)}`, topic: "Ra mắt Q4" })).body;
    expect(renamed).toMatchObject({ name: `ra-mat-${RUN.slice(-6)}`, topic: "Ra mắt Q4", archived: false });

    // A written name next to the handle: shown everywhere, cleared with "".
    expect((await call(server.url, minh, "PATCH", `/channels/${id}`, { displayName: "Ra mắt sản phẩm" })).body.displayName).toBe("Ra mắt sản phẩm");
    expect((await call(server.url, lan, "GET", "/channels")).body.channels.find((c: { id: string }) => c.id === id).displayName).toBe("Ra mắt sản phẩm");
    expect((await call(server.url, lan, "GET", `/channels/${id}`)).body.displayName).toBe("Ra mắt sản phẩm");
    expect((await call(server.url, minh, "PATCH", `/channels/${id}`, { displayName: "" })).body.displayName).toBeNull();
    const written = (await call(server.url, minh, "POST", "/channels", { kind: "public", name: `ky-thuat-${RUN.slice(-6)}`, displayName: "Kỹ thuật" })).body.id;
    expect((await call(server.url, minh, "GET", `/channels/${written}`)).body).toMatchObject({ name: `ky-thuat-${RUN.slice(-6)}`, displayName: "Kỹ thuật" });

    expect((await call(server.url, minh, "PATCH", `/channels/${id}`, { archived: true })).body.archived).toBe(true);
    expect((await call(server.url, lan, "POST", `/channels/${id}/messages`, { body: "còn ai không?" })).status).toBe(403); // read-only
    expect((await call(server.url, lan, "PATCH", `/messages/${mine.id}`, { body: "sửa sau khi lưu trữ" })).status).toBe(403);
    expect((await call(server.url, lan, "GET", `/channels/${id}/messages`)).body.messages[0].body).toBe("lịch sử giữ nguyên");
    expect((await call(server.url, lan, "GET", "/channels")).body.channels.some((c: { id: string }) => c.id === id)).toBe(false); // off the sidebar
    expect((await call(server.url, lan, "GET", `/channels/${id}`)).body).toMatchObject({ archived: true, name: `ra-mat-${RUN.slice(-6)}` });

    // Workspace admins (channel.manage) can manage any channel, e.g. restore it.
    const admin = { ...huy, grants: [...huy.grants, { permission: "channel.manage", scope: "WORKSPACE" as const }] };
    expect((await call(server.url, admin, "PATCH", `/channels/${id}`, { archived: false })).body.archived).toBe(false);
    expect((await call(server.url, lan, "POST", `/channels/${id}/messages`, { body: "đã mở lại" })).status).toBe(201);
    expect((await call(server.url, lan, "PATCH", `/messages/${mine.id}`, { body: "sửa lại được" })).status).toBe(200);
  });
});

describe("usage stats (admin overview)", () => {
  it("counts people's messages per day for admins only, never content", async () => {
    const admin = { ...minh, grants: [...minh.grants, { permission: "audit.read", scope: "WORKSPACE" as const }] };
    expect((await call(server.url, lan, "GET", "/stats/activity")).status).toBe(403);
    const before = (await call(server.url, admin, "GET", "/stats/activity?days=7&tz=Asia/Ho_Chi_Minh")).body;
    expect(before.days).toHaveLength(7);
    await call(server.url, lan, "POST", `/channels/${general}/messages`, { body: "đếm tôi với" });
    const after = (await call(server.url, admin, "GET", "/stats/activity?days=7&tz=Mars/Base")).body; // unknown zone → default
    expect(after.days.at(-1).messages).toBe(before.days.at(-1).messages + 1);
    expect(after.totals.senders).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(after)).not.toContain("đếm tôi với");
  });
});

describe("importing Slack history", () => {
  it("brings a channel over with time, order and threads; members appear as themselves, others keep their Slack name", async () => {
    const admin = { ...minh, grants: [...minh.grants, { permission: "member.invite", scope: "WORKSPACE" as const }] };
    const t0 = Date.UTC(2025, 5, 1, 2, 0, 0);
    const at = (min: number) => new Date(t0 + min * 60_000).toISOString();
    const body = {
      name: `Dự án Alpha ${RUN.slice(-4)}`,
      topic: "Từ Slack",
      messages: [
        { key: "1.0", threadKey: null, at: at(0), text: "Bắt đầu dự án nhé", userId: "lan", authorName: "Lan" },
        { key: "2.0", threadKey: "1.0", at: at(5), text: "Ok, mình làm phần thiết kế", userId: null, authorName: "Freelancer Tú" },
        { key: "3.0", threadKey: null, at: at(10), text: "Họp lúc 3h", userId: "nobody-here", authorName: "Người cũ" },
        { key: "4.0", threadKey: "9.9", at: at(11), text: "reply to a root that was not exported", userId: null, authorName: "X" },
      ],
    };
    expect((await call(server.url, lan, "POST", "/imports/slack", body)).status).toBe(403);
    const r = await call(server.url, admin, "POST", "/imports/slack", body);
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ imported: 3 });
    expect(r.body.name).toMatch(/^du-an-alpha-/);
    const list = (await call(server.url, admin, "GET", `/channels/${r.body.channelId}/messages`)).body.messages as {
      id: string;
      body: string;
      authorId: string;
      authorType: string;
      importAuthor: string | null;
      createdAt: string;
      replyCount: number;
    }[];
    const byBody = Object.fromEntries(list.map((m) => [m.body, m]));
    expect(byBody["Bắt đầu dự án nhé"]).toMatchObject({ authorId: "lan", authorType: "user", importAuthor: null, replyCount: 1 });
    expect(new Date(byBody["Bắt đầu dự án nhé"]!.createdAt).toISOString()).toBe(at(0));
    expect(byBody["Họp lúc 3h"]).toMatchObject({ authorType: "import", importAuthor: "Người cũ" });
    expect(byBody["Ok, mình làm phần thiết kế"]).toBeUndefined(); // a reply lives in its thread
    // Importing the same channel name again gets a distinct name instead of mixing histories.
    const again = await call(server.url, admin, "POST", "/imports/slack", body);
    expect(again.body.name).not.toBe(r.body.name);
  });
});
