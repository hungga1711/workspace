import { expect, test } from "@playwright/test";
import { PASSWORD, api, setupWorkspace, signIn } from "./helpers";

/** Work › Vận hành: typed requests from templates and team leave in one queue, with amounts and batch approval. */
const run = Date.now().toString(36);

test("a request from a template and a leave request wait together; the boss approves them in one go", async ({ browser }) => {
  test.setTimeout(180_000);
  const owner = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  await setupWorkspace(owner, { company: `Ops ${run}`, name: "Hà Minh", email: `ops-${run}@example.com` });
  await api(owner, "POST", "identity/members/invite", { email: `ops-emp-${run}@example.com`, displayName: "Trịnh Nga", roleNames: ["Employee"], password: PASSWORD });
  const emp = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  await signIn(emp, `ops-emp-${run}@example.com`);

  // An employee has nothing to administer: the admin area says so instead of showing tools that refuse every change.
  await emp.goto("/admin/workspace/holidays");
  await expect(emp.getByRole("heading", { name: "Khu vực dành cho quản trị" })).toBeVisible();

  // The boss adds a company template: "Đề xuất tuyển dụng" with its own fields, approved by the boss.
  await owner.goto("/app/work/ops");
  await owner.getByRole("button", { name: "Thêm thao tác" }).click();
  await owner.getByRole("menuitem", { name: "Mẫu yêu cầu" }).click();
  const tpl = owner.getByRole("dialog", { name: "Mẫu yêu cầu" });
  await tpl.getByLabel("Tên mẫu").fill("Đề xuất tuyển dụng");
  await tpl.getByLabel("Tên ô 1").fill("Vị trí");
  await tpl.getByRole("button", { name: "Thêm ô" }).click();
  await tpl.getByLabel("Tên ô 2").fill("Lý do");
  await tpl.getByRole("button", { name: "Kiểu ô 2" }).click();
  await tpl.getByRole("option", { name: "Đoạn văn" }).click();
  await tpl.getByRole("button", { name: "Lưu mẫu" }).click();
  await expect(tpl.getByRole("listitem").filter({ hasText: "Đề xuất tuyển dụng" })).toContainText("Vị trí · Lý do");
  await tpl.getByRole("button", { name: "Đóng" }).click();

  // The employee asks for an advance from the template.
  await emp.goto("/app/work/ops");
  await emp.getByRole("button", { name: "Gửi yêu cầu" }).click();
  await emp.getByRole("button", { name: /Tạm ứng/ }).click();
  const dlg = emp.getByRole("dialog", { name: "Tạm ứng" });
  await dlg.getByLabel("Mục đích").fill("Đi gặp khách ở Đà Nẵng");
  await dlg.getByLabel("Số tiền", { exact: true }).fill("5000000");
  await dlg.getByLabel("Tìm người").fill("Hà Minh");
  await dlg
    .getByRole("option", { name: /Hà Minh/ })
    .getByRole("button")
    .click();
  await dlg.getByRole("button", { name: "Gửi yêu cầu" }).click();
  const mine = emp.getByRole("list", { name: "Yêu cầu của tôi" });
  await expect(mine).toContainText("Tạm ứng: Đi gặp khách ở Đà Nẵng");
  await expect(mine).toContainText("5.000.000 ₫");
  // And one from the company template.
  await emp.getByRole("button", { name: "Gửi yêu cầu" }).first().click();
  await emp.getByRole("button", { name: /Đề xuất tuyển dụng/ }).click();
  const d2 = emp.getByRole("dialog", { name: "Đề xuất tuyển dụng" });
  await d2.getByLabel("Vị trí").fill("Kế toán");
  await d2.getByLabel("Tìm người").fill("Hà Minh");
  await d2
    .getByRole("option", { name: /Hà Minh/ })
    .getByRole("button")
    .click();
  await d2.getByRole("button", { name: "Gửi yêu cầu" }).click();
  await expect(mine).toContainText("Đề xuất tuyển dụng: Kế toán");

  // And leave, the usual way.
  // The employee record follows the invite through the event stream: give it a moment.
  let leave = await api(emp, "POST", "employee/leave", { type: "unpaid", startDate: "2026-12-14", endDate: "2026-12-15", reason: "Việc gia đình" });
  for (let i = 0; i < 20 && leave.status === 404; i++) {
    await emp.waitForTimeout(500);
    leave = await api(emp, "POST", "employee/leave", { type: "unpaid", startDate: "2026-12-14", endDate: "2026-12-15", reason: "Việc gia đình" });
  }
  expect(leave.status, JSON.stringify(leave.body)).toBeLessThan(300);

  // The boss: both in one queue, with the amount, the inbox tab counts them; approve both at once.
  await owner.goto("/app/work/ops");
  await expect(owner.getByRole("heading", { level: 1 })).toHaveText("Yêu cầu");
  await expect(owner.getByRole("link", { name: /^Chờ tôi xử lý/ })).toHaveText(/3$/);
  const inbox = owner.getByRole("list", { name: "Chờ tôi xử lý" });
  await expect(inbox.getByRole("listitem")).toHaveCount(3);
  await expect(inbox).toContainText("5.000.000 ₫");
  await expect(inbox).toContainText("Nghỉ không lương · 2 ngày");
  await owner.getByRole("button", { name: "Loại yêu cầu" }).click();
  await owner.getByRole("option", { name: /Nghỉ phép/ }).click();
  await expect(inbox.getByRole("listitem")).toHaveCount(1);
  await owner.getByRole("button", { name: "Loại yêu cầu" }).click();
  await owner.getByRole("option", { name: /^Tất cả/ }).click();
  for (const box of await inbox.getByRole("checkbox").all()) await box.check();
  await owner.getByRole("button", { name: "Duyệt các mục đã chọn" }).click();
  await expect(owner.getByText("Không có yêu cầu nào chờ bạn.")).toBeVisible();
  await owner.getByRole("link", { name: /^Đã xử lý/ }).click();
  await expect(owner.getByRole("list", { name: "Đã xử lý" }).getByRole("listitem")).toHaveCount(3);
  // For accounting: the handled requests as an Excel file, with the amounts.
  await owner.getByRole("button", { name: "Thêm thao tác" }).click();
  const [file] = await Promise.all([owner.waitForEvent("download"), owner.getByRole("menuitem", { name: "Xuất CSV" }).click()]);
  const csv = Buffer.concat(await (await file.createReadStream()).toArray()).toString("utf8");
  expect(csv).toContain("Tạm ứng: Đi gặp khách ở Đà Nẵng");
  expect(csv).toContain("5000000");
});
