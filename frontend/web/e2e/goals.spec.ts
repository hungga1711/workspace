import { expect, test } from "@playwright/test";
import { setupWorkspace } from "./helpers";

/** Mục tiêu (OKR): a department goal with a number and a project key result; check-in; progress vs time. */
test("goals: create with key results, update a number, see progress against time", async ({ page }) => {
  test.setTimeout(150_000);
  const run = Date.now().toString(36);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await setupWorkspace(page, { company: `Goals ${run}`, name: "Trần Minh Hưng", email: `goals-${run}@example.com` });
  const h = { headers: { "x-wos-csrf": "1" } };
  const project = await (await page.request.post("/api/proxy/work/projects", { ...h, data: { name: "Cổng khách hàng 2.0" } })).json();
  for (const title of ["Đăng nhập SSO", "Hoá đơn", "Hồ sơ", "Thông báo"]) await page.request.post("/api/proxy/work/tasks", { ...h, data: { title, projectId: project.id } });

  await page.goto("/app/work/goals");
  await expect(page.getByText("Chưa có mục tiêu cho kỳ này")).toBeVisible();
  await page.getByRole("button", { name: "Mục tiêu mới" }).first().click();
  const dlg = page.getByRole("dialog", { name: "Mục tiêu mới" });
  await dlg.getByLabel("Mục tiêu", { exact: true }).fill("Tăng doanh thu mảng doanh nghiệp");
  // A fresh workspace has no departments yet: "Phòng ban khác…" opens a name field.
  await dlg.getByRole("button", { name: "Phòng ban" }).click();
  await dlg.getByRole("option", { name: "Phòng ban khác…" }).click();
  await dlg.getByLabel("Tên phòng ban").fill("Kinh doanh");
  await dlg.getByLabel("Kết quả 1", { exact: true }).fill("Doanh thu mới");
  await dlg.getByLabel("Cần đạt").fill("2000");
  await dlg.getByLabel("Đơn vị").fill("triệu");
  await dlg.getByRole("button", { name: "Thêm kết quả" }).click();
  await dlg.getByLabel("Kết quả 2", { exact: true }).fill("Ra mắt cổng khách hàng");
  await dlg
    .getByRole("radiogroup", { name: "Loại kết quả 2" })
    .getByRole("radio", { name: /^Dự án/ })
    .click();
  await dlg.getByRole("button", { name: "Dự án" }).click();
  await dlg.getByRole("option", { name: "Cổng khách hàng 2.0" }).click();
  await dlg.getByRole("button", { name: "Lưu" }).click();
  await expect(dlg).toHaveCount(0);

  const goal = page.getByRole("listitem", { name: "Tăng doanh thu mảng doanh nghiệp" });
  await expect(page.getByRole("heading", { name: /^Kinh doanh/ })).toBeVisible();
  // The tree shows one row per goal; its key results open on tap.
  await goal.getByRole("button", { name: "Tăng doanh thu mảng doanh nghiệp" }).click();
  await expect(goal.getByText("0/4", { exact: true })).toBeVisible(); // project key result: tasks done of total
  await goal.getByRole("button", { name: "Cập nhật Doanh thu mới" }).click();
  await goal.getByLabel("Giá trị mới cho Doanh thu mới").fill("1000");
  await goal.getByRole("button", { name: "Lưu" }).click();
  await expect(goal.getByText("1.000 triệu", { exact: true })).toBeVisible();
  await expect(goal.getByText("≥2.000 triệu", { exact: true })).toBeVisible();
  await expect(goal.getByText("25%").first()).toBeVisible(); // (50 + 0) / 2
  // The bar carries a tick at where the goal should be by now.
  await expect(goal.getByRole("meter", { name: /theo thời gian nên đạt \d+%/ })).toBeVisible();

  // The AI answers about goals from the same numbers.
  const ask = await (await page.request.post("/api/proxy/ai/ask", { ...h, data: { question: "Mục tiêu quý này đang thế nào?" } })).json();
  expect(ask.toolCalls).toContain("goals_status");
  expect(ask.answer).toContain("Tăng doanh thu mảng doanh nghiệp");
});
