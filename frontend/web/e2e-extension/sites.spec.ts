import { test, expect, chromium, type BrowserContext, type Worker } from "@playwright/test";
import { createServer, type Server } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AI_SITES } from "../src/lib/ai-sites";

/**
 * Every site in the registry (frontend/browser-extension/sites.js), headless: a stand-in page served at each real
 * host with that site's kind of composer (textarea, rich-text editor or one-line input). Checks that a prompt is
 * recorded on Enter and on the send button, that the safety net blocks on every one of them, that the manifest and
 * the download zip carry what the registry needs, and that a capture made while a batch is in flight is not lost.
 *
 * The stand-in pages prove the extension's own logic on every host; they cannot prove a real site's selectors, which
 * is why content.js never depends on them alone (the focused field and a send-looking button next to it also count).
 */
declare const chrome: { storage: { local: { set(items: Record<string, unknown>): Promise<void>; get(k: string): Promise<Record<string, unknown>> } } };

const EXT = fileURLToPath(new URL("../../browser-extension", import.meta.url));
interface Site {
  id: string;
  name: string;
  hosts: string[];
  path?: string;
  input: string;
  send: string;
  answer: string;
}
const { WORKSPACE_AI_SITES: SITES } = createRequire(import.meta.url)(join(EXT, "sites.js")) as { WORKSPACE_AI_SITES: Site[] };
const manifest = JSON.parse(readFileSync(join(EXT, "manifest.json"), "utf8")) as {
  host_permissions: string[];
  content_scripts: { matches: string[]; js: string[] }[];
  icons: Record<string, string>;
  action: { default_icon: Record<string, string>; default_popup: string };
  background: { service_worker: string };
  options_page: string;
};
type Ev = Record<string, unknown> & { kind?: string; prompt?: string; url?: string };

// What each site's composer is on the real page (seen 2026-11-11 where the page opens without signing in).
const KIND: Record<string, "textarea" | "editor" | "input"> = { claude: "editor", gemini: "editor", perplexity: "editor", kimi: "editor", meta: "input", you: "input" };
const composerHtml = (kind: "textarea" | "editor" | "input") =>
  kind === "editor"
    ? `<div id="c" contenteditable="true" role="textbox"></div>`
    : kind === "input"
      ? `<input id="c" type="text" aria-label="Ask" />`
      : `<textarea id="c"></textarea>`;
/** A page whose send button no site selector names on purpose: only "a send-looking button next to the composer". */
const page = (kind: "textarea" | "editor" | "input") => `<!doctype html><html><body>
<div class="box">${composerHtml(kind)}<div><button type="button" aria-label="Send message" id="go">↑</button></div></div>
<button type="button" aria-label="Send feedback" id="elsewhere">Feedback</button>
<ol id="sent"></ol>
<script>
  const c = document.querySelector("#c");
  const read = () => (c.value ?? c.innerText ?? "").trim();
  const clear = () => { if ("value" in c) c.value = ""; else c.textContent = ""; };
  const send = () => { const t = read(); if (!t) return; const li = document.createElement("li"); li.textContent = t; document.querySelector("#sent").append(li); clear(); };
  document.querySelector("#go").addEventListener("click", send);
  c.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } });
</script></body></html>`;

let server: Server;
let base = "";
let delay = 0;
let mode: "warn" | "block" = "warn";
const received: Ev[] = [];
let context: BrowserContext;
let sw: Worker;
let profile: string;

const targets = SITES.flatMap((s) => s.hosts.map((host) => ({ site: s, host, url: `https://${host}${s.path ?? ""}/c/` })));

test.beforeAll(async () => {
  server = createServer((req, res) => {
    res.setHeader("access-control-allow-origin", "*");
    res.setHeader("access-control-allow-headers", "authorization, content-type");
    res.setHeader("access-control-allow-methods", "POST, OPTIONS");
    if (req.method === "OPTIONS") return res.end();
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const events = (JSON.parse(body || "{}").events ?? []) as Ev[];
      setTimeout(() => {
        received.push(...events);
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ accepted: events.length, captureResponses: false, sensitiveMode: mode, keywords: [] }));
      }, delay);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  profile = mkdtempSync(join(tmpdir(), "wx-ext-sites-"));
  context = await chromium.launchPersistentContext(profile, {
    channel: "chromium",
    headless: true,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  });
  sw = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
  for (const p of context.pages()) if (p.url().startsWith("chrome-extension://")) await p.close();
  await sw.evaluate(([server]) => chrome.storage.local.set({ server, token: "aim_testtesttesttesttesttest", status: "connected", sensitiveMode: "warn", keywords: [] }), [base]);
  for (const s of SITES)
    for (const host of s.hosts) await context.route(`https://${host}/**`, (route) => route.fulfill({ contentType: "text/html", body: page(KIND[s.id] ?? "textarea") }));
});

test.afterAll(async () => {
  await context?.close();
  server?.close();
  rmSync(profile, { recursive: true, force: true });
});

test("the registry, the manifest and the download zip agree", () => {
  const want = [...new Set(targets.map((t) => `https://${t.host}${t.site.path ?? ""}/*`))].sort();
  expect([...manifest.host_permissions].sort()).toEqual(want);
  expect([...manifest.content_scripts[0]!.matches].sort()).toEqual(want);
  expect(manifest.content_scripts[0]!.js).toEqual(["sites.js", "content.js"]);
  expect(new Set(SITES.map((s) => s.id)).size).toBeGreaterThanOrEqual(10);
  // The web app names the same sites (AI › Connect).
  expect([...AI_SITES]).toEqual(SITES.map((s) => s.name));

  // Everything the manifest loads must be in the zip people download (a missing icon makes Chrome refuse the folder).
  const zip = (JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8")) as { scripts: Record<string, string> }).scripts["ext:zip"]!;
  const zipped = zip
    .slice(zip.indexOf("workspace-ai.zip", zip.indexOf("zip -q")) + "workspace-ai.zip".length)
    .trim()
    .split(/\s+/);
  const needed = [
    "manifest.json",
    "_locales",
    manifest.background.service_worker,
    manifest.options_page,
    manifest.action.default_popup,
    "options.js",
    "hint.js",
    ...manifest.content_scripts.flatMap((c) => c.js),
    ...Object.values(manifest.icons),
    ...Object.values(manifest.action.default_icon),
  ];
  for (const f of needed) {
    expect(existsSync(join(EXT, f)), `${f} exists`).toBe(true);
    expect(zipped.includes(f) || zipped.includes(f.split("/")[0]!), `${f} is in ext:zip`).toBe(true);
  }
});

test("every site: a prompt is recorded on Enter and on the send button; a button elsewhere records nothing", async () => {
  test.setTimeout(240_000);
  const p = await context.newPage();
  for (const [i, t] of targets.entries()) {
    const viaKey = i % 2 === 0;
    const text = `hello from ${t.host} ${viaKey ? "key" : "button"}`;
    await p.goto(`${t.url}s${i}`);
    await expect(p.locator("[role=status]")).toBeVisible();
    const c = p.locator("#c");
    await c.click();
    await p.keyboard.type(text);
    // A "Send feedback" button far from the composer is not the send button.
    await p.locator("#elsewhere").click();
    if (viaKey) await c.focus();
    if (viaKey) await p.keyboard.press("Enter");
    else await p.locator("#go").click();
    await expect(p.locator("#sent li")).toHaveText([text]);
    // The prompt leaves 1.5 s after the send (it waits for the conversation id); leaving the page earlier is a
    // best-effort path (pagehide) this test does not lean on.
    await p.waitForTimeout(1700);
  }
  const missing = () => targets.filter((t) => !received.some((e) => (e.prompt ?? "").startsWith(`hello from ${t.host} `))).map((t) => t.host);
  await expect.poll(missing, { timeout: 30_000 }).toEqual([]);
  for (const t of targets) {
    const mine = received.filter((e) => (e.prompt ?? "").startsWith(`hello from ${t.host} `));
    expect(mine, t.host).toHaveLength(1);
    expect(new URL(String(mine[0]!.url)).hostname).toBe(t.host);
  }
  await p.close();
});

test("every site: block mode stops a card number before the site or the workspace sees it", async () => {
  test.setTimeout(240_000);
  mode = "block";
  await sw.evaluate(() => chrome.storage.local.set({ sensitiveMode: "block" }));
  const before = received.filter((e) => e.kind === "safety").length;
  const p = await context.newPage();
  // One host per site: the rule is the same on a site's other hosts.
  const firsts = SITES.map((s) => targets.find((t) => t.site === s)!);
  for (const [i, t] of firsts.entries()) {
    await p.goto(`${t.url}b${i}`);
    await expect(p.locator("[role=status]")).toBeVisible();
    await p.locator("#c").click();
    await p.keyboard.type("Pay with card 4111 1111 1111 1111");
    if (i % 2) await p.keyboard.press("Enter");
    else await p.locator("#go").click();
    await expect(p.locator("[data-wx=panel]"), t.host).toBeVisible();
    await p.locator("[data-wx=panel] button.primary").click();
    await expect(p.locator("#sent li")).toHaveCount(0);
  }
  await expect.poll(() => received.filter((e) => e.kind === "safety" && e.action === "block").length - before, { timeout: 30_000 }).toBe(firsts.length);
  expect(JSON.stringify(received)).not.toContain("4111");
  mode = "warn";
  await sw.evaluate(() => chrome.storage.local.set({ sensitiveMode: "warn" }));
  await p.close();
});

test("a capture made while a batch is on its way is sent too, not overwritten", async () => {
  delay = 2500;
  const p = await context.newPage();
  await p.goto("https://chatgpt.com/c/race-1");
  await expect(p.locator("[role=status]")).toBeVisible();
  for (const text of ["race one", "race two"]) {
    await p.locator("#c").click();
    await p.keyboard.type(text);
    await p.keyboard.press("Enter");
    // The first prompt leaves the page after 1.5 s and its batch then takes 2.5 s: the second lands in between.
    await p.waitForTimeout(1800);
  }
  await expect.poll(() => received.filter((e) => (e.prompt ?? "").startsWith("race ")).map((e) => e.prompt), { timeout: 30_000 }).toEqual(["race one", "race two"]);
  delay = 0;
  expect(((await sw.evaluate(() => chrome.storage.local.get("queue"))) as { queue?: unknown[] }).queue ?? []).toHaveLength(0);
  await p.close();
});
