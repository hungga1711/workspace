#!/usr/bin/env node
/**
 * Builds the static live demo from fixtures.json: the real web app, rendered once per recorded address with its reads
 * answered from the fixtures, saved as plain files any static host serves (GitHub Pages: /live-demo).
 *
 *   node tooling/live-demo/build.mjs [--out website/out/live-demo] [--skip-next]
 *
 * No backend, database or network: `next build`, then `next start` on this machine while the pages are saved.
 */
import { createServer } from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");
const web = join(root, "frontend/web");
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const BASE = "/live-demo";
const DIST = ".next-livedemo";
const OUT = resolve(root, arg("out", "website/out/live-demo"));
const GW_PORT = 4630;
const WEB_PORT = 3630;
const fx = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures.json"), "utf8"));
const next = join(web, "node_modules/.bin/next");
const me = JSON.parse(fx.get["/api/identity/members/summary?limit=300"].b).me;
const env = { ...process.env, NEXT_BASE_PATH: BASE, NEXT_DIST_DIR: DIST, NEXT_PUBLIC_CHAT_URL: "", NEXT_SKIP_CHECKS: "1", APP_URL: "https://workspace.hungga1711.dev" };

if (!process.argv.includes("--skip-next")) {
  // next build adds its dist folder to tsconfig.json; put the files back as they were.
  const touched = ["tsconfig.json", "next-env.d.ts"]
    .map((f) => join(web, f))
    .filter(existsSync)
    .map((f) => [f, readFileSync(f)]);
  const r = spawnSync(next, ["build"], { cwd: web, env, stdio: "inherit" });
  for (const [f, body] of touched) writeFileSync(f, body);
  if (r.status !== 0) process.exit(1);
}

// A moment in a query ("the last 30 days, from now") differs on every read: compare without it.
const plain = (url) => decodeURIComponent(url).replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g, "*");
const byPlain = new Map(Object.entries(fx.get).map(([k, v]) => [plain(k), v]));
const misses = new Set();
const gateway = createServer((req, res) => {
  const hit = fx.get[req.url] ?? byPlain.get(plain(req.url));
  if (!hit || req.method !== "GET") {
    misses.add(`${req.method} ${req.url}`);
    return res.writeHead(404, { "content-type": "application/json" }).end('{"error":"not_found"}');
  }
  res.writeHead(hit.s, { "content-type": hit.t ?? "application/json" });
  res.end(hit.e ? Buffer.from(hit.b, "base64") : hit.b);
}).listen(GW_PORT);
const LIVE_DEMO = JSON.stringify({ recordedAt: fx.recordedAt, user: { ...fx.user, name: me.displayName, givenName: me.displayName.split(" ")[0] } });
const app = spawn(process.execPath, ["--require", join(import.meta.dirname, "preload.cjs"), join(web, "node_modules/next/dist/bin/next"), "start", "-p", String(WEB_PORT)], {
  cwd: web,
  env: { ...env, GATEWAY_URL: `http://localhost:${GW_PORT}`, LIVE_DEMO, NODE_OPTIONS: "" },
  stdio: ["ignore", "ignore", "inherit"],
});

const ORIGIN = `http://localhost:${WEB_PORT}`;
const cookie = `wos_session=${"a".repeat(43)}; wos_locale=en`;
const get = (path, headers = {}) => fetch(ORIGIN + BASE + path, { redirect: "manual", headers: { cookie, "accept-language": "en", ...headers } });
// "Nothing open below this area": the server answers with the area's content but not its layout, which every page
// already holds. A page of another area is a full load (runtime.js).
const treeOf = (area) =>
  encodeURIComponent(JSON.stringify(["", { children: [area, { children: ["__none__", {}], ...(area === "app" ? { peek: ["__DEFAULT__", {}] } : {}) }] }, null, null, true]));
const PEEK = /^\/app\/work\/(tasks|approvals|meetings)\/[^/]+$/;
const keyOf = (page) => {
  const u = new URL(page, ORIGIN);
  u.searchParams.sort();
  return u.pathname + (u.searchParams.size ? `?${u.searchParams}` : "");
};
const idOf = (s) => createHash("sha256").update(s).digest("hex").slice(0, 12);
const save = (file, body) => {
  const to = join(OUT, file);
  mkdirSync(dirname(to), { recursive: true });
  writeFileSync(to, body);
};
// A task's page here is the one by its code (T-12), which every link in the app uses; search answers with its id.
const search = fx.search.map((h) => ({ ...h, url: h.entity_type === "task" ? `/app/work/tasks/${h.title.split(" ")[0]}` : h.url }));
// What the owner asked the company's AI: the demo answers these questions, word for word or nearly (runtime.js).
const ask = JSON.parse(fx.get["/api/ai/assistant/conversations"].b).conversations.flatMap(({ id }) => {
  const { messages } = JSON.parse(fx.get[`/api/ai/assistant/conversations/${id}`].b);
  return messages.flatMap((m, i) => (m.role === "user" && messages[i + 1] ? [{ id, q: m.content, a: messages[i + 1] }] : []));
});
const flows = JSON.parse(fx.get["/api/work/workflows"].b).workflows;
const proposal = {
  workflows: flows.map(({ id, name, category, runner }) => ({ id, name, category, runner })),
  projects: JSON.parse(fx.get["/api/work/projects"].b).projects.map(({ id, name }) => ({ id, name })),
};
const D = { base: BASE, recordedAt: Date.parse(fx.recordedAt), pages: {}, rsc: {}, peek: {}, redirects: {}, api: {}, post: fx.post, search, ask, proposal };

try {
  for (let i = 0; ; i++) {
    if (
      await fetch(`${ORIGIN}${BASE}/api/none`).then(
        () => true,
        () => false,
      )
    )
      break;
    if (i > 80) throw new Error("the web app did not start");
    await new Promise((r) => setTimeout(r, 250));
  }
  rmSync(OUT, { recursive: true, force: true });
  // Static assets, without the source maps and without the server's own files.
  cpSync(join(web, DIST, "static"), join(OUT, "_next/static"), { recursive: true, filter: (f) => !f.endsWith(".map") });
  // Values only: the same text sits, escaped, in the selectors.
  // Screens as tall as the window end above the demo's bar (runtime.js).
  for (const f of readdirSync(join(OUT, "_next/static/css"))) {
    const css = join(OUT, "_next/static/css", f);
    writeFileSync(css, readFileSync(css, "utf8").replace(/(?<!\\[(,])(?<=[:(,\s])100dvh/g, "calc(100dvh - var(--demo-bar, 0px))"));
  }
  for (const d of ["reactions", "excalidraw", "downloads"]) if (existsSync(join(web, "public", d))) cpSync(join(web, "public", d), join(OUT, d), { recursive: true });

  for (const [url, a] of Object.entries(fx.get)) {
    const id = idOf(url);
    const ext = a.e ? "bin" : a.t?.includes("svg") ? "svg" : a.t?.includes("html") ? "txt" : "json";
    D.api[url] = [id, a.s, a.t ?? 0, ext === "json" ? 0 : ext];
    save(`_demo/api/${id}.${ext}`, a.e ? Buffer.from(a.b, "base64") : a.b);
  }

  // Root-relative addresses the app writes by hand (next/link and next/image already carry the base path).
  const rebase = (html) =>
    html
      .replace(/(\s(?:src|href)=")(\/(?:reactions|api|files|downloads)\/[^"]*)"/g, (_, a, v) => {
        const hit = D.api[v.replaceAll("&amp;", "&").replace("/api/proxy/", "/api/")];
        return `${a}${hit ? `${BASE}/_demo/api/${hit[0]}.${hit[3] || "json"}` : BASE + v}"`;
      })
      .replace(/(\shref=")(\/(?:app|admin)(?:\/[^"]*)?)"/g, `$1${BASE}$2"`);
  const HEAD = `<script src="${BASE}/_demo/runtime.js"></script>`;
  // Every recorded address with a query is a page of its own: dropping one shows another page under its address.
  // Only the month-by-month and per-record lists are thinned; links to the rest say they are not in the demo.
  const THIN = /^\/admin\/workspace\/(attendance|audit|holidays|leave)\b/;
  const variants = new Map();
  const queue = [...new Set(fx.pages)].filter((p) => {
    const [path, q] = p.split("?");
    if (!q || !THIN.test(path)) return true;
    variants.set(path, (variants.get(path) ?? 0) + 1);
    return variants.get(path) <= (path.startsWith("/admin/workspace/attendance/") ? 2 : 8);
  });
  // A queried address is only useful with its plain page present too.
  for (const p of [...queue]) if (p.includes("?") && !queue.includes(p.split("?")[0])) queue.push(p.split("?")[0]);
  const total = queue.length;
  const failed = [];
  const linked = new Set();
  const render = async () => {
    for (let page; (page = queue.shift());) {
      const key = keyOf(page);
      const area = page.split("/")[1].split("?")[0];
      const r = await get(page);
      if (r.status >= 300 && r.status < 400) {
        const to = new URL(r.headers.get("location"), ORIGIN);
        const target = (to.pathname.startsWith(BASE) ? to.pathname.slice(BASE.length) : to.pathname) + to.search;
        D.redirects[key] = target;
        if (!page.includes("?"))
          save(
            `${page}.html`,
            `<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=${BASE}${target}"><script>location.replace(${JSON.stringify(BASE + target)})</script>`,
          );
        continue;
      }
      const html = await r.text();
      if (r.status !== 200) {
        failed.push(`${r.status} ${page}`);
        continue;
      }
      for (const m of html.matchAll(/<a [^>]*?href="(\/(?:live-demo\/)?(?:app|admin)\b[^"#]*)/g)) linked.add(keyOf(m[1].replaceAll("&amp;", "&").replace(BASE, "")));
      const doc = rebase(html).replace("<head>", `<head>${HEAD}`);
      const id = idOf(key);
      D.pages[key] = page.includes("?") ? id : 1;
      if (page.includes("?")) save(`_demo/html/${id}.html`, doc);
      else save(`${page}.html`, doc);
      const f = await get(page + (page.includes("?") ? "&" : "?") + "_rsc=x", { rsc: "1", "next-router-state-tree": treeOf(area) });
      if (f.ok && f.headers.get("content-type")?.startsWith("text/x-component")) {
        D.rsc[key] = id;
        save(`_demo/rsc/${id}.txt`, await f.text());
      }
      if (PEEK.test(page)) {
        const p = await get(`${page}?_rsc=x`, { rsc: "1", "next-router-state-tree": treeOf("app"), "next-url": "/app/home" });
        if (p.ok) {
          D.peek[key] = id;
          save(`_demo/peek/${id}.txt`, await p.text());
        }
      }
    }
  };
  await Promise.all(Array.from({ length: 6 }, render));
  for (const [k, to] of Object.entries(D.redirects)) if (/^\/login/.test(to)) throw new Error(`${k} asked to sign in: the fixtures lack its session`);

  save("_demo/runtime.js", `(() => {\nconst D=${JSON.stringify(D)};\n${readFileSync(join(import.meta.dirname, "runtime.js"), "utf8")}})();\n`);
  save(
    "index.html",
    `<!doctype html><html lang="en"><meta charset="utf-8"><title>workspace live demo</title><meta http-equiv="refresh" content="0;url=${BASE}/app/home"><script>location.replace("${BASE}/app/home")</script><a href="${BASE}/app/home">Open the demo</a>`,
  );
  console.log(
    `${OUT}: ${Object.keys(D.pages).length} pages, ${Object.keys(D.peek).length} peeks, ${Object.keys(D.redirects).length} redirects, ${Object.keys(D.api).length} answers`,
  );
  if (failed.length) console.log(`not built:\n  ${failed.join("\n  ")}`);
  // Every link on a built screen leads to a built screen, or to one left out on purpose.
  const dead = new Set();
  for (const k of linked) {
    const path = k.split("?")[0];
    if (!(k in D.pages) && !(k in D.redirects) && !THIN.test(path) && !/^\/app\/(ai\/ask\?|files\/)|\/export\b/.test(k)) dead.add(k);
  }
  if (dead.size) console.log(`links to pages not built (${dead.size}):\n  ${[...dead].sort().join("\n  ")}`);
  if (misses.size) console.log(`reads without a fixture (${misses.size}):\n  ${[...misses].slice(0, 25).join("\n  ")}`);
  if (Object.keys(D.pages).length < total * 0.8) throw new Error("too many pages failed to build");
} finally {
  app.kill();
  gateway.close();
}
process.exit(0);
