#!/usr/bin/env node
/**
 * workspace usage: sends the AI token use on this computer to your workspace (Áp dụng AI › Mức sử dụng).
 *
 *   node workspace-usage.mjs --url https://work.your-company.example --key wos_… [--days 90] [--every 30] [--dry-run]
 *
 * Coding agents keep every session as a log on the machine, with the token counts of each turn. One reader per
 * tool (READERS below; adding a tool is adding a reader):
 *   - Claude Code: ~/.claude/projects/**.jsonl (and $CLAUDE_CONFIG_DIR/projects)
 *   - Codex:       ~/.codex/sessions/**.jsonl (or $CODEX_HOME/sessions)
 *   - Gemini CLI:  ~/.gemini/tmp/<project>/chats/session-*.json
 *   - opencode:    ~/.local/share/opencode/storage/message/<session>/*.json (or $XDG_DATA_HOME)
 *   - local models (Ollama, LM Studio, …): the answers workspace-connect.mjs asked them for, which it counts in
 *     ~/.workspace-ai/ledger.jsonl (a model server keeps no log of its own)
 * This script reads only those counts and sends daily totals per tool and model. It never sends what you wrote,
 * what the agent answered, file paths or project names. When a session's git branch or folder names a task
 * (feat/T-123-login, ~/code/T-123), its token total goes to that task as AI help, if you can open that task;
 * only the code is sent, never the branch or folder.
 *
 * --every N keeps running and syncs every N minutes; --dry-run prints what would be sent and sends nothing.
 * Sign in with a personal API key (My profile › Security). Node 22+, no dependencies.
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { basename, dirname, join } from "node:path";
import { createInterface } from "node:readline";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith("--") ? [...acc, [a.slice(2), all[i + 1]?.startsWith("--") ? "true" : (all[i + 1] ?? "true")]] : acc), []),
);
const URL_ = (args.url ?? process.env.WORKSPACE_URL ?? "").replace(/\/$/, "");
const KEY = args.key ?? process.env.WORKSPACE_KEY ?? "";
const DAYS = Math.min(400, Math.max(1, Number(args.days ?? 90)));
const EVERY = Number(args.every ?? 0);
const DRY = args["dry-run"] === "true";
const DEVICE = (args.device ?? hostname()).slice(0, 80);
const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

if (!DRY && (!URL_ || !KEY.startsWith("wos_"))) {
  console.error("usage: node workspace-usage.mjs --url <the address you open workspace at> --key wos_… [--days 90] [--every 30] [--dry-run]");
  process.exit(2);
}

const dayOf = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" });
const localDay = (iso) => dayOf.format(new Date(iso));
/** A task code in a branch or folder name: T-123, ops-42. The workspace keeps only codes of tasks you can open. */
const CODE = /(?:^|[^A-Za-z0-9])([A-Za-z][A-Za-z0-9]{0,9}-\d{1,7})(?![0-9])/g;
/** ClickUp's branch convention: CU-<task id> (synced ClickUp tasks answer to "#<ID>"). */
const CLICKUP = /(?:^|[^A-Za-z0-9])CU-([0-9a-z]{7,12})(?![A-Za-z0-9])/gi;
const codesIn = (...texts) => [
  ...new Set(
    texts
      .filter(Boolean)
      .flatMap((t) => [
        ...[...String(t).matchAll(CLICKUP)].filter((m) => /\d/.test(m[1]) && /[a-z]/i.test(m[1])).map((m) => `#${m[1].toUpperCase()}`),
        ...[...String(t).matchAll(CODE)].filter((m) => !/^CU-/i.test(m[1])).map((m) => m[1].toUpperCase()),
      ]),
  ),
];
const hash = (s) => createHash("sha256").update(s).digest("hex").slice(0, 32);

async function jsonlFiles(dir, since, ext = ".jsonl") {
  const out = [];
  const walk = async (d) => {
    let entries = [];
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile() && e.name.endsWith(ext)) {
        const s = await stat(p).catch(() => null);
        if (s && s.mtimeMs >= since) out.push(p);
      }
    }
  };
  await walk(dir);
  return out;
}

async function* lines(file) {
  const rl = createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const l of rl) if (l) yield l;
}

/** Totals: key "tool|model|day" → counts; sessions: key → { tool, codes, tokens, firstAt, lastAt }. */
function collector() {
  const days = new Map();
  const sessions = new Map();
  const add = (tool, model, iso, sessionId, t, codes) => {
    const day = localDay(iso);
    const k = `${tool}|${model || "unknown"}|${day}`;
    const x = days.get(k) ?? { tool, model: model || "unknown", day, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, turns: 0, ids: new Set() };
    x.input += t.input;
    x.output += t.output;
    x.cacheRead += t.cacheRead;
    x.cacheWrite += t.cacheWrite;
    x.reasoning += t.reasoning;
    x.turns += 1;
    x.ids.add(sessionId);
    days.set(k, x);
    const sk = `${tool}:${sessionId}`;
    const s = sessions.get(sk) ?? { tool, codes: new Set(), tokens: 0, firstAt: iso, lastAt: iso };
    for (const c of codes) s.codes.add(c);
    s.tokens += t.input + t.output + t.cacheRead + t.cacheWrite;
    if (iso < s.firstAt) s.firstAt = iso;
    if (iso > s.lastAt) s.lastAt = iso;
    sessions.set(sk, s);
  };
  return { days, sessions, add };
}

/** Claude Code: assistant records carry message.usage; streamed copies of a turn share message id + request id. */
async function readClaude(c, since, sinceIso) {
  const roots = [join(homedir(), ".claude", "projects"), join(homedir(), ".claude", "transcripts")];
  for (const d of (process.env.CLAUDE_CONFIG_DIR ?? "").split(",").filter(Boolean)) roots.push(join(d, "projects"));
  const files = [...new Set((await Promise.all([...new Set(roots)].map((r) => jsonlFiles(r, since)))).flat())];
  const seen = new Map();
  for (const f of files) {
    for await (const l of lines(f)) {
      if (!l.includes('"assistant"') || !l.includes('"usage"')) continue;
      let r;
      try {
        r = JSON.parse(l);
      } catch {
        continue;
      }
      const u = r?.message?.usage;
      if (r.type !== "assistant" || !u || !r.timestamp || r.timestamp < sinceIso) continue;
      const t = {
        input: u.input_tokens ?? 0,
        output: u.output_tokens ?? 0,
        cacheRead: u.cache_read_input_tokens ?? 0,
        cacheWrite: u.cache_creation_input_tokens ?? 0,
        reasoning: 0,
      };
      if (t.input + t.output + t.cacheRead + t.cacheWrite <= 0) continue;
      const key = r.message.id ? `${r.message.id}:${r.requestId ?? ""}` : (r.uuid ?? null);
      const rec = { model: r.message.model, at: r.timestamp, session: r.sessionId ?? basename(f, ".jsonl"), t, codes: codesIn(r.gitBranch, r.cwd && basename(r.cwd)) };
      if (!key) {
        seen.set(Symbol(), rec);
        continue;
      }
      const prev = seen.get(key);
      // A later copy of the same turn can carry fuller counts.
      if (prev) for (const k of Object.keys(t)) prev.t[k] = Math.max(prev.t[k], t[k]);
      else seen.set(key, rec);
    }
  }
  for (const x of seen.values()) if (x.model !== "<synthetic>") c.add("claude-code", x.model, x.at, x.session, x.t, x.codes);
}

/** Codex: token_count events carry the turn's usage (last_token_usage) or running totals (total_token_usage). */
async function readCodex(c, since, sinceIso) {
  const home = process.env.CODEX_HOME || join(homedir(), ".codex");
  for (const f of await jsonlFiles(join(home, "sessions"), since)) {
    let session = basename(f, ".jsonl");
    let model = null;
    let codes = [];
    let prevTotal = null;
    for await (const l of lines(f)) {
      let r;
      try {
        r = JSON.parse(l);
      } catch {
        continue;
      }
      const p = r?.payload;
      if (!p) continue;
      if (r.type === "session_meta") {
        session = p.id ?? session;
        codes = codesIn(p.git?.branch, p.cwd && basename(p.cwd));
        continue;
      }
      if (r.type === "turn_context") {
        model = p.model ?? model;
        if (p.cwd) codes = [...new Set([...codes, ...codesIn(basename(p.cwd))])];
        continue;
      }
      if (r.type !== "event_msg" || p.type !== "token_count" || !p.info || !r.timestamp) continue;
      const total = p.info.total_token_usage;
      let u = p.info.last_token_usage;
      if (total && prevTotal && total.total_tokens === prevTotal.total_tokens) continue; // the same count again
      if (!u && total) {
        const b = prevTotal ?? {};
        u = Object.fromEntries(Object.keys(total).map((k) => [k, Math.max(0, (total[k] ?? 0) - (b[k] ?? 0))]));
      }
      if (total) prevTotal = total;
      if (!u || r.timestamp < sinceIso) continue;
      const cached = Math.min(u.cached_input_tokens ?? 0, u.input_tokens ?? 0);
      const t = { input: (u.input_tokens ?? 0) - cached, output: u.output_tokens ?? 0, cacheRead: cached, cacheWrite: 0, reasoning: u.reasoning_output_tokens ?? 0 };
      if (t.input + t.output + t.cacheRead <= 0) continue;
      c.add("codex", model, r.timestamp, session, t, codes);
    }
  }
}

const readFileJson = async (f) => {
  try {
    return JSON.parse(await readFile(f, "utf8"));
  } catch {
    return null;
  }
};

/** Gemini CLI: one JSON file per session; each model message carries its tokens (cached ones are part of input). */
async function readGemini(c, since, sinceIso) {
  for (const f of await jsonlFiles(join(homedir(), ".gemini", "tmp"), since, ".json")) {
    if (!/[\\/]chats[\\/]session-/.test(f)) continue;
    const s = await readFileJson(f);
    for (const m of s?.messages ?? []) {
      const k = m?.tokens;
      if (m?.type !== "gemini" || !k || !m.timestamp || m.timestamp < sinceIso) continue;
      const cached = Math.min(k.cached ?? 0, k.input ?? 0);
      const t = { input: (k.input ?? 0) - cached, output: k.output ?? 0, cacheRead: cached, cacheWrite: 0, reasoning: k.thoughts ?? 0 };
      if (t.input + t.output + t.cacheRead <= 0) continue;
      c.add("gemini-cli", m.model, m.timestamp, s.sessionId ?? basename(f, ".json"), t, []);
    }
  }
}

/** opencode: one JSON file per message; assistant messages carry tokens and the model. */
async function readOpencode(c, since, sinceIso) {
  const data = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  for (const f of await jsonlFiles(join(data, "opencode", "storage", "message"), since, ".json")) {
    const m = await readFileJson(f);
    const k = m?.tokens;
    const at = m?.time?.created ? new Date(m.time.created).toISOString() : null;
    if (m?.role !== "assistant" || !k || !at || at < sinceIso) continue;
    const t = { input: k.input ?? 0, output: k.output ?? 0, cacheRead: k.cache?.read ?? 0, cacheWrite: k.cache?.write ?? 0, reasoning: k.reasoning ?? 0 };
    if (t.input + t.output + t.cacheRead + t.cacheWrite <= 0) continue;
    c.add("opencode", m.modelID, at, m.sessionID ?? basename(dirname(f)), t, codesIn(m.path?.cwd && basename(m.path.cwd)));
  }
}

/** Local models: what workspace-connect.mjs counted when it asked one (a line per answer). */
async function readLedger(c, _since, sinceIso) {
  const file = join(process.env.WORKSPACE_AI_HOME || join(homedir(), ".workspace-ai"), "ledger.jsonl");
  if (!(await stat(file).catch(() => null))) return;
  for await (const l of lines(file)) {
    let r;
    try {
      r = JSON.parse(l);
    } catch {
      continue;
    }
    if (!r?.at || r.at < sinceIso || !(r.input + r.output > 0)) continue;
    c.add("local-model", r.model, r.at, localDay(r.at), { input: r.input ?? 0, output: r.output ?? 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }, []);
  }
}

/** One reader per tool; a reader that finds no logs (the tool is not installed) adds nothing. */
const READERS = [readClaude, readCodex, readGemini, readOpencode, readLedger];

async function scan() {
  const since = Date.now() - DAYS * 86_400_000;
  const sinceIso = new Date(since).toISOString();
  const c = collector();
  // A reader that trips over a log format it does not know must not cost the others their counts.
  for (const read of READERS) await read(c, since, sinceIso).catch((e) => console.error(`${read.name}: ${e?.message ?? e}`));
  const rows = [...c.days.values()].map(({ ids, ...x }) => ({ ...x, model: x.model.slice(0, 80), sessions: ids.size }));
  // A session counts for a task only when it names exactly one code (a branch with two codes is ambiguous).
  const sessions = [...c.sessions.entries()]
    .filter(([, s]) => s.codes.size === 1)
    .map(([k, s]) => ({
      key: hash(k),
      tool: s.tool,
      taskCode: [...s.codes][0],
      tokens: s.tokens,
      firstAt: new Date(s.firstAt).toISOString(),
      lastAt: new Date(s.lastAt).toISOString(),
    }));
  return { rows, sessions };
}

async function send({ rows, sessions }) {
  for (let i = 0; i < Math.max(rows.length, 1); i += 4000) {
    const body = { device: DEVICE, timeZone: TZ, rows: rows.slice(i, i + 4000), sessions: i === 0 ? sessions.slice(0, 1000) : [] };
    const r = await fetch(`${URL_}/api/ai/local-usage`, {
      method: "POST",
      headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw await failure("sync failed", r);
  }
}

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
  return new Error(`${what}: HTTP ${r.status} ${msg}`);
}

async function once() {
  const data = await scan();
  // Cache reads are context sent again on every turn, usually most of the count: reported apart, not as new work.
  const total = data.rows.reduce((n, r) => n + r.input + r.output + r.cacheWrite, 0);
  const cacheRead = data.rows.reduce((n, r) => n + r.cacheRead, 0);
  if (DRY) {
    console.log(
      JSON.stringify(
        {
          device: DEVICE,
          timeZone: TZ,
          days: DAYS,
          rows: data.rows.length,
          sessionsWithTask: data.sessions.length,
          tokens: total,
          cacheReadTokens: cacheRead,
          sample: data.rows.slice(0, 5),
        },
        null,
        2,
      ),
    );
    return;
  }
  await send(data);
  console.log(
    `${new Date().toLocaleString()}  sent ${data.rows.length} day rows, ${total.toLocaleString()} tokens (+${cacheRead.toLocaleString()} cache reads), ${data.sessions.length} sessions linked to a task code`,
  );
}

await once().catch((e) => {
  console.error(String(e?.message ?? e));
  if (!EVERY) process.exit(1);
});
if (EVERY > 0 && !DRY) setInterval(() => void once().catch((e) => console.error(String(e?.message ?? e))), EVERY * 60_000);
