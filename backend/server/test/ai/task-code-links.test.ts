import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import type { INestApplication } from "@nestjs/common";
import { migrate, PRINCIPAL_HEADER, ServiceClient, signInternalToken } from "@workspace/service-kit";
import { newId, withTransaction, type Principal } from "@workspace/shared";
import { createAiApp, depsFromEnv } from "../../src/modules/ai/app.js";
import { LocalProvider } from "../../src/modules/ai/providers.js";

/**
 * A task code typed in a prompt (T-157) becomes a link suggestion, and the extension's "Link this chat to T-157?"
 * links it, both only for a task the person can read (work answers as them).
 */
const SECRET = "dev-internal-secret-change-me-32bytes!";
const staff: Principal = { type: "user", id: newId(), teamIds: [], departmentId: null, grants: [{ permission: "ai.use", scope: "WORKSPACE" }] } as Principal;
const gateway = { type: "service", id: "gateway", teamIds: [], departmentId: null, grants: [{ permission: "principal.resolve", scope: "PLATFORM" }] } as unknown as Principal;
const TASK = { id: "task_t157_0000000000", code: "T-157", title: "Quarterly report", status: "in_progress", completedAt: null };

let app: INestApplication;
let base: string;
let stub: Server;
let pool: import("pg").Pool;
const lookups: string[] = [];

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
  // Identity (who the token's owner is) and work (which tasks they may read), in one stand-in.
  stub = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url?.startsWith("/internal/resolve")) return void res.end(JSON.stringify(staff));
    if (req.url?.startsWith("/me/tasks/lookup")) {
      lookups.push(req.url);
      const codes = new URL(req.url, "http://x").searchParams.get("codes")?.split(",") ?? [];
      const ids = new URL(req.url, "http://x").searchParams.get("ids")?.split(",") ?? [];
      return void res.end(JSON.stringify({ tasks: codes.includes("T-157") || ids.includes(TASK.id) ? [TASK] : [] }));
    }
    if (req.url?.startsWith("/me/ai-outcomes")) return void res.end(JSON.stringify(null));
    res.end(JSON.stringify({ employees: [], reports: [] }));
  });
  await new Promise<void>((r) => stub.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(stub.address() as { port: number }).port}`;
  const { deps } = depsFromEnv(new LocalProvider());
  pool = deps.pool;
  await pool.query("DELETE FROM ai_policy");
  deps.identity = new ServiceClient(url, SECRET, "ai", []);
  delete deps.platform;
  deps.services = { ...deps.services, work: new ServiceClient(url, SECRET, "ai", []), employee: new ServiceClient(url, SECRET, "ai", []) };
  app = await createAiApp(deps, SECRET);
  await app.listen(0);
  base = (await app.getUrl()).replace("[::1]", "127.0.0.1");
});

afterAll(async () => {
  await app?.close();
  stub?.close();
});

describe("task codes in prompts", () => {
  let token: string;
  const send = (events: unknown[]) => call(gateway, "POST", "/internal/monitor/events", { token, events });
  const conv = (key: string) =>
    q<{ hint_task_code: string | null; hint_task_id: string | null; task_id: string | null; task_link: string | null }>(
      "SELECT hint_task_code, hint_task_id, task_id, task_link FROM ai_conversations WHERE user_id = $1 AND external_key = $2",
      [staff.id, key],
    ).then((r) => r[0]);

  it("keeps the codes a prompt names and suggests the first one the person can see", async () => {
    token = (await call(staff, "POST", "/monitor/connection")).body.token;
    const at = new Date().toISOString();
    await send([{ url: "https://claude.ai/chat/a1", conversation: "/chat/a1", prompt: "Compare GPT-4 with OPS-99 and T-157 for the report", at }]);
    expect(await conv("/chat/a1")).toMatchObject({ hint_task_code: "OPS-99,T-157", hint_task_id: null, task_id: null });
    const me = await call(staff, "GET", "/oversight/me");
    expect(me.status).toBe(200);
    const row = me.body.insights.conversations.find((c: { title: string }) => c.title.includes("OPS-99"));
    expect(row.hint).toMatchObject({ id: TASK.id, code: "T-157" });
    expect(row.hintFrom).toBe("code");
    expect(lookups.some((u) => u.includes("codes="))).toBe(true);
    // A suggestion alone never counts for the task.
    expect((await conv("/chat/a1"))!.task_id).toBeNull();
  });

  it("links on the extension's confirm, only to a task the person can read", async () => {
    const at = new Date().toISOString();
    await send([{ url: "https://chatgpt.com/c/b2", conversation: "/c/b2", prompt: "Summarise T-157 and T-404", at }]);
    const r = await send([
      { kind: "link", url: "https://chatgpt.com/c/b2", conversation: "/c/b2", code: "T-404", at },
      { kind: "link", url: "https://chatgpt.com/c/b2", conversation: "/c/b2", code: "T-157", at },
    ]);
    expect(r.body.accepted).toBe(1);
    expect(await conv("/c/b2")).toMatchObject({ task_id: TASK.id, task_link: "hint", hint_task_code: null });
    const [usage] = await q<{ n: number }>(
      "SELECT count(*)::int AS n FROM outbox WHERE type = 'ai.usage.recorded.v1' AND payload->'payload'->>'subjectId' = $1 AND payload->'payload'->>'userId' = $2",
      [TASK.id, staff.id],
    );
    expect(usage!.n).toBe(1);
  });

  it("drops the suggestion on Not this task", async () => {
    const at = new Date().toISOString();
    await send([{ url: "https://gemini.google.com/app/c3", conversation: "/app/c3", prompt: "Draft T-157 notes", at }]);
    await send([{ kind: "link", url: "https://gemini.google.com/app/c3", conversation: "/app/c3", code: "T-157", decline: true, at }]);
    expect(await conv("/app/c3")).toMatchObject({ hint_task_code: null, hint_task_id: null, task_id: null });
  });
});
