import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import type { INestApplication } from "@nestjs/common";
import pg from "pg";
import { migrate, signInternalToken, PRINCIPAL_HEADER, S3Storage, type ServiceClient } from "@workspace/service-kit";
import { newId, type Grant, type Principal } from "@workspace/shared";
import { createWorkApp } from "../../src/modules/work/app.js";
import { ASK_HINT, DECIDE_HINT, MAX_STEP_ROUNDS } from "../../src/modules/work/agent-ask.js";
import { resetTestDatabase } from "../test-db.js";

/**
 * Agent questions (work/agent-ask.ts): an AI step asks, the run waits, the right people answer, the step runs again
 * with the answers. The company AI is a fake that replies from a script and records each prompt.
 */
const SECRET = "dev-internal-secret-change-me-32bytes!";
const T = (...ps: string[]): Grant[] => ps.map((permission) => ({ permission, scope: "WORKSPACE" }));
const S = (...ps: string[]): Grant[] => ps.map((permission) => ({ permission, scope: "SELF" }));
const EMPLOYEE = [...T("project.read", "project.create", "task.read", "task.create", "ai.use"), ...S("task.edit", "task.assign")];
const ADMIN = [...EMPLOYEE, ...T("task.edit", "task.assign")];
const mk = (id: string, grants: Grant[]): Principal => ({ type: "user", id, teamIds: [], departmentId: null, grants });
const minh = mk("minh", ADMIN);
const lan = mk("lan", EMPLOYEE);
const huy = mk("huy", EMPLOYEE);

const ASK = (...qs: string[]) =>
  `\`\`\`workspace-ask\n${JSON.stringify({ questions: qs.map((text, i) => (i === 0 ? { text, options: ["Vietnam", "Singapore"] } : { text })) })}\n\`\`\``;
let script: string[] = [];
const prompts: string[] = [];
const ai = {
  request: async (_m: string, _path: string, body: { prompt: string }) => {
    prompts.push(body.prompt);
    return { text: script.shift() ?? "done" };
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

/** The run once it stops moving (a server run is driven in the background). */
async function settled(p: Principal, taskId: string) {
  for (let i = 0; i < 100; i++) {
    const run = (await call(p, "GET", `/tasks/${taskId}/runs`)).body.runs[0];
    if (!["queued", "running"].includes(run.status)) return run;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("run did not settle");
}

async function taskWith(owner: Principal, runner: "server" | "local", steps = [{ title: "Brief", kind: "ai", prompt: "Write a brief.\n\n{{task}}" }]) {
  const wf = (await call(minh, "POST", "/workflows", { name: `WF ${newId()}`, runner, steps })).body;
  // A personal task (no project): only its owner, assignee and workspace-wide editors may read it.
  const task = (await call(owner, "POST", "/tasks", { title: "Launch post", assigneeId: owner.id })).body;
  expect((await call(owner, "PUT", `/tasks/${task.id}/workflow`, { workflowId: wf.id })).status).toBe(200);
  return task as { id: string; code: string };
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
  app = await createWorkApp({ pool, storage, internalSecret: SECRET, ai, resolvePrincipal: async (id: string) => people.get(id)! });
  await app.listen(0);
  base = (await app.getUrl()).replace("[::1]", "127.0.0.1");
});

afterAll(async () => {
  await app?.close();
  await pool?.end();
});

describe("agent questions on a server run", () => {
  it("asks, waits, takes the answers and runs the step again with them", async () => {
    const task = await taskWith(lan, "server");
    script = [ASK("Which market?", "Any deadline?"), "The brief for Vietnam"];
    prompts.length = 0;
    expect((await call(lan, "POST", `/tasks/${task.id}/runs`)).status).toBe(201);
    const run = await settled(lan, task.id);
    expect(run).toMatchObject({ status: "waiting_input", canAnswer: true });
    expect(run.steps[0].state).toBe("waiting");
    expect(run.asks).toHaveLength(1);
    const ask = run.asks[0];
    expect(ask).toMatchObject({ round: 1, stepIndex: 0, outcome: null });
    expect(ask.questions).toEqual([
      { id: "q1", text: "Which market?", kind: "choice", options: ["Vietnam", "Singapore"] },
      { id: "q2", text: "Any deadline?", kind: "text" },
    ]);
    // The step's instruction told the AI how to ask.
    expect(prompts[0]).toContain("```workspace-ask");

    // The open list (the chat sidebar) and the task's card show it to the people who may answer.
    const open = (await call(lan, "GET", "/agent-questions/open")).body.asks;
    expect(open).toEqual([expect.objectContaining({ id: ask.id, runId: run.id, taskCode: task.code, count: 2, round: 1 })]);
    const detail = (await call(lan, "GET", `/tasks/${task.id}`)).body;
    expect(detail.agentAsks).toEqual([expect.objectContaining({ id: ask.id, canAnswer: true, questions: ask.questions })]);
    // Someone who cannot open this personal task sees nothing and cannot answer.
    expect((await call(huy, "GET", "/agent-questions/open")).body.asks).toEqual([]);
    expect((await call(huy, "GET", `/runs/${run.id}/questions`)).status).toBe(404);
    expect((await call(huy, "POST", `/agent-questions/${ask.id}/answer`, { answers: { q1: "x", q2: "y" } })).status).toBe(404);
    // Every required question needs an answer (or "let the AI decide").
    expect((await call(lan, "POST", `/agent-questions/${ask.id}/answer`, { answers: { q1: "Vietnam" } })).status).toBe(400);

    // The notice went out to the starter (also the assignee) once.
    const asked = (await pool.query("SELECT payload FROM outbox WHERE type = 'work.run.asked.v1' AND aggregateid = $1", [run.id])).rows;
    expect(asked).toHaveLength(1);
    expect(asked[0].payload.payload).toMatchObject({ runId: run.id, questionId: ask.id, recipientIds: ["lan"], count: 2 });

    expect((await call(lan, "POST", `/agent-questions/${ask.id}/answer`, { answers: { q1: "Vietnam", q2: "Friday" } })).status).toBe(201);
    const after = await settled(lan, task.id);
    expect(after.status).toBe("done");
    expect(after.steps[0]).toMatchObject({ state: "done", output: "The brief for Vietnam" });
    expect(prompts[1]).toContain("Q: Which market?\nA: Vietnam");
    expect(prompts[1]).toContain("Q: Any deadline?\nA: Friday");
    expect(after.asks[0]).toMatchObject({ outcome: "answered", answeredBy: "lan", answers: { q1: "Vietnam", q2: "Friday" } });
    // Answered: nothing waits any more, and a second answer is refused.
    expect((await call(lan, "GET", "/agent-questions/open")).body.asks).toEqual([]);
    expect((await call(lan, "POST", `/agent-questions/${ask.id}/answer`, { skip: true })).status).toBe(409);
    const thread = (await call(lan, "GET", `/runs/${run.id}/questions`)).body;
    expect(thread).toMatchObject({ task: { code: task.code }, run: { status: "done" }, canAnswer: true });
    expect(thread.rounds).toHaveLength(1);
    const closed = (await pool.query("SELECT payload FROM outbox WHERE type = 'work.run.answered.v1' AND aggregateid = $1", [run.id])).rows;
    expect(closed.map((r) => r.payload.payload.outcome)).toEqual(["answered"]);
  });

  it("an editor of the task may answer; 'let the AI decide' stops further questions", async () => {
    const task = await taskWith(lan, "server");
    script = [ASK("Tone?"), "Final text"];
    prompts.length = 0;
    await call(lan, "POST", `/tasks/${task.id}/runs`);
    const run = await settled(lan, task.id);
    // Minh may edit every task: he can answer on Lan's behalf.
    const open = (await call(minh, "GET", "/agent-questions/open")).body.asks;
    expect(open.map((a: { runId: string }) => a.runId)).toContain(run.id);
    expect((await call(minh, "POST", `/agent-questions/${run.asks[0].id}/answer`, { skip: true })).status).toBe(201);
    const after = await settled(lan, task.id);
    expect(after.status).toBe("done");
    expect(prompts[1]).toContain("not answered: decide yourself");
    expect(prompts[1]?.endsWith(DECIDE_HINT)).toBe(true);
    expect(after.asks[0]).toMatchObject({ outcome: "skipped", answeredBy: "minh" });
  });

  it("a step may ask again after the answers, up to its cap; then it is told to decide, and fails only if it still asks", async () => {
    const task = await taskWith(lan, "server");
    script = [ASK("A?"), ASK("B?"), ASK("C?"), ASK("D?"), ASK("E?")];
    prompts.length = 0;
    await call(lan, "POST", `/tasks/${task.id}/runs`);
    for (let round = 0; round < MAX_STEP_ROUNDS; round++) {
      const run = await settled(lan, task.id);
      expect(run.status).toBe("waiting_input");
      expect(run.asks).toHaveLength(round + 1);
      expect((await call(lan, "POST", `/agent-questions/${run.asks[round].id}/answer`, { answers: { q1: "ok" } })).status).toBe(201);
    }
    const last = await settled(lan, task.id);
    expect(last.status).toBe("failed");
    expect(last.error).toContain("kept asking");
    expect(last.asks).toHaveLength(MAX_STEP_ROUNDS);
    expect(prompts[1]?.endsWith(ASK_HINT)).toBe(true);
    expect(prompts[MAX_STEP_ROUNDS]?.endsWith(DECIDE_HINT)).toBe(true);
    // The step's log keeps every attempt and every answer, in order.
    const log = (last.steps[0].history as { kind: string; outcome?: string; by?: string }[]).map((e) => e.outcome ?? e.kind);
    expect(log).toEqual(["asked", "answered", "asked", "answered", "asked", "answered", "decide", "asked"]);
    expect(last.steps[0].history[1]).toMatchObject({ by: "lan", text: "A?\n→ ok" });
  });

  it("any AI step may ask: a later step asks too, with the earlier answers in hand", async () => {
    const task = await taskWith(lan, "server", [
      { title: "Brief", kind: "ai", prompt: "Write a brief.\n\n{{task}}" },
      { title: "Draft", kind: "ai", prompt: "Write the draft.\n\n{{previous}}" },
    ]);
    script = [ASK("Which market?"), "Brief for Vietnam", ASK("Headline?"), "Draft"];
    prompts.length = 0;
    await call(lan, "POST", `/tasks/${task.id}/runs`);
    const run = await settled(lan, task.id);
    expect(run.status).toBe("waiting_input");
    expect((await call(lan, "POST", `/agent-questions/${run.asks[0].id}/answer`, { answers: { q1: "Vietnam" } })).status).toBe(201);
    const second = await settled(lan, task.id);
    expect(second).toMatchObject({ status: "waiting_input", currentStep: 1 });
    expect(second.asks.map((a: { stepIndex: number }) => a.stepIndex)).toEqual([0, 1]);
    expect(prompts[2]).toContain("A: Vietnam");
    expect(prompts[2]?.endsWith(ASK_HINT)).toBe(true);
    expect((await call(lan, "POST", `/agent-questions/${second.asks[1].id}/answer`, { answers: { q1: "Go big" } })).status).toBe(201);
    const after = await settled(lan, task.id);
    expect(after.status).toBe("done");
    expect(prompts[3]).toContain("A: Go big");
    expect(after.steps[1]).toMatchObject({ state: "done", output: "Draft" });
    expect(after.steps[1].history.at(-1)).toMatchObject({ kind: "attempt", outcome: "done", output: "Draft" });
    // The wait for people is not counted as the step's work.
    expect(after.steps[0].waitedMs).toBeGreaterThanOrEqual(0);
    expect(after.steps[0].waitingSince).toBeUndefined();
  });

  it("'let the AI decide' keeps the answers already given", async () => {
    const task = await taskWith(lan, "server");
    script = [ASK("Which market?", "Tone?"), "Text"];
    prompts.length = 0;
    await call(lan, "POST", `/tasks/${task.id}/runs`);
    const run = await settled(lan, task.id);
    expect((await call(lan, "POST", `/agent-questions/${run.asks[0].id}/answer`, { skip: true, answers: { q1: "Singapore", q2: " " } })).status).toBe(201);
    const after = await settled(lan, task.id);
    expect(after.asks[0]).toMatchObject({ outcome: "skipped", answers: { q1: "Singapore" } });
    expect(prompts[1]).toContain("Q: Which market?\nA: Singapore");
    expect(prompts[1]).toContain("Q: Tone?\nA: (not answered: decide yourself");
  });

  it("gives the AI the task's context and posts the result under the workflow's name", async () => {
    const task = await taskWith(lan, "server");
    expect((await call(lan, "POST", `/tasks/${task.id}/comments`, { body: "The customer wants a 12-month plan" })).status).toBe(201);
    script = ["## Brief\n\n- Vietnam"];
    prompts.length = 0;
    await call(lan, "POST", `/tasks/${task.id}/runs`);
    const run = await settled(lan, task.id);
    expect(run.status).toBe("done");
    expect(prompts[0]).toContain("Context from the workspace");
    expect(prompts[0]).toContain("The customer wants a 12-month plan");
    const comments = (await call(lan, "GET", `/tasks/${task.id}`)).body.comments as { authorId: string; agent: string | null; body: string }[];
    const result = comments.at(-1)!;
    expect(result).toMatchObject({ authorId: "lan", agent: run.workflowName, body: "## Brief\n\n- Vietnam" });
    // A person's comment has no agent.
    expect(comments[0]!.agent).toBeNull();
  });

  it("cancelling closes the open round", async () => {
    const task = await taskWith(lan, "server");
    script = [ASK("A?")];
    await call(lan, "POST", `/tasks/${task.id}/runs`);
    const run = await settled(lan, task.id);
    expect((await call(lan, "POST", `/runs/${run.id}/cancel`)).body.status).toBe("cancelled");
    expect((await call(lan, "GET", "/agent-questions/open")).body.asks).toEqual([]);
    const after = (await call(lan, "GET", `/tasks/${task.id}/runs`)).body.runs[0];
    expect(after.asks[0]).toMatchObject({ outcome: "cancelled" });
    expect((await call(lan, "POST", `/agent-questions/${run.asks[0].id}/answer`, { skip: true })).status).toBe(409);
  });
});

/** A runner (protocol 2) takes the next run of `p`, says its environment is ready and asks for the first step. */
async function claimed(p: Principal) {
  const next = (await call(p, "POST", "/runner/claim", { device: "laptop", protocol: 2 })).body.next;
  if (!next) return null;
  await call(p, "POST", `/runner/runs/${next.run.id}/env`, { state: "ready", isolation: "computer" });
  const first = (await call(p, "POST", `/runner/runs/${next.run.id}/next`)).body;
  return { id: next.run.id as string, step: first.step as { index: number; kind: string; input: string }, status: first.status as string };
}

describe("agent questions on a local run", () => {
  it("the runner reports the ask block, the run waits, the step comes back with the answers", async () => {
    const task = await taskWith(lan, "local");
    await call(lan, "POST", `/tasks/${task.id}/runs`);
    // A runner from before protocol 2 is told to update and gets nothing.
    expect((await call(lan, "POST", "/runner/claim", { device: "laptop" })).body).toEqual({ next: null, upgrade: true });
    const first = (await claimed(lan))!;
    // The server writes the whole instruction: the task, then how to ask.
    expect(first.step).toMatchObject({ index: 0, kind: "ai" });
    expect(first.step.input).toContain("Write a brief.");
    expect(first.step.input).toContain(ASK_HINT);
    const reported = (await call(lan, "POST", `/runner/runs/${first.id}/step`, { index: 0, state: "done", output: `Reading the repo…\n${ASK("Which market?")}` })).body;
    expect(reported.status).toBe("waiting_input");
    // Waiting for answers: nothing to claim.
    expect((await call(lan, "POST", "/runner/claim", { device: "laptop", protocol: 2 })).body.next).toBeNull();

    const run = (await call(lan, "GET", `/tasks/${task.id}/runs`)).body.runs[0];
    expect(run.asks[0].questions[0]).toMatchObject({ text: "Which market?", kind: "choice" });
    expect((await call(lan, "POST", `/agent-questions/${run.asks[0].id}/answer`, { answers: { q1: "Singapore" } })).body.status).toBe("queued");

    // Back on the same computer the environment is still there (`resumed`); the step runs again with the answers.
    const back = (await call(lan, "POST", "/runner/claim", { device: "laptop", protocol: 2 })).body.next;
    expect(back).toMatchObject({ run: { id: first.id }, resumed: true });
    const again = (await call(lan, "POST", `/runner/runs/${first.id}/next`)).body;
    expect(again.step.index).toBe(0);
    expect(again.step.input).toContain("A: Singapore");
    expect((await call(lan, "POST", `/runner/runs/${first.id}/step`, { index: 0, state: "done", output: "Shipped" })).body.status).toBe("running");
    // Nothing left: asking for the next step finishes the run.
    expect((await call(lan, "POST", `/runner/runs/${first.id}/next`)).body).toEqual({ status: "done" });
  });

  it("accepts an explicit ask from the runner and refuses an empty one", async () => {
    const task = await taskWith(lan, "local");
    await call(lan, "POST", `/tasks/${task.id}/runs`);
    const next = (await claimed(lan))!;
    expect((await call(lan, "POST", `/runner/runs/${next.id}/step`, { index: 0, state: "ask", questions: [] })).status).toBe(400);
    expect((await call(lan, "POST", `/runner/runs/${next.id}/step`, { index: 0, state: "ask", questions: ["Which branch?"] })).body.status).toBe("waiting_input");
  });
});

describe("pause, continue and stop", () => {
  it("a server run paused mid-step keeps that step's result, holds, and continues from the next step", async () => {
    const task = await taskWith(lan, "server", [
      { title: "One", kind: "ai", prompt: "first" },
      { title: "Two", kind: "ai", prompt: "second" },
    ]);
    // The first AI call waits until the test lets it answer, so the pause lands mid-step.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    script = [];
    prompts.length = 0;
    const slow = ai.request;
    (ai as { request: unknown }).request = async (m: string, path: string, body: { prompt: string }) => {
      if (!prompts.length) await gate;
      return (slow as (m: string, p: string, b: { prompt: string }) => Promise<{ text: string }>)(m, path, body);
    };
    try {
      const run = (await call(lan, "POST", `/tasks/${task.id}/runs`)).body;
      for (let i = 0; i < 50 && (await call(lan, "GET", `/tasks/${task.id}/runs`)).body.runs[0].steps[0].state !== "running"; i++) await new Promise((r) => setTimeout(r, 20));
      // Huy cannot open Lan's personal task: he cannot pause it either.
      expect((await call(huy, "POST", `/runs/${run.id}/pause`)).status).toBe(404);
      expect((await call(lan, "POST", `/runs/${run.id}/pause`)).body.status).toBe("paused");
      expect((await call(lan, "POST", `/runs/${run.id}/pause`)).status).toBe(409);
      release();
      let now = run;
      for (let i = 0; i < 100; i++) {
        now = (await call(lan, "GET", `/tasks/${task.id}/runs`)).body.runs[0];
        if (now.steps[0].state === "done") break;
        await new Promise((r) => setTimeout(r, 20));
      }
      // The step in progress finished and kept its result; the run holds before the next one.
      expect(now).toMatchObject({ status: "paused", currentStep: 1, canControl: true });
      expect(now.steps[1].state).toBe("pending");
      await new Promise((r) => setTimeout(r, 100));
      expect(prompts).toHaveLength(1);
      const paused = (await pool.query("SELECT type FROM outbox WHERE aggregateid = $1 ORDER BY created_at", [run.id])).rows.map((r) => r.type);
      expect(paused).toEqual(["work.run.started.v1", "work.run.paused.v1"]);

      expect((await call(lan, "POST", `/runs/${run.id}/resume`)).body.status).toBe("running");
      const after = await settled(lan, task.id);
      expect(after.status).toBe("done");
      expect(prompts).toHaveLength(2);
      expect((await call(lan, "POST", `/runs/${run.id}/resume`)).status).toBe(409);
      expect((await call(lan, "POST", `/runs/${run.id}/cancel`)).status).toBe(409);
    } finally {
      (ai as { request: unknown }).request = slow;
    }
  });

  it("only queued or running runs pause; only paused ones continue; a paused run survives a restart", async () => {
    const task = await taskWith(lan, "server");
    script = [ASK("A?")];
    await call(lan, "POST", `/tasks/${task.id}/runs`);
    const asking = await settled(lan, task.id);
    expect(asking.status).toBe("waiting_input");
    expect((await call(lan, "POST", `/runs/${asking.id}/pause`)).status).toBe(409);
    expect((await call(lan, "POST", `/runs/${asking.id}/resume`)).status).toBe(409);
    await call(lan, "POST", `/runs/${asking.id}/cancel`);

    // A paused server run whose AI call was lost with the process: the step goes back to pending, the run stays paused.
    const { resumeServerRuns } = await import("../../src/modules/work/workflows.js");
    const id = newId();
    await pool.query(
      `INSERT INTO task_agent_runs (id, task_id, workflow_name, runner, status, current_step, steps, started_by, updated_at) VALUES ($1, $2, 'X', 'server', 'paused', 0, $3, 'lan', now() - interval '1 hour')`,
      [id, task.id, JSON.stringify([{ key: "a", title: "A", kind: "ai", prompt: "p", state: "running" }])],
    );
    await resumeServerRuns({ pool, ai, storage: null, resolve: async () => lan });
    const row = (await pool.query("SELECT status, steps FROM task_agent_runs WHERE id = $1", [id])).rows[0];
    expect(row.status).toBe("paused");
    expect(row.steps[0].state).toBe("pending");
  });

  it("a local run: the runner sees pause and stop between and during steps", async () => {
    const task = await taskWith(lan, "local", [
      { title: "One", kind: "ai", prompt: "first" },
      { title: "Two", kind: "ai", prompt: "second: {{previous}}" },
    ]);
    await call(lan, "POST", `/tasks/${task.id}/runs`);
    const { id } = (await claimed(lan))!;
    expect((await call(lan, "POST", `/runs/${id}/pause`)).body.status).toBe("paused");
    // The runner's check: paused, so it lets the step finish; logs still land.
    expect((await call(lan, "GET", `/runner/runs/${id}`)).body).toEqual({ status: "paused", currentStep: 0 });
    expect((await call(huy, "GET", `/runner/runs/${id}`)).status).toBe(403);
    expect((await call(lan, "POST", `/runner/runs/${id}/step`, { index: 0, state: "log", log: "working…" })).body.status).toBe("paused");
    // The step's result counts, then the run holds: no next step, and nothing can be claimed.
    expect((await call(lan, "POST", `/runner/runs/${id}/step`, { index: 0, state: "done", output: "one done" })).body).toEqual({ status: "paused" });
    expect((await call(lan, "POST", `/runner/runs/${id}/next`)).body).toEqual({ status: "paused" });
    expect((await call(lan, "POST", "/runner/claim", { device: "laptop", protocol: 2 })).body.next).toBeNull();
    // Continue: back in the queue at the next step, which reads the first one's result.
    expect((await call(lan, "POST", `/runs/${id}/resume`)).body.status).toBe("queued");
    expect((await call(lan, "POST", "/runner/claim", { device: "laptop", protocol: 2 })).body.next.run.id).toBe(id);
    const two = (await call(lan, "POST", `/runner/runs/${id}/next`)).body.step;
    expect(two).toMatchObject({ index: 1, kind: "ai" });
    expect(two.input).toContain("second: one done");
    // Stop: the runner's next check says cancelled; its late report changes nothing.
    expect((await call(lan, "POST", `/runs/${id}/cancel`)).body.status).toBe("cancelled");
    expect((await call(lan, "GET", `/runner/runs/${id}`)).body.status).toBe("cancelled");
    expect((await call(lan, "POST", `/runner/runs/${id}/step`, { index: 1, state: "done", output: "late" })).body.status).toBe("cancelled");
    const types = (await pool.query("SELECT type FROM outbox WHERE aggregateid = $1 ORDER BY created_at", [id])).rows.map((r) => r.type);
    expect(types).toEqual(["work.run.started.v1", "work.run.paused.v1", "work.run.resumed.v1", "work.run.cancelled.v1"]);
    // The audit trail: one entry per transition, with the run's id and never any step text.
    const trail = (await pool.query("SELECT payload FROM outbox WHERE type = 'audit.entry.recorded.v1' AND aggregateid = $1 ORDER BY created_at", [`task:${task.id}`])).rows.map(
      (r) => r.payload.payload,
    );
    expect(trail.map((x: { action: string }) => x.action)).toEqual(["work.workflow.started", "work.workflow.paused", "work.workflow.resumed", "work.workflow.cancelled"]);
    expect(trail[0]).toMatchObject({ targetType: "task", targetId: task.id, outcome: "success", meta: { runId: id, runner: "local" } });
  });
});
