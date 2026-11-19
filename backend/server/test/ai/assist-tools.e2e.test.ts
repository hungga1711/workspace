import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { moduleUrl, PRINCIPAL_HEADER, ServiceClient, signInternalToken } from "@workspace/service-kit";
import { newId, type Grant, type Principal } from "@workspace/shared";
import { DEFAULT_ROLES } from "../../src/modules/identity/catalog.js";
import { toolTitle, workspaceTools } from "../../src/modules/ai/workspace-tools.js";
import { Trace, type Step } from "../../src/modules/ai/progress.js";
import { setToolCache } from "../../src/modules/ai/tool-cache.js";
import type { ToolContext } from "../../src/modules/ai/tools.js";
import type { Loc } from "../../src/modules/ai/locale.js";

/**
 * plan_my_day and draft_update (tools-assist.ts) against the real modules, with the answer's progress (each call shown
 * as it starts and ends) and the short-lived read cache. Needs a test server (`pnpm test:server`, its internal port
 * in TEST_INTERNAL_PORT); skipped without one.
 */

const SECRET = process.env.INTERNAL_TOKEN_SECRET ?? "dev-internal-secret-change-me-32bytes!";
const ZONE = "Asia/Ho_Chi_Minh";
const up = await fetch(`${moduleUrl("work")}/health`)
  .then((r) => r.ok)
  .catch(() => false);

const EMPLOYEE = DEFAULT_ROLES.find((r) => r.name === "Employee")!.grants;
const OWNER = DEFAULT_ROLES.find((r) => r.name === "Owner")!.grants;
const mk = (id: string, grants: Grant[]): Principal => ({ type: "user", id, teamIds: [], departmentId: null, grants });
const ids = { owner: newId(), lan: newId(), an: newId() };
let owner: Principal, lan: Principal, an: Principal;

const svc = (name: Parameters<typeof moduleUrl>[0]) => new ServiceClient(moduleUrl(name), SECRET, "ai", []);
const services: ToolContext["services"] = { chat: svc("chat"), work: svc("work"), employee: svc("employee"), ai: svc("ai"), home: svc("home"), identity: svc("identity") };
let aiPool: pg.Pool;

async function call<T = any>(module: "work" | "employee", p: Principal, method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${moduleUrl(module)}${path}`, {
    method,
    headers: { "content-type": "application/json", [PRINCIPAL_HEADER]: await signInternalToken({ principal: p, requestId: newId() }, SECRET) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const t = await res.text();
  if (!res.ok) throw new Error(`${method} ${module}${path} → ${res.status} ${t}`);
  return (t ? JSON.parse(t) : null) as T;
}

function tools(p: Principal, loc: Loc = "en", steps?: Step[]) {
  const progress = new Trace(loc, toolTitle, steps ? (s) => steps.push(s) : undefined);
  return { set: workspaceTools(aiPool, { principal: p, agentId: null, progress }, services, { withConfirm: true, loc, timeZone: ZONE }), progress };
}

const DAY = 86_400_000;
const seed: Record<string, { id: string; code: string }> = {};

beforeAll(async () => {
  if (!up) return;
  aiPool = new pg.Pool({ connectionString: process.env.AI_DATABASE_URL!, max: 3 });
  owner = mk(ids.owner, OWNER);
  lan = mk(ids.lan, EMPLOYEE);
  an = mk(ids.an, EMPLOYEE);
  await call("employee", owner, "PUT", `/employees/${ids.lan}`, { displayName: "Lan Nguyễn", title: "Engineer" });
  await call("employee", owner, "PUT", `/employees/${ids.an}`, { displayName: "An Phạm", title: "Sales" });
  const now = Date.now();
  const mkTask = async (key: string, body: Record<string, unknown>, by = lan) => {
    const t = await call<{ id: string; code: string }>("work", by, "POST", "/tasks", { assigneeId: ids.lan, ...body });
    seed[key] = t;
    return t;
  };
  await mkTask("late", { title: "Fix the invoice export", dueAt: new Date(now - 3 * DAY).toISOString(), priority: "high" });
  await mkTask("today", { title: "Reply to the auditor", dueAt: new Date(now + 2 * 3600_000).toISOString() });
  await mkTask("later", { title: "Tidy the wiki", priority: "low" });
  const blocked = await mkTask("blocked", { title: "Ship the mobile build", dueAt: new Date(now + 5 * DAY).toISOString() });
  const head = await call<{ task: { version: number } }>("work", lan, "GET", `/tasks/${blocked.id}`);
  await call("work", lan, "PATCH", `/tasks/${blocked.id}`, { expectedVersion: head.task.version, blockedReason: "waiting for the signing certificate" });
  const done = await mkTask("done", { title: "Send the weekly numbers" });
  const d = await call<{ task: { version: number } }>("work", lan, "GET", `/tasks/${done.id}`);
  await call("work", lan, "PATCH", `/tasks/${done.id}`, { expectedVersion: d.task.version, status: "done" });
  // A task Lan cannot open: An's own, unassigned.
  seed.private = await call<{ id: string; code: string }>("work", an, "POST", "/tasks", { title: "An's private to-do" });
});

afterAll(async () => {
  setToolCache(false);
  await aiPool?.end();
});

describe.skipIf(!up)("plan_my_day", () => {
  it("orders the day: late first, then due today, the blocked task apart, the free time after", async () => {
    const steps: Step[] = [];
    const { set, progress } = tools(lan, "en", steps);
    const r = await set.run("plan_my_day", {});
    expect(r.ok, r.content).toBe(true);
    const order = r.content.split("## Tasks in order")[1]!.split("##")[0]!;
    expect(order.indexOf(seed.late!.code)).toBeGreaterThan(-1);
    expect(order.indexOf(seed.late!.code)).toBeLessThan(order.indexOf(seed.today!.code));
    expect(order).toContain("overdue 3 days");
    expect(order).not.toContain(seed.blocked!.code);
    expect(order).not.toContain(seed.done!.code);
    expect(r.content).toMatch(/## Blocked: unblock or ask for help\n- \[task [A-Z]+-\d+\] Ship the mobile build/);
    expect(r.content).toContain("Done today: 1.");
    // Shown as it ran: one step starting, then the same step done.
    expect(steps.map((s) => [s.tool, s.state])).toEqual([
      ["plan_my_day", "running"],
      ["plan_my_day", "done"],
    ]);
    expect(steps[0]!.text).toBe("Planning your day…");
    expect(progress.notes()).toEqual([]);
  });

  it("in Vietnamese, and with nothing open it says so", async () => {
    const vi = await tools(lan, "vi").set.run("plan_my_day", {});
    expect(vi.content).toContain("## Thứ tự làm việc");
    expect(vi.content).toContain("đã trễ hạn 3 ngày");
    const empty = await tools(owner).set.run("plan_my_day", {});
    expect(empty.content).toBe("Nothing is open for the user today: no tasks, no approvals waiting.");
  });
});

describe.skipIf(!up)("draft_update", () => {
  it("an end-of-day report from the day's own work", async () => {
    const r = await tools(lan).set.run("draft_update", { kind: "end_of_day" });
    expect(r.ok, r.content).toBe(true);
    expect(r.content).toMatch(/Finished today: 1\./);
    expect(r.content).toContain(`- ${seed.done!.code} Send the weekly numbers`);
    expect(r.content).toContain("Blocked:");
    expect(r.content).toContain("waiting for the signing certificate");
  });

  it("a task update and a request for help name the task's real state", async () => {
    const up1 = await tools(lan, "vi").set.run("draft_update", { kind: "task_update", task: seed.blocked!.code });
    expect(up1.ok, up1.content).toBe(true);
    expect(up1.content).toContain(`**${seed.blocked!.code} Ship the mobile build** · bị chặn`);
    const help = await tools(lan).set.run("draft_update", { kind: "help_request", task: seed.blocked!.code });
    expect(help.content).toContain(`I need help with ${seed.blocked!.code} Ship the mobile build. It is blocked: waiting for the signing certificate.`);
  });

  it("a task the person cannot open is refused, a missing task code is asked for, and the answer notes it", async () => {
    const { set, progress } = tools(lan);
    const denied = await set.run("draft_update", { kind: "task_update", task: seed.private!.code });
    expect(denied.ok).toBe(false);
    expect(denied.content).toMatch(/^DENIED/);
    const missing = await set.run("draft_update", { kind: "help_request" });
    expect(missing).toMatchObject({ ok: false, content: "Which task? Give its code (e.g. T-041), or ask the user." });
    expect(progress.notes()).toEqual(["Part of this is not visible to you, so it is left out.", "1 source could not be read: the answer may be incomplete."]);
  });
});

describe.skipIf(!up)("the read cache", () => {
  it("the same read twice is answered from the first, audited both times; a change by the person clears it", async () => {
    setToolCache(true);
    try {
      const a = await tools(lan).set.run("list_my_tasks", {});
      // A task created behind the cache's back is not seen by the next read within the minute…
      await call("work", lan, "POST", "/tasks", { title: "Created meanwhile", assigneeId: ids.lan });
      const b = await tools(lan).set.run("list_my_tasks", {});
      expect(b.content).toBe(a.content);
      const audit = await aiPool.query("SELECT reason FROM ai_audit WHERE actor_id = $1 AND tool = 'list_my_tasks' ORDER BY at DESC LIMIT 2", [ids.lan]);
      expect(audit.rows.map((x) => x.reason)).toEqual(["cached", null]);
      // …but one the person makes through the AI clears what was kept for them.
      const w = await tools(lan).set.run("create_task", { title: "Made through the AI" });
      expect(w.ok, w.content).toBe(true);
      const c = await tools(lan).set.run("list_my_tasks", {});
      expect(c.content).toContain("Created meanwhile");
      expect(c.content).toContain("Made through the AI");
    } finally {
      setToolCache(false);
    }
  });
});
