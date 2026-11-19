import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { migrate, signInternalToken, PRINCIPAL_HEADER } from "@workspace/service-kit";
import { newId, type Principal } from "@workspace/shared";
import { createChatApp, depsFromEnv } from "../../src/modules/chat/app.js";
import { resetTestDatabase } from "../test-db.js";
import pg from "pg";

/** The reads behind the AI's chat tools: a channel since last read or a time, and questions nobody answered. */
const SECRET = "dev-internal-secret-change-me-32bytes!";
const DB = "postgres://workspace_owner:owner_pw@localhost:5432/workspace_test?options=-c%20search_path%3Dchat";
const EMP = ["channel.create", "channel.read", "message.post", "message.read"].map((permission) => ({ permission, scope: "WORKSPACE" as const }));
const user = (id: string): Principal => ({ type: "user", id, teamIds: [], departmentId: null, grants: EMP });
const minh = user("minh");
const lan = user("lan");
const huy = user("huy");

let server: { close: () => Promise<void>; url: string };
async function call(p: Principal, method: string, path: string, body?: unknown) {
  const res = await fetch(`${server.url}${path}`, {
    method,
    headers: { "content-type": "application/json", [PRINCIPAL_HEADER]: await signInternalToken({ principal: p, requestId: newId() }, SECRET) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const t = await res.text();
  return { status: res.status, body: t ? JSON.parse(t) : null };
}
const post = async (p: Principal, ch: string, body: string, threadRootId?: string): Promise<{ id: string; seq: number }> =>
  (await call(p, "POST", `/channels/${ch}/messages`, { body, ...(threadRootId ? { threadRootId } : {}) })).body;

let owner: pg.Client;
/** Messages are only "unanswered" after some hours: move one back in time. */
const age = (id: string, hours: number) => owner.query("UPDATE messages SET created_at = now() - make_interval(hours => $2::int) WHERE id = $1", [id, hours]);

beforeAll(async () => {
  await resetTestDatabase();
  await migrate("postgres://workspace_owner:owner_pw@localhost:5432/workspace_test", fileURLToPath(new URL("../../migrations/chat", import.meta.url)), "chat");
  owner = new pg.Client(DB);
  await owner.connect();
  for (const u of ["minh", "lan", "huy"]) await owner.query("INSERT INTO known_members (user_id) VALUES ($1) ON CONFLICT DO NOTHING", [u]);
  const { app, listen } = await createChatApp(depsFromEnv());
  const port = await listen(0);
  server = { url: `http://127.0.0.1:${port}`, close: () => app.close() };
});

afterAll(async () => {
  await owner?.end();
  await server?.close();
});

describe("chat reads for the assistant", () => {
  it("reads a channel since the person last read it, or since a time, oldest first", async () => {
    const ch = (await call(minh, "POST", "/channels", { kind: "public", name: `ops-${newId().slice(-6)}`, memberIds: ["lan"] })).body.id;
    await post(minh, ch, "old news");
    const seen = (await call(lan, "GET", `/channels/${ch}/messages?limit=1`)).body.messages[0];
    await call(lan, "POST", `/channels/${ch}/read`, { seq: seen.seq });
    await post(minh, ch, "first new");
    await post(minh, ch, "second new");
    const w = (await call(lan, "GET", `/assist/channels/${ch}/window`)).body;
    expect(w.fromLastRead).toBe(true);
    expect(w.messages.map((m: { body: string }) => m.body)).toEqual(["first new", "second new"]);
    const all = (await call(lan, "GET", `/assist/channels/${ch}/window?since=${encodeURIComponent(new Date(Date.now() - 3_600_000).toISOString())}&limit=2`)).body;
    expect(all.more).toBe(true);
    expect(all.messages.map((m: { body: string }) => m.body)).toEqual(["first new", "second new"]);
    // Not a member of a private channel: nothing to read.
    const priv = (await call(minh, "POST", "/channels", { kind: "private", name: `hr-${newId().slice(-6)}`, memberIds: [] })).body.id;
    expect((await call(huy, "GET", `/assist/channels/${priv}/window`)).status).toBe(403);
  });

  it("lists questions to the person that nobody answered", async () => {
    const dm = (await call(huy, "POST", "/dms", { userId: "lan" })).body.id;
    const ch = (await call(minh, "POST", "/channels", { kind: "public", name: `sales-${newId().slice(-6)}`, memberIds: ["lan", "huy"] })).body.id;
    const askDm = await post(huy, dm, "Chị gửi giúp em báo giá được không");
    const mention = await post(minh, ch, "<@lan> khi nào xong slide");
    const statement = await post(minh, ch, "<@lan> cảm ơn chị");
    const answered = await post(minh, ch, "<@lan> can you check the invoice?");
    const notMine = await post(minh, ch, "<@huy> can you check the invoice?");
    for (const m of [askDm, mention, statement, answered, notMine]) await age(m.id, 6);
    await post(huy, ch, "done", answered.id);
    const fresh = await post(minh, ch, "<@lan> one more question?");
    const ids = async (path: string, p = lan) => (await call(p, "GET", path)).body.questions.map((q: { id: string }) => q.id);

    const qs = await ids("/assist/unanswered?hours=4");
    expect(qs).toEqual(expect.arrayContaining([askDm.id, mention.id]));
    for (const id of [statement.id, answered.id, notMine.id, fresh.id]) expect(qs).not.toContain(id);
    expect(await ids("/assist/unanswered?hours=4&direct=1")).toEqual([askDm.id]);
    // The asker is not the one to answer.
    expect(await ids("/assist/unanswered?hours=0", huy)).not.toContain(askDm.id);
    // Lan answers in the direct conversation, and reacts to the mention: both are done.
    await post(lan, dm, "đây em");
    await call(lan, "POST", `/messages/${mention.id}/reactions`, { emoji: "👍" });
    const after = await ids("/assist/unanswered?hours=4");
    expect(after).not.toContain(askDm.id);
    expect(after).not.toContain(mention.id);
  });
});
