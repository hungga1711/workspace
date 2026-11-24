#!/usr/bin/env node
/**
 * Records the live demo's mock data: fixtures.json, every gateway answer the web app needs to show the seeded demo
 * company, and the list of addresses to build. Run it on a developer's machine when the screens or the seed change;
 * build.mjs then needs no server. See README.md for the throwaway server it records.
 *
 *   node tooling/live-demo/record.mjs --gateway http://localhost:4600 --dist .next-ldrec
 *
 * Env: SEED_OWNER_EMAIL, SEED_OWNER_PASSWORD, WEB_DATABASE_URL (the throwaway database's).
 *
 * Writes reach the server only while a page loads (read marks, tickets); every click afterwards runs with writes
 * refused, so clicking around cannot change what is recorded.
 */
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");
const web = join(root, "frontend/web");
const { chromium } = createRequire(join(web, "package.json"))("@playwright/test");
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const GW = arg("gateway", "http://localhost:4600");
const REC_PORT = 4610;
const WEB_PORT = 3600;
const BASE = `http://localhost:${WEB_PORT}`;
const MODEL_PORT = 4620;

// ── the recording gateway ────────────────────────────────────────────────
const get = new Map(); // "/api/…?query" → { s: status, t: content type (when not JSON), b: body, e: "base64" when binary }
const post = new Map(); // "POST /api/…" → same, writes a page makes by itself while loading
const keep = (map, key, entry) => map.has(key) || map.set(key, entry);
let recordWrites = false;
const PRIVATE = /^\/api\/(auth|realtime\/ticket|signup|setup)(\/|\?|$)/;
const recorder = createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const headers = Object.fromEntries(Object.entries(req.headers).filter(([k]) => !["host", "connection", "content-length", "accept-encoding"].includes(k)));
  try {
    const up = await fetch(GW + req.url, { method: req.method, headers, ...(chunks.length ? { body: Buffer.concat(chunks) } : {}), redirect: "manual" });
    const buf = Buffer.from(await up.arrayBuffer());
    const type = up.headers.get("content-type") ?? "";
    const json = type.includes("json") || buf.length === 0;
    const entry = {
      s: up.status,
      ...(json ? {} : { t: type }),
      ...(/json|text|svg/.test(type) || !buf.length ? { b: buf.toString() } : { b: buf.toString("base64"), e: "base64" }),
    };
    if (up.status !== 429 && up.status < 500) {
      if (req.method === "GET" && (!PRIVATE.test(req.url) || req.url === "/api/setup")) keep(get, req.url, entry);
      else if (recordWrites && req.method !== "GET" && !PRIVATE.test(req.url) && up.ok) keep(post, `${req.method} ${req.url}`, entry);
    }
    res.writeHead(up.status, { ...(type ? { "content-type": type } : {}) });
    res.end(buf);
  } catch (e) {
    res.writeHead(502).end(String(e));
  }
}).listen(REC_PORT);

// ── a stand-in model, so AI screens are on (the answers visitors read come from the seed) ──
const ANSWER = "Done.";
const model = createServer(async (req, res) => {
  let body = "";
  for await (const c of req) body += c;
  if (req.url.endsWith("/models")) return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: [{ id: "qwen3:8b" }] }));
  if (!req.url.endsWith("/chat/completions")) return res.writeHead(404).end("{}");
  const usage = { prompt_tokens: 812, completion_tokens: 96, total_tokens: 908 };
  if (JSON.parse(body).stream) {
    res.writeHead(200, { "content-type": "text/event-stream" });
    const ev = (delta, finish_reason = null) =>
      res.write(`data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    ev({ role: "assistant", content: ANSWER });
    ev({}, "stop");
    res.write(`data: ${JSON.stringify({ id: "x", choices: [], usage })}\n\ndata: [DONE]\n\n`);
    return res.end();
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ id: "x", choices: [{ index: 0, message: { role: "assistant", content: ANSWER }, finish_reason: "stop" }], usage }));
}).listen(MODEL_PORT);

// ── the web app on the recording gateway ─────────────────────────────────
const next = spawn(join(web, "node_modules/.bin/next"), ["start", "-p", String(WEB_PORT)], {
  cwd: web,
  env: { ...process.env, GATEWAY_URL: `http://localhost:${REC_PORT}`, APP_URL: BASE, NEXT_DIST_DIR: arg("dist", ".next-ldrec") },
  stdio: ["ignore", "ignore", "inherit"],
});
const until = async (url) => {
  for (let i = 0; i < 60; i++) {
    if (
      await fetch(url).then(
        (r) => r.status < 500,
        () => false,
      )
    )
      return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`${url} did not answer`);
};

const urls = new Set(); // "/app/…?query" to build
const APP = /^\/(app|admin)(\/|$)/;
// Files, exports and redirects are not pages.
const SKIP = /\/export\b|^\/app\/files\/|^\/app\/ui-kit|^\/app\/chat\/m\/|_rsc=/;
const VARIANTS = 30; // addresses per path that differ only by their query
/** /app/work/tasks/T-12 → /app/work/tasks/*: screens of one kind. */
const kind = (p) => p.replace(/\/[^/]*\d[^/]*(?=\/|$)/g, "/*");
const queue = [];
const perPath = new Map();
function add(href) {
  let u;
  try {
    u = new URL(href, BASE);
  } catch {
    return;
  }
  if (u.origin !== BASE || !APP.test(u.pathname)) return;
  u.searchParams.delete("_rsc");
  const key = u.pathname + u.search;
  if (SKIP.test(key) || urls.has(key)) return;
  const n = perPath.get(u.pathname) ?? 0;
  if (u.search && n >= VARIANTS) return;
  perPath.set(u.pathname, n + 1);
  urls.add(key);
  queue.push(key);
}

const SEEDS =
  "/app/home /app/work /app/work/tasks /app/work/tasks?view=projects /app/work/tasks?scope=assigned /app/work/tasks?scope=owned /app/work/docs?view=files /app/work/docs?view=files&section=recent /app/work/docs?view=files&section=starred /app/ai/workflows?tab=runs /app/ai/workflows?tab=performance /app/work/goals /app/work/calendar /app/work/docs /app/work/whiteboards /app/work/ops /app/chat /app/chat/general /app/chat/browse /app/chat/mentions /app/chat/saved /app/chat/threads /app/chat/unreads /app/ai /app/ai/ask /app/ai/connect /app/ai/progress /app/ai/adoption /app/ai/adoption/how /app/ai/adoption/library /app/ai/adoption/report /app/ai/adoption/usage /app/ai/workflows /app/ai/workflows/new /app/announcements /app/me /app/me/people /app/search /app/time /app/welcome /admin/workspace".split(
    " ",
  );

const visited = new Map(); // kind → times clicked through
async function settle(page) {
  await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(250);
}
async function links(page) {
  for (const h of await page.evaluate(() => [...globalThis.document.querySelectorAll("a[href]")].map((a) => a.href))) add(h);
}

async function clickThrough(page, url) {
  await page.evaluate(() => (globalThis.__demoClicks = 0));
  const sel = "button:visible, [role=tab]:visible, [role=row]:visible, summary:visible, [aria-haspopup]:visible";
  const n = Math.min(await page.locator(sel).count(), 45);
  for (let i = 0; i < n; i++) {
    const el = page.locator(sel).nth(i);
    const label = ((await el.getAttribute("aria-label", { timeout: 500 }).catch(() => "")) ?? "") + ((await el.textContent({ timeout: 500 }).catch(() => "")) ?? "");
    if (/log ?out|sign out|download|export|print|check in|check out/i.test(label)) continue;
    await el.click({ timeout: 900, noWaitAfter: true }).catch(() => {});
    await page.waitForTimeout(450);
    if (!page.url().startsWith(BASE)) return;
    await links(page).catch(() => {});
    add(page.url());
    const moved = new URL(page.url()).pathname !== new URL(url, BASE).pathname;
    if (moved) {
      await page.goto(BASE + url, { waitUntil: "domcontentloaded" }).catch(() => {});
      await settle(page);
    } else {
      await page.keyboard.press("Escape").catch(() => {});
      await page.waitForTimeout(80);
    }
  }
}

const browser = await chromium.launch();
try {
  await until(`${BASE}/login`);
  // The server may run on a shifted clock (README): the browser reads the same one.
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "en-US", timezoneId: "UTC", reducedMotion: "reduce" });
  await context.addInitScript(
    (offset) => {
      if (!offset) return;
      const Real = Date;
      globalThis.Date = class Date extends Real {
        constructor(...a) {
          if (a.length) super(...a);
          else super(Real.now() + offset);
        }
        static now() {
          return Real.now() + offset;
        }
      };
    },
    Number(process.env.CLOCK_OFFSET_MS ?? 0),
  );
  await context.addCookies([{ name: "wos_locale", value: "en", url: BASE }]);
  let readOnly = false;
  await context.route("**/*", (r) => {
    const req = r.request();
    const u = new URL(req.url());
    if (u.searchParams.has("_rsc")) add(req.url());
    if (readOnly && req.method() !== "GET" && u.origin === BASE)
      return r.fulfill({ status: 403, contentType: "application/json", body: '{"error":"demo_locked","message":"off"}' });
    return r.continue();
  });
  context.on("page", (p) => p.on("dialog", (d) => d.dismiss().catch(() => {})));
  const first = await context.newPage();
  await first.goto(`${BASE}/login`);
  await first.locator("input[name=email]").fill(process.env.SEED_OWNER_EMAIL);
  await first.locator("input[name=password]").fill(process.env.SEED_OWNER_PASSWORD);
  await first.locator("form button[type=submit]").first().click();
  await first.waitForURL(/\/app\//, { timeout: 60_000 });
  const call = async (path, method = "GET", data) => {
    const r = await first.request.fetch(`${BASE}/api/proxy/${path}`, { method, headers: { "x-wos-csrf": "1" }, ...(data === undefined ? {} : { data }) });
    return { status: r.status(), body: await r.json().catch(() => null) };
  };
  // The company assistant is off until an admin asks for it; its routes answer 404 until then.
  const { body: ws } = await call("platform/workspace");
  const features = { ...ws.config.features, ai: { ...ws.config.features.ai, assistant: true } };
  console.log("AI on:", (await call("platform/workspace/config", "PUT", { version: ws.configVersion, config: { ...ws.config, features } })).status);
  if (!(await call("ai/status")).body?.configured)
    console.log("AI connection:", (await call("ai/connections", "POST", { mode: "selfhost", baseUrl: `http://localhost:${MODEL_PORT}`, modelSmart: "qwen3:8b" })).status);
  await first.waitForTimeout(31_000); // lib/ai.ts keeps the AI status half a minute
  // From here on, what the app reads is what visitors get: forget the half-configured answers.
  get.clear();
  recordWrites = true;

  SEEDS.forEach(add);
  // Pass 1: every page reachable by links.
  const work = async () => {
    const page = await context.newPage();
    for (let idle = 0; idle < 20;) {
      const url = queue.shift();
      if (!url) {
        idle++;
        await page.waitForTimeout(500);
        continue;
      }
      idle = 0;
      const r = await page.goto(BASE + url, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => null);
      await settle(page);
      const landed = new URL(page.url());
      if (!r || r.status() >= 400) urls.delete(url);
      else add(landed.pathname + landed.search);
      await links(page).catch(() => {});
    }
    await page.close();
  };
  await Promise.all([work(), work(), work(), work()]);
  console.log(`pass 1: ${urls.size} addresses, ${get.size} answers`);
  // Pass 2: click through a couple of screens of each kind, writes refused.
  recordWrites = false;
  readOnly = true;
  const todo = [...urls].filter((u) => {
    const k = kind(u.split("?")[0]) + (u.includes("?") ? "?" + [...new URLSearchParams(u.split("?")[1]).keys()].sort() : "");
    const n = visited.get(k) ?? 0;
    visited.set(k, n + 1);
    return n < 2;
  });
  const click = async () => {
    const page = await context.newPage();
    for (let url; (url = todo.shift());) {
      await page.goto(BASE + url, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => {});
      await settle(page);
      await Promise.race([clickThrough(page, url).catch((e) => console.log(url, e.message.split("\n")[0])), page.waitForTimeout(150_000)]).catch(() => {});
      if (todo.length % 10 === 0) console.log(`${todo.length} screens to click through`);
    }
    await page.close();
  };
  await Promise.all([click(), click(), click(), click(), click()]);
  // Pass 3: what the clicks found.
  await Promise.all([work(), work(), work(), work()]);

  // Pages only a script opens: every document.
  recordWrites = true;
  readOnly = false;
  for (const h of (
    await Promise.all(
      ["release", "launch", "offline", "billing", "interviews", "runbook", "review", "postmortem", "press", "work", "leave", "home"].map((q) =>
        call(`chat/search?types=document&q=${q}`),
      ),
    )
  ).flatMap((r) => r.body?.hits ?? []))
    add(h.url);
  for (const x of (await call("work/drive")).body?.items ?? []) if (x.kind === "folder") add(`/app/work/docs?view=files&folder=${x.id}`);
  await work();
  recordWrites = false;

  // Every entity of a kind answers where one did: …/tasks/T-1/comments for all tasks.
  const ids = new Map(); // parent segment → ids
  const isId = (s) => /\d/.test(s) && s.length > 2 && !/^v\d|^\d{4}/.test(s);
  const templates = new Map();
  for (const k of get.keys()) {
    const [p, q] = k.split("?");
    const seg = p.split("/");
    const at = seg.findIndex((s, i) => i > 2 && isId(s));
    if (at < 0 || seg.findIndex((s, i) => i > at && isId(s)) > 0) continue;
    const parent = seg.slice(0, at).join("/");
    if (!ids.has(parent)) ids.set(parent, new Set());
    ids.get(parent).add(seg[at]);
    if (q && /cursor|before|after|since/.test(q)) continue;
    if (get.get(k).s === 200) templates.set(parent + "\0" + seg.slice(at + 1).join("/") + (q ? "?" + q : ""), { parent, rest: seg.slice(at + 1).join("/"), q });
  }
  const jobs = [];
  for (const { parent, rest, q } of templates.values())
    for (const id of ids.get(parent)) {
      const path = `${parent}/${id}${rest ? `/${rest}` : ""}${q ? `?${q}` : ""}`;
      if (!get.has(path)) jobs.push(path.replace("/api/", ""));
    }
  console.log(`expanding ${jobs.length} answers`);
  const expand = async () => {
    for (let p; (p = jobs.shift());) await call(p).catch(() => {});
  };
  await Promise.all(Array.from({ length: 8 }, expand));

  // The search box: every hit the words of the company's titles find; the browser filters them as people type.
  const words = new Set(
    [...get.values()].flatMap((a) =>
      a.e
        ? []
        : [...a.b.matchAll(/"(?:title|displayName|name)":"([^"\\]{3,120})"/g)].flatMap((m) =>
            m[1]
              .toLowerCase()
              .split(/[^\p{L}\p{N}]+/u)
              .filter((w) => w.length > 3),
          ),
    ),
  );
  const search = new Map();
  for (const w of words) for (const h of (await call(`chat/search?q=${encodeURIComponent(w)}`)).body?.hits ?? []) search.set(`${h.entity_type}:${h.entity_id}`, h);
  for (const k of get.keys()) if (k.startsWith("/api/chat/search?")) get.delete(k);

  const ok = (o) => Object.fromEntries([...o].sort(([a], [b]) => (a < b ? -1 : 1)));
  const me = JSON.parse(get.get("/api/me")?.b ?? "{}");
  const out = {
    recordedAt: new Date().toISOString(),
    user: { id: me.principal?.id, email: process.env.SEED_OWNER_EMAIL },
    // The question a page was opened with is put in by the browser (runtime.js).
    pages: [...urls, "/app/ai/ask?q=__question__", "/app/ai/ask?q=__question__&send=1"].filter((u) => !/ask\?q=(?!__)|ask\?.*send=1(?!$)/.test(u)).sort(),
    get: ok(get),
    post: ok(post),
    search: [...search.values()],
  };
  const file = join(import.meta.dirname, "fixtures.json");
  writeFileSync(
    file,
    JSON.stringify(out, null, 1).replaceAll(`Self-host (localhost:${MODEL_PORT})`, "Company AI").replaceAll(`http://localhost:${MODEL_PORT}`, "http://ai.internal") + "\n",
  );
  console.log(`${file}: ${out.pages.length} pages, ${get.size} answers, ${post.size} writes`);
} finally {
  await browser.close();
  next.kill();
  recorder.close();
  model.close();
}
process.exit(0);
