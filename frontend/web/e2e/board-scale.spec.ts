import { expect, test } from "@playwright/test";
import { setupWorkspace } from "./helpers";

/** Big boards: server-side filters, 50 cards per column with "show more", quick filters, swimlanes, compact cards. */
test("a board with many cards loads in pages, filters on the server and groups by assignee", async ({ page }) => {
  test.setTimeout(180_000);
  const run = Date.now().toString(36);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await setupWorkspace(page, { company: `Board ${run}`, name: "Lê Minh", email: `board-${run}@example.com` });
  const post = (path: string, data: unknown) => page.request.post(`/api/proxy/${path}`, { headers: { "x-wos-csrf": "1" }, data });
  const me = (await (await page.request.get("/api/proxy/identity/members", { headers: { "x-wos-csrf": "1" } })).json()).members[0].userId as string;
  const project = await (await post("work/projects", { name: "Ra mắt lớn" })).json();
  for (let i = 0; i < 60; i++) await post("work/tasks", { title: `Việc số ${i}`, projectId: project.id, assigneeId: i < 5 ? me : null });

  await page.goto(`/app/work/tasks?project=${project.id}`);
  const todo = page.getByRole("region", { name: "Cần làm" });
  await expect(todo.locator("[data-card]")).toHaveCount(50);
  await todo.getByRole("button", { name: "Xem thêm 10 thẻ" }).click();
  await expect(todo.locator("[data-card]")).toHaveCount(60);

  // Quick filters sit in the "Bộ lọc" panel (one toolbar row above the board).
  await page.getByRole("button", { name: "Bộ lọc" }).click();
  await page.getByRole("dialog", { name: "Bộ lọc" }).getByRole("button", { name: "Của tôi" }).click();
  await expect(todo.locator("[data-card]")).toHaveCount(5);
  await page.getByRole("button", { name: "Lọc thẻ" }).click();
  await page.getByRole("searchbox", { name: "Lọc thẻ" }).fill("Việc số 3");
  await expect(todo.locator("[data-card]")).toHaveCount(1);
  await page.getByRole("button", { name: "Bỏ lọc" }).click();
  await expect(todo.locator("[data-card]")).toHaveCount(50);

  // Display options live in the "Hiển thị" panel.
  await page.getByRole("button", { name: "Hiển thị" }).click();
  await page.getByRole("button", { name: "Nhóm theo" }).click();
  await page.getByRole("option", { name: "Người làm" }).click();
  await expect(page.getByRole("region", { name: "Chưa giao" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Lê Minh" })).toBeVisible();
  await page.getByRole("button", { name: "Nhóm theo" }).click();
  await page.getByRole("option", { name: "Không nhóm" }).click();
  await page.getByLabel("Thẻ gọn").check();
  await expect(todo.locator("[data-card]").first()).toContainText("T-");
});
