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
const EMPLOYEE = [...T("project.read", "project.create", "task.read", "task.create", "ai.use"), ...S("task.edit", "task.assign")];
const ADMIN = [...EMPLOYEE, ...T("task.edit", "task.assign")];
const mk = (id: string, grants: Grant[]): Principal => ({ type: "user", id, teamIds: [], departmentId: null, grants });
const minh = mk("minh", ADMIN);
const lan = mk("lan", EMPLOYEE);
const huy = mk("huy", EMPLOYEE);

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
  const storage = new S3Storage({
    endpoint: "http://localhost:8333",
    region: "auto",
    bucket: "workspace-files",
    accessKeyId: "workspace_dev_key",
    secretAccessKey: "workspace_dev_secret",
  });
  // A runner acts as the person who started the run (workflows.ts runnerRun): the gateway's lookup, here.
  const people = new Map([minh, lan, huy].map((x) => [x.id, x]));
  app = await createWorkApp({ pool, storage, internalSecret: SECRET, resolvePrincipal: async (id: string) => people.get(id)! });
  await app.listen(0);
  base = (await app.getUrl()).replace("[::1]", "127.0.0.1");
});

afterAll(async () => {
  await app?.close();
  await pool?.end();
});

describe("workflow activity", () => {
  it("counts and lists only runs on tasks the reader may open", async () => {
    const wf = (
      await call(minh, "POST", "/workflows", {
        name: "Review",
        runner: "server",
        steps: [
          { title: "Draft", kind: "ai", prompt: "{{task}}" },
          { title: "Approve", kind: "approval" },
        ],
      })
    ).body;
    expect(wf.id).toBeTruthy();
    // Lan's personal to-do: only Lan and workspace-wide editors (Minh) may read it; Huy may not.
    const task = (await call(lan, "POST", "/tasks", { title: "Private brief" })).body;
    expect((await call(lan, "PUT", `/tasks/${task.id}/workflow`, { workflowId: wf.id })).status).toBe(200);
    const steps = (states: string[]) =>
      JSON.stringify(
        states.map((state, i) => ({
          key: `s${i}`,
          title: `Step ${i}`,
          kind: i ? "approval" : "ai",
          state,
          output: "secret",
          ...(i === 0 ? { startedAt: "2026-11-05T10:00:00Z", finishedAt: "2026-11-05T10:01:30Z" } : {}),
        })),
      );
    await pool.query(
      `INSERT INTO task_agent_runs (id, task_id, workflow_id, workflow_name, runner, status, current_step, steps, started_by, finished_at) VALUES
        ($1, $3, $4, 'Review', 'server', 'done', 2, $5, 'lan', now()),
        ($2, $3, $4, 'Review', 'server', 'waiting_approval', 1, $6, 'lan', NULL)`,
      [newId(), newId(), task.id, wf.id, steps(["done", "done"]), steps(["done", "waiting"])],
    );

    const mine = (await call(lan, "GET", "/workflows/activity")).body;
    expect(mine.stats).toMatchObject({ runs30d: 2, done30d: 1, failed30d: 0, waiting: 1 });
    expect(mine.usage[wf.id]).toMatchObject({ tasks: 1, runs30d: 2, done30d: 1 });
    // Each step's figures by key: the first step finished twice in 90s each.
    expect(mine.usage[wf.id].steps.s0).toMatchObject({ done: 2, failed: 0, avgSec: 90 });
    expect(mine.runs).toHaveLength(2);
    // Waiting runs lead; steps carry their state only, never the output.
    expect(mine.runs[0]).toMatchObject({ status: "waiting_approval", taskCode: task.code, canApprove: true });
    expect(mine.runs[0].steps).toEqual([
      { title: "Step 0", kind: "ai", state: "done", startedAt: "2026-11-05T10:00:00Z", finishedAt: "2026-11-05T10:01:30Z" },
      { title: "Step 1", kind: "approval", state: "waiting" },
    ]);

    expect((await call(minh, "GET", "/workflows/activity")).body.runs).toHaveLength(2);
    const other = (await call(huy, "GET", "/workflows/activity")).body;
    expect(other.runs).toEqual([]);
    expect(other.stats).toMatchObject({ runs30d: 0, waiting: 0 });
    expect(other.usage[wf.id]).toBeUndefined();
  });
});

describe("asking for changes instead of approving", () => {
  it("sends the run back to the AI step under review with the request and its previous result", async () => {
    const task = (await call(lan, "POST", "/tasks", { title: "Newsletter" })).body;
    const id = newId();
    const steps = [
      { key: "a", title: "Draft", kind: "ai", prompt: "{{task}}", state: "done", output: "First draft", startedAt: "2026-11-05T10:00:00Z", finishedAt: "2026-11-05T10:01:00Z" },
      { key: "b", title: "Approve", kind: "approval", state: "waiting", startedAt: "2026-11-05T10:01:00Z" },
      { key: "c", title: "Done", kind: "status", status: "done", state: "pending" },
    ];
    await pool.query(
      `INSERT INTO task_agent_runs (id, task_id, workflow_name, runner, status, current_step, steps, started_by) VALUES ($1, $2, 'Review', 'local', 'waiting_approval', 1, $3, 'lan')`,
      [id, task.id, JSON.stringify(steps)],
    );
    // The request is the point: an empty one is refused, and only someone who may edit the task can send it back.
    expect((await call(lan, "POST", `/runs/${id}/rework`, { note: "  " })).status).toBe(400);
    expect((await call(huy, "POST", `/runs/${id}/rework`, { note: "Shorter" })).status).not.toBe(200);
    const r = await call(lan, "POST", `/runs/${id}/rework`, { note: "Shorter, and drop the pricing claim" });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ status: "queued", currentStep: 0 });
    const thread = (await call(lan, "GET", `/runs/${id}/questions`)).body;
    expect(thread.run.steps.map((s: { state: string }) => s.state)).toEqual(["pending", "pending", "pending"]);
    expect(thread.run.steps[0].rework).toMatchObject({ note: "Shorter, and drop the pricing claim", by: "lan" });
    // The runner is handed the step again, its instruction carrying the request and the result it replaces.
    const claim = (await call(lan, "POST", "/runner/claim", { device: "laptop", protocol: 2 })).body;
    expect(claim.next.run.id).toBe(id);
    await call(lan, "POST", `/runner/runs/${id}/env`, { state: "ready", isolation: "computer" });
    const next = (await call(lan, "POST", `/runner/runs/${id}/next`)).body;
    expect(next.step).toMatchObject({ index: 0, kind: "ai" });
    expect(next.step.input).toContain("Shorter, and drop the pricing claim");
    expect(next.step.input).toContain("First draft");
    // No longer waiting: a second request is refused.
    expect((await call(lan, "POST", `/runs/${id}/rework`, { note: "Again" })).status).toBe(400);
  });
});
