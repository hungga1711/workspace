import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { INestApplication } from "@nestjs/common";
import pg from "pg";
import { migrate, signInternalToken, PRINCIPAL_HEADER, S3Storage } from "@workspace/service-kit";
import { newId, type Grant, type Principal } from "@workspace/shared";
import { createWorkApp } from "../../src/modules/work/app.js";
import type { Fetcher } from "../../src/modules/work/task-sync/types.js";
import { resetTestDatabase } from "../test-db.js";

const SECRET = "dev-internal-secret-change-me-32bytes!";
const T = (...ps: string[]): Grant[] => ps.map((permission) => ({ permission, scope: "WORKSPACE" }));
const mk = (id: string, grants: Grant[]): Principal => ({ type: "user", id, teamIds: [], departmentId: null, grants });
const admin = mk("admin", T("workspace.configure", "project.read", "project.create", "task.read", "task.create", "task.edit", "task.delete", "task.assign"));
const staff = mk("staff", T("project.read", "task.read", "task.create"));
const storage = new S3Storage({
  endpoint: "http://localhost:8333",
  region: "auto",
  bucket: "workspace-files",
  accessKeyId: "workspace_dev_key",
  secretAccessKey: "workspace_dev_secret",
});
const linear = JSON.parse(readFileSync(fileURLToPath(new URL("../../src/modules/work/task-sync/fixtures/linear.json", import.meta.url)), "utf8"));

let app: INestApplication;
let base: string;
let pool: pg.Pool;
/** What the fake Linear answers next: the recorded issues, then the same ones with one moved on. */
let issues: unknown = linear.issues;
const fetchFake: Fetcher = async (_url, init) => {
  const body = String(init?.body ?? "");
  const data = body.includes("issues(") ? issues : linear.teams;
  return new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json" } });
};

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
  app = await createWorkApp({
    pool,
    storage,
    internalSecret: SECRET,
    taskSync: { pool, fetch: fetchFake, members: async (emails) => new Map(emails.filter((e) => e === "lily@brightline.test").map((e) => [e, "lily"])) },
  });
  await app.listen(0);
  base = (await app.getUrl()).replace("[::1]", "127.0.0.1");
});
afterAll(async () => {
  await app?.close();
  await pool?.end();
});

describe("task sync", () => {
  it("is for admins only and never returns the token", async () => {
    expect((await call(staff, "GET", "/task-sync")).status).toBe(403);
    const test = await call(admin, "POST", "/task-sync/test", { provider: "linear", token: "lin_api_recorded" });
    expect(test.status).toBe(200);
    expect(test.body.projects).toEqual([{ id: "team-eng", name: "Engineering", key: "ENG" }]);
  });

  it("creates a project per team and read-only tasks with the source's keys, people and dates", async () => {
    const created = await call(admin, "POST", "/task-sync", { provider: "linear", token: "lin_api_recorded", scope: ["team-eng"] });
    expect(created.status).toBe(201);
    const id = created.body.id;
    const run = await call(admin, "POST", `/task-sync/${id}/run`);
    expect(run.status).toBe(200);
    // The first run also started in the background on create: between the two, all three exist once.
    const list = await call(admin, "GET", "/task-sync");
    const conn = list.body.connections[0];
    expect(JSON.stringify(conn)).not.toContain("lin_api_recorded");
    expect(conn).toMatchObject({ provider: "linear", name: "Linear", lastError: null, stats: { tasks: 3 } });
    expect(conn.projects).toEqual([{ externalId: "team-eng", projectId: expect.any(String), name: "Engineering" }]);

    const rows = (
      await pool.query<{
        code: string;
        status: string;
        assignee_id: string | null;
        created_at: Date;
        started_at: Date | null;
        completed_at: Date | null;
        source: { type: string; key: string; url: string };
      }>("SELECT code, status, assignee_id, created_at, started_at, completed_at, source FROM tasks WHERE source->>'type' = 'sync' ORDER BY code")
    ).rows;
    expect(rows.map((r) => [r.code, r.status, r.assignee_id])).toEqual([
      ["ENG-123", "done", "lily"],
      ["ENG-124", "review", null],
      ["ENG-125", "cancelled", null],
    ]);
    expect(rows[0]!.created_at.toISOString()).toBe("2026-10-30T09:00:00.000Z");
    expect(rows[0]!.started_at!.toISOString()).toBe("2026-11-02T09:00:00.000Z");
    expect(rows[0]!.completed_at!.toISOString()).toBe("2026-11-05T12:00:00.000Z");
    expect(rows[0]!.source).toMatchObject({ type: "sync", key: "ENG-123", url: "https://linear.app/acme/issue/ENG-123" });

    // Read-only here: an edit is refused with where to make it.
    const task = (await call(admin, "GET", "/tasks/ENG-124")).body.task;
    const edit = await call(admin, "PATCH", `/tasks/${task.id}`, { title: "Changed", expectedVersion: task.version });
    expect(edit.status).toBe(400);
    expect(edit.body.message).toMatch(/synced from linear/);

    // A later change at the source updates the same task; an unchanged one is skipped.
    const moved = structuredClone(linear.issues);
    moved.data.issues.nodes[1].state = { type: "completed", name: "Done" };
    moved.data.issues.nodes[1].completedAt = "2026-11-08T10:00:00.000Z";
    moved.data.issues.nodes[1].updatedAt = "2026-11-08T10:00:00.000Z";
    issues = moved;
    const again = await call(admin, "POST", `/task-sync/${id}/run`);
    expect(again.body).toMatchObject({ created: 0, updated: 1, error: null });
    const after = (await pool.query<{ status: string; completed_at: Date }>("SELECT status, completed_at FROM tasks WHERE code = 'ENG-124'")).rows[0]!;
    expect(after.status).toBe("done");
    expect(after.completed_at.toISOString()).toBe("2026-11-08T10:00:00.000Z");
    const history = (await pool.query("SELECT 1 FROM activity WHERE entity_id = $1 AND action = 'moved'", [task.id])).rowCount;
    expect(history).toBe(1);

    // Mine › AI finds synced tasks by their key.
    const found = await call(admin, "GET", "/me/tasks/lookup?codes=ENG-123");
    expect(found.body.tasks.map((t: { code: string }) => t.code)).toEqual(["ENG-123"]);

    // Disconnecting keeps the tasks and makes them editable.
    expect((await call(admin, "DELETE", `/task-sync/${id}`)).status).toBe(204);
    const edited = await call(admin, "PATCH", `/tasks/${task.id}`, { title: "Now ours", expectedVersion: (await call(admin, "GET", `/tasks/${task.id}`)).body.task.version });
    expect(edited.status).toBe(200);
  });

  it("stores an API failure on the connection instead of throwing", async () => {
    issues = { errors: [{ message: "Authentication required" }] };
    const created = (await call(admin, "POST", "/task-sync", { provider: "linear", token: "lin_api_expired", scope: ["team-eng"] })).body;
    const run = await call(admin, "POST", `/task-sync/${created.id}/run`);
    expect(run.body.error).toMatch(/Authentication required/);
    const conn = (await call(admin, "GET", "/task-sync")).body.connections.find((c: { id: string }) => c.id === created.id);
    expect(conn.lastError).toMatch(/Authentication required/);
  });
});
