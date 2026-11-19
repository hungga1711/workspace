import { expect, test } from "@playwright/test";
import { setupWorkspace } from "./helpers";

/**
 * Task peek: a task opened from a list or a board shows over it (the URL changes so it can be
 * shared, by the task's code), edits show behind it at once, Esc returns to the list, and "Open full page" loads
 * the page. Old links by id keep working.
 */
test("tasks open over the list and the board, and the full page is one click away", async ({ page }) => {
  test.setTimeout(180_000);
  const run = Date.now().toString(36);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await setupWorkspace(page, { company: `Peek ${run}`, name: "Phạm Thu", email: `peek-${run}@example.com` });
  const post = async (path: string, data: unknown) => (await page.request.post(`/api/proxy/${path}`, { headers: { "x-wos-csrf": "1" }, data })).json();
  const project = await post("work/projects", { name: "Ra mắt" });
  const task = await post("work/tasks", { title: "Viết tài liệu API", projectId: project.id });

  // From the list.
  await page.goto("/app/work/tasks");
  await page.getByRole("navigation", { name: "Các mục của Việc" }).getByRole("link", { name: "Việc của tôi" }).click();
  await page.getByRole("group", { name: "Việc của tôi" }).getByRole("link", { name: "Tôi giao" }).click();
  await page
    .getByRole("link", { name: /Viết tài liệu API/ })
    .first()
    .click();
  // The drawer is named by its context (code · project); the task's name is the one title inside it.
  const view = page.getByRole("dialog", { name: /· Ra mắt$/ });
  await expect(view).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/app/work/tasks/${task.code}$`));
  await page.keyboard.press("Escape");
  await expect(view).toHaveCount(0);
  await expect(page).toHaveURL(/\/app\/work\/tasks(\?|$)/);

  // From the board: a status change shows behind the view without closing it.
  await page.goto(`/app/work/projects/${project.id}`);
  await page.getByRole("link", { name: "Viết tài liệu API" }).click();
  await expect(view).toBeVisible();
  await view.getByRole("button", { name: "Trạng thái" }).click();
  await view.getByRole("option", { name: "Đang làm" }).click();
  await expect(view.getByRole("status").filter({ hasText: "Đã lưu" })).toBeVisible();
  await view.getByRole("button", { name: "Đóng" }).click();
  await expect(view).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`/app/work/projects/${project.id}$`));

  // "Open full page" is a real page, not the view.
  await page.getByRole("link", { name: "Viết tài liệu API" }).click();
  // The task's code in the header is the link to its page (named by the code; "Mở trang đầy đủ" is its tooltip).
  await view.getByTitle("Mở trang đầy đủ").click();
  await expect(page).toHaveURL(new RegExp(`/app/work/tasks/${task.code}$`));
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Tiêu đề" })).toHaveValue("Viết tài liệu API");

  // The code in any case, and the id of older links, open the same task.
  for (const ref of [task.code.toLowerCase(), task.id]) {
    await page.goto(`/app/work/tasks/${ref}`);
    await expect(page.getByRole("textbox", { name: "Tiêu đề" })).toHaveValue("Viết tài liệu API");
  }
  await page.goto(`/app/work/projects/${project.code}`);
  await expect(page.getByRole("link", { name: "Viết tài liệu API" })).toBeVisible();

  // Old links (`?task=` over a page) open the task's own address.
  await page.goto(`/app/work?tab=tasks&task=${task.code}`);
  await expect(page).toHaveURL(new RegExp(`/app/work/tasks/${task.code}$`));
  await expect(page.getByRole("textbox", { name: "Tiêu đề" })).toHaveValue("Viết tài liệu API");
});
