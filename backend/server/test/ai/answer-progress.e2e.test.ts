import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { INestApplication } from "@nestjs/common";
import { moduleUrl, PRINCIPAL_HEADER, signInternalToken } from "@workspace/service-kit";
import { newId, type Grant, type Principal } from "@workspace/shared";
import { DEFAULT_ROLES } from "../../src/modules/identity/catalog.js";
import { createAiApp, depsFromEnv } from "../../src/modules/ai/app.js";
import type { ModelProvider, ModelRequest, ModelResponse } from "../../src/modules/ai/providers.js";

/**
 * Hỏi đáp's answer with what it is doing (progress.ts), end to end: a scripted model calls real tools (the other modules
 * on a test server, TEST_INTERNAL_PORT), the stream says each call as it starts and ends, and the answer comes with its
 * steps, its notes (a task the person cannot open) and the next questions. Skipped without a test server.
 */

const SECRET = process.env.INTERNAL_TOKEN_SECRET ?? "dev-internal-secret-change-me-32bytes!";
const up = await fetch(`${moduleUrl("work")}/health`)
  .then((r) => r.ok)
  .catch(() => false);

class Scripted implements ModelProvider {
  readonly name = "scripted";
  calls = 0;
  script: (n: number) => Partial<ModelResponse> = () => ({ text: "ok" });
  toolsFor() {
    return true;
  }
  async generate(req: ModelRequest): Promise<ModelResponse> {
    if (req.system.startsWith("Summarise what an employee")) return { text: "{}", toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 }, model: "scripted" };
    const r = this.script(++this.calls);
    if (r.text && req.stream) req.stream.text(r.text);
    return { text: r.text ?? "", toolCalls: r.toolCalls ?? [], usage: { inputTokens: 10, outputTokens: 5 }, model: "scripted" };
  }
}
const model = new Scripted();
const tools = (...calls: [string, Record<string, unknown>][]) => ({ toolCalls: calls.map(([name, input]) => ({ id: newId(), name, input })) });

const EMPLOYEE = DEFAULT_ROLES.find((r) => r.name === "Employee")!.grants;
const mk = (id: string, grants: Grant[]): Principal => ({ type: "user", id, teamIds: [], departmentId: null, grants });
const lan = mk(newId(), EMPLOYEE);
const an = mk(newId(), EMPLOYEE);

let ai: INestApplication;
let aiUrl = "";
const seed: Record<string, { id: string; code: string }> = {};
const headers = async (p: Principal) => ({ "content-type": "application/json", [PRINCIPAL_HEADER]: await signInternalToken({ principal: p, requestId: newId() }, SECRET) });

async function events(p: Principal, content: string) {
  const res = await fetch(`${aiUrl}/assistant/messages/stream`, { method: "POST", headers: await headers(p), body: JSON.stringify({ content }) });
  const text = await res.text();
  return text
    .split("\n\n")
    .map((b) => ({ event: /^event: (.+)$/m.exec(b)?.[1], data: /^data: (.+)$/m.exec(b)?.[1] }))
    .filter((e): e is { event: string; data: string } => !!e.event && !!e.data)
    .map((e) => ({ event: e.event, data: JSON.parse(e.data) as Record<string, any> }));
}

beforeAll(async () => {
  if (!up) return;
  const { deps } = depsFromEnv(model);
  delete deps.platform;
  ai = await createAiApp(deps, SECRET);
  await ai.listen(0);
  aiUrl = (await ai.getUrl()).replace("[::1]", "127.0.0.1");
  const post = async (p: Principal, body: unknown) => {
    const r = await fetch(`${moduleUrl("work")}/tasks`, { method: "POST", headers: await headers(p), body: JSON.stringify(body) });
    return (await r.json()) as { id: string; code: string };
  };
  seed.mine = await post(lan, { title: "Prepare the quarterly numbers", assigneeId: lan.id });
  seed.theirs = await post(an, { title: "An's own to-do" });
}, 60_000);

afterAll(async () => {
  await ai?.close();
});

describe.skipIf(!up)("an answer's progress, notes and next questions", () => {
  it("streams each tool call as it starts and ends, then sends the steps, the notes and the next questions with the answer", async () => {
    model.calls = 0;
    model.script = (n) => (n === 1 ? tools(["list_my_tasks", {}], ["get_task", { task: seed.theirs!.code }]) : { text: `You have ${seed.mine!.code}.` });
    const ev = await events(lan, "What are my tasks?");
    const steps = ev.filter((e) => e.event === "step").map((e) => e.data);
    // Both reads run together: two starts, then two ends, each with its words.
    expect(steps.filter((s) => s.state === "running").map((s) => s.tool)).toEqual(["list_my_tasks", "get_task"]);
    expect(steps.find((s) => s.tool === "list_my_tasks" && s.state === "done")!.text).toMatch(/^Reading your tasks/);
    expect(steps.find((s) => s.tool === "get_task" && s.state !== "running")).toMatchObject({ state: "failed", text: `Reading the task: ${seed.theirs!.code} · no access` });
    // The first step comes before any word of the answer.
    expect(ev.findIndex((e) => e.event === "step")).toBeLessThan(ev.findIndex((e) => e.event === "delta"));
    const done = ev.find((e) => e.event === "done")!.data;
    expect(done.answer).toBe(`You have ${seed.mine!.code}.`);
    expect(done.steps.map((s: { tool: string; state: string }) => `${s.tool}:${s.state}`)).toEqual(["list_my_tasks:done", "get_task:failed"]);
    expect(done.notes).toEqual(["Part of this is not visible to you, so it is left out."]);
    expect(done.followUps).toEqual(expect.arrayContaining(["What should I do first today?"]));
    expect(done.followUps.length).toBeLessThanOrEqual(3);
  });

  it("an answer without tools has no steps, notes or next questions", async () => {
    model.calls = 0;
    model.script = () => ({ text: "Hello!" });
    const ev = await events(lan, "Say hello");
    expect(ev.some((e) => e.event === "step")).toBe(false);
    const done = ev.find((e) => e.event === "done")!.data;
    expect(done).not.toHaveProperty("steps");
    expect(done).not.toHaveProperty("notes");
    expect(done).not.toHaveProperty("followUps");
  });

  it("the non-streamed route answers with the same steps and next questions", async () => {
    model.calls = 0;
    model.script = (n) => (n === 1 ? tools(["plan_my_day", {}]) : { text: "Start with the numbers." });
    const res = await fetch(`${aiUrl}/assistant/messages`, { method: "POST", headers: await headers(lan), body: JSON.stringify({ content: "Plan my day" }) });
    const body = (await res.json()) as Record<string, any>;
    expect(body.steps).toEqual([expect.objectContaining({ tool: "plan_my_day", state: "done", text: expect.stringMatching(/^Planning your day/) })]);
    expect(body.followUps).toEqual(expect.arrayContaining(["Write my end-of-day report"]));
  });
});
