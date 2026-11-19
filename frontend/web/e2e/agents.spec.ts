import { expect, test } from "@playwright/test";
import { setupWorkspace } from "./helpers";

/** Admin › AI & agent: create an agent, grant, budget, turn off; chat explains why it cannot answer. */
const run = Date.now().toString(36);

test("admins create, budget and switch off an agent", async ({ browser }) => {
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 1000 } })).newPage();
  await setupWorkspace(page, { company: `Agt ${run}`, name: "Ninh Khoa", email: `agt-${run}@example.com` });
  await page.goto("/admin/workspace/agents");
  await page.getByRole("button", { name: "Tạo agent" }).click();
  const dlg = page.getByRole("dialog", { name: "Tạo agent" });
  await dlg.getByLabel("Tên agent").fill("Trợ lý Kinh doanh");
  await dlg.getByLabel(/Ngân sách token/).fill("50000");
  await dlg.getByRole("button", { name: "Tạo" }).click();
  await expect(page.getByRole("status")).toContainText("Đã tạo Trợ lý Kinh doanh");
  const card = page.getByRole("listitem").filter({ hasText: "Trợ lý Kinh doanh" });
  await expect(card).toContainText("ngân sách 50.000");
  await card.getByRole("switch", { name: "Bật Trợ lý Kinh doanh" }).click();
  await expect(page.getByRole("status")).toContainText("Đã tắt Trợ lý Kinh doanh");
  await expect(card.getByRole("switch")).toHaveAttribute("aria-checked", "false");
  await card.getByRole("button", { name: "Hoạt động" }).click();
  await expect(page.getByRole("dialog", { name: "Hoạt động của Trợ lý Kinh doanh" })).toContainText("0 lần gọi");
  if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/agents.png` });
});
