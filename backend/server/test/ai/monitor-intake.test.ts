import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import type { INestApplication } from "@nestjs/common";
import { migrate, PRINCIPAL_HEADER, ServiceClient, signInternalToken } from "@workspace/service-kit";
import { newId, withTransaction, type Principal } from "@workspace/shared";
import { createAiApp, depsFromEnv } from "../../src/modules/ai/app.js";
import { LocalProvider } from "../../src/modules/ai/providers.js";

const SECRET = "dev-internal-secret-change-me-32bytes!";
const admin: Principal = {
  type: "user",
  id: newId(),
  teamIds: [],
  departmentId: null,
  grants: [
    { permission: "ai.use", scope: "WORKSPACE" },
    { permission: "ai.policy.manage", scope: "WORKSPACE" },
  ],
} as Principal;
const staff: Principal = { ...admin, id: newId(), grants: [{ permission: "ai.use", scope: "WORKSPACE" }] } as Principal;
const gateway = {
  type: "service",
  id: "gateway",
  teamIds: [],
  departmentId: null,
  grants: [{ permission: "principal.resolve", scope: "PLATFORM" }],
} as unknown as Principal;

let app: INestApplication;
let base: string;
let employees: Server;
let pool: import("pg").Pool;

async function call(p: Principal, method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json", [PRINCIPAL_HEADER]: await signInternalToken({ principal: p, requestId: newId() }, SECRET) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const t = await res.text();
  return { status: res.status, body: t ? JSON.parse(t) : null };
}
const q = <R>(sql: string, args: unknown[] = []) => withTransaction(pool, async (c) => (await c.query(sql, args)).rows as R[]);

beforeAll(async () => {
  await migrate("postgres://workspace_owner:owner_pw@localhost:5432/workspace_test", fileURLToPath(new URL("../../migrations/ai", import.meta.url)), "ai");
  // Employee module stand-in: the directory the oversight audience is built from.
  employees = createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ employees: [{ userId: staff.id, displayName: "Lan", department: "Sales" }], reports: [] }));
  });
  await new Promise<void>((r) => employees.listen(0, "127.0.0.1", r));
  const empUrl = `http://127.0.0.1:${(employees.address() as { port: number }).port}`;
  const { deps } = depsFromEnv(new LocalProvider());
  pool = deps.pool;
  // The workspace's keywords and policy are shared by every suite on the test database: start from none.
  await pool.query("DELETE FROM ai_keywords");
  await pool.query("DELETE FROM ai_policy");
  const nowhere = new ServiceClient("http://127.0.0.1:1", SECRET, "ai", []);
  deps.identity = nowhere;
  delete deps.platform;
  deps.services = { ...deps.services, employee: new ServiceClient(empUrl, SECRET, "ai", []) };
  app = await createAiApp(deps, SECRET);
  await app.listen(0);
  base = (await app.getUrl()).replace("[::1]", "127.0.0.1");
});

afterAll(async () => {
  await app?.close();
  employees?.close();
});

describe("extension intake (AI Insights)", () => {
  let token: string;
  const send = (events: unknown[]) => call(gateway, "POST", "/internal/monitor/events", { token, events });

  it("tells the extension the safety mode and the company keywords", async () => {
    token = (await call(staff, "POST", "/monitor/connection")).body.token;
    expect((await call(staff, "POST", "/policy/keywords", { term: "Sao Mai" })).status).toBe(403);
    expect((await call(admin, "POST", "/policy/keywords", { term: "Sao Mai", label: "khách hàng" })).status).toBe(201);
    expect((await call(admin, "POST", "/policy/keywords", { term: "sao mai" })).status).toBe(409);
    expect((await call(admin, "PUT", "/policy", { detail: "summary", captureResponses: false, retentionDays: 180, sensitiveMode: "redact" })).body.policy.sensitiveMode).toBe(
      "redact",
    );
    // A client that does not know the mode keeps it.
    expect((await call(admin, "PUT", "/policy", { detail: "topic", captureResponses: false, retentionDays: 180 })).body.policy.sensitiveMode).toBe("redact");
    const ping = await send([]);
    expect(ping).toMatchObject({ status: 201 });
    expect(ping.body).toEqual({ accepted: 0, captureResponses: false, sensitiveMode: "redact", keywords: ["Sao Mai"] });
  });

  it("records redacted turns, hints, safety events and feedback without the removed text", async () => {
    const at = new Date().toISOString();
    const url = "https://chat.deepseek.com/a/chat/s/abc123";
    const r = await send([
      {
        url,
        conversation: "/a/chat/s/abc123",
        prompt: "Báo giá cho [KEYWORD], CCCD [CCCD]",
        model: "",
        at,
        hint: { taskId: "task_0123456789", seenAt: at },
        redactions: { keyword: 1, personal_id: 1 },
      },
      { kind: "safety", url: "https://grok.com/", action: "block", kinds: ["card"], at },
      { kind: "feedback", url, conversation: "/a/chat/s/abc123", helpful: "partly", at },
      { kind: "safety", url: "https://example.com/", action: "warn", kinds: ["card"], at },
    ]);
    expect(r.body.accepted).toBe(3);
    const [conv] = await q<{ source: string; hint_task_id: string; helpful: string; sensitive: string[]; task_id: string | null }>(
      "SELECT source, hint_task_id, helpful, sensitive, task_id FROM ai_conversations WHERE user_id = $1",
      [staff.id],
    );
    expect(conv).toMatchObject({ source: "deepseek", hint_task_id: "task_0123456789", helpful: "partly", task_id: null });
    expect(conv!.sensitive.sort()).toEqual(["keyword", "personal_id"]);
    const safety = await q<{ action: string; count: number; source: string }>("SELECT action, count, source FROM ai_safety_events WHERE user_id = $1 ORDER BY action", [staff.id]);
    expect(safety).toEqual([
      { action: "block", count: 1, source: "grok" },
      { action: "redact", count: 2, source: "deepseek" },
    ]);
  });

  it("adds each prompt to the hourly rollup the oversight charts read", async () => {
    const rows = await q<{ source: string; feature: string; prompts: number }>("SELECT source, feature, prompts FROM ai_hourly_stats WHERE user_id = $1 ORDER BY source", [
      staff.id,
    ]);
    expect(rows).toEqual([{ source: "deepseek", feature: "", prompts: 1 }]);
    const r = await call(admin, "GET", "/oversight?days=7");
    expect(r.status).toBe(200);
    const today = r.body.daily.find((d: { source: string }) => d.source === "deepseek");
    expect(today).toMatchObject({ prompts: 1 });
    expect(r.body.weekly).toHaveLength(8);
    expect(r.body.weekly.at(-1)).toMatchObject({ prompts: 1, people: 1, cost: 0 });
  });

  it("ignores a stale hint", async () => {
    const at = new Date().toISOString();
    await send([
      {
        url: "https://chatgpt.com/c/old-hint",
        conversation: "/c/old-hint",
        prompt: "Viết email",
        at,
        hint: { taskId: "task_9999999999", seenAt: new Date(Date.now() - 3 * 3600_000).toISOString() },
      },
    ]);
    const [conv] = await q<{ hint_task_id: string | null }>("SELECT hint_task_id FROM ai_conversations WHERE external_key = '/c/old-hint' AND user_id = $1", [staff.id]);
    expect(conv!.hint_task_id).toBeNull();
  });

  it("counts warned / redacted / blocked sends per person and department for admins", async () => {
    const r = await call(admin, "GET", "/oversight/safety?days=7");
    expect(r.body.total).toEqual({ warn: 0, redact: 2, block: 1 });
    expect(r.body.people).toEqual([{ userId: staff.id, name: "Lan", department: "Sales", warn: 0, redact: 2, block: 1 }]);
    expect(r.body.departments).toEqual([{ department: "Sales", warn: 0, redact: 2, block: 1 }]);
  });
});
