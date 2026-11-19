import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import type { INestApplication } from "@nestjs/common";
import pg from "pg";
import { migrate, signInternalToken, PRINCIPAL_HEADER, S3Storage } from "@workspace/service-kit";
import { newId, type Grant, type Principal } from "@workspace/shared";
import { createWorkApp } from "../../src/modules/work/app.js";
import { outputWindows } from "../../src/modules/work/reports.js";
import { resetTestDatabase } from "../test-db.js";

const SECRET = "dev-internal-secret-change-me-32bytes!";
const T = (...ps: string[]): Grant[] => ps.map((permission) => ({ permission, scope: "WORKSPACE" }));
const S = (...ps: string[]): Grant[] => ps.map((permission) => ({ permission, scope: "SELF" }));
const EMPLOYEE = [...T("project.read", "project.create", "task.read", "task.create"), ...S("task.edit", "task.assign")];
const ADMIN = [...EMPLOYEE, ...T("task.edit", "task.assign", "task.delete", "project.edit")];
const mk = (id: string, grants: Grant[]): Principal => ({ type: "user", id, teamIds: [], departmentId: null, grants });
const boss = mk("boss", ADMIN);
const ann = mk("ann", EMPLOYEE);

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

describe("reports", () => {
  it("lists blocked tasks longest first with the chain they wait on and what they hold up", async () => {
    const pr = (await call(boss, "POST", "/projects", { name: "Launch" })).body;
    const mkTask = async (title: string, assigneeId = "ann") => (await call(boss, "POST", "/tasks", { title, projectId: pr.id, assigneeId })).body;
    const api = await mkTask("API");
    const ui = await mkTask("UI");
    const qa = await mkTask("QA", "bob");
    const legal = await mkTask("Legal review");
    expect((await call(boss, "POST", `/tasks/${ui.id}/dependencies`, { predecessorId: api.id })).status).toBe(201);
    expect((await call(boss, "POST", `/tasks/${qa.id}/dependencies`, { predecessorId: ui.id })).status).toBe(201);
    const r = await call(boss, "PATCH", `/tasks/${legal.id}`, { blockedReason: "waiting for the contract", expectedVersion: legal.version });
    expect(r.status).toBe(200);
    await owner.query(`UPDATE work.activity SET at = now() - interval '6 days' WHERE entity_id = $1 AND changes ? 'blocked_reason'`, [legal.id]);

    const b = (await call(ann, "GET", "/reports/blockers")).body;
    // Legal has been blocked for 6 days; UI and QA only since their dependencies were added today.
    expect(b.tasks[0].code).toBe(legal.code);
    expect(b.tasks.map((t: { code: string }) => t.code).sort()).toEqual([legal.code, ui.code, qa.code].sort());
    const legalRow = b.tasks.find((t: { code: string }) => t.code === legal.code);
    expect(legalRow.reason).toBe("waiting for the contract");
    expect(Date.now() - Date.parse(legalRow.since)).toBeGreaterThan(5 * 86400_000);
    const qaRow = b.tasks.find((t: { code: string }) => t.code === qa.code);
    expect(qaRow.waitingOn.map((t: { code: string }) => t.code)).toEqual([ui.code, api.code]);
    const uiRow = b.tasks.find((t: { code: string }) => t.code === ui.code);
    expect(uiRow.holdsUp).toBe(1);
  });

  it("counts tasks overdue at the end of each week", async () => {
    const pr = (await call(boss, "POST", "/projects", { name: "Late" })).body;
    const t = (await call(boss, "POST", "/tasks", { title: "Late one", projectId: pr.id, assigneeId: "ann" })).body;
    await owner.query(`UPDATE work.tasks SET created_at = now() - interval '30 days', due_at = now() - interval '10 days' WHERE id = $1`, [t.id]);
    const r = await call(ann, "GET", `/reports/overdue-trend?scope=project:${pr.code}&weeks=4`);
    expect(r.status).toBe(200);
    expect(r.body.weeks).toHaveLength(4);
    expect(r.body.weeks.at(-1).overdue).toBe(1);
    expect(r.body.weeks[0].overdue).toBe(0);
    // Company-wide numbers are for company-wide viewers only.
    expect((await call(ann, "GET", "/reports/overdue-trend?scope=workspace")).status).toBe(403);
  });

  it("counts done per person in the window and the window before", async () => {
    const pr = (await call(boss, "POST", "/projects", { name: "Output" })).body;
    const mkDone = async (ago: number) => {
      const t = (await call(boss, "POST", "/tasks", { title: `Done ${ago}`, projectId: pr.id, assigneeId: "bob" })).body;
      // As the work role: the status trigger reads work's own tables by name.
      await pool.query(`UPDATE tasks SET status = 'done', completed_at = now() - make_interval(days => $2), due_at = now() WHERE id = $1`, [t.id, ago]);
    };
    await mkDone(1);
    await mkDone(2);
    await mkDone(10);
    const c = await pool.connect();
    try {
      const rows = await outputWindows(c, ["bob"], 7);
      expect(rows).toEqual([{ userId: "bob", done: 2, donePrev: 1, dated: 2, onTime: 2 }]);
    } finally {
      c.release();
    }
  });
});
