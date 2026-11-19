import { test, expect, chromium, type BrowserContext, type Worker } from "@playwright/test";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The extension end to end, headless: a fake ChatGPT page (served at https://chatgpt.com by routing) and a fake
 * workspace events endpoint on localhost. Checks the safety net (redact shows and sends the redacted text with
 * counts; block sends nothing but a safety event), the task hint and the one-tap "did AI help?".
 */

// The extension APIs, as seen from its service worker (only what the test calls).
declare const chrome: { storage: { local: { set(items: Record<string, unknown>): Promise<void> } } };

const EXT = fileURLToPath(new URL("../../browser-extension", import.meta.url));
type Ev = Record<string, unknown> & { kind?: string; prompt?: string };

let server: Server;
let base = "";
let mode: "warn" | "redact" | "block" = "redact";
const received: Ev[] = [];
let context: BrowserContext;
let sw: Worker;
let profile: string;

const CHAT = `<!doctype html><html><body>
<form onsubmit="return false"><textarea id="prompt-textarea"></textarea><button type="button" data-testid="send-button">Send</button></form>
<ol id="sent"></ol><div id="answers"></div>
<script>
  // What a real chat site does on send: take the composer text, clear it, answer a moment later.
  document.querySelector("[data-testid=send-button]").addEventListener("click", () => {
    const t = document.querySelector("#prompt-textarea");
    const li = document.createElement("li"); li.textContent = t.value; document.querySelector("#sent").append(li); t.value = "";
    setTimeout(() => { const a = document.createElement("div"); a.dataset.messageAuthorRole = "assistant"; a.textContent = "Here is a draft."; document.querySelector("#answers").append(a); }, 300);
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
      const events = (JSON.parse(body || "{}").events ?? []) as Ev[];
      received.push(...events);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ accepted: events.length, captureResponses: false, sensitiveMode: mode, keywords: ["Sao Mai"] }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  profile = mkdtempSync(join(tmpdir(), "wx-ext-"));
  context = await chromium.launchPersistentContext(profile, {
    channel: "chromium",
    headless: true,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  });
  sw = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
  // Connected, as after pasting the code from Của tôi › AI (the options page tab it opened is closed).
  for (const p of context.pages()) if (p.url().startsWith("chrome-extension://")) await p.close();
  await sw.evaluate(
    ([server]) => chrome.storage.local.set({ server, token: "aim_testtesttesttesttesttest", status: "connected", sensitiveMode: "redact", keywords: ["Sao Mai"] }),
    [base],
  );
  await context.route("https://chatgpt.com/**", (route) => route.fulfill({ contentType: "text/html", body: CHAT }));
});

test.afterAll(async () => {
  await context?.close();
  server?.close();
  rmSync(profile, { recursive: true, force: true });
});

const waitFor = async (pred: (e: Ev) => boolean, timeout = 15_000) => {
  await expect.poll(() => received.find(pred), { timeout }).toBeTruthy();
  return received.find(pred)!;
};

test("redact: the person sees the redacted text, the site and workspace get only that, with counts and the task hint", async () => {
  await sw.evaluate(() => chrome.storage.local.set({ hintsEnabled: true, lastTaskSeen: { taskId: "task_0123456789", seenAt: new Date().toISOString() } }));
  const page = await context.newPage();
  await page.goto("https://chatgpt.com/c/redact-1");
  await page.locator("#prompt-textarea").fill("Báo giá cho Sao Mai, CCCD 079203001234, gửi lan@nhatminh.vn");
  await page.locator("[data-testid=send-button]").click();

  const preview = page.locator("[data-wx=preview]");
  await expect(preview).toHaveText("Báo giá cho [KEYWORD], CCCD [CCCD], gửi [EMAIL]");
  // Nothing has left yet.
  await expect(page.locator("#sent li")).toHaveCount(0);
  await page.locator("[data-wx=panel] button.primary").click();

  await expect(page.locator("#sent li")).toHaveText(["Báo giá cho [KEYWORD], CCCD [CCCD], gửi [EMAIL]"]);
  const turn = await waitFor((e) => (e.prompt ?? "").includes("[CCCD]"));
  expect(turn.prompt).toBe("Báo giá cho [KEYWORD], CCCD [CCCD], gửi [EMAIL]");
  expect(turn.redactions).toEqual({ keyword: 1, personal_id: 1, contacts: 1 });
  expect(turn.hint).toMatchObject({ taskId: "task_0123456789" });
  expect(JSON.stringify(received)).not.toContain("079203001234");

  // After the answer settles, one tap on "did AI help?".
  await page.locator("[data-wx=feedback] button[data-v=yes]").click({ timeout: 20_000 });
  const fb = await waitFor((e) => e.kind === "feedback");
  expect(fb).toMatchObject({ kind: "feedback", conversation: "/c/redact-1", helpful: "yes" });
  await page.close();
});

test("block: nothing is sent to the site or workspace except a safety event without text", async () => {
  mode = "block";
  await sw.evaluate(() => chrome.storage.local.set({ sensitiveMode: "block" }));
  const page = await context.newPage();
  await page.goto("https://chatgpt.com/c/block-1");
  await page.locator("#prompt-textarea").fill("Thanh toán bằng thẻ 4111 1111 1111 1111");
  await page.locator("[data-testid=send-button]").click();
  await expect(page.locator("[data-wx=panel]")).toBeVisible();
  await page.locator("[data-wx=panel] button.primary").click();
  await expect(page.locator("#sent li")).toHaveCount(0);
  await expect(page.locator("#prompt-textarea")).toHaveValue("Thanh toán bằng thẻ 4111 1111 1111 1111");

  const ev = await waitFor((e) => e.kind === "safety" && e.action === "block");
  expect(ev).toMatchObject({ kind: "safety", action: "block", kinds: ["card"], count: 1 });
  expect(JSON.stringify(received)).not.toContain("4111");
  await page.close();
});

test("a task code in the prompt: one tap links the chat to that task, once per conversation", async () => {
  mode = "warn";
  await sw.evaluate(() => chrome.storage.local.set({ sensitiveMode: "warn", hintsEnabled: false }));
  const page = await context.newPage();
  await page.goto("https://chatgpt.com/c/link-1");
  await page.locator("#prompt-textarea").fill("Summarise the status of T-157 for GPT-4 users");
  await page.locator("[data-testid=send-button]").click();

  const chip = page.locator("[data-wx=link]");
  await expect(chip).toContainText("T-157");
  await chip.locator("button[data-v=link]").click();
  const ev = await waitFor((e) => e.kind === "link");
  expect(ev).toMatchObject({ kind: "link", conversation: "/c/link-1", code: "T-157", decline: false });

  // The same conversation is not asked again.
  await page.locator("#prompt-textarea").fill("And T-158?");
  await page.locator("[data-testid=send-button]").click();
  await waitFor((e) => e.prompt === "And T-158?");
  await expect(page.locator("[data-wx=link]")).toHaveCount(0);
  await page.close();
});
