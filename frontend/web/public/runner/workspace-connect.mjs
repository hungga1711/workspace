#!/usr/bin/env node
/**
 * workspace connect: connects the AI on this computer to your workspace. One program, started once.
 *
 *   node workspace-connect.mjs <connection code>     the first time (the code is shown in workspace › AI › Connect)
 *   node workspace-connect.mjs                       afterwards: it remembers the code
 *
 * It looks for the AI you already have (nothing to pick or type), tells the workspace what it found, and then:
 *
 *   1. Workflows   runs the agent workflows you start with Run on a task, with your AI, on this computer
 *                  (workspace-runner.mjs, downloaded next to this file).
 *   2. Answers     answers the questions the workspace sends here: your own, when you chose this computer's AI for
 *                  them (AI › Connect), and everyone's, when an admin chose it for the assistant (Admin › AI).
 *   3. Tokens      sends how many tokens your AI tools used (workspace-usage.mjs): counts only, never text.
 *   4. Safety net  checks what is about to be sent to an AI outside this computer against the company's rules
 *                  (ID numbers, cards, keys, bank details, the company's own keywords) and warns, redacts or blocks.
 *
 * Which AI: two registries below, one entry per kind. Adding a kind is adding an entry.
 *   AGENTS   command-line agents (Claude Code, Codex, Gemini CLI, opencode, Cursor Agent, Qwen Code, Copilot CLI)
 *   SERVERS  model servers that speak the OpenAI API on this computer (Ollama, LM Studio, Jan, llama.cpp, …)
 *
 * Other commands:
 *   --status        what was found on this computer, and whether the workspace answers
 *   --install       start with the computer (macOS LaunchAgent, Linux systemd user unit, Windows scheduled task)
 *   --uninstall     stop starting with the computer, remove the safety-net hook and the saved code
 *   --no-guard      do not add the safety-net hook to Claude Code
 *   --dir <folder>  where workflows work (default: the folder this was started in)
 *   --shared        a company runner: also take sandbox workflows anyone starts on "the company's runner" (the code must
 *                   be of someone who manages the company's AI agents); --no-shared turns it off again
 *
 * Everything it keeps is in ~/.workspace-ai (WORKSPACE_AI_HOME to move it). Node 22+, no dependencies.
 */
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, hostname, platform, tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const VERSION = "3";
const HOME = process.env.WORKSPACE_AI_HOME || join(homedir(), ".workspace-ai");
const CONFIG = join(HOME, "config.json");
const SELF = join(HOME, "workspace-connect.mjs");
/** Token counts of the answers this program asked a local model for (read by workspace-usage.mjs). */
const LEDGER = join(HOME, "ledger.jsonl");
const WIN = platform() === "win32";
/** Questions this computer answers at the same time. */
const MAX_AT_ONCE = 3;

// ---------------------------------------------------------------- the registries

/**
 * Command-line agents. `args(model)` runs one prompt and prints the answer; the prompt goes on stdin unless
 * `promptArg` (then it is the last argument). `cloud`: the prompt leaves this computer, so the safety net applies.
 * `logs`: workspace-usage.mjs reads this tool's own logs for token counts. `hook`: it can check prompts typed in the
 * tool itself (only Claude Code has such a hook today). `live(model)`: the arguments that print the answer as it is
 * written, as JSON lines `textOf` reads; agents without it print the answer as it comes, or all at the end.
 */
export const AGENTS = [
  {
    id: "claude-code",
    name: "Claude Code",
    bin: "claude",
    args: (m) => ["-p", ...(m ? ["--model", m] : [])],
    live: (m) => ["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages", ...(m ? ["--model", m] : [])],
    cloud: true,
    logs: true,
    hook: true,
    models: () => claudeModels(),
    // Images go in as content blocks of one JSON input line (--input-format stream-json), next to the text.
    images: true,
    // A question to answer, not work to do: none of its own tools, MCP servers, plugins, hooks or saved sessions, and
    // the workspace's instructions in place of its own long ones. Starting all of that for every answer took ~15 s a
    // turn; this way ~5 s. `sys`: a file with the instructions. `web` (the question needs the web): its web search and
    // page reading only, allowed without asking. Never its file, shell or code tools: anyone in the company may ask.
    answer: (m, sys, web) => [
      "--tools",
      web ? "WebSearch,WebFetch" : "",
      ...(web ? ["--allowedTools", "WebSearch,WebFetch"] : []),
      "--strict-mcp-config",
      "--disable-slash-commands",
      "--setting-sources",
      "",
      "--no-session-persistence",
      ...(sys ? ["--system-prompt-file", sys] : []),
      ...(m ? [] : claudeModel()),
    ],
  },
  { id: "codex", name: "Codex", bin: "codex", args: (m) => ["exec", "--skip-git-repo-check", ...(m ? ["--model", m] : []), "-"], cloud: true, logs: true },
  { id: "gemini-cli", name: "Gemini CLI", bin: "gemini", args: (m) => (m ? ["-m", m] : []), cloud: true, logs: true },
  { id: "opencode", name: "opencode", bin: "opencode", args: (m) => ["run", ...(m ? ["-m", m] : [])], promptArg: true, cloud: true, logs: true },
  { id: "cursor-agent", name: "Cursor Agent", bin: "cursor-agent", args: (m) => ["-p", "--output-format", "text", ...(m ? ["--model", m] : [])], promptArg: true, cloud: true },
  { id: "qwen-code", name: "Qwen Code", bin: "qwen", args: (m) => (m ? ["-m", m] : []), cloud: true },
  { id: "copilot-cli", name: "GitHub Copilot CLI", bin: "copilot", args: (m) => [...(m ? ["--model", m] : []), "-p"], promptArg: true, cloud: true },
];

/** Model servers on this computer that speak the OpenAI API. Nothing leaves the machine. */
export const SERVERS = [
  { id: "ollama", name: "Ollama", base: "http://127.0.0.1:11434/v1" },
  { id: "lmstudio", name: "LM Studio", base: "http://127.0.0.1:1234/v1" },
  { id: "jan", name: "Jan", base: "http://127.0.0.1:1337/v1" },
  { id: "llamacpp", name: "llama.cpp / LocalAI", base: "http://127.0.0.1:8080/v1" },
  { id: "gpt4all", name: "GPT4All", base: "http://127.0.0.1:4891/v1" },
  { id: "vllm", name: "vLLM", base: "http://127.0.0.1:8000/v1" },
  { id: "koboldcpp", name: "KoboldCpp", base: "http://127.0.0.1:5001/v1" },
  { id: "textgen", name: "text-generation-webui", base: "http://127.0.0.1:5000/v1" },
];

// ---------------------------------------------------------------- small things

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const option = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : undefined;
};
const say = (text) => console.log(text);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readJson = (file, fallback) => {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
};
const loadConfig = () => readJson(CONFIG, null);
const saveConfig = (c) => {
  mkdirSync(HOME, { recursive: true });
  writeFileSync(CONFIG, JSON.stringify(c, null, 2));
  // The file holds the connection code: readable by its owner only.
  if (!WIN) chmodSync(CONFIG, 0o600);
};

/** Where a program is on PATH (no shell, so nothing typed is ever run). */
function which(bin) {
  const exts = WIN ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
  for (const dir of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const p = join(dir, bin + ext.toLowerCase());
      if (existsSync(p)) return p;
      if (ext && existsSync(join(dir, bin + ext))) return join(dir, bin + ext);
    }
  }
  return null;
}

async function getJson(url, ms = 1500) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(ms) });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

/** What is on this computer right now: [{ id, name, kind: "agent" | "server", models?, cloud }]. */
export async function detect() {
  const agents = AGENTS.filter((a) => which(a.bin)).map((a) => {
    const models = a.models?.() ?? [];
    return { id: a.id, name: a.name, kind: "agent", cloud: !!a.cloud, hook: !!a.hook, logs: !!a.logs, ...(models.length ? { models } : {}) };
  });
  const servers = (
    await Promise.all(
      SERVERS.map(async (s) => {
        const body = await getJson(`${s.base}/models`);
        const models = (body?.data ?? [])
          .map((m) => m?.id)
          .filter((id) => typeof id === "string" && !/embed/i.test(id))
          .slice(0, 40);
        return models.length ? { id: s.id, name: s.name, kind: "server", cloud: false, models } : null;
      }),
    )
  ).filter(Boolean);
  return [...agents, ...servers];
}

// ---------------------------------------------------------------- the workspace

/** "https://work.example.com#wos_…": the address and the key in one piece, so nothing else has to be typed. */
function parseCode(raw) {
  const m = /^(https?:\/\/[^#\s]+)#(wos_[A-Za-z0-9_-]{20,})$/.exec(String(raw ?? "").trim());
  return m ? { url: m[1].replace(/\/$/, ""), key: m[2] } : null;
}

class Refused extends Error {}
async function api(cfg, method, path, body, ms = 20_000) {
  let r;
  try {
    r = await fetch(`${cfg.url}/api/ai${path}`, {
      method,
      headers: { authorization: `Bearer ${cfg.key}`, "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(ms),
    });
  } catch (e) {
    throw new Error(`Cannot reach ${cfg.url} (${e?.cause?.code ?? e?.name ?? "network"}). Is this computer online, and is that the address you open workspace at?`);
  }
  const text = await r.text().catch(() => "");
  if (r.status === 403 && /ai_off/.test(text)) throw new Error("AI is switched off for this workspace (an admin turns it on in Admin › AI). Trying again in a while.");
  if (r.status === 404 && /feature_off|ai_off/.test(text)) throw new Error("AI is not part of this workspace installation, or is switched off. Trying again in a while.");
  if (r.status === 401 || r.status === 403)
    throw new Refused("The workspace refused this connection code. Open workspace › AI › Connect, press “Connect this computer” again and run the new command.");
  if (/^\s*</.test(text)) throw new Error(`${cfg.url} answered with a web page, not workspace (HTTP ${r.status}). Copy the command again from workspace › AI › Connect.`);
  if (!r.ok) {
    let msg = text.slice(0, 200);
    try {
      const j = JSON.parse(text);
      msg = j.message ?? j.error ?? msg;
    } catch {
      // Not JSON: keep the first part of the text.
    }
    throw new Error(`workspace answered HTTP ${r.status}: ${msg}`);
  }
  return text ? JSON.parse(text) : null;
}

// ---------------------------------------------------------------- one answer from the AI on this computer

/** Reasoning models print their thinking first; only the answer is wanted. */
const answerOnly = (text) => text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();

/**
 * Claude Code's stream-json lines: the answer's text deltas as they come, and the final result. Returns the text so
 * far, or null for a line that adds nothing.
 */
export function claudeLine(line, soFar) {
  let j;
  try {
    j = JSON.parse(line);
  } catch {
    return null;
  }
  if (j?.type === "stream_event" && j.event?.type === "content_block_delta" && j.event.delta?.type === "text_delta") return soFar + (j.event.delta.text ?? "");
  if (j?.type === "result" && typeof j.result === "string") return j.result;
  return null;
}

/** The web tools an assistant line of Claude Code's calls (WebSearch, WebFetch), with what it searched or read. */
export function webToolsOf(line) {
  let j;
  try {
    j = JSON.parse(line);
  } catch {
    return [];
  }
  if (j?.type !== "assistant" || !Array.isArray(j.message?.content)) return [];
  return j.message.content
    .filter((b) => b?.type === "tool_use" && (b.name === "WebSearch" || b.name === "WebFetch"))
    .map((b) => ({
      name: b.name,
      input: b.name === "WebSearch" ? { query: String(b.input?.query ?? "").slice(0, 200) } : { url: String(b.input?.url ?? "").slice(0, 500) },
    }));
}

/**
 * The pages a line of Claude Code shows: the first results of a web search it ran (its result lists them as
 * `Links: [{title, url}]`), and the page it read with WebFetch. Cited with the answer.
 */
export function webPagesOf(line) {
  let j;
  try {
    j = JSON.parse(line);
  } catch {
    return [];
  }
  const blocks = Array.isArray(j?.message?.content) ? j.message.content : [];
  const out = [];
  if (j?.type === "assistant")
    for (const b of blocks)
      if (b?.type === "tool_use" && b.name === "WebFetch" && /^https?:\/\//.test(String(b.input?.url ?? "")))
        out.push({ url: String(b.input.url).slice(0, 2000), title: String(b.input.url).slice(0, 300) });
  if (j?.type === "user")
    for (const b of blocks) {
      const text = typeof b?.content === "string" ? b.content : Array.isArray(b?.content) ? b.content.map((c) => c?.text ?? "").join("\n") : "";
      const links = /Links: (\[[\s\S]*?\])\s*(?:\n|$)/.exec(text)?.[1];
      if (b?.type !== "tool_result" || !links) continue;
      try {
        for (const l of JSON.parse(links).slice(0, 3))
          if (/^https?:\/\//.test(String(l?.url ?? ""))) out.push({ url: String(l.url).slice(0, 2000), title: String(l.title || l.url).slice(0, 300) });
      } catch {
        // A result in another shape: no pages from it.
      }
    }
  return out;
}

/** A private file with `text` in it, for instructions too long for a command line (Windows allows 8 KB). */
function tempFile(text) {
  const f = join(tmpdir(), `workspace-ai-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
  writeFileSync(f, text, { mode: 0o600 });
  return f;
}

/**
 * The models Claude Code offers on this computer, the one chosen in its settings first: its three families (aliases for
 * their latest version), then the ones this account has on top (what its own /model menu lists, cached in .claude.json).
 */
function claudeModels() {
  const dir = process.env.CLAUDE_CONFIG_DIR?.split(",")[0];
  let extra = [];
  try {
    const j = JSON.parse(readFileSync(dir ? join(dir, ".claude.json") : join(homedir(), ".claude.json"), "utf8"));
    extra = (Array.isArray(j.additionalModelOptionsCache) ? j.additionalModelOptionsCache : []).map((o) => o?.value).filter((v) => typeof v === "string" && v);
  } catch {
    // Never opened, or another layout: the families alone.
  }
  const chosen = claudeModel()[1];
  return [...new Set([chosen, "opus", "sonnet", "haiku", ...extra].filter(Boolean))].slice(0, 40);
}

/** The model the person chose in Claude Code's own settings, kept when its settings are left out (`answer`). */
function claudeModel() {
  try {
    const m = JSON.parse(readFileSync(claudeSettings(), "utf8")).model;
    return typeof m === "string" && m ? ["--model", m] : [];
  } catch {
    return [];
  }
}

function runProcess(cmd, argv, input, ms, { onOut, signal } = {}) {
  return new Promise((done) => {
    // .cmd shims on Windows only start through a shell; arguments there never come from outside this program.
    const child = spawn(cmd, argv, { shell: WIN, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), ms);
    const stop = () => child.kill("SIGTERM");
    signal?.addEventListener("abort", stop, { once: true });
    child.stdout.on("data", (b) => {
      out += b;
      onOut?.(out);
    });
    child.stderr.on("data", (b) => (err += b));
    child.on("error", (e) => {
      clearTimeout(timer);
      done({ code: 1, out, err: e.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", stop);
      done({ code: code ?? 1, out, err });
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(input ?? "");
  });
}

/**
 * Asks one AI: `target` is "<id>" or "<id>:<model>"; "auto" is the preferred one (cfg.prefer), else the first agent,
 * else the first server. Returns { text, usage, tool, model }. `onText(soFar)`: the answer as it is written, for
 * whoever watches it come (reasoning included; the workspace leaves that out). `signal`: stop and return what is there.
 * `onEvent(line)`: each of the agent's own JSON lines about what it does (Claude Code: a tool it calls, its result),
 * for the workflow runner to show as the step's activity.
 */
export async function complete(
  target,
  { system = "", prompt, maxTokens = 2000, timeoutMs = 600_000, onText, onEvent, signal, answer = false, web = false, images = [] },
  found,
  cfg = {},
) {
  let [id, ...rest] = String(target || "auto").split(":");
  let model = rest.join(":");
  if (id === "auto") {
    const [pid, ...pm] = String(cfg.prefer || "").split(":");
    const pick = found.find((f) => f.id === pid) ?? found.find((f) => f.kind === "agent") ?? found[0];
    if (!pick) throw new Error("No AI was found on this computer. Install Claude Code, Codex, Gemini CLI, Ollama or LM Studio, then start this again.");
    id = pick.id;
    if (!model) model = pick.id === pid ? pm.join(":") : "";
  }
  const agent = AGENTS.find((a) => a.id === id);
  if (agent) {
    const bin = which(agent.bin);
    if (!bin) throw new Error(`${agent.name} is not installed on this computer any more.`);
    // `answer` (the workspace asks a question): the agent's lean mode when it has one, the instructions in a file.
    const sys = answer && agent.answer && system ? tempFile(system) : null;
    // The web for this answer only when the agent can be held to its web tools (Claude Code's lean mode).
    const withWeb = !!(web && answer && agent.answer);
    const lean = answer && agent.answer ? agent.answer(model, sys, withWeb) : [];
    const pictures = images.filter((i) => i && typeof i.data === "string" && /^image\//.test(i.mediaType));
    // An agent that takes only text: said plainly, so the person is not answered as if nothing was attached.
    if (pictures.length && !agent.images) throw new Error(`${agent.name} on this computer does not read images. Remove them or pick another AI.`);
    const text = system && !sys ? `${system}\n\n${prompt}` : prompt;
    // JSON lines also tell which web tools it used, for the answer's steps; images need them in both directions.
    let json = !!((onText || onEvent || withWeb || pictures.length) && agent.live);
    const used = [];
    const pages = [];
    const argv = [...(json ? agent.live(model) : agent.args(model)), ...(pictures.length ? ["--input-format", "stream-json"] : []), ...lean];
    // With images the question is one JSON line: the text, then each image as a base64 content block.
    const input = pictures.length ? imageInput(text, pictures) : text;
    // JSON lines: the text is rebuilt from them; plain output: the output so far is the answer so far.
    let said = "";
    // Whether the agent really printed JSON lines: one that answers in plain text anyway (an older version that
    // ignores the options, a wrapper script) has its output taken as the answer, as before.
    let spoke = false;
    let passed = 0;
    const onOut = json
      ? (out) => {
          // Whole lines only, each once (a long session is many megabytes of them); the text deltas are for onText,
          // not for whoever follows the actions.
          let next = said;
          for (let i = out.indexOf("\n", passed); i >= 0; i = out.indexOf("\n", passed)) {
            const line = out.slice(passed, i);
            passed = i + 1;
            if (!line) continue;
            if (!spoke && line.startsWith("{")) {
              try {
                spoke = typeof JSON.parse(line).type === "string";
              } catch {
                // Not one of its lines.
              }
            }
            next = claudeLine(line, next) ?? next;
            if (withWeb && used.length < 20 && line.includes('"tool_use"')) used.push(...webToolsOf(line));
            if (withWeb && pages.length < 8 && (line.includes('"tool_result"') || line.includes('"WebFetch"')))
              for (const p of webPagesOf(line)) if (pages.length < 8 && !pages.some((x) => x.url === p.url)) pages.push(p);
            if (onEvent && !line.includes('"type":"stream_event"')) onEvent(line);
          }
          if (next !== said) {
            said = next;
            onText?.(said);
          }
        }
      : onText
        ? (out) => onText(out)
        : undefined;
    const run = (args, input, opts) => runProcess(bin, agent.promptArg ? [...args, input] : args, agent.promptArg ? "" : input, timeoutMs, opts);
    let r;
    try {
      r = await run(argv, input, { onOut, signal });
      // A version that cannot take images this way: told as such, never answered without them.
      if (pictures.length && r.code !== 0 && !said && !signal?.aborted && /unknown option|input-format/i.test(r.err))
        throw new Error(`This version of ${agent.name} does not read images here. Update it, or remove the images.`);
      // An older version without the lean options: as before, with the instructions in the prompt.
      // (Never with images: the plain retries below would answer without them.)
      if (!pictures.length && lean.length && r.code !== 0 && !said && !signal?.aborted && /unknown option|tools|strict-mcp|setting-sources|system-prompt/i.test(r.err)) {
        passed = 0;
        r = await run(json ? agent.live(model) : agent.args(model), system ? `${system}\n\n${prompt}` : prompt, { onOut, signal });
      }
      // An older version without these options: the answer at the end, as before.
      if (!pictures.length && json && r.code !== 0 && !said && !signal?.aborted && /unknown option|include-partial-messages|output-format/i.test(r.err)) {
        json = false;
        r = await run(agent.args(model), system ? `${system}\n\n${prompt}` : prompt, { signal });
      }
    } finally {
      if (sys) rmSync(sys, { force: true });
    }
    if (json && !spoke) json = false;
    if (signal?.aborted) return { text: answerOnly(json ? said : r.out), usage: null, tool: agent.id, model: model || agent.id, tools: used, pages };
    if (r.code !== 0) throw new Error(`${agent.name} stopped with an error: ${(r.err || r.out).trim().slice(-400) || `exit code ${r.code}`}`);
    // A command-line agent does not say how many tokens it used here; its own logs do (workspace-usage.mjs).
    return { text: answerOnly(json ? said : r.out), usage: null, tool: agent.id, model: model || agent.id, tools: used, pages };
  }
  const server = SERVERS.find((s) => s.id === id);
  if (!server) throw new Error(`Unknown AI “${id}”.`);
  if (!model) model = found.find((f) => f.id === id)?.models?.[0] ?? "";
  if (!model) throw new Error(`${server.name} has no model loaded. Open ${server.name}, load a model, then try again.`);
  let r;
  try {
    r = await fetch(`${server.base}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model,
        stream: !!onText,
        ...(onText ? { stream_options: { include_usage: true } } : {}),
        max_tokens: maxTokens,
        messages: [
          ...(system ? [{ role: "system", content: system }] : []),
          {
            role: "user",
            // A vision model reads the images; a text-only one refuses, and its error says so ("does not support multimodal").
            content: images.length
              ? [{ type: "text", text: prompt }, ...images.map((i) => ({ type: "image_url", image_url: { url: `data:${i.mediaType};base64,${i.data}` } }))]
              : prompt,
          },
        ],
      }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
    });
  } catch {
    if (signal?.aborted) return { text: "", usage: null, tool: server.id, model };
    throw new Error(`${server.name} did not answer. Is it still open on this computer?`);
  }
  let body;
  if (onText && r.ok && /event-stream/.test(r.headers.get("content-type") ?? "")) {
    // Streamed: the answer's pieces as the model writes them, then (with include_usage) the token counts.
    let text = "";
    let counts = null;
    try {
      for await (const data of sseData(r.body)) {
        let chunk;
        try {
          chunk = JSON.parse(data);
        } catch {
          continue;
        }
        if (chunk?.usage) counts = chunk.usage;
        const piece = chunk?.choices?.[0]?.delta?.content;
        if (piece) onText((text += piece));
      }
    } catch {
      if (!signal?.aborted) throw new Error(`${server.name} stopped answering part-way.`);
    }
    body = { choices: [{ message: { content: text } }], usage: counts };
  } else body = await r.json().catch(() => null);
  if (!r.ok) throw new Error(`${server.name} refused: ${body?.error?.message ?? `HTTP ${r.status}`}`);
  const usage = { input: body?.usage?.prompt_tokens ?? 0, output: body?.usage?.completion_tokens ?? 0 };
  try {
    mkdirSync(HOME, { recursive: true });
    appendFileSync(LEDGER, `${JSON.stringify({ at: new Date().toISOString(), tool: "local-model", model: `${server.id}/${model}`.slice(0, 80), ...usage })}\n`);
  } catch {
    // The count is a courtesy; the answer matters.
  }
  return { text: answerOnly(body?.choices?.[0]?.message?.content ?? ""), usage, tool: server.id, model };
}

/** One user message as Claude Code's JSON input (--input-format stream-json): the text, then the images. */
export function imageInput(text, images) {
  const content = [{ type: "text", text }, ...images.map((i) => ({ type: "image", source: { type: "base64", media_type: i.mediaType, data: i.data } }))];
  return `${JSON.stringify({ type: "user", message: { role: "user", content } })}\n`;
}

/** Server-Sent Events from a model server: each `data:` payload, "[DONE]" left out. */
async function* sseData(stream) {
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of stream) {
    buf += decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, "");
      buf = buf.slice(nl + 1);
      if (line.startsWith("data:")) {
        const data = line.slice(5).trim();
        if (data && data !== "[DONE]") yield data;
      }
    }
  }
}

/**
 * Sends the answer so far to the workspace while the AI writes it, at most every 300 ms (the last one always). Calls
 * `stop` when the person there pressed stop.
 */
function relay(cfg, jobId, stop) {
  let latest = null;
  let sent = null;
  let busy = false;
  let timer = null;
  const flush = async () => {
    timer = null;
    if (busy || latest === sent) return;
    busy = true;
    const text = latest;
    try {
      const r = await api(cfg, "POST", `/local/connect/jobs/${jobId}/part`, { text }, 10_000);
      sent = text;
      if (r?.stop) stop();
    } catch {
      // A part that did not arrive is made up by the next one, or by the answer itself.
    }
    busy = false;
    if (latest !== sent && !timer) timer = setTimeout(flush, 300);
  };
  return {
    text: (soFar) => {
      latest = soFar;
      if (!timer && !busy) timer = setTimeout(flush, sent === null ? 0 : 300);
    },
    done: () => timer && clearTimeout(timer),
  };
}

// ---------------------------------------------------------------- the safety net

/**
 * Asks the workspace what to do with a text before it goes to an AI outside this computer. The rules run there
 * (the same ones the browser extension applies), with or without any AI. Unreachable: the text goes through, since
 * a workspace that is down must not stop anyone's work.
 */
async function checkText(cfg, tool, text) {
  if (!cfg?.url || !text?.trim()) return { action: "allow" };
  try {
    return (await api(cfg, "POST", "/local/guard", { tool, text: text.slice(0, 60_000) }, 4000)) ?? { action: "allow" };
  } catch {
    return { action: "allow" };
  }
}

const HOOK_MARK = "workspace-connect.mjs";
const claudeSettings = () => join(process.env.CLAUDE_CONFIG_DIR?.split(",")[0] || join(homedir(), ".claude"), "settings.json");
/** Claude Code runs this before every prompt typed in it (settings.json › hooks › UserPromptSubmit). */
function installClaudeHook() {
  const file = claudeSettings();
  if (!existsSync(dirname(file))) return false;
  const s = readJson(file, {});
  const list = (s.hooks ??= {}).UserPromptSubmit ?? [];
  if (JSON.stringify(list).includes(HOOK_MARK)) return true;
  s.hooks.UserPromptSubmit = [...list, { hooks: [{ type: "command", command: `node "${SELF}" --guard claude-code`, timeout: 10 }] }];
  writeFileSync(file, `${JSON.stringify(s, null, 2)}\n`);
  return true;
}
function removeClaudeHook() {
  const file = claudeSettings();
  const s = readJson(file, null);
  const list = s?.hooks?.UserPromptSubmit;
  if (!Array.isArray(list)) return;
  s.hooks.UserPromptSubmit = list.filter((h) => !JSON.stringify(h).includes(HOOK_MARK));
  if (!s.hooks.UserPromptSubmit.length) delete s.hooks.UserPromptSubmit;
  if (!Object.keys(s.hooks).length) delete s.hooks;
  writeFileSync(file, `${JSON.stringify(s, null, 2)}\n`);
}

/** The hook itself: reads the prompt, asks the workspace, and stops the prompt (exit 2) when the company blocks it. */
async function guardHook(tool) {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  let prompt = "";
  try {
    prompt = JSON.parse(raw).prompt ?? "";
  } catch {
    prompt = raw;
  }
  const r = await checkText(loadConfig(), tool, prompt);
  if (r.action === "block") {
    console.error(`workspace: not sent. This looks like ${r.names ?? "sensitive data"}, and your company blocks sending it to AI. Remove it and try again.`);
    process.exit(2);
  }
  if (r.action === "redact") {
    console.error(`workspace: not sent. This looks like ${r.names ?? "sensitive data"}. Send this instead:\n\n${r.text ?? ""}`);
    process.exit(2);
  }
  process.exit(0);
}

// ---------------------------------------------------------------- start with the computer

function autostart(install) {
  const node = process.execPath;
  if (platform() === "darwin") {
    const plist = join(homedir(), "Library", "LaunchAgents", "app.workspace.connect.plist");
    spawnSync("launchctl", ["unload", plist], { stdio: "ignore" });
    if (!install) return rmSync(plist, { force: true });
    mkdirSync(dirname(plist), { recursive: true });
    writeFileSync(
      plist,
      `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>
  <key>Label</key><string>app.workspace.connect</string>
  <key>ProgramArguments</key><array><string>${node}</string><string>${SELF}</string></array>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>${process.env.PATH ?? ""}</string></dict>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${join(HOME, "connect.log")}</string><key>StandardErrorPath</key><string>${join(HOME, "connect.log")}</string>
</dict></plist>\n`,
    );
    return spawnSync("launchctl", ["load", plist], { stdio: "ignore" }).status === 0;
  }
  if (platform() === "linux") {
    const unit = join(homedir(), ".config", "systemd", "user", "workspace-connect.service");
    if (!install) {
      spawnSync("systemctl", ["--user", "disable", "--now", "workspace-connect.service"], { stdio: "ignore" });
      return rmSync(unit, { force: true });
    }
    mkdirSync(dirname(unit), { recursive: true });
    writeFileSync(
      unit,
      `[Unit]\nDescription=workspace connect\n\n[Service]\nExecStart=${node} ${SELF}\nEnvironment=PATH=${process.env.PATH ?? ""}\nRestart=always\nRestartSec=10\n\n[Install]\nWantedBy=default.target\n`,
    );
    spawnSync("systemctl", ["--user", "daemon-reload"], { stdio: "ignore" });
    return spawnSync("systemctl", ["--user", "enable", "--now", "workspace-connect.service"], { stdio: "ignore" }).status === 0;
  }
  if (WIN) {
    if (!install) return void spawnSync("schtasks", ["/Delete", "/TN", "workspace-connect", "/F"], { stdio: "ignore" });
    if (spawnSync("schtasks", ["/Create", "/TN", "workspace-connect", "/SC", "ONLOGON", "/F", "/TR", `"${node}" "${SELF}"`], { stdio: "ignore" }).status !== 0) return false;
    return spawnSync("schtasks", ["/Run", "/TN", "workspace-connect"], { stdio: "ignore" }).status === 0;
  }
  return false;
}

// ---------------------------------------------------------------- the long-running program

const children = new Map();
/** Keeps one helper script running (the workflow runner, the token collector); restarts it if it stops. */
function keep(name, script, argv, cfg) {
  if (children.has(name)) return;
  const start = () => {
    const child = spawn(process.execPath, [script, ...argv], { stdio: ["ignore", "inherit", "inherit"], env: { ...process.env, WORKSPACE_URL: cfg.url, WORKSPACE_KEY: cfg.key } });
    children.set(name, child);
    child.on("close", () => {
      if (children.get(name) !== child) return;
      children.delete(name);
      if (!stopping) setTimeout(() => keep(name, script, argv, cfg), 15_000);
    });
  };
  start();
}
let stopping = false;
const stopAll = () => {
  stopping = true;
  for (const c of children.values()) c.kill("SIGTERM");
};

/** The two helper scripts live next to this one on the workspace; fetched again on every start, so they stay current. */
async function fetchHelpers(cfg) {
  mkdirSync(HOME, { recursive: true });
  for (const name of ["workspace-runner.mjs", "workspace-usage.mjs", "workspace-connect.mjs"]) {
    try {
      const r = await fetch(`${cfg.url}/runner/${name}`, { signal: AbortSignal.timeout(15_000) });
      const text = await r.text();
      if (r.ok && text.startsWith("#!/usr/bin/env node")) writeFileSync(join(HOME, name), text);
    } catch {
      // Offline at start: the copies from last time are used.
    }
  }
  // Started from a download elsewhere and never fetched: keep a copy where the hook and autostart expect it.
  if (!existsSync(SELF)) writeFileSync(SELF, readFileSync(fileURLToPath(import.meta.url)));
}

async function main() {
  const given = parseCode(args.find((a) => !a.startsWith("--") && a.includes("#wos_")));
  let cfg = loadConfig();
  if (given) cfg = { ...(cfg ?? {}), ...given, device: cfg?.device ?? hostname().slice(0, 80) };
  if (!cfg?.url || !cfg?.key) {
    say("This computer is not connected yet.\nOpen workspace › AI › Connect, press “Connect this computer”, and run the command it shows.");
    process.exit(2);
  }
  if (option("dir")) cfg.dir = resolve(option("dir"));
  cfg.dir ??= process.cwd();
  if (flag("no-guard")) cfg.guard = false;
  if (flag("shared")) cfg.shared = true;
  if (flag("no-shared")) cfg.shared = false;
  saveConfig(cfg);

  say(`workspace connect · ${cfg.device} · ${cfg.url}`);
  await fetchHelpers(cfg);
  let found = await detect();
  say(
    found.length
      ? `Found on this computer: ${found.map((f) => f.name + (f.models ? ` (${f.models.length} models)` : "")).join(", ")}`
      : "No AI found on this computer yet. Still watching: install one and it shows up within a few minutes.",
  );

  let guard = false;
  const beat = async () => {
    const r = await api(cfg, "POST", "/local/connect/heartbeat", {
      device: cfg.device,
      os: platform(),
      version: VERSION,
      keyPrefix: /^wos_([a-f0-9]{8})_/.exec(cfg.key)?.[1],
      found,
      state: { workflow: children.has("runner"), usage: children.has("usage"), guard },
    });
    if (r?.prefer !== undefined && r.prefer !== cfg.prefer) {
      cfg.prefer = r.prefer;
      saveConfig(cfg);
    }
    return r;
  };
  try {
    await beat();
  } catch (e) {
    say(String(e.message ?? e));
    if (e instanceof Refused) process.exit(1);
  }
  if (flag("install")) {
    // From here on the copy that starts with the computer does the work; two at once would run every workflow twice.
    if (autostart(true)) {
      say("Connected. It now runs in the background and starts with this computer. You can close this window.");
      process.exit(0);
    }
    say("Could not set it to start with this computer; it keeps running in this window instead.");
  }
  say("Connected. Leave this window open.");

  const apply = () => {
    // Workflows need something that can answer; the token collector only reads logs, so it always runs.
    if (found.length)
      keep(
        "runner",
        join(HOME, "workspace-runner.mjs"),
        ["--dir", cfg.dir, "--device", cfg.device, "--agent", `"${process.execPath}" "${SELF}" --complete auto`, ...(cfg.shared ? ["--shared"] : [])],
        cfg,
      );
    keep("usage", join(HOME, "workspace-usage.mjs"), ["--every", "30", "--device", cfg.device], cfg);
    if (cfg.guard !== false && found.some((f) => f.hook)) guard = installClaudeHook();
  };
  apply();
  // Again, now that the helpers run: the page shows "ready" at once instead of a minute later.
  await beat().catch(() => undefined);

  process.on("SIGINT", () => {
    stopAll();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    stopAll();
    process.exit(0);
  });

  // Every minute: say we are here; every five: look again for AI that was installed or opened since.
  let n = 0;
  setInterval(async () => {
    n++;
    if (n % 5 === 0) {
      found = await detect();
      apply();
    }
    await beat().catch((e) => {
      if (e instanceof Refused) {
        say(String(e.message));
        stopAll();
        process.exit(1);
      }
    });
  }, 60_000);

  // Questions the workspace sends to this computer's AI (its owner's own, or everyone's when an admin chose it).
  // A few at once: a background job (a conversation's one-line summary) must not hold up the next question. One poll
  // at a time all the same (the workspace keeps one per computer); a full house waits for one to finish first.
  const inFlight = new Set();
  const answer = async (job) => {
    let result;
    // Someone watches this answer come (Hỏi đáp): send it as it is written, and stop when they press stop.
    const halt = new AbortController();
    const live = job.stream ? relay(cfg, job.id, () => halt.abort()) : null;
    try {
      const agent = AGENTS.find((a) => a.id === String(job.target).split(":")[0]);
      // The workspace already applied the company's rules to what people typed; nothing more to check here.
      const out = await complete(
        job.target,
        {
          system: job.system,
          prompt: job.prompt,
          maxTokens: job.maxTokens,
          timeoutMs: agent ? 110_000 : 100_000,
          answer: true,
          // The question needs the web (an older workspace never sends this).
          web: !!(job.web?.search || job.web?.fetch),
          // The images attached to the question (an older workspace never sends them).
          ...(Array.isArray(job.images) && job.images.length ? { images: job.images } : {}),
          ...(live ? { onText: live.text, signal: halt.signal } : {}),
        },
        found,
        cfg,
      );
      result = { text: out.text, usage: out.usage, model: out.model, ...(out.tools?.length ? { tools: out.tools } : {}), ...(out.pages?.length ? { pages: out.pages } : {}) };
    } catch (e) {
      result = { error: String(e.message ?? e).slice(0, 500) };
    }
    live?.done();
    // Stopped there: the workspace already kept what it had.
    if (!halt.signal.aborted) await api(cfg, "POST", `/local/connect/jobs/${job.id}`, result).catch(() => undefined);
  };
  for (;;) {
    try {
      if (inFlight.size >= MAX_AT_ONCE) await Promise.race(inFlight);
      const r = await api(cfg, "POST", "/local/connect/jobs/claim", { device: cfg.device }, 40_000);
      const job = r?.job;
      if (!job) continue;
      const p = answer(job).catch(() => undefined);
      inFlight.add(p);
      void p.finally(() => inFlight.delete(p));
    } catch (e) {
      if (e instanceof Refused) {
        say(String(e.message));
        stopAll();
        process.exit(1);
      }
      await sleep(10_000);
    }
  }
}

// ---------------------------------------------------------------- commands

// Run as a program (how it is installed and how the runner calls it); imported (tests), only its functions.
const direct = (() => {
  try {
    return realpathSync(resolve(process.argv[1] ?? "")) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (direct) {
  if (flag("guard")) {
    await guardHook(option("guard") ?? "claude-code");
  } else if (flag("complete")) {
    // One prompt on stdin, the answer on stdout: what the workflow runner calls for every AI step.
    let prompt = "";
    for await (const chunk of process.stdin) prompt += chunk;
    const cfg = loadConfig() ?? {};
    const found = await detect();
    let target = option("complete") ?? "auto";
    // A step that names a model (WORKSPACE_MODEL, set by the runner) gets it when the AI has such a model.
    const stepModel = process.env.WORKSPACE_MODEL;
    try {
      const [id] = (target === "auto" ? String(cfg.prefer || found.find((f) => f.kind === "agent")?.id || found[0]?.id || "") : target).split(":");
      const meta = found.find((f) => f.id === id);
      if (stepModel && meta && (meta.kind === "agent" ? id === "claude-code" : meta.models?.includes(stepModel))) target = `${id}:${stepModel}`;
      if (meta?.cloud) {
        const r = await checkText(cfg, id, prompt);
        if (r.action === "block") throw new Error(`Not sent: this step contains ${r.names ?? "sensitive data"}, and your company blocks sending it to AI outside this computer.`);
        if (r.action === "redact" && r.text) prompt = r.text;
      }
      // The runner is watching (WORKSPACE_ACTIVITY): the agent's own lines about what it does go to it on stderr.
      const onEvent = process.env.WORKSPACE_ACTIVITY === "1" ? (line) => process.stderr.write(`::workspace-claude:: ${line}\n`) : undefined;
      const out = await complete(target, { prompt, ...(onEvent ? { onEvent } : {}) }, found, cfg);
      process.stdout.write(`${out.text}\n`);
    } catch (e) {
      console.error(String(e.message ?? e));
      process.exit(1);
    }
  } else if (flag("status")) {
    const cfg = loadConfig();
    const found = await detect();
    say(
      found.length
        ? found.map((f) => `✓ ${f.name}${f.models ? `: ${f.models.slice(0, 5).join(", ")}${f.models.length > 5 ? "…" : ""}` : ""}`).join("\n")
        : "No AI found on this computer.",
    );
    if (!cfg?.url) say("Not connected to a workspace yet.");
    else
      await api(cfg, "POST", "/local/connect/heartbeat", { device: cfg.device, os: platform(), version: VERSION, found, state: {}, probe: true })
        .then(() => say(`✓ Connected to ${cfg.url} as “${cfg.device}”.`))
        .catch((e) => say(`✕ ${e.message}`));
  } else if (flag("uninstall")) {
    autostart(false);
    removeClaudeHook();
    rmSync(CONFIG, { force: true });
    say("Disconnected: it no longer starts with the computer, the safety-net hook is removed and the connection code is forgotten.");
  } else {
    await main();
  }
}
