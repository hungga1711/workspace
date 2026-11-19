#!/usr/bin/env node
/**
 * workspace runner: runs a task's agent workflow on this computer.
 *
 *   node workspace-runner.mjs --url https://work.your-company.example --key wos_… [--dir ~/code/repo] [--agent "claude -p"]
 *
 * It signs in with your personal API key (Me › Sign-in & security), asks the workspace every few seconds for a run it
 * may take, prepares the run's environment, and then does what the workspace hands it, one step at a time. The
 * workspace writes every instruction and decides what comes next (a check that fails sends the work back, an approval
 * parks the run); this program only prepares, executes and reports.
 *
 * Where the steps run is set on the workflow:
 *
 *   computer   in --dir (your own working folder), with your coding agent, your tools and your credentials.
 *              Only runs you started yourself with Run on a task.
 *   sandbox    in a fresh folder made for the run under --sandbox-root (default ~/.workspace-ai/sandbox/<run>):
 *                work/     the working folder of every step (the workflow's repository is cloned here, if it has one)
 *                assets/   the workflow's reference files and, when it asks for them, the task's attachments
 *                out/      what the run hands back: every file here is attached to the task when the run ends
 *              With isolation "container" the steps run inside a Docker container (the workflow's image, with or
 *              without a network, with CPU and memory limits); the folder is mounted at /run, assets read-only. A
 *              workflow that asks for a container is never run without one: no Docker here, the run fails and says so.
 *              AI steps run with this computer's agent in the folder, or inside the container when the workflow names
 *              the agent's command in its image.
 *
 * A company runner (--shared, with the key of someone who manages the company's AI agents) also takes sandbox runs that
 * anyone starts on workflows set to "the company's runner", so people need nothing on their own computer.
 *
 * Steps:
 *   ai        the instruction goes to the agent on stdin (default: Claude Code in print mode, `claude -p`)
 *   command   runs in a shell; a non-zero exit fails the step
 *   check     a command (its exit code is the verdict) or an instruction for the agent to judge the last result
 * Questions, approvals, pause, continue and stop happen in the workspace. While a step runs this program asks the
 * workspace every few seconds whether the run was stopped (the step's process is ended at once) and tells it that it
 * is still alive; a step over its time limit is ended and reported as timed out.
 *
 * What the agent does inside a step is shown in the workspace as it happens. Claude Code says it by itself (it is
 * run with `--output-format stream-json`: every file it reads, command it runs and word it writes becomes a line).
 * Any other agent may say it on stderr, one line per action:
 *   ::workspace-activity:: {"kind":"tool","tool":"search","text":"overdue invoices"}
 * with kind `tool` (an action), `say` (its own words), `result`, `error` or `note`; optional `detail` for more text.
 * WORKSPACE_ACTIVITY=1 in the agent's environment tells it somebody is watching.
 *
 * Node 22+, no dependencies.
 */
import { spawn, spawnSync } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir, hostname, platform, tmpdir } from "node:os";
import { basename, extname, join, relative, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const VERSION = "3";
const PROTOCOL = 2;
const args = Object.fromEntries(
  process.argv
    .slice(2)
    .reduce((acc, a, i, all) => (a.startsWith("--") ? [...acc, [a.slice(2), all[i + 1] === undefined || all[i + 1].startsWith("--") ? "true" : all[i + 1]]] : acc), []),
);
const tilde = (p) => p.replace(/^~(?=$|\/)/, homedir());
const URL_ = (args.url ?? process.env.WORKSPACE_URL ?? "").replace(/\/$/, "");
const KEY = args.key ?? process.env.WORKSPACE_KEY ?? "";
const DIR = resolve(tilde(args.dir ?? process.cwd()));
const AGENT = args.agent ?? process.env.WORKSPACE_AGENT ?? "claude -p";
const DEVICE = args.device ?? hostname();
const EVERY = Number(args.every ?? 5) * 1000;
const SHARED = args.shared === "true" || process.env.WORKSPACE_SHARED === "1";
const HOME = process.env.WORKSPACE_AI_HOME || join(homedir(), ".workspace-ai");
const SANDBOX_ROOT = resolve(tilde(args["sandbox-root"] ?? process.env.WORKSPACE_SANDBOX_ROOT ?? join(HOME, "sandbox")));
const ONCE = args.once === "true";
/** How often a running step checks whether the run was stopped (also the runner's sign of life). */
const CHECK_EVERY = 4000;
const WIN = platform() === "win32";

if (!URL_ || !KEY.startsWith("wos_")) {
  console.error('usage: node workspace-runner.mjs --url <the address you open workspace at> --key wos_… [--dir <folder>] [--agent "claude -p"] [--shared]');
  process.exit(2);
}

const api = async (method, path, body) => {
  const r = await fetch(`${URL_}/api/work${path}`, {
    method,
    headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(60_000),
  });
  if (!r.ok) throw await failure(`${method} ${path}`, r);
  const text = await r.text();
  return text ? JSON.parse(text) : null;
};

/** A failed call in words a person can act on, never a page of HTML. */
async function failure(what, r) {
  const text = await r.text().catch(() => "");
  if (/^\s*</.test(text) || (r.headers.get("content-type") ?? "").includes("text/html"))
    return new Error(
      `${what}: ${URL_} answered with a web page (HTTP ${r.status}), not workspace. Use the address you open workspace at in the browser, ` +
        "and check that this workspace is up to date (older installs need the API address from Admin › Integrations).",
    );
  if (r.status === 401 || r.status === 403) return new Error(`${what}: the key was refused (HTTP ${r.status}). Create a new personal API key in Me › Sign-in & security.`);
  let msg = text.slice(0, 300);
  try {
    const j = JSON.parse(text);
    msg = j.message ?? j.error ?? msg;
  } catch {
    // Not JSON: keep the first part of the text.
  }
  return Object.assign(new Error(`${what}: HTTP ${r.status} ${msg}`), { status: r.status });
}

// ---------------------------------------------------------------- processes

/** Docker answers on this computer (checked now and then: it may be started later). */
let dockerSeen = { at: 0, ok: false };
function hasDocker() {
  if (Date.now() - dockerSeen.at < 60_000) return dockerSeen.ok;
  const r = spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], { stdio: "ignore", timeout: 8000 });
  dockerSeen = { at: Date.now(), ok: r.status === 0 };
  return dockerSeen.ok;
}

/** A program with its arguments, never through a shell; resolves with its exit code and output. */
function tool(bin, argv, opts = {}) {
  return new Promise((done) => {
    const child = spawn(bin, argv, { cwd: opts.cwd, env: process.env });
    let out = "";
    const take = (b) => {
      out += b.toString();
      if (out.length > 200_000) out = out.slice(-100_000);
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    const timer = opts.timeoutMs ? setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs) : null;
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      done({ code: code ?? 1, output: out.trim() });
    });
    child.on("error", (e) => {
      if (timer) clearTimeout(timer);
      done({ code: 127, output: e.message });
    });
  });
}

// ---------------------------------------------------------------- what the agent is doing

const clip = (s, n) => {
  const t = String(s ?? "");
  return t.length > n ? `${t.slice(0, n)}…` : t;
};
const firstLine = (s) =>
  String(s ?? "")
    .split("\n")
    .map((l) => l.trim())
    .find(Boolean) ?? "";
const lineCount = (s) => (s.includes("\n") ? `${s.split("\n").length} lines` : "1 line");
const ACTIVITY = "::workspace-activity::";
const CLAUDE_LINE = "::workspace-claude::";
const KINDS = new Set(["say", "tool", "result", "error", "note"]);

/** A line an agent wrote on stderr to say what it is doing, as an activity line; null when it is not one. */
function agentLine(line) {
  if (!line.startsWith(ACTIVITY)) return null;
  try {
    const j = JSON.parse(line.slice(ACTIVITY.length));
    if (!KINDS.has(j?.kind)) return [];
    return [{ kind: j.kind, ...(j.tool ? { tool: clip(j.tool, 120) } : {}), text: clip(j.text, 600), ...(j.detail ? { detail: clip(j.detail, 1500) } : {}) }];
  } catch {
    return [];
  }
}

/** Tools whose result is something read or found: how much of it is worth a word, the content is not sent. */
const READS = new Set(["Read", "NotebookRead", "Grep", "Glob"]);

/** What a tool of Claude Code acts on, in a line: the file, the command, the pattern, the address. */
function toolTarget(name, input, cwd) {
  const i = input ?? {};
  const rel = (p) => (typeof p === "string" && cwd && p.startsWith(`${cwd}/`) ? p.slice(cwd.length + 1) : (p ?? ""));
  if (name === "Bash")
    return {
      text: firstLine(i.command),
      ...(String(i.command ?? "")
        .trim()
        .includes("\n") || String(i.command ?? "").length > 300
        ? { detail: i.command }
        : {}),
    };
  if (i.file_path || i.notebook_path) return { text: rel(i.file_path ?? i.notebook_path) };
  if (i.pattern) return { text: `${i.pattern}${i.path ? ` in ${rel(i.path)}` : i.glob ? ` in ${i.glob}` : ""}` };
  if (i.url) return { text: i.url };
  if (i.query) return { text: i.query };
  if (Array.isArray(i.todos)) return { text: (i.todos.find((t) => t.status === "in_progress") ?? i.todos[0])?.content ?? "" };
  if (i.description) return { text: i.description };
  const first = Object.values(i).find((v) => typeof v === "string" && v.trim());
  return { text: first ? firstLine(first) : Object.keys(i).length ? JSON.stringify(i) : "" };
}

/**
 * Reads Claude Code's stream-json lines (`claude -p --output-format stream-json --verbose`): each one becomes the
 * activity lines it stands for. The agent's last words are the step's result (`output()`); `model` is the model that
 * answered. A line that is not one of Claude Code's gives null.
 */
function claudeReader() {
  const tools = new Map();
  let cwd = "";
  let result = null;
  let said = "";
  const self = {
    model: "",
    seen: 0,
    output: () => (result ?? said).trim(),
    take(line) {
      let j;
      try {
        j = JSON.parse(line);
      } catch {
        return null;
      }
      if (!j || typeof j !== "object" || typeof j.type !== "string") return null;
      self.seen++;
      const out = [];
      if (j.type === "system" && j.subtype === "init") {
        cwd = j.cwd ?? "";
        self.model = j.model ?? "";
      } else if (j.type === "assistant") {
        for (const b of j.message?.content ?? []) {
          if (b.type === "text" && b.text?.trim()) {
            // Only the main agent's words can be the result; a sub-agent's are its own.
            if (!j.parent_tool_use_id) said = b.text;
            out.push({ kind: "say", text: clip(b.text.trim(), 600) });
          } else if (b.type === "tool_use") {
            tools.set(b.id, b.name);
            const t = toolTarget(b.name, b.input, cwd);
            out.push({ kind: "tool", tool: clip(b.name, 120), text: clip(t.text, 600), ...(t.detail ? { detail: clip(t.detail, 1500) } : {}) });
          }
        }
      } else if (j.type === "user") {
        for (const b of Array.isArray(j.message?.content) ? j.message.content : []) {
          if (b.type !== "tool_result") continue;
          const name = tools.get(b.tool_use_id) ?? "";
          const text = (typeof b.content === "string" ? b.content : (b.content ?? []).map((c) => c.text ?? "").join("\n")).trim();
          if (b.is_error) out.push({ kind: "error", tool: name, text: clip(firstLine(text), 300), detail: clip(text, 1500) });
          // What a command printed is worth reading; what a file holds stays on this computer (only its size is said).
          else if (name === "Bash") out.push({ kind: "result", tool: name, text: clip(firstLine(text), 300), ...(text.includes("\n") ? { detail: clip(text, 1500) } : {}) });
          else out.push({ kind: "result", tool: name, text: READS.has(name) && text ? lineCount(text) : "" });
        }
      } else if (j.type === "result") {
        if (typeof j.result === "string") result = j.result;
        const facts = [j.num_turns ? `${j.num_turns} turns` : "", j.duration_ms ? `${Math.round(j.duration_ms / 1000)}s` : ""].filter(Boolean).join(" · ");
        if (j.is_error) out.push({ kind: "error", text: clip(firstLine(j.result) || j.subtype || "the agent stopped with an error", 300) });
        else if (facts) out.push({ kind: "note", text: facts });
      }
      return out;
    },
  };
  return self;
}

/** A stream cut into lines. */
const byLine = (fn) => {
  let buf = "";
  return {
    push(s) {
      buf += s;
      for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
        fn(buf.slice(0, i));
        buf = buf.slice(i + 1);
      }
    },
    end() {
      if (buf) fn(buf);
      buf = "";
    },
  };
};

/** Claude Code in print mode, without an output format of its own: it can be asked to say what it does. */
const speaksClaude = (cmd) => /^\s*claude\b/.test(cmd) && /\s(-p|--print)\b/.test(cmd) && !/--output-format\b/.test(cmd);

/**
 * Runs one step's process, streaming its output to the task every couple of seconds; resolves with all of it.
 * `onChunk(output, activity)` gets what it printed and what it did since the last time. With `claude` its stdout is
 * Claude Code's stream-json: read as activity, and the result is the agent's last words, not the lines themselves.
 * `stopped()` is asked every few seconds: true ends the process (the run was stopped in the workspace). Past
 * `timeoutMs` the process is ended and the result says so. `kill` ends what the process started (a container's
 * processes are not children of the docker client).
 */
function runProcess({ bin, argv, shell, cwd, env, input, onChunk, stopped, timeoutMs, kill, claude }) {
  return new Promise((done) => {
    const child = shell ? spawn(bin, { cwd, shell: true, env, detached: !WIN }) : spawn(bin, argv, { cwd, env, detached: !WIN });
    let ended = "";
    const end = (why) => {
      if (ended) return;
      ended = why;
      try {
        if (kill) kill();
        // The whole process group: a shell's children (the agent, a test runner) go too.
        if (!WIN) process.kill(-child.pid, "SIGTERM");
        else child.kill("SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }
      setTimeout(() => {
        try {
          if (!WIN) process.kill(-child.pid, "SIGKILL");
          else child.kill("SIGKILL");
        } catch {
          // Already gone.
        }
      }, 5000).unref();
    };
    const watch = setInterval(async () => {
      if (!ended && (await stopped().catch(() => false))) end("stopped");
    }, CHECK_EVERY);
    const limit = timeoutMs ? setTimeout(() => end("timeout"), timeoutMs) : null;
    let all = "";
    let pending = "";
    let acts = [];
    const flush = () => {
      if (pending || acts.length) onChunk(pending, acts);
      pending = "";
      acts = [];
    };
    const timer = setInterval(flush, 2000);
    const take = (s) => {
      process.stdout.write(s);
      all += s;
      if (all.length > 400_000) all = all.slice(-200_000);
      pending += s;
    };
    const did = (events) => {
      for (const e of events) {
        console.log(`   · ${[e.kind === "error" ? "✕" : "", e.tool, clip(e.text, 160)].filter(Boolean).join(" ")}`);
        acts.push(e);
      }
      // A burst of actions goes at once, well under what one report may carry.
      if (acts.length >= 100) flush();
    };
    const reader = claude ? claudeReader() : null;
    // An agent started through another program (workspace-connect) passes Claude Code's lines on, marked, on stderr.
    let relayed = null;
    const stdout = reader ? byLine((line) => did(reader.take(line) ?? (take(`${line}\n`), []))) : { push: take, end() {} };
    const stderr = byLine((line) => {
      const said = line.startsWith(CLAUDE_LINE) ? ((relayed ??= claudeReader()).take(line.slice(CLAUDE_LINE.length).trim()) ?? []) : agentLine(line);
      if (said) did(said);
      else take(`${line}\n`);
    });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (s) => stdout.push(s));
    child.stderr.on("data", (s) => stderr.push(s));
    child.stdin.on("error", () => {});
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
    const finish = (code, extra = "") => {
      clearInterval(timer);
      clearInterval(watch);
      if (limit) clearTimeout(limit);
      stdout.end();
      stderr.end();
      flush();
      // Claude Code's result is what it said last; anything else it printed (an error) only matters when it failed.
      const said = reader?.output() ?? "";
      const output = reader ? (code === 0 && said ? said : [said, all.trim()].filter(Boolean).join("\n")) : all;
      done({
        code: code ?? 1,
        output: output + extra,
        stopped: ended === "stopped",
        timeout: ended === "timeout",
        model: reader?.model || relayed?.model || "",
        spoke: reader ? reader.seen > 0 : undefined,
      });
    };
    child.on("close", (code) => finish(code));
    child.on("error", (e) => finish(127, `\n${e.message}`));
  });
}

// ---------------------------------------------------------------- the environment

const safeName = (name, taken) => {
  let n =
    basename(String(name).replace(/\\/g, "/"))
      .replace(/[\u0000-\u001f<>:"|?*]/g, "_")
      .slice(0, 180) || "file";
  if (n === "." || n === "..") n = "file";
  const ext = extname(n);
  const stem = n.slice(0, n.length - ext.length);
  for (let i = 2; taken.has(n.toLowerCase()); i++) n = `${stem} (${i})${ext}`;
  taken.add(n.toLowerCase());
  return n;
};

async function download(assets, dir, log) {
  mkdirSync(dir, { recursive: true });
  const taken = new Set();
  let n = 0;
  for (const a of assets) {
    const name = safeName(a.name, taken);
    try {
      const r = await fetch(a.url, { signal: AbortSignal.timeout(120_000) });
      if (!r.ok || !r.body) throw new Error(`HTTP ${r.status}`);
      await pipeline(Readable.fromWeb(r.body), createWriteStream(join(dir, name)));
      n++;
      log(`asset ${name}`);
    } catch (e) {
      log(`could not download ${name}: ${e.message}`);
    }
  }
  return n;
}

const containerName = (runId) => `workspace-run-${runId.toLowerCase()}`;
/** Who a container's steps run as: this computer's user (its files in the mounted folder stay its own), never root. */
const STEP_USER = typeof process.getuid === "function" && process.getuid() !== 0 ? `${process.getuid()}:${process.getgid()}` : "1000:1000";

/**
 * Prepares where the run's steps execute and returns how to execute them. Throws with a message for the run's page
 * when the environment cannot be given as the workflow asks (no Docker for a container, a repository that will not clone).
 */
async function prepare(next, log) {
  const { run, environment: env, resumed, assets } = next;
  const computer = env.kind !== "sandbox";
  const root = computer ? join(tmpdir(), "workspace-runs", run.id) : join(SANDBOX_ROOT, run.id);
  const work = computer ? DIR : join(root, "work");
  const assetsDir = join(root, "assets");
  const outDir = join(root, "out");
  const fresh = !resumed || !existsSync(work);
  mkdirSync(assetsDir, { recursive: true });
  mkdirSync(outDir, { recursive: true });
  if (!computer) mkdirSync(work, { recursive: true });
  const container = !computer && env.isolation === "container";
  const name = containerName(run.id);
  const facts = { isolation: computer ? "computer" : container ? "container" : "folder" };
  let assetCount;

  if (fresh) {
    if (!computer && env.repo) {
      log(`cloning ${env.repo}${env.branch ? ` (${env.branch})` : ""}`);
      const r = await tool("git", ["clone", "--depth", "1", ...(env.branch ? ["--branch", env.branch] : []), "--", env.repo, work], { timeoutMs: 10 * 60_000 });
      if (r.code !== 0) throw new Error(`could not clone the repository: ${r.output.slice(-600)}`);
    }
    if (assets?.length) assetCount = await download(assets, assetsDir, log);
  }

  if (container) {
    if (!hasDocker()) throw new Error(`this workflow runs in a container, and Docker is not available on ${DEVICE}. Start Docker, or run it on a runner that has it.`);
    const state = await tool("docker", ["inspect", "-f", "{{.State.Running}}", name]);
    if (state.code === 0 && state.output.trim() === "false") {
      const s = await tool("docker", ["start", name]);
      if (s.code !== 0) throw new Error(`could not start the container again: ${s.output.slice(-400)}`);
    } else if (state.code !== 0) {
      log(`starting a container from ${env.image}${env.network === "off" ? ", without a network" : ""}`);
      const argv = [
        "run",
        "-d",
        "--name",
        name,
        "--label",
        "workspace.run=1",
        ...(env.network === "off" ? ["--network", "none"] : []),
        ...(env.cpus ? ["--cpus", String(env.cpus)] : []),
        ...(env.memoryMb ? ["--memory", `${env.memoryMb}m`] : []),
        // The steps run as this computer's user, not root: files they write in the folder stay this user's, and a
        // step cannot change what the image installed. The setup command alone runs as root (see `shell`).
        "--user",
        STEP_USER,
        "-e",
        "HOME=/tmp",
        "-v",
        `${root}:/run`,
        "-v",
        `${assetsDir}:/run/assets:ro`,
        "-w",
        "/run/work",
        "-e",
        "WORKSPACE_ASSETS=/run/assets",
        "-e",
        "WORKSPACE_OUT=/run/out",
        "-e",
        `WORKSPACE_TASK=${run.taskCode}`,
        "-e",
        `WORKSPACE_RUN=${run.id}`,
        // Only the names the workflow lists, with this computer's values; nothing else of its environment goes in.
        ...(env.env ?? []).filter((n) => process.env[n] !== undefined).flatMap((n) => ["-e", n]),
        env.image,
        "sh",
        "-c",
        "trap 'exit 0' TERM INT; tail -f /dev/null & wait",
      ];
      const r = await tool("docker", argv, { timeoutMs: 15 * 60_000 });
      if (r.code !== 0) throw new Error(`could not start the container: ${r.output.slice(-600)}`);
    }
    facts.image = env.image;
    facts.network = env.network === "off" ? "off" : "on";
    facts.agentIn = env.agent ? "container" : "host";
  }

  const hostEnv = { ...process.env, WORKSPACE_ASSETS: assetsDir, WORKSPACE_OUT: outDir, WORKSPACE_TASK: run.taskCode, WORKSPACE_RUN: run.id, WORKSPACE_ACTIVITY: "1" };
  /** One shell command where the steps run: inside the container, or in the working folder. */
  const shell = (command, o) =>
    container
      ? runProcess({
          ...o,
          bin: "docker",
          argv: [
            "exec",
            "-i",
            "-e",
            "WORKSPACE_ACTIVITY=1",
            ...(o.model ? ["-e", `WORKSPACE_MODEL=${o.model}`] : []),
            ...Object.entries(o.vars ?? {}).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
            ...(o.root ? ["-u", "0"] : []),
            name,
            "sh",
            "-lc",
            command,
          ],
          kill: () => void tool("docker", ["restart", "-t", "1", name]),
        })
      : runProcess({ ...o, bin: command, shell: true, cwd: work, env: { ...hostEnv, ...(o.vars ?? {}), ...(o.model ? { WORKSPACE_MODEL: o.model } : {}) } });
  /** The agent for one AI step: inside the container when the workflow names its command there, else this computer's. */
  const agent = async (o) => {
    const withModel = (cmd) => (o.model && /^claude\b/.test(cmd) && !/--model\b/.test(cmd) ? `${cmd} --model ${JSON.stringify(o.model)}` : cmd);
    const inside = container && env.agent;
    const cmd = withModel(inside ? env.agent : AGENT);
    const start = (command, claude) =>
      inside
        ? shell(command, { ...o, claude })
        : runProcess({ ...o, claude, bin: command, shell: true, cwd: work, env: o.model ? { ...hostEnv, WORKSPACE_MODEL: o.model } : hostEnv });
    if (!speaksClaude(cmd)) return start(cmd, false);
    const r = await start(`${cmd} --output-format stream-json --verbose`, true);
    // A Claude Code without these options: the step runs without streaming, its answer at the end.
    if (r.code !== 0 && !r.spoke && !r.stopped && !r.timeout && /unknown option|output-format|verbose/i.test(r.output)) return start(cmd, false);
    return r;
  };

  if (fresh && !computer && env.setup) {
    log(`$ ${env.setup}`);
    // Installing is the image's business: the setup runs as root, the steps after it do not.
    const r = await shell(env.setup, { onChunk: (c) => c && log(c.trimEnd()), stopped: async () => false, timeoutMs: 20 * 60_000, root: true });
    if (r.code !== 0) throw new Error(`the setup command failed (exit ${r.code}): ${r.output.trim().slice(-600)}`);
  }

  return {
    facts: { ...facts, ...(assetCount !== undefined ? { assets: assetCount } : {}) },
    shell,
    agent,
    outDir,
    // What the instruction's {{assets_dir}} and {{out_dir}} become: relative in a sandbox (the same inside a container).
    paths: computer ? { assets: assetsDir, out: outDir } : { assets: "../assets", out: "../out" },
    /** The run waits for people: the container stops (the folder stays), and starts again when the run comes back. */
    park: async () => {
      if (container) await tool("docker", ["stop", "-t", "2", name]);
    },
    /** The run is over: the container goes, and the folder too unless the workflow keeps it. */
    remove: async () => {
      if (container) await tool("docker", ["rm", "-f", name]);
      if (!(env.keep && !computer)) rmSync(root, { recursive: true, force: true });
    },
  };
}

// ---------------------------------------------------------------- handing files back

const TYPES = {
  ".md": "text/markdown",
  ".txt": "text/plain",
  ".csv": "text/csv",
  ".json": "application/json",
  ".html": "text/html",
  ".xml": "application/xml",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".zip": "application/zip",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".mp4": "video/mp4",
  ".mp3": "audio/mpeg",
};
const MAX_FILES = 30;
const MAX_BYTES = 50 * 1024 * 1024;

function filesIn(dir, base = dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (out.length >= MAX_FILES * 4) break;
    const p = join(dir, e.name);
    if (e.isDirectory()) filesIn(p, base, out);
    else if (e.isFile()) out.push({ path: p, rel: relative(base, p), size: statSync(p).size });
  }
  return out;
}

/** Every file of the run's out folder becomes an attachment of the task; what the workspace refuses is said in the log. */
async function handBack(runId, outDir) {
  const lines = [];
  const missing = [];
  const files = existsSync(outDir) ? filesIn(outDir) : [];
  let sent = 0;
  for (const f of files) {
    const name = f.rel.split(/[\\/]/).join(" - ");
    if (sent >= MAX_FILES) {
      lines.push(`not handed back (over ${MAX_FILES} files): ${name}`);
      missing.push({ name, why: `over ${MAX_FILES} files` });
      continue;
    }
    if (!f.size || f.size > MAX_BYTES) {
      lines.push(`not handed back (${f.size ? "over 50 MB" : "empty"}): ${name}`);
      // An empty file is nothing lost; one that is too big is.
      if (f.size) missing.push({ name, why: "over 50 MB" });
      continue;
    }
    const contentType = TYPES[extname(name).toLowerCase()] ?? "application/octet-stream";
    try {
      const u = await api("POST", `/runner/runs/${runId}/artifacts`, { name, contentType, size: f.size });
      const put = await fetch(u.uploadUrl, { method: "PUT", headers: { "content-type": contentType, "content-length": String(f.size) }, body: await readFile(f.path) });
      if (!put.ok) throw new Error(`upload refused (HTTP ${put.status})`);
      await api("POST", `/runner/runs/${runId}/artifacts/${u.fileId}/confirm`);
      sent++;
      lines.push(`handed back ${name}`);
    } catch (e) {
      const why = String(e.message ?? e).slice(0, 200);
      lines.push(`not handed back: ${name}: ${why}`);
      missing.push({ name, why });
    }
  }
  if (!files.length) lines.push("nothing in the out folder");
  console.log(lines.map((l) => `   ${l}`).join("\n"));
  // What could not be handed back fails the run in the workspace, with the reasons: never a silent "done".
  await api("POST", `/runner/runs/${runId}/collected`, { log: `${lines.join("\n")}\n`, missing });
}

// ---------------------------------------------------------------- one run

const WAITS = {
  waiting_approval: "⏸  waiting for approval in the workspace",
  waiting_input: "?  the agent asked a question: answer it in the workspace",
  paused: "‖  paused in the workspace: Continue there to go on",
};

async function work(next) {
  const { run } = next;
  console.log(`\n▶ ${run.taskCode} · ${run.taskTitle} — ${run.workflowName}${next.resumed ? " (continuing)" : ""}`);
  let pendingLog = "";
  const envLog = (line) => {
    console.log(`   ${line}`);
    pendingLog += `${line}\n`;
  };
  let ctx;
  try {
    ctx = await prepare(next, envLog);
    const r = await api("POST", `/runner/runs/${run.id}/env`, { state: "ready", ...ctx.facts, log: pendingLog });
    if (r.status !== "running" && r.status !== "paused") return;
  } catch (e) {
    console.error(`✕ ${e.message}`);
    await api("POST", `/runner/runs/${run.id}/env`, { state: "failed", log: `${pendingLog}${e.message}\n` }).catch(() => {});
    // Nothing of a half-made sandbox is kept.
    if (next.environment.kind === "sandbox") {
      await tool("docker", ["rm", "-f", containerName(run.id)]).catch(() => {});
      rmSync(join(SANDBOX_ROOT, run.id), { recursive: true, force: true });
    }
    return;
  }

  let status = "running";
  try {
    for (;;) {
      const n = await api("POST", `/runner/runs/${run.id}/next`);
      status = n.status;
      if (n.collect) {
        console.log("\n— handing back the files of the out folder");
        await handBack(run.id, ctx.outDir);
        continue;
      }
      if (!n.step) break;
      const s = n.step;
      console.log(`\n— ${s.index + 1} ${s.title} (${s.kind})`);
      const report = (state, extra = {}) => api("POST", `/runner/runs/${run.id}/step`, { index: s.index, state, ...extra });
      const stopped = async () => (await api("GET", `/runner/runs/${run.id}`)).status === "cancelled";
      // Reports go one after the other, so what the agent did reaches the workspace in order and before the result.
      let sending = Promise.resolve();
      const onChunk = (chunk, activity) => {
        sending = sending.then(() => report("log", { ...(chunk ? { log: chunk.slice(-40_000) } : {}), ...(activity.length ? { activity } : {}) }).catch(() => {}));
      };
      const o = { onChunk, stopped, timeoutMs: s.timeoutMin * 60_000, model: s.model || "" };
      const input = s.input?.replaceAll("{{assets_dir}}", ctx.paths.assets).replaceAll("{{out_dir}}", ctx.paths.out);
      const byAgent = input !== undefined;
      if (byAgent) await report("log", { model: s.model || AGENT }).catch(() => {});
      const res = byAgent ? await ctx.agent({ ...o, input }) : await ctx.shell(s.command, { ...o, vars: s.env ?? {} });
      await sending;
      // The model that really answered, when the agent said it.
      if (byAgent && res.model) await report("log", { model: res.model }).catch(() => {});
      if (res.stopped) {
        console.log("■ stopped in the workspace");
        status = "cancelled";
        break;
      }
      const output = res.output.trim().slice(-20_000);
      const ok = res.code === 0 && !res.timeout;
      const x = await report(ok ? "done" : "failed", { output: output || (ok ? "" : `exit code ${res.code}`), exitCode: res.code, ...(res.timeout ? { timeout: true } : {}) });
      if (!ok)
        console.log(res.timeout ? `✕ ran out of time (${s.timeoutMin} min)` : s.kind === "check" ? `✕ check did not pass (exit ${res.code})` : `✕ failed (exit ${res.code})`);
      status = x.status;
      if (status !== "running") break;
    }
  } finally {
    const over = status === "done" || status === "failed" || status === "cancelled";
    console.log(status === "done" ? "✓ done" : (WAITS[status] ?? `■ ${status}`));
    await (over ? ctx.remove() : ctx.park()).catch(() => {});
  }
}

console.log(`workspace runner ${VERSION} · ${DEVICE} · ${DIR} · agent: ${AGENT}${SHARED ? " · company runner" : ""}${hasDocker() ? " · Docker" : ""}`);
let told = false;
for (;;) {
  try {
    const r = await api("POST", "/runner/claim", {
      device: DEVICE,
      protocol: PROTOCOL,
      shared: SHARED,
      docker: hasDocker(),
      agent: AGENT.slice(0, 400),
      os: platform(),
      version: VERSION,
    });
    if (r.upgrade && !told) {
      told = true;
      console.error("This runner is older than the workspace. Download it again from AI › Connect.");
    }
    if (r.latest && !told) {
      told = true;
      console.error(`A newer runner (${r.latest}) is on the workspace: restart the connection to use it.`);
    }
    if (r.next) await work(r.next);
    else {
      if (ONCE) break;
      await new Promise((res) => setTimeout(res, EVERY));
    }
  } catch (e) {
    console.error(String(e.message ?? e));
    if (ONCE) process.exit(1);
    await new Promise((res) => setTimeout(res, EVERY * 2));
  }
}
