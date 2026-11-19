import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import type { INestApplication } from "@nestjs/common";
import pg from "pg";
import { migrate, signInternalToken, PRINCIPAL_HEADER, S3Storage, ServiceClient } from "@workspace/service-kit";
import { newId, withTransaction, type Principal } from "@workspace/shared";
import { createAiApp, depsFromEnv } from "../../src/modules/ai/app.js";
import { LocalProvider } from "../../src/modules/ai/providers.js";
import { createWorkApp } from "../../src/modules/work/app.js";
import { createEmployeeApp } from "../../src/modules/employee/app.js";
import { createIdentityApp, depsFromEnv as identityDeps } from "../../src/modules/identity/app.js";
import { resetTestDatabase } from "../test-db.js";

/**
 * AI Insights, the person's side (me-insights.ts): links to tasks (hint, suggestion, manual), the one-tap
 * "có giúp", the JSON export and the erasure request an admin handles. Real identity, employee, work and ai apps.
 */
const SECRET = "dev-internal-secret-change-me-32bytes!";
const run = newId().toLowerCase().slice(-8);
const apps: INestApplication[] = [];
const url: Record<string, string> = {};
let aiPool: pg.Pool;
let owner: Principal;
let staff: Principal;

async function call(svc: string, p: Principal, method: string, path: string, body?: unknown) {
  const res = await fetch(`${url[svc]}${path}`, {
    method,
    headers: { "content-type": "application/json", [PRINCIPAL_HEADER]: await signInternalToken({ principal: p, requestId: newId() }, SECRET) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const t = await res.text();
  return { status: res.status, body: t ? JSON.parse(t) : null };
}
const urlOf = async (a: INestApplication) => (await a.getUrl()).replace("[::1]", "127.0.0.1");
const tx = <R>(fn: (c: pg.PoolClient) => Promise<R>) => withTransaction(aiPool, fn);

/** An extension conversation, as the intake would have stored it (fork D2 writes the hint). */
async function conversation(userId: string, title: string, hintTaskId: string | null = null, source = "chatgpt") {
  const id = newId();
  await tx(async (c) => {
    await c.query(
      `INSERT INTO ai_conversations (id, user_id, source, external_key, title, topic, messages, started_at, last_at, hint_task_id)
       VALUES ($1, $2, $6, $3, $4, 'sales', 1, now() - interval '2 hours', now(), $5)`,
      [id, userId, `/c/${id}`, title, hintTaskId, source],
    );
    await c.query("INSERT INTO ai_messages (id, conversation_id, role, content) VALUES ($1, $2, 'user', $3)", [newId(), id, title]);
  });
  return id;
}

beforeAll(async () => {
  await resetTestDatabase();
  for (const [db, dir] of [
    ["identity", "../../migrations/identity"],
    ["work", "../../migrations/work"],
    ["employee", "../../migrations/employee"],
    ["ai", "../../migrations/ai"],
  ] as const) {
    await migrate("postgres://workspace_owner:owner_pw@localhost:5432/workspace_test", fileURLToPath(new URL(dir, import.meta.url)), db);
  }
  const iDeps = identityDeps();
  const idApp = await createIdentityApp(iDeps);
  await idApp.listen(0);
  apps.push(idApp);
  url.identity = await urlOf(idApp);
  const identity = new ServiceClient(url.identity, SECRET, "test", [
    { permission: "workspace.provision", scope: "PLATFORM" },
    { permission: "principal.resolve", scope: "PLATFORM" },
  ]);
  await identity.request("POST", "/internal/workspace/bootstrap", {
    name: "Insights",
    owner: { email: `ins-owner-${run}@example.com`, displayName: "Owner", password: "Passw0rd!dev" },
  });
  owner = await identity.request("POST", "/internal/resolve", { userId: (await iDeps.users.findUserByEmail(`ins-owner-${run}@example.com`))! });
  const emp = await call("identity", owner, "POST", "/members/invite", { email: `ins-staff-${run}@example.com`, displayName: "Mai Staff", password: "Passw0rd!dev" });
  staff = await identity.request("POST", "/internal/resolve", { userId: emp.body.userId });

  const employee = await createEmployeeApp({
    pool: new pg.Pool({ connectionString: "postgres://workspace_employee:app_pw@localhost:5432/workspace_test", max: 3 }),
    internalSecret: SECRET,
  });
  await employee.listen(0);
  apps.push(employee);
  url.employee = await urlOf(employee);
  const work = await createWorkApp({
    pool: new pg.Pool({ connectionString: "postgres://workspace_work:app_pw@localhost:5432/workspace_test", max: 3 }),
    storage: new S3Storage({
      endpoint: "http://localhost:8333",
      region: "auto",
      bucket: "workspace-files",
      accessKeyId: "workspace_dev_key",
      secretAccessKey: "workspace_dev_secret",
    }),
    internalSecret: SECRET,
    employee: new ServiceClient(url.employee, SECRET, "work", []),
  });
  await work.listen(0);
  apps.push(work);
  url.work = await urlOf(work);

  const { deps } = depsFromEnv(new LocalProvider());
  aiPool = deps.pool;
  deps.identity = new ServiceClient(url.identity, SECRET, "ai", [{ permission: "principal.resolve", scope: "PLATFORM" }]);
  deps.services = {
    chat: new ServiceClient("http://127.0.0.1:9", SECRET, "ai", []),
    work: new ServiceClient(url.work, SECRET, "ai", []),
    employee: new ServiceClient(url.employee, SECRET, "ai", []),
  };
  const ai = await createAiApp(deps, SECRET);
  await ai.listen(0);
  apps.push(ai);
  url.ai = await urlOf(ai);
});

afterAll(async () => {
  for (const a of apps.reverse()) await a.close();
});

describe("AI Insights for the person", () => {
  it("shows the extension's hint, links on confirm and tells work the task had AI help", async () => {
    const task = (await call("work", staff, "POST", "/tasks", { title: `Báo giá khách hàng Minh Long ${run}`, assigneeId: staff.id })).body;
    const conv = await conversation(staff.id, `Soạn email báo giá cho khách hàng Minh Long ${run}`, task.id);
    const me = (await call("ai", staff, "GET", "/oversight/me")).body;
    const row = me.insights.conversations.find((x: { id: string }) => x.id === conv);
    expect(row.hint).toMatchObject({ id: task.id, title: task.title });
    expect(row.task).toBeNull();

    const linked = await call("ai", staff, "PUT", `/oversight/me/conversations/${conv}/task`, { taskId: task.id, via: "hint" });
    expect(linked.status).toBe(200);
    const events = await tx(
      async (c) =>
        (
          await c.query<{ payload: { source: string; subjectId: string; usageId: string } }>(
            "SELECT payload->'payload' AS payload FROM outbox WHERE type = 'ai.usage.recorded.v1' AND aggregateid = $1",
            [conv],
          )
        ).rows,
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toMatchObject({ source: "extension", subjectId: task.id, usageId: conv });
    // Linking again to the same task is not a second use.
    await call("ai", staff, "PUT", `/oversight/me/conversations/${conv}/task`, { taskId: task.id, via: "manual" });
    expect(await tx(async (c) => (await c.query("SELECT 1 FROM outbox WHERE type = 'ai.usage.recorded.v1' AND aggregateid = $1", [conv])).rowCount)).toBe(1);
    const after = (await call("ai", staff, "GET", "/oversight/me")).body.insights.conversations.find((x: { id: string }) => x.id === conv);
    expect(after).toMatchObject({ task: { id: task.id }, hint: null });
  });

  it("suggests my tasks by full text, and nobody else's", async () => {
    const mine = (await call("work", staff, "POST", "/tasks", { title: `Kế hoạch tuyển dụng quý 4 ${run}`, assigneeId: staff.id })).body;
    await call("work", owner, "POST", "/tasks", { title: `Kế hoạch tuyển dụng quý 4 sếp ${run}`, assigneeId: owner.id });
    const conv = await conversation(staff.id, `Giúp tôi viết kế hoạch tuyển dụng`);
    const s = (await call("ai", staff, "GET", `/oversight/me/conversations/${conv}/suggestions`)).body;
    expect(s.tasks.map((t: { id: string }) => t.id)).toContain(mine.id);
    expect(s.tasks.every((t: { title: string }) => !t.title.includes("sếp"))).toBe(true);
    const search = (await call("ai", staff, "GET", `/oversight/me/tasks?q=${encodeURIComponent("tuyển dụng")}`)).body;
    expect(search.tasks.map((t: { id: string }) => t.id)).toContain(mine.id);
  });

  it("only the owner of a conversation answers 'did AI help' or links it", async () => {
    const conv = await conversation(staff.id, "Dịch hợp đồng sang tiếng Anh");
    expect((await call("ai", owner, "PUT", `/oversight/me/conversations/${conv}/helpful`, { helpful: "yes" })).status).toBe(404);
    expect((await call("ai", staff, "PUT", `/oversight/me/conversations/${conv}/helpful`, { helpful: "partly" })).status).toBe(200);
    const me = (await call("ai", staff, "GET", "/oversight/me")).body.insights;
    expect(me.week.helpful.partly).toBeGreaterThanOrEqual(1);
    const task = (await call("work", owner, "POST", "/tasks", { title: `Việc riêng của sếp ${run}`, assigneeId: owner.id })).body;
    // A task the person cannot see is "not found", even with a valid id.
    expect((await call("ai", staff, "PUT", `/oversight/me/conversations/${conv}/task`, { taskId: task.id })).status).toBe(404);
  });

  it("renames only my own Trợ lý AI conversations, masking the new title like a generated one", async () => {
    const conv = await conversation(staff.id, "Soạn email báo giá", null, "company");
    const other = await conversation(staff.id, "Dịch tài liệu");
    expect((await call("ai", owner, "PATCH", `/assistant/conversations/${conv}`, { title: "Của sếp" })).status).toBe(404);
    // An extension conversation is not the assistant's: it keeps the title its site gave it.
    expect((await call("ai", staff, "PATCH", `/assistant/conversations/${other}`, { title: "Khác" })).status).toBe(404);
    expect((await call("ai", staff, "PATCH", `/assistant/conversations/${conv}`, { title: "  " })).status).toBe(400);
    const r = await call("ai", staff, "PATCH", `/assistant/conversations/${conv}`, { title: "Báo giá cho khách, gọi 0912345678" });
    expect(r.status).toBe(200);
    expect(r.body.title).not.toContain("0912345678");
    const list = (await call("ai", staff, "GET", "/assistant/conversations")).body.conversations;
    expect(list.find((x: { id: string }) => x.id === conv).title).toBe(r.body.title);
  });

  it("deletes only my own Trợ lý AI conversation, with its messages and a paused answer", async () => {
    const conv = await conversation(staff.id, "Soạn thư mời họp", null, "company");
    const other = await conversation(staff.id, "Tóm tắt báo cáo");
    await tx((c) =>
      c.query("INSERT INTO mcp_pending (id, user_id, conversation_id, server_id, tool, state) VALUES ($1, $2, $3, 'workspace', 'update_task', '{}')", [newId(), staff.id, conv]),
    );
    expect((await call("ai", owner, "DELETE", `/assistant/conversations/${conv}`)).status).toBe(404);
    // An extension conversation is not the assistant's: the person deletes it in Của tôi › AI, not here.
    expect((await call("ai", staff, "DELETE", `/assistant/conversations/${other}`)).status).toBe(404);
    expect((await call("ai", staff, "DELETE", `/assistant/conversations/${conv}`)).status).toBe(200);
    expect((await call("ai", staff, "GET", `/assistant/conversations/${conv}`)).status).toBe(404);
    const left = await tx(async (c) => ({
      messages: (await c.query("SELECT 1 FROM ai_messages WHERE conversation_id = $1", [conv])).rowCount,
      pending: (await c.query("SELECT 1 FROM mcp_pending WHERE conversation_id = $1", [conv])).rowCount,
    }));
    expect(left).toEqual({ messages: 0, pending: 0 });
    expect((await call("ai", staff, "DELETE", `/assistant/conversations/${conv}`)).status).toBe(404);
  });

  it("answers my last Trợ lý AI question again in place of the old answer", async () => {
    // The built-in model stands in for a connected one (the not-configured guard lets it through).
    process.env.AI_LOCAL_MODEL = "1";
    try {
      const conv = await conversation(staff.id, "Tôi có việc gì?", null, "company");
      expect((await call("ai", staff, "POST", `/assistant/conversations/${conv}/regenerate`, {})).status).toBe(404);
      await tx((c) => c.query("INSERT INTO ai_messages (id, conversation_id, role, content, at) VALUES ($1, $2, 'assistant', 'câu trả lời cũ', now())", [newId(), conv]));
      expect((await call("ai", owner, "POST", `/assistant/conversations/${conv}/regenerate`, {})).status).toBe(404);
      const r = await call("ai", staff, "POST", `/assistant/conversations/${conv}/regenerate`, {});
      expect(r.status).toBe(201);
      expect(r.body.answer).toBeTruthy();
      const msgs = (await call("ai", staff, "GET", `/assistant/conversations/${conv}`)).body.messages;
      expect(msgs.map((m: { role: string }) => m.role)).toEqual(["user", "assistant"]);
      expect(msgs[1].content).toBe(r.body.answer);
    } finally {
      delete process.env.AI_LOCAL_MODEL;
    }
  });

  it("exports everything about me, and an admin's 'done' on my erasure request deletes it", async () => {
    const conv = await conversation(staff.id, "Tóm tắt báo cáo doanh thu");
    const exp = (await call("ai", staff, "GET", "/oversight/me/export")).body;
    expect(exp.conversations.find((x: { id: string }) => x.id === conv).messages).toHaveLength(1);
    const req1 = (await call("ai", staff, "POST", "/oversight/me/erasure", { note: "please" })).body;
    // One open request at a time.
    expect((await call("ai", staff, "POST", "/oversight/me/erasure", {})).body.id).toBe(req1.id);
    expect((await call("ai", staff, "GET", "/oversight/erasure-requests")).status).toBe(403);
    const list = (await call("ai", owner, "GET", "/oversight/erasure-requests")).body.requests;
    expect(list.find((r: { id: string }) => r.id === req1.id)).toMatchObject({ userId: staff.id, status: "open" });
    const done = (await call("ai", owner, "POST", `/oversight/erasure-requests/${req1.id}`, { status: "done" })).body;
    expect(done.status).toBe("done");
    expect(await tx(async (c) => (await c.query("SELECT 1 FROM ai_conversations WHERE user_id = $1", [staff.id])).rowCount)).toBe(0);
    const me = (await call("ai", staff, "GET", "/oversight/me")).body.insights;
    expect(me.erasure[0]).toMatchObject({ id: req1.id, status: "done" });
  });
});
