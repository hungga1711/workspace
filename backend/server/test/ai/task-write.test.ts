import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { INestApplication } from "@nestjs/common";
import { kv, PRINCIPAL_HEADER, ServiceCallError, signInternalToken } from "@workspace/service-kit";
import { newId, type Principal } from "@workspace/shared";
import { createAiApp, depsFromEnv } from "../../src/modules/ai/app.js";
import type { ModelProvider, ModelRequest, ModelResponse } from "../../src/modules/ai/providers.js";

const SECRET = "dev-internal-secret-change-me-32bytes!";

/**
 * "AI viết giúp" (POST /tasks/write) in the ai module: `ai.use` is required, an existing task must be readable by the
 * caller (the work module is asked AS them), the use is metered as `task_write` on that task, mentions never reach the
 * model as ids, and nothing is written anywhere. The work module is a fake that records who asked.
 */

class ScriptedProvider implements ModelProvider {
  readonly name = "scripted";
  requests: ModelRequest[] = [];
  reply = "{}";
  async generate(req: ModelRequest): Promise<ModelResponse> {
    this.requests.push(req);
    return { text: this.reply, toolCalls: [], usage: { inputTokens: 40, outputTokens: 20 }, model: "scripted" };
  }
}
const model = new ScriptedProvider();

const TASK = "01TASKWRITE000000000000000";
const calls: { path: string; as: string; method: string }[] = [];
const fake = (handler: (path: string, as: Principal) => unknown) => ({
  async request<R>(method: string, path: string, _b?: unknown, as?: Principal): Promise<R> {
    calls.push({ path, as: as?.id ?? "service", method });
    const r = handler(path, as!);
    if (r === undefined) throw new ServiceCallError(404, { error: "not found" }, `GET ${path} → 404`);
    return r as R;
  },
});
// Lan can open the task and its project; Huy cannot open either.
const work = fake((path, as) => {
  if (as.id !== "lan") return undefined;
  if (path === `/tasks/WEB-9` || path === `/tasks/${TASK}`)
    return { task: { id: TASK, code: "WEB-9", title: "fix login", description: "", projectId: "01PROJECT0000000000000000A" }, subtasks: [{ title: "Reproduce" }] };
  if (path === `/tasks/${TASK}/related`) return { docs: [{ title: "Auth runbook" }], similar: [] };
  if (path === "/projects/01PROJECT0000000000000000A") return { name: "Website", description: "The public site" };
  return undefined;
});
const employee = fake(() => ({ departmentId: null }));
const chat = fake(() => ({ hits: [] }));

let ai: INestApplication;
let aiUrl = "";
let pool: import("pg").Pool;
const person = (id: string, perms: string[]): Principal => ({
  type: "user",
  id,
  teamIds: [],
  departmentId: "dep-web",
  grants: perms.map((permission) => ({ permission, scope: "WORKSPACE" as const })),
});
const lan = person("lan", ["ai.use", "task.read"]);
const huy = person("huy", ["ai.use", "task.read"]);
const noAi = person("lan", ["task.read"]);

async function call(p: Principal, b: unknown, locale = "vi") {
  const res = await fetch(`${aiUrl}/tasks/write`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-locale": locale, [PRINCIPAL_HEADER]: await signInternalToken({ principal: p, requestId: newId() }, SECRET) },
    body: JSON.stringify(b),
  });
  const t = await res.text();
  return { status: res.status, body: t ? JSON.parse(t) : null };
}
const usage = async (userId: string) =>
  (
    await pool.query<{ feature: string; subject_type: string | null; subject_id: string | null }>(
      "SELECT feature, subject_type, subject_id FROM ai_usage WHERE user_id = $1 AND feature = 'task_write'",
      [userId],
    )
  ).rows;

beforeAll(async () => {
  const { deps } = depsFromEnv(model);
  pool = deps.pool;
  delete deps.platform;
  deps.services = { work, employee, chat } as unknown as typeof deps.services;
  ai = await createAiApp(deps, SECRET);
  await ai.listen(0);
  aiUrl = (await ai.getUrl()).replace("[::1]", "127.0.0.1");
  await pool.query("DELETE FROM ai_usage WHERE user_id IN ('lan', 'huy') AND feature = 'task_write'");
  kv().delPrefix("ai:task-write:");
});

afterAll(async () => {
  await pool?.query("DELETE FROM ai_usage WHERE user_id IN ('lan', 'huy') AND feature = 'task_write'");
  await ai?.close();
});

describe("task write", () => {
  it("drafts a description for a task the caller can open and meters it on the task", async () => {
    model.reply = JSON.stringify({ title: "fix login", description: "## Mục tiêu\nĐăng nhập được trên Safari trước 30/11.\n\n## Việc cần làm\n- [ ] Hỏi @P1" });
    calls.length = 0;
    const r = await call(lan, { mode: "draft", title: "fix login", description: "cc <@01USERHUY>", taskRef: "WEB-9" });
    expect(r.status).toBe(200);
    expect(r.body.title).toBeUndefined();
    expect(r.body.description).toContain("- [ ] Hỏi <@01USERHUY>");
    expect(r.body.added).toEqual(["30/11"]);
    // The work module was asked as Lan; the model saw the project and related titles but never the user id.
    expect(calls.filter((c) => c.path.startsWith("/tasks") || c.path.startsWith("/projects")).every((c) => c.as === "lan" && c.method === "GET")).toBe(true);
    const sent = model.requests.at(-1)!;
    expect(sent.messages[0]!.content).toContain("Website");
    expect(sent.messages[0]!.content).toContain("Auth runbook");
    expect(sent.messages[0]!.content).not.toContain("01USERHUY");
    expect(await usage("lan")).toEqual([{ feature: "task_write", subject_type: "task", subject_id: TASK }]);
  });

  it("improves the title and description of a new task (no task yet)", async () => {
    model.reply = '{"title": "Fix sign-in on Safari", "description": "Users on Safari cannot sign in."}';
    const r = await call(lan, { mode: "improve", title: "fix login", description: "users cant login on safari" }, "en");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ title: "Fix sign-in on Safari", description: "Users on Safari cannot sign in.", language: "en", truncated: false, added: [] });
    expect(model.requests.at(-1)!.system).toContain("Write in English");
  });

  it("refuses without ai.use, for a task the caller cannot open, and bad input", async () => {
    const before = model.requests.length;
    expect((await call(noAi, { mode: "draft", title: "x" })).status).toBe(403);
    expect((await call(huy, { mode: "draft", title: "x", taskRef: "WEB-9" })).status).toBe(404);
    expect((await call(lan, { mode: "draft", title: "", description: "" })).status).toBe(400);
    expect((await call(lan, { mode: "custom", title: "x" })).status).toBe(400);
    expect((await call(lan, { mode: "nope", title: "x" })).status).toBe(400);
    expect(model.requests.length).toBe(before);
    expect(await usage("huy")).toEqual([]);
  });

  it("reports output it cannot use", async () => {
    model.reply = "";
    expect((await call(lan, { mode: "shorter", title: "x", description: "y" })).status).toBe(502);
  });

  it("limits bursts per person", async () => {
    model.reply = '{"description": "ok"}';
    kv().delPrefix("ai:task-write:");
    const codes: number[] = [];
    for (let i = 0; i < 21; i++) codes.push((await call(lan, { mode: "shorter", title: "x", description: "y" })).status);
    expect(codes.slice(0, 20).every((c) => c === 200)).toBe(true);
    expect(codes[20]).toBe(429);
    kv().delPrefix("ai:task-write:");
  });
});
