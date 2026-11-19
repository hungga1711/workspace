import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { INestApplication } from "@nestjs/common";
import { PRINCIPAL_HEADER, ServiceCallError, signInternalToken, type ServiceClient } from "@workspace/service-kit";
import { newId, type Principal } from "@workspace/shared";
import { createAiApp, depsFromEnv } from "../../src/modules/ai/app.js";
import type { ModelProvider, ModelRequest, ModelResponse } from "../../src/modules/ai/providers.js";
import { WORKSPACE_WRITE_TOOLS, citedIn, previewOf, workspaceRules } from "../../src/modules/ai/workspace-tools.js";
import { gated, promptedCalls } from "../../src/modules/ai/mcp/loop.js";

const SECRET = "dev-internal-secret-change-me-32bytes!";

/**
 * The assistant's workspace tools end to end in the ai module: a scripted model that calls them, the other modules as
 * fakes that record what they were asked and as whom. Reading cites its sources; a change waits for the person's yes
 * on a card and runs as them; @AI in a task's comments posts its answer there.
 */

class ScriptedProvider implements ModelProvider {
  readonly name = "scripted";
  requests: ModelRequest[] = [];
  script: (req: ModelRequest, n: number) => Partial<ModelResponse> = () => ({ text: "ok" });
  /** false: a connection without tool calling of its own (an AI on a connected computer). */
  native = true;
  toolsFor() {
    return this.native;
  }
  async generate(req: ModelRequest): Promise<ModelResponse> {
    if (req.system.startsWith("Summarise what an employee")) return { text: "{}", toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 }, model: "scripted" };
    this.requests.push(req);
    const r = this.script(req, this.requests.length);
    return {
      text: r.text ?? "",
      toolCalls: r.toolCalls ?? [],
      usage: { inputTokens: 10, outputTokens: 5 },
      model: r.model ?? "scripted",
      ...(r.provider ? { provider: r.provider } : {}),
    };
  }
}
const model = new ScriptedProvider();
const call1 = (name: string, input: Record<string, unknown>) => ({ toolCalls: [{ id: newId(), name, input }] });

// ------------------------------------------------------------------ the other modules, as fakes

interface Seen {
  service: string;
  method: string;
  path: string;
  body: unknown;
  as: string | null;
}
const seen: Seen[] = [];
let handlers: Record<string, (s: Seen) => unknown> = {};
const fake = (service: string) =>
  ({
    request: async (method: string, path: string, body?: unknown, as?: Principal) => {
      const s: Seen = { service, method, path, body: body ?? null, as: as?.id ?? null };
      seen.push(s);
      const key = Object.keys(handlers).find((k) => `${service} ${method} ${path}`.startsWith(k));
      if (!key) throw new ServiceCallError(404, { message: "not found" }, `${method} ${path}`);
      return handlers[key]!(s);
    },
  }) as unknown as ServiceClient;
const writes = () => seen.filter((s) => s.method !== "GET");

const principal = (perms: string[]): Principal => ({
  type: "user",
  id: newId(),
  teamIds: [],
  departmentId: null,
  grants: perms.map((permission) => ({ permission, scope: "WORKSPACE" as const })),
});
const lan = principal(["ai.use", "task.read", "task.create", "calendar.edit", "document.create", "employee.profile.read", "message.read"]);
const reader = principal(["ai.use", "task.read", "message.read"]);

let ai: INestApplication;
let aiUrl = "";
async function call(p: Principal, method: string, path: string, b?: unknown) {
  const res = await fetch(`${aiUrl}${path}`, {
    method,
    headers: { "content-type": "application/json", [PRINCIPAL_HEADER]: await signInternalToken({ principal: p, requestId: newId() }, SECRET) },
    ...(b === undefined ? {} : { body: JSON.stringify(b) }),
  });
  const t = await res.text();
  return { status: res.status, body: t ? JSON.parse(t) : null };
}
const ask = (p: Principal, content: string, more: Record<string, unknown> = {}) => call(p, "POST", "/assistant/messages", { content, ...more });
const lastUser = (req: ModelRequest) => String(req.messages.at(-1)!.content);

beforeAll(async () => {
  const { deps } = depsFromEnv(model);
  delete deps.platform;
  deps.services = { work: fake("work"), chat: fake("chat"), employee: fake("employee") };
  ai = await createAiApp(deps, SECRET);
  await ai.listen(0);
  aiUrl = (await ai.getUrl()).replace("[::1]", "127.0.0.1");
});
afterAll(async () => {
  await ai?.close();
});
beforeEach(() => {
  seen.length = 0;
  model.requests = [];
  model.native = true;
  handlers = {
    "employee GET /employees": () => ({
      employees: [
        { userId: "u-minh", displayName: "Tran Minh", email: "minh@example.com" },
        { userId: "u-minh2", displayName: "Le Minh", email: "leminh@example.com" },
        { userId: "u-anh", displayName: "Nguyen Anh", email: "anh@example.com" },
      ],
    }),
  };
});

describe("reading the workspace", () => {
  it("searches as the asker, answers from the passages and cites what it read", async () => {
    handlers["chat GET /search/passages"] = () => ({
      passages: [
        { entity_type: "document", entity_id: "doc1", title: "Refund policy", url: "/app/work/docs/doc1", seq: 3, text: "Refunds are possible within 30 days with a receipt." },
        { entity_type: "meeting", entity_id: "m1", title: "Support weekly", url: "/app/work/meetings/M-4", seq: 0, text: "Decided: lamps get a 24 month warranty." },
      ],
    });
    model.script = (_req, n) => (n === 1 ? call1("search_workspace", { query: "refund policy" }) : { text: "Refunds: within 30 days with a receipt (Refund policy)." });
    const r = await ask(lan, "What is our refund policy?");
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.answer).toContain("within 30 days");
    // Two passages came back; the answer names one, and that is the one cited.
    expect(r.body.sources).toEqual([{ type: "document", id: "doc1", title: "Refund policy", url: "/app/work/docs/doc1" }]);
    expect(r.body.toolCalls).toMatchObject([{ serverId: "workspace", tool: "search_workspace", title: "Searched the workspace", outcome: "ok" }]);
    // The search ran as the asker (the chat module filters by what they may read), with the model's own words.
    const search = seen.find((x) => x.service === "chat")!;
    expect(search.as).toBe(lan.id);
    expect(search.path).toContain("q=refund%20policy");
    // The model was told the date and its rules, and read the passages as untrusted data.
    expect(model.requests[0]!.system).toContain("search_workspace first");
    expect(model.requests[0]!.tools!.map((t) => t.name)).toEqual(
      expect.arrayContaining(["search_workspace", "read_item", "list_calendar", "create_task", "edit_document", "run_workflow"]),
    );
    expect(lastUser(model.requests[1]!)).toContain("<untrusted_content>");
    expect(lastUser(model.requests[1]!)).toContain("[document doc1 part 3] Refund policy");
    // Reopened, the conversation still shows the citations.
    const again = await call(lan, "GET", `/assistant/conversations/${r.body.conversationId}`);
    expect(again.body.messages.at(-1).sources).toHaveLength(1);
  });

  it("falls back to the document search where the passage index is not built yet", async () => {
    handlers["chat GET /search?"] = () => ({ hits: [{ entity_type: "task", entity_id: "t9", title: "T-9 Fix lamp", url: "/app/work/tasks/t9", body: "It flickers." }] });
    model.script = (_req, n) => (n === 1 ? call1("search_workspace", { query: "lamp", types: ["task"] }) : { text: "T-9." });
    const r = await ask(lan, "Any task about the lamp?");
    expect(r.body.sources).toEqual([{ type: "task", id: "t9", title: "T-9 Fix lamp", url: "/app/work/tasks/t9" }]);
    expect(seen.map((s) => s.path.split("?")[0])).toEqual(["/search/passages", "/search"]);
  });

  it("what the asker may not open is not read: the owning module refuses and the model is told so", async () => {
    handlers["work GET /docs/secret"] = () => {
      throw new ServiceCallError(404, { message: "not found" }, "GET /docs/secret");
    };
    model.script = (_req, n) => (n === 1 ? call1("read_item", { type: "document", id: "secret" }) : { text: "I cannot open that page." });
    const r = await ask(reader, "Read page secret");
    expect(lastUser(model.requests[1]!)).toContain("DENIED: not found or not permitted");
    expect(r.body.toolCalls[0]).toMatchObject({ tool: "read_item", outcome: "denied" });
    expect(r.body.sources).toEqual([]);
  });
});

describe("changing the workspace", () => {
  const task = { id: "t41", code: "T-41", title: "Lamp flickers", version: 7, status: "todo" };

  it("a change waits for the person's yes: the card says what would change, nothing runs before", async () => {
    handlers["work POST /tasks"] = () => ({ id: "t50", code: "T-50", title: "Call the supplier" });
    model.script = (_req, n) =>
      n === 1
        ? call1("create_task", { title: "Call the supplier", assignee: "Nguyen Anh", dueAt: "2026-11-14T09:00:00+07:00", priority: "high" })
        : { text: "Done: T-50 is created for Anh." };
    const r = await ask(lan, "Create a task for Anh to call the supplier on Saturday morning");
    expect(r.body.answer).toBe("");
    expect(r.body.pending).toMatchObject({
      serverId: "workspace",
      tool: "create_task",
      title: "Create a task",
      preview: {
        title: "Create a task",
        fields: [
          { label: "Title", value: "Call the supplier" },
          { label: "Assignee", value: "Nguyen Anh" },
          { label: "Due", value: "Sat, 14 Nov 2026, 09:00" },
          { label: "Priority", value: "high" },
        ],
      },
    });
    expect(writes()).toEqual([]);

    const done = await call(lan, "POST", `/assistant/pending/${r.body.pending.id}`, { approve: true });
    expect(done.status).toBe(200);
    expect(done.body.answer).toBe("Done: T-50 is created for Anh.");
    expect(done.body.sources).toEqual([{ type: "task", id: "t50", title: "T-50 Call the supplier", url: "/app/work/tasks/T-50" }]);
    // It ran as the person, with the name resolved to the colleague and the time kept.
    expect(writes()).toEqual([
      {
        service: "work",
        method: "POST",
        path: "/tasks",
        as: lan.id,
        body: { title: "Call the supplier", description: "", assigneeId: "u-anh", dueAt: "2026-11-14T02:00:00.000Z", priority: "high" },
      },
    ]);
    // A second click on the same card does nothing.
    expect((await call(lan, "POST", `/assistant/pending/${r.body.pending.id}`, { approve: true })).status).toBe(404);
    expect(writes()).toHaveLength(1);
    // What it did is shown, and kept with the answer: the reopened conversation shows the same steps.
    expect(done.body.steps).toEqual([expect.objectContaining({ tool: "create_task", state: "done" })]);
    const reopened = await call(lan, "GET", `/assistant/conversations/${r.body.conversationId}`);
    const saved = reopened.body.messages.filter((m: { role: string }) => m.role === "assistant").at(-1);
    expect(saved.content).toBe("Done: T-50 is created for Anh.");
    expect(saved.steps).toEqual(done.body.steps);
  });

  it("declined, nothing changes and the model is told", async () => {
    model.script = (_req, n) => (n === 1 ? call1("create_task", { title: "X" }) : { text: "Okay, I did not create it." });
    const r = await ask(lan, "Create a task X");
    const done = await call(lan, "POST", `/assistant/pending/${r.body.pending.id}`, { approve: false });
    expect(done.body.answer).toBe("Okay, I did not create it.");
    expect(writes()).toEqual([]);
    expect(lastUser(model.requests.at(-1)!)).toContain("The user declined");
    expect(done.body.toolCalls.at(-1)).toMatchObject({ tool: "create_task", outcome: "declined" });
  });

  it("someone else cannot approve my card", async () => {
    model.script = () => call1("create_task", { title: "X" });
    const r = await ask(lan, "Create a task X");
    expect((await call(reader, "POST", `/assistant/pending/${r.body.pending.id}`, { approve: true })).status).toBe(404);
    expect(writes()).toEqual([]);
  });

  it("a card left waiting is shown again when the conversation is opened, and becomes a 'not done' line after a new question", async () => {
    model.script = (_req, n) => (n === 1 ? call1("create_task", { title: "Fix the DM list" }) : { text: "Sure." });
    const r = await ask(lan, "Make a ticket to fix the DM list");
    const opened = await call(lan, "GET", `/assistant/conversations/${r.body.conversationId}`);
    expect(opened.body.messages.map((m: { role: string }) => m.role)).toEqual(["user", "assistant"]);
    expect(opened.body.messages[1]).toMatchObject({ content: "", confirm: { id: r.body.pending.id, tool: "create_task", preview: { title: "Create a task" } } });

    model.script = () => ({ text: "Written in English this time." });
    await ask(lan, "Write it in English", { conversationId: r.body.conversationId });
    // The model reads what was proposed and not done.
    expect(JSON.stringify(model.requests.at(-1))).toContain("Not done (not approved):_ Create a task “Fix the DM list”");
    const after = await call(lan, "GET", `/assistant/conversations/${r.body.conversationId}`);
    expect(after.body.messages.map((m: { role: string; content: string }) => [m.role, m.content])).toEqual([
      ["user", "Make a ticket to fix the DM list"],
      ["assistant", "_Not done (not approved):_ Create a task “Fix the DM list”"],
      ["user", "Write it in English"],
      ["assistant", "Written in English this time."],
    ]);
    // The old card can no longer be answered.
    expect((await call(lan, "POST", `/assistant/pending/${r.body.pending.id}`, { approve: true })).status).toBe(404);
    expect(writes()).toEqual([]);
  });

  it("where no card can be shown (a regenerated answer), no tool that changes anything is offered", async () => {
    model.script = () => ({ text: "first" });
    const r = await ask(lan, "Hello");
    await call(lan, "POST", `/assistant/conversations/${r.body.conversationId}/regenerate`, {});
    const offered = model.requests.at(-1)!.tools!.map((t) => t.name);
    expect(offered).toContain("search_workspace");
    for (const w of WORKSPACE_WRITE_TOOLS) expect(offered).not.toContain(w);
    expect(model.requests.at(-1)!.system).toContain("You cannot change anything here");
  });

  it("without the permission, the change is refused before it reaches the module", async () => {
    model.script = (_req, n) => (n === 1 ? call1("create_task", { title: "X" }) : { text: "You may not create tasks." });
    const r = await ask(reader, "Create a task X");
    const done = await call(reader, "POST", `/assistant/pending/${r.body.pending.id}`, { approve: true });
    expect(lastUser(model.requests.at(-1)!)).toContain("DENIED: you do not have permission task.create");
    expect(done.body.toolCalls.at(-1)).toMatchObject({ outcome: "denied" });
    expect(writes()).toEqual([]);
  });

  it("an unclear name goes back to the model as a question to ask, not a guess", async () => {
    model.script = (_req, n) => (n === 1 ? call1("create_task", { title: "X", assignee: "Minh" }) : { text: "Which Minh: Tran Minh or Le Minh?" });
    const r = await ask(lan, "Create a task X for Minh");
    const done = await call(lan, "POST", `/assistant/pending/${r.body.pending.id}`, { approve: true });
    expect(lastUser(model.requests.at(-1)!), JSON.stringify(seen)).toContain('Several people match "Minh": Tran Minh, Le Minh. Ask the user which one.');
    expect(done.body.answer).toContain("Which Minh");
    expect(writes()).toEqual([]);
  });

  it("updates a task at the version it read, moves a meeting, and tells the model why a module refused", async () => {
    handlers["work GET /tasks/T-41"] = () => ({ task });
    handlers["work PATCH /tasks/t41"] = () => ({});
    model.script = (_req, n) => (n === 1 ? call1("update_task", { task: "T-41", status: "in_progress", assignee: "me", dueAt: null }) : { text: "Updated." });
    let r = await ask(lan, "Start T-41 and assign it to me, no due date");
    expect(r.body.pending, JSON.stringify([r.body, seen])).toBeTruthy();
    expect(r.body.pending.preview).toMatchObject({
      title: "Change task T-41",
      fields: [
        { label: "Status", value: "in_progress" },
        { label: "Assignee", value: "me" },
      ],
    });
    await call(lan, "POST", `/assistant/pending/${r.body.pending.id}`, { approve: true });
    expect(writes().at(-1)).toMatchObject({
      method: "PATCH",
      path: "/tasks/t41",
      as: lan.id,
      body: { expectedVersion: 7, status: "in_progress", assigneeId: lan.id, dueAt: null },
    });

    model.requests = [];
    handlers["work PATCH /calendar/events/ev1"] = () => {
      throw new ServiceCallError(400, { message: "only the organizer can change this event" }, "PATCH");
    };
    model.script = (_req, n) =>
      n === 1
        ? call1("update_event", { id: "ev1", label: "Weekly sync", startsAt: "2026-11-16T10:00:00+07:00", endsAt: "2026-11-16T10:30:00+07:00" })
        : { text: "Only its organiser can move it." };
    r = await ask(lan, "Move the weekly sync to Monday 10:00");
    expect(r.body.pending.preview.title).toBe("Move or change a calendar entry");
    await call(lan, "POST", `/assistant/pending/${r.body.pending.id}`, { approve: true });
    expect(lastUser(model.requests.at(-1)!)).toContain("Refused: only the organizer can change this event");
    void 0;
  });

  it("edits a page by exact passage at the version it read; a passage that is not there changes nothing", async () => {
    handlers["work GET /docs/doc1"] = () => ({
      document: { id: "doc1", title: "Refund policy", currentVersion: 4, format: "markdown" },
      content: "Refunds within 30 days.\n\nContact support.",
    });
    handlers["work PUT /docs/doc1"] = () => ({});
    model.script = (_req, n) =>
      n === 1 ? call1("edit_document", { document: "doc1", label: "Refund policy", mode: "replace_text", find: "30 days", text: "45 days" }) : { text: "Changed to 45 days." };
    let r = await ask(lan, "Change the refund window to 45 days in the Refund policy page");
    expect(r.body.pending.preview).toMatchObject({
      title: "Edit the page Refund policy",
      fields: [
        { label: "Replace this", value: "30 days" },
        { label: "With", value: "45 days" },
      ],
    });
    await call(lan, "POST", `/assistant/pending/${r.body.pending.id}`, { approve: true });
    expect(writes().at(-1)).toMatchObject({
      method: "PUT",
      path: "/docs/doc1",
      body: { content: "Refunds within 45 days.\n\nContact support.", baseVersion: 4, format: "markdown" },
    });

    const before = writes().length;
    model.requests = [];
    model.script = (_req, n) =>
      n === 1 ? call1("edit_document", { document: "doc1", mode: "replace_text", find: "60 days", text: "45 days" }) : { text: "I could not find that sentence." };
    r = await ask(lan, "Change 60 days to 45");
    await call(lan, "POST", `/assistant/pending/${r.body.pending.id}`, { approve: true });
    expect(lastUser(model.requests.at(-1)!)).toContain("That passage is not in the page word for word");
    expect(writes()).toHaveLength(before);
  });

  it("starts a workflow on a task with the answers to its questions", async () => {
    handlers["work GET /tasks/T-41"] = () => ({ task });
    handlers["work PUT /tasks/t41/workflow"] = () => ({ workflowId: "wf1", run: null });
    handlers["work POST /tasks/t41/runs"] = () => ({ id: "run1" });
    model.script = (_req, n) => (n === 1 ? call1("run_workflow", { task: "T-41", workflow: "wf1", label: "Customer reply", inputs: { tone: "Warm" } }) : { text: "Started." });
    const r = await ask(lan, "Run the Customer reply workflow on T-41, warm tone");
    expect(r.body.pending, JSON.stringify([r.body, seen])).toBeTruthy();
    expect(r.body.pending.preview).toMatchObject({
      title: "Run a workflow on a task",
      fields: [
        { label: "Workflow", value: "Customer reply" },
        { label: "Task", value: "T-41" },
        { label: "Answers", value: "tone: Warm" },
      ],
    });
    await call(lan, "POST", `/assistant/pending/${r.body.pending.id}`, { approve: true });
    expect(
      writes().map((s) => `${s.method} ${s.path}`),
      lastUser(model.requests.at(-1)!),
    ).toEqual(["PUT /tasks/t41/workflow", "POST /tasks/t41/runs"]);
    expect(writes()[1]!.body).toEqual({ inputs: { tone: "Warm" } });
  });
});

describe("when the AI does not answer", () => {
  it("every connected model failed and the built-in one stood in: the person is told the AI is unavailable, not shown its JSON", async () => {
    model.script = () => ({ text: '{"summary":"hello","actions":[],"decisions":[]}', provider: "local", model: "local-extractive" });
    const r = await ask(lan, "hello");
    expect(r.status).toBe(503);
    expect(r.body.error).toBe("ai_unavailable");
  });
});

describe("@AI where the work is", () => {
  const brief = () => {
    handlers["work GET /tasks/T-41"] = () => ({
      task: { id: "t41", code: "T-41", title: "Lamp flickers", description: "Customer reports flicker.", status: "todo", version: 7, assigneeId: null, dueAt: null },
      comments: [],
      subtasks: [],
    });
    handlers["work GET /tasks/t41"] = handlers["work GET /tasks/T-41"]!;
    handlers["work POST /internal/tasks/t41/agent-comments"] = () => ({ id: "c1" });
  };

  it("in a task's comments the answer is posted on the task, marked AI, in the asker's name", async () => {
    brief();
    model.script = () => ({ text: "The lamp flickers; ask for the order number." });
    const r = await call(lan, "POST", "/mention", { surface: "task", taskId: "T-41", content: "@AI what should we do next?" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ answer: "The lamp flickers; ask for the order number.", posted: { commentId: "c1" } });
    const posted = writes().at(-1)!;
    // Posted by the ai module itself (no person's principal), naming who asked.
    expect(posted).toMatchObject({
      path: "/internal/tasks/t41/agent-comments",
      as: null,
      body: { askerId: lan.id, agent: "AI", body: "The lamp flickers; ask for the order number." },
    });
    // The model got the question without the mention, and knows which task "this" is.
    const q = lastUser(model.requests[0]!);
    expect(q.startsWith("what should we do next?")).toBe(true);
    expect(q).toContain('"This task" means T-41');
  });

  it("a change asked in a comment waits for the asker; the answer is posted once they decide", async () => {
    brief();
    handlers["work PATCH /tasks/t41"] = () => ({});
    model.script = (_req, n) => (n === 1 ? call1("update_task", { task: "T-41", status: "done" }) : { text: "Marked T-41 as done." });
    const r = await call(lan, "POST", "/mention", { surface: "task", taskId: "T-41", content: "@AI mark this task as done" });
    expect(r.body.pending.preview.title).toBe("Change task T-41");
    expect(r.body.posted).toBeUndefined();
    expect(writes()).toEqual([]);
    const done = await call(lan, "POST", `/assistant/pending/${r.body.pending.id}`, { approve: true });
    expect(done.body).toMatchObject({ answer: "Marked T-41 as done.", posted: { commentId: "c1" } });
    expect(writes().map((s) => s.path)).toEqual(["/tasks/t41", "/internal/tasks/t41/agent-comments"]);
  });

  it("in a channel the answer stays with the asker, who must be a member; the channel's messages are context", async () => {
    const channelId = newId();
    handlers[`chat GET /channels/${channelId}/messages`] = () => ({
      messages: [{ id: "m1", authorId: "u-anh", body: "Supplier says Friday.", createdAt: "2026-11-12T03:00:00Z" }],
    });
    model.script = () => ({ text: "Anh said the supplier delivers on Friday." });
    const r = await call(lan, "POST", "/mention", { surface: "channel", channelId, content: "@AI when does the supplier deliver?" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.answer).toContain("Friday");
    expect(r.body.posted).toBeUndefined();
    expect(writes()).toEqual([]);
  });

  it("a task the asker cannot open is not answered about", async () => {
    const r = await call(reader, "POST", "/mention", { surface: "task", taskId: "T-999", content: "@AI summarise" });
    expect(r.status).toBe(404);
    expect(model.requests).toHaveLength(0);
  });
});

describe("a model without tool calling of its own (an AI on a connected computer)", () => {
  it("reads the tools in its instructions, calls one by writing JSON, and still cites and asks before changing", async () => {
    model.native = false;
    handlers["chat GET /search/passages"] = () => ({
      passages: [{ entity_type: "document", entity_id: "doc1", title: "Travel policy", url: "/app/work/docs/doc1", seq: 1, text: "Hotel cap: 1,800,000 VND per night in Hanoi." }],
    });
    model.script = (_req, n) =>
      n === 1 ? { text: '{"name": "search_workspace", "parameters": {"query": "hotel cap Hanoi"}}' } : { text: "1,800,000 VND per night (Travel policy)." };
    const r = await ask(lan, "Draft me a note: what is the hotel cap in Hanoi?");
    expect(r.body.answer).toBe("1,800,000 VND per night (Travel policy).");
    expect(r.body.sources).toEqual([{ type: "document", id: "doc1", title: "Travel policy", url: "/app/work/docs/doc1" }]);
    // Nothing is sent as API tools; they are described in words, with how to call one.
    expect(model.requests[0]!.tools ?? []).toEqual([]);
    expect(model.requests[0]!.system).toContain("TOOLS. You have these tools");
    expect(model.requests[0]!.system).toContain("- search_workspace:");
    expect(model.requests[0]!.system).toContain("reply with ONLY one JSON object");
    expect(lastUser(model.requests[1]!)).toContain("Hotel cap: 1,800,000 VND");

    // A change still waits for the person.
    handlers["work POST /tasks"] = () => ({ id: "t60", code: "T-60", title: "Book flights" });
    model.requests = [];
    model.script = (_req, n) =>
      n === 1 ? { text: 'Sure.\n```json\n{"name": "create_task", "parameters": {"title": "Book flights", "assignee": "me"}}\n```' } : { text: "Created T-60." };
    const w = await ask(lan, "Draft and create a task: book flights, for me");
    expect(w.body.pending.preview).toMatchObject({
      title: "Create a task",
      fields: [
        { label: "Title", value: "Book flights" },
        { label: "Assignee", value: "me" },
      ],
    });
    expect(writes()).toEqual([]);
    const done = await call(lan, "POST", `/assistant/pending/${w.body.pending.id}`, { approve: true });
    expect(done.body.answer).toBe("Created T-60.");
    expect(writes()).toMatchObject([{ path: "/tasks", as: lan.id, body: { title: "Book flights", assigneeId: lan.id } }]);
  });

  it("a computer's AI gets the person's tasks and week read ahead, and answers in one turn", async () => {
    model.native = false;
    handlers["work GET /tasks"] = () => ({
      tasks: [
        { id: "t36", code: "T-036", title: "Decide on code signing", status: "in_progress", dueAt: "2026-11-14T10:00:00Z" },
        { id: "t40", code: "T-040", title: "Ship the release notes", status: "done", dueAt: null },
      ],
    });
    handlers["work GET /calendar/events"] = (x) => {
      expect(x.path).toMatch(/from=\d{4}-\d{2}-\d{2}T00%3A00%3A00/);
      return { events: [{ id: "e1", title: "Friday demo", kind: "meeting", startsAt: "2026-11-17T09:00:00Z", endsAt: "2026-11-17T09:45:00Z" }] };
    };
    model.script = () => ({ text: "T-036 is overdue." });
    const r = await ask(lan, "Is anything of mine overdue?");
    expect(r.body.answer).toBe("T-036 is overdue.");
    // One model turn: the data was in the question already, and no tool shows as used.
    expect(model.requests).toHaveLength(1);
    const q = lastUser(model.requests[0]!);
    expect(q).toContain("Workspace data already read");
    expect(q).toContain("T-036");
    expect(q).toContain("Friday demo");
    expect(q).not.toContain("Ship the release notes");
    expect(r.body.toolCalls).toEqual([]);
    // Read ahead is cited only when the answer names it.
    expect(r.body.sources.map((x: { title: string }) => x.title).join()).not.toContain("Friday demo");

    // A model that takes tools itself reads nothing ahead.
    model.native = true;
    model.requests = [];
    model.script = () => ({ text: "Nothing." });
    await ask(lan, "Is anything of mine overdue?");
    expect(lastUser(model.requests[0]!)).not.toContain("Workspace data already read");
  });

  it("takes a tool call written in text, never an answer that only quotes JSON", () => {
    const names = ["search_workspace", "create_task"];
    expect(promptedCalls('{"name":"search_workspace","parameters":{"query":"x"}}', names)).toMatchObject([{ name: "search_workspace", input: { query: "x" } }]);
    expect(promptedCalls('I will search.\n{"name":"search_workspace","arguments":{"query":"x"}}', names)).toHaveLength(1);
    expect(promptedCalls('{"name":"delete_everything","parameters":{}}', names)).toEqual([]);
    expect(
      promptedCalls(
        `The config looks like {"name": "search_workspace"} in the file, which is a long explanation of how the settings are written and why they matter to the team.`,
        names,
      ),
    ).toEqual([]);
    expect(promptedCalls("Just an answer.", names)).toEqual([]);
    // Some Claude models write calls as markup even when asked for JSON.
    expect(
      promptedCalls(
        '<function_calls>\n<invoke name="search_workspace">\n<parameter name="query">Q3 plan</parameter>\n<parameter name="limit">5</parameter>\n</invoke>\n</function_calls>',
        names,
      ),
    ).toMatchObject([{ name: "search_workspace", input: { query: "Q3 plan", limit: 5 } }]);
    expect(promptedCalls('<invoke name="delete_everything"></invoke>', names)).toEqual([]);
    expect(promptedCalls(`Write it as <invoke name="search_workspace"></invoke> — that is the markup some models use, explained here at length for the team.`, names)).toEqual([]);
  });

  it("holds back a turn that may be a tool call, and writes an answer through as it comes", () => {
    const run = (deltas: string[], call: boolean) => {
      let shown = "";
      const g = gated({ text: (d) => void (shown += d), reset: () => void (shown += "|"), signal: new AbortController().signal });
      for (const d of deltas) g.stream.text(d);
      g.end(call);
      return shown;
    };
    expect(run(["Hel", "lo ", "there"], false)).toBe("Hello there");
    expect(run(['{"name": "search', '_workspace"}'], true)).toBe("");
    expect(run(["```json\n", '{"name":"x"}', "\n```"], true)).toBe("");
    // Looked like a call, turned out to be the answer: shown whole at the end.
    expect(run(['{"a": 1} is the', " config"], false)).toBe('{"a": 1} is the config');
  });
});

describe("what the card and the model are told", () => {
  it("previews in the answer's language, only for tools that change something", () => {
    expect(previewOf("create_task", { title: "Gọi nhà cung cấp" }, "vi")).toEqual({ title: "Tạo việc mới", fields: [{ label: "Tiêu đề", value: "Gọi nhà cung cấp" }] });
    expect(previewOf("update_event", { id: "e1", label: "Weekly", cancel: true }, "en")).toMatchObject({ title: "Cancel a calendar entry" });
    expect(previewOf("search_workspace", { query: "x" }, "en")).toBeNull();
  });

  it("cites what the answer used: what it opened or changed, and of a search's hits only those it names", () => {
    const doc = { type: "document" as const, id: "d1", title: "Travel policy", url: "/d1", found: true };
    const task = { type: "task" as const, id: "t1", title: "T-49 Rate limit per IP", url: "/t1", found: true };
    const opened = { type: "meeting" as const, id: "m1", title: "Weekly", url: "/m1" };
    expect(citedIn("The cap is 1.8M (Travel policy).", [doc, task])).toEqual([{ type: "document", id: "d1", title: "Travel policy", url: "/d1" }]);
    expect(citedIn("See T-49.", [doc, task]).map((s) => s.id)).toEqual(["t1"]);
    // Named nothing: the best two hits, so a searched answer still shows where it looked.
    expect(citedIn("It is 1.8M.", [doc, task]).map((s) => s.id)).toEqual(["d1", "t1"]);
    // What it opened or changed is always cited; unnamed hits beside it are not.
    expect(citedIn("Done.", [doc, opened]).map((s) => s.id)).toEqual(["m1"]);
  });

  it("tells the model the date, the offset and whether it may change things", () => {
    const rules = workspaceRules(new Date("2026-11-12T03:00:00Z"), "Asia/Ho_Chi_Minh", true);
    expect(rules).toContain("Thursday, 12 November 2026");
    expect(rules).toContain("UTC+07:00");
    expect(rules).toContain("must approve it first");
    expect(workspaceRules(new Date(), undefined, false)).toContain("You cannot change anything here");
  });
});

describe("messages and requests for approval", () => {
  const sender = principal(["ai.use", "task.read", "message.read", "message.post", "employee.profile.read"]);
  const channels = () => ({
    channels: [
      { id: "c-general", kind: "public", name: "general", displayName: null },
      { id: "c-dm", kind: "dm", name: null, displayName: null },
    ],
  });

  it("a message to a channel is sent in the person's name, after their yes", async () => {
    handlers["chat GET /channels"] = channels;
    handlers["chat POST /channels/c-general/messages"] = () => ({ id: "m9" });
    model.script = (_req, n) => (n === 1 ? call1("send_message", { to: "#General", body: "Standup moves to 10:00 tomorrow." }) : { text: "Sent to #general." });
    const r = await ask(sender, "Tell #general that standup moves to 10:00 tomorrow");
    expect(r.body.pending).toMatchObject({
      tool: "send_message",
      preview: {
        title: "Send a message in your name",
        fields: [
          { label: "To", value: "#General" },
          { label: "Message", value: "Standup moves to 10:00 tomorrow." },
        ],
      },
    });
    expect(writes()).toEqual([]);
    const done = await call(sender, "POST", `/assistant/pending/${r.body.pending.id}`, { approve: true });
    expect(done.body.answer).toBe("Sent to #general.");
    expect(writes()).toEqual([{ service: "chat", method: "POST", path: "/channels/c-general/messages", as: sender.id, body: { body: "Standup moves to 10:00 tomorrow." } }]);
  });

  it("a colleague's name opens the direct conversation; an unknown destination sends nothing", async () => {
    handlers["chat GET /channels"] = channels;
    handlers["chat POST /dms"] = () => ({ id: "c-anh" });
    handlers["chat POST /channels/c-anh/messages"] = () => ({ id: "m10" });
    model.script = (_req, n) => (n === 1 ? call1("send_message", { to: "Nguyen Anh", body: "The contract is signed." }) : { text: "Sent." });
    const r = await ask(sender, "Message Anh that the contract is signed");
    await call(sender, "POST", `/assistant/pending/${r.body.pending.id}`, { approve: true });
    expect(writes().map((w) => [w.path, w.body])).toEqual([
      ["/dms", { userId: "u-anh" }],
      ["/channels/c-anh/messages", { body: "The contract is signed." }],
    ]);

    seen.length = 0;
    model.requests = [];
    model.script = (_req, n) => (n === 1 ? call1("send_message", { to: "marketing", body: "Hi" }) : { text: "Where should I send it?" });
    const r2 = await ask(sender, "Tell marketing hi");
    const done = await call(sender, "POST", `/assistant/pending/${r2.body.pending.id}`, { approve: true });
    expect(done.body.answer).toBe("Where should I send it?");
    expect(writes()).toEqual([]);
    expect(done.body.toolCalls.at(-1)).toMatchObject({ tool: "send_message", outcome: "error" });
  });

  it("someone who may not post is not sent for", async () => {
    model.script = (_req, n) => (n === 1 ? call1("send_message", { to: "general", body: "Hi" }) : { text: "You may not post messages." });
    const r = await ask(reader, "Say hi in general");
    const done = await call(reader, "POST", `/assistant/pending/${r.body.pending.id}`, { approve: true });
    expect(done.body.toolCalls.at(-1)).toMatchObject({ tool: "send_message", outcome: "denied" });
    expect(writes()).toEqual([]);
  });

  it("a request for approval goes to the named approver with its amount", async () => {
    handlers["work POST /approvals"] = () => ({ id: "a7", code: "R-7" });
    model.script = (_req, n) =>
      n === 1
        ? call1("request_approval", { title: "Two monitors", approver: "Nguyen Anh", kind: "purchase", amount: 12000000, details: "For the design team." })
        : { text: "Request R-7 is with Anh." };
    const r = await ask(sender, "Ask Anh to approve buying two monitors for 12 million");
    expect(r.body.pending.preview).toEqual({
      title: "Send a request for approval",
      fields: [
        { label: "Title", value: "Two monitors" },
        { label: "Approver", value: "Nguyen Anh" },
        { label: "Type", value: "purchase" },
        { label: "Amount", value: "12,000,000 VND" },
        { label: "Details", value: "For the design team.", md: true },
      ],
    });
    const done = await call(sender, "POST", `/assistant/pending/${r.body.pending.id}`, { approve: true });
    expect(done.body.sources).toEqual([{ type: "approval", id: "a7", title: "R-7 Two monitors", url: "/app/work/approvals/a7" }]);
    expect(writes()).toEqual([
      {
        service: "work",
        method: "POST",
        path: "/approvals",
        as: sender.id,
        body: { title: "Two monitors", details: "For the design team.", approverId: "u-anh", kind: "purchase", amount: 12000000, currency: null },
      },
    ]);
  });

  it("a money request without an amount is not sent: the assistant asks", async () => {
    model.script = (_req, n) => (n === 1 ? call1("request_approval", { title: "Advance", approver: "Nguyen Anh", kind: "advance" }) : { text: "How much is the advance?" });
    const r = await ask(sender, "Ask Anh for an advance");
    const done = await call(sender, "POST", `/assistant/pending/${r.body.pending.id}`, { approve: true });
    expect(done.body.answer).toBe("How much is the advance?");
    expect(writes()).toEqual([]);
  });
});

describe("small things the card and the page get right", () => {
  it("a list added after a list carries it on", async () => {
    const { appended, niceTime } = await import("../../src/modules/ai/workspace-tools.js");
    expect(appended("- a\n- b\n", "- c", false)).toBe("- a\n- b\n- c");
    expect(appended("Intro\n", "- c", false)).toBe("Intro\n\n- c");
    expect(appended("<p>x</p><ul><li>a</li></ul>", "<ul><li>b</li></ul>", true)).toBe("<p>x</p><ul><li>a</li><li>b</li></ul>");
    expect(appended("<ul><li>a</li></ul>", "<p>b</p>", true)).toBe("<ul><li>a</li></ul><p>b</p>");
    // The card shows the time as the person said it, in their language.
    expect(niceTime("2026-11-16T15:00:00+07:00", "en")).toBe("Mon, 16 Nov 2026, 15:00");
    expect(niceTime("2026-11-16", "en")).toBe("Mon, 16 Nov 2026");
    expect(niceTime("next week", "en")).toBe("next week");
  });
});
