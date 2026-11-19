#!/usr/bin/env node
/**
 * README hero GIF (docs/assets/hero.gif): the AI Insights flow end to end against a running workspace with the demo
 * seed (`pnpm seed:demo`), headless:
 *
 *   1. a staff member writes to an AI chat (a neutral stand-in page served at the chat site's address, with the real
 *      browser extension loaded and connected to this workspace), the extension redacts the ID number and the
 *      company keyword before anything is sent, and they answer "Did AI help?";
 *   2. they open Me › AI and see that conversation, redacted, with their own numbers;
 *   3. the owner opens Progress › AI Insights: whether tasks done with AI help go better.
 *
 *   node tooling/scripts/hero-gif.mjs --base http://localhost:3002 --staff bao@example.com --staff-password …
 *                                     --owner admin@example.com --owner-password … [--locale en|vi] [--out file.gif]
 *
 * Needs ffmpeg on PATH. The prompt really is recorded in the workspace (as the staff member), like any other.
 */
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
const BASE = arg("base", "http://localhost:3002");
const LOCALE = arg("locale", "en");
const OUT = arg("out", join(root, "docs/assets/hero.gif"));
const STAFF = [arg("staff"), arg("staff-password")];
const OWNER = [arg("owner"), arg("owner-password")];
if (!STAFF[0] || !STAFF[1] || !OWNER[0] || !OWNER[1]) {
  console.error("usage: hero-gif.mjs --staff <email> --staff-password <pw> --owner <email> --owner-password <pw>");
  process.exit(1);
}
const EXT = join(root, "frontend/browser-extension");
const SIZE = { width: 1280, height: 800 };
const work = mkdtempSync(join(tmpdir(), "wx-hero-"));

const TEXT = {
  en: {
    title: "AI chat",
    hello: "How can I help today?",
    prompt: "Draft a short quote email for Lakeshore Logistics. Their director's ID number is 079203001234, contact anna@lakeshore-logistics.example",
    answer: "Here is a draft: “Dear [KEYWORD] team, thank you for your interest…”",
  },
  vi: {
    title: "AI chat",
    hello: "Hôm nay tôi giúp gì được bạn?",
    prompt: "Soạn email báo giá ngắn cho Lakeshore Logistics. CCCD của giám đốc bên đó là 079203001234, liên hệ anna@lakeshore-logistics.example",
    answer: "Đây là bản nháp: “Kính gửi quý công ty [KEYWORD], cảm ơn quý công ty đã quan tâm…”",
  },
}[LOCALE];

// A neutral chat page with the markup the extension looks for on that site (composer, send button, answers).
const CHAT = `<!doctype html><html><head><meta charset="utf-8"><title>${TEXT.title}</title><style>
  body { margin: 0; font: 16px/1.5 Inter, system-ui, sans-serif; color: #1f2328; background: #fff; }
  main { max-width: 760px; margin: 0 auto; padding: 72px 24px 160px; }
  h1 { font-size: 28px; font-weight: 600; text-align: center; margin: 80px 0 32px; }
  .msg { padding: 12px 16px; border-radius: 16px; margin: 12px 0; max-width: 80%; }
  .me { background: #f2f3f5; margin-left: auto; }
  form { position: fixed; left: 50%; bottom: 40px; transform: translateX(-50%); width: min(720px, 90vw); display: flex; gap: 8px;
         border: 1px solid #d8dbe0; border-radius: 24px; padding: 10px 10px 10px 18px; background: #fff; box-shadow: 0 2px 12px rgb(0 0 0 / 6%); }
  textarea { flex: 1; border: 0; resize: none; font: inherit; outline: none; height: 48px; }
  button { border: 0; border-radius: 999px; background: #1f2328; color: #fff; width: 40px; height: 40px; font-size: 18px; align-self: end; }
</style></head><body><main><h1>${TEXT.hello}</h1><div id="log"></div></main>
<form onsubmit="return false"><textarea id="prompt-textarea"></textarea><button type="button" data-testid="send-button" aria-label="Send">↑</button></form>
<script>
  document.querySelector("[data-testid=send-button]").addEventListener("click", () => {
    const t = document.querySelector("#prompt-textarea");
    if (!t.value) return;
    const me = document.createElement("div"); me.className = "msg me"; me.textContent = t.value; document.querySelector("#log").append(me); t.value = "";
    document.querySelector("h1").remove();
    setTimeout(() => { const a = document.createElement("div"); a.className = "msg"; a.dataset.messageAuthorRole = "assistant"; a.textContent = ${JSON.stringify(TEXT.answer)}; document.querySelector("#log").append(a); }, 900);
  });
</script></body></html>`;

async function signIn(context, [email, password]) {
  await context.addCookies([{ name: "wos_locale", value: LOCALE, url: BASE }]);
  const page = await context.newPage();
  await page.goto(`${BASE}/login`);
  await page.locator("input[name=email]").fill(email);
  await page.locator("input[name=password]").fill(password);
  await page.locator("form button[type=submit]").first().click();
  await page.waitForURL(/\/app\//, { timeout: 60_000 });
  return page;
}

const settle = async (page, ms = 1200) => {
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.evaluate(() => globalThis.document.fonts.ready);
  await page.waitForTimeout(ms);
};
const glide = async (page, dy, steps = 12) => {
  for (let i = 0; i < steps; i++) {
    await page.mouse.wheel(0, dy / steps);
    await page.waitForTimeout(60);
  }
};

/**
 * Screenshots in a loop instead of the context's video: a persistent context with an extension records its window,
 * not the viewport, and pads the difference in grey. Each frame keeps its real duration (ffconcat), so timing holds.
 */
function film(page, dir) {
  const frames = [];
  let on = true;
  const loop = (async () => {
    while (on) {
      const file = join(dir, `${String(frames.length).padStart(5, "0")}.jpg`);
      try {
        await page.screenshot({ path: file, type: "jpeg", quality: 85 });
        frames.push({ file, at: Date.now() });
      } catch {
        await new Promise((r) => setTimeout(r, 50)); // mid-navigation: try again
      }
    }
  })();
  return async () => {
    on = false;
    await loop;
    return frames;
  };
}

const frames = [];
try {
  // 1–2. Staff: the extension in a real Chromium profile, connected to this workspace with their own code.
  const staff = await chromium.launchPersistentContext(join(work, "profile"), {
    channel: "chromium",
    headless: true,
    viewport: SIZE,
    locale: LOCALE === "en" ? "en-US" : "vi-VN",
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, `--lang=${LOCALE}`],
  });
  const sw = staff.serviceWorkers()[0] ?? (await staff.waitForEvent("serviceworker"));
  const login = await signIn(staff, STAFF);
  const code = await login.request.fetch(`${BASE}/api/proxy/ai/monitor/connection`, { method: "POST", headers: { "x-wos-csrf": "1" } }).then((r) => r.json());
  if (!code.token) throw new Error(`no connection code: ${JSON.stringify(code)}`);
  // What the options page stores after the code is pasted, then the same first call it makes (policy and keywords).
  await sw.evaluate(([server, token]) => globalThis.chrome.storage.local.set({ server, token, status: "connected" }), [BASE, code.token]);
  await sw.evaluate(() => globalThis.flush?.(true));
  await login.waitForTimeout(1500);
  for (const p of staff.pages()) if (p !== login) await p.close();
  await login.close();

  await staff.route("https://chatgpt.com/**", (route) => route.fulfill({ contentType: "text/html", body: CHAT }));
  const chat = await staff.newPage();
  await chat.goto(`https://chatgpt.com/c/hero-${Date.now()}`);
  await chat.waitForTimeout(500);
  mkdirSync(join(work, "staff"));
  let stop = film(chat, join(work, "staff"));
  await chat.waitForTimeout(800);
  await chat.locator("#prompt-textarea").pressSequentially(TEXT.prompt, { delay: 18 });
  await chat.waitForTimeout(400);
  await chat.locator("[data-testid=send-button]").click();
  await chat.locator("[data-wx=panel]").waitFor({ timeout: 10_000 });
  await chat.waitForTimeout(2600);
  await chat.locator("[data-wx=panel] button.primary").click();
  await chat.locator("[data-wx=feedback] button[data-v=yes]").waitFor({ timeout: 20_000 });
  await chat.waitForTimeout(1200);
  await chat.locator("[data-wx=feedback] button[data-v=yes]").click();
  await chat.waitForTimeout(1400);
  frames.push(...(await stop()));

  // Loading screens are not the point: film Me › AI once it has rendered.
  await chat.goto(`${BASE}/app/me?tab=ai`, { waitUntil: "domcontentloaded" });
  await chat.locator("#ai-week").waitFor({ timeout: 30_000 });
  await settle(chat);
  await chat.evaluate(() => globalThis.document.querySelector("#ai-week")?.scrollIntoView({ block: "start" }));
  await chat.mouse.wheel(0, -120);
  await chat.waitForTimeout(300);
  mkdirSync(join(work, "me"));
  stop = film(chat, join(work, "me"));
  await chat.waitForTimeout(2200);
  await chat.evaluate(() => globalThis.document.querySelector("#ai-conversations")?.scrollIntoView({ block: "start", behavior: "smooth" }));
  await chat.waitForTimeout(2600);
  frames.push(...(await stop()));
  await staff.close();

  // 3. The owner: whether AI helps the work get done.
  const browser = await chromium.launch({ headless: true });
  const ownerCtx = await browser.newContext({ viewport: SIZE, locale: LOCALE === "en" ? "en-US" : "vi-VN" });
  const page = await signIn(ownerCtx, OWNER);
  await page.goto(`${BASE}/app/ai/adoption/usage`, { waitUntil: "domcontentloaded" });
  await settle(page, 1500);
  mkdirSync(join(work, "owner"));
  stop = film(page, join(work, "owner"));
  await page.waitForTimeout(2600);
  await glide(page, 620);
  await page.waitForTimeout(2600);
  frames.push(...(await stop()));
  await browser.close();

  // Real durations per frame (the last one of each scene holds a little), 10 fps, 880 wide, one shared palette.
  const list = ["ffconcat version 1.0"];
  frames.forEach((f, i) => {
    const next = frames[i + 1];
    const d = next && next.at > f.at && next.at - f.at < 1000 ? (next.at - f.at) / 1000 : 0.6;
    list.push(`file '${f.file}'`, `duration ${d.toFixed(3)}`);
  });
  list.push(`file '${frames.at(-1).file}'`);
  writeFileSync(join(work, "frames.txt"), list.join("\n"));
  const filter = "fps=10,scale=880:-2:flags=lanczos,split[a][b];[a]palettegen=max_colors=96:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle";
  const r = spawnSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", join(work, "frames.txt"), "-filter_complex", filter, "-loop", "0", OUT], {
    stdio: "inherit",
  });
  if (r.status !== 0) throw new Error("ffmpeg failed");
  console.log(`saved ${OUT} (${(statSync(OUT).size / 1024 / 1024).toFixed(1)} MB, ${frames.length} frames)`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
