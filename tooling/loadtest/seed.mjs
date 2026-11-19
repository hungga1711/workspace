// Seeds a load-test workspace through the public app: first-run setup, N employees with passwords, teams of
// TEAM people (a channel with history and a project each). Idempotent: rerun with
// a larger --users to grow it. Writes data/users.json for login.mjs (which also gives everyone tasks).
//
//   node tooling/loadtest/seed.mjs --users 3000 [--team 20] [--history 30]
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { actionForm, api, Jar, login, pool, request, submitAction } from "./lib/http.mjs";

const arg = (name, d) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? Number(process.argv[i + 1]) : d;
};
const USERS = arg("users", 1000);
const TEAM = arg("team", 20);
const HISTORY = arg("history", 30);
export const PASSWORD = process.env.LOAD_PASSWORD ?? "Loadtest!2026";
const OWNER = "owner@load.test";
const DATA = join(dirname(fileURLToPath(import.meta.url)), "data");
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s]`, ...a);

// 1. First-run setup (only on an empty installation).
const setup = await request("GET", "/setup");
if (setup.status === 200 && setup.text.includes("companyName")) {
  const form = await actionForm("/setup");
  const r = await submitAction(
    "/setup",
    form,
    { companyName: "Công ty Tải Thử", ownerName: "Chủ Doanh Nghiệp", ownerEmail: OWNER, password: PASSWORD, teamType: "product" },
    new Jar(),
  );
  log("setup", r.status);
}
const owner = await login(OWNER, PASSWORD);

// 2. Employees (bcrypt on the server is the slow part; 4 at a time keeps the 2-core box responsive).
const existing = new Map(((await api(owner, "GET", "identity/members")).members ?? []).map((m) => [m.email.toLowerCase(), m.userId ?? m.user_id ?? m.id]));
const wanted = Array.from({ length: USERS }, (_, i) => ({ i, email: `u${i}@load.test`, name: `Nhân viên ${String(i).padStart(5, "0")}` }));
let made = 0;
await pool(
  wanted.filter((w) => !existing.has(w.email)),
  4,
  async (w) => {
    const r = await api(owner, "POST", "identity/members/invite", { email: w.email, displayName: w.name, password: PASSWORD });
    existing.set(w.email, r.userId);
    if (++made % 250 === 0) log("invited", made);
  },
);
log("employees", USERS, "new", made);
const users = wanted.map((w) => ({ ...w, userId: existing.get(w.email) }));

// 3. Teams: a channel (with message history) and a project each.
const channels = new Map(((await api(owner, "GET", "chat/channels")).channels ?? []).map((c) => [c.name, c.id]));
const projects = new Map(((await api(owner, "GET", "work/projects")).projects ?? []).map((p) => [p.name, p.id]));
const teams = [];
for (let t = 0; t * TEAM < USERS; t++) teams.push(users.slice(t * TEAM, (t + 1) * TEAM));
await pool(teams, 4, async (members, t) => {
  const name = `team-${t}`;
  if (!channels.has(name)) {
    const c = await api(owner, "POST", "chat/channels", { kind: "public", name, topic: `Nhóm ${t}`, memberIds: members.map((m) => m.userId) });
    channels.set(name, c.id);
    for (let k = 0; k < HISTORY; k++)
      await api(owner, "POST", `chat/channels/${c.id}/messages`, { body: `Cập nhật tiến độ nhóm ${t}, mục ${k}: thanh toán, báo cáo tuần, kế hoạch phát hành` });
  } else {
    // Grown team: make sure everyone is in it.
    await api(owner, "POST", `chat/channels/${channels.get(name)}/members`, { userIds: members.map((m) => m.userId) }).catch(() => undefined);
  }
  if (!projects.has(`Dự án nhóm ${t}`)) {
    const p = await api(owner, "POST", "work/projects", { name: `Dự án nhóm ${t}`, description: `Dự án của nhóm ${t}` });
    projects.set(`Dự án nhóm ${t}`, p.id ?? p.project?.id);
  }
  for (const m of members) m.channelId = channels.get(name);
  if ((t + 1) % 25 === 0) log("teams", t + 1);
});
log("teams", teams.length);

mkdirSync(DATA, { recursive: true });
writeFileSync(join(DATA, "users.json"), JSON.stringify(users.map(({ email, userId, channelId, i }) => ({ i, email, userId, channelId }))));
log("done", { users: USERS, teams: teams.length });
