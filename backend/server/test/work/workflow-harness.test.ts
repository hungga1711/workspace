import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import type { INestApplication } from "@nestjs/common";
import pg from "pg";
import { migrate, signInternalToken, PRINCIPAL_HEADER, S3Storage, type ServiceClient } from "@workspace/service-kit";
import { newId, type Grant, type Principal } from "@workspace/shared";
import { createWorkApp } from "../../src/modules/work/app.js";
import { reclaimSilentRuns, resumeServerRuns } from "../../src/modules/work/workflows.js";
import { resetTestDatabase } from "../test-db.js";

/**
 * The workflow harness (work/workflows.ts): inputs, resources, checks that send work back, retries and
 * limits, who approves, what a finished run delivers, runs that survive a restart, and the runner protocol with a
 * sandbox and a company runner. The company AI is a fake that answers from a script and records what it was asked.
 */
const SECRET = "dev-internal-secret-change-me-32bytes!";
const T = (...ps: string[]): Grant[] => ps.map((permission) => ({ permission, scope: "WORKSPACE" }));
const S = (...ps: string[]): Grant[] => ps.map((permission) => ({ permission, scope: "SELF" }));
const EMPLOYEE = [
  ...T("project.read", "project.create", "task.read", "task.create", "ai.use", "document.create", "document.read", "file.upload", "file.read"),
  ...S("task.edit", "task.assign"),
];
const ADMIN = [...EMPLOYEE, ...T("task.edit", "task.assign", "ai.agent.manage")];
const mk = (id: string, grants: Grant[]): Principal => ({ type: "user", id, teamIds: [], departmentId: null, grants });
const minh = mk("minh", ADMIN);
const lan = mk("lan", EMPLOYEE);
const huy = mk("huy", EMPLOYEE);
const people: Record<string, Principal> = { minh, lan, huy };

const PASS = '```workspace-check\n{"pass": true, "issues": []}\n```';
const FAIL = (...issues: string[]) => `\`\`\`workspace-check\n${JSON.stringify({ pass: false, issues })}\n\`\`\``;
type Reply = string | { text: string; tokens?: number } | Error;
let script: Reply[] = [];
const asked: { prompt: string; model?: string; role?: string; tools?: boolean; maxTokens?: number; runId?: string; step?: number }[] = [];
/** What the fake AI does while it "works" on a step (the real one reports its activity to the work module then). */
let during: ((body: { runId?: string; step?: number }) => Promise<void>) | null = null;
const ai = {
  request: async (_m: string, _path: string, body: { prompt: string; model?: string; role?: string; tools?: boolean; maxTokens?: number; runId?: string; step?: number }) => {
    asked.push(body);
    await during?.(body);
    const next = script.shift() ?? "done";
    if (next instanceof Error) throw next;
    const text = typeof next === "string" ? next : next.text;
    const tokens = typeof next === "string" ? 100 : (next.tokens ?? 100);
    return { text, ran: { model: "fake-1", inputTokens: tokens, outputTokens: tokens } };
  },
} as unknown as ServiceClient;

let app: INestApplication;
let base: string;
let pool: pg.Pool;
let storage: S3Storage;

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
  for (let i = 0; i < 200; i++) {
    const run = (await call(p, "GET", `/tasks/${taskId}/runs`)).body.runs[0];
    if (run && !["queued", "running"].includes(run.status)) return run;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("run did not settle");
}

type Step = Record<string, unknown>;
const AI = (title: string, prompt = "{{task}}", more: Step = {}): Step => ({ title, kind: "ai", prompt, ...more });

async function workflowOf(steps: Step[], config: Record<string, unknown> = {}, by: Principal = minh) {
  const r = await call(by, "POST", "/workflows", { name: `WF ${newId()}`, steps, config });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body as { id: string; runner: string; steps: { key: string }[]; config: Record<string, never> };
}
async function taskOn(owner: Principal, workflowId: string, more: Record<string, unknown> = {}) {
  const task = (await call(owner, "POST", "/tasks", { title: "Launch post", description: "For the autumn launch.", assigneeId: owner.id, ...more })).body;
  expect((await call(owner, "PUT", `/tasks/${task.id}/workflow`, { workflowId })).status).toBe(200);
  return task as { id: string; code: string };
}
async function ran(owner: Principal, steps: Step[], config: Record<string, unknown> = {}, inputs?: Record<string, unknown>) {
  const wf = await workflowOf(steps, config);
  const task = await taskOn(owner, wf.id);
  const started = await call(owner, "POST", `/tasks/${task.id}/runs`, inputs ? { inputs } : undefined);
  expect(started.status, JSON.stringify(started.body)).toBe(201);
  return { wf, task, run: await settled(owner, task.id) };
}

beforeAll(async () => {
  await migrate("postgres://workspace_owner:owner_pw@localhost:5432/workspace_test", fileURLToPath(new URL("../../migrations/work", import.meta.url)), "work");
  await resetTestDatabase();
  pool = new pg.Pool({ connectionString: "postgres://workspace_work:app_pw@localhost:5432/workspace_test", max: 5 });
  storage = new S3Storage({
    endpoint: "http://localhost:8333",
    region: "auto",
    bucket: "workspace-files",
    accessKeyId: "workspace_dev_key",
    secretAccessKey: "workspace_dev_secret",
  });
  app = await createWorkApp({ pool, storage, internalSecret: SECRET, ai, resolvePrincipal: async (id) => people[id] ?? Promise.reject(new Error("not a member")) });
  await app.listen(0);
  base = (await app.getUrl()).replace("[::1]", "127.0.0.1");
});

afterAll(async () => {
  await app?.close();
  await pool?.end();
});

const last = () => asked[asked.length - 1]!;

describe("saving a workflow", () => {
  it("stores the whole harness and derives how it is driven from its environment", async () => {
    const wf = await workflowOf([AI("Draft"), { title: "Approve", kind: "approval", approver: "owner" }], {
      inputs: [{ label: "Audience", type: "text", required: true }],
      environment: { kind: "sandbox", host: "company", isolation: "container", image: "python:3.12-slim", network: "off" },
      resources: { notes: "Be brief.", links: [{ url: "https://example.com/brand", title: "Brand" }] },
      guardrails: { maxMinutes: 20, stepMinutes: 5, ask: "never" },
      output: { comment: true, doc: true, files: true, status: "review" },
      autoStart: true,
    });
    expect(wf.runner).toBe("local");
    expect(wf.config).toMatchObject({
      inputs: [{ key: "audience", label: "Audience", type: "text", required: true }],
      environment: { kind: "sandbox", host: "company", isolation: "container", image: "python:3.12-slim", network: "off" },
      resources: { notes: "Be brief.", taskContext: true, links: [{ url: "https://example.com/brand", title: "Brand" }] },
      guardrails: { maxMinutes: 20, stepMinutes: 5, maxTokens: 0, ask: "never" },
      output: { comment: true, doc: true, files: true, subtasks: false, status: "review" },
      autoStart: true,
    });
    const one = await call(lan, "GET", `/workflows/${wf.id}`);
    expect(one.body).toMatchObject({ id: wf.id, canEdit: false, steps: [{ key: "draft" }, { key: "approve", approver: "owner" }] });
    // What cannot run is refused with the step's name.
    expect((await call(minh, "POST", "/workflows", { name: "x", steps: [{ title: "Tests", kind: "command", command: "npm test" }] })).body.message).toMatch(
      /sandbox or on a computer/,
    );
    expect((await call(minh, "POST", "/workflows", { name: "x", steps: [{ title: "Check", kind: "check", criteria: "short" }] })).body.message).toMatch(/nothing before it/);
    // A workflow from before the harness still saves with only where it runs.
    const old = (await call(minh, "POST", "/workflows", { name: "Old", runner: "local", steps: [{ title: "Tests", kind: "command", command: "npm test" }] })).body;
    expect(old).toMatchObject({ runner: "local", config: { environment: { kind: "computer" } } });
  });

  it("lists templates for every department, each a complete harness, and the runners seen", async () => {
    const r = (await call(lan, "GET", "/workflows")).body;
    expect(r.templates.length).toBeGreaterThan(15);
    expect(new Set(r.templates.map((t: { category: string }) => t.category)).size).toBeGreaterThan(7);
    for (const t of r.templates) expect(t.config.guardrails.maxMinutes).toBeGreaterThan(0);
    expect(r.prompting.limits).toMatchObject({ resources: 20000 });
    expect(r.prompting.hints.check).toContain("workspace-check");
    expect(Array.isArray(r.runners)).toBe(true);
    // A template saves as it is.
    const t = r.templates.find((x: { key: string }) => x.key === "support-reply") ?? r.templates[0];
    const saved = await call(lan, "POST", "/workflows", { name: t.name, description: t.description, category: t.category, steps: t.steps, config: t.config, template: t.key });
    expect(saved.status, JSON.stringify(saved.body)).toBe(201);
    expect(saved.body.steps.map((s: { key: string }) => s.key)).toEqual(t.steps.map((s: { key: string }) => s.key));
  });

  it("copies a workflow for someone else to change", async () => {
    const wf = await workflowOf([AI("Draft")], { resources: { notes: "N" } });
    const copy = (await call(lan, "POST", `/workflows/${wf.id}/duplicate`)).body;
    expect(copy).toMatchObject({ canEdit: true, createdBy: "lan", config: { resources: { notes: "N" } } });
    expect(copy.name).toMatch(/\(copy\)$/);
    expect(copy.id).not.toBe(wf.id);
  });
});

describe("inputs", () => {
  const config = {
    inputs: [
      { label: "Audience", type: "text", required: true },
      { label: "Tone", type: "choice", options: ["Formal", "Friendly"], default: "Friendly" },
    ],
  };

  it("asks for what the workflow needs before a run starts and hands it to the steps", async () => {
    const wf = await workflowOf([AI("Draft", "Write for {{input.audience}}, {{input.tone}}.\n\n{{task}}"), AI("Polish", "{{task}}\n\n{{previous}}")], config);
    const task = await taskOn(lan, wf.id);
    expect((await call(lan, "POST", `/tasks/${task.id}/runs`)).body.message).toMatch(/"Audience" is required/);
    expect((await call(lan, "POST", `/tasks/${task.id}/runs`, { inputs: { audience: "CFOs", tone: "Rude" } })).body.message).toMatch(/one of its options/);
    asked.length = 0;
    script = ["DRAFT", "FINAL"];
    expect((await call(lan, "POST", `/tasks/${task.id}/runs`, { inputs: { audience: "CFOs" } })).status).toBe(201);
    const run = await settled(lan, task.id);
    expect(run).toMatchObject({ status: "done", inputs: { audience: "CFOs", tone: "Friendly" } });
    expect(asked[0]!.prompt).toContain("Write for CFOs, Friendly.");
    // A step that does not place the inputs still reads them, with the task.
    expect(asked[1]!.prompt).toContain("Details given when this run was started:\n- Audience: CFOs\n- Tone: Friendly");
    // The run keeps the config it started with, whatever happens to the workflow later.
    expect(run.config.inputs.map((f: { key: string }) => f.key)).toEqual(["audience", "tone"]);
  });
});

describe("resources", () => {
  it("gives every AI step the playbook, the pages and the text files; a step can leave them out", async () => {
    const page = (await call(lan, "POST", "/docs", { title: "Brand voice", content: "Plain words. No exclamation marks.", projectId: null })).body;
    expect(page.id, JSON.stringify(page)).toBeTruthy();
    // A file uploaded for a workflow not saved yet stays with the uploader until the save adopts it.
    const csv = "plan,price\nStarter,9\nTeam,29\n";
    const up = (await call(minh, "POST", "/files/uploads", { name: "prices.csv", contentType: "text/csv", size: csv.length, attachTo: { type: "workflow", id: "draft" } })).body;
    expect(up.fileId, JSON.stringify(up)).toBeTruthy();
    expect((await fetch(up.uploadUrl, { method: "PUT", headers: { "content-type": "text/csv" }, body: csv })).ok).toBe(true);
    expect((await call(minh, "POST", `/files/${up.fileId}/confirm`)).status).toBeLessThan(300);
    expect((await call(lan, "GET", `/files/${up.fileId}/download`)).status).toBe(404);

    const wf = await workflowOf([AI("Draft"), AI("Format", "Tidy this:\n{{previous}}", { resources: false })], {
      resources: {
        notes: "Always quote prices from the list.",
        docs: [{ id: page.id, title: "Brand voice" }],
        // Someone else's file id never becomes this workflow's resource.
        files: [
          { id: up.fileId, name: "prices.csv", size: csv.length, contentType: "text/csv" },
          { id: newId(), name: "stolen.txt", size: 1, contentType: "text/plain" },
        ],
        links: [{ url: "https://example.com/brand", title: "Brand site" }],
      },
    });
    expect(wf.config.resources).toMatchObject({ files: [{ id: up.fileId, name: "prices.csv" }] });
    expect((wf.config.resources as unknown as { files: unknown[] }).files).toHaveLength(1);
    // Saved: the file is the workflow's, and anyone who reads workflows may open it.
    expect((await call(lan, "GET", `/files/${up.fileId}/download`)).status).toBe(200);

    const task = await taskOn(lan, wf.id);
    asked.length = 0;
    script = ["DRAFT", "TIDY"];
    await call(lan, "POST", `/tasks/${task.id}/runs`);
    expect((await settled(lan, task.id)).status).toBe("done");
    const first = asked[0]!.prompt;
    expect(first).toMatch(/^Reference material from the company/);
    expect(first).toContain("## Playbook\nAlways quote prices from the list.");
    expect(first).toContain("## Page: Brand voice\nPlain words. No exclamation marks.");
    expect(first).toContain("## File: prices.csv\nplan,price\nStarter,9");
    expect(first).toContain("- Brand site: https://example.com/brand");
    expect(asked[1]!.prompt).not.toContain("Reference material");

    // Dropped from the list on a later save: the file goes with it.
    const again = await call(minh, "PUT", `/workflows/${wf.id}`, { name: "Without files", steps: [AI("Draft")], config: { resources: { notes: "N" } } });
    expect(again.status).toBe(200);
    expect((await call(lan, "GET", `/files/${up.fileId}/download`)).status).toBe(404);
  });

  it("a page the person who started the run cannot open never reaches the model", async () => {
    const secret = (await call(minh, "POST", "/docs", { title: "Salaries", content: "CEO: 1", projectId: null, visibility: "private" })).body;
    const wf = await workflowOf([AI("Draft")], { resources: { docs: [{ id: secret.id, title: "Salaries" }], taskContext: false } });
    const task = await taskOn(lan, wf.id);
    asked.length = 0;
    script = ["X"];
    await call(lan, "POST", `/tasks/${task.id}/runs`);
    await settled(lan, task.id);
    expect(asked[0]!.prompt).not.toContain("CEO: 1");
    expect(asked[0]!.prompt).toContain("The person who started the run cannot open: Salaries");
  });
});

describe("resources from where a company keeps them", () => {
  let site: Server;
  let origin = "";
  beforeAll(async () => {
    // Links are fetched from the outside world only; this test's own server is allowed the way webhooks' tests are.
    process.env.WEBHOOK_ALLOW_PRIVATE = "1";
    site = createServer((req, res) => {
      if (req.url === "/brand")
        return void res
          .writeHead(200, { "content-type": "text/html; charset=utf-8" })
          .end("<html><head><title>x</title><script>var secret = 1;</script></head><body><h1>Brand voice</h1><p>Plain words &amp; short sentences.</p></body></html>");
      if (req.url === "/moved") return void res.writeHead(302, { location: "/prices.csv" }).end();
      if (req.url === "/prices.csv") return void res.writeHead(200, { "content-type": "text/csv" }).end("plan,price\nTeam,29\n");
      if (req.url === "/private") return void res.writeHead(403).end("sign in");
      res.writeHead(404).end();
    });
    await new Promise<void>((r) => site.listen(0, "127.0.0.1", r));
    origin = `http://127.0.0.1:${(site.address() as { port: number }).port}`;
  });
  afterAll(async () => {
    delete process.env.WEBHOOK_ALLOW_PRIVATE;
    await new Promise((r) => site.close(r));
  });

  it("checks a link as it is added: readable with how much text, or why not", async () => {
    const check = async (url: string) => (await call(lan, "POST", "/workflows/links/check", { url })).body;
    expect(await check(`${origin}/brand`)).toMatchObject({ ok: true, kind: "web", sample: "Brand voice Plain words & short sentences." });
    expect(await check(`${origin}/moved`)).toMatchObject({ ok: true, chars: 18 });
    expect(await check(`${origin}/private`)).toEqual({ ok: false, kind: "web", problem: "private" });
    expect(await check(`${origin}/nothing`)).toMatchObject({ ok: false, problem: "unreachable" });
    expect(await check("https://drive.google.com/drive/folders/1AbCdEfGhIjKlMnOp")).toEqual({ ok: false, kind: "gfolder", problem: "folder" });
    expect((await call(lan, "POST", "/workflows/links/check", { url: "not a link" })).status).toBe(400);
  });

  it("reads links, files from the Drive and other tasks into every AI step, as the person who started the run", async () => {
    // A file in Minh's Drive, shared with the workspace; another he keeps private.
    const drive = async (name: string, body: string, share: boolean) => {
      const up = (await call(minh, "POST", "/drive/uploads", { name, contentType: "text/plain", size: body.length })).body;
      expect(up.itemId, JSON.stringify(up)).toBeTruthy();
      await fetch(up.uploadUrl, { method: "PUT", headers: { "content-type": "text/plain" }, body });
      expect((await call(minh, "POST", `/files/${up.fileId}/confirm`)).status).toBeLessThan(300);
      expect((await call(minh, "POST", `/drive/items/${up.itemId}/finish`)).status).toBe(200);
      if (share) expect((await call(minh, "PUT", `/drive/items/${up.itemId}/sharing`, { visibility: "workspace", viewers: [], editors: [] })).status).toBeLessThan(300);
      return up.itemId as string;
    };
    const shared = await drive("warranty.txt", "Warranty: 24 months on parts.", true);
    const hidden = await drive("margins.txt", "Margin: 61%", false);
    // A past task of Lan's own to learn from, and one she cannot open.
    const past = (await call(lan, "POST", "/tasks", { title: "Spring campaign", description: "Worked well: short subject lines.", assigneeId: "lan" })).body;
    await call(lan, "POST", `/tasks/${past.id}/comments`, { body: "Open rate was 41%." });
    const secret = (await call(minh, "POST", "/tasks", { title: "Layoff plan", description: "Confidential.", assigneeId: "minh" })).body;

    const wf = await workflowOf([AI("Draft", "Write the campaign email.")], {
      resources: {
        drive: [
          { id: shared, name: "warranty.txt" },
          { id: hidden, name: "margins.txt" },
        ],
        tasks: [
          { id: past.id, code: past.code, title: "Spring campaign" },
          { id: secret.id, code: secret.code, title: "Layoff plan" },
        ],
        links: [
          { url: `${origin}/brand`, title: "Brand voice" },
          { url: `${origin}/private`, title: "Board deck" },
        ],
        taskContext: false,
      },
    });
    expect(wf.config.resources).toMatchObject({ drive: [{ id: shared }, { id: hidden }], tasks: [{ code: past.code }, { code: secret.code }] });
    const task = await taskOn(lan, wf.id);
    asked.length = 0;
    script = ["EMAIL"];
    await call(lan, "POST", `/tasks/${task.id}/runs`);
    expect((await settled(lan, task.id)).status).toBe("done");
    const prompt = asked[0]!.prompt;
    expect(prompt).toContain(`## Task: ${past.code} · Spring campaign\nStatus: todo\n\nWorked well: short subject lines.\n\nLatest comments:\n- Open rate was 41%.`);
    expect(prompt).toContain("## File: warranty.txt\nWarranty: 24 months on parts.");
    expect(prompt).toContain(`## Link: Brand voice (${origin}/brand)\nBrand voice\nPlain words & short sentences.`);
    expect(prompt).not.toContain("var secret");
    // What Lan cannot open stays out, and is named.
    expect(prompt).not.toContain("Margin: 61%");
    expect(prompt).not.toContain("Confidential.");
    // By its code only: the title of a task she cannot open is not hers to read either.
    expect(prompt).toContain(`cannot open: ${secret.code}, margins.txt`);
    expect(prompt).not.toContain("Layoff plan");
    expect(prompt).toContain(`- Board deck: ${origin}/private (not shared with anyone who has the link)`);
    // The instruction placed nothing to work on, so the task came with it.
    expect(prompt).toContain(`Write the campaign email.\n\n${task.code} · Launch post`);

    // On a runner, the Drive file she may read is among the files to download; the private one is not.
    const sandbox = await workflowOf([AI("Draft")], {
      environment: { kind: "sandbox", isolation: "folder" },
      resources: {
        drive: [
          { id: shared, name: "warranty.txt" },
          { id: hidden, name: "margins.txt" },
        ],
      },
    });
    const t2 = await taskOn(lan, sandbox.id);
    await call(lan, "POST", `/tasks/${t2.id}/runs`);
    const claim = (await call(lan, "POST", "/runner/claim", { device: "lan-mac", protocol: 2 })).body.next;
    expect(claim.assets.map((a: { name: string; from: string }) => `${a.from}:${a.name}`)).toEqual(["drive:warranty.txt"]);
    await call(lan, "POST", `/runs/${claim.run.id}/cancel`);
  });
});

describe("time estimates", () => {
  it("says how long a run should take, from typical times first and from the workflow's own runs after", async () => {
    const wf = await workflowOf([
      AI("Draft"),
      { title: "Quality", kind: "check", criteria: "Short" },
      { title: "Approve", kind: "approval" },
      AI("Send", "{{previous}}", { model: "fast" }),
    ]);
    expect((await call(lan, "GET", `/workflows/${wf.id}/estimate`)).body).toEqual({ totalSec: 80, steps: { draft: 45, quality: 15, approve: 0, send: 20 }, basedOn: 0 });
    const task = await taskOn(lan, wf.id);
    script = ["DRAFT", PASS];
    await call(lan, "POST", `/tasks/${task.id}/runs`);
    const waiting = await settled(lan, task.id);
    // Waiting for a person: what is left is the last step, and nobody can say when.
    expect(waiting.estimate).toMatchObject({ totalSec: 80, remainingSec: 20, finishAt: null, basedOn: 0 });
    script = ["SENT"];
    await call(lan, "POST", `/runs/${waiting.id}/approve`, { note: "" });
    const done = await settled(lan, task.id);
    expect(done.estimate).toMatchObject({ remainingSec: 0, finishAt: null });
    // The next estimate is drawn from that run: its steps took well under the typical times.
    const next = (await call(lan, "GET", `/workflows/${wf.id}/estimate`)).body;
    expect(next.basedOn).toBe(1);
    expect(next.steps.draft).toBeLessThan(45);
    expect(next.steps.approve).toBe(0);
  });

  it("a workflow can leave the estimate out", async () => {
    script = ["X"];
    const { run } = await ran(lan, [AI("Draft")], { estimate: false });
    expect(run.estimate).toBeNull();
    expect(run.config.estimate).toBe(false);
  });
});

describe("checks", () => {
  const steps = (more: Step = {}) => [
    AI("Draft", "Write.\n\n{{task}}"),
    { title: "Quality", kind: "check", criteria: "Under 100 words\nFor {{input.audience}}", ...more },
    AI("Summary", "Summarize:\n{{previous}}"),
  ];
  const config = { inputs: [{ label: "Audience", type: "text", default: "CFOs" }] };

  it("a check that passes lets the run go on; the judge sees the requirements, the result and the playbook", async () => {
    asked.length = 0;
    script = ["DRAFT ONE", PASS, "SUMMARY"];
    const { run } = await ran(lan, steps(), { ...config, resources: { notes: "House style: sober." } });
    expect(run.status).toBe("done");
    const judge = asked[1]!;
    expect(judge).toMatchObject({ model: "fast", tools: false });
    expect(judge.prompt).toContain("Requirements:\nUnder 100 words\nFor CFOs");
    expect(judge.prompt).toContain('made by the step "Draft"');
    expect(judge.prompt).toContain("DRAFT ONE");
    expect(judge.prompt).toContain("House style: sober.");
    expect(run.steps[1]).toMatchObject({ state: "done", verdict: { pass: true, round: 1 } });
    // A check has no result of its own: the next step still reads the draft.
    expect(asked[2]!.prompt).toContain("Summarize:\nDRAFT ONE");
  });

  it("a check that fails sends the work back with its issues, then judges the new result", async () => {
    asked.length = 0;
    script = ["LONG DRAFT", FAIL("Over 100 words", "No audience named"), "SHORT DRAFT", PASS, "SUMMARY"];
    const { run } = await ran(lan, steps());
    expect(run.status).toBe("done");
    const redo = asked[2]!.prompt;
    expect(redo).toContain('An automatic check ("Quality") did not pass');
    expect(redo).toContain("- Over 100 words\n- No audience named");
    expect(redo).toContain("Your previous result:\nLONG DRAFT");
    expect(asked[3]!.prompt).toContain("SHORT DRAFT");
    expect(run.steps[0]).toMatchObject({ state: "done", output: "SHORT DRAFT", rework: { by: "check", check: "Quality" } });
    expect(run.steps[0].history.map((h: { kind: string }) => h.kind)).toEqual(["attempt", "sent_back", "attempt"]);
    expect(run.steps[1]).toMatchObject({ state: "done", sentBack: 1, verdict: { pass: true, round: 2 } });
    expect(run.steps[1].history.filter((h: { kind: string }) => h.kind === "checked").map((h: { outcome: string }) => h.outcome)).toEqual(["failed", "done"]);
    expect(run.usage).toMatchObject({ inputTokens: 500, outputTokens: 500 });
  });

  it("after its attempts a check stops the run, or goes on with the issues on record for the approver", async () => {
    script = ["D1", FAIL("bad"), "D2", FAIL("still bad")];
    const stopped = await ran(lan, steps({ attempts: 1 }));
    expect(stopped.run).toMatchObject({ status: "failed", canRetry: true });
    expect(stopped.run.error).toBe('the check "Quality" did not pass: still bad');
    expect(stopped.run.steps[1]).toMatchObject({ state: "failed", verdict: { pass: false, issues: ["still bad"], round: 2 } });

    script = ["D1", FAIL("too long")];
    const on = await ran(lan, [AI("Draft"), { title: "Quality", kind: "check", criteria: "Short", attempts: 0, onFail: "continue" }, { title: "Approve", kind: "approval" }]);
    expect(on.run.status).toBe("waiting_approval");
    expect(on.run.steps[1]).toMatchObject({ state: "done", verdict: { pass: false, issues: ["too long"] } });
    const thread = (await call(lan, "GET", `/runs/${on.run.id}/questions`)).body;
    expect(thread.run.steps[2]).toMatchObject({ review: "D1", reviewFrom: "Draft", issues: ["too long"] });
  });

  it("a verdict that cannot be read is asked for once more, never taken as a pass", async () => {
    script = ["D1", "Looks fine to me!", PASS];
    const ok = await ran(lan, [AI("Draft"), { title: "Quality", kind: "check", criteria: "Short" }]);
    expect(ok.run.status).toBe("done");
    expect(ok.run.steps[1]).toMatchObject({ retried: 1, verdict: { pass: true } });
    script = ["D1", "Looks fine!", "Still fine!"];
    const bad = await ran(lan, [AI("Draft"), { title: "Quality", kind: "check", criteria: "Short" }]);
    expect(bad.run).toMatchObject({ status: "failed", error: 'the check "Quality" gave no verdict' });
  });
});

describe("retries and limits", () => {
  it("runs a failed step again while it has retries, then fails the run with the reason", async () => {
    const down = Object.assign(new Error("503"), { status: 503, body: { message: "the AI did not answer in time" } });
    script = [down, "RECOVERED"];
    const ok = await ran(lan, [AI("Draft", "{{task}}", { retries: 1 })]);
    expect(ok.run).toMatchObject({ status: "done", steps: [{ state: "done", output: "RECOVERED", retried: 1 }] });
    expect(ok.run.steps[0].history.map((h: { kind: string; outcome?: string }) => `${h.kind}:${h.outcome ?? ""}`)).toEqual(["attempt:failed", "retry:", "attempt:done"]);
    script = [down];
    const bad = await ran(lan, [AI("Draft")]);
    expect(bad.run).toMatchObject({ status: "failed", error: "the AI did not answer in time", canRetry: true });
  });

  it("a failed run goes again from the step that failed, keeping what was made before it", async () => {
    script = ["FACTS", new Error("boom")];
    const { run, task } = await ran(lan, [AI("Facts"), AI("Draft", "From:\n{{steps.facts}}")]);
    expect(run).toMatchObject({ status: "failed", currentStep: 1 });
    expect((await call(huy, "POST", `/runs/${run.id}/retry`)).status).toBe(404);
    asked.length = 0;
    script = ["DRAFT"];
    expect((await call(lan, "POST", `/runs/${run.id}/retry`)).status).toBe(201);
    const again = await settled(lan, task.id);
    expect(again).toMatchObject({ id: run.id, status: "done", error: null });
    expect(asked).toHaveLength(1);
    expect(asked[0]!.prompt).toBe("From:\nFACTS\n\n" + asked[0]!.prompt.split("\n\n").slice(1).join("\n\n"));
    expect((await call(lan, "POST", `/runs/${run.id}/retry`)).status).toBe(409);
  });

  it("stops a run that is over its token budget before the next step", async () => {
    script = [{ text: "BIG", tokens: 600 }, "never asked"];
    asked.length = 0;
    const { run } = await ran(lan, [AI("One"), AI("Two")], { guardrails: { maxTokens: 1000 } });
    expect(run.status).toBe("failed");
    expect(run.error).toMatch(/^over the token budget: 1,200 of 1,000 tokens used/);
    expect(asked).toHaveLength(1);
  });

  it("a workflow or a step can say the AI never stops to ask", async () => {
    const ASK = '```workspace-ask\n{"questions": [{"text": "Which market?"}]}\n```';
    asked.length = 0;
    script = [ASK, "DECIDED"];
    const { run } = await ran(lan, [AI("Draft")], { guardrails: { ask: "never" } });
    expect(run.status).toBe("done");
    expect(asked[0]!.prompt).toContain("Do not ask any more questions");
    expect(run.steps[0].history.map((h: { outcome?: string }) => h.outcome)).toEqual(["decide", "done"]);
    script = [ASK, ASK];
    const still = await ran(lan, [AI("Draft", "{{task}}", { ask: false })]);
    expect(still.run).toMatchObject({ status: "failed", error: 'the AI kept asking questions on "Draft" instead of deciding' });
  });

  it("passes a step's model, role, tools and length to the AI", async () => {
    asked.length = 0;
    script = ["X"];
    await ran(lan, [AI("Draft", "{{task}}", { model: "fast", role: "An editor.", tools: false, maxOutput: 4000 })]);
    expect(last()).toMatchObject({ model: "fast", role: "An editor.", tools: false, maxTokens: 4000 });
  });
});

describe("what the agent is doing", () => {
  const aiModule: Principal = { type: "service", id: "ai", teamIds: [], departmentId: null, grants: [{ permission: "agent.post", scope: "PLATFORM" }] };
  it("a step of the company's AI reports its tools and its answer as it is written; the page reads them as they come", async () => {
    const seen: { doing?: { kind: string; text: string } | undefined; kinds: string[]; draft?: string | undefined }[] = [];
    let taskId = "";
    during = async (b) => {
      const say = (events: unknown[]) => call(aiModule, "POST", `/internal/runs/${b.runId}/activity`, { step: b.step, events });
      expect((await say([{ kind: "tool", tool: "Workspace › search", text: "query: autumn launch" }])).body).toEqual({ ok: true });
      await say([
        { kind: "result", tool: "Workspace › search", text: "3 pages" },
        { kind: "draft", detail: "Autumn is" },
      ]);
      // A draft replaces the one before it.
      await say([{ kind: "draft", detail: "Autumn is here" }]);
      // Only the ai module says what a server step does.
      expect((await call(minh, "POST", `/internal/runs/${b.runId}/activity`, { step: b.step, events: [{ kind: "say", text: "hi" }] })).status).toBe(403);
      const run = (await call(minh, "GET", `/tasks/${taskId}/runs`)).body.runs[0];
      const events = (await call(minh, "GET", `/runs/${b.runId}/activity?step=${b.step}`)).body.events as { kind: string; detail?: string }[];
      seen.push({ doing: run.doing, kinds: events.map((e) => e.kind), draft: events.find((e) => e.kind === "draft")?.detail });
    };
    try {
      const wf = await workflowOf([AI("Draft"), AI("Polish")]);
      const task = await taskOn(minh, wf.id);
      taskId = task.id;
      script = ["A draft.", new Error("model down")];
      await call(minh, "POST", `/tasks/${task.id}/runs`);
      const run = await settled(minh, task.id);
      expect(run.status).toBe("failed");
      expect(asked.at(-2)).toMatchObject({ runId: run.id, step: 0 });
      expect(seen[0]).toMatchObject({ doing: { kind: "draft" }, kinds: ["start", "tool", "result", "draft"], draft: "Autumn is here" });
      // Once the step has its result the draft is gone; a step that failed says why.
      const first = (await call(minh, "GET", `/runs/${run.id}/activity?step=0`)).body.events as { kind: string }[];
      expect(first.map((e) => e.kind)).toEqual(["start", "tool", "result"]);
      const second = (await call(minh, "GET", `/runs/${run.id}/activity?step=1`)).body.events as { kind: string; text: string }[];
      expect(second.at(-1)).toMatchObject({ kind: "error", text: "the AI step failed" });
      expect(run.doing).toBeUndefined();
      // Lines for a step that is no longer at work are dropped; someone who cannot read the task reads none of it.
      expect((await call(aiModule, "POST", `/internal/runs/${run.id}/activity`, { step: 0, events: [{ kind: "say", text: "late" }] })).body).toEqual({ ok: false });
      expect((await call(huy, "GET", `/runs/${run.id}/activity?step=0`)).status).toBeGreaterThanOrEqual(403);
      // The run's timeline: every step's lines in the order they happened, paged by the last id, never a draft.
      const all = (await call(minh, "GET", `/runs/${run.id}/timeline`)).body as { events: { id: number; step: number; kind: string }[]; more: boolean };
      expect(all.events.map((e) => [e.step, e.kind])).toEqual([
        [0, "start"],
        [0, "tool"],
        [0, "result"],
        [1, "start"],
        [1, "tool"],
        [1, "result"],
        [1, "error"],
      ]);
      expect(all.more).toBe(false);
      expect((await call(minh, "GET", `/runs/${run.id}/timeline?after=${all.events[2]!.id}`)).body.events.map((e: { step: number }) => e.step)).toEqual([1, 1, 1, 1]);
      expect((await call(huy, "GET", `/runs/${run.id}/timeline`)).status).toBeGreaterThanOrEqual(403);
    } finally {
      during = null;
    }
  });
});

describe("who approves", () => {
  it("the step names who may let the run go on", async () => {
    script = ["DRAFT"];
    const wf = await workflowOf([AI("Draft"), { title: "Sign-off", kind: "approval", approver: "owner" }, AI("Send", "{{previous}}")]);
    // Minh owns the task, Lan does the work and starts the run.
    const task = (await call(minh, "POST", "/tasks", { title: "Quote", assigneeId: "lan" })).body;
    await call(minh, "PUT", `/tasks/${task.id}/workflow`, { workflowId: wf.id });
    expect((await call(lan, "POST", `/tasks/${task.id}/runs`)).status).toBe(201);
    const run = await settled(lan, task.id);
    expect(run).toMatchObject({ status: "waiting_approval", canApprove: false });
    expect((await call(lan, "POST", `/runs/${run.id}/approve`, { note: "" })).status).toBe(403);
    expect((await call(lan, "POST", `/runs/${run.id}/rework`, { note: "shorter" })).status).toBe(403);
    // It waits for the owner, and only the owner is told.
    expect((await call(lan, "GET", "/agent-questions/open")).body.approvals.filter((a: { runId: string }) => a.runId === run.id)).toHaveLength(0);
    expect((await call(minh, "GET", "/agent-questions/open")).body.approvals.filter((a: { runId: string }) => a.runId === run.id)).toHaveLength(1);
    expect((await call(minh, "GET", `/tasks/${task.id}/runs`)).body.runs[0].canApprove).toBe(true);
    script = ["SENT"];
    expect((await call(minh, "POST", `/runs/${run.id}/approve`, { note: "ok, send it" })).status).toBe(201);
    expect((await settled(minh, task.id)).status).toBe("done");
    expect(last().prompt).toContain("DRAFT\n\nNote from the approver:\nok, send it");
    // One run by its id (the API and the MCP tools follow a run this way), with what the reader may do on it; and
    // what an integration is told: the run waits for a person, then it ends.
    expect((await call(minh, "GET", `/runs/${run.id}`)).body).toMatchObject({ id: run.id, status: "done", canApprove: false, asks: [] });
    expect((await call(huy, "GET", `/runs/${run.id}`)).status).toBeGreaterThanOrEqual(403);
    const events = (
      await pool.query<{ type: string; payload: Record<string, unknown> }>("SELECT type, payload->'payload' AS payload FROM outbox WHERE aggregateid = $1 ORDER BY created_at", [
        run.id,
      ])
    ).rows;
    // "decided": the wait for approval closed (home settles the notices that asked for it).
    expect(events.map((e) => e.type)).toEqual(["work.run.started.v1", "work.run.waiting.v1", "work.run.decided.v1", "work.run.finished.v1"]);
    expect(events[1]!.payload).toMatchObject({ reason: "approval", step: "Sign-off", code: task.code });
    expect(events[2]!.payload).toMatchObject({ outcome: "approved" });
    expect(events[3]!.payload).toMatchObject({ status: "done", error: null });
  });

  it("a run that fails says so to whoever listens, with the reason", async () => {
    script = [new Error("model down")];
    const { run } = await ran(minh, [AI("Draft")]);
    expect(run.status).toBe("failed");
    const finished = (
      await pool.query<{ payload: Record<string, unknown> }>("SELECT payload->'payload' AS payload FROM outbox WHERE type = 'work.run.finished.v1' AND aggregateid = $1", [run.id])
    ).rows;
    expect(finished).toHaveLength(1);
    expect(finished[0]!.payload).toMatchObject({ status: "failed", error: "the AI step failed" });
  });
});

describe("what a finished run delivers", () => {
  it("a comment, a page, subtasks from the checklist and the task's status", async () => {
    script = ["# Onboarding plan\n\nWelcome.\n\n- [ ] Order the laptop\n- [ ] Book the intro call\n- [x] Sign the contract"];
    const { run, task } = await ran(minh, [AI("Plan")], { output: { comment: true, doc: true, subtasks: true, status: "review" } });
    expect(run.status).toBe("done");
    expect(run.error).toBeNull();
    const page = run.artifacts.find((a: { kind: string }) => a.kind === "doc");
    expect(page).toMatchObject({ name: "Onboarding plan" });
    expect(run.artifacts.find((a: { kind: string }) => a.kind === "subtasks")).toMatchObject({ count: 2 });
    const doc = (await call(minh, "GET", `/docs/${page.id}`)).body;
    expect(JSON.stringify(doc)).toContain("Order the laptop");
    expect((await pool.query("SELECT status FROM tasks WHERE id = $1", [task.id])).rows[0].status).toBe("review");
    const subs = (await pool.query("SELECT title FROM tasks WHERE parent_id = $1 ORDER BY title", [task.id])).rows.map((r) => r.title);
    expect(subs).toEqual(["Book the intro call", "Order the laptop"]);
    const comment = (await pool.query("SELECT body, agent FROM task_comments WHERE task_id = $1", [task.id])).rows[0];
    expect(comment.agent).toMatch(/^WF /);
    expect(comment.body).toContain(`](/app/work/docs/${page.id})`);
  });

  it("a delivery that fails is noted; the run is still done and the rest is delivered", async () => {
    script = ["RESULT"];
    // Lan may not move this task to done... she can; so make the page fail instead: no document.create.
    const noDocs = mk(
      "no-docs",
      EMPLOYEE.filter((g) => g.permission !== "document.create"),
    );
    people["no-docs"] = noDocs;
    const { run, task } = await ran(noDocs, [AI("Draft")], { output: { comment: true, doc: true } });
    expect(run.status).toBe("done");
    expect(run.error).toMatch(/^could not save the page: /);
    expect((await pool.query("SELECT body FROM task_comments WHERE task_id = $1", [task.id])).rows[0].body).toBe("RESULT");
  });

  it("a workflow set to start by itself runs as soon as it is put on a task", async () => {
    script = ["AUTO"];
    const wf = await workflowOf([AI("Draft")], { autoStart: true });
    const task = (await call(lan, "POST", "/tasks", { title: "Auto", assigneeId: "lan" })).body;
    const set = (await call(lan, "PUT", `/tasks/${task.id}/workflow`, { workflowId: wf.id })).body;
    expect(set.run).toMatchObject({ status: "queued", startedBy: "lan" });
    expect((await settled(lan, task.id)).status).toBe("done");
    // Not when it would have to ask the person something first.
    const asks = await workflowOf([AI("Draft")], { autoStart: true, inputs: [{ label: "Audience", type: "text", required: true }] });
    const other = (await call(lan, "POST", "/tasks", { title: "Needs input", assigneeId: "lan" })).body;
    expect((await call(lan, "PUT", `/tasks/${other.id}/workflow`, { workflowId: asks.id })).body.run).toBeNull();
  });
});

describe("a run survives a restart", () => {
  it("a server run nobody drives is picked up again as the person who started it", async () => {
    const wf = await workflowOf([AI("One"), AI("Two", "After:\n{{previous}}")]);
    const task = await taskOn(lan, wf.id);
    const id = newId();
    // As the process left it: step one done, step two in flight, nobody driving.
    const steps = [
      { key: "one", title: "One", kind: "ai", prompt: "{{task}}", state: "done", output: "ONE" },
      { key: "two", title: "Two", kind: "ai", prompt: "After:\n{{previous}}", state: "running", history: [{ at: new Date().toISOString(), kind: "attempt" }] },
    ];
    await pool.query(
      `INSERT INTO task_agent_runs (id, task_id, workflow_id, workflow_name, runner, status, current_step, steps, started_by, updated_at)
       VALUES ($1, $2, $3, 'Restarted', 'server', 'running', 1, $4, 'lan', now() - interval '5 minutes')`,
      [id, task.id, wf.id, JSON.stringify(steps)],
    );
    asked.length = 0;
    script = ["TWO"];
    const engine = { pool, ai, storage: null, resolve: async (u: string) => people[u]! };
    expect(await resumeServerRuns(engine)).toBeGreaterThanOrEqual(1);
    const run = await settled(lan, task.id);
    expect(run).toMatchObject({ id, status: "done" });
    expect(asked[0]!.prompt).toContain("After:\nONE");
    expect(run.steps[1].history.map((h: { outcome?: string }) => h.outcome)).toEqual(["cancelled", "done"]);
  });
});

// ── Runners ──────────────────────────────────────────────────────────────────────────────────────────

const runner = (p: Principal, device: string, more: Record<string, unknown> = {}) =>
  call(p, "POST", "/runner/claim", { device, protocol: 2, agent: "claude -p", os: "darwin", version: "2", ...more });
const rr = (p: Principal, id: string, path: string, body?: unknown) => call(p, "POST", `/runner/runs/${id}/${path}`, body);

describe("a run on a runner", () => {
  it("a sandbox run: prepare, steps one at a time, a command check that sends work back, files handed back", async () => {
    const wf = await workflowOf(
      [
        AI("Write the script", "Write analysis.py.\n\n{{task}}", { model: "sonnet", role: "A data analyst." }),
        { title: "Run it", kind: "check", command: "python analysis.py", attempts: 1 },
        { title: "Export", kind: "command", command: "ls ../out" },
        { title: "Approve", kind: "approval" },
      ],
      {
        environment: { kind: "sandbox", host: "person", isolation: "container", image: "python:3.12-slim", network: "off", setup: "pip install pandas" },
        resources: { taskFiles: true },
        output: { files: true, comment: true },
      },
    );
    const task = await taskOn(lan, wf.id);
    // A sandbox on a person's runner: whoever starts it runs it on their own computer.
    expect((await call(lan, "POST", `/tasks/${task.id}/runs`)).status).toBe(201);
    expect((await runner(huy, "huy-mac", { docker: true })).body.next).toBeNull();
    const claim = (await runner(lan, "lan-mac", { docker: true })).body.next;
    expect(claim).toMatchObject({
      run: { taskCode: task.code, taskTitle: "Launch post" },
      environment: { kind: "sandbox", isolation: "container", image: "python:3.12-slim", network: "off", setup: "pip install pandas" },
      resumed: false,
      collect: true,
    });
    const id = claim.run.id as string;
    // The runner is listed for its owner, with what it can do.
    const mine = (await call(lan, "GET", "/workflows")).body.runners.find((x: { device: string }) => x.device === "lan-mac");
    expect(mine).toMatchObject({ mine: true, online: true, docker: true, shared: false, agent: "claude -p" });
    expect((await call(huy, "GET", "/workflows")).body.runners.find((x: { device: string }) => x.device === "lan-mac")).toBeUndefined();

    expect((await rr(huy, id, "next")).status).toBe(403);
    expect((await rr(lan, id, "env", { state: "preparing", log: "starting a container from python:3.12-slim\n" })).body.status).toBe("running");
    expect(
      (await rr(lan, id, "env", { state: "ready", isolation: "container", image: "python:3.12-slim", network: "off", agentIn: "host", assets: 0, log: "$ pip install pandas\n" }))
        .body.status,
    ).toBe("running");
    let view = (await call(lan, "GET", `/tasks/${task.id}/runs`)).body.runs[0];
    expect(view.env).toMatchObject({ state: "ready", device: "lan-mac", isolation: "container", network: "off", agentIn: "host" });
    expect(view.env.log).toContain("pip install pandas");

    // Step 1: the whole instruction comes from the server, role first, with where the files are.
    const one = (await rr(lan, id, "next")).body.step;
    expect(one).toMatchObject({ index: 0, key: "write-the-script", kind: "ai", model: "sonnet", timeoutMin: 10 });
    expect(one.input).toMatch(/^Your role for this step:\nA data analyst\./);
    expect(one.input).toContain("{{assets_dir}}");
    expect(one.input).toContain("{{out_dir}}");
    expect((await rr(lan, id, "step", { index: 0, state: "log", log: "thinking…", model: "sonnet" })).body.status).toBe("running");
    expect((await rr(lan, id, "step", { index: 0, state: "done", output: "wrote analysis.py" })).body.status).toBe("running");
    // Step 2: a command check. It fails: the work goes back to the AI step with the end of the output.
    const two = (await rr(lan, id, "next")).body.step;
    expect(two).toMatchObject({ index: 1, kind: "check", command: "python analysis.py" });
    expect(two.input).toBeUndefined();
    expect((await rr(lan, id, "step", { index: 1, state: "failed", output: "KeyError: 'revenue'", exitCode: 1 })).body.status).toBe("running");
    const redo = (await rr(lan, id, "next")).body.step;
    expect(redo.index).toBe(0);
    expect(redo.input).toContain("The command exited with 1.\n\nKeyError: 'revenue'");
    await rr(lan, id, "step", { index: 0, state: "done", output: "fixed analysis.py", model: "sonnet" });
    expect((await rr(lan, id, "next")).body.step.index).toBe(1);
    expect((await rr(lan, id, "step", { index: 1, state: "done", output: "ok", exitCode: 0 })).body.status).toBe("running");
    // A report for a step that is not in progress is refused.
    expect((await rr(lan, id, "step", { index: 1, state: "done", output: "again" })).status).toBe(400);
    // Step 3: a command; then the approval parks the run and the runner lets go.
    expect((await rr(lan, id, "next")).body.step).toMatchObject({ index: 2, kind: "command", command: "ls ../out" });
    await rr(lan, id, "step", { index: 2, state: "done", output: "report.csv" });
    expect((await rr(lan, id, "next")).body).toEqual({ status: "waiting_approval" });
    expect((await runner(lan, "lan-mac", { docker: true })).body.next).toBeNull();
    expect((await call(lan, "POST", `/runs/${id}/approve`, { note: "" })).body.status).toBe("queued");
    // Only the computer that holds the sandbox takes it back.
    expect((await runner(lan, "other-laptop", { docker: true })).body.next).toBeNull();
    expect((await runner(lan, "lan-mac", { docker: true })).body.next).toMatchObject({ run: { id }, resumed: true, assets: [] });

    // Nothing left to run: first the files of the out folder, then the run finishes.
    expect((await rr(lan, id, "next")).body).toEqual({ status: "running", collect: true });
    const csv = "month,revenue\n2026-10,120\n";
    const up = (await rr(lan, id, "artifacts", { name: "report.csv", contentType: "text/csv", size: csv.length })).body;
    expect((await fetch(up.uploadUrl, { method: "PUT", headers: { "content-type": "text/csv" }, body: csv })).ok).toBe(true);
    expect((await rr(lan, id, `artifacts/${up.fileId}/confirm`)).body).toEqual({ ok: true });
    // A program is refused like any upload.
    expect((await rr(lan, id, "artifacts", { name: "run.sh", contentType: "text/x-shellscript", size: 10 })).status).toBe(400);
    expect((await rr(lan, id, "collected", { log: "handed back report.csv\n" })).body.status).toBe("running");
    expect((await rr(lan, id, "next")).body).toEqual({ status: "done" });

    view = (await call(lan, "GET", `/tasks/${task.id}/runs`)).body.runs[0];
    expect(view).toMatchObject({ status: "done", artifacts: [{ kind: "file", id: up.fileId, name: "report.csv", size: csv.length }] });
    expect(view.steps[0]).toMatchObject({ rework: { by: "check", check: "Run it" }, ran: { model: "sonnet" }, output: "fixed analysis.py" });
    expect(view.steps[0].log).toContain("thinking…");
    expect(view.steps[1]).toMatchObject({ sentBack: 1, verdict: { pass: true, round: 2 } });
    // The file is on the task; the comment is the last result.
    expect((await pool.query("SELECT name FROM files WHERE attached_type = 'task' AND attached_id = $1 AND status = 'active'", [task.id])).rows).toEqual([{ name: "report.csv" }]);
    expect((await pool.query("SELECT body FROM task_comments WHERE task_id = $1", [task.id])).rows[0].body).toBe("report.csv");
  });

  it("downloads the workflow's files and the task's attachments into the run", async () => {
    const put = async (p: Principal, name: string, body: string, attachTo: { type: string; id: string }) => {
      const up = (await call(p, "POST", "/files/uploads", { name, contentType: "text/csv", size: body.length, attachTo })).body;
      await fetch(up.uploadUrl, { method: "PUT", headers: { "content-type": "text/csv" }, body });
      await call(p, "POST", `/files/${up.fileId}/confirm`);
      return up.fileId as string;
    };
    const ref = await put(minh, "price-list.csv", "plan,price\n", { type: "workflow", id: "draft" });
    const wf = await workflowOf([AI("Analyse")], {
      environment: { kind: "sandbox", isolation: "folder" },
      resources: { files: [{ id: ref, name: "price-list.csv", size: 11, contentType: "text/csv" }], taskFiles: true },
    });
    const task = await taskOn(lan, wf.id);
    await put(lan, "sales.csv", "month,revenue\n", { type: "task", id: task.id });
    await call(lan, "POST", `/tasks/${task.id}/runs`);
    const claim = (await runner(lan, "lan-mac")).body.next;
    expect(claim.assets.map((a: { name: string; from: string }) => `${a.from}:${a.name}`)).toEqual(["workflow:price-list.csv", "task:sales.csv"]);
    expect(await (await fetch(claim.assets[1].url)).text()).toBe("month,revenue\n");
    await rr(lan, claim.run.id, "env", { state: "ready", isolation: "folder", assets: 2 });
    // The agent is told the price list is among its files (its text is also in the reference block).
    const step = (await rr(lan, claim.run.id, "next")).body.step;
    expect(step.input).toContain("## File: price-list.csv\nplan,price");
    await call(lan, "POST", `/runs/${claim.run.id}/cancel`);
  });

  it("an environment that cannot be prepared fails the run and says why", async () => {
    const wf = await workflowOf([AI("Draft")], { environment: { kind: "sandbox", isolation: "container", image: "python:3.12-slim" } });
    const task = await taskOn(lan, wf.id);
    await call(lan, "POST", `/tasks/${task.id}/runs`);
    const claim = (await runner(lan, "lan-mac", { docker: false })).body.next;
    expect((await rr(lan, claim.run.id, "env", { state: "failed", log: "this workflow runs in a container, and Docker is not available on lan-mac." })).body.status).toBe("failed");
    const run = (await call(lan, "GET", `/tasks/${task.id}/runs`)).body.runs[0];
    expect(run.error).toMatch(/^the environment could not be prepared: this workflow runs in a container/);
    expect(run.env.state).toBe("failed");
  });

  it("on the assignee's own computer only the assignee starts it", async () => {
    const wf = await workflowOf([AI("Code"), { title: "Tests", kind: "command", command: "npm test", retries: 1 }], { environment: { kind: "computer" } });
    const task = (await call(minh, "POST", "/tasks", { title: "Fix", assigneeId: "lan" })).body;
    await call(minh, "PUT", `/tasks/${task.id}/workflow`, { workflowId: wf.id });
    expect((await call(minh, "POST", `/tasks/${task.id}/runs`)).status).toBe(403);
    expect((await call(lan, "POST", `/tasks/${task.id}/runs`)).status).toBe(201);
    const id = (await runner(lan, "lan-mac")).body.next.run.id;
    await rr(lan, id, "env", { state: "ready", isolation: "computer" });
    await rr(lan, id, "next");
    await rr(lan, id, "step", { index: 0, state: "done", output: "coded" });
    // A command that fails is run again while it has retries, then fails the run with the end of its output.
    expect((await rr(lan, id, "next")).body.step.index).toBe(1);
    expect((await rr(lan, id, "step", { index: 1, state: "failed", output: "1 failing", exitCode: 1 })).body.status).toBe("running");
    expect((await rr(lan, id, "next")).body.step.index).toBe(1);
    expect((await rr(lan, id, "step", { index: 1, state: "failed", output: "1 failing", exitCode: 1, timeout: true })).body.status).toBe("failed");
    const run = (await call(lan, "GET", `/tasks/${task.id}/runs`)).body.runs[0];
    expect(run.error).toBe('step "Tests" ran out of time');
    expect(run.steps[1].history.map((h: { kind: string; outcome?: string }) => `${h.kind}:${h.outcome ?? ""}`)).toEqual(["attempt:failed", "retry:", "attempt:timeout"]);
  });
});

describe("a company runner", () => {
  it("takes sandbox runs anyone starts, acting for the person who started them", async () => {
    const wf = await workflowOf([AI("Report"), { title: "To review", kind: "status", status: "review" }], {
      environment: { kind: "sandbox", host: "company", isolation: "container", image: "python:3.12-slim" },
    });
    const task = await taskOn(lan, wf.id);
    expect((await call(lan, "POST", `/tasks/${task.id}/runs`)).status).toBe(201);
    // Lan's own computer does not take it; nor does someone who may not run the company's agents, whatever they send.
    expect((await runner(lan, "lan-mac", { docker: true })).body.next).toBeNull();
    expect((await runner(huy, "huy-mac", { docker: true, shared: true })).body.next).toBeNull();
    // A company runner without Docker leaves a container run for one that has it.
    expect((await runner(minh, "office-nuc", { shared: true, docker: false })).body.next).toBeNull();
    const claim = (await runner(minh, "office-box", { shared: true, docker: true })).body.next;
    expect(claim.run.taskCode).toBe(task.code);
    const id = claim.run.id as string;
    // Everyone sees the company's runner.
    expect((await call(huy, "GET", "/workflows")).body.runners.find((x: { device: string }) => x.device === "office-box")).toMatchObject({
      shared: true,
      mine: false,
      online: true,
      docker: true,
    });
    await rr(minh, id, "env", { state: "ready", isolation: "container", image: "python:3.12-slim", network: "on", agentIn: "host" });
    expect((await rr(minh, id, "next")).body.step.index).toBe(0);
    await rr(minh, id, "step", { index: 0, state: "done", output: "REPORT" });
    expect((await rr(minh, id, "next")).body).toEqual({ status: "done" });
    // The task moved and the result was posted as Lan, who started it, not as the runner's owner.
    expect((await pool.query("SELECT status FROM tasks WHERE id = $1", [task.id])).rows[0].status).toBe("review");
    expect((await pool.query("SELECT author_id, body FROM task_comments WHERE task_id = $1", [task.id])).rows[0]).toEqual({ author_id: "lan", body: "REPORT" });
  });
});

describe("a runner that goes away", () => {
  it("gives the run back to the queue twice, then the run fails and says so", async () => {
    const wf = await workflowOf([AI("Draft")], { environment: { kind: "sandbox", isolation: "folder" } });
    const task = await taskOn(lan, wf.id);
    await call(lan, "POST", `/tasks/${task.id}/runs`);
    const silent = async () => {
      const id = (await runner(lan, "lan-mac")).body.next.run.id as string;
      await rr(lan, id, "env", { state: "ready", isolation: "folder" });
      await rr(lan, id, "next");
      await pool.query("UPDATE task_agent_runs SET heartbeat_at = now() - interval '10 minutes', updated_at = now() - interval '10 minutes' WHERE id = $1", [id]);
      await reclaimSilentRuns(pool);
      return (await call(lan, "GET", `/tasks/${task.id}/runs`)).body.runs[0];
    };
    const first = await silent();
    expect(first).toMatchObject({ status: "queued", claimedBy: null, env: null });
    expect(first.steps[0]).toMatchObject({ state: "pending" });
    expect(first.steps[0].history.map((h: { kind: string }) => h.kind)).toEqual(["attempt", "requeued"]);
    expect((await silent()).status).toBe("queued");
    const third = await silent();
    expect(third).toMatchObject({ status: "failed", error: "the runner (lan-mac) stopped answering" });
    // A runner that is alive is left alone: its status checks are its sign of life.
    await call(lan, "POST", `/runs/${third.id}/retry`);
    const id = (await runner(lan, "lan-mac")).body.next.run.id as string;
    await rr(lan, id, "env", { state: "ready", isolation: "folder" });
    await rr(lan, id, "next");
    await pool.query("UPDATE task_agent_runs SET heartbeat_at = now() - interval '10 minutes', updated_at = now() - interval '10 minutes' WHERE id = $1", [id]);
    expect((await call(lan, "GET", `/runner/runs/${id}`)).body.status).toBe("running");
    await reclaimSilentRuns(pool);
    expect((await call(lan, "GET", `/tasks/${task.id}/runs`)).body.runs[0].status).toBe("running");
  });
});
