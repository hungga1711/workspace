#!/usr/bin/env node
/**
 * Fills the existing workspace with the Workspace open-source team (seed-demo-company.mjs), in English, through the
 * public API: five members (invited with a temporary password that each one then changes, so no email is sent), two
 * departments, three projects with their tasks, goals, leave, announcements, approvals, documents, meetings, chat
 * and the tech-team workflow templates, and outside AI use through the extension intake. Then, straight into the
 * database (the API never backdates): eight weeks of finished work and AI Insights history, and four weeks of attendance.
 *
 *   pnpm seed:demo
 *   pnpm seed:demo -- --docs-only    # spaces, pages, comments and stars on an already-seeded workspace
 *   pnpm seed:demo -- --task-descs   # fill task descriptions from seed-demo-company.mjs
 *
 * Needs the server (`pnpm dev:server`) running. Re-running is safe: members that already exist are reused,
 * and once the first project exists the script stops (unless --docs-only or --task-descs).
 *
 * Env: GATEWAY_URL (optional); SEED_OWNER_EMAIL and SEED_OWNER_PASSWORD (the owner you created at
 * /setup; remembered in .seed-demo.json after the first run); SEED_EMAIL_DOMAIN for the members' addresses (default
 * example.com); SEED_PASSWORD for the demo members (optional: a random one is generated, printed at the end and
 * remembered in .seed-demo.json so re-runs can sign in again); SEED_TZ_OFFSET, the workspace's UTC offset in hours
 * for meeting and check-in times (default 0: London in winter, and the public demo's UTC).
 */

import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { aiInsightsSql, lit, prng, runSql } from "./seed-demo-ai.mjs";
import { balanceSql } from "./seed-demo-balance.mjs";
import {
  ANNOUNCEMENTS,
  APPROVALS,
  CELEBRATE,
  CHANNELS,
  CHAT,
  DEPARTMENTS,
  DOC_SPACES,
  DOCS,
  EXTENSION,
  GOALS,
  LEAVE,
  MEETINGS,
  company,
  deptName,
  taskDescriptions,
} from "./seed-demo-company.mjs";

const GW = process.env.GATEWAY_URL ?? "http://localhost:4000";
// The public demo locks invitations and activation for visitors; its seed gets through with the server's secret.
const SEED_HEADERS = process.env.DEMO_SEED_SECRET ? { "x-demo-seed": process.env.DEMO_SEED_SECRET } : {};
// Credentials never live in the script (it is public): the owner's come from /setup, the members' are generated.
const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const STATE_FILE = join(ROOT, ".seed-demo.json");
const state = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, "utf8")) : {};
// Member addresses: example.com by default; another (reserved) domain lets a second demo workspace share a database
// whose addresses are unique across workspaces, as in development.
const EMAIL_DOMAIN = process.env.SEED_EMAIL_DOMAIN ?? "example.com";
const OWNER_EMAIL = process.env.SEED_OWNER_EMAIL ?? state.ownerEmail ?? "admin@example.com";
const OWNER_PASSWORD = process.env.SEED_OWNER_PASSWORD ?? state.ownerPassword;
if (!OWNER_PASSWORD) {
  console.error(`Set SEED_OWNER_PASSWORD (and SEED_OWNER_EMAIL, default ${OWNER_EMAIL}) to the owner you created at /setup.`);
  process.exit(1);
}
const PASSWORD = process.env.SEED_PASSWORD ?? state.password ?? `Demo${randomBytes(6).toString("base64url")}1`;
writeFileSync(STATE_FILE, JSON.stringify({ ownerEmail: OWNER_EMAIL, ownerPassword: OWNER_PASSWORD, password: PASSWORD }, null, 2) + "\n", { mode: 0o600 });

const TZ_OFFSET_HOURS = Number(process.env.SEED_TZ_OFFSET ?? 0);
const DATABASE_URL = process.env.SEED_DATABASE_URL ?? process.env.MIGRATE_DATABASE_URL ?? "postgres://workspace_owner:owner_pw@localhost:5432/workspace";

const { people: PEOPLE, projects: PROJECTS, history: HISTORY, at } = company(EMAIL_DOMAIN);

// ---------------------------------------------------------------- plumbing

const tokens = new Map(); // email → { token, exp }

async function signIn(email, password) {
  const hit = tokens.get(email);
  if (hit && hit.exp > Date.now() + 30_000) return hit.token;
  const res = await fetch(`${GW}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", ...SEED_HEADERS },
    body: JSON.stringify({ email, password }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.accessToken) throw new Error(`sign-in failed for ${email}: ${res.status} ${body.error ?? (body.mfa ? "two-step sign-in is on" : "")}`);
  tokens.set(email, { token: body.accessToken, exp: Date.now() + body.expiresIn * 1000 });
  return body.accessToken;
}

class ApiError extends Error {
  constructor(method, path, status, body) {
    super(`${method} ${path} → ${status} ${JSON.stringify(body)}`);
    this.status = status;
    this.body = body;
  }
}

/** Calls the gateway as `who` (a person key, or "owner"). */
async function api(who, method, path, body) {
  const person = who === "owner" ? { email: OWNER_EMAIL, password: OWNER_PASSWORD } : { email: byKey(who).email, password: PASSWORD };
  const token = await signIn(person.email, person.password);
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${GW}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-locale": "en",
        ...SEED_HEADERS,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (res.status === 429 && attempt < 5) {
      await sleep(2000 * (attempt + 1));
      continue;
    }
    const text = await res.text();
    const data = text ? safeJson(text) : null;
    if (!res.ok) throw new ApiError(method, path, res.status, data);
    return data;
  }
}

const safeJson = (t) => {
  try {
    return JSON.parse(t);
  } catch {
    return t;
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const byKey = (key) => {
  const p = PEOPLE.find((x) => x.key === key);
  if (!p) throw new Error(`unknown person ${key}`);
  return p;
};
const ids = new Map(); // person key (and "owner") → user id
const uid = (key) => {
  const id = ids.get(key);
  if (!id) throw new Error(`no user id for ${key}`);
  return id;
};
/** Runs `fn` over `items`, `n` at a time: a hundred people one by one is slow, all at once trips the rate limits. */
async function pool(items, n, fn) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        await fn(items[i], i);
      }
    }),
  );
}

/** A moment `days` from today at `hour`:`minute` in the workspace's time zone (TZ_OFFSET_HOURS), as ISO. */
function localTime(days, hour, minute = 0) {
  const now = new Date(Date.now() + TZ_OFFSET_HOURS * 3600_000); // wall clock in the workspace's zone
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + days, hour - TZ_OFFSET_HOURS, minute));
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}
/** The workspace's calendar day `days` from today, YYYY-MM-DD. */
const localDay = (days) => localTime(days, 12).slice(0, 10);
const weekend = (days) => [0, 6].includes(new Date(`${localDay(days)}T12:00:00Z`).getUTCDay());
/**
 * `n` working days from today as calendar days (negative: back), so meetings and leave land on weekdays whichever
 * day the seed runs; today itself stays today.
 */
function workday(n) {
  let d = 0;
  for (let left = Math.abs(n), step = Math.sign(n); left > 0;) {
    d += step;
    if (!weekend(d)) left--;
  }
  return d;
}

const counts = {};
const bump = (k, n = 1) => (counts[k] = (counts[k] ?? 0) + n);
const problems = [];
/** Runs one optional step; a failure is reported at the end instead of stopping the whole seed. */
async function soft(label, fn) {
  try {
    return await fn();
  } catch (e) {
    problems.push(`${label}: ${e.message}`);
    return undefined;
  }
}

// ---------------------------------------------------------------- passwords

/** Members start on a temporary password (set by the owner) and change it to the demo one themselves, as people do. */
const tempPassword = () => `${PASSWORD}-tmp`;

async function changeToDemoPassword(email) {
  const temp = tempPassword();
  tokens.delete(email);
  const token = await signIn(email, temp);
  const res = await fetch(`${GW}/api/identity/me/password`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...SEED_HEADERS },
    body: JSON.stringify({ current: temp, next: PASSWORD }),
  });
  if (!res.ok) throw new Error(`password change failed for ${email}: ${res.status} ${await res.text()}`);
  tokens.delete(email);
}
const canSignIn = (email) =>
  signIn(email, PASSWORD).then(
    () => true,
    () => false,
  );

// ---------------------------------------------------------------- steps

async function members() {
  const { members: existing } = await api("owner", "GET", "/api/identity/members");
  const owner = existing.find((m) => m.email.toLowerCase() === OWNER_EMAIL.toLowerCase());
  ids.set("owner", owner?.userId ?? (await api("owner", "GET", "/api/me")).principal.id);
  const roles = (p) => ["Employee", ...(p.role ? [p.role] : []), ...(p.admin ? ["Admin"] : [])];
  await pool(PEOPLE, 6, async (p) => {
    const found = existing.find((m) => m.email.toLowerCase() === p.email);
    if (found) {
      ids.set(p.key, found.userId);
      if (await canSignIn(p.email)) return bump("members reused");
      if (found.status !== "invited") throw new Error(`${p.email} exists but cannot sign in with the demo password`);
      await api("owner", "POST", `/api/identity/members/${found.userId}/password/reset`, { password: tempPassword() });
    } else {
      const r = await api("owner", "POST", "/api/identity/members/invite", { email: p.email, displayName: p.name, roleNames: roles(p), password: tempPassword() });
      ids.set(p.key, r.userId);
      bump("members invited");
      // An account seeded into another workspace earlier is added, not invited: it already has the demo password.
      if (await canSignIn(p.email)) return bump("members reused");
    }
    await changeToDemoPassword(p.email);
    bump("members activated");
  });
  // First call as each member through the gateway (resolves the principal; marks them active). The app greets people
  // by the last word of their name, the Vietnamese given name; these names put it first, so each person sets theirs.
  await pool(PEOPLE, 8, async (p) => {
    await api(p.key, "GET", "/api/me");
    await soft(`given name of ${p.key}`, () => api(p.key, "PUT", "/api/identity/me/name", { givenName: p.name.split(" ")[0] }));
  });
  const ownerName = existing.find((m) => m.userId === uid("owner"))?.displayName;
  if (ownerName) await soft("owner's given name", () => api("owner", "PUT", "/api/identity/me/name", { givenName: ownerName.split(" ")[0] }));
}

const deptIds = new Map(); // department key → employee department id
/** Every task the seed made through the API: the history and AI Insights link to them. */
const seededTasks = [];

const hiredOn = new Map(); // person key → hire date
/** Seniority from the title, for the job level column. */
const level = (p) => (p.head ? "Director" : p.lead ? "Lead" : /Senior/.test(p.title) ? "Senior" : /Junior|Associate|Coordinator|Development Rep/.test(p.title) ? "Junior" : "Mid");

async function org() {
  const { departments: existing } = await api("owner", "GET", "/api/employee/departments");
  for (const d of DEPARTMENTS) {
    const head = PEOPLE.find((p) => p.dept === d.key && p.head);
    const found = existing.find((x) => x.name === d.name);
    if (found) deptIds.set(d.key, found.id);
    else {
      deptIds.set(d.key, (await api("owner", "POST", "/api/employee/departments", { name: d.name, headId: head ? uid(head.key) : null })).id);
      bump("departments");
    }
  }
  const ownerName = (await api("owner", "GET", "/api/identity/members")).members.find((m) => m.userId === uid("owner"))?.displayName ?? "Owner";
  await api("owner", "PUT", `/api/employee/employees/${uid("owner")}`, {
    displayName: ownerName,
    title: "Chief Executive Officer",
    location: "London",
    jobLevel: "Executive",
    hireDate: "2018-03-01",
  });
  // Hire dates: heads joined early, everyone else across the last seven years, and six people this month.
  const rand = prng(1027);
  const hired = (p, i) => {
    if (p.head) return `${2018 + (i % 4)}-0${1 + (i % 9)}-15`;
    if (i % 16 === 5) return localDay(-1 - (i % 20));
    const d = new Date(Date.UTC(2019, 0, 1) + Math.floor(rand() * (Date.now() - Date.UTC(2019, 0, 1) - 60 * 86400_000)));
    return d.toISOString().slice(0, 10);
  };
  await pool(
    PEOPLE.map((p, i) => [p, i]),
    6,
    async ([p, i]) => {
      hiredOn.set(p.key, hired(p, i));
      await api("owner", "PUT", `/api/employee/employees/${uid(p.key)}`, {
        displayName: p.name,
        title: p.title,
        departmentId: deptIds.get(p.dept),
        managerId: uid(p.manager),
        jobLevel: level(p),
        hireDate: hiredOn.get(p.key),
        location: p.location,
      });
      bump("employee profiles");
    },
  );
}

async function projects() {
  const projectIds = new Map();
  // Seeded tasks are all finished "now": a done task due in the past would count as late, so everyone's on-time
  // rate would read 0%. Two in three done tasks keep their due date ahead (finished early); the rest stay late.
  let doneN = 0;
  for (const pr of PROJECTS) {
    const { id } = await api(pr.owner, "POST", "/api/work/projects", { name: pr.name, description: pr.description, dueAt: localTime(pr.due, 17) });
    projectIds.set(pr.key, id);
    bump("projects");
    // The default board's lanes in order (To do, In progress, Review, Done); a column never sets a status, so both are sent.
    const board = await api(pr.owner, "GET", `/api/work/projects/${id}/board`);
    const lane = ["todo", "in_progress", "review", "done"];
    const column = Object.fromEntries(board.columns.map((c, i) => [lane[i], c.id]));
    await pool(pr.tasks, 4, async ([title, status, assignee, priority, seededDue, extra = {}]) => {
      const due = status === "done" && seededDue !== null && seededDue < 0 && doneN++ % 3 !== 2 ? -seededDue : seededDue;
      const task = await api(pr.owner, "POST", "/api/work/tasks", {
        title,
        description: extra.desc ?? "",
        assigneeId: uid(assignee),
        projectId: id,
        priority,
        dueAt: due === null ? null : localTime(due, 17),
        columnId: column[status],
        status,
      });
      bump("tasks");
      seededTasks.push({ id: task.id, title, status, assignee, project: pr.key });
      if (extra.blocked) {
        await soft(`blocker on "${title}"`, async () => {
          await api(pr.owner, "PATCH", `/api/work/tasks/${task.id}`, { expectedVersion: task.version, blockedReason: extra.blocked });
          bump("blocked tasks");
        });
      }
      if (extra.progress !== undefined) {
        await soft(`check-in on "${title}"`, async () => {
          await api(assignee, "POST", `/api/work/tasks/${task.id}/checkin`, { progress: extra.progress, note: extra.progress >= 50 ? "On track." : "Started; more this week." });
          bump("progress check-ins");
        });
      }
      if (extra.comment) {
        await soft(`comment on "${title}"`, async () => {
          await api(extra.comment[0], "POST", `/api/work/tasks/${task.id}/comments`, { body: extra.comment[1] });
          bump("task comments");
        });
      }
      for (const [subTitle, subStatus, subAssignee] of extra.sub ?? []) {
        await api(pr.owner, "POST", "/api/work/tasks", {
          title: subTitle,
          assigneeId: uid(subAssignee),
          projectId: id,
          parentId: task.id,
          dueAt: due === null ? null : localTime(due - 2, 17),
          status: subStatus,
        });
        bump("subtasks");
      }
    });
  }
  return projectIds;
}

async function history(projectIds) {
  for (const h of HISTORY) {
    const pr = PROJECTS.find((x) => x.key === h.project);
    const id = projectIds.get(h.project);
    const board = await api(pr.owner, "GET", `/api/work/projects/${id}/board`);
    const done = board.columns.at(-1)?.id;
    await pool(h.titles, 4, async ([title, assignee, desc]) => {
      const task = await api(pr.owner, "POST", "/api/work/tasks", {
        title,
        description: desc ?? "",
        assigneeId: uid(assignee),
        projectId: id,
        priority: "medium",
        columnId: done,
        status: "done",
      });
      seededTasks.push({ id: task.id, title, status: "done", assignee, project: h.project });
      bump("finished tasks (history)");
    });
  }
}

/** Fills empty (or outdated) task descriptions on an already-seeded workspace from seed-demo-company.mjs. */
async function patchTaskDescriptions() {
  const wanted = taskDescriptions();
  const { projects } = await api("owner", "GET", "/api/work/projects");
  for (const p of projects) {
    const board = await api("owner", "GET", `/api/work/projects/${p.id}/board`);
    for (const col of board.columns ?? []) {
      for (const t of col.tasks ?? []) {
        const desc = wanted.get(t.title);
        if (!desc) continue;
        const full = await api("owner", "GET", `/api/work/tasks/${t.id}`);
        const task = full.task ?? full;
        if (task.description === desc) continue;
        await api("owner", "PATCH", `/api/work/tasks/${t.id}`, { expectedVersion: task.version, description: desc });
        bump("task descriptions");
      }
    }
  }
}

async function aiInsights() {
  // Straight into the database (see seed-demo-ai.mjs), as the owner role like migrations.
  const people = [{ key: "owner", dept: "owner", userId: uid("owner") }, ...PEOPLE.map((p) => ({ key: p.key, dept: p.dept, userId: uid(p.key) }))];
  const { sql, counts: made } = aiInsightsSql({
    people,
    tasks: seededTasks.filter((t) => t.status === "done"),
    openTasks: seededTasks.filter((t) => t.status === "in_progress" || t.status === "todo"),
    deptIds: Object.fromEntries(deptIds),
    staffKey: "minh",
  });
  await runSql(sql, DATABASE_URL, ROOT);
  for (const [k, v] of Object.entries(made)) bump(`AI Insights: ${k}`, v);
}

async function goals(projectIds) {
  const { period } = await api("owner", "GET", "/api/work/goals");
  for (const g of GOALS) {
    await api("owner", "POST", "/api/work/goals", {
      title: g.title,
      ownerId: uid(g.owner),
      department: deptName(g.department),
      period,
      keyResults: g.krs.map((kr) =>
        kr.kind === "project"
          ? { title: kr.title, kind: "project", projectId: projectIds.get(kr.project) }
          : { title: kr.title, kind: "number", start: kr.start, target: kr.target, current: kr.current, unit: kr.unit, ...(kr.direction ? { direction: kr.direction } : {}) },
      ),
    });
    bump("goals");
  }
}

async function extension() {
  // The demo shows AI oversight, which is off by default: switch both AI features on for this workspace
  // (the admin can turn them off again in Admin › AI).
  const ws = await api("owner", "GET", "/api/platform/workspace");
  if (ws?.config && ws.version) {
    const features = { ...ws.config.features, ai: { ...ws.config.features?.ai, assistant: true, monitoring: true } };
    await api("owner", "PUT", "/api/platform/workspace/config", { version: ws.version, config: { ...ws.config, features } });
    console.log("  AI assistant and AI Insights switched on for the demo workspace");
  }
  for (const [who, url, prompts] of EXTENSION) {
    const { token } = await api(who, "POST", "/api/ai/monitor/connection", {});
    const events = prompts.map((prompt, i) => ({ url, prompt, at: new Date(Date.now() - (prompts.length - i) * 3600_000).toISOString() }));
    const res = await fetch(`${GW}/api/ai-monitor/events`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ events }),
    });
    if (!res.ok) throw new Error(`extension intake for ${who}: ${res.status} ${await res.text()}`);
    bump("extension prompts", prompts.length);
  }
}

async function approvals() {
  for (const [byRef, approverRef, kind, title, details, amount, decision] of APPROVALS) {
    const by = at(byRef);
    const approver = at(approverRef);
    const r = await api(by, "POST", "/api/work/approvals", {
      title,
      details,
      approverId: uid(approver),
      kind,
      amount: amount ?? null,
      currency: amount == null ? null : "USD",
    });
    bump("approvals");
    if (decision) {
      await soft(`decision on "${title}"`, async () => {
        await api(approver, "POST", `/api/work/approvals/${r.id}/decision`, { decision: decision[0], comment: decision[1] });
        bump(`approvals ${decision[0]}`);
      });
    }
  }
}

/**
 * Open tasks were all created a moment ago; in a real company they were opened over the past weeks. Each goes back
 * one to six weeks, never after its own due date, so the "created" chart and the week-on-week deltas read naturally.
 */
async function spreadOpenWork() {
  await runSql(
    `BEGIN;
SELECT setseed(0.27);
UPDATE work.tasks SET created_at = LEAST(coalesce(due_at, now()) - interval '3 days', now() - interval '1 day') - random() * interval '35 days'
 WHERE completed_at IS NULL;
UPDATE work.tasks SET updated_at = GREATEST(created_at, now() - random() * interval '6 days') WHERE completed_at IS NULL;
-- A project exists before its first task: Tiến độ draws each project as a bar from its creation to its deadline.
UPDATE work.projects p SET created_at = s.first - interval '4 days' FROM (SELECT project_id, min(created_at) AS first FROM work.tasks GROUP BY project_id) s WHERE s.project_id = p.id AND s.first < p.created_at;
COMMIT;`,
    DATABASE_URL,
    ROOT,
  );
}

const daysOff = new Set(); // "key day" for approved leave: nobody checks in then
async function leave() {
  const year = Number(localDay(0).slice(0, 4));
  // 25 days a year, as UK companies give; the policy makes new joiners get theirs too.
  await soft("leave policy", () =>
    api("owner", "PUT", "/api/employee/settings", {
      workWeek: [1, 2, 3, 4, 5],
      shift: { start: "09:00", end: "17:30", lateAfterMin: 10 },
      leavePolicy: { autoGrant: true, typeCode: "annual", defaultDays: 25, prorate: false, seniority: false, carryOverMax: 5 },
    }),
  );
  await api("owner", "POST", "/api/employee/leave/balances/bulk", { type: "annual", year, entitledDays: 25, onlyMissing: false });
  for (let [ref, type, from, to, status, reason] of LEAVE) {
    const who = at(ref);
    [from, to] = [workday(from), workday(to)];
    if (status === "approved") for (let d = from; d <= to; d++) daysOff.add(`${who} ${localDay(d)}`);
    await soft(`leave for ${who}`, async () => {
      const r = await api(who, "POST", "/api/employee/leave", { type, startDate: localDay(from), endDate: localDay(to), reason });
      bump(`leave requests (${status})`);
      if (status === "approved") await api(byKey(who).manager, "POST", `/api/employee/leave/${r.id}/decision`, { decision: "approved" });
    });
  }
}

async function announcements() {
  for (const [author, category, title, body, pinned, event] of ANNOUNCEMENTS) {
    const payload = { title, body, category, pinned, eventAt: event ? localTime(workday(event[0]), event[1]) : null };
    // Publishing is an admin right: anyone else's announcement goes out under the owner.
    await api(author, "POST", "/api/employee/announcements", payload).catch((e) => {
      if (e.status !== 403) throw e;
      return api("owner", "POST", "/api/employee/announcements", payload);
    });
    bump("announcements");
  }
}

/**
 * Spaces first (each creates a home page), then pages under them, then comments / stars / a few views so Docs home
 * looks lived-in. Re-runs skip spaces and titles that already exist; old flat workspace pages from earlier seeds
 * (no space) with the same title are removed so they do not double up on the home list.
 */
async function docs() {
  const { spaces: existingSpaces } = await api("owner", "GET", "/api/work/spaces");
  const spaces = new Map(existingSpaces.map((s) => [s.key, s])); // key → { id, homeId, … }
  for (const s of DOC_SPACES) {
    const key = s.key.toUpperCase();
    if (spaces.has(key)) continue;
    const created = await api(s.by, "POST", "/api/work/spaces", {
      key,
      name: s.name,
      description: s.description,
      icon: s.icon,
      visibility: "workspace",
      members: [],
    });
    spaces.set(key, created);
    bump("doc spaces");
  }

  const { documents: existingDocs } = await api("owner", "GET", "/api/work/docs");
  // Drop the pre-space flat copies so the home list is only the tree under spaces.
  const seededTitles = new Set(DOCS.map((d) => d.title));
  for (const d of existingDocs) {
    if (d.spaceId || !seededTitles.has(d.title)) continue;
    await api("owner", "DELETE", `/api/work/docs/${d.id}`).catch(() => undefined);
    bump("old flat documents removed");
  }

  const { documents: afterCleanup } = await api("owner", "GET", "/api/work/docs");
  const byTitleInSpace = new Map(afterCleanup.filter((d) => d.spaceId).map((d) => [`${d.spaceId}:${d.title}`, d.id]));
  const pageIds = new Map(); // title → id (titles are unique in this seed)

  // Parents before children (this seed nests one level deep). Pages without a parent hang under the space home.
  const ordered = [...DOCS].sort((a, b) => Number(!!a.parent) - Number(!!b.parent));
  for (const d of ordered) {
    const space = spaces.get(d.space.toUpperCase());
    if (!space?.id) throw new Error(`doc space ${d.space} missing`);
    const key = `${space.id}:${d.title}`;
    let id = byTitleInSpace.get(key);
    let created = false;
    if (!id) {
      const parentId = d.parent ? pageIds.get(d.parent) : space.homeId;
      if (d.parent && !parentId) throw new Error(`parent page "${d.parent}" not created yet for "${d.title}"`);
      const page = await api(d.by, "POST", "/api/work/docs", {
        title: d.title,
        content: d.content,
        format: "markdown",
        spaceId: space.id,
        parentId: parentId ?? null,
        emoji: d.emoji,
        labels: d.labels ?? [],
      });
      id = page.id;
      created = true;
      bump("documents");
    }
    pageIds.set(d.title, id);
    if (!created) continue;

    for (const who of d.star ?? []) {
      await soft(`star ${d.title} as ${who}`, () => api(who, "PUT", `/api/work/docs/${id}/star`));
      bump("doc stars");
    }
    for (const [who, body, quote] of d.comments ?? []) {
      await soft(`comment on ${d.title} by ${who}`, () => api(who, "POST", `/api/work/docs/${id}/comments`, { body, quote: quote ?? null }));
      bump("doc comments");
    }
    for (const who of d.views ?? []) {
      await soft(`view ${d.title} as ${who}`, () => api(who, "GET", `/api/work/docs/${id}`));
    }
  }
}

async function meetings() {
  for (const [title, day, hour, minutes, organizer, attendees, location] of MEETINGS) {
    const start = localTime(workday(day), hour);
    await api(organizer, "POST", "/api/work/calendar/events", {
      title,
      kind: "meeting",
      startsAt: start,
      endsAt: new Date(Date.parse(start) + minutes * 60_000).toISOString(),
      attendeeIds: [...new Set(attendees.map(at))].filter((k) => k !== organizer).map(uid),
      location,
    });
    bump("meetings");
  }
}

/**
 * Copies every ready-made template into the company library, then hands the launch-post task to "Ship a change"
 * (the video's main workflow). Creating a workflow needs ai.use; the owner has it after setup.
 */
async function workflows() {
  const { templates } = await api("owner", "GET", "/api/work/workflows");
  if (!templates.some((t) => t.key === "ship-change")) {
    throw new Error(`expected tech templates (ship-change); got ${templates.map((t) => t.key).join(", ") || "(none)"} — is the server on the latest code?`);
  }
  const byKey = new Map();
  for (const t of templates) {
    const w = await api("owner", "POST", "/api/work/workflows", {
      name: t.name,
      description: t.description,
      category: t.category,
      runner: t.runner,
      steps: t.steps,
      template: t.key,
    });
    byKey.set(t.key, w.id);
    bump("workflows");
  }
  const ship = byKey.get("ship-change");
  const launch = seededTasks.find((t) => /launch post for v1\.0/i.test(t.title));
  if (!ship || !launch) throw new Error(`could not attach Ship a change (workflow=${ship}, task=${launch?.id})`);
  await api("trinh", "PUT", `/api/work/tasks/${launch.id}/workflow`, { workflowId: ship });
  bump("tasks with workflow");
}

async function chat() {
  const { channels: mine, browsable } = await api("owner", "GET", "/api/chat/channels");
  const all = [...mine, ...browsable];
  const channelIds = new Map();
  const inChannel = new Map(); // channel → member keys
  for (const ch of CHANNELS) {
    let id = all.find((c) => c.name?.toLowerCase() === ch.name)?.id;
    if (!id) {
      // Channels are created empty and people join themselves: adding members at creation needs the chat module to
      // have heard about them already (identity events), which may lag.
      id = (await api("owner", "POST", "/api/chat/channels", { kind: "public", name: ch.name, displayName: ch.displayName, topic: ch.topic })).id;
      bump("channels");
    }
    channelIds.set(ch.name, id);
    const members = ch.members === "all" ? PEOPLE : PEOPLE.filter((p) => ch.members.includes(p.dept));
    await pool(members, 8, (p) => api(p.key, "POST", `/api/chat/channels/${id}/join`, {}));
    inChannel.set(ch.name, new Set(["owner", ...members.map((p) => p.key)]));
  }
  // Post as the channel members who say it; anyone else joins first (the owner already sits everywhere).
  let i = 0;
  for (const [channel, ref, text] of CHAT) {
    const author = at(ref);
    const id = channelIds.get(channel);
    if (!inChannel.get(channel).has(author)) {
      await api(author, "POST", `/api/chat/channels/${id}/join`, {});
      inChannel.get(channel).add(author);
    }
    const msg = await api(author, "POST", `/api/chat/channels/${id}/messages`, { body: text, clientMsgId: `seed-demo-${i++}` });
    bump("chat messages");
    if (CELEBRATE.test(text)) {
      for (const who of ["owner", "sofia", "rachel", "maya", "diego"].filter((w) => w !== author && inChannel.get(channel).has(w))) {
        await soft("reaction", () => api(who, "POST", `/api/chat/messages/${msg.id}/reactions`, { emoji: "🎉" }));
      }
    }
  }
}

/**
 * Four weeks of check-ins, straight into the database (check-in only records "now"): most people arrive around
 * nine, a few are often late, and nobody is in on the days they were on leave or before they joined.
 */
async function attendance() {
  const rand = prng(4242);
  const late = new Set(PEOPLE.filter((_, i) => i % 13 === 7).map((p) => p.key));
  const nowUtc = Date.now();
  const rows = [];
  for (let d = -27; d <= 0; d++) {
    const day = localDay(d);
    const dow = new Date(`${day}T12:00:00Z`).getUTCDay();
    if (dow === 0 || dow === 6) continue;
    for (const p of [{ key: "owner" }, ...PEOPLE]) {
      const userId = uid(p.key);
      if ((hiredOn.get(p.key) ?? "") > day || daysOff.has(`${p.key} ${day}`)) continue;
      if (rand() < 0.03) continue; // the odd missed check-in
      const lateBy = late.has(p.key) && rand() < 0.45 ? 12 + Math.floor(rand() * 40) : 0;
      const inMin = lateBy ? 9 * 60 + lateBy : 8 * 60 + 25 + Math.floor(rand() * 44);
      const checkIn = Date.parse(localTime(d, 0)) + inMin * 60_000;
      if (checkIn > nowUtc) continue;
      const outMin = 17 * 60 + 15 + Math.floor(rand() * 90);
      const checkOut = d === 0 ? null : Date.parse(localTime(d, 0)) + outMin * 60_000;
      const lateMinutes = Math.max(0, inMin - (9 * 60 + 10));
      rows.push(
        `(${[`seed${String(rows.length).padStart(22, "0")}`, userId, day, new Date(checkIn), checkOut && new Date(checkOut), rand() < 0.2 ? "mobile" : "web", lateMinutes].map(lit).join(", ")})`,
      );
    }
  }
  await runSql(
    `BEGIN;
INSERT INTO employee.attendance (id, user_id, day, check_in, check_out, source, late_minutes) VALUES
${rows.join(",\n")}
ON CONFLICT DO NOTHING;
COMMIT;`,
    DATABASE_URL,
    ROOT,
  );
  bump("attendance days", rows.length);
}

// ---------------------------------------------------------------- main

async function main() {
  const t0 = Date.now();
  const docsOnly = process.argv.includes("--docs-only");
  const taskDescsOnly = process.argv.includes("--task-descs");
  const token = await signIn(OWNER_EMAIL, OWNER_PASSWORD).catch((e) => {
    throw new Error(`${e.message}\nIs the owner account ${OWNER_EMAIL} set up? (SEED_OWNER_EMAIL / SEED_OWNER_PASSWORD)`);
  });
  const ws = await fetch(`${GW}/api/platform/workspace`, { headers: { authorization: `Bearer ${token}` } });
  if (!ws.ok) throw new Error("the owner has no workspace yet: finish setup in the web app first");
  const wsName = (await ws.json()).workspace?.name ?? "the workspace";
  const only = docsOnly ? " (documents only)" : taskDescsOnly ? " (task descriptions only)" : "";
  console.log(`Seeding "${wsName}" through ${GW}: ${PEOPLE.length + 1} people${only}`);

  const step = async (label, fn, optional = true) => {
    const t = Date.now();
    process.stdout.write(`• ${label}`);
    await (optional ? soft(label, fn) : fn());
    console.log(` (${((Date.now() - t) / 1000).toFixed(1)}s)`);
  };

  // Members must exist so document authors can sign in; --docs-only / --task-descs reuse them on an already-seeded workspace.
  await step("members", members, false);
  if (docsOnly) {
    await step("documents", docs, false);
  } else if (taskDescsOnly) {
    await step("task descriptions", patchTaskDescriptions, false);
  } else {
    const { projects: existing } = await api("owner", "GET", "/api/work/projects");
    if (existing.some((p) => p.name === PROJECTS[0].name)) {
      console.log(`Already seeded: project "${PROJECTS[0].name}" exists. Nothing to do.`);
      return;
    }
    await step("departments and reporting lines", org, false);
    let projectIds;
    await step("projects and tasks", async () => (projectIds = await projects()), false);
    await step("finished work (history)", () => history(projectIds));
    await step("goals", () => goals(projectIds));
    await step("AI extension (outside AI use)", extension);
    await step("AI Insights history (8 weeks)", aiInsights);
    await step("open work spread over the weeks", spreadOpenWork);
    await step("leave", leave);
    await step("attendance (4 weeks)", attendance);
    await step("announcements", announcements);
    await step("approvals", approvals);
    await step("documents", docs);
    await step("meetings", meetings);
    await step("chat", chat);
    await step("workflows", workflows);
    // The moment this data is true for: platform.demo_refresh() (pnpm demo:refresh, the public demo's hourly reset,
    // Admin › Settings) moves it forward to today from here, so the demo never goes stale.
    await step("demo clock", () =>
      runSql(
        `INSERT INTO platform.demo_clock (anchor) VALUES (now()) ON CONFLICT (singleton) DO UPDATE SET anchor = now(), refreshed_at = NULL;
UPDATE ai.workspace_settings SET demo_data = true;`,
        DATABASE_URL,
        ROOT,
      ),
    );
    // After the clock: lateness is set from its anchor, so the refresh moves it forward with the rest.
    await step("lateness kept to a story (2 late projects, ~12 late tasks)", () => runSql(balanceSql, DATABASE_URL, ROOT));
  }

  console.log(`\nDone in ${((Date.now() - t0) / 1000).toFixed(1)}s:`);
  for (const [k, v] of Object.entries(counts)) console.log(`  ${String(v).padStart(4)}  ${k}`);
  console.log(`\nEvery demo member signs in with their email (e.g. minh@${EMAIL_DOMAIN}) and the password ${PASSWORD}`);
  console.log(`(kept in ${STATE_FILE} for re-runs; the owner stays ${OWNER_EMAIL})`);
  if (problems.length) {
    console.log(`\n${problems.length} step(s) failed:`);
    for (const p of problems) console.log(`  - ${p}`);
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(`\nSeed failed: ${e.message}`);
  if (Object.keys(counts).length) console.error(`Created so far: ${JSON.stringify(counts)}`);
  process.exit(1);
});
