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
const EMPLOYEE = [...T("project.read", "project.create", "task.read", "task.create"), ...S("task.edit", "task.assign")];
const ADMIN = [...EMPLOYEE, ...T("task.edit", "task.assign", "task.delete", "project.edit")];
const mk = (id: string, grants: Grant[]): Principal => ({ type: "user", id, teamIds: [], departmentId: null, grants });
const boss = mk("boss", ADMIN);
const ann = mk("ann", EMPLOYEE);
const bob = mk("bob", EMPLOYEE);

let app: INestApplication;
let base: string;
let pool: pg.Pool;
const owner = new pg.Pool({ connectionString: "postgres://workspace_owner:owner_pw@localhost:5432/workspace_test", max: 2 });

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
  const storage = new S3Storage({
    endpoint: "http://localhost:8333",
    region: "auto",
    bucket: "workspace-files",
    accessKeyId: "workspace_dev_key",
    secretAccessKey: "workspace_dev_secret",
  });
  app = await createWorkApp({ pool, storage, internalSecret: SECRET });
  await app.listen(0);
  base = (await app.getUrl()).replace("[::1]", "127.0.0.1");
});

afterAll(async () => {
  await app?.close();
  await owner.end();
});

describe("velocity", () => {
  it("counts done and added per week, work in flight, stuck and cycle time for a project", async () => {
    const pr = (await call(boss, "POST", "/projects", { name: "Flow" })).body;
    const mkTask = async (title: string, assigneeId = "ann") => (await call(boss, "POST", "/tasks", { title, projectId: pr.id, assigneeId })).body;
    const a = await mkTask("A");
    const b = await mkTask("B");
    const c = await mkTask("C", "bob");
    await mkTask("D");
    // A: started, then done. B: in progress for 10 days (stuck). C: in review. D: still to do.
    let r = await call(boss, "PATCH", `/tasks/${a.id}`, { status: "in_progress", expectedVersion: a.version });
    r = await call(boss, "PATCH", `/tasks/${a.id}`, { status: "done", expectedVersion: r.body.version });
    expect(r.status).toBe(200);
    await call(boss, "PATCH", `/tasks/${b.id}`, { status: "in_progress", expectedVersion: b.version });
    await call(boss, "PATCH", `/tasks/${c.id}`, { status: "review", expectedVersion: c.version });
    // The trigger stamps the first start and the last status change.
    const stamps = (await owner.query(`SELECT code, started_at, status_changed_at FROM work.tasks WHERE id = ANY($1) ORDER BY code`, [[a.id, b.id]])).rows;
    expect(stamps.every((s) => s.started_at && s.status_changed_at)).toBe(true);
    await owner.query(`UPDATE work.tasks SET status_changed_at = now() - interval '10 days' WHERE id = $1`, [b.id]);
    await owner.query(`UPDATE work.tasks SET started_at = completed_at - interval '2 days' WHERE id = $1`, [a.id]);

    const v = (await call(ann, "GET", `/velocity?scope=project:${pr.code}&weeks=4`)).body;
    expect(v.weeks).toHaveLength(4);
    expect(v.thisWeek).toEqual({ done: 1, added: 4 });
    expect(v.weeks.at(-1).cycleDays).toBe(2);
    expect(v.now).toMatchObject({ inProgress: 1, review: 1, stuck: 1, open: 3 });
    expect(v.attention.map((x: { code: string; reason: string }) => [x.code, x.reason])).toEqual([[b.code, "stuck"]]);

    // The projects page carries the same pace per project, and no "% done" is needed to read it.
    const row = (await call(ann, "GET", "/projects")).body.projects.find((x: { id: string }) => x.id === pr.id);
    expect(row.flow.thisWeek).toEqual({ done: 1, added: 4 });
    expect(row.flow.done).toHaveLength(8);
    expect(row.flow).toMatchObject({ inProgress: 2, stuck: 1 });
  });

  it("scopes people: yourself yes, a colleague or the workspace only for those who follow them", async () => {
    expect((await call(ann, "GET", "/velocity?scope=person:ann")).status).toBe(200);
    expect((await call(ann, "GET", "/velocity?scope=person:bob")).status).toBe(403);
    expect((await call(ann, "GET", "/velocity?scope=workspace")).status).toBe(403);
    const all = await call(boss, "GET", "/velocity?scope=workspace");
    expect(all.status).toBe(200);
    expect(all.body.now.open).toBeGreaterThanOrEqual(3);
    expect((await call(boss, "GET", "/velocity?scope=person:bob")).body.now.review).toBe(1);
    expect((await call(boss, "GET", "/velocity?scope=nope")).status).toBe(400);
  });

  it("weekly status updates: the owner posts, others read", async () => {
    const pr = (await call(boss, "POST", "/projects", { name: "Status" })).body;
    expect((await call(bob, "POST", `/projects/${pr.id}/updates`, { health: "on_track", body: "x" })).status).toBe(403);
    const u = await call(boss, "POST", `/projects/${pr.id}/updates`, { health: "at_risk", body: "Shipped billing; waiting on legal.", suggested: true });
    expect(u.status).toBe(201);
    const list = (await call(bob, "GET", `/projects/${pr.code}/updates`)).body;
    expect(list.canPost).toBe(false);
    expect(list.updates[0]).toMatchObject({ health: "at_risk", body: "Shipped billing; waiting on legal.", suggested: true, authorId: "boss" });
    const row = (await call(bob, "GET", "/projects")).body.projects.find((x: { id: string }) => x.id === pr.id);
    expect(row.status).toBe("active");
    expect(row.statusUpdate).toMatchObject({ health: "at_risk" });
  });
});
