import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { INestApplication } from "@nestjs/common";
import pg from "pg";
import { migrate, signInternalToken, PRINCIPAL_HEADER, S3Storage, type ServiceClient } from "@workspace/service-kit";
import { newId, type Grant, type Principal } from "@workspace/shared";
import { createWorkApp } from "../../src/modules/work/app.js";
import { resetTestDatabase } from "../test-db.js";

/**
 * The runner itself (frontend/web/public/runner/workspace-runner.mjs), run as a real process against this server: it
 * claims a sandbox run, prepares the folder (and a Docker container, when Docker is here and has the image), downloads
 * the assets, runs the steps the server hands it, hands back the files of the out folder and cleans up. A small proxy
 * stands in for the gateway: it turns the runner's API key into its owner's principal.
 */
const SECRET = "dev-internal-secret-change-me-32bytes!";
const T = (...ps: string[]): Grant[] => ps.map((permission) => ({ permission, scope: "WORKSPACE" }));
const lan: Principal = {
  type: "user",
  id: "lan",
  teamIds: [],
  departmentId: null,
  grants: T("project.read", "task.read", "task.create", "task.edit", "ai.use", "file.upload", "file.read", "ai.agent.manage"),
};
/** The key Connect this computer makes: a few task permissions only. The run still acts as the person who started it. */
const lanKey: Principal = { ...lan, grants: T("task.read", "task.edit", "project.read") };
const RUNNER = fileURLToPath(new URL("../../../../frontend/web/public/runner/workspace-runner.mjs", import.meta.url));
const IMAGE = "alpine:latest";
/** What the runner reports: a Docker daemon it can reach. */
const daemon = spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], { stdio: "ignore", timeout: 10_000 }).status === 0;
/** The container test also needs its image already pulled (no download in a test). */
const docker = daemon && spawnSync("docker", ["image", "inspect", IMAGE], { stdio: "ignore", timeout: 10_000 }).status === 0;

let app: INestApplication;
let base: string;
let pool: pg.Pool;
let proxy: Server;
let url: string;
let dir: string;
let agent: string;

async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json", [PRINCIPAL_HEADER]: await signInternalToken({ principal: lan, requestId: newId() }, SECRET) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const t = await res.text();
  return { status: res.status, body: t ? JSON.parse(t) : null };
}

/** Starts the runner, lets it work until the queue is empty (`--once`), and returns what it printed. */
function runRunner(extra: string[] = [], env: Record<string, string> = {}, key = "wos_test"): Promise<string> {
  return new Promise((done, fail) => {
    const child = spawn(
      process.execPath,
      [RUNNER, "--url", url, "--key", key, "--device", "test-box", "--dir", dir, "--sandbox-root", join(dir, "sandbox"), "--agent", agent, "--once", ...extra],
      {
        env: { ...process.env, WORKSPACE_AI_HOME: join(dir, "home"), SECRET_FROM_HOST: "s3cr3t", NOT_LISTED: "nope", ...env },
      },
    );
    let out = "";
    child.stdout.on("data", (b) => (out += b));
    child.stderr.on("data", (b) => (out += b));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      fail(new Error(`the runner did not finish:\n${out}`));
    }, 110_000);
    child.on("close", () => {
      clearTimeout(timer);
      done(out);
    });
  });
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
  const ai = { request: async () => ({ text: "unused" }) } as unknown as ServiceClient;
  app = await createWorkApp({ pool, storage, internalSecret: SECRET, ai, resolvePrincipal: async () => lan });
  await app.listen(0);
  base = (await app.getUrl()).replace("[::1]", "127.0.0.1");
  // The gateway's part: /api/work/* with a personal API key becomes a call as that person.
  proxy = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      void (async () => {
        const who = req.headers.authorization === "Bearer wos_test" ? lan : req.headers.authorization === "Bearer wos_narrow" ? lanKey : null;
        if (!who) return void res.writeHead(401).end("{}");
        const r = await fetch(`${base}${(req.url ?? "").replace(/^\/api\/work/, "")}`, {
          method: req.method ?? "GET",
          headers: { "content-type": "application/json", [PRINCIPAL_HEADER]: await signInternalToken({ principal: who, requestId: newId() }, SECRET) },
          ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
        });
        res.writeHead(r.status, { "content-type": "application/json" }).end(await r.text());
      })();
    });
  });
  await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
  dir = mkdtempSync(join(tmpdir(), "ws-runner-"));
  // The "agent": reads its instruction, writes a report next to the reference file it was told about, prints a result.
  const script = join(dir, "agent.mjs");
  writeFileSync(
    script,
    `import { readFileSync, writeFileSync, readdirSync } from "node:fs";
const input = readFileSync(0, "utf8");
if (input.includes("workspace-check")) { console.log('\`\`\`workspace-check\\n{"pass": true, "issues": []}\\n\`\`\`'); process.exit(0); }
const assets = /folder (\\S+) \\(read them/.exec(input)?.[1];
const out = /into the folder (\\S+);/.exec(input)?.[1];
const files = assets ? readdirSync(assets).sort() : [];
const fixed = input.includes("did not pass");
if (out) writeFileSync(out + "/report.md", "# Report\\n\\nfiles: " + files.join(", ") + (fixed ? "\\nfixed" : "") + "\\n");
// What it is doing, said the way any agent may (the runner's header): never part of the result.
if (process.env.WORKSPACE_ACTIVITY === "1") console.error('::workspace-activity:: ' + JSON.stringify({ kind: "tool", tool: "read", text: files.join(", ") }));
console.log("Report written from " + files.join(", ") + (fixed ? " (fixed)" : ""));
`,
  );
  agent = `"${process.execPath}" "${script}"`;
}, 60_000);

afterAll(async () => {
  await new Promise((r) => proxy?.close(r));
  await app?.close();
  await pool?.end();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

async function upload(name: string, body: string, attachTo: { type: string; id: string }) {
  const up = (await call("POST", "/files/uploads", { name, contentType: "text/csv", size: body.length, attachTo })).body;
  await fetch(up.uploadUrl, { method: "PUT", headers: { "content-type": "text/csv" }, body });
  await call("POST", `/files/${up.fileId}/confirm`);
  return up.fileId as string;
}

async function sandboxRun(environment: Record<string, unknown>, steps: Record<string, unknown>[], key = "wos_test") {
  const ref = await upload("price-list.csv", "plan,price\nTeam,29\n", { type: "workflow", id: "draft" });
  const wf = (
    await call("POST", "/workflows", {
      name: `Sandbox ${newId()}`,
      steps,
      config: {
        environment,
        resources: { files: [{ id: ref, name: "price-list.csv", size: 19, contentType: "text/csv" }], taskFiles: true, taskContext: false },
        guardrails: { ask: "never", stepMinutes: 2 },
        output: { files: true, comment: true },
      },
    })
  ).body;
  expect(wf.id, JSON.stringify(wf)).toBeTruthy();
  const task = (await call("POST", "/tasks", { title: "Monthly numbers", assigneeId: "lan" })).body;
  await upload("sales.csv", "month,revenue\n2026-10,120\n", { type: "task", id: task.id });
  await call("PUT", `/tasks/${task.id}/workflow`, { workflowId: wf.id });
  expect((await call("POST", `/tasks/${task.id}/runs`)).status).toBe(201);
  const printed = await runRunner([], {}, key);
  const run = (await call("GET", `/tasks/${task.id}/runs`)).body.runs[0];
  return { run, task, printed };
}

describe("the runner script", () => {
  it("runs a sandbox in a clean folder: assets in, steps, a failing check sent back, files handed back, folder removed", async () => {
    const { run, task, printed } = await sandboxRun({ kind: "sandbox", isolation: "folder", setup: "echo ready > setup.txt" }, [
      { title: "Analyse", kind: "ai", prompt: "Write the report.\n\n{{task}}" },
      // Fails the first time (the report has no "fixed" line yet), so the work goes back once.
      { title: "Report is fixed", kind: "check", command: "grep -q fixed ../out/report.md", attempts: 1 },
      { title: "List", kind: "command", command: "ls ../assets && cat setup.txt && echo task=$WORKSPACE_TASK" },
    ]);
    expect(run.status, `${run.error}\n${printed}`).toBe("done");
    expect(run.env).toMatchObject({ state: "ready", device: "test-box", isolation: "folder", assets: 2, collected: true });
    expect(run.env.log).toContain("$ echo ready > setup.txt");
    expect(run.env.log).toContain("handed back report.md");
    // The agent found both files where its instruction said, and the check sent its first result back.
    expect(run.steps[0]).toMatchObject({ state: "done", output: "Report written from price-list.csv, sales.csv (fixed)", rework: { by: "check" } });
    expect(run.steps[0].input).toContain("{{assets_dir}}");
    // What the agent said it was doing is the step's activity, attempt by attempt; a command's start is its command.
    const activity = (await call("GET", `/runs/${run.id}/activity?step=0`)).body.events as { id: number; kind: string; tool: string | null; text: string }[];
    expect(activity.map((e) => [e.kind, e.tool, e.text])).toEqual([
      ["start", null, ""],
      ["tool", "read", "price-list.csv, sales.csv"],
      ["start", null, ""],
      ["tool", "read", "price-list.csv, sales.csv"],
    ]);
    expect((await call("GET", `/runs/${run.id}/activity?step=0&after=${activity[2]!.id}`)).body.events).toHaveLength(1);
    expect((await call("GET", `/runs/${run.id}/activity?step=2`)).body.events[0]).toMatchObject({
      kind: "start",
      text: "$ ls ../assets && cat setup.txt && echo task=$WORKSPACE_TASK",
    });
    expect(run.steps[1]).toMatchObject({ state: "done", sentBack: 1, verdict: { pass: true, round: 2 } });
    expect(run.steps[2].output).toBe(`price-list.csv\nsales.csv\nready\ntask=${task.code}`);
    expect(run.artifacts).toMatchObject([{ kind: "file", name: "report.md" }]);
    const file = (await call("GET", `/files/${run.artifacts[0].id}/download`)).body;
    expect(await (await fetch(file.url)).text()).toBe("# Report\n\nfiles: price-list.csv, sales.csv\nfixed\n");
    // Nothing of the sandbox is left on the runner.
    expect(existsSync(join(dir, "sandbox", run.id))).toBe(false);
    expect(printed).toContain("✓ done");
    // The runner showed up as a connected computer.
    expect((await call("GET", "/workflows")).body.runners.find((r: { device: string }) => r.device === "test-box")).toMatchObject({ mine: true, docker: daemon });
  }, 120_000);

  it.skipIf(process.platform === "win32")(
    "follows Claude Code step by step: its actions are the step's activity, its last words the result",
    async () => {
      // A stand-in `claude` on the PATH that prints what the real one does with --output-format stream-json --verbose.
      const bin = join(dir, "bin");
      mkdirSync(bin, { recursive: true });
      writeFileSync(
        join(dir, "claude.mjs"),
        `import { readFileSync } from "node:fs";
readFileSync(0, "utf8");
if (!process.argv.includes("stream-json")) { console.log("plain answer"); process.exit(0); }
const cwd = process.cwd();
const say = (j) => console.log(JSON.stringify(j));
say({ type: "system", subtype: "init", cwd, model: "claude-test-1" });
say({ type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "text", text: "I will read the note first." }, { type: "tool_use", id: "t1", name: "Read", input: { file_path: cwd + "/note.txt" } }] } });
say({ type: "user", message: { content: [{ tool_use_id: "t1", type: "tool_result", content: "1\\thello\\n2\\tworld" }] } });
say({ type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "tool_use", id: "t2", name: "Bash", input: { command: "npm test" } }] } });
say({ type: "rate_limit_event" });
say({ type: "user", message: { content: [{ tool_use_id: "t2", type: "tool_result", content: "2 failed\\nsee log", is_error: true }] } });
say({ type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "text", text: "Tiếng Việt: xong." }] } });
say({ type: "result", subtype: "success", is_error: false, result: "The note says hello.", num_turns: 3, duration_ms: 4200 });
`,
      );
      writeFileSync(join(bin, "claude"), `#!/bin/sh\nexec "${process.execPath}" "${join(dir, "claude.mjs")}" "$@"\n`);
      chmodSync(join(bin, "claude"), 0o755);
      const wf = (
        await call("POST", "/workflows", {
          name: `Claude ${newId()}`,
          steps: [{ title: "Work", kind: "ai", prompt: "Do it.\n\n{{task}}" }],
          config: { environment: { kind: "sandbox", isolation: "folder" }, guardrails: { ask: "never", stepMinutes: 2 } },
        })
      ).body;
      const task = (await call("POST", "/tasks", { title: "Follow", assigneeId: "lan" })).body;
      await call("PUT", `/tasks/${task.id}/workflow`, { workflowId: wf.id });
      await call("POST", `/tasks/${task.id}/runs`);
      const printed = await runRunner(["--agent", "claude -p"], { PATH: `${bin}:${process.env.PATH}` });
      const run = (await call("GET", `/tasks/${task.id}/runs`)).body.runs[0];
      expect(run.status, `${run.error}\n${printed}`).toBe("done");
      // The result is what the agent said last, not the JSON it printed; the model is the one that answered.
      expect(run.steps[0]).toMatchObject({ state: "done", output: "The note says hello.", ran: { model: "claude-test-1" } });
      expect(run.steps[0].log ?? "").toBe("");
      const events = (await call("GET", `/runs/${run.id}/activity?step=0`)).body.events as { kind: string; tool: string | null; text: string; detail?: string }[];
      expect(events.map((e) => [e.kind, e.tool, e.text])).toEqual([
        ["start", null, ""],
        ["say", null, "I will read the note first."],
        ["tool", "Read", "note.txt"],
        // A file's content stays on the runner: only how much was read.
        ["result", "Read", "2 lines"],
        ["tool", "Bash", "npm test"],
        ["error", "Bash", "2 failed"],
        ["say", null, "Tiếng Việt: xong."],
        ["note", null, "3 turns · 4s"],
      ]);
      expect(events[5]!.detail).toBe("2 failed\nsee log");
      expect(printed).toContain("· Read note.txt");
    },
    120_000,
  );

  it("with the narrow key of Connect this computer: downloads the task's files and hands back its own, as the person", async () => {
    const { run, printed } = await sandboxRun(
      { kind: "sandbox", isolation: "folder" },
      [
        { title: "Analyse", kind: "ai", prompt: "Write the report.\n\n{{task}}" },
        { title: "List", kind: "command", command: "ls ../assets" },
      ],
      "wos_narrow",
    );
    expect(run.status, `${run.error}\n${printed}`).toBe("done");
    expect(run.env).toMatchObject({ assets: 2, collected: true });
    expect(run.steps[1].output).toBe("price-list.csv\nsales.csv");
    expect(run.artifacts).toMatchObject([{ kind: "file", name: "report.md" }]);
    // Uploaded as the person who started the run.
    expect((await pool.query("SELECT owner_id FROM files WHERE id = $1", [run.artifacts[0].id])).rows[0].owner_id).toBe("lan");
  }, 120_000);

  it("a file that cannot be handed back fails the run with what and why; what did arrive stays on the task", async () => {
    const { run, task, printed } = await sandboxRun({ kind: "sandbox", isolation: "folder" }, [
      { title: "Analyse", kind: "ai", prompt: "Write the report.\n\n{{task}}" },
      { title: "A script too", kind: "command", command: "echo 'echo hi' > ../out/tool.sh && : > ../out/empty.txt" },
    ]);
    expect(run.status, printed).toBe("failed");
    expect(run.error).toMatch(/^1 file of the out folder could not be handed back: tool\.sh \(/);
    // The empty file is nothing lost; the report did arrive.
    expect(run.error).not.toContain("empty.txt");
    expect(run.artifacts).toMatchObject([{ kind: "file", name: "report.md" }]);
    expect((await pool.query("SELECT name FROM files WHERE attached_type = 'task' AND attached_id = $1 AND name = 'report.md'", [task.id])).rowCount).toBe(1);
    expect(existsSync(join(dir, "sandbox", run.id))).toBe(false);
  }, 120_000);

  it("ends a step's process at once when the run is stopped in the workspace", async () => {
    const wf = (
      await call("POST", "/workflows", {
        name: `Slow ${newId()}`,
        steps: [{ title: "Sleep", kind: "command", command: "sleep 120", timeoutMin: 1 }],
        config: { environment: { kind: "sandbox", isolation: "folder" } },
      })
    ).body;
    const task = (await call("POST", "/tasks", { title: "Slow", assigneeId: "lan" })).body;
    await call("PUT", `/tasks/${task.id}/workflow`, { workflowId: wf.id });
    await call("POST", `/tasks/${task.id}/runs`);
    // A two-minute sleep: stopped from the workspace after a moment, the runner must end it and clean up.
    const done = runRunner();
    let id = "";
    for (let i = 0; i < 100 && !id; i++) {
      await new Promise((r) => setTimeout(r, 200));
      const r = (await call("GET", `/tasks/${task.id}/runs`)).body.runs[0];
      if (r.steps[0].state === "running") id = r.id;
    }
    expect(id).toBeTruthy();
    await call("POST", `/runs/${id}/cancel`);
    const printed = await done;
    expect(printed).toContain("■ stopped in the workspace");
    expect(existsSync(join(dir, "sandbox", id))).toBe(false);
  }, 120_000);

  it.runIf(docker)(
    "runs a sandbox in a container: no network, only the variables the workflow lists, assets read-only",
    async () => {
      const { run, printed } = await sandboxRun(
        { kind: "sandbox", isolation: "container", image: IMAGE, network: "off", memoryMb: 256, cpus: 1, env: ["SECRET_FROM_HOST"], setup: "id -u > /setup-uid && echo installed" },
        [
          { title: "Analyse", kind: "ai", prompt: "Write the report.\n\n{{task}}" },
          {
            title: "Inside",
            kind: "command",
            command:
              'echo "os=$(. /etc/os-release; echo $ID) pwd=$(pwd) secret=$SECRET_FROM_HOST other=${NOT_LISTED:-unset}"; ls /run/assets; (touch /run/assets/x 2>/dev/null && echo writable || echo read-only); (wget -q -T 3 -O- http://example.com >/dev/null 2>&1 && echo online || echo offline); echo "from the container" > ../out/inside.txt',
          },
          // The setup ran as root (it could write to /); the steps run as this computer's user and cannot.
          {
            title: "Who",
            kind: "command",
            command: 'echo "setup=$(cat /setup-uid) step=$(id -u) root=$( (touch /etc/x 2>/dev/null && echo yes) || echo no) home=$HOME" > ../out/who.txt; cat ../out/who.txt',
          },
        ],
      );
      expect(run.status, `${run.error}\n${printed}`).toBe("done");
      expect(run.env).toMatchObject({ state: "ready", isolation: "container", image: IMAGE, network: "off", agentIn: "host", assets: 2 });
      expect(run.steps[1].output).toBe("os=alpine pwd=/run/work secret=s3cr3t other=unset\nprice-list.csv\nsales.csv\nread-only\noffline");
      expect(run.artifacts.map((a: { name: string }) => a.name).sort()).toEqual(["inside.txt", "report.md", "who.txt"]);
      const uid = typeof process.getuid === "function" && process.getuid() !== 0 ? process.getuid() : 1000;
      expect(run.steps[2].output).toBe(`setup=0 step=${uid} root=no home=/tmp`);
      // The container is gone with the run.
      expect(spawnSync("docker", ["inspect", `workspace-run-${String(run.id).toLowerCase()}`], { stdio: "ignore" }).status).not.toBe(0);
    },
    120_000,
  );

  it("never runs a container workflow without a container", async () => {
    const wf = (
      await call("POST", "/workflows", {
        name: `No image ${newId()}`,
        steps: [{ title: "Hello", kind: "command", command: "echo hello" }],
        config: { environment: { kind: "sandbox", isolation: "container", image: "workspace-test/does-not-exist:0" } },
      })
    ).body;
    const task = (await call("POST", "/tasks", { title: "No image", assigneeId: "lan" })).body;
    await call("PUT", `/tasks/${task.id}/workflow`, { workflowId: wf.id });
    await call("POST", `/tasks/${task.id}/runs`);
    await runRunner();
    const run = (await call("GET", `/tasks/${task.id}/runs`)).body.runs[0];
    expect(run.status).toBe("failed");
    expect(run.error).toMatch(/^the environment could not be prepared: /);
    expect(run.steps[0].state).not.toBe("done");
    expect(existsSync(join(dir, "sandbox", run.id))).toBe(false);
  }, 120_000);
});
