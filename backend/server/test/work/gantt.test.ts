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
const minh: Principal = {
  type: "user",
  id: "minh",
  teamIds: [],
  departmentId: null,
  grants: T("project.read", "project.create", "project.edit", "task.read", "task.create", "task.edit", "task.assign", "task.delete"),
};
const storage = new S3Storage({
  endpoint: "http://localhost:8333",
  region: "auto",
  bucket: "workspace-files",
  accessKeyId: "workspace_dev_key",
  secretAccessKey: "workspace_dev_secret",
});
let app: INestApplication;
let base: string;

/** Can see the project but not edit tasks. */
const viewer: Principal = { ...minh, id: "lan", grants: T("project.read", "task.read") };

async function call(method: string, path: string, body?: unknown, as: Principal = minh) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json", [PRINCIPAL_HEADER]: await signInternalToken({ principal: as, requestId: newId() }, SECRET) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const t = await res.text();
  return { status: res.status, body: t ? JSON.parse(t) : null };
}

beforeAll(async () => {
  await migrate("postgres://workspace_owner:owner_pw@localhost:5432/workspace_test", fileURLToPath(new URL("../../migrations/work", import.meta.url)), "work");
  // Each suite starts from an empty installation: counts and codes below assume only its own rows.
  await resetTestDatabase();
  const pool = new pg.Pool({ connectionString: "postgres://workspace_work:app_pw@localhost:5432/workspace_test", max: 5 });
  app = await createWorkApp({ pool, storage, internalSecret: SECRET });
  await app.listen(0);
  base = (await app.getUrl()).replace("[::1]", "127.0.0.1");
});
afterAll(async () => {
  await app?.close();
});

describe("gantt", () => {
  it("schedules tasks, links them without loops and pushes dependents when a task slips", async () => {
    const project = (await call("POST", "/projects", { name: "Gantt" })).body;
    const day = (n: number) => new Date(Date.UTC(2026, 9, 20 + n, 2)).toISOString();
    const mk = async (title: string, s: number, d: number) => {
      const t = (await call("POST", "/tasks", { title, projectId: project.id })).body;
      return (await call("PATCH", `/tasks/${t.id}`, { expectedVersion: t.version, startAt: day(s), dueAt: day(d) })).body;
    };
    const api = await mk("API", 0, 2);
    const ui = await mk("UI", 3, 5);
    const qa = await mk("QA", 6, 7);

    // The start may not come after the due date.
    expect((await call("PATCH", `/tasks/${qa.id}`, { expectedVersion: qa.version, startAt: day(9) })).status).toBe(400);

    expect((await call("POST", `/tasks/${ui.id}/dependencies`, { predecessorId: api.id })).status).toBe(201);
    expect((await call("POST", `/tasks/${qa.id}/dependencies`, { predecessorId: ui.id })).status).toBe(201);
    // QA → UI → API: making API wait on QA would be a loop.
    const loop = await call("POST", `/tasks/${api.id}/dependencies`, { predecessorId: qa.id });
    expect(loop.status).toBe(409);
    expect(loop.body.error).toBe("cycle");

    const tl = (await call("GET", `/projects/${project.id}/timeline`)).body;
    expect(tl.tasks).toHaveLength(3);
    expect(tl.dependencies).toHaveLength(2);

    // API slips by three days: UI and then QA move after it, keeping their lengths.
    const fresh = tl.tasks.find((t: { id: string }) => t.id === api.id);
    await call("PATCH", `/tasks/${api.id}`, { expectedVersion: fresh.version, dueAt: day(5) });
    // Someone who can only read cannot reschedule other people's work.
    expect((await call("POST", `/tasks/${api.id}/shift-dependents`, undefined, viewer)).status).toBe(403);
    expect((await call("POST", `/tasks/${api.id}/dependencies`, { predecessorId: api.id }, viewer)).status).toBe(403);
    const shifted = (await call("POST", `/tasks/${api.id}/shift-dependents`)).body.changed;
    const byTitle = Object.fromEntries(shifted.map((t: { title: string }) => [t.title, t]));
    expect(new Date(byTitle.UI.startAt).toISOString()).toBe(day(6));
    expect(new Date(byTitle.UI.dueAt).toISOString()).toBe(day(8));
    expect(new Date(byTitle.QA.startAt).toISOString()).toBe(day(9));
    expect(new Date(byTitle.QA.dueAt).toISOString()).toBe(day(10));

    // Removing a link.
    const link = tl.dependencies.find((d: { to: string }) => d.to === qa.id);
    expect((await call("DELETE", `/task-dependencies/${link.id}`)).status).toBe(204);
    expect((await call("GET", `/projects/${project.id}/timeline`)).body.dependencies).toHaveLength(1);
  });
});
