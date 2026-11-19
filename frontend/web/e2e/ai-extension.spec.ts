import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, expect, test } from "@playwright/test";
import { resetTestDatabase } from "./helpers";

/**
 * The workspace AI browser extension, for real: loaded unpacked in Chromium, connected with a code
 * from Của tôi › AI, then used on (stand-ins for) chatgpt.com and claude.ai. The page shows the notice,
 * the prompt sent with Enter / the send button reaches workspace with its tool and conversation, and
 * nothing is recorded before sending.
 */
const BASE = process.env.E2E_BASE_URL ?? "http://localhost:3000";
const EXT = resolve("../browser-extension");

const CHATGPT = `<!doctype html><html><head><meta charset="utf-8"></head><body>
<main><div id="thread"></div>
<form onsubmit="return false"><div id="prompt-textarea" contenteditable="true" style="min-height:40px;border:1px solid #ccc"></div>
<button type="button" data-testid="send-button" aria-label="Send prompt">Send</button></form></main>
<script>
  const send = () => {
    const box = document.getElementById("prompt-textarea");
    const text = box.innerText.trim();
    if (!text) return;
    setTimeout(() => {
      box.innerText = "";
      history.pushState({}, "", "/c/6714aa00-test");
      const a = document.createElement("div");
      a.setAttribute("data-message-author-role", "assistant");
      a.innerText = "Đây là câu trả lời.";
      document.getElementById("thread").appendChild(a);
    }, 50);
  };
  document.querySelector("[data-testid=send-button]").addEventListener("click", send);
  document.getElementById("prompt-textarea").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } });
</script></body></html>`;

const CLAUDE = `<!doctype html><html><head><meta charset="utf-8"></head><body>
<div class="ProseMirror" contenteditable="true" style="min-height:40px;border:1px solid #ccc"></div>
<button type="button" aria-label="Send message">Send</button>
<script>
  document.querySelector("button").addEventListener("click", () => {
    setTimeout(() => { document.querySelector(".ProseMirror").innerText = ""; history.pushState({}, "", "/chat/9f1c-test"); }, 50);
  });
</script></body></html>`;

test("the extension records prompts sent on ChatGPT and Claude, with a notice on the page", async () => {
  test.setTimeout(180_000);
  const ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), "workspace-ext-")), {
    channel: "chromium",
    headless: true,
    viewport: { width: 1280, height: 900 },
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  });
  try {
    await ctx.route("https://chatgpt.com/**", (r) => r.fulfill({ contentType: "text/html; charset=utf-8", body: CHATGPT }));
    await ctx.route("https://claude.ai/**", (r) => r.fulfill({ contentType: "text/html; charset=utf-8", body: CLAUDE }));
    const worker = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent("serviceworker"));
    const extId = new URL(worker.url()).host;

    // A person with a connection code.
    // On install the extension opens its options in the first tab; work in a tab of our own.
    await expect.poll(() => ctx.pages().some((p) => p.url().startsWith("chrome-extension://")), { timeout: 10_000 }).toBe(true);
    // The extension speaks the browser's language (_locales), which headless Chromium does not let us pick: its texts
    // are matched in either language.
    const locales = ["vi", "en"].map((l) => JSON.parse(readFileSync(join(EXT, "_locales", l, "messages.json"), "utf8")) as Record<string, { message: string }>);
    const escape = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const msg = (key: string) => new RegExp(locales.map((m) => escape(m[key]!.message)).join("|"));
    const page = await ctx.newPage();
    const run = Date.now().toString(36);
    await resetTestDatabase();
    await page.goto(`${BASE}/setup`);
    await page.getByLabel("Tên công ty").fill(`Ext ${run}`);
    await page.getByLabel("Họ tên của bạn").fill("Phạm Quốc Khánh");
    await page.getByLabel("Email công việc").fill(`ext-${run}@example.com`);
    await page.getByLabel("Mật khẩu").fill("Passw0rd!dev");
    await page.getByRole("button", { name: "Tạo không gian làm việc" }).click();
    await page.waitForURL(/\/app\/welcome/);

    // Not connected yet: the notice says so and nothing is sent.
    const gpt = await ctx.newPage();
    await gpt.goto("https://chatgpt.com/");
    await expect(gpt.getByText(msg("noticeOff"))).toBeVisible();

    // The company keeps answers too: the very first answer must be kept.
    const put = await page.request.put(`${BASE}/api/proxy/ai/policy`, {
      headers: { "x-wos-csrf": "1" },
      data: { detail: "summary", captureResponses: true, retentionDays: 90 },
    });
    expect(put.status()).toBe(200);
    await page.goto(`${BASE}/app/me?tab=ai`);
    await page.getByRole("button", { name: "Tạo mã kết nối" }).click();
    const code = (await page.getByTestId("ai-code").textContent())!.trim();
    const options = await ctx.newPage();
    await options.goto(`chrome-extension://${extId}/options.html`);
    // A wrong code is caught at once.
    await options.getByLabel(msg("optCodeLabel")).fill(`${BASE}#aim_wrongwrongwrongwrongwrongwrong`);
    await options.getByRole("button", { name: msg("optConnect"), exact: true }).click();
    await expect(options.getByText(msg("statusExpired"))).toBeVisible();
    await options.getByLabel(msg("optCodeLabel")).fill(code);
    await options.getByRole("button", { name: msg("optConnect"), exact: true }).click();
    await expect(options.getByText(new RegExp(locales.map((m) => escape(m.statusConnected!.message.replace(" $host$", ""))).join("|")))).toBeVisible();
    // A page already open follows the connection without a reload.
    await expect(gpt.getByText(msg("noticeOn"))).toBeVisible();
    await gpt.close();

    // ChatGPT: typed, sent with Enter; a draft that is never sent stays private.
    const chat = await ctx.newPage();
    await chat.goto("https://chatgpt.com/");
    await expect(chat.getByText(msg("noticeOn"))).toBeVisible();
    const box = chat.locator("#prompt-textarea");
    await box.click();
    await box.pressSequentially("Viết công thức Excel tính hoa hồng theo bậc doanh thu");
    await box.press("Enter");
    await box.pressSequentially("bản nháp không gửi");
    // Claude: sent with the button.
    const claude = await ctx.newPage();
    await claude.goto("https://claude.ai/new");
    const pm = claude.locator(".ProseMirror");
    await pm.click();
    await pm.pressSequentially("Dịch hợp đồng dịch vụ sang tiếng Anh");
    await claude.getByRole("button", { name: "Send message" }).click();

    // A password in the prompt: the extension asks first; "Cancel" keeps it on screen, unsent.
    let asked = "";
    chat.once("dialog", (d) => {
      asked = d.message();
      void d.dismiss();
    });
    await box.evaluate((el) => (el.textContent = ""));
    await box.pressSequentially("Kết nối DB password: Hunter2024!");
    await box.press("Enter");
    await expect.poll(() => asked).toMatch(msg("kindSecret"));
    await expect(box).toContainText("Hunter2024");
    await expect(chat.locator("[data-message-author-role=assistant]")).toHaveCount(1); // only the first prompt was answered

    const stats = async () =>
      (await (await page.request.get(`${BASE}/api/proxy/ai/oversight/me`, { headers: { "x-wos-csrf": "1" } })).json()).stats as { source: string; prompts: number }[];
    await expect.poll(async () => (await stats()).map((s) => `${s.source}:${s.prompts}`).sort(), { timeout: 30_000 }).toEqual(["chatgpt:1", "claude:1"]);

    // The boss (owner) sees both, with their topics, and the draft is nowhere.
    await page.goto(`${BASE}/app/ai/adoption/usage`);
    // The recent conversations sit behind the "Gần đây" toggle under Chi tiết.
    await page.getByRole("button", { name: /^Gần đây/ }).click();
    const recent = page.locator("#ai-recent");
    await expect(recent.getByText(/ChatGPT · Phân tích số liệu/)).toBeVisible();
    await expect(recent.getByText(/Claude · Dịch thuật/)).toBeVisible();
    await expect(page.getByText("bản nháp không gửi")).toHaveCount(0);
    // The answer on the page was kept with the prompt (policy: keep answers); it is sent once it has
    // stopped changing for 3 seconds. Only the person reads it (their own export): the boss has no way to open text.
    const h = { headers: { "x-wos-csrf": "1" } };
    await expect
      .poll(async () => JSON.stringify(await (await page.request.get(`${BASE}/api/proxy/ai/oversight/me/export`, h)).json()), { timeout: 30_000 })
      .toContain("Đây là câu trả lời.");
    const gptConv = (await (await page.request.get(`${BASE}/api/proxy/ai/oversight?days=7`, h)).json()).recent.find((c: { source: string }) => c.source === "chatgpt");
    expect(gptConv.title).toBeUndefined();
    expect((await page.request.get(`${BASE}/api/proxy/ai/oversight/conversations/${gptConv.id}`, h)).status()).toBe(404);
    await expect(recent.getByRole("button", { name: "Xem nội dung" })).toHaveCount(0);
  } finally {
    await ctx.close();
  }
});
