#!/usr/bin/env node
/**
 * README hero screenshots: signs in to the demo workspace (`pnpm seed:demo`) with a headless browser and saves the
 * staged shots (1440×900 at 2×, plus Home on a 390×844 phone) to docs/assets/screenshots/. Run it against a
 * production build for the real look:
 *
 *   node tooling/scripts/screenshots.mjs [--base http://localhost:3000] [--email admin@example.com] [--password …]
 *                                        [--out dir] [--video] [--locale en|vi|zh|es] [--only name,name]
 *
 * `--locale` switches the interface (the `wos_locale` cookie) and saves to docs/assets/screenshots/<locale>/ unless
 * `--out` is given; `vi` keeps docs/assets/screenshots/ for the Vietnamese README.
 *
 * `--video` also records demo.mp4 (silent, ~15 s): ⌘K → open a task → mark it done → the toast. The task's status is
 * put back afterwards. Needs ffmpeg on PATH for the MP4 (otherwise the WebM is kept).
 *
 * The shots show AI switched on. When the workspace has no AI connection, the script points a temporary self-hosted
 * connection at a tiny local stand-in model and removes it afterwards. Nothing is sent to a model.
 */
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const { chromium } = createRequire(join(root, "frontend/web/package.json"))("@playwright/test");

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const ONLY = arg("only", "").split(",").filter(Boolean);
const BASE = arg("base", process.env.SHOTS_BASE_URL ?? "http://localhost:3000");
// The owner from /setup; `pnpm seed:demo` remembers both in .seed-demo.json.
const seedState = (() => {
  try {
    return JSON.parse(readFileSync(new URL("../../.seed-demo.json", import.meta.url), "utf8"));
  } catch {
    return {};
  }
})();
const EMAIL = arg("email", process.env.SEED_OWNER_EMAIL ?? seedState.ownerEmail ?? "admin@example.com");
const PASSWORD = arg("password", process.env.SEED_OWNER_PASSWORD ?? seedState.ownerPassword ?? "");
if (!PASSWORD) {
  console.error("Pass --password (or SEED_OWNER_PASSWORD): the owner's password from /setup.");
  process.exit(1);
}
const LOCALE = arg("locale", "en");
if (!["en", "vi", "zh", "es"].includes(LOCALE)) {
  console.error("--locale must be en, vi, zh or es.");
  process.exit(1);
}
const OUT = arg("out", join(root, LOCALE === "vi" ? "docs/assets/screenshots" : `docs/assets/screenshots/${LOCALE}`));
/** Labels the script clicks by name, per interface language (the demo data itself is in English). */
const L = {
  vi: { browser: "vi-VN", status: "Trạng thái", done: "Xong", ask: "Hỏi AI" },
  en: { browser: "en-US", status: "Status", done: "Done", ask: "Ask AI" },
  zh: { browser: "zh-CN", status: "状态", done: "已完成", ask: "问 AI" },
  es: { browser: "es-ES", status: "Estado", done: "Hecha", ask: "Preguntar a la IA" },
}[LOCALE];
const VIDEO = process.argv.includes("--video");

/**
 * name → path, and what to do once it has loaded. The first is the README hero:
 * Tiến độ › AI, the screen no other work app has.
 */
const SHOTS = [
  ["progress-ai", "/app/ai/adoption/usage"],
  // AI Insights from the other side (the person's own page), the weekly report and the shared prompt library.
  [
    "my-ai",
    "/app/me?tab=ai",
    async (page) => {
      // The section sits under the profile card: start the shot at it.
      await page.evaluate(() => globalThis.document.querySelector("#ai-week")?.scrollIntoView({ block: "start" }));
      await page.mouse.wheel(0, -120);
      await page.waitForTimeout(600);
    },
  ],
  ["ai-report", "/app/ai/adoption/report"],
  ["ai-library", "/app/ai/adoption/library"],
  ["home", "/app/home"],
  // A project board: the pace line over the columns.
  ["work-board", "/app/work/projects/P-010"],
  // The owner's evidence page, a project's pace, a task with its Ask AI panel, a workflow draft waiting for approval,
  // and the admin's first-run checklist.
  ["adoption", "/app/ai/adoption"],
  ["project-overview", "/app/work/projects/P-010?view=overview"],
  [
    "task-ask",
    "/app/work/tasks/T-215",
    async (page) => {
      await page.getByRole("button", { name: L.ask, exact: true }).first().click();
      await page.waitForTimeout(1500);
    },
  ],
  ["workflow-approval", "/app/chat/ask/01M6H6NR7S7JSYZQ14MCKRBWW9"],
  ["admin-setup", "/admin/workspace"],
];

/** An OpenAI-compatible stand-in so the shots have an AI connection to show; it is never asked anything. */
function standInModel() {
  const server = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/v1/models") return res.end(JSON.stringify({ data: [{ id: "qwen3:8b" }] }));
    res.statusCode = 404;
    res.end("{}");
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() })));
}

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, locale: L.browser, colorScheme: "light", reducedMotion: "reduce" });
const page = await context.newPage();
const api = (path, method = "GET", data) => page.request.fetch(`${BASE}/api/proxy/${path}`, { method, headers: { "x-wos-csrf": "1" }, ...(data === undefined ? {} : { data }) });

/** demo.mp4: ⌘K → a task → "Xong" → the toast; the task goes back to its status afterwards. */
async function recordDemo() {
  const dir = join(OUT, ".video");
  const rec = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    locale: L.browser,
    storageState: await context.storageState(),
    recordVideo: { dir, size: { width: 1280, height: 800 } },
  });
  const p = await rec.newPage();
  let restore = null;
  try {
    await p.goto(`${BASE}/app/home`, { waitUntil: "domcontentloaded", timeout: 120_000 });
    await p.waitForLoadState("networkidle").catch(() => {});
    await p.addStyleTag({ content: "nextjs-portal { display: none !important; }" });
    await p.waitForTimeout(1200);
    await p.keyboard.press("ControlOrMeta+k");
    await p.getByRole("dialog").waitFor();
    await p.keyboard.type("onboarding", { delay: 90 });
    await p.waitForTimeout(1200);
    // The first row is "Ask AI" when AI is on: pick the task itself.
    await p
      .getByRole("dialog")
      .getByRole("option", { name: /T-\d+.*onboarding/i })
      .first()
      .click();
    await p.getByRole("button", { name: L.status }).waitFor({ timeout: 30_000 });
    await p.waitForLoadState("networkidle").catch(() => {});
    await p.waitForTimeout(1200);
    const url = new URL(p.url());
    const id = url.searchParams.get("task") ?? url.pathname.split("/").pop();
    console.log(`demo video: task ${id} (${url.pathname}${url.search})`);
    const before = await (await p.request.fetch(`${BASE}/api/proxy/work/tasks/${id}`, { headers: { "x-wos-csrf": "1" } })).json();
    restore = { id, status: before.task.status };
    await p.getByRole("button", { name: L.status }).click();
    await p.waitForTimeout(600);
    await p.getByRole("option", { name: L.done }).click();
    await p.waitForTimeout(3500);
  } catch (e) {
    console.warn(`demo video: ${e.message}`);
  } finally {
    const video = p.video();
    await rec.close();
    if (restore) {
      const now = await (await page.request.fetch(`${BASE}/api/proxy/work/tasks/${restore.id}`, { headers: { "x-wos-csrf": "1" } })).json();
      await page.request.fetch(`${BASE}/api/proxy/work/tasks/${restore.id}`, {
        method: "PATCH",
        headers: { "x-wos-csrf": "1" },
        data: { expectedVersion: now.task.version, status: restore.status },
      });
    }
    const webm = video ? await video.path() : null;
    if (webm) {
      const mp4 = join(OUT, "demo.mp4");
      const r = spawnSync("ffmpeg", [
        "-y",
        "-loglevel",
        "error",
        "-i",
        webm,
        "-vf",
        "scale=1280:-2",
        "-c:v",
        "libx264",
        "-crf",
        "30",
        "-preset",
        "slow",
        "-pix_fmt",
        "yuv420p",
        "-an",
        "-movflags",
        "+faststart",
        mp4,
      ]);
      if (r.status === 0) {
        await rm(dir, { recursive: true, force: true });
        console.log(`saved ${mp4}`);
      } else console.log(`ffmpeg unavailable; video kept at ${webm}`);
    }
  }
}

let temporary = null;
let model = null;
try {
  await mkdir(OUT, { recursive: true });
  // The interface language comes from the wos_locale cookie (lib/i18n/server.ts), so set it before the first page.
  await context.addCookies([{ name: "wos_locale", value: LOCALE, url: BASE }]);
  await page.goto(`${BASE}/login`);
  // By field name, not label: the sign-in form follows the language too.
  await page.locator("input[name=email]").fill(EMAIL);
  await page.locator("input[name=password]").fill(PASSWORD);
  await page.locator("form button[type=submit]").first().click();
  await page.waitForURL(/\/app\//, { timeout: 60_000 });

  const status = await (await api("ai/status")).json().catch(() => ({ configured: false }));
  if (!status.configured) {
    model = await standInModel();
    const r = await api("ai/connections", "POST", { mode: "selfhost", baseUrl: model.url, modelSmart: "qwen3:8b" });
    temporary = (await r.json()).connection?.id ?? null;
    // The web server keeps the AI status for 30 s (lib/ai.ts); wait it out so every shot shows AI switched on.
    await page.waitForTimeout(31_000);
  }

  const settle = async (p) => {
    await p.waitForLoadState("networkidle").catch(() => {});
    // A dev server's build indicator is not part of the product; fonts and count-ups settle, no hover states.
    await p.addStyleTag({ content: "nextjs-portal { display: none !important; }" });
    await p.evaluate(() => globalThis.document.fonts.ready);
    await p.mouse.move(0, 899);
    await p.waitForTimeout(1200);
  };
  for (const [name, target, act] of SHOTS) {
    if (ONLY.length && !ONLY.includes(name)) continue;
    await page.goto(`${BASE}${target}`, { waitUntil: "domcontentloaded", timeout: 120_000 });
    await settle(page);
    if (act) await act(page);
    await page.screenshot({ path: join(OUT, `${name}.jpg`), type: "jpeg", quality: 82 });
    console.log(`saved ${join(OUT, `${name}.jpg`)}`);
  }

  // Home on a phone: the same session in a 390×844 viewport.
  if (!ONLY.length || ONLY.includes("home-mobile")) {
    const phone = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 3,
      isMobile: true,
      hasTouch: true,
      locale: L.browser,
      reducedMotion: "reduce",
      storageState: await context.storageState(),
    });
    const mp = await phone.newPage();
    await mp.goto(`${BASE}/app/home`, { waitUntil: "domcontentloaded", timeout: 120_000 });
    await settle(mp);
    await mp.screenshot({ path: join(OUT, "home-mobile.jpg"), type: "jpeg", quality: 82 });
    console.log(`saved ${join(OUT, "home-mobile.jpg")}`);
    await phone.close();
  }

  if (VIDEO) await recordDemo();
} finally {
  if (temporary) await api(`ai/connections/${temporary}`, "DELETE").catch(() => {});
  model?.close();
  await browser.close();
}
