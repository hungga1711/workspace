import { expect, test } from "@playwright/test";
import { setupWorkspace } from "./helpers";

/**
 * Custom Kanban columns: add one inline, rename inline, move cards in, remove it with a destination. A column stands
 * for a status (work/007_board_column_status): a card moved into it takes that status, and a card
 * whose status changes moves to the column of its new status.
 */
test("a project's columns can be added, renamed and removed; cards follow the status a column stands for", async ({ page }) => {
  test.setTimeout(180_000);
  const run = Date.now().toString(36);
  await page.setViewportSize({ width: 1600, height: 1000 });
  await setupWorkspace(page, { company: `Cols ${run}`, name: "Lê Minh", email: `cols-${run}@example.com` });
  const h = { headers: { "x-wos-csrf": "1" } };
  const project = await (await page.request.post("/api/proxy/work/projects", { ...h, data: { name: "Cột tuỳ chỉnh" } })).json();
  for (const title of ["Viết API", "Thiết kế màn hình"]) await page.request.post("/api/proxy/work/tasks", { ...h, data: { title, projectId: project.id } });

  await page.goto(`/app/work/tasks?project=${project.id}`);
  await expect(page.getByRole("region", { name: "Cần làm" }).locator("[data-card]")).toHaveCount(2);

  // Add "Chờ khách duyệt": the name is typed where the column appears.
  // The toolbar's button (the "+" lane after the last column has the same name).
  await page.getByRole("toolbar").getByRole("button", { name: "Thêm cột" }).click();
  await page.getByRole("textbox", { name: "Thêm cột" }).fill("Chờ khách duyệt");
  await page.keyboard.press("Enter");
  const waiting = page.getByRole("region", { name: "Chờ khách duyệt" });
  await expect(waiting).toBeVisible();

  // Moving a card there gives it the column's status: "Chờ … duyệt" reads as review (projects.ts columnStatusFor).
  const board = await (await page.request.get(`/api/proxy/work/projects/${project.id}/board`, h)).json();
  const col = board.columns.find((c: { name: string }) => c.name === "Chờ khách duyệt");
  const card = board.columns[0].tasks[0];
  const moved = await (
    await page.request.post(`/api/proxy/work/tasks/${card.id}/move`, { ...h, data: { columnId: col.id, beforeId: null, afterId: null, expectedVersion: card.version } })
  ).json();
  expect(moved.status).toBe("review");
  expect(moved.columnId).toBe(col.id);

  // Rename "Đang làm" inline from the column menu.
  await page.reload();
  await page.getByRole("region", { name: "Đang làm", exact: true }).hover();
  await page.getByRole("button", { name: "Tuỳ chọn cột Đang làm" }).click();
  await page.getByRole("menuitem", { name: "Đổi tên cột" }).click();
  await page.getByRole("textbox", { name: "Đổi tên cột" }).fill("Đang code");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("region", { name: "Đang code" })).toBeVisible();

  // A status change moves the card to the column that stands for the new status.
  const done = await page.request.patch(`/api/proxy/work/tasks/${card.id}`, { ...h, data: { expectedVersion: moved.version, status: "done" } });
  expect(done.status()).toBe(200);
  await page.reload();
  await expect(page.getByRole("region", { name: "Xong" }).locator("[data-card]", { hasText: card.title })).toBeVisible();
  await expect(waiting.locator("[data-card]")).toHaveCount(0);

  // The other card goes into the new column, so removing the column has something to move.
  const other = board.columns[0].tasks[1];
  await page.request.post(`/api/proxy/work/tasks/${other.id}/move`, { ...h, data: { columnId: col.id, beforeId: null, afterId: null, expectedVersion: other.version } });
  await page.reload();
  await expect(waiting.locator("[data-card]")).toHaveCount(1);

  // Remove the new column after confirming; its card goes to "Xong" and becomes done with it.
  await waiting.hover();
  await page.getByRole("button", { name: "Tuỳ chọn cột Chờ khách duyệt" }).click();
  await page.getByRole("menuitem", { name: "Xoá cột" }).click();
  await page.getByRole("button", { name: "Chuyển các việc sang" }).click();
  await page.getByRole("option", { name: "Xong" }).click();
  await page.getByRole("button", { name: "Xoá cột" }).last().click();
  await expect(page.getByRole("region", { name: "Chờ khách duyệt" })).toHaveCount(0);
  const after = await (await page.request.get(`/api/proxy/work/tasks/${other.id}`, h)).json();
  expect(after.task.status).toBe("done");
  await expect(page.getByRole("region", { name: "Xong" }).locator("[data-card]")).toHaveCount(2);
});
