import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { INestApplication } from "@nestjs/common";
import { moduleUrl, PRINCIPAL_HEADER, signInternalToken } from "@workspace/service-kit";
import { newId, type Grant, type Principal } from "@workspace/shared";
import { DEFAULT_ROLES, mergeGrants } from "../../src/modules/identity/catalog.js";
import { createAiApp, depsFromEnv } from "../../src/modules/ai/app.js";
import type { ModelProvider, ModelRequest, ModelResponse } from "../../src/modules/ai/providers.js";

/**
 * The new tools inside the assistant's real loop: Hỏi đáp, @AI in a channel and the task chat, with a scripted model
 * and every other module real (a test server on TEST_INTERNAL_PORT). What the model is shown for a question, the
 * channel as the default context, and a change that waits for the person's yes on a card, then runs (or not) as them.
 *
 * Skipped when no test server answers.
 */

const SECRET = process.env.INTERNAL_TOKEN_SECRET ?? "dev-internal-secret-change-me-32bytes!";
const up = await fetch(`${moduleUrl("work")}/health`)
  .then((r) => r.ok)
  .catch(() => false);

class Scripted implements ModelProvider {
  readonly name = "scripted";
  requests: ModelRequest[] = [];
  script: (req: ModelRequest, n: number) => Partial<ModelResponse> = () => ({ text: "ok" });
  toolsFor() {
    return true;
  }
  async generate(req: ModelRequest): Promise<ModelResponse> {
    if (req.system.startsWith("Summarise what an employee")) return { text: "{}", toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 }, model: "scripted" };
    this.requests.push(req);
    const r = this.script(req, this.requests.length);
    return { text: r.text ?? "", toolCalls: r.toolCalls ?? [], usage: { inputTokens: 10, outputTokens: 5 }, model: "scripted" };
  }
}
const model = new Scripted();
const call1 = (name: string, input: Record<string, unknown>) => ({ toolCalls: [{ id: newId(), name, input }] });

const role = (name: string) => DEFAULT_ROLES.find((r) => r.name === name)!.grants;
const OWNER = role("Owner");
const EMPLOYEE = role("Employee");
const MANAGER = mergeGrants([...EMPLOYEE, ...role("Manager")]);
const mk = (id: string, grants: Grant[]): Principal => ({ type: "user", id, teamIds: [], departmentId: null, grants });
const ids = { owner: newId(), lan: newId(), an: newId() };
const owner = mk(ids.owner, OWNER);
const lan = mk(ids.lan, MANAGER);
const an = mk(ids.an, EMPLOYEE);

let ai: INestApplication;
let aiUrl = "";
async function req(base: string, p: Principal, method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json", [PRINCIPAL_HEADER]: await signInternalToken({ principal: p, requestId: newId() }, SECRET) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const t = await res.text();
  return { status: res.status, body: t ? JSON.parse(t) : null };
}
const toAi = (p: Principal, method: string, path: string, body?: unknown) => req(aiUrl, p, method, path, body);
const mod = async (m: "work" | "chat" | "employee", p: Principal, method: string, path: string, body?: unknown) => {
  const r = await req(moduleUrl(m), p, method, path, body);
  if (r.status >= 400) throw new Error(`${method} ${m}${path} → ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
};
const shown = (r: ModelRequest) => (r.tools ?? []).map((t) => t.name);
const seed: Record<string, any> = {};

beforeAll(async () => {
  if (!up) return;
  const { deps } = depsFromEnv(model);
  delete deps.platform;
  ai = await createAiApp(deps, SECRET);
  await ai.listen(0);
  aiUrl = (await ai.getUrl()).replace("[::1]", "127.0.0.1");
  await mod("employee", owner, "PUT", `/employees/${ids.owner}`, { displayName: "Hưng Trần" });
  await mod("employee", owner, "PUT", `/employees/${ids.lan}`, { displayName: "Lan Nguyễn", managerId: ids.owner });
  await mod("employee", owner, "PUT", `/employees/${ids.an}`, { displayName: "An Phạm", managerId: ids.lan });
  const pg = await import("pg");
  const db = new pg.default.Client(`postgres://workspace_owner:owner_pw@localhost:5432/${process.env.TEST_DATABASE ?? "workspace_test"}`);
  await db.connect();
  for (const id of Object.values(ids)) await db.query("INSERT INTO chat.known_members (user_id) VALUES ($1) ON CONFLICT DO NOTHING", [id]);
  await db.end();
  seed.task = await mod("work", owner, "POST", "/tasks", { title: "Plan the offsite", assigneeId: ids.lan });
  seed.other = await mod("work", owner, "POST", "/tasks", { title: "Book the venue", assigneeId: ids.lan });
  seed.channel = await mod("chat", lan, "POST", "/channels", { kind: "public", name: "offsite", memberIds: [ids.an, ids.owner] });
  seed.msg = await mod("chat", an, "POST", `/channels/${seed.channel.id}/messages`, { body: "I'll book the bus by Friday." });
}, 60_000);

afterAll(async () => {
  await ai?.close();
});

describe.skipIf(!up)("the new tools in the assistant's loop", () => {
  it("Hỏi đáp shows the model the core tools and the areas the question names, with their guidance", async () => {
    model.requests = [];
    model.script = () => ({ text: "Lan has the most." });
    const r = await toAi(lan, "POST", "/assistant/messages", { content: "Ai đang quá tải trong đội?" });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const names = shown(model.requests[0]!);
    expect(names).toEqual(expect.arrayContaining(["search_workspace", "needs_my_attention", "workload_balance", "person_progress"]));
    expect(names).not.toContain("create_whiteboard_diagram");
    expect(names).not.toContain("import_tasks");
    expect(model.requests[0]!.system).toContain("workload_balance");
  });

  it("a change waits for the person's yes on a card, then runs as them against the real task", async () => {
    model.requests = [];
    model.script = (_r, n) => (n === 1 ? call1("assign_task", { task: seed.task.code, assignee: "An" }) : { text: "Done: An has it." });
    const r = await toAi(lan, "POST", "/assistant/messages", { content: `Giao ${seed.task.code} cho An` });
    expect(r.body.pending, JSON.stringify(r.body)).toMatchObject({
      tool: "assign_task",
      // Asked in Vietnamese: the card is too.
      preview: {
        title: `Giao ${seed.task.code}`,
        fields: [
          { label: "Việc", value: seed.task.code },
          { label: "Người làm", value: "An" },
        ],
      },
    });
    // Nothing ran yet.
    expect((await mod("work", owner, "GET", `/tasks/${seed.task.id}`)).task.assigneeId).toBe(ids.lan);
    const done = await toAi(lan, "POST", `/assistant/pending/${r.body.pending.id}`, { approve: true });
    expect(done.body.answer).toBe("Done: An has it.");
    expect((await mod("work", owner, "GET", `/tasks/${seed.task.id}`)).task.assigneeId).toBe(ids.an);
    // The model was told what happened, with the new assignee's load.
    expect(JSON.stringify(model.requests.at(-1))).toContain(`Đã giao ${seed.task.code} cho An Phạm. An Phạm hiện có`);
  });

  it("declined, the tasks stay as they were and the model is told", async () => {
    model.requests = [];
    model.script = (_r, n) => (n === 1 ? call1("move_tasks_bulk", { tasks: [seed.other.code], status: "done" }) : { text: "Okay, left as is." });
    const r = await toAi(lan, "POST", "/assistant/messages", { content: `Đánh dấu xong ${seed.other.code}` });
    expect(r.body.pending.preview.fields).toEqual(expect.arrayContaining([{ label: "Các việc", value: seed.other.code }]));
    const done = await toAi(lan, "POST", `/assistant/pending/${r.body.pending.id}`, { approve: false });
    expect(done.body.answer).toBe("Okay, left as is.");
    expect((await mod("work", owner, "GET", `/tasks/${seed.other.id}`)).task.status).toBe("todo");
  });

  it("@AI in a channel: the chat tools are shown, the channel is the default, and its summary reads the real messages", async () => {
    model.requests = [];
    model.script = (req, n) => {
      if (n > 1) return { text: "An will book the bus by Friday." };
      // The context names the channel to pass: take it from there, as a model would.
      const id = /pass channel ([0-9A-Z]{26})/.exec(JSON.stringify(req.messages))?.[1];
      return call1("summarize_channel", { channel: id });
    };
    const r = await toAi(lan, "POST", "/mention", { surface: "channel", channelId: seed.channel.id, content: "@AI tóm tắt kênh này" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(shown(model.requests[0]!)).toEqual(expect.arrayContaining(["summarize_channel", "extract_action_items", "unanswered_questions", "pin_message"]));
    expect(r.body.toolCalls).toEqual([expect.objectContaining({ tool: "summarize_channel", outcome: "ok" })]);
    expect(JSON.stringify(model.requests[1]!.messages)).toContain("I'll book the bus by Friday.");
    expect(r.body.answer).toContain("Friday");
  });

  it("@AI in a public channel the person has not joined still reads it (the chat module allows it)", async () => {
    const stranger = mk(newId(), EMPLOYEE);
    model.requests = [];
    model.script = (_req, n) => (n === 1 ? call1("summarize_channel", { channel: seed.channel.id }) : { text: "An books the bus." });
    const r = await toAi(stranger, "POST", "/mention", { surface: "channel", channelId: seed.channel.id, content: "@AI tóm tắt kênh này" });
    expect(r.body.toolCalls).toEqual([expect.objectContaining({ tool: "summarize_channel", outcome: "ok" })]);
  });

  it("@AI in a private channel by someone who is not in it reads nothing of it", async () => {
    const secret = await mod("chat", lan, "POST", "/channels", { kind: "private", name: "salaries", memberIds: [ids.owner] });
    await mod("chat", lan, "POST", `/channels/${secret.id}/messages`, { body: "Raises are 5% this year." });
    model.requests = [];
    model.script = (_req, n) => (n === 1 ? call1("summarize_channel", { channel: secret.id }) : { text: "nothing" });
    const r = await toAi(an, "POST", "/mention", { surface: "channel", channelId: secret.id, content: "@AI tóm tắt kênh này" });
    expect(JSON.stringify(model.requests)).not.toContain("Raises are 5%");
    expect(JSON.stringify(r.body)).not.toContain("Raises are 5%");
  });

  it("the task chat offers the task tools and splits a task only after the person's yes", async () => {
    model.requests = [];
    model.script = (_r, n) =>
      n === 1 ? call1("split_task", { task: seed.other.code, subtasks: [{ title: "Get three quotes" }, { title: "Pay the deposit" }] }) : { text: "Split into two." };
    const r = await toAi(lan, "POST", `/tasks/${seed.other.id}/chat`, { content: "Chia nhỏ việc này" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(shown(model.requests[0]!)).toEqual(
      expect.arrayContaining(["task_history", "estimate_due_date", "split_task", "assign_task", "link_tasks", "update_task", "comment_on_task"]),
    );
    expect(shown(model.requests[0]!)).not.toContain("create_poll");
    const pending = r.body.pending ?? r.body.messages?.at(-1)?.confirm;
    expect(pending, JSON.stringify(r.body)).toBeTruthy();
    expect((await mod("work", owner, "GET", `/tasks/${seed.other.id}`)).subtasks).toHaveLength(0);
  });
});
