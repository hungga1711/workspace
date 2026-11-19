import { expect, test } from "@playwright/test";
import { api, setupWorkspace } from "./helpers";

/** Search: ⌘K and the results page cover tasks, documents, files and messages, permission-filtered. */
const run = Date.now().toString(36);
const WORD = `kiemtoan${run}`;

test("finds tasks, documents and messages from ⌘K and the results page", async ({ browser }) => {
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 1000 } })).newPage();
  await setupWorkspace(page, { company: `Search ${run}`, name: "Mạc Tú", email: `search-${run}@example.com` });
  await api(page, "POST", "work/tasks", { title: `Chuẩn bị ${WORD} cuối năm` });
  await api(page, "POST", "work/docs", { title: `Quy trình ${WORD}`, content: "Các bước kiểm toán nội bộ", visibility: "workspace" });
  await expect.poll(async () => (await api(page, "GET", "chat/channels")).body.channels.length).toBeGreaterThan(0);
  const general = (await api(page, "GET", "chat/channels")).body.channels.find((c: { name: string }) => c.name === "general").id;
  await api(page, "POST", `chat/channels/${general}/messages`, { body: `Nhắc mọi người nộp hồ sơ ${WORD} trước thứ Sáu` });

  await expect
    .poll(
      async () => {
        const r = await api(page, "GET", `chat/search?q=${WORD}`);
        return new Set((r.body?.hits ?? []).map((h: { entity_type: string }) => h.entity_type)).size;
      },
      { timeout: 60_000 },
    )
    .toBe(3);

  await page.goto("/app/home");
  await page.keyboard.press("ControlOrMeta+k");
  await page.getByRole("combobox").fill(WORD);
  await expect(page.getByRole("option", { name: new RegExp(`Chuẩn bị ${WORD}`) })).toBeVisible();
  await page.getByRole("option", { name: /Xem tất cả kết quả/ }).click();
  await page.waitForURL(/\/app\/search\?q=/);
  const results = page.getByRole("main");
  await expect(results.getByRole("link", { name: new RegExp(`Quy trình ${WORD}`) })).toBeVisible();
  await expect(results.getByRole("link", { name: new RegExp(`nộp hồ sơ ${WORD}`) })).toBeVisible();
  if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/search.png` });
  await page.getByRole("group", { name: "Loại kết quả" }).getByRole("link", { name: "Việc" }).click();
  await expect(results.getByRole("link", { name: new RegExp(`Quy trình ${WORD}`) })).toHaveCount(0);
  await expect(results.getByRole("link", { name: new RegExp(`Chuẩn bị ${WORD}`) })).toBeVisible();
});
