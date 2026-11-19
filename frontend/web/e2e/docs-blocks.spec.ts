import { expect, test } from "@playwright/test";
import { setupWorkspace } from "./helpers";

/** Docs: toggle and table-of-contents blocks, a checklist line turned into a task, Markdown export. */
test("a page gets a contents block, a toggle, a task from a checklist line and exports to Markdown", async ({ page }) => {
  test.setTimeout(150_000);
  const run = Date.now().toString(36);
  await page.setViewportSize({ width: 1440, height: 900 });
  await setupWorkspace(page, { company: `Docs ${run}`, name: "Lê Minh", email: `docs-${run}@example.com` });
  const h = { headers: { "x-wos-csrf": "1" } };
  const html = `<div data-toc=""></div><h2>Mục tiêu</h2><p>Ra mắt bản 2.0.</p><div data-toggle=""><p>Chi tiết kỹ thuật</p><p>Dùng SSO cho khách hàng.</p></div><ul data-type="taskList"><li data-type="taskItem" data-checked="false"><label><input type="checkbox"><span></span></label><div><p>Viết API hoá đơn</p></div></li></ul>`;
  const d = await (await page.request.post("/api/proxy/work/docs", { ...h, data: { title: "Kế hoạch ra mắt", content: html, format: "html" } })).json();
  await page.goto(`/app/work/docs/${d.id}`);

  // Contents lists the heading; the toggle folds its body.
  await expect(page.getByText("Mục lục")).toBeVisible();
  await expect(page.getByRole("button", { name: "Mục tiêu" })).toBeVisible();
  await expect(page.getByText("Dùng SSO cho khách hàng.")).toBeVisible();
  await page.getByRole("button", { name: "Thu gọn", exact: true }).click();
  await expect(page.getByText("Dùng SSO cho khách hàng.")).toBeHidden();

  // Edit: put the cursor in the checklist line and turn it into a task.
  await page.getByRole("button", { name: "Sửa" }).first().click();
  await page.getByText("Viết API hoá đơn").click();
  await page.getByRole("button", { name: "→ Tạo việc" }).click();
  await expect(page.getByRole("link", { name: /^T-\d+/ })).toBeVisible();
  const tasks = await (await page.request.get("/api/proxy/work/tasks?scope=owned", h)).json();
  expect(tasks.tasks.map((t: { title: string }) => t.title)).toContain("Viết API hoá đơn");

  // Markdown export (from the saved page).
  await page.goto(`/app/work/docs/${d.id}`);
  await page.getByRole("button", { name: "Thêm thao tác" }).click();
  const [dl] = await Promise.all([page.waitForEvent("download"), page.getByRole("menuitem", { name: "Tải Markdown (.md)" }).click()]);
  expect(dl.suggestedFilename()).toBe("Kế hoạch ra mắt.md");
});
