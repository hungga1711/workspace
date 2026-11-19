import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { moduleUrl, PRINCIPAL_HEADER, ServiceClient, signInternalToken } from "@workspace/service-kit";
import { newId, type Grant, type Principal } from "@workspace/shared";
import { DEFAULT_ROLES, mergeGrants } from "../../src/modules/identity/catalog.js";
import { previewOf, workspaceTools, WORKSPACE_TOOL_NAMES, WORKSPACE_WRITE_TOOLS } from "../../src/modules/ai/workspace-tools.js";
import type { ToolContext } from "../../src/modules/ai/tools.js";
import type { Loc } from "../../src/modules/ai/locale.js";

/**
 * The workspace tools against the real modules: a test server (`pnpm test:server`, its internal port in
 * TEST_INTERNAL_PORT) hosts work, chat, employee, home and ai on the test database, and every tool runs through
 * workspaceTools().run as a real person with the built-in roles: what it reads, what it refuses, what a model's usual
 * mistakes (an unknown or ambiguous name, a wrong code) get back, and the feature switches.
 *
 * Skipped when no test server answers (run `TEST_INTERNAL_PORT=4101 pnpm test:server` first).
 */

const SECRET = process.env.INTERNAL_TOKEN_SECRET ?? "dev-internal-secret-change-me-32bytes!";
const DB = process.env.TEST_DATABASE ?? "workspace_test";
const ZONE = "Asia/Ho_Chi_Minh";
const up = await fetch(`${moduleUrl("work")}/health`)
  .then((r) => r.ok)
  .catch(() => false);

const role = (name: string) => DEFAULT_ROLES.find((r) => r.name === name)!.grants;
const EMPLOYEE = role("Employee");
const MANAGER = mergeGrants([...EMPLOYEE, ...role("Manager")]);
const OWNER = role("Owner");

const ids = { owner: newId(), minh: newId(), lan: newId(), an: newId(), minh2: newId(), outsider: newId() };
const dept = { board: "", eng: "", sales: "" };
const mk = (id: string, grants: Grant[], departmentId: string | null = null): Principal => ({ type: "user", id, teamIds: [], departmentId, grants });
let owner: Principal, minh: Principal, lan: Principal, an: Principal;

const svc = (name: Parameters<typeof moduleUrl>[0], grants: Grant[] = []) => new ServiceClient(moduleUrl(name), SECRET, "ai", grants);
const services: ToolContext["services"] = {
  chat: svc("chat", [{ permission: "agent.post", scope: "PLATFORM" }]),
  work: svc("work", [{ permission: "agent.post", scope: "PLATFORM" }]),
  employee: svc("employee"),
  ai: svc("ai"),
  home: svc("home"),
  identity: svc("identity"),
};
let aiPool: pg.Pool;
let ownerDb: pg.Pool;
let workDb: pg.Pool;
let chatDb: pg.Pool;

/** One tool call as `p`, the way Hỏi đáp runs it. */
async function tool(p: Principal, name: string, input: Record<string, unknown> = {}, loc: Loc = "en") {
  const t = workspaceTools(aiPool, { principal: p, agentId: null }, services, { withConfirm: true, loc, timeZone: ZONE });
  const r = await t.run(name, input);
  return { ok: r.ok, content: r.content, sources: t.sources, offered: t.byKey.has(name) };
}
const okTool = async (p: Principal, name: string, input: Record<string, unknown> = {}, loc: Loc = "en") => {
  const r = await tool(p, name, input, loc);
  expect(r.ok, `${name}: ${r.content}`).toBe(true);
  return r.content;
};
const failTool = async (p: Principal, name: string, input: Record<string, unknown> = {}, loc: Loc = "en") => {
  const r = await tool(p, name, input, loc);
  expect(r.ok, `${name} should fail: ${r.content}`).toBe(false);
  return r.content;
};

async function call<T = any>(module: "work" | "chat" | "employee" | "home" | "ai", p: Principal, method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${moduleUrl(module)}${path}`, {
    method,
    headers: { "content-type": "application/json", [PRINCIPAL_HEADER]: await signInternalToken({ principal: p, requestId: newId() }, SECRET) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const t = await res.text();
  if (!res.ok) throw new Error(`${method} ${module}${path} → ${res.status} ${t}`);
  return (t ? JSON.parse(t) : null) as T;
}

const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();
const seed: Record<string, any> = {};

beforeAll(async () => {
  if (!up) return;
  aiPool = new pg.Pool({ connectionString: process.env.AI_DATABASE_URL!, max: 4 });
  ownerDb = new pg.Pool({ connectionString: `postgres://workspace_owner:owner_pw@localhost:5432/${DB}`, max: 2 });
  // Triggers name their tables without a schema: each module's own search path.
  workDb = new pg.Pool({ connectionString: `postgres://workspace_owner:owner_pw@localhost:5432/${DB}?options=-c%20search_path%3Dwork`, max: 2 });
  chatDb = new pg.Pool({ connectionString: `postgres://workspace_owner:owner_pw@localhost:5432/${DB}?options=-c%20search_path%3Dchat`, max: 2 });
  owner = mk(ids.owner, OWNER);
  // The directory: two departments under the owner, two people called Minh (a model's favourite ambiguity).
  dept.board = (await call("employee", owner, "POST", "/departments", { name: "Ban giám đốc" })).id;
  dept.eng = (await call("employee", owner, "POST", "/departments", { name: "Kỹ thuật" })).id;
  dept.sales = (await call("employee", owner, "POST", "/departments", { name: "Kinh doanh" })).id;
  await call("employee", owner, "PUT", `/employees/${ids.owner}`, { displayName: "Hưng Trần", title: "CEO", departmentId: dept.board });
  await call("employee", owner, "PUT", `/employees/${ids.minh}`, { displayName: "Minh Lê", title: "Engineering Manager", departmentId: dept.eng, managerId: ids.owner });
  await call("employee", owner, "PUT", `/employees/${ids.lan}`, { displayName: "Lan Nguyễn", title: "Engineer", departmentId: dept.eng, managerId: ids.minh });
  await call("employee", owner, "PUT", `/employees/${ids.an}`, { displayName: "An Phạm", title: "Sales", departmentId: dept.sales, managerId: ids.owner });
  await call("employee", owner, "PUT", `/employees/${ids.minh2}`, { displayName: "Minh Trần", title: "Sales", departmentId: dept.sales, managerId: ids.owner });
  await call("employee", owner, "PATCH", `/departments/${dept.eng}`, { headId: ids.minh }).catch(() => undefined);
  minh = mk(ids.minh, MANAGER, dept.eng);
  lan = mk(ids.lan, EMPLOYEE, dept.eng);
  an = mk(ids.an, EMPLOYEE, dept.sales);
  // Chat adds only known members to conversations (identity's member events, not running here).
  for (const id of Object.values(ids)) await ownerDb.query("INSERT INTO chat.known_members (user_id) VALUES ($1) ON CONFLICT DO NOTHING", [id]);
  // Identity holds the emails (an import matches people by email first).
  for (const [key, name] of [
    ["owner", "Hưng Trần"],
    ["minh", "Minh Lê"],
    ["lan", "Lan Nguyễn"],
    ["an", "An Phạm"],
    ["minh2", "Minh Trần"],
  ] as const)
    await ownerDb.query("INSERT INTO identity.members (user_id, email, display_name, status) VALUES ($1, $2, $3, 'active') ON CONFLICT DO NOTHING", [
      ids[key],
      `${key}@example.com`,
      name,
    ]);

  // Work: a project, late, at-risk, blocked and finished tasks.
  const pr = await call("work", owner, "POST", "/projects", { name: "Launch" });
  seed.project = pr;
  const task = (p: Principal, body: Record<string, unknown>) => call<{ id: string; code: string; title: string }>("work", p, "POST", "/tasks", { projectId: pr.id, ...body });
  const now = Date.now();
  seed.late = await task(owner, { title: "Write the launch blog post", assigneeId: ids.lan, dueAt: iso(now - 3 * DAY) });
  seed.lateAn = await task(owner, { title: "Call the ten biggest customers", assigneeId: ids.an, dueAt: iso(now - 2 * DAY) });
  seed.api = await task(owner, { title: "Build the billing API", assigneeId: ids.minh, dueAt: iso(now + 5 * DAY) });
  seed.ui = await task(owner, { title: "Build the billing screen", assigneeId: ids.lan, dueAt: iso(now + 6 * DAY) });
  seed.dup1 = await task(owner, { title: "Update the pricing page", assigneeId: ids.lan });
  seed.dup2 = await task(owner, { title: "Update pricing page", assigneeId: ids.an });
  seed.free = await task(owner, { title: "Plan the team offsite" });
  for (const [i, title] of ["Build the reports API", "Build the export API", "Build the audit API"].entries()) {
    const t = await task(owner, { title, assigneeId: ids.minh });
    // Finished work with a known cycle time (started i+2 days before it was done).
    await workDb.query("UPDATE tasks SET status = 'done', started_at = $2, completed_at = $3, created_at = $2 WHERE id = $1", [
      t.id,
      new Date(now - (10 + i + 2) * DAY),
      new Date(now - 10 * DAY),
    ]);
    seed[`done${i}`] = t;
  }
  // The billing screen waits on the API, and the API is blocked.
  await call("work", owner, "POST", `/tasks/${seed.ui.id}/dependencies`, { predecessorId: seed.api.id });
  const api = (await call("work", owner, "GET", `/tasks/${seed.api.id}`)).task;
  await call("work", owner, "PATCH", `/tasks/${seed.api.id}`, { expectedVersion: api.version, blockedReason: "Waiting for the payment provider's keys" });

  // Chat: a channel with a question to Lan nobody answered, and an action item.
  const ch = await call("chat", minh, "POST", "/channels", { kind: "public", name: "launch", displayName: "Launch", memberIds: [ids.lan, ids.an, ids.owner] });
  seed.channel = ch;
  seed.q = await call("chat", an, "POST", `/channels/${ch.id}/messages`, { body: `<@${ids.lan}> can you send me the release notes?` });
  seed.commit = await call("chat", minh, "POST", `/channels/${ch.id}/messages`, { body: "I'll finish the billing API by Friday." });
  await chatDb.query("UPDATE messages SET created_at = now() - interval '6 hours' WHERE id = $1", [seed.q.id]);

  // Docs: a page with two versions.
  const doc = await call("work", owner, "POST", "/docs", {
    title: "Launch plan",
    content: "# Launch plan\n\n## Goals\n\nShip billing.\n\n## Steps\n\n- Build the API\n- Build the screen",
    format: "markdown",
    projectId: null,
  });
  const d1 = (await call("work", owner, "GET", `/docs/${doc.id}`)).document;
  await call("work", owner, "PUT", `/docs/${doc.id}`, {
    content: "# Launch plan\n\n## Goals\n\nShip billing and reports.\n\n## Steps\n\n- Build the API\n- Build the screen\n- Write the blog post",
    baseVersion: d1.version,
    format: "markdown",
  });
  seed.doc = (await call("work", owner, "GET", `/docs/${doc.id}`)).document;
}, 120_000);

afterAll(async () => {
  await aiPool?.end();
  await ownerDb?.end();
  await workDb?.end();
  await chatDb?.end();
});

const ALL_FEATURES_ON = () => {
  delete process.env.DISABLED_FEATURES;
};

describe.skipIf(!up)("registry and cards", () => {
  it("registers every tool once, with a card for every write tool in English and Vietnamese", () => {
    expect(new Set(WORKSPACE_TOOL_NAMES).size).toBe(WORKSPACE_TOOL_NAMES.length);
    for (const name of WORKSPACE_WRITE_TOOLS)
      for (const loc of ["en", "vi"] as const) {
        const card = previewOf(name, {}, loc);
        expect(card, name).not.toBeNull();
        expect(card!.title.trim().length, name).toBeGreaterThan(0);
        // An empty input shows no empty fields and never "undefined" or "[object Object]".
        expect(JSON.stringify(card), name).not.toMatch(/undefined|\[object Object\]/);
      }
  });

  it("shows what will change on each new write tool's card, in the asker's language", () => {
    const at = "2026-12-01T09:00:00+07:00";
    const cards: [string, Record<string, unknown>, string[]][] = [
      ["assign_task", { task: "T-7", assignee: "An", dueAt: at }, ["T-7", "An", "2026"]],
      ["split_task", { task: "T-3", subtasks: [{ title: "Design", assignee: "Minh", dueAt: at }, { title: "Test" }] }, ["Design → Minh", "Test"]],
      ["move_tasks_bulk", { tasks: ["T-1", "T-2"], status: "done", addLabels: ["q4"] }, ["T-1, T-2", "done", "q4"]],
      ["link_tasks", { task: "T-1", relation: "blocked_by", other: "T-4" }, ["T-1", "T-4"]],
      ["onboarding_checklist", { newHire: "Bình", startDate: at }, ["Bình", "2026"]],
      ["pin_message", { message: "01M7KMY76TRXGNN7J07DBBF83K", quote: "can you send" }, ["can you send"]],
      ["create_poll", { channel: "#launch", question: "Launch day?", options: ["Mon", "Tue"], multi: true }, ["#launch", "Launch day?", "Mon, Tue"]],
      ["weekly_report", { of: "Kỹ thuật" }, ["Kỹ thuật"]],
      ["translate_document", { document: "D-1", language: "English", title: "Plan", content: "# Plan" }, ["D-1", "English", "# Plan"]],
      [
        "create_whiteboard_diagram",
        {
          title: "Flow",
          kind: "flow",
          nodes: [
            { id: "a", label: "Code" },
            { id: "b", label: "Ship" },
          ],
        },
        ["Flow", "Code · Ship"],
      ],
      ["create_workflow_from_description", { name: "Review", steps: [{ title: "Draft", kind: "ai" }] }, ["Review", "Draft (ai)"]],
      ["import_tasks", { project: "P-1", text: "Summary,Status\nA,To Do\nB,Done" }, ["P-1", "A · B"]],
      ["request_leave", { startDate: "2026-12-07", endDate: "2026-12-08", reason: "Family", balanceAfter: 10 }, ["2026-12-07", "Family", "10"]],
      ["schedule_reminder", { at, message: "Send notes", person: "Minh" }, ["Send notes", "2026"]],
    ];
    for (const [name, input, want] of cards)
      for (const loc of ["en", "vi"] as const) {
        const text = JSON.stringify(previewOf(name, input, loc));
        for (const w of want) expect(text, `${name} ${loc}`).toContain(w);
      }
    expect(previewOf("assign_task", { task: "T-7", assignee: "An" }, "vi")!.title).toBe("Giao T-7");
    expect(previewOf("request_leave", { startDate: "2026-12-07", endDate: "2026-12-08" }, "vi")!.title).toBe("Gửi đơn xin nghỉ");
  });
});

describe.skipIf(!up)("task tools", () => {
  it("overdue_tasks: grouped by person, narrowed by department, and an ambiguous name is asked back", async () => {
    const all = await okTool(owner, "overdue_tasks");
    expect(all).toContain("2 overdue");
    expect(all).toContain(`[Lan Nguyễn] ${seed.late.code}`);
    const sales = await okTool(owner, "overdue_tasks", { department: "Kinh doanh" });
    expect(sales).toContain(seed.lateAn.code);
    expect(sales).not.toContain(seed.late.code);
    expect(await failTool(owner, "overdue_tasks", { person: "Minh" })).toMatch(/Several people match "Minh": Minh Lê, Minh Trần/);
    expect(await failTool(owner, "overdue_tasks", { department: "Marketing" })).toMatch(/No department called "Marketing"/);
    // A short first name is that person, not everyone whose name contains it (Lan, Thanh…).
    expect(await okTool(owner, "overdue_tasks", { person: "An" })).toContain("[late · An Phạm]");
    expect(await okTool(owner, "overdue_tasks", {}, "vi")).toContain("việc trễ hạn");
  });

  it("find_duplicate_tasks, task_history and estimate_due_date read real data; a wrong code is refused", async () => {
    const dup = await okTool(owner, "find_duplicate_tasks");
    expect(dup).toContain(seed.dup1.code);
    expect(dup).toContain(seed.dup2.code);
    const h = await okTool(owner, "task_history", { task: seed.api.code });
    expect(h).toContain("blocked now: Waiting for the payment provider's keys");
    expect(h).toContain("created");
    expect(h).not.toMatch(/— → —/);
    expect(await okTool(owner, "task_history", { task: seed.ui.code })).toContain(`now waits on ${seed.api.code}`);
    expect(await failTool(owner, "task_history", { task: "T-9999" })).toMatch(/^DENIED/);
    const est = await okTool(owner, "estimate_due_date", { title: "Build the payments API" });
    expect(est).toMatch(/Based on 3 similar tasks: median 3 days/);
    expect(await okTool(owner, "estimate_due_date", { title: seed.api.code })).toContain("similar");
  });
});

describe.skipIf(!up)("chat tools", () => {
  it("summarize_channel: the channel since last read, names for mentions, the unread list with no channel, nothing for a stranger", async () => {
    const c = await okTool(lan, "summarize_channel", { channel: "launch" });
    expect(c).toContain("#Launch");
    expect(c).toContain("An Phạm: @Lan Nguyễn can you send me the release notes?");
    // Ids are for tool calls only: a mention is never shown as <@id>.
    expect(c).not.toMatch(/<@/);
    expect(await okTool(lan, "summarize_channel", { channel: seed.channel.id })).toContain("#Launch");
    expect(await okTool(lan, "summarize_channel", {}, "vi")).toMatch(/## #Launch \(2 chưa đọc, 1 nhắc tên người dùng\)/);
    expect(await failTool(lan, "summarize_channel", { channel: "#nowhere" })).toMatch(/not a channel the user is in/);
    // A direct conversation that does not exist is not created by a read.
    expect(await failTool(lan, "summarize_channel", { channel: "Minh Trần" })).toMatch(/no direct conversation with Minh Trần/);
  });

  it("extract_action_items, unanswered_questions, draft_reply and needs_my_attention", async () => {
    const a = await okTool(lan, "extract_action_items", { channel: "#launch" });
    expect(a).toContain("I'll finish the billing API by Friday.");
    const u = await okTool(lan, "unanswered_questions");
    expect(u).toContain("An Phạm · waiting 6h: @Lan Nguyễn can you send me the release notes?");
    expect(await okTool(an, "unanswered_questions")).toMatch(/No unanswered questions/);
    const d = await okTool(lan, "draft_reply", { message: seed.q.id });
    expect(d).toContain("The user is Lan Nguyễn.");
    expect(await failTool(lan, "draft_reply", { message: "not-an-id" })).toMatch(/invalid|message/i);
    const n = await okTool(lan, "needs_my_attention");
    expect(n).toContain("## Unread mentions (1)");
    expect(n).toContain(`[task ${seed.late.code}] Write the launch blog post · OVERDUE since`);
    expect(n).not.toContain("could not be read");
  });
});

describe.skipIf(!up)("report tools", () => {
  it("person_progress: a manager sees their report, a colleague in another department is refused", async () => {
    expect(await okTool(minh, "person_progress", { person: "Lan" })).toContain("[person Lan Nguyễn, Engineer, Kỹ thuật]");
    expect(await okTool(owner, "person_progress", { person: "An" })).toContain("[person An Phạm");
    expect(await failTool(an, "person_progress", { person: "Lan" })).toMatch(/^DENIED/);
  });

  it("department_compare, workload_balance and weekly_report_text follow who the asker follows", async () => {
    const all = await okTool(owner, "department_compare");
    expect(all).toContain("Kỹ thuật |");
    expect(all).toContain("Kinh doanh |");
    const mine = await okTool(minh, "department_compare");
    expect(mine).toContain("Kỹ thuật | 1 |");
    expect(mine).not.toContain("Kinh doanh");
    expect(await okTool(lan, "department_compare")).toContain("Nobody reports to the user");
    const w = await okTool(owner, "workload_balance");
    expect(w).toMatch(/Lan Nguyễn \(Kỹ thuật\) \| 3 \| 1 \| 1 \| 0 \| busy/);
    expect(await okTool(owner, "weekly_report_text", { of: "An" })).toContain("# Weekly report: An Phạm");
    expect(await okTool(owner, "weekly_report_text", { of: "Kỹ thuật" })).toContain("# Weekly report: Kỹ thuật");
    expect(await okTool(owner, "weekly_report_text", {}, "vi")).toContain("Báo cáo tuần");
  });

  it("blockers_report and trend_metric: chains, a department by name, a person by first name, and a clear refusal", async () => {
    const b = await okTool(owner, "blockers_report");
    expect(b).toContain(`${seed.ui.code} Build the billing screen → Lan Nguyễn`);
    expect(b).toContain(`waits on ${seed.api.code} (Minh Lê, todo)`);
    expect(await okTool(owner, "blockers_report", { department: "Kinh doanh" })).toContain("Nothing is blocked");
    const t = await okTool(owner, "trend_metric", { of: "Kỹ thuật", weeks: 4 });
    expect(t).toContain("[trend Kỹ thuật, 4 weeks]");
    expect(t.split("\n")).toHaveLength(5);
    expect(await okTool(owner, "trend_metric", { of: "An" })).toContain("[trend An Phạm");
    expect(await failTool(lan, "trend_metric")).toMatch(/may not see the trend of the company/);
    expect(await okTool(lan, "trend_metric", { of: "me", weeks: 2 })).toContain("[trend Lan Nguyễn");
  });

  it("the AI report tools answer on an installation with no AI use yet", async () => {
    expect(await okTool(owner, "ai_usage_vs_output")).toContain("Minh Lê (Kỹ thuật) | 0 (–) | 3 (–)");
    expect(await okTool(lan, "ai_usage_vs_output")).not.toContain("Minh Lê");
    expect(await okTool(owner, "prompt_topics")).toContain("No AI use recorded");
    expect(await okTool(owner, "ai_spend")).toContain("[AI spend, 30 days]");
    expect(await okTool(owner, "suggest_ai_adoption")).toContain("[not using AI]");
  });
});

describe.skipIf(!up)("content tools", () => {
  it("pages: summarize, compare versions, turn into tasks; a private page is refused to others", async () => {
    const s = await okTool(owner, "summarize_document", { document: seed.doc.id });
    expect(s).toContain('Page "Launch plan" (version 2');
    expect(s).toContain("<untrusted_content>");
    const c = await okTool(owner, "compare_document_versions", { document: seed.doc.id });
    expect(c).toContain("version 1 → 2, 2 lines added, 1 removed");
    expect(c).toContain("+ Ship billing and reports.");
    expect(await okTool(owner, "doc_to_tasks", { document: seed.doc.code })).toContain("create_task once they agree");
    expect(await failTool(lan, "summarize_document", { document: seed.doc.id })).toMatch(/^DENIED/);
    expect(await failTool(owner, "summarize_document", { document: "D-999" })).toMatch(/^DENIED/);
  });

  it("workflow_run_status, import_preview (people matched by email) and export_report", async () => {
    expect(await okTool(owner, "workflow_run_status")).toContain("Last 30 days: 0 runs");
    const pre = await okTool(owner, "import_preview", { text: "Summary,Assignee,Status,Due Date\nFix login,lan@example.com,To Do,2026-12-01\nWrite docs,Nobody Here,Done," });
    expect(pre).toContain("2 tasks");
    expect(pre).toContain("1 with a matched assignee");
    expect(pre).toContain("Not found in the workspace (left unassigned): Nobody Here.");
    const csv = await okTool(owner, "export_report", { status: "open", assignee: "Lan" });
    expect(csv).toContain("code,title,status,priority,assignee,due,completed,labels");
    expect(csv).toContain(`${seed.late.code},Write the launch blog post,todo,medium,Lan Nguyễn,`);
    expect(csv).not.toContain("An Phạm");
  });
});

describe.skipIf(!up)("people tools", () => {
  it("find_meeting_slot: free times in working hours; an ambiguous colleague is asked back", async () => {
    const s = await okTool(lan, "find_meeting_slot", { people: ["Minh Lê"], from: "2026-12-07", to: "2026-12-07" });
    expect(s).toContain("Free for you and Minh Lê, 30 min");
    expect(s).toContain("[2026-12-07T02:00:00.000Z]");
    expect(await failTool(lan, "find_meeting_slot", { people: ["Minh"] })).toMatch(/Several people match/);
    expect(await failTool(lan, "find_meeting_slot", { people: ["Minh Lê"], from: "2026-01-05", to: "2026-01-06" })).toMatch(/already over/);
  });

  it("attendance_summary says when nobody checks in, instead of calling everyone absent", async () => {
    expect(await okTool(owner, "attendance_summary")).toMatch(/No check-ins recorded .* for the 5 people/);
    expect(await okTool(lan, "attendance_summary")).toMatch(/for the 1 people/);
  });

  it("org_chart and who_reports_to", async () => {
    const o = await okTool(lan, "org_chart");
    expect(o).toContain("- Hưng Trần, CEO (Ban giám đốc)");
    expect(o).toContain("    - Lan Nguyễn, Engineer (Kỹ thuật)");
    expect(await okTool(lan, "org_chart", { department: "Kỹ thuật" })).toContain("Kỹ thuật (2 people, head: Minh Lê)");
    expect(await failTool(lan, "org_chart", { department: "Marketing" })).toMatch(/No department matches/);
    expect(await okTool(lan, "who_reports_to")).toContain("Reports to: Minh Lê (Engineering Manager) → Hưng Trần (CEO)");
    expect(await okTool(lan, "who_reports_to", { person: "Minh Lê" }, "vi")).toContain("Cấp dưới trực tiếp (1): Lan Nguyễn");
  });
});

describe.skipIf(!up)("write tools change real data as the asker, and the module refuses what the person may not do", () => {
  it("assign_task reports the new load; an employee cannot take someone else's task", async () => {
    expect(await okTool(owner, "assign_task", { task: seed.free.code, assignee: "An" })).toMatch(/Assigned .* to An Phạm\. An Phạm now has 3 open tasks \(1 overdue/);
    expect((await call("work", owner, "GET", `/tasks/${seed.free.id}`)).task.assigneeId).toBe(ids.an);
    expect(await failTool(lan, "assign_task", { task: seed.lateAn.code, assignee: "me" })).toMatch(/^DENIED/);
    expect((await call("work", owner, "GET", `/tasks/${seed.lateAn.id}`)).task.assigneeId).toBe(ids.an);
  });

  it("split_task creates subtasks in order, and checks every name before creating any", async () => {
    const before = (await call("work", owner, "GET", `/tasks/${seed.api.id}`)).subtasks.length;
    expect(await failTool(owner, "split_task", { task: seed.api.code, subtasks: [{ title: "ok" }, { title: "x", assignee: "Nobody" }] })).toMatch(/Nobody in the workspace/);
    expect((await call("work", owner, "GET", `/tasks/${seed.api.id}`)).subtasks).toHaveLength(before);
    expect(await okTool(owner, "split_task", { task: seed.api.code, subtasks: [{ title: "Design endpoints", assignee: "Minh Lê" }, { title: "Write tests" }] })).toMatch(
      /Created 2 subtasks/,
    );
    const subs = (await call("work", owner, "GET", `/tasks/${seed.api.id}`)).subtasks as { title: string }[];
    expect(subs.map((x) => x.title)).toEqual(expect.arrayContaining(["Design endpoints", "Write tests"]));
  });

  it("move_tasks_bulk changes what the person may change and names what it could not", async () => {
    expect(await okTool(owner, "move_tasks_bulk", { tasks: [seed.dup1.code, seed.dup2.code], priority: "high" })).toBe("Changed 2 of 2 tasks.");
    expect((await call("work", owner, "GET", `/tasks/${seed.dup2.id}`)).task.priority).toBe("high");
    expect(await okTool(lan, "move_tasks_bulk", { tasks: [seed.lateAn.code], status: "done" })).toMatch(/Changed 0 of 1 tasks\. Not changed: .* \(forbidden\)/);
    expect((await call("work", owner, "GET", `/tasks/${seed.lateAn.id}`)).task.status).toBe("todo");
    expect(await failTool(owner, "move_tasks_bulk", { tasks: [seed.dup1.code] })).toMatch(/Nothing to change/);
  });

  it("link_tasks and onboarding_checklist", async () => {
    expect(await okTool(owner, "link_tasks", { task: seed.late.code, relation: "blocked_by", other: seed.ui.code })).toBe(`${seed.late.code} now waits on ${seed.ui.code}.`);
    expect(await failTool(owner, "link_tasks", { task: seed.late.code, relation: "blocks", other: seed.late.code })).toMatch(/cannot depend on itself/);
    expect(await okTool(owner, "onboarding_checklist", { newHire: "Bình Võ", startDate: "2026-12-01T09:00:00+07:00" })).toMatch(/with 8 steps \(Bình Võ has no account yet/);
    // Two colleagues called Minh: asked back, never treated as a new hire without an account.
    expect(await failTool(owner, "onboarding_checklist", { newHire: "Minh", startDate: "2026-12-01T09:00:00+07:00" })).toMatch(/Several people match "Minh"/);
  });

  it("pin_message and create_poll in a channel the person is in; a stranger's channel is refused", async () => {
    expect(await okTool(lan, "pin_message", { message: seed.commit.id })).toBe("Pinned.");
    expect(await okTool(lan, "create_poll", { channel: "launch", question: "Launch day?", options: ["Mon", "Tue"] })).toBe("Poll posted in #Launch.");
    const stranger = mk(ids.minh2, EMPLOYEE, dept.sales);
    expect(await failTool(stranger, "pin_message", { message: seed.commit.id })).toMatch(/^DENIED/);
  });

  it("pages, boards, workflows and imports", async () => {
    expect(await okTool(owner, "weekly_report", { of: "Kỹ thuật" })).toMatch(/Created the page "Weekly report: Kỹ thuật/);
    expect(await okTool(owner, "translate_document", { document: seed.doc.id, language: "Tiếng Việt", title: "Kế hoạch ra mắt", content: "# Kế hoạch" })).toContain(
      'the Tiếng Việt translation of "Launch plan"',
    );
    expect(
      await okTool(owner, "create_whiteboard_diagram", {
        title: "Release flow",
        kind: "flow",
        nodes: [
          { id: "a", label: "Code" },
          { id: "b", label: "Review", shape: "decision" },
          { id: "c", label: "Ship" },
        ],
        edges: [
          { from: "a", to: "b" },
          { from: "b", to: "c", label: "Yes" },
        ],
      }),
    ).toMatch(/Created the board and drew a flow with 3 boxes on W-\d+ "Release flow"/);
    expect(await failTool(owner, "create_whiteboard_diagram", { kind: "flow", nodes: [{ id: "a", label: "A" }], edges: [{ from: "a", to: "z" }] })).toMatch(/names a node/);
    expect(
      await okTool(owner, "create_workflow_from_description", {
        name: "Blog review",
        steps: [
          { title: "Draft", kind: "ai", prompt: "Draft a post about {{task.title}}" },
          { title: "Check", kind: "check", criteria: "Under 800 words" },
          { title: "Approve", kind: "approval" },
          { title: "Done", kind: "status", status: "done" },
        ],
      }),
    ).toContain('Created the workflow "Blog review" with 4 steps');
    expect(await failTool(owner, "create_workflow_from_description", { name: "Bad", steps: [{ title: "Draft", kind: "ai" }] })).toMatch(/needs a prompt/);
    expect(await okTool(owner, "import_tasks", { project: seed.project.code, text: "Summary,Assignee,Status\nFix login,lan@example.com,To Do\nWrite docs,An Phạm,Done" })).toBe(
      `Imported 2 tasks into ${seed.project.code} Launch.`,
    );
    const imported = (await call("work", owner, "GET", `/tasks?projectId=${seed.project.id}`)).tasks as { title: string; assigneeId: string | null }[];
    expect(imported.find((t) => t.title === "Fix login")?.assigneeId).toBe(ids.lan);
  });

  it("request_leave goes through the leave rules; schedule_reminder for oneself and for a colleague", async () => {
    expect(await failTool(lan, "request_leave", { startDate: "2026-12-07", endDate: "2026-12-08", reason: "Family" })).toMatch(/Not enough Annual leave left: 0 day/);
    expect(await failTool(lan, "request_leave", { type: "holiday-xyz", startDate: "2026-12-07", endDate: "2026-12-08" })).toMatch(/No leave type "holiday-xyz"/);
    expect(await okTool(lan, "request_leave", { type: "unpaid", startDate: "2026-12-07", endDate: "2026-12-08" })).toMatch(
      /Leave request sent: Unpaid leave, 07\/12–08\/12, 2 working day/,
    );
    expect(await failTool(lan, "request_leave", { type: "unpaid", startDate: "2026-12-08", endDate: "2026-12-08" })).toMatch(/already has a leave request/);
    const soon = new Date(Date.now() + 3600_000).toISOString();
    expect(await okTool(lan, "schedule_reminder", { at: soon, message: "Send the release notes" })).toMatch(/^Reminder set for/);
    expect(await okTool(lan, "schedule_reminder", { at: soon, message: "Please review", person: "Minh Lê" })).toMatch(/^Minh Lê will get this message at/);
    expect(await failTool(lan, "schedule_reminder", { at: new Date(Date.now() - 3600_000).toISOString(), message: "Past" })).toMatch(/from now to a year ahead/);
  });
});

describe.skipIf(!up)("deploy-time feature switches", () => {
  it("leaves out each feature's tools and refuses them if called anyway", async () => {
    const cases: [string, string, Principal, Record<string, unknown>][] = [
      ["docs", "summarize_document", owner, { document: seed.doc.id }],
      ["docs", "weekly_report", owner, {}],
      ["whiteboards", "create_whiteboard_diagram", owner, { kind: "flow", nodes: [{ id: "a", label: "A" }] }],
      ["calendar", "find_meeting_slot", lan, { people: ["Minh Lê"] }],
      ["time", "attendance_summary", lan, {}],
      ["time", "request_leave", lan, { startDate: "2026-12-14", endDate: "2026-12-14" }],
      ["ai", "ai_spend", owner, {}],
      ["ai", "prompt_topics", owner, {}],
    ];
    try {
      for (const [feature, name, p, input] of cases) {
        process.env.DISABLED_FEATURES = feature;
        const r = await tool(p, name, input);
        expect(r.offered, `${name} offered without ${feature}`).toBe(false);
        expect(r.ok).toBe(false);
        expect(r.content).toBe(`DENIED: ${feature} is not part of this installation`);
      }
      // Without docs the weekly report is still there as text.
      process.env.DISABLED_FEATURES = "docs";
      expect((await tool(owner, "weekly_report_text")).ok).toBe(true);
    } finally {
      ALL_FEATURES_ON();
    }
    expect((await tool(owner, "ai_spend")).offered).toBe(true);
  });
});

describe.skipIf(!up)("an empty workspace", () => {
  it("answers plainly for someone with nothing (no tasks, no channels, no reports)", async () => {
    const nobody = mk(newId(), EMPLOYEE);
    expect(await okTool(nobody, "needs_my_attention")).toContain("Nothing is waiting on the user right now.");
    expect(await okTool(nobody, "summarize_channel")).toContain("no unread messages");
    expect(await okTool(nobody, "unanswered_questions")).toContain("No unanswered questions");
    expect(await okTool(nobody, "workload_balance")).toContain("Nobody reports to the user");
    expect(await failTool(nobody, "who_reports_to")).toMatch(/not in the active directory/);
  });
});
