#!/usr/bin/env node
/**
 * The second half of the live demo's data, after seed-demo.mjs with SEED_COMPANY=tooling/live-demo/company.mjs: labels
 * and comments on tasks, meetings with agenda, minutes and action items, chat spread over the past week, status
 * updates and decisions. Through the API as the people who say it; then the dates go back, which the API never does.
 * Same environment as seed-demo.mjs, on the throwaway database only.
 */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { lit, runSql } from "../scripts/seed-demo-ai.mjs";
import { CHANNELS, DECISIONS, DEPENDENCIES, EXTRA_CHAT, EXTRA_MEETINGS, PROJECTS, STATUS, UNREAD, UPDATES, company } from "./company.mjs";
import { ASK, BOARDS, FILES, FOLDERS, HOLIDAYS, OWNED, OWNER_TASKS, RUNNERS, RUNS, SAVED, TOPIC_LABELS } from "./company-more.mjs";

const ROOT = resolve(import.meta.dirname, "../..");
const GW = process.env.GATEWAY_URL;
const DB = process.env.SEED_DATABASE_URL;
const { people } = company("example.com");
const password = process.env.SEED_PASSWORD ?? JSON.parse(readFileSync(join(ROOT, ".seed-demo.json"), "utf8")).password;

const tokens = new Map();
async function token(who) {
  if (!tokens.has(who)) {
    const body =
      who === "owner" ? { email: process.env.SEED_OWNER_EMAIL, password: process.env.SEED_OWNER_PASSWORD } : { email: people.find((p) => p.key === who).email, password };
    const r = await fetch(`${GW}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (!r.ok) throw new Error(`sign-in as ${who}: ${r.status}`);
    tokens.set(who, (await r.json()).accessToken);
  }
  return tokens.get(who);
}
async function api(who, method, path, body) {
  const r = await fetch(`${GW}${path}`, {
    method,
    headers: { authorization: `Bearer ${await token(who)}`, "content-type": "application/json", "x-locale": "en" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${who} ${method} ${path} → ${r.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

// ── who, when, and how text refers to them ───────────────────────────────
const id = {};
for (const m of (await api("owner", "GET", "/api/identity/members")).members) {
  const p = people.find((x) => x.email === m.email.toLowerCase());
  id[p ? p.key : "owner"] = m.userId;
}
const DAY = 86400_000;
const today = new Date().toISOString().slice(0, 10);
/** `n` working days from today (negative: back) at HH:MM, as a Date. */
function when(n, time = "12:00") {
  let t = Date.parse(`${today}T${time}:00Z`);
  for (let left = Math.abs(n); left > 0; ) {
    t += Math.sign(n) * DAY;
    if (![0, 6].includes(new Date(t).getUTCDay())) left--;
  }
  return new Date(t);
}
const projectId = {};
const { projects } = await api("owner", "GET", "/api/work/projects");
for (const p of PROJECTS) projectId[p.key] = projects.find((x) => x.name === p.name).id;
// Top-level tasks from the database: a board's answer shows only the first cards of each column.
const pg = createRequire(join(ROOT, "backend/server/package.json"))("pg");
const db = new pg.Client({ connectionString: DB });
await db.connect();
const allTasks = async () => (await db.query("SELECT id, code, title FROM work.tasks WHERE parent_id IS NULL")).rows;
const tasks = await allTasks();
const task = (start) => {
  const t = tasks.find((x) => x.title.startsWith(start));
  if (!t) throw new Error(`no task starts with "${start}"`);
  return t;
};
const say = (text) => text.replace(/@\{(\w+)\}/g, (_, k) => `<@${id[k]}>`).replace(/\{\{([^}]+)\}\}/g, (_, s) => task(s).code);

const sql = [];
const at = (table, where, date, col = "created_at") => sql.push(`UPDATE ${table} SET ${col} = ${lit(date)} WHERE ${where};`);
const hoursAgo = (h) => new Date(Date.now() - h * 3600_000);

// ── tasks ────────────────────────────────────────────────────────────────
for (const p of PROJECTS)
  for (const [title, , , , , x = {}] of p.tasks) {
    const t = task(title);
    if (x.labels) {
      const full = (await api("owner", "GET", `/api/work/tasks/${t.id}`)).task;
      await api(p.owner, "PATCH", `/api/work/tasks/${t.id}`, {
        expectedVersion: full.version,
        labels: x.labels,
        ...(x.start === undefined ? {} : { startAt: new Date(Date.parse(`${today}T09:00:00Z`) + x.start * DAY).toISOString() }),
      });
    }
    for (const [who, ago, text] of x.comments ?? []) {
      const c = await api(who, "POST", `/api/work/tasks/${t.id}/comments`, { body: say(text) });
      at("work.task_comments", `task_id = ${lit(t.id)} AND id = ${lit(c?.id ?? c?.comment?.id)}`, hoursAgo(ago));
    }
  }
for (const [waits, on] of DEPENDENCIES)
  await api(PROJECTS.find((p) => p.tasks.some((t) => t[0].startsWith(waits))).owner, "POST", `/api/work/tasks/${task(waits).id}/dependencies`, { predecessorId: task(on).id });

// ── projects: status updates, decisions ──────────────────────────────────
for (const [project, who, days, health, body] of UPDATES) {
  await api(who, "POST", `/api/work/projects/${projectId[project]}/updates`, { health, body });
  at("work.project_updates", `project_id = ${lit(projectId[project])} AND body = ${lit(body)}`, when(-days, "16:30"));
}
for (const [who, project, title, details, decider, decided] of DECISIONS) {
  const d = await api(who, "POST", "/api/work/decisions", { title, details, projectId: projectId[project], deciderId: id[decider] });
  // One's own decision is settled as it is recorded.
  if (decided && decider !== who) await api(decider, "POST", `/api/work/decisions/${d.id}/settle`, { action: "decide" });
}

// ── meetings ─────────────────────────────────────────────────────────────
for (const [title, day, time, minutes, organizer, attendees, location, project, agenda, notes, items] of EXTRA_MEETINGS) {
  const start = when(day, time);
  const made = await api(organizer, "POST", "/api/work/calendar/events", {
    title,
    kind: "meeting",
    startsAt: start.toISOString(),
    endsAt: new Date(start.getTime() + minutes * 60_000).toISOString(),
    attendeeIds: [...new Set(attendees)].filter((k) => k !== organizer).map((k) => id[k]),
    location,
    projectId: project && projectId[project],
  });
  const eventId = made.id ?? made.event?.id ?? made.ids?.[0];
  const { event } = await api(organizer, "GET", `/api/work/meetings/${eventId}`);
  await api(organizer, "PATCH", `/api/work/meetings/${eventId}`, { expectedVersion: event.version, agenda, notes });
  // Past meetings were answered; for the coming ones most people have, the owner not always.
  let n = 0;
  for (const who of attendees.filter((k) => k !== organizer)) {
    n++;
    if (day > 0 && (who === "owner" ? day > 2 : n % 4 === 0)) continue;
    sql.push(`UPDATE work.event_attendees SET response = 'accepted' WHERE event_id = ${lit(eventId)} AND user_id = ${lit(id[who])};`);
  }
  for (const [item, who, due, status] of items) {
    const t = await api(organizer, "POST", "/api/work/tasks", {
      title: item,
      description: `From **${title}**, ${start.toISOString().slice(0, 10)}.`,
      assigneeId: id[who],
      projectId: project && projectId[project],
      dueAt: when(due, "17:00").toISOString(),
      source: { type: "meeting", eventId },
      status,
    });
    at("work.tasks", `id = ${lit(t.id)}`, new Date(start.getTime() + minutes * 60_000));
    if (status === "done") at("work.tasks", `id = ${lit(t.id)}`, when(due, "15:00"), "completed_at");
  }
}

// ── chat ─────────────────────────────────────────────────────────────────
const { channels } = await api("owner", "GET", "/api/chat/channels");
const channelId = Object.fromEntries(CHANNELS.map((c) => [c.name, channels.find((x) => x.name === c.name).id]));
const lastSeq = {};
const said = [...EXTRA_CHAT].sort((a, b) => b[2] - a[2] || a[3].localeCompare(b[3]));
let n = 0;
const join1 = new Set();
for (const [channel, who, day, time, text, x] of said) {
  if (channel.startsWith("dm:")) channelId[channel] ??= (await api("owner", "POST", "/api/chat/dms", { userId: id[channel.slice(3)] })).id;
  const ch = channelId[channel];
  const join = async (k) => {
    if (k === "owner" || channel.startsWith("dm:") || join1.has(k + ch)) return;
    join1.add(k + ch);
    await api(k, "POST", `/api/chat/channels/${ch}/join`, {});
  };
  for (const k of [who, ...Object.values(x.r ?? {}).flat(), ...(x.t ?? []).map((t) => t[0]), ...Object.keys(x.votes ?? {})]) await join(k);
  const post = (k, body, threadRootId = null) => api(k, "POST", `/api/chat/channels/${ch}/messages`, { body: say(body), clientMsgId: `live-demo-${n++}`, threadRootId });
  const m = x.poll ? await api(who, "POST", `/api/chat/channels/${ch}/polls`, { question: text, options: x.poll }) : await post(who, text);
  at("chat.messages", `id = ${lit(m.id)}`, when(-day, time));
  lastSeq[channel] = [...(lastSeq[channel] ?? []), m.seq];
  for (const [k, option] of Object.entries(x.votes ?? {})) await api(k, "POST", `/api/chat/messages/${m.id}/vote`, { optionIds: [option] });
  for (const [k, t, body] of x.t ?? []) {
    const r = await post(k, body, m.id);
    at("chat.messages", `id = ${lit(r.id)}`, when(-day, t));
    at("chat.messages", `id = ${lit(m.id)}`, when(-day, t), "last_reply_at");
  }
  for (const [emoji, who2] of Object.entries(x.r ?? {})) for (const k of who2) await api(k, "POST", `/api/chat/messages/${m.id}/reactions`, { emoji });
  if (x.pin) await api("owner", "POST", `/api/chat/messages/${m.id}/pin`);
}
for (const ch of Object.keys(lastSeq)) {
  const seq = lastSeq[ch].at(-1) + 50;
  const read = UNREAD[ch] ? (lastSeq[ch].at(-1 - UNREAD[ch]) ?? 0) : seq;
  await api("owner", "POST", `/api/chat/channels/${channelId[ch]}/read`, { seq: Math.max(0, read) });
}
for (const [who, emoji, text] of STATUS) await api(who, "PUT", "/api/chat/me/status", { emoji, text });

// ── the owner's own work ─────────────────────────────────────────────────
for (const [title, status, priority, due, project, labels, description, comments] of OWNER_TASKS) {
  const made = await api("owner", "POST", "/api/work/tasks", {
    title,
    description,
    assigneeId: id.owner,
    priority,
    projectId: project && projectId[project],
    dueAt: new Date(Date.parse(`${today}T17:00:00Z`) + due * DAY).toISOString(),
    status,
  });
  const full = (await api("owner", "GET", `/api/work/tasks/${made.id}`)).task;
  await api("owner", "PATCH", `/api/work/tasks/${made.id}`, { expectedVersion: full.version, labels });
  for (const [who, ago, text] of comments) {
    const c = await api("owner", "POST", `/api/work/tasks/${made.id}/comments`, { body: text });
    sql.push(`UPDATE work.task_comments SET author_id = ${lit(id[who])}, created_at = ${lit(hoursAgo(ago))} WHERE id = ${lit(c?.id ?? c?.comment?.id)};`);
  }
  at("work.tasks", `id = ${lit(made.id)}`, hoursAgo(status === "done" ? 150 : 60));
  if (status === "done") at("work.tasks", `id = ${lit(made.id)}`, hoursAgo(-due * 24 - 2), "completed_at");
}
tasks.push(...(await allTasks()).filter((t) => !tasks.some((x) => x.id === t.id)));
sql.push(`UPDATE work.tasks SET owner_id = ${lit(id.owner)} WHERE id IN (${OWNED.map((s) => lit(task(s).id)).join(", ")});`);

// ── saved messages, holidays, announcements people have read ─────────────
for (const [channel, part] of SAVED)
  sql.push(
    `INSERT INTO chat.saved_messages (user_id, message_id, saved_at) SELECT ${lit(id.owner)}, id, now() - interval '3 hours' FROM chat.messages WHERE channel_id = ${lit(channelId[channel])} AND body ILIKE ${lit(`%${part}%`)} LIMIT 1;`,
  );
for (const [day, name] of HOLIDAYS) sql.push(`INSERT INTO employee.holidays (day, name) VALUES (${lit(day)}, ${lit(name)}) ON CONFLICT DO NOTHING;`);
sql.push(
  `INSERT INTO employee.announcement_reads (announcement_id, user_id, read_at) SELECT a.id, u.id, now() - interval '1 hour' * (1 + abs(hashtext(a.id || u.id)) % 30)
     FROM employee.announcements a CROSS JOIN unnest(${lit(Object.values(id))}) AS u(id) WHERE u.id <> ${lit(id.owner)} AND abs(hashtext(u.id || a.id)) % 5 > 0 ON CONFLICT DO NOTHING;`,
  TOPIC_LABELS,
);

// ── the company's AI: what the owner asked, and the answers ──────────────
let last = 0;
/** A ULID at `date`; the same millisecond never twice, so order holds. */
const ulid = (date) => {
  const A = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let t = Math.max(1, date.getTime() + (last++ % 900));
  let out = "";
  for (let i = 0; i < 10; i++, t = Math.floor(t / 32)) out = A[t % 32] + out;
  return out + [...randomBytes(16)].map((b) => A[b % 32]).join("");
};
const docs = (await db.query("SELECT id, title FROM work.documents")).rows;
const source = (s) => {
  if (s.task) {
    const x = task(s.task);
    return { type: "task", id: x.id, title: `${x.code} ${x.title}`, url: `/app/work/tasks/${x.code}` };
  }
  if (s.doc) {
    const x = docs.find((d) => d.title === s.doc);
    return { type: "document", id: x.id, title: x.title, url: `/app/work/docs/${x.id}` };
  }
  const x = projects.find((p) => p.id === projectId[s.project]);
  return { type: "project", id: x.id, title: x.name, url: `/app/work/projects/${x.code}` };
};
const json = (v) => (v === undefined ? "NULL" : `${lit(JSON.stringify(v))}::jsonb`);
sql.push(
  `DELETE FROM ai.ai_messages WHERE conversation_id IN (SELECT id FROM ai.ai_conversations WHERE user_id = ${lit(id.owner)} AND source = 'company');`,
  `DELETE FROM ai.ai_conversations WHERE user_id = ${lit(id.owner)} AND source = 'company';`,
);
for (const [ago, topic, helpful, turns] of ASK) {
  const start = hoursAgo(ago);
  const conv = ulid(start);
  const end = new Date(start.getTime() + (turns.length - 1) * 180_000 + 20_000);
  sql.push(
    `INSERT INTO ai.ai_conversations (id, user_id, source, title, model, topic, messages, started_at, last_at, helpful, helpful_at) VALUES (${[conv, id.owner, "company", turns[0][0].slice(0, 80), "qwen3:8b", topic, turns.length, start, end, helpful, end].map(lit).join(", ")});`,
  );
  turns.forEach(([q, a, x], i) => {
    const asked = new Date(start.getTime() + i * 180_000);
    const answered = new Date(asked.getTime() + 14_000);
    const steps = x.steps?.map((text, n) => ({ id: `s${n}`, tool: "workspace", text, state: "done" }));
    const extras = { ...(steps ? { steps } : {}), ...(x.next?.length ? { followUps: x.next } : {}) };
    sql.push(
      `INSERT INTO ai.ai_messages (id, conversation_id, role, content, at) VALUES (${[ulid(asked), conv, "user", q, asked].map(lit).join(", ")});`,
      `INSERT INTO ai.ai_messages (id, conversation_id, role, content, at, sources, blocks, extras) VALUES (${[ulid(answered), conv, "assistant", say(a), answered].map(lit).join(", ")}, ${json(x.sources?.map(source))}, ${json(x.blocks)}, ${json(extras)});`,
    );
  });
}

// ── agent runs ───────────────────────────────────────────────────────────
const flows = (await db.query("SELECT id, name, runner, steps, config, template FROM work.agent_workflows")).rows;
for (const [template, title, who, ago, status, outputs, minutes] of RUNS) {
  const w = flows.find((f) => f.template === template);
  const t = task(title);
  if (!w) throw new Error(`no workflow from ${template}`);
  const stop = status === "done" ? w.steps.length : status === "failed" ? w.steps.findIndex((s) => s.kind === "ai") : w.steps.map((s) => s.kind).lastIndexOf("approval");
  let clock = hoursAgo(ago).getTime();
  const each = (minutes * 60_000) / Math.max(1, Math.min(stop, w.steps.length));
  let tokens = 0;
  const steps = w.steps.map((s, i) => {
    if (i > stop) return { ...s, state: "pending" };
    const startedAt = new Date(clock).toISOString();
    if (i === stop)
      return {
        ...s,
        startedAt,
        state: status === "failed" ? "failed" : "waiting",
        ...(status === "failed" ? { finishedAt: startedAt, output: "The computer went to sleep." } : {}),
      };
    clock += s.kind === "status" ? 1000 : s.kind === "approval" ? each * 2 : each;
    const finishedAt = new Date(clock).toISOString();
    tokens += s.kind === "ai" ? 2400 : 0;
    return {
      ...s,
      state: "done",
      startedAt,
      finishedAt,
      ...(s.kind === "ai" || s.kind === "command" ? { output: say(outputs[s.key] ?? "Done.") } : {}),
      ...(s.kind === "ai" ? { ran: { model: w.runner === "local" ? "claude" : "qwen3:8b", inputTokens: 1900, outputTokens: 500, ms: Math.round(each) } } : {}),
      ...(s.kind === "check" ? { output: "Passed.", verdict: { pass: true, issues: [], round: 1, at: finishedAt } } : {}),
      ...(s.kind === "approval" ? { history: [{ at: finishedAt, kind: "approved", by: id[who] }] } : {}),
    };
  });
  const over = status === "done" || status === "failed";
  sql.push(
    `INSERT INTO work.task_agent_runs (id, task_id, workflow_id, workflow_name, runner, status, current_step, steps, error, started_by, config, usage, created_at, updated_at, finished_at) VALUES (${[ulid(hoursAgo(ago)), t.id, w.id, w.name, w.runner, status, Math.min(stop, w.steps.length - 1)].map(lit).join(", ")}, ${json(steps)}, ${lit(status === "failed" ? "The computer went to sleep." : null)}, ${lit(id[who])}, ${json(w.config)}, ${json({ inputTokens: Math.round(tokens * 0.8), outputTokens: Math.round(tokens * 0.2) })}, ${lit(hoursAgo(ago))}, ${lit(new Date(clock))}, ${over ? lit(new Date(clock)) : "NULL"});`,
    `UPDATE work.tasks SET workflow_id = ${lit(w.id)} WHERE id = ${lit(t.id)};`,
  );
}
RUNNERS.forEach(([who, device, agent, os]) =>
  sql.push(
    `INSERT INTO work.agent_runners (id, user_id, device, agent, os, version, last_seen_at) VALUES (${[ulid(new Date()), id[who], device, agent, os, "1.0.3"].map(lit).join(", ")}, now() + interval '2 hours');`,
  ),
);

// ── the Drive: names only, nobody downloads from a demo ──────────────────
const folder = {};
for (const [name, who] of Object.entries(FOLDERS)) {
  folder[name] = (await api(who, "POST", "/api/work/drive/folders", { name, parentId: null })).id;
  sql.push(`UPDATE work.drive_items SET visibility = 'workspace', owner_id = ${lit(id.owner)}, created_at = now() - interval '60 days' WHERE id = ${lit(folder[name])};`);
}
for (const [place, name, type, kb, who, days, star] of FILES) {
  const date = when(-days, "14:20");
  const [file, item] = [ulid(date), ulid(date)];
  sql.push(
    `INSERT INTO work.files (id, object_key, name, content_type, size, status, owner_id, attached_type, attached_id, created_at) VALUES (${[file, `demo/${file}`, name, type, kb * 1024, "active", id[who], "drive", item, date].map(lit).join(", ")});`,
    `INSERT INTO work.drive_items (id, kind, name, parent_id, owner_id, file_id, size, content_type, visibility, created_at, updated_at) VALUES (${[item, "file", name, place && folder[place], id[who], file, kb * 1024, type, "workspace", date, date].map(lit).join(", ")});`,
    ...(star ? [`INSERT INTO work.drive_stars (item_id, user_id) VALUES (${lit(item)}, ${lit(id.owner)});`] : []),
  );
}

// ── whiteboards: plain Excalidraw elements, and the same shapes as the card's picture ─────────────────────────────
function draw(board) {
  const elements = [];
  const svg = [];
  const INK = "#18181B";
  const el = (type, x, y, width, height, more = {}) => {
    const e = {
      id: randomBytes(12).toString("base64url"),
      type,
      x,
      y,
      width,
      height,
      angle: 0,
      strokeColor: INK,
      backgroundColor: "transparent",
      fillStyle: "solid",
      strokeWidth: 1,
      strokeStyle: "solid",
      roughness: 0,
      opacity: 100,
      groupIds: [],
      frameId: null,
      index: `a${"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"[elements.length] ?? `zz${elements.length}`}`,
      roundness: null,
      seed: 1 + elements.length,
      version: 1,
      versionNonce: 1 + elements.length,
      isDeleted: false,
      boundElements: null,
      updated: Date.now(),
      link: null,
      locked: false,
      ...more,
    };
    elements.push(e);
    return e;
  };
  const esc = (v) => v.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const text = (x, y, w, body, size, align = "left", containerId = null) => {
    const room = Math.max(6, Math.floor(w / (size * 0.52)));
    const lines = body.split(" ").reduce((l, word) => (l.length && `${l.at(-1)} ${word}`.length <= room ? [...l.slice(0, -1), `${l.at(-1)} ${word}`] : [...l, word]), []);
    const h = lines.length * size * 1.35;
    const top = containerId ? y - h / 2 : y;
    const e = el("text", x, top, w, h, {
      text: lines.join("\n"),
      originalText: body,
      fontSize: size,
      fontFamily: 6,
      textAlign: align,
      verticalAlign: containerId ? "middle" : "top",
      containerId,
      autoResize: !containerId,
      lineHeight: 1.35,
    });
    lines.forEach((l, i) =>
      svg.push(
        `<text x="${align === "center" ? x + w / 2 : x}" y="${top + (i + 0.78) * size * 1.35}" font-size="${size}" font-family="Nunito, sans-serif" fill="${INK}"${align === "center" ? ' text-anchor="middle"' : ""}>${esc(l)}</text>`,
      ),
    );
    return e;
  };
  const shape = (type, x, y, w, h, fill, stroke, label, size = 20) => {
    const e = el(type, x, y, w, h, { backgroundColor: fill, strokeColor: stroke, roundness: { type: type === "rectangle" ? 3 : 2 } });
    svg.push(
      type === "diamond"
        ? `<polygon points="${x + w / 2},${y} ${x + w},${y + h / 2} ${x + w / 2},${y + h} ${x},${y + h / 2}" fill="${fill}" stroke="${stroke}"/>`
        : `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="14" fill="${fill}" stroke="${stroke}"/>`,
    );
    if (label) e.boundElements = [{ type: "text", id: text(x + 10, y + h / 2, w - 20, label, size, "center", e.id).id }];
    return e;
  };
  text(0, -80, 900, board.title, 32);
  if (board.columns) {
    board.columns.forEach(([heading, color, notes], c) => {
      const x = c * 520;
      shape("rectangle", x, 0, 490, 560, "#F4F4F5", "#E4E4E7");
      text(x + 24, 20, 400, heading, 26);
      notes.forEach((n, i) => shape("rectangle", x + 24 + (i % 2) * 226, 78 + Math.floor(i / 2) * 232, 212, 212, color, "transparent", n));
    });
  } else {
    const nodes = Object.fromEntries(
      board.nodes.map(([key, x, y, label, kind]) => [
        key,
        kind === "diamond" ? shape("diamond", x - 10, y - 20, 260, 150, "#FEF3C7", INK, label) : shape("rectangle", x, y, 240, 90, "#E6EEFE", INK, label),
      ]),
    );
    for (const [a, b] of board.edges) {
      const [from, to] = [nodes[a], nodes[b]];
      const [x1, y1, x2, y2] = [from.x + from.width / 2, from.y + from.height + 4, to.x + to.width / 2, to.y - 4];
      const arrow = el("arrow", x1, y1, Math.abs(x2 - x1), Math.abs(y2 - y1), {
        points: [
          [0, 0],
          [x2 - x1, y2 - y1],
        ],
        lastCommittedPoint: null,
        startBinding: { elementId: from.id, focus: 0, gap: 4 },
        endBinding: { elementId: to.id, focus: 0, gap: 4 },
        startArrowhead: null,
        endArrowhead: "arrow",
        elbowed: false,
      });
      for (const s of [from, to]) s.boundElements = [...(s.boundElements ?? []), { type: "arrow", id: arrow.id }];
      svg.push(`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${INK}" stroke-width="2"/>`);
    }
  }
  const right = Math.max(...elements.map((e) => e.x + e.width));
  const bottom = Math.max(...elements.map((e) => e.y + e.height));
  return {
    elements,
    thumbnail: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-30 -110 ${Math.round(right + 60)} ${Math.round(bottom + 150)}">${svg.join("")}</svg>`,
  };
}
const boardFolder = {};
for (const b of BOARDS) {
  if (b.folder) boardFolder[b.folder] ??= (await api("owner", "POST", "/api/work/whiteboards/folders", { name: b.folder, parentId: null })).id;
}
for (const name of Object.keys(boardFolder))
  sql.push(
    `INSERT INTO work.whiteboard_grants (target_type, target_id, subject_type, subject_id, role) VALUES ('folder', ${lit(boardFolder[name])}, 'everyone', '', 'edit') ON CONFLICT DO NOTHING;`,
  );
for (const s of sql.splice(sql.findIndex((x) => x.includes("INSERT INTO work.whiteboard_grants")))) await runSql(s, DB, ROOT);
for (const b of BOARDS) {
  const made = await api(b.by, "POST", "/api/work/whiteboards", { title: b.title, projectId: b.project && projectId[b.project], folderId: b.folder && boardFolder[b.folder] });
  const ref = made.id ?? made.whiteboard?.id;
  const { elements, thumbnail } = draw(b);
  await api(b.by, "PUT", `/api/work/whiteboards/${ref}/scene`, { baseVersion: 1, scene: { elements, appState: {}, files: {} }, thumbnail });
  sql.push(
    `UPDATE work.whiteboards SET created_at = ${lit(when(-b.days - 5, "10:00"))}, updated_at = ${lit(when(-b.days, "15:40"))} WHERE id = ${lit(ref)};`,
    `INSERT INTO work.whiteboard_grants (target_type, target_id, subject_type, subject_id, role) VALUES ('board', ${lit(ref)}, 'everyone', '', 'edit') ON CONFLICT DO NOTHING;`,
  );
}
await db.end();

// ── dates ────────────────────────────────────────────────────────────────
sql.unshift(
  // What only happened because the seed ran: "joined the channel", creation lines, notifications.
  "DELETE FROM chat.messages WHERE author_type = 'system';",
  "UPDATE chat.channels SET created_at = now() - interval '200 days';",
);
sql.push(
  "UPDATE work.activity a SET at = t.created_at FROM work.tasks t WHERE a.entity_type = 'task' AND a.entity_id = t.id AND a.action = 'created';",
  "UPDATE work.activity a SET at = GREATEST(t.created_at, now() - random() * interval '4 days') FROM work.tasks t WHERE a.entity_type = 'task' AND a.entity_id = t.id AND a.action <> 'created';",
  "UPDATE work.activity SET at = now() - interval '1 day' - random() * interval '9 days' WHERE entity_type <> 'task';",
  // Two that slipped: the partner access that is late, and the last beta answers.
  "UPDATE work.tasks SET due_at = date_trunc('day', now()) - interval '3 days' + interval '17 hours' WHERE title LIKE 'Accounting export%' OR title LIKE 'Beta feedback%';",
  "UPDATE work.approvals SET created_at = now() - interval '3 hours' - random() * interval '3 days';",
  "UPDATE work.approvals SET decided_at = created_at + interval '2 hours' WHERE decided_at IS NOT NULL;",
  "UPDATE employee.announcements SET created_at = x.d, publish_at = x.d, updated_at = x.d FROM (SELECT id, now() - (row_number() OVER (ORDER BY id DESC)) * interval '19 hours' AS d FROM employee.announcements) x WHERE x.id = announcements.id;",
  "UPDATE work.documents SET created_at = now() - interval '9 days' - random() * interval '30 days', updated_at = now() - interval '2 hours' - random() * interval '8 days';",
  "UPDATE work.document_versions v SET created_at = d.updated_at FROM work.documents d WHERE d.id = v.document_id;",
  "UPDATE work.doc_comments SET created_at = now() - random() * interval '3 days';",
  "UPDATE work.decisions SET created_at = now() - random() * interval '6 days';",
  "UPDATE home.notifications SET created_at = now() - interval '20 minutes' - random() * interval '3 days';",
  "UPDATE home.notifications SET read_at = created_at + interval '10 minutes' WHERE created_at < now() - interval '20 hours';",
  `UPDATE employee.employees SET hire_date = current_date - 90 WHERE user_id = ${lit(id.noah)};`,
  "UPDATE ai.ai_prompt_library SET body = replace(body, 'engineering teams who self-host', 'owners of small companies');",
);
await new Promise((r) => setTimeout(r, 5000)); // events still on their way to notifications
for (const s of sql) await runSql(s, DB, ROOT).catch((e) => console.log(`${s.slice(0, 120)}: ${e.message}`));
console.log(`extra: ${tasks.length} tasks, ${ASK.length} AI conversations, ${RUNS.length} runs, ${EXTRA_MEETINGS.length} meetings, ${n} messages, ${sql.length} dates`);
