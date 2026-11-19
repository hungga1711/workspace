import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import { io as ioClient, type Socket } from "socket.io-client";
import pg from "pg";
import { migrate, signInternalToken, PRINCIPAL_HEADER } from "@workspace/service-kit";
import { newId, type Principal } from "@workspace/shared";
import { callNote, type Call } from "../../src/modules/chat/calls.js";
import { resetTestDatabase } from "../test-db.js";

/**
 * One-to-one calls: ringing reaches the person called on every device, one answer wins, and the DM keeps
 * what happened (missed, declined, how long). The work module (rooms) is faked.
 */
process.env.CALL_RING_MS = "1500";
const { createChatApp, depsFromEnv } = await import("../../src/modules/chat/app.js");

const SECRET = "dev-internal-secret-change-me-32bytes!";
const EMP = ["channel.create", "channel.read", "message.post", "message.read"].map((permission) => ({ permission, scope: "WORKSPACE" as const }));
const user = (id: string): Principal => ({ type: "user", id, teamIds: [], departmentId: null, grants: EMP });
const minh = user("minh");
const lan = user("lan");
const huy = user("huy");

let fake: Server;
let server: { url: string; close: () => Promise<void> };
const sockets: Socket[] = [];

beforeAll(async () => {
  await resetTestDatabase();
  await migrate("postgres://workspace_owner:owner_pw@localhost:5432/workspace_test", fileURLToPath(new URL("../../migrations/chat", import.meta.url)), "chat");
  const owner = new pg.Client("postgres://workspace_owner:owner_pw@localhost:5432/workspace_test?options=-c%20search_path%3Dchat");
  await owner.connect();
  for (const u of ["minh", "lan", "huy"]) await owner.query("INSERT INTO known_members (user_id) VALUES ($1) ON CONFLICT DO NOTHING", [u]);
  // Huy has Do not disturb on for the next hour.
  await owner.query("INSERT INTO user_status (user_id, dnd_until) VALUES ('huy', now() + interval '1 hour')");
  await owner.end();
  fake = createServer((req, res) => {
    if (req.method === "POST" && req.url === "/meet/rooms") {
      return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ code: "abc-defg-hij" }));
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => fake.listen(r));
  const workUrl = `http://127.0.0.1:${(fake.address() as { port: number }).port}`;
  const { app, listen } = await createChatApp({ ...depsFromEnv(), workUrl });
  server = { url: `http://127.0.0.1:${await listen(0)}`, close: () => app.close() };
});

afterAll(async () => {
  sockets.forEach((s) => s.disconnect());
  await server?.close();
  fake.close();
});

async function call(p: Principal, method: string, path: string, body?: unknown) {
  const res = await fetch(`${server.url}${path}`, {
    method,
    // The call lines are asserted in Vietnamese; English is the default, so ask for Vietnamese.
    headers: { "content-type": "application/json", "x-locale": "vi", [PRINCIPAL_HEADER]: await signInternalToken({ principal: p, requestId: newId() }, SECRET) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const t = await res.text();
  return { status: res.status, body: t ? JSON.parse(t) : null };
}

async function listen(p: Principal): Promise<{ name: string; data: any }[]> {
  const s = ioClient(server.url, {
    auth: { ticket: await signInternalToken({ principal: p, requestId: newId() }, SECRET) },
    transports: ["websocket"],
    forceNew: true,
  });
  sockets.push(s);

  const events: { name: string; data: any }[] = [];
  s.onAny((name, data) => events.push({ name, data }));
  await new Promise<void>((resolve, reject) => {
    s.once("ready", () => resolve());
    s.once("connect_error", reject);
  });
  return events;
}
const until = async (pred: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 25));
  }
};
const lastNote = async (p: Principal, channelId: string) => (await call(p, "GET", `/channels/${channelId}/messages?limit=1`)).body.messages[0]?.body as string;

describe("calls", () => {
  it("writes the DM line for each outcome", () => {
    const c: Call = { id: "x", from: "a", to: "b", video: false, code: "c", channelId: "d", state: "ended", startedAt: 0, acceptedAt: 1000, endedAt: 186_000 };
    expect(callNote(c, "ended", false)).toBe("📞 Cuộc gọi thoại · 3 phút");
    expect(callNote({ ...c, video: true }, "missed", false)).toBe("📞 Cuộc gọi video nhỡ");
    expect(callNote(c, "declined", true)).toBe("📞 Voice call declined");
  });

  it("rings the person called on every device; the first answer wins; hanging up ends it for both with its length", async () => {
    const lanPhone = await listen(lan);
    const lanLaptop = await listen(lan);
    const minhTab = await listen(minh);
    const r = await call(minh, "POST", "/calls", { userId: "lan", video: true });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ from: "minh", to: "lan", video: true, state: "ringing" });
    await until(() => lanPhone.some((e) => e.name === "call:ring") && lanLaptop.some((e) => e.name === "call:ring"));
    expect(minhTab.some((e) => e.name === "call:ring")).toBe(false);

    // Strangers do not see it; only Lan answers it.
    expect((await call(huy, "GET", `/calls/${r.body.id}`)).status).toBe(404);
    expect((await call(minh, "POST", `/calls/${r.body.id}/accept`)).status).toBe(403);
    const [a, b] = await Promise.all([call(lan, "POST", `/calls/${r.body.id}/accept`), call(lan, "POST", `/calls/${r.body.id}/accept`)]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    await until(() => minhTab.some((e) => e.name === "call:accepted") && lanLaptop.some((e) => e.name === "call:accepted"));

    // Someone else calling Lan now hears she is busy.
    expect((await call(huy, "POST", "/calls", { userId: "lan" })).body).toMatchObject({ error: "busy" });

    expect((await call(lan, "POST", `/calls/${r.body.id}/hangup`)).body.state).toBe("ended");
    await until(() => minhTab.some((e) => e.name === "call:ended"));
    expect(await lastNote(minh, r.body.channelId)).toMatch(/^📞 Cuộc gọi video · \d+ giây$/);
    // The line is free again.
    const again = await call(huy, "POST", "/calls", { userId: "lan" });
    expect(again.status).toBe(201);
    await call(huy, "POST", `/calls/${again.body.id}/hangup`);
  });

  it("declined, cancelled and unanswered calls end the ring and leave a line in the DM", async () => {
    const minhTab = await listen(minh);
    const d = (await call(minh, "POST", "/calls", { userId: "lan" })).body;
    expect((await call(lan, "POST", `/calls/${d.id}/decline`)).body.state).toBe("declined");
    await until(() => minhTab.some((e) => e.name === "call:declined" && e.data.id === d.id));
    expect(await lastNote(lan, d.channelId)).toBe("📞 Cuộc gọi thoại bị từ chối");

    const lanTab = await listen(lan);
    const c = (await call(minh, "POST", "/calls", { userId: "lan" })).body;
    expect((await call(minh, "POST", `/calls/${c.id}/hangup`)).body.state).toBe("cancelled");
    await until(() => lanTab.some((e) => e.name === "call:cancelled" && e.data.id === c.id));
    expect(await lastNote(lan, c.channelId)).toBe("📞 Cuộc gọi thoại nhỡ");

    const m = (await call(minh, "POST", "/calls", { userId: "lan" })).body;
    await until(() => lanTab.some((e) => e.name === "call:missed" && e.data.id === m.id), 5000);
    expect((await call(lan, "POST", `/calls/${m.id}/accept`)).status).toBe(409);
  });

  it("does not ring someone on Do not disturb, nor yourself", async () => {
    expect((await call(minh, "POST", "/calls", { userId: "huy" })).body).toMatchObject({ error: "dnd" });
    expect((await call(minh, "POST", "/calls", { userId: "minh" })).status).toBe(400);
  });
});
