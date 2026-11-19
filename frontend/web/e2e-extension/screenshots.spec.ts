import { test, expect, chromium, type BrowserContext, type Worker } from "@playwright/test";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Store screenshots (1280×800) of the extension on a fake chat page, headless: the notice, the redact panel, the
 * block notice, the "did AI help?" chip and the options page. Written to docs/extension/screenshots/. Skipped in
 * the normal run; `EXT_SHOTS=1 pnpm test:ext` produces them.
 */

declare const chrome: { storage: { local: { set(items: Record<string, unknown>): Promise<void> } } };

const EXT = fileURLToPath(new URL("../../browser-extension", import.meta.url));
const OUT = fileURLToPath(new URL("../../../docs/extension/screenshots", import.meta.url));

test.skip(!process.env.EXT_SHOTS, "set EXT_SHOTS=1 to regenerate the store screenshots");

let server: Server;
let base = "";
let mode: "warn" | "redact" | "block" = "redact";
let context: BrowserContext;
let sw: Worker;
let profile: string;

// A chat page that looks like one, without any site's branding.
const CHAT = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Chat</title><style>
  body{margin:0;font:15px/1.5 system-ui,sans-serif;color:#1c1c1e;background:#fff;display:grid;grid-template-columns:260px 1fr;min-height:100vh}
  aside{background:#f7f7f8;border-right:1px solid #ececf1;padding:16px}
  aside h1{font-size:15px;margin:0 0 14px}
  aside div{padding:8px 10px;border-radius:8px;color:#444;font-size:14px}
  aside div.on{background:#ececf1;color:#111}
  main{display:grid;grid-template-rows:1fr auto;max-width:760px;margin:0 auto;width:100%;padding:0 24px}
  .msgs{padding:48px 0 24px;display:grid;gap:24px;align-content:end}
  .u{justify-self:end;background:#f4f4f5;border-radius:18px;padding:10px 16px;max-width:70%}
  .a{max-width:85%}
  form{position:sticky;bottom:0;background:#fff;padding:12px 0 96px}
  .box{display:flex;align-items:flex-end;gap:8px;border:1px solid #d9d9e3;border-radius:16px;padding:10px 10px 10px 16px;box-shadow:0 2px 10px rgb(0 0 0/.05)}
  textarea{flex:1;border:0;outline:0;resize:none;font:inherit;min-height:48px}
  button{background:#111;color:#fff;border:0;border-radius:999px;width:36px;height:36px;font-size:18px;cursor:pointer}
</style></head><body>
<aside><h1>Chats</h1><div class="on">Reply to the customer</div><div>Q4 summary</div><div>SQL for the report</div></aside>
<main><div class="msgs" id="msgs"></div>
<form onsubmit="return false"><div class="box"><textarea id="prompt-textarea" placeholder="Message"></textarea><button type="button" data-testid="send-button" aria-label="Send">↑</button></div></form></main>
<script>
  document.querySelector("[data-testid=send-button]").addEventListener("click", () => {
    const t = document.querySelector("#prompt-textarea");
    const u = document.createElement("div"); u.className = "u"; u.textContent = t.value; document.querySelector("#msgs").append(u); t.value = "";
    setTimeout(() => { const a = document.createElement("div"); a.className = "a"; a.dataset.messageAuthorRole = "assistant";
      a.textContent = "Here is a draft you can send: Thank you for your patience. We have reviewed the invoice and will issue the corrected one by Friday."; document.querySelector("#msgs").append(a); }, 300);
  });
</script></body></html>`;

test.beforeAll(async () => {
  server = createServer((req, res) => {
    res.setHeader("access-control-allow-origin", "*");
    res.setHeader("access-control-allow-headers", "authorization, content-type");
    res.setHeader("access-control-allow-methods", "POST, OPTIONS");
    if (req.method === "OPTIONS") return res.end();
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const n = (JSON.parse(body || "{}").events ?? []).length as number;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ accepted: n, captureResponses: false, sensitiveMode: mode, keywords: ["Sao Mai"] }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  profile = mkdtempSync(join(tmpdir(), "wx-ext-shots-"));
  context = await chromium.launchPersistentContext(profile, {
    channel: "chromium",
    headless: true,
    locale: "en-US",
    viewport: { width: 1280, height: 800 },
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--lang=en-US"],
  });
  sw = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
  for (const p of context.pages()) if (p.url().startsWith("chrome-extension://")) await p.close();
  await sw.evaluate(
    ([server]) =>
      chrome.storage.local.set({
        server,
        token: "aim_testtesttesttesttesttest",
        status: "connected",
        sensitiveMode: "redact",
        keywords: ["Sao Mai"],
        lastSentAt: new Date().toISOString(),
      }),
    [base],
  );
  await context.route("https://chatgpt.com/**", (route) => route.fulfill({ contentType: "text/html", body: CHAT }));
});

test.afterAll(async () => {
  await context?.close();
  server?.close();
  rmSync(profile, { recursive: true, force: true });
});

const shot = (name: string) => join(OUT, `${name}.png`);

test("1 notice: the pill in the corner, expanded", async () => {
  const page = await context.newPage();
  await page.goto("https://chatgpt.com/c/shots-1");
  await page.locator("#prompt-textarea").fill("Draft a reply to the customer about the late invoice");
  const pill = page.locator("[role=status]");
  await expect(pill).toBeVisible();
  await pill.click();
  await page.screenshot({ path: shot("1-notice") });
  await page.close();
});

test("2 redact: the panel with the text that will be sent", async () => {
  const page = await context.newPage();
  await page.goto("https://chatgpt.com/c/shots-2");
  await page.locator("#prompt-textarea").fill("Write a quote for Sao Mai. Contact: lan@example.com, 0912 345 678. Customer ID card 079203001234.");
  await page.locator("[data-testid=send-button]").click();
  await expect(page.locator("[data-wx=preview]")).toContainText("[KEYWORD]");
  await page.screenshot({ path: shot("2-redact") });
  await page.close();
});

test("3 feedback: did AI help?", async () => {
  const page = await context.newPage();
  await page.goto("https://chatgpt.com/c/shots-3");
  await page.locator("#prompt-textarea").fill("Draft a reply to the customer about the late invoice");
  await page.locator("[data-testid=send-button]").click();
  await expect(page.locator("[data-wx=feedback]")).toBeVisible({ timeout: 20_000 });
  await page.screenshot({ path: shot("3-feedback") });
  await page.close();
});

test("4 block: the message was not sent", async () => {
  mode = "block";
  await sw.evaluate(() => chrome.storage.local.set({ sensitiveMode: "block" }));
  const page = await context.newPage();
  await page.goto("https://chatgpt.com/c/shots-4");
  await page.locator("#prompt-textarea").fill("Charge the deposit to card 4111 1111 1111 1111, expiry 12/28");
  await page.locator("[data-testid=send-button]").click();
  await expect(page.locator("[data-wx=panel]")).toBeVisible();
  await page.screenshot({ path: shot("4-block") });
  await page.close();
});

test("5 options page", async () => {
  const id = new URL(sw.url()).host;
  const page = await context.newPage();
  await page.goto(`chrome-extension://${id}/options.html`);
  await expect(page.locator("#status")).toContainText("Connected");
  // The popup is 360px wide; centre it on a neutral ground for the 1280×800 frame.
  await page.addStyleTag({ content: "html{background:#eef0fe;min-height:100vh;display:grid;place-items:center}body{border-radius:12px;box-shadow:0 12px 32px rgb(11 18 32/.12)}" });
  await page.screenshot({ path: shot("5-options") });
  await page.close();
});
