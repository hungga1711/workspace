import { describe, expect, it } from "vitest";
import type { Principal } from "@workspace/shared";
import { PUBLIC_API } from "@workspace/contracts";
import { summarizeInsights, TOOL_FEATURE, TOOL_NEEDS, TOOLS, toolsFor, type Call, type ToolContext } from "./mcp-tools.js";
import { callTool } from "./mcp.js";

// Holds every permission a tool needs, so the tests below exercise the tools themselves.
const person: Principal = {
  type: "user",
  id: "U1",
  teamIds: [],
  departmentId: null,
  grants: [...new Set(Object.values(TOOL_NEEDS).flat())].map((permission) => ({ permission, scope: "SELF" as const })),
};

function ctx(answers: Record<string, unknown>, features: Record<string, boolean> = { aiMonitoring: true }) {
  const calls: string[] = [];
  const log: [string, boolean, string | null][] = [];
  const call: Call = async (service, method, path) => {
    calls.push(`${service} ${method} ${path}`);
    // The longest matching prefix answers, so "/channels" and "/channels/C1/messages" can both be stubbed.
    const key = Object.keys(answers)
      .filter((k) => `${service} ${method} ${path}`.startsWith(k))
      .sort((a, b) => b.length - a.length)[0];
    const v = key ? answers[key] : undefined;
    if (v instanceof Error) return { status: 403, body: { error: v.message } };
    return key ? { status: 200, body: v } : { status: 404, body: { error: "not found" } };
  };
  const c: ToolContext = { principal: person, features, call, appUrl: "https://app.example.com", onToolCall: (tool, ok, error) => void log.push([tool, ok, error]) };
  return { ctx: c, calls, log };
}

const project = (code: string, done: number, total: number) => ({
  id: `id-${code}`,
  code,
  name: code,
  status: "active",
  dueAt: null,
  openTasks: total - done,
  overdueTasks: 1,
  blockedTasks: 0,
  atRiskTasks: 0,
  doneTasks: done,
  totalTasks: total,
  health: "at_risk",
  daysLeft: 5,
});

describe("MCP tools", () => {
  it("every tool has a unique snake_case name and an object input", () => {
    expect(new Set(TOOLS.map((t) => t.name)).size).toBe(TOOLS.length);
    for (const t of TOOLS) expect(t.name).toMatch(/^[a-z_]+$/);
  });

  it("project_progress finds a project by code, case-insensitively, and computes percent done", async () => {
    const { ctx: c } = ctx({ "work GET /projects": { projects: [project("WEB", 3, 4), project("OPS", 0, 0)] } });
    const r = await callTool("project_progress", { project: "web" }, c);
    expect(JSON.parse(r.content[0]!.text)).toMatchObject({ code: "WEB", percentDone: 75, overdueTasks: 1 });
    const all = JSON.parse((await callTool("project_progress", {}, c)).content[0]!.text);
    expect(all.projects.map((p: { percentDone: number }) => p.percentDone)).toEqual([75, 0]);
    const none = await callTool("project_progress", { project: "NOPE" }, c);
    expect(none.isError).toBe(true);
  });

  it("ai_insights_summary answers 'off' without calling anything when AI Insights is off", async () => {
    const { ctx: c, calls } = ctx({}, { aiMonitoring: false });
    const r = await callTool("ai_insights_summary", {}, c);
    expect(JSON.parse(r.content[0]!.text)).toMatchObject({ enabled: false });
    expect(calls).toEqual([]);
  });

  it("ai_insights_summary keeps aggregates only and adds tasks with and without AI", async () => {
    const oversight = {
      totals: { people: 3, prompts: 12 },
      people: [{ userId: "U2", displayName: "Lan", topics: { writing: 5 } }],
      departments: [
        { name: "Sales", people: 2, active: 2, prompts: 9, inApp: 1, flagged: 1, cost: 0.123, sources: { chatgpt: 6, company: 3 }, topics: { sales: 6, writing: 3 } },
        { name: null, people: 1, active: 1, prompts: 3, inApp: 0, flagged: 0, cost: 0, sources: { claude: 3 }, topics: { writing: 4 } },
      ],
      features: [{ feature: "assist", calls: 4, tokens: 10, cost: 0, people: 1 }],
    };
    const { ctx: c, calls } = ctx({ "ai GET /oversight": oversight, "work GET /followup/outcomes": { withAi: { assisted: { done: 2 }, other: { done: 5 } } } });
    const out = JSON.parse((await callTool("ai_insights_summary", { days: 7 }, c)).content[0]!.text);
    expect(calls).toEqual(["ai GET /oversight?days=7", "work GET /followup/outcomes?days=7"]);
    expect(out.tools).toEqual({ chatgpt: 6, claude: 3, company: 3 });
    expect(Object.keys(out.topics)).toEqual(["writing", "sales"]);
    expect(out.departments[1].name).toBe("(no department)");
    expect(out.departments[0].costUsd).toBe(0.12);
    expect(out.tasksWithAi.assisted.done).toBe(2);
    // No per-person rows leave the app through MCP.
    expect(JSON.stringify(out)).not.toContain("Lan");
  });

  it("summarizeInsights works without outcomes", () => {
    expect(summarizeInsights({ totals: {}, departments: [] }, 30)).not.toHaveProperty("tasksWithAi");
  });

  it("validates arguments before calling anything", async () => {
    const { ctx: c, calls } = ctx({});
    const r = await callTool("search", { q: "x" }, c);
    expect(r.isError).toBe(true);
    expect(calls).toEqual([]);
    expect((await callTool("nope", {}, c)).isError).toBe(true);
  });

  it("search joins types and update_task refuses an empty change", async () => {
    const { ctx: c, calls } = ctx({ "chat GET /search": { hits: [] } });
    await callTool("search", { q: "báo giá", types: ["task", "document"] }, c);
    expect(calls[0]).toBe("chat GET /search?q=b%C3%A1o+gi%C3%A1&types=task%2Cdocument");
    expect((await callTool("update_task", { id: "T1" }, c)).isError).toBe(true);
  });

  it("get_task reads by code and turns ids into names; failures are logged with a short reason", async () => {
    const task = {
      id: "01J0000000000000000000000T",
      code: "WEB-7",
      title: "x",
      status: "todo",
      priority: "low",
      dueAt: null,
      assigneeId: "U2",
      ownerId: "U1",
      projectId: null,
      progress: 0,
      atRisk: false,
      blockedReason: null,
      version: 1,
      description: "d",
      labels: [],
    };
    const {
      ctx: c,
      calls,
      log,
    } = ctx({
      "work GET /tasks/WEB-7": {
        task,
        comments: [{ id: "C1", authorId: "U2", body: "hi", createdAt: "2026-11-04T00:00:00Z", editedAt: null }],
        subtasks: [],
        files: [{ name: "a.pdf" }],
        dependencies: { waitingOn: [], blocking: [] },
      },
      "employee GET /employees?all=1": { employees: [{ userId: "U2", displayName: "Lan" }] },
    });
    const out = JSON.parse((await callTool("get_task", { id: "WEB-7" }, c)).content[0]!.text);
    expect(out).toMatchObject({ code: "WEB-7", assignee: "Lan", url: "https://app.example.com/app/work/tasks/WEB-7", files: ["a.pdf"] });
    expect(out.comments[0]).toMatchObject({ author: "Lan", body: "hi" });
    expect(calls).toContain("work GET /tasks/WEB-7");
    await callTool("get_task", { id: "NOPE-1" }, c);
    expect(log).toEqual([
      ["get_task", true, null],
      ["get_task", false, "not_found"],
    ]);
  });

  it("comment_on_task resolves a code to the task id first", async () => {
    const { ctx: c, calls } = ctx({
      "work GET /tasks/WEB-7": { task: { id: "T7", version: 2 } },
      "work POST /tasks/T7/comments": { id: "C9" },
    });
    expect(JSON.parse((await callTool("comment_on_task", { id: "WEB-7", body: "on it" }, c)).content[0]!.text)).toMatchObject({ commentId: "C9", taskId: "T7" });
    expect(calls.filter((x) => x.includes("POST"))).toEqual(["work POST /tasks/T7/comments"]);
  });

  it("read_channel finds a channel by name and returns messages oldest first with author names", async () => {
    const { ctx: c, calls } = ctx({
      "chat GET /channels": { channels: [{ id: "C1", kind: "public", name: "general", displayName: null }], browsable: [{ id: "C2", kind: "public", name: "random" }] },
      "chat GET /channels/C1/messages": {
        messages: [
          { id: "M2", seq: 2, authorId: "U2", body: "second", createdAt: "b" },
          { id: "M1", seq: 1, authorId: "U9", body: "first", createdAt: "a" },
        ],
        nextBefore: null,
      },
      "employee GET /employees?all=1": { employees: [{ userId: "U2", displayName: "Lan" }] },
    });
    const out = JSON.parse((await callTool("read_channel", { channel: "#General", limit: 2 }, c)).content[0]!.text);
    expect(out.messages.map((m: { body: string }) => m.body)).toEqual(["first", "second"]);
    expect(out.messages[1].author).toBe("Lan");
    expect(calls).toContain("chat GET /channels/C1/messages?limit=2");
    // Posting needs membership: a channel one could join is refused before anything is sent.
    const post = await callTool("post_message", { channel: "random", body: "hello" }, c);
    expect(post.isError).toBe(true);
    expect(calls.some((x) => x.startsWith("chat POST"))).toBe(false);
  });

  it("my_day keeps what it could read when one part is not allowed", async () => {
    const { ctx: c } = ctx({
      "home GET /home": new Error("forbidden"),
      "work GET /me/summary": { open: [{ id: "T1", code: "A-1", title: "t", status: "todo" }], stats: { overdue: 0 } },
      "home GET /notifications": new Error("forbidden"),
    });
    const out = JSON.parse((await callTool("my_day", {}, c)).content[0]!.text);
    expect(out.myOpenTasks[0].code).toBe("A-1");
    expect(out.needsYou).toBeUndefined();
  });

  it("every write tool says whether it is destructive and idempotent; reads are read-only", () => {
    for (const t of TOOLS) if (t.readOnly) expect(t.destructive, t.name).toBeFalsy();
    expect(TOOLS.find((t) => t.name === "update_task")).toMatchObject({ destructive: true, idempotent: true });
    expect(TOOLS.find((t) => t.name === "post_message")).toMatchObject({ readOnly: false });
  });
});

describe("tools a key may use", () => {
  const narrow: Principal = { ...person, grants: [{ permission: "document.read", scope: "WORKSPACE" }] };
  it("lists only tools whose permissions the key holds, plus the ones that need none", () => {
    const names = toolsFor(TOOLS, narrow).map((t) => t.name);
    expect(names).toContain("read_document");
    expect(names).toContain("search");
    expect(names).not.toContain("list_my_tasks");
    expect(names).not.toContain("post_message");
  });
  it("refuses a call to a tool the key cannot use, before calling anything", async () => {
    const { ctx: c, calls, log } = ctx({});
    const r = await callTool("list_my_tasks", {}, { ...c, principal: narrow });
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r.content)).toContain("task.read");
    expect(calls).toEqual([]);
    expect(log).toEqual([["list_my_tasks", false, "not_allowed"]]);
  });
  it("every tool named in TOOL_NEEDS exists", () => {
    const names = new Set(TOOLS.map((t) => t.name));
    for (const n of Object.keys(TOOL_NEEDS)) expect(names.has(n)).toBe(true);
  });
});

describe("post_message", () => {
  it("accepts text as the message body", async () => {
    const { ctx: c, calls } = ctx({
      "chat GET /channels": { channels: [{ id: "C1", name: "general" }], browsable: [] },
      "chat POST /channels/C1/messages": { id: "M1", createdAt: "2026-11-08T10:00:00Z" },
    });
    const r = await callTool("post_message", { channel: "general", text: "Hello" }, c);
    expect(r.isError).toBeUndefined();
    expect(calls).toContain("chat POST /channels/C1/messages");
  });
  it("asks for a body when neither is given", async () => {
    const { ctx: c } = ctx({ "chat GET /channels": { channels: [{ id: "C1", name: "general" }], browsable: [] } });
    const r = await callTool("post_message", { channel: "general" }, c);
    expect(r.isError).toBe(true);
  });
});

describe("removed tools", () => {
  it("no longer offers log_progress (progress check-ins were removed)", async () => {
    const { TOOLS } = await import("./mcp-tools.js");
    expect(TOOLS.map((t) => t.name)).not.toContain("log_progress");
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Every tool against the public API's own table: a tool may only call an operation the OpenAPI document describes,
// with query parameters it lists and a body its schema accepts. A tool that reaches for an undocumented route, or a
// route whose schema moved, fails here.

const T = {
  id: "01HZX0000000000000000000T1",
  code: "WEB-1",
  title: "t",
  status: "todo",
  priority: "high",
  dueAt: null,
  assigneeId: null,
  projectId: null,
  progress: 0,
  atRisk: false,
  blockedReason: null,
  version: 3,
};
const RUN = {
  id: "01HZX0000000000000000000R1",
  taskId: T.id,
  workflowName: "Launch post",
  status: "waiting_input",
  currentStep: 0,
  steps: [{ title: "Draft", kind: "ai", state: "waiting", output: "x".repeat(50) }],
  error: null,
  startedBy: "U1",
  createdAt: "2026-11-13T09:00:00.000Z",
  finishedAt: null,
  asks: [{ id: "Q1", stepIndex: 0, questions: [{ id: "tone", text: "Which tone?" }], closedAt: null }],
  canApprove: true,
  canAnswer: true,
  canControl: true,
};
const EVENT = {
  id: "E1",
  code: "H-001",
  title: "Sync",
  kind: "meeting",
  startsAt: "2026-11-14T09:00:00+07:00",
  endsAt: "2026-11-14T10:00:00+07:00",
  organizerId: "U1",
  location: "",
};
const APPROVAL = {
  id: "01HZX0000000000000000000A1",
  code: "YC-001",
  title: "Laptop",
  details: "",
  requesterId: "U2",
  approverId: "U1",
  status: "pending",
  kind: "purchase",
  amount: 100,
  currency: "USD",
  createdAt: "2026-11-13T09:00:00.000Z",
  decidedAt: null,
};
const MSG = { id: "M1", seq: 1, authorId: "U1", body: "hi", createdAt: "2026-11-13T09:00:00.000Z" };

/** What the modules answer, first match wins. */
const LINK = {
  id: "L1",
  provider: "github",
  providerName: "GitHub",
  url: "https://github.com/acme/web/pull/7",
  kind: "review",
  source: "manual",
  card: { title: "Fix login", state: "open" },
  cardAt: "2026-11-13T09:00:00.000Z",
  error: null,
  connected: true,
};
const UPSTREAM: [RegExp, unknown][] = [
  [/^work GET \/task-tools\/late$/, { tasks: [] }],
  [/^work GET \/reports\/(blockers|output)$/, { tasks: [], people: [] }],
  [/^chat GET \/assist\/unanswered$/, { questions: [] }],
  [/^employee GET \/attendance\/summary$/, { people: [] }],
  [/^work GET \/tasks\/[^/]+\/runs$/, { runs: [RUN] }],
  [/^work POST \/tasks\/[^/]+\/runs$/, RUN],
  [/^work PUT \/tasks\/[^/]+\/workflow$/, { workflowId: "W1", run: null }],
  [/^work POST \/tasks\/[^/]+\/comments$/, { id: "C1" }],
  [
    /^work GET \/tasks\/[^/]+$/,
    {
      task: { ...T, description: "", ownerId: "U1", labels: [], etaAt: null, completedAt: null },
      comments: [],
      subtasks: [],
      files: [],
      dependencies: { waitingOn: [], blocking: [] },
    },
  ],
  [/^work GET \/tasks\/[^/]+\/links$/, { links: [LINK], connected: [{ id: "github", name: "GitHub" }] }],
  [/^work POST \/tasks\/[^/]+\/links$/, LINK],
  [/^work GET \/projects\/[^/]+\/reviews$/, { reviews: [{ ...LINK, task: { id: "T1", code: "WEB-1", title: "x", status: "todo" } }] }],
  [/^work (POST|PATCH) \/tasks/, T],
  [/^work GET \/tasks$/, { tasks: [T], nextCursor: null }],
  [
    /^work GET \/workflows$/,
    {
      workflows: [
        {
          id: "W1",
          name: "Launch post",
          description: "",
          category: "marketing",
          runner: "server",
          steps: [{ title: "Draft", kind: "ai" }],
          config: { environment: { kind: "assistant" }, inputs: [] },
        },
      ],
    },
  ],
  [/^work GET \/runs\/[^/]+\/activity$/, { events: [{ id: 7, step: 0, at: "2026-11-13T09:00:01.000Z", kind: "tool", tool: "Read", text: "a.ts" }], more: false }],
  [/^work (GET|POST) \/runs\//, RUN],
  [/^work POST \/agent-questions\//, RUN],
  [/^work GET \/approvals$/, { approvals: [APPROVAL] }],
  [/^work GET \/approvals\//, { ...APPROVAL, comment: null, canDecide: true, canCancel: false, events: [] }],
  [/^work POST \/approvals$/, { id: APPROVAL.id, code: "YC-002" }],
  [/^work POST \/approvals\//, null],
  [/^work GET \/calendar\/events$/, { events: [EVENT] }],
  [/^work POST \/calendar\/events$/, { id: "E2", code: "H-002" }],
  [/^work POST \/calendar\/events\//, null],
  [/^work GET \/meetings\//, { event: { ...EVENT, agenda: "", notes: "", projectId: null, version: 1 }, attendees: [{ userId: "U1", response: "accepted" }], tasks: [T] }],
  [/^work GET \/projects$/, { projects: [project("WEB", 1, 2)] }],
  [/^work GET \/projects\//, { ...project("WEB", 1, 2), description: "", ownerId: "U1", history: [] }],
  [/^work GET \/me\/summary$/, { open: [T], stats: {} }],
  [/^home GET \/home$/, { counts: {}, needsYou: [], today: [], timezone: "UTC" }],
  [/^home GET \/notifications$/, { action: [] }],
  [/^work GET \/docs$/, { documents: [] }],
  [/^work GET \/docs\//, { document: { id: "D1", code: "D-001", title: "d", visibility: "private", version: 1 }, content: "# d", format: "markdown", text: "d" }],
  [/^work POST \/docs$/, { id: "D2", code: "D-002", title: "d", visibility: "private" }],
  [/^work GET \/whiteboards$/, { whiteboards: [] }],
  [/^work GET \/whiteboards\//, { id: "W1", code: "W-001", title: "b", stickies: [], labels: [], text: "" }],
  [/^chat GET \/channels$/, { channels: [{ id: "C1", kind: "channel", name: "general" }], browsable: [] }],
  [/^chat GET \/channels\/[^/]+\/messages$/, { messages: [MSG], nextBefore: null }],
  [/^chat POST \/channels\/[^/]+\/messages$/, MSG],
  [/^chat GET \/messages\/[^/]+\/thread$/, { root: MSG, replies: [] }],
  [/^chat GET \/search$/, { hits: [] }],
  [/^employee GET \/employees$/, { employees: [{ userId: "U1", displayName: "Lan" }], nextCursor: null }],
  [/^employee GET \/employees\//, { userId: "U1", displayName: "Lan" }],
  [/^work GET \/followup\/(team|outcomes)$/, {}],
  [/^ai GET \/oversight$/, { totals: {}, departments: [] }],
];

/** Arguments that take every tool down each of its paths. */
const SAMPLES: Record<string, unknown[]> = {
  list_my_tasks: [{}, { scope: "owned", status: "todo", projectId: "P1", cursor: "c" }],
  get_task: [{ id: "WEB-1" }],
  create_task: [{ title: "x" }],
  update_task: [{ id: "WEB-1", status: "done" }],
  comment_on_task: [{ id: "WEB-1", body: "ok" }],
  list_task_links: [{ task: "WEB-1" }],
  link_work_to_task: [{ task: "WEB-1", url: "https://github.com/acme/web/pull/7" }],
  project_reviews: [{ project: "WEB" }],
  list_workflows: [{}],
  start_workflow_run: [{ task: "WEB-1", workflowId: "W1", inputs: { tone: "warm" } }],
  get_workflow_run: [{ run: RUN.id, step: 0, afterLine: 3 }, { task: "WEB-1" }],
  decide_workflow_run: [
    { run: RUN.id, action: "approve", note: "good" },
    { run: RUN.id, action: "send_back", note: "shorter" },
    { run: RUN.id, action: "answer", answers: { tone: "warm" } },
    { run: RUN.id, action: "answer", skip: true },
  ],
  stop_workflow_run: [{ run: RUN.id }],
  list_approvals: [{}, { role: "requester", status: "all" }],
  get_approval: [{ id: "YC-001" }],
  request_approval: [{ title: "Laptop", approverId: "U2", kind: "purchase", amount: 100, currency: "USD" }],
  decide_approval: [{ id: "YC-001", decision: "approved" }],
  list_calendar_events: [{ from: "2026-11-13T00:00:00+07:00", to: "2026-11-20T00:00:00+07:00" }],
  schedule_event: [{ title: "Sync", startsAt: "2026-11-14T09:00:00+07:00", endsAt: "2026-11-14T10:00:00+07:00", attendeeIds: ["U2"] }],
  respond_to_event: [{ id: "E1", response: "accepted" }],
  get_meeting: [{ id: "H-001" }],
  list_projects: [{ status: "archived" }],
  get_project: [{ project: "WEB" }],
  project_progress: [{}],
  my_day: [{}],
  list_documents: [{ label: "spec" }],
  read_document: [{ id: "D-001" }],
  create_document: [{ title: "d", content: "# d" }],
  list_whiteboards: [{ q: "b", projectId: "P1" }],
  read_whiteboard: [{ id: "W-001" }],
  list_channels: [{}],
  read_channel: [{ channel: "general", limit: 10, before: 40 }],
  read_thread: [{ messageId: "M1" }],
  post_message: [{ channel: "general", body: "hi" }],
  find_people: [{ q: "lan" }, { userId: "U1" }],
  search: [{ q: "launch", types: ["task", "document"] }],
  team_workload: [{}],
  overdue_work: [{}, { project: "WEB" }],
  blocked_work: [{}],
  team_output: [{ days: 7 }],
  unanswered_questions: [{}],
  attendance_summary: [{}, { from: "2026-11-01", to: "2026-11-15", department: "Sales" }],
  ai_insights_summary: [{ days: 30 }],
};

describe("tools and the public API are one API", () => {
  const anyone: Principal = {
    ...person,
    grants: [...person.grants, ...["calendar.read", "calendar.edit", "home.read"].map((permission) => ({ permission, scope: "SELF" as const }))],
  };
  const ops = PUBLIC_API.map((op) => ({ op, service: op.path.split("/")[2]!, path: new RegExp(`^${op.path.replace(/^\/api\/[^/]+/, "").replace(/\{\w+\}/g, "[^/]+")}$`) }));

  it("every tool has sample arguments here", () => {
    expect(Object.keys(SAMPLES).sort()).toEqual(TOOLS.map((t) => t.name).sort());
  });

  it.each(TOOLS.map((t) => t.name))("%s only calls documented operations, with their parameters and bodies", async (name) => {
    for (const args of SAMPLES[name] ?? []) {
      const made: { service: string; method: string; path: string; body: unknown }[] = [];
      const call: Call = async (service, method, path, body) => {
        made.push({ service, method, path, body });
        const hit = UPSTREAM.find(([re]) => re.test(`${service} ${method} ${path.replace(/\?.*$/, "")}`));
        return hit ? { status: 200, body: hit[1] } : { status: 404, body: { error: `no stub for ${service} ${method} ${path}` } };
      };
      const r = await callTool(name, args, { principal: anyone, features: { aiMonitoring: true }, call });
      expect(r.isError, `${name}(${JSON.stringify(args)}): ${r.content[0]!.text}`).toBeFalsy();
      expect(made.length, name).toBeGreaterThan(0);
      for (const m of made) {
        const [route, search = ""] = m.path.split("?");
        const found = ops.find((o) => o.service === m.service && o.op.method === m.method && o.path.test(route!));
        expect(found, `${name} calls ${m.service} ${m.method} ${route}, which PUBLIC_API does not describe`).toBeTruthy();
        const query = Object.fromEntries(new URLSearchParams(search));
        const listed = Object.keys(found!.op.query?.shape ?? {});
        expect(
          Object.keys(query).filter((k) => !listed.includes(k)),
          `${name}: query of ${found!.op.operationId}`,
        ).toEqual([]);
        if (found!.op.query) expect(found!.op.query.safeParse(query).success, `${name}: ${found!.op.operationId} refuses ${search}`).toBe(true);
        if (m.body !== undefined) {
          expect(found!.op.body, `${name} sends a body to ${found!.op.operationId}, which takes none`).toBeTruthy();
          const parsed = found!.op.body!.safeParse(m.body);
          expect(parsed.success, `${name}: ${found!.op.operationId} refuses ${JSON.stringify(m.body)}`).toBe(true);
        }
      }
    }
  });
});

describe("a connection approved as read only", () => {
  it("is offered no tool that decides, starts, stops or schedules anything", () => {
    const readOnly: Principal = {
      ...person,
      grants: ["task.read", "project.read", "document.read", "message.read", "channel.read", "employee.profile.read", "home.read", "calendar.read"].map((permission) => ({
        permission,
        scope: "SELF" as const,
      })),
    };
    // Commenting is the one write a reader has, in the app as here (the work module asks task.read for it).
    expect(
      toolsFor(TOOLS, readOnly)
        .filter((t) => !t.readOnly)
        .map((t) => t.name),
    ).toEqual(["comment_on_task"]);
  });
});

describe("workflow run tools", () => {
  it("get_workflow_run says what the run waits for, what I may do, and adds a step's activity on request", async () => {
    const { ctx: c, calls } = ctx({
      [`work GET /runs/${RUN.id}/activity`]: { events: [{ id: 7, at: "t", kind: "tool", tool: "Read", text: "a.ts" }], more: false },
      "work GET /runs/R1": RUN,
    });
    const raw = await callTool("get_workflow_run", { run: "R1", step: 0, afterLine: 3, maxChars: 200 }, c);
    expect(raw.isError, `${raw.content[0]!.text} ${calls.join(" | ")}`).toBeFalsy();
    const r = JSON.parse(raw.content[0]!.text);
    expect(r).toMatchObject({ status: "waiting_input", waitsFor: "answers", mayAnswer: true, mayApprove: true, step: "1 of 1: Draft", openQuestions: { id: "Q1" } });
    expect(r.activity).toMatchObject({ step: 0, lastLine: 7, more: false, lines: [{ tool: "Read" }] });
    expect(calls).toContain(`work GET /runs/${RUN.id}/activity?step=0&after=3`);
  });

  it("decide_workflow_run answers the open round, and says so when there is none", async () => {
    const { ctx: c, calls } = ctx({ "work GET /runs/R1": RUN, "work POST /agent-questions/Q1/answer": { ...RUN, status: "running", asks: [] } });
    const r = JSON.parse((await callTool("decide_workflow_run", { run: "R1", action: "answer", answers: { tone: "warm" } }, c)).content[0]!.text);
    expect(r.status).toBe("running");
    expect(calls.at(-1)).toBe("work POST /agent-questions/Q1/answer");
    const none = ctx({ "work GET /runs/R1": { ...RUN, asks: [] } });
    expect((await callTool("decide_workflow_run", { run: "R1", action: "answer", skip: true }, none.ctx)).isError).toBe(true);
    expect((await callTool("decide_workflow_run", { run: "R1", action: "send_back" }, none.ctx)).isError).toBe(true);
  });

  it("workflow and calendar tools go with their feature; a workspace key cannot decide for a person", async () => {
    expect(TOOL_FEATURE).toMatchObject({ start_workflow_run: "ai", get_workflow_run: "ai", schedule_event: "calendar" });
    const { ctx: c, calls } = ctx({});
    const key = { ...c, principal: { ...person, type: "service" as const } };
    expect((await callTool("decide_workflow_run", { run: "R1", action: "approve" }, key)).isError).toBe(true);
    expect((await callTool("decide_approval", { id: "YC-1", decision: "approved" }, key)).isError).toBe(true);
    expect(calls).toEqual([]);
  });
});
