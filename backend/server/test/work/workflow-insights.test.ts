import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import type { INestApplication } from "@nestjs/common";
import pg from "pg";
import { migrate, signInternalToken, PRINCIPAL_HEADER, type ServiceClient } from "@workspace/service-kit";
import { newId, type Grant, type Principal } from "@workspace/shared";
import { createWorkApp } from "../../src/modules/work/app.js";
import { resetTestDatabase } from "../test-db.js";

/**
 * AI › Workflows › Performance (work/workflows/insights.ts) through the API: the figures come from real runs, and a
 * run on a task the reader cannot open is in none of them, not even as a count.
 */
const SECRET = "dev-internal-secret-change-me-32bytes!";
const T = (...ps: string[]): Grant[] => ps.map((permission) => ({ permission, scope: "WORKSPACE" }));
const S = (...ps: string[]): Grant[] => ps.map((permission) => ({ permission, scope: "SELF" }));
const EMPLOYEE = [...T("project.read", "task.read", "task.create", "ai.use"), ...S("task.edit", "task.assign")];
const mk = (id: string, grants: Grant[]): Principal => ({ type: "user", id, teamIds: [], departmentId: null, grants });
const minh = mk("minh", [...EMPLOYEE, ...T("task.edit", "task.assign", "ai.agent.manage")]);
const lan = mk("lan", EMPLOYEE);
const huy = mk("huy", EMPLOYEE);

let script: (string | Error)[] = [];
const ai = {
  request: async () => {
    const next = script.shift() ?? "done";
    if (next instanceof Error) throw next;
    return { text: next, ran: { model: "fake-1", provider: "c_test", inputTokens: 1000, outputTokens: 100 } };
  },
} as unknown as ServiceClient;

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
async function ranOn(owner: Principal, workflowId: string) {
  const task = (await call(owner, "POST", "/tasks", { title: "A private task", assigneeId: owner.id })).body;
  await call(owner, "PUT", `/tasks/${task.id}/workflow`, { workflowId });
  expect((await call(owner, "POST", `/tasks/${task.id}/runs`)).status).toBe(201);
  for (let i = 0; i < 200; i++) {
    const run = (await call(owner, "GET", `/tasks/${task.id}/runs`)).body.runs[0];
    if (run && !["queued", "running"].includes(run.status)) return run;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("run did not settle");
}

beforeAll(async () => {
  await migrate("postgres://workspace_owner:owner_pw@localhost:5432/workspace_test", fileURLToPath(new URL("../../migrations/work", import.meta.url)), "work");
  await resetTestDatabase();
  pool = new pg.Pool({ connectionString: "postgres://workspace_work:app_pw@localhost:5432/workspace_test", max: 5 });
  const people: Record<string, Principal> = { minh, lan, huy };
  app = await createWorkApp({ pool, storage: null as never, internalSecret: SECRET, ai, resolvePrincipal: async (id) => people[id] ?? Promise.reject(new Error("not a member")) });
  await app.listen(0);
  base = (await app.getUrl()).replace("[::1]", "127.0.0.1");
});
afterAll(async () => {
  await app?.close();
  await pool?.end();
});

describe("workflow performance", () => {
  it("counts runs, tokens by model and failures for the reader, and nothing of a task they cannot open", async () => {
    const wf = (
      await call(minh, "POST", "/workflows", {
        name: `Perf ${newId()}`,
        steps: [
          { title: "Draft", kind: "ai", prompt: "{{task}}" },
          { title: "Polish", kind: "ai", prompt: "{{previous}}" },
        ],
      })
    ).body;
    script = ["A draft.", "Polished."];
    expect((await ranOn(lan, wf.id)).status).toBe("done");
    script = ["A draft.", new Error("model down")];
    expect((await ranOn(lan, wf.id)).status).toBe("failed");
    script = ["A draft.", "Polished."];
    expect((await ranOn(huy, wf.id)).status).toBe("done");

    // Lan reads her own two runs; Huy's personal task is not hers to open.
    const mine = (await call(lan, "GET", `/workflows/insights?days=30&workflowId=${wf.id}`)).body;
    expect(mine).toMatchObject({ days: 30, capped: false, totals: { runs: 2, done: 1, failed: 1, tokens: { input: 3000, output: 300 }, tokensUnknownRuns: 0 } });
    const w = mine.workflows[0];
    expect(w).toMatchObject({ id: wf.id, runs: 2, done: 1, failed: 1, models: [{ provider: "c_test", model: "fake-1", input: 3000, output: 300 }] });
    expect(w.steps.map((s: { title: string; runs: number; done: number; failed: number }) => [s.title, s.runs, s.done, s.failed])).toEqual([
      ["Draft", 2, 2, 0],
      ["Polish", 2, 1, 1],
    ]);
    expect(mine.daily).toHaveLength(1);
    // Someone who may read every task sees all three.
    const all = (await call(minh, "GET", `/workflows/insights?workflowId=${wf.id}`)).body;
    expect(all.totals).toMatchObject({ runs: 3, done: 2, failed: 1 });
    // The window is one of 7, 30 or 90 days: anything else reads 30.
    expect((await call(minh, "GET", "/workflows/insights?days=5000")).body.days).toBe(30);
    expect((await call(minh, "GET", "/workflows/insights?days=7")).body.days).toBe(7);
  });
});
