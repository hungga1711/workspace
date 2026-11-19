import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import type { INestApplication } from "@nestjs/common";
import pg from "pg";
import { migrate, signInternalToken, PRINCIPAL_HEADER, S3Storage } from "@workspace/service-kit";
import { newId, type Grant, type Principal } from "@workspace/shared";
import { createWorkApp } from "../../src/modules/work/app.js";
import { resetTestDatabase } from "../test-db.js";

const SECRET = "dev-internal-secret-change-me-32bytes!";
const T = (...ps: string[]): Grant[] => ps.map((permission) => ({ permission, scope: "WORKSPACE" }));
const S = (...ps: string[]): Grant[] => ps.map((permission) => ({ permission, scope: "SELF" }));
const mk = (id: string, grants: Grant[]): Principal => ({ type: "user", id, teamIds: [], departmentId: null, grants });
const EMPLOYEE = [...T("project.read", "project.create", "task.read", "task.create"), ...S("task.edit", "task.assign")];
const boss = mk("boss", [...EMPLOYEE, ...T("task.edit", "task.assign", "task.delete", "project.edit")]);
const ana = mk("ana", EMPLOYEE);
const ben = mk("ben", EMPLOYEE);
const storage = new S3Storage({
  endpoint: "http://localhost:8333",
  region: "auto",
  bucket: "workspace-files",
  accessKeyId: "workspace_dev_key",
  secretAccessKey: "workspace_dev_secret",
});
let app: INestApplication;
let base: string;
let pool: pg.Pool;

async function call(p: Principal, method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json", [PRINCIPAL_HEADER]: await signInternalToken({ principal: p, requestId: newId() }, SECRET) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const t = await res.text();
  return { status: res.status, body: t ? JSON.parse(t) : null };
}

beforeAll(async () => {
  await migrate("postgres://workspace_owner:owner_pw@localhost:5432/workspace_test", fileURLToPath(new URL("../../migrations/work", import.meta.url)), "work");
  await resetTestDatabase();
  pool = new pg.Pool({ connectionString: "postgres://workspace_work:app_pw@localhost:5432/workspace_test", max: 5 });
  app = await createWorkApp({ pool, storage, internalSecret: SECRET });
  await app.listen(0);
  base = (await app.getUrl()).replace("[::1]", "127.0.0.1");
});
afterAll(async () => {
  await app?.close();
});

type Board = { columns: { id: string; status: string; tasks: { id: string }[] }[] };

describe("task actions", () => {
  it("moves a task to another project into the column of its status, subtasks with it", async () => {
    const a = (await call(boss, "POST", "/projects", { name: "Alpha" })).body;
    const b = (await call(boss, "POST", "/projects", { name: "Beta" })).body;
    const t = (await call(boss, "POST", "/tasks", { title: "Ship it", projectId: a.id, status: "in_progress" })).body;
    const sub = (await call(boss, "POST", "/tasks", { title: "Step", projectId: a.id, parentId: t.id })).body;
    const moved = await call(boss, "POST", `/tasks/${t.id}/project`, { projectId: b.id, expectedVersion: t.version });
    expect(moved.status).toBe(201);
    expect(moved.body).toMatchObject({ projectId: b.id, status: "in_progress" });
    const board = (await call(boss, "GET", `/projects/${b.id}/board`)).body as Board;
    const col = board.columns.find((c) => c.tasks.some((x) => x.id === t.id));
    expect(col?.status).toBe("in_progress");
    expect((await call(boss, "GET", `/tasks/${sub.id}`)).body.task.projectId).toBe(b.id);
    // A subtask moves with its parent, not on its own.
    expect((await call(boss, "POST", `/tasks/${sub.id}/project`, { projectId: a.id, expectedVersion: 2 })).status).toBe(400);
    // A stale version is a conflict.
    expect((await call(boss, "POST", `/tasks/${t.id}/project`, { projectId: a.id, expectedVersion: t.version })).status).toBe(409);
  });

  it("deletes subtasks with their parent, alone and in a bulk delete that also names them", async () => {
    const t = (await call(ana, "POST", "/tasks", { title: "Launch" })).body;
    const s = (await call(ana, "POST", "/tasks", { title: "Step one", parentId: t.id })).body;
    const ss = (await call(ana, "POST", "/tasks", { title: "Step one, part a", parentId: s.id })).body;
    expect((await call(ana, "DELETE", `/tasks/${t.id}`)).status).toBe(204);
    for (const id of [s.id, ss.id]) expect((await call(ana, "GET", `/tasks/${id}`)).status).toBe(404);

    const b = (await call(ana, "POST", "/tasks", { title: "Bulk parent" })).body;
    const bs = (await call(ana, "POST", "/tasks", { title: "Bulk child", parentId: b.id })).body;
    const r = (await call(ana, "POST", "/tasks/bulk", { ids: [b.id, bs.id], delete: true })).body;
    expect(r.failed).toEqual([]);
    expect([...r.ok].sort()).toEqual([b.id, bs.id].sort());
  });

  it("duplicates a task with or without its subtasks", async () => {
    const t = (await call(ana, "POST", "/tasks", { title: "Weekly report", labels: ["ops"], priority: "high" })).body;
    await call(ana, "POST", "/tasks", { title: "Collect numbers", parentId: t.id });
    await call(ana, "POST", "/tasks", { title: "Write summary", parentId: t.id });
    const copy = (await call(ana, "POST", `/tasks/${t.id}/duplicate`, { title: "Weekly report (copy)", withSubtasks: true })).body;
    expect(copy).toMatchObject({ title: "Weekly report (copy)", labels: ["ops"], priority: "high", status: "todo" });
    expect(copy.source).toMatchObject({ type: "duplicate", fromTaskId: t.id });
    const detail = (await call(ana, "GET", `/tasks/${copy.id}`)).body;
    expect(detail.subtasks.map((s: { title: string }) => s.title)).toEqual(["Collect numbers", "Write summary"]);
    const bare = (await call(ana, "POST", `/tasks/${t.id}/duplicate`, { withSubtasks: false })).body;
    expect((await call(ana, "GET", `/tasks/${bare.id}`)).body.subtasks).toEqual([]);
  });

  it("turns a subtask into a task and back, and orders subtasks", async () => {
    const parent = (await call(ana, "POST", "/tasks", { title: "Parent" })).body;
    const s1 = (await call(ana, "POST", "/tasks", { title: "One", parentId: parent.id })).body;
    const s2 = (await call(ana, "POST", "/tasks", { title: "Two", parentId: parent.id })).body;
    const s3 = (await call(ana, "POST", "/tasks", { title: "Three", parentId: parent.id })).body;
    expect((await call(ana, "PUT", `/tasks/${parent.id}/subtask-order`, { ids: [s3.id, s1.id] })).status).toBe(200);
    expect((await call(ana, "GET", `/tasks/${parent.id}`)).body.subtasks.map((s: { title: string }) => s.title)).toEqual(["Three", "One", "Two"]);
    const free = (await call(ana, "POST", `/tasks/${s2.id}/parent`, { parentId: null, expectedVersion: s2.version })).body;
    expect(free.parentId).toBeNull();
    // A task with subtasks cannot become one.
    expect((await call(ana, "POST", `/tasks/${parent.id}/parent`, { parentId: free.id, expectedVersion: parent.version })).status).toBe(400);
    const back = (await call(ana, "POST", `/tasks/${free.id}/parent`, { parentId: parent.id, expectedVersion: free.version })).body;
    expect(back.parentId).toBe(parent.id);
  });

  it("watchers follow a task and are named in its comment and completion events", async () => {
    const t = (await call(ana, "POST", "/tasks", { title: "Watched", projectId: (await call(boss, "POST", "/projects", { name: "W" })).body.id })).body;
    expect((await call(ben, "PUT", `/tasks/${t.id}/watch`)).body).toMatchObject({ watching: true, watchers: ["ben"] });
    expect((await call(ben, "GET", `/tasks/${t.id}`)).body).toMatchObject({ watching: true, watchers: ["ben"] });
    await call(ana, "POST", `/tasks/${t.id}/comments`, { body: "Started" });
    await call(ana, "PATCH", `/tasks/${t.id}`, { expectedVersion: t.version, status: "done" });
    const events = (await pool.query("SELECT type, payload FROM outbox WHERE aggregateid = $1 AND type IN ('work.task.commented.v1', 'work.task.completed.v1')", [t.id])).rows;
    expect(events.map((e) => e.payload.payload.watchers)).toEqual([["ben"], ["ben"]]);
    expect((await call(ben, "DELETE", `/tasks/${t.id}/watch`)).body).toMatchObject({ watching: false, watchers: [] });
  });

  it("changes many tasks at once and reports the ones it could not", async () => {
    const mine = (await call(ana, "POST", "/tasks", { title: "Mine" })).body;
    const mine2 = (await call(ana, "POST", "/tasks", { title: "Mine too", labels: ["old"] })).body;
    const notMine = (await call(ben, "POST", "/tasks", { title: "Ben's" })).body;
    const r = await call(ana, "POST", "/tasks/bulk", { ids: [mine.id, mine2.id, notMine.id], status: "in_progress", addLabels: ["new"], removeLabels: ["old"] });
    expect(r.status).toBe(201);
    expect(r.body.ok.sort()).toEqual([mine.id, mine2.id].sort());
    expect(r.body.failed).toEqual([{ id: notMine.id, error: "not_found" }]);
    expect(r.body.tasks.map((t: { status: string; labels: string[] }) => [t.status, t.labels])).toEqual([
      ["in_progress", ["new"]],
      ["in_progress", ["new"]],
    ]);
    const del = await call(ana, "POST", "/tasks/bulk", { ids: [mine.id], delete: true });
    expect(del.body.ok).toEqual([mine.id]);
    expect((await call(ana, "GET", `/tasks/${mine.id}`)).status).toBe(404);
  });

  it("saves a task as a template and starts new tasks from it", async () => {
    const p = (await call(boss, "POST", "/projects", { name: "Templates" })).body;
    const t = (await call(boss, "POST", "/tasks", { title: "Onboard a hire", projectId: p.id, labels: ["hr"], description: "Checklist" })).body;
    await call(boss, "POST", "/tasks", { title: "Laptop", projectId: p.id, parentId: t.id });
    await call(boss, "POST", "/tasks", { title: "Accounts", projectId: p.id, parentId: t.id });
    const tpl = (await call(boss, "POST", "/task-templates", { name: "Onboarding", taskId: t.id, projectId: p.id })).body;
    expect(tpl.payload).toMatchObject({ title: "Onboard a hire", labels: ["hr"], subtasks: ["Laptop", "Accounts"] });
    // Offered in its project, not in another.
    expect((await call(ana, "GET", `/task-templates?projectId=${p.id}`)).body.map((x: { id: string }) => x.id)).toContain(tpl.id);
    expect((await call(ana, "GET", "/task-templates")).body.map((x: { id: string }) => x.id)).not.toContain(tpl.id);
    const made = (await call(ana, "POST", `/task-templates/${tpl.id}/use`, { projectId: p.id, title: "Onboard Dana" })).body;
    expect(made).toMatchObject({ title: "Onboard Dana", labels: ["hr"], description: "Checklist", assigneeId: "ana" });
    expect((await call(ana, "GET", `/tasks/${made.id}`)).body.subtasks.map((s: { title: string }) => s.title)).toEqual(["Laptop", "Accounts"]);
    // Only whoever saved it (or someone who may delete tasks) removes it.
    expect((await call(ana, "DELETE", `/task-templates/${tpl.id}`)).status).toBe(403);
    expect((await call(boss, "DELETE", `/task-templates/${tpl.id}`)).status).toBe(204);
  });

  it("finishing a recurring task schedules the next one", async () => {
    const t = (await call(ana, "POST", "/tasks", { title: "Pay rent", dueAt: "2030-01-31T09:00:00Z", recurrence: "monthly" })).body;
    await call(ana, "PATCH", `/tasks/${t.id}`, { expectedVersion: t.version, status: "done" });
    const next = (await pool.query("SELECT due_at, recurrence FROM tasks WHERE source->>'fromTaskId' = $1", [t.id])).rows[0];
    expect(next.recurrence).toBe("monthly");
    expect(new Date(next.due_at).toISOString().slice(0, 10)).toBe("2030-02-28");
  });
});
