import { expect, test, type Locator } from "@playwright/test";
import { setupWorkspace } from "./helpers";

const inView = async (log: Locator, row: Locator) => {
  const [a, b] = await Promise.all([log.boundingBox(), row.boundingBox()]);
  return !!a && !!b && b.y >= a.y && b.y + b.height <= a.y + a.height;
};

/** A long conversation opens where the reader is going: a linked old message in context, or the first unread. */
test("a link to an old message opens the log around it; many unread open at the first one", async ({ page }) => {
  test.setTimeout(150_000);
  const run = Date.now().toString(36);
  await page.setViewportSize({ width: 1440, height: 900 });
  await setupWorkspace(page, { company: `History ${run}`, name: "Lê Minh", email: `history-${run}@example.com` });
  const h = { headers: { "x-wos-csrf": "1" } };
  const ch = await (await page.request.post("/api/proxy/chat/channels", { ...h, data: { kind: "public", name: `lich-su-${run}` } })).json();
  const sent: { id: string; seq: number }[] = [];
  for (let i = 1; i <= 120; i++) sent.push(await (await page.request.post(`/api/proxy/chat/channels/${ch.id}/messages`, { ...h, data: { body: `Tin số ${i} ạ` } })).json());

  // The permalink of message 10 (110 newer ones after it): centred and highlighted, older and newer pages around it.
  await page.goto(`/app/chat/m/${sent[9]!.id}`);
  const log = page.getByRole("log");
  const old = log.locator("article", { hasText: "Tin số 10 ạ" });
  await expect(old).toBeVisible();
  await expect.poll(() => inView(log, old)).toBe(true);
  await expect(page.getByRole("button", { name: "Xuống tin mới nhất" })).toBeVisible();
  // Scrolling down pages forward through the rest, up to the newest.
  for (let i = 0; i < 6; i++) {
    await log.evaluate((e) => (e.scrollTop = e.scrollHeight));
    await page.waitForTimeout(300);
  }
  await expect(log.locator("article", { hasText: "Tin số 120 ạ" })).toBeVisible();

  // "Xuống tin mới nhất" from an older stretch loads the newest page.
  await page.goto(`/app/chat/m/${sent[4]!.id}`);
  await expect(log.locator("article", { hasText: "Tin số 5 ạ" })).toBeVisible();
  await page.getByRole("button", { name: "Xuống tin mới nhất" }).click();
  await expect(log.locator("article", { hasText: "Tin số 120 ạ" })).toBeVisible();

  // 100 unread (more than a page): the conversation opens at the first of them, not at the bottom.
  await page.request.post(`/api/proxy/chat/channels/${ch.id}/unread`, { ...h, data: { seq: sent[20]!.seq } });
  await page.goto(`/app/chat/${ch.id}`);
  const first = log.locator("article", { hasText: "Tin số 21 ạ" });
  await expect(first).toBeVisible();
  await expect.poll(() => inView(log, first)).toBe(true);
  await expect(log.locator("article", { hasText: "Tin số 120 ạ" })).toHaveCount(0);
});
