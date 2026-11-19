// Signs every seeded user in through the real /login form (bcrypt on the server) and stores their session
// cookies in data/sessions.json, so the load test measures steady-state use rather than a login storm.
//
//   node tooling/loadtest/login.mjs [--concurrency 8] [--tasks 5]   (--tasks N [--tasks-from I]: users from index I get N tasks)
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { api, login, pool } from "./lib/http.mjs";

const DATA = join(dirname(fileURLToPath(import.meta.url)), "data");
const i = process.argv.indexOf("--concurrency");
const N = i > 0 ? Number(process.argv[i + 1]) : 8;
const k = process.argv.indexOf("--tasks");
const TASKS = k > 0 ? Number(process.argv[k + 1]) : 0;
// Users below this index already have their tasks (a dataset grown in steps).
const f = process.argv.indexOf("--tasks-from");
const TASKS_FROM = f > 0 ? Number(process.argv[f + 1]) : 0;
const PASSWORD = process.env.LOAD_PASSWORD ?? "Loadtest!2026";
const users = JSON.parse(readFileSync(join(DATA, "users.json"), "utf8"));
const t0 = Date.now();
let n = 0;
const times = [];
const sessions = await pool(users, N, async (u) => {
  const s = Date.now();
  const jar = await login(u.email, PASSWORD);
  times.push(Date.now() - s);
  // Their own to-do list, created as themselves (each user stays far under the per-user limit).
  for (let t = 0; u.i >= TASKS_FROM && t < TASKS; t++) {
    await api(jar, "POST", "work/tasks", {
      title: `Việc ${t} của u${u.i}: chuẩn bị báo cáo`,
      assigneeId: u.userId,
      priority: ["low", "medium", "high"][t % 3],
      dueAt: new Date(Date.now() + (t - 1) * 86_400_000).toISOString(),
    });
  }
  if (++n % 500 === 0) console.log(`${n} signed in, ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  return { ...u, cookie: jar.header() };
});
writeFileSync(join(DATA, "sessions.json"), JSON.stringify(sessions));
times.sort((a, b) => a - b);
const secs = (Date.now() - t0) / 1000;
console.log(
  `${sessions.length} sessions in ${secs.toFixed(0)}s (${(sessions.length / secs).toFixed(1)}/s), p50 ${times[times.length >> 1]} ms, p95 ${times[Math.floor(times.length * 0.95)]} ms`,
);
