import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import type { INestApplication } from "@nestjs/common";
import pg from "pg";
import { migrate, signInternalToken, PRINCIPAL_HEADER, S3Storage, ServiceClient } from "@workspace/service-kit";
import { newId, runWithContext, withTransaction, type Grant, type Principal } from "@workspace/shared";
import { createWorkApp } from "../../src/modules/work/app.js";
import { applyAiUsageEvent } from "../../src/modules/work/ai-assists.js";
import { createEmployeeApp } from "../../src/modules/employee/app.js";
import { resetTestDatabase } from "../test-db.js";

const SECRET = "dev-internal-secret-change-me-32bytes!";
const T = (...ps: string[]): Grant[] => ps.map((permission) => ({ permission, scope: "WORKSPACE" }));
const S = (...ps: string[]): Grant[] => ps.map((permission) => ({ permission, scope: "SELF" }));
const EMPLOYEE = [
  ...T("project.read", "project.create", "task.read", "task.create", "employee.profile.read", "document.create", "document.read"),
  ...S("task.edit", "task.assign"),
];
const ADMIN = [...EMPLOYEE, ...T("task.edit", "task.assign")];
const mk = (id: string, grants: Grant[] = EMPLOYEE): Principal => ({ type: "user", id, teamIds: [], departmentId: null, grants });
const ceo = mk("ceo", ADMIN);
const minh = mk("minh");
const lan = mk("lan");
const huy = mk("huy");
const eve = mk("eve");

const storage = new S3Storage({
  endpoint: "http://localhost:8333",
  region: "auto",
  bucket: "workspace-files",
  accessKeyId: "workspace_dev_key",
  secretAccessKey: "workspace_dev_secret",
});
let work: INestApplication;
let employee: INestApplication;
let base: string;
let workPool: pg.Pool;
const urlOf = async (a: INestApplication) => (await a.getUrl()).replace("[::1]", "127.0.0.1");

async function call(p: Principal, method: string, path: string, body?: unknown, locale?: "en" | "vi") {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      [PRINCIPAL_HEADER]: await signInternalToken({ principal: p, requestId: newId() }, SECRET),
      ...(locale ? { "x-locale": locale } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const t = await res.text();
  return { status: res.status, body: t ? JSON.parse(t) : null };
}
const inTx = <R>(pool: pg.Pool, fn: (c: pg.PoolClient) => Promise<R>) => runWithContext({ actorId: "test", requestId: newId() }, () => withTransaction(pool, fn));

beforeAll(async () => {
  await migrate("postgres://workspace_owner:owner_pw@localhost:5432/workspace_test", fileURLToPath(new URL("../../migrations/work", import.meta.url)), "work");
  // Each suite starts from an empty installation: counts and codes below assume only its own rows.
  await resetTestDatabase();
  await migrate("postgres://workspace_owner:owner_pw@localhost:5432/workspace_test", fileURLToPath(new URL("../../migrations/employee", import.meta.url)), "employee");
  const empPool = new pg.Pool({ connectionString: "postgres://workspace_employee:app_pw@localhost:5432/workspace_test", max: 5 });
  // Reporting line: ceo ← minh ← (lan, huy). eve reports to nobody.
  await inTx(empPool, async (c) => {
    for (const [id, name, manager, n] of [
      ["ceo", "Chị CEO", null, 1],
      ["minh", "Minh", "ceo", 2],
      ["lan", "Lan", "minh", 3],
      ["huy", "Huy", "minh", 4],
      ["eve", "Eve", null, 5],
    ] as const)
      await c.query("INSERT INTO employees (user_id, code, display_name, manager_id) VALUES ($1,$2,$3,$4)", [id, `EMP-${n}`, name, manager]);
  });
  employee = await createEmployeeApp({ pool: empPool, internalSecret: SECRET });
  await employee.listen(0);
  workPool = new pg.Pool({ connectionString: "postgres://workspace_work:app_pw@localhost:5432/workspace_test", max: 5 });
  work = await createWorkApp({ pool: workPool, storage, internalSecret: SECRET, employee: new ServiceClient(await urlOf(employee), SECRET, "work", []) });
  await work.listen(0);
  base = await urlOf(work);
});
afterAll(async () => {
  await work?.close();
  await employee?.close();
});

describe("follow-up", () => {
  let project: { id: string };
  const ids: Record<string, string> = {};

  it("sets up work across the team", async () => {
    project = (await call(minh, "POST", "/projects", { name: "Ra mắt Q4" })).body;
    const task = async (p: Principal, title: string, extra: Record<string, unknown>) => {
      const r = await call(p, "POST", "/tasks", { title, projectId: project.id, ...extra });
      expect(r.status).toBe(201);
      ids[title] = r.body.id;
      return r.body;
    };
    await task(ceo, "Kế hoạch ra mắt", { assigneeId: "minh", dueAt: "2030-01-10T10:00:00+07:00" });
    await task(minh, "Landing page", { assigneeId: "lan", dueAt: "2020-01-01T10:00:00+07:00" }); // overdue
    await task(minh, "Bài PR", { assigneeId: "huy" });
    await task(eve, "Việc của Eve", { assigneeId: "eve" });
    // Lan's own to-do with no project: private.
    ids.private = (await call(lan, "POST", "/tasks", { title: "Đi chợ" })).body.id;
    expect((await call(lan, "PATCH", `/tasks/${ids["Landing page"]}`, { status: "in_progress", expectedVersion: 1 })).status).toBeLessThan(300);
    // Huy's task has not moved in a week.
    await inTx(workPool, (c) => c.query("UPDATE tasks SET updated_at = now() - interval '7 days' WHERE id = $1", [ids["Bài PR"]]));
  });

  it("delegated: what I gave to others, late and quiet first", async () => {
    const r = (await call(minh, "GET", "/followup/delegated")).body;
    expect(r.tasks.map((t: { title: string }) => t.title)).toEqual(["Landing page", "Bài PR"]);
    expect(r.summary).toMatchObject({ open: 2, overdue: 1, stale: 1 });
    expect((await call(ceo, "GET", "/followup/delegated")).body.tasks.map((t: { title: string }) => t.title)).toEqual(["Kế hoạch ra mắt"]);
  });

  it("team: a manager sees their reporting line and nobody else, private to-dos excluded", async () => {
    const r = (await call(minh, "GET", "/followup/team")).body;
    expect(r.scope).toBe("reports");
    expect(r.people.map((x: { userId: string }) => x.userId)).toEqual(["lan", "huy"]); // late first
    const lanRow = r.people[0];
    expect(lanRow).toMatchObject({ open: 1, overdue: 1, inProgress: 1 });
    expect(lanRow.now.map((t: { title: string }) => t.title)).toEqual(["Landing page"]);
    expect(lanRow.tasks.map((t: { id: string }) => t.id)).not.toContain(ids.private);
    expect(r.people[1]).toMatchObject({ userId: "huy", stale: 1 });
    expect(r.totals).toMatchObject({ open: 2, overdue: 1, stale: 1 });
  });

  it("anyone can see exactly what their manager sees about them, private to-dos excluded", async () => {
    const me = (await call(lan, "GET", "/followup/me")).body.me;
    expect(me).toMatchObject({ userId: "lan", open: 1, overdue: 1, inProgress: 1 });
    expect(me.tasks.map((t: { id: string }) => t.id)).not.toContain(ids.private);
    // The same row the manager gets for Lan.
    const fromMinh = (await call(minh, "GET", "/followup/team")).body.people.find((x: { userId: string }) => x.userId === "lan");
    expect(me.now).toEqual(fromMinh.now);
  });

  it("the brief view for Home keeps the numbers and only the tasks worth asking about", async () => {
    const r = (await call(minh, "GET", "/followup/team?brief=1")).body;
    expect(r.totals).toMatchObject({ open: 2, overdue: 1, stale: 1 });
    for (const x of r.people) {
      expect(x.tasks.length).toBeLessThanOrEqual(3);
      for (const t of x.tasks) expect(t.overdue || t.stale || t.blockedReason).toBeTruthy();
    }
    expect(r.people.find((x: { userId: string }) => x.userId === "lan").late.map((t: { title: string }) => t.title)).toEqual(["Landing page"]);
  });

  it("the CEO sees the whole chain below them; someone with no reports sees nothing", async () => {
    const r = (await call(ceo, "GET", "/followup/team")).body;
    expect(r.people.map((x: { userId: string }) => x.userId).sort()).toEqual(["huy", "lan", "minh"]);
    expect(r.people.map((x: { userId: string }) => x.userId)).not.toContain("eve");
    const none = (await call(lan, "GET", "/followup/team")).body;
    expect(none).toMatchObject({ scope: "none", people: [] });
    expect((await call(huy, "GET", "/followup/delegated")).body.tasks).toEqual([]);
  });

  it("a nudge mentions the assignee on the task; anyone who can see it may send it, never the assignee", async () => {
    expect((await call(minh, "POST", `/tasks/${ids["Bài PR"]}/nudge`, {}, "vi")).status).toBe(201);
    expect((await call(ceo, "POST", `/tasks/${ids["Bài PR"]}/nudge`, { message: "Kịp thứ 6 không em?" })).status).toBe(201);
    expect((await call(huy, "POST", `/tasks/${ids["Bài PR"]}/nudge`, {})).status).toBe(403); // the assignee reports instead
    const comments = await inTx(workPool, (c) => c.query<{ body: string }>("SELECT body FROM task_comments WHERE task_id = $1 ORDER BY created_at", [ids["Bài PR"]]));
    expect(comments.rows.map((x) => x.body)).toEqual(["<@huy> Việc này đang tiến triển thế nào rồi? Bạn cập nhật giúp nhé.", "<@huy> Kịp thứ 6 không em?"]);
  });

  it("a check-in records progress and the expected finish; finishing after the due date flags it at risk", async () => {
    const id = ids["Kế hoạch ra mắt"]!;
    expect((await call(lan, "POST", `/tasks/${id}/checkin`, { progress: 50 })).status).toBe(403);
    const r = await call(minh, "POST", `/tasks/${id}/checkin`, { progress: 30, etaAt: "2030-01-20T17:00:00+07:00", note: "Chờ duyệt ngân sách" }, "vi");
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ progress: 30, status: "in_progress", atRisk: true });
    const d = (await call(ceo, "GET", "/followup/delegated")).body;
    expect(d.summary.atRisk).toBe(1);
    expect(d.tasks[0]).toMatchObject({ title: "Kế hoạch ra mắt", progress: 30, atRisk: true });
    const team = (await call(ceo, "GET", "/followup/team")).body;
    expect(team.people.find((x: { userId: string }) => x.userId === "minh")).toMatchObject({ atRisk: 1 });
    const c = await inTx(workPool, (x) => x.query<{ body: string }>("SELECT body FROM task_comments WHERE task_id = $1", [id]));
    expect(c.rows.map((x) => x.body)).toEqual(["<@ceo> 📍 Tiến độ 30% · dự kiến xong 20/01\nChờ duyệt ngân sách"]);
    // Back on track: a forecast before the due date clears the flag. Written in the language of whoever checks in.
    const back = await call(minh, "POST", `/tasks/${id}/checkin`, { progress: 80, etaAt: "2030-01-08T17:00:00+07:00" }, "en");
    expect(back.body.atRisk).toBe(false);
    expect(back.body.comment.body).toBe("<@ceo> 📍 Progress 80% · expected done 08/01");
  });

  it("the weekly report becomes a private page with the team's numbers, what needs attention and @mentions", async () => {
    const r = await call(ceo, "POST", "/followup/report", {});
    expect(r.status).toBe(201);
    const d = (await call(ceo, "GET", `/docs/${r.body.id}`)).body;
    expect(d.document.title).toMatch(/^Báo cáo tuần \d\d\/\d\d – \d\d\/\d\d$/);
    expect(d.document.visibility).toBe("private");
    expect(d.content).toContain("<h2>Cần chú ý</h2>");
    expect(d.content).toContain("Landing page");
    expect(d.content).toContain('data-type="mention" data-id="lan"');
    // Someone else cannot read it until it is shared.
    expect((await call(minh, "GET", `/docs/${r.body.id}`)).status).toBe(404);
  });

  it("asks everyone without a recent progress update at once, and not twice in a day", async () => {
    const r = await call(minh, "POST", "/followup/nudge-all");
    expect(r.status).toBe(201);
    // Lan's landing page and Huy's PR have no check-in; Minh already asked Huy about the PR today.
    expect(r.body).toEqual({ tasks: 1, people: 1 });
    expect((await call(minh, "POST", "/followup/nudge-all")).body).toEqual({ tasks: 0, people: 0 });
    expect((await call(eve, "POST", "/followup/nudge-all")).body).toEqual({ tasks: 0, people: 0 });
  });
});

describe("outcomes (Công việc › AI)", () => {
  it("counts each person's finished work, on-time share and the weekly trend; private to-dos and other teams stay out", async () => {
    const proj = (await call(ceo, "POST", "/projects", { name: "Kết quả" })).body;
    const zero = { done: 0, dated: 0, onTime: 0, open: 0 };
    const huyOf = async (q = "") => (await call(ceo, "GET", `/followup/outcomes${q}`)).body.people.find((p: { userId: string }) => p.userId === "huy") ?? zero;
    const before = await huyOf("?days=30");
    const before90 = await huyOf("?days=90");
    const mkTask = async (title: string, assigneeId: string, done: { daysAgo: number; dueDaysAgo?: number } | null) => {
      const id = (await call(ceo, "POST", "/tasks", { title, projectId: proj.id, assigneeId })).body.id as string;
      if (done)
        await inTx(workPool, (c) =>
          c.query(
            "UPDATE tasks SET status = 'done', created_at = now() - make_interval(days => $2 + 2), completed_at = now() - make_interval(days => $2), due_at = CASE WHEN $3::int IS NULL THEN NULL ELSE now() - make_interval(days => $3::int) END WHERE id = $1",
            [id, done.daysAgo, done.dueDaysAgo ?? null],
          ),
        );
      return id;
    };
    await mkTask("Xong đúng hạn", "huy", { daysAgo: 1, dueDaysAgo: -2 });
    await mkTask("Xong trễ", "huy", { daysAgo: 1, dueDaysAgo: 5 });
    await mkTask("Xong lâu rồi", "huy", { daysAgo: 60 });
    await mkTask("Đang làm", "huy", null);
    await call(huy, "POST", "/tasks", { title: "Việc riêng" }); // private to-do: never counted

    const r = await call(ceo, "GET", "/followup/outcomes?days=30");
    expect(r.status).toBe(200);
    const h = r.body.people.find((p: { userId: string }) => p.userId === "huy");
    expect(h.done - before.done).toBe(2);
    expect(h.dated - before.dated).toBe(2);
    expect(h.onTime - before.onTime).toBe(1);
    expect(h.open - before.open).toBe(1);
    expect(r.body.weekly).toHaveLength(8);
    expect(r.body.weekly.reduce((n: number, w: { done: number }) => n + w.done, 0)).toBeGreaterThanOrEqual(2);
    // 90 days includes the old one.
    expect((await huyOf("?days=90")).done - before90.done).toBe(3);
    // Minh (manager) sees his reports; Eve (no reports, not admin) sees nobody.
    expect((await call(minh, "GET", "/followup/outcomes")).body.people.map((p: { userId: string }) => p.userId)).toContain("huy");
    expect((await call(eve, "GET", "/followup/outcomes")).body.people).toEqual([]);
  });
});

describe("tasks done with and without AI (ADR 0011)", () => {
  const used = (taskId: string, at: Date, userId = "lan", subjectType = "task") =>
    inTx(workPool, (c) =>
      applyAiUsageEvent(
        {
          eventId: newId(),
          eventType: "ai.usage.recorded.v1",
          version: 1,
          aggregateType: "ai.usage",
          aggregateId: newId(),
          actorId: `user:${userId}`,
          occurredAt: at.toISOString(),
          payload: { usageId: newId(), userId, feature: "task_summarize", subjectType, subjectId: taskId, tokens: 120, at: at.toISOString() },
        },
        c,
      ),
    );

  it("splits finished tasks by whether AI helped before they were done", async () => {
    const proj = (await call(ceo, "POST", "/projects", { name: "AI so sánh" })).body;
    const before = (await call(ceo, "GET", "/followup/outcomes?days=30")).body.withAi;
    const done = async (title: string, daysAgo: number, dueInDays: number) => {
      const id = (await call(ceo, "POST", "/tasks", { title, projectId: proj.id, assigneeId: "lan" })).body.id as string;
      await inTx(workPool, (c) =>
        c.query(
          "UPDATE tasks SET status = 'done', created_at = now() - make_interval(days => $2 + 4), completed_at = now() - make_interval(days => $2), due_at = now() - make_interval(days => $2) + make_interval(days => $3) WHERE id = $1",
          [id, daysAgo, dueInDays],
        ),
      );
      return id;
    };
    const helped = await done("Có AI giúp", 2, 1);
    const late = await done("AI hỏi sau khi xong", 2, -1);
    await done("Không dùng AI", 3, -1);
    const open = (await call(ceo, "POST", "/tasks", { title: "Đang làm có AI", projectId: proj.id, assigneeId: "lan" })).body.id as string;

    const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);
    await used(helped, daysAgo(4));
    await used(helped, daysAgo(3), "minh"); // a second person, later: still one assisted task
    await used(late, daysAgo(1)); // after it was finished: does not count
    await used(open, daysAgo(1)); // not finished: not in either group
    await used(newId(), daysAgo(1)); // a task that does not exist here: ignored
    await used(proj.id, daysAgo(1), "lan", "document"); // other subjects: ignored

    const r = await call(ceo, "GET", "/followup/outcomes?days=30");
    const { assisted, other } = r.body.withAi;
    expect(assisted.done - before.assisted.done).toBe(1);
    expect(assisted.onTime - before.assisted.onTime).toBe(1);
    expect(other.done - before.other.done).toBe(2);
    expect(other.dated - before.other.dated).toBe(2);
    expect(other.onTime - before.other.onTime).toBe(0);
    expect(r.body.weekly.reduce((n: number, w: { aiDone: number }) => n + w.aiDone, 0)).toBeGreaterThanOrEqual(1);
    const row = await inTx(workPool, async (c) => (await c.query("SELECT calls, tokens::int AS tokens, people FROM task_ai_assists WHERE task_id = $1", [helped])).rows[0]);
    expect(row).toEqual({ calls: 2, tokens: 240, people: ["lan", "minh"] });
    // Eve sees nobody, so no comparison either.
    expect((await call(eve, "GET", "/followup/outcomes")).body.withAi.assisted.done).toBe(0);
  });
});
