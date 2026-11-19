import { expect, test } from "@playwright/test";
import { axe, setupWorkspace } from "./helpers";
/** Switching from Jira: a project's export becomes tasks here, reviewed before anything is created. */
test("a Jira CSV export becomes the project's tasks", async ({ page }) => {
  const run = Date.now().toString(36);
  await setupWorkspace(page, { company: `Import ${run}`, name: "Lê Hoa", email: `import-${run}@example.com` });
  const project = await (await page.request.post("/api/proxy/work/projects", { headers: { "x-wos-csrf": "1" }, data: { name: "Website mới" } })).json();
  await page.goto(`/app/work/projects/${project.id}`);
  await page.getByRole("button", { name: "Thao tác khác với dự án" }).click();
  await page.getByRole("menuitem", { name: "Nhập việc" }).click();
  const dialog = page.getByRole("dialog", { name: /^Nhập việc từ CSV/ });
  const csv = [
    "Issue key,Issue Type,Summary,Status,Priority,Assignee,Due Date",
    `WEB-1,Task,Thiết kế trang chủ,Done,High,import-${run}@example.com,15/Oct/26 10:00 AM`,
    "WEB-2,Bug,Sửa lỗi đăng nhập,In Progress,Highest,Người Lạ,",
    ",,,,,,",
  ].join("\n");
  await dialog.getByLabel("Tệp CSV").setInputFiles({ name: "jira.csv", mimeType: "text/csv", buffer: Buffer.from(csv) });
  await expect(dialog.getByText("Tệp xuất từ Jira")).toBeVisible();
  await expect(dialog.getByText("Chưa khớp 1 người với danh bạ (Người Lạ).", { exact: false })).toBeVisible();
  await expect(dialog.getByRole("cell", { name: /WEB-1\s*Thiết kế trang chủ/ })).toBeVisible();
  await axe(page, "import preview");
  await dialog.getByRole("button", { name: "Nhập 2 việc" }).click();
  await expect(dialog.getByText("Đã nhập 2 việc vào dự án.")).toBeVisible();
  await dialog.getByRole("button", { name: "Đóng" }).last().click();
  await page.goto(`/app/work/tasks?project=${project.id}`);
  await expect(page.getByText("Sửa lỗi đăng nhập").first()).toBeVisible();
});
