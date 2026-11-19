import { expect, test } from "@playwright/test";
import { setupWorkspace } from "./helpers";

/** Chưa đọc: new messages from every conversation on one page; "Đã đọc" clears a card. Docs: the page outline rail. */
test("unreads gathers new messages and clears them; a docs page shows its outline", async ({ page }) => {
  test.setTimeout(150_000);
  const run = Date.now().toString(36);
  await page.setViewportSize({ width: 1600, height: 1000 });
  await setupWorkspace(page, { company: `Unread ${run}`, name: "Lê Minh", email: `unread-${run}@example.com` });
  const h = { headers: { "x-wos-csrf": "1" } };
  const ch = await (await page.request.post("/api/proxy/chat/channels", { ...h, data: { kind: "public", name: `kinh-doanh-${run}` } })).json();
  const msg = await (await page.request.post(`/api/proxy/chat/channels/${ch.id}/messages`, { ...h, data: { body: "Khách Nhật Minh chốt hợp đồng 12 tháng" } })).json();
  await page.request.post(`/api/proxy/chat/channels/${ch.id}/unread`, { ...h, data: { seq: msg.seq } });

  await page.goto("/app/chat/unreads");
  await expect(page.getByRole("heading", { name: "Tin nhắn", level: 1 })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Tin nhắn", exact: true }).getByRole("link", { name: "Chưa đọc" })).toHaveAttribute("aria-current", "page");
  const card = page.locator("section").filter({ hasText: "Khách Nhật Minh chốt hợp đồng 12 tháng" });
  await expect(card).toBeVisible();
  // The card goes at once; the reload below must wait for the server to have it too.
  await Promise.all([page.waitForResponse((r) => r.url().endsWith(`/channels/${ch.id}/read`)), card.getByRole("button", { name: "Đã đọc" }).click()]);
  await expect(card).toHaveCount(0);
  await page.reload();
  await expect(page.getByText("Khách Nhật Minh chốt hợp đồng 12 tháng")).toHaveCount(0);

  const d = await (
    await page.request.post("/api/proxy/work/docs", {
      ...h,
      data: { title: "Quy trình release", content: "<h2>Chuẩn bị</h2><p>a</p><h2>Triển khai</h2><p>b</p><h3>Kiểm tra</h3><p>c</p>", format: "html" },
    })
  ).json();
  await page.goto(`/app/work/docs/${d.id}`);
  const outline = page.getByRole("navigation", { name: "Trên trang này" });
  await expect(outline.getByRole("link", { name: "Triển khai" })).toBeVisible();
  await outline.getByRole("link", { name: "Kiểm tra" }).click();
  await expect(outline.getByRole("link", { name: "Kiểm tra" })).toHaveAttribute("aria-current", "location");
});
