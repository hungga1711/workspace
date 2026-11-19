import { expect, test } from "@playwright/test";
import { setupWorkspace } from "./helpers";

/** Inline comments: select text in a page, comment on it, the quote is marked and leads back to the text. */
test("comment on selected text in a page", async ({ page }) => {
  test.setTimeout(150_000);
  const run = Date.now().toString(36);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await setupWorkspace(page, { company: `Inline ${run}`, name: "Lê Minh", email: `inline-${run}@example.com` });
  const h = { headers: { "x-wos-csrf": "1" } };
  const html = "<h2>Phạm vi</h2><p>Bản 2.0 phát hành ngày <strong>30/10</strong> cho hai khách hàng thí điểm.</p><p>Ngân sách quảng cáo là 50 triệu.</p>";
  const d = await (await page.request.post("/api/proxy/work/docs", { ...h, data: { title: "Kế hoạch ra mắt", content: html, format: "html" } })).json();
  await page.goto(`/app/work/docs/${d.id}`);

  // Select across the bold date (two text nodes) with the mouse.
  const para = page.locator("[data-doc-body] p").first();
  await expect(para).toBeVisible();
  await para.evaluate((el) => {
    const r = document.createRange();
    const first = el.firstChild!; // "Bản 2.0 phát hành ngày "
    r.setStart(first, 4);
    r.setEnd(el.childNodes[2]!, 4); // " cho"
    const s = window.getSelection()!;
    s.removeAllRanges();
    s.addRange(r);
  });
  await para.dispatchEvent("mouseup");
  await page.getByRole("button", { name: "Bình luận", exact: true }).click();
  await expect(page.getByTestId("comment-quote")).toHaveText("2.0 phát hành ngày 30/10 cho");
  await page.getByLabel("Thêm bình luận").fill("Ngày này đã chốt với khách chưa?");
  await page.getByRole("button", { name: "Gửi" }).click();
  await expect(page.getByRole("heading", { name: "Bình luận (1)" })).toBeVisible();
  // The quote is painted in the page and leads back to the text.
  await expect.poll(() => page.evaluate(() => (CSS as unknown as { highlights: Map<string, { size: number }> }).highlights.get("doc-comment")?.size ?? 0)).toBe(1);
  await page.getByRole("button", { name: "2.0 phát hành ngày 30/10 cho" }).click();
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toContain("30/10");
});
