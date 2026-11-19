import { expect, test } from "@playwright/test";
import { setupWorkspace } from "./helpers";

/** Bulk invite: paste a list, get a result per person, the table shows the new invitees. */
const run = Date.now().toString(36);

test("an admin invites several people at once and sees what happened to each", async ({ browser }) => {
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 1000 } })).newPage();
  await setupWorkspace(page, { company: `Bulk ${run}`, name: "Chủ Công Ty", email: `bulk-${run}@example.com` });

  // The overview shows real usage for the last 7 days (the welcome thread already has messages).
  await page.goto("/admin/workspace");
  const usage = page.getByRole("region", { name: "Mức độ sử dụng 7 ngày qua" });
  // A trend line needs 3 active days, so a one-day-old workspace shows the figures without one.
  await expect(usage).toContainText(/Thành viên[^0-9]*1/);
  await expect(usage).toContainText("Tin nhắn");
  await expect(usage.getByRole("img", { name: /^Tin nhắn/ })).toHaveCount(0);
  if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/admin-overview.png` });

  await page.goto("/admin/workspace/members");
  await page.getByRole("button", { name: "Mời nhiều người" }).click();
  const dlg = page.getByRole("dialog", { name: "Mời nhiều người" });
  await dlg
    .getByLabel("Danh sách người cần mời")
    .fill(
      [
        "Email, Họ tên, Vai trò",
        `bulk-a-${run}@example.com, Nguyễn Thị An`,
        `bulk-b-${run}@example.com; Trần Bảo; Manager`,
        "khong-phai-email, Sai Địa Chỉ",
        `bulk-c-${run}@example.com, Lê Chi, Giám đốc vũ trụ`,
      ].join("\n"),
    );
  // The list is checked as it is typed: who is ready, and what is wrong with each of the other lines.
  await expect(dlg.getByText("2 người sẵn sàng · 2 dòng cần sửa")).toBeVisible();
  await expect(dlg.getByRole("row", { name: /khong-phai-email/ })).toContainText("Email không hợp lệ");
  await expect(dlg.getByRole("row", { name: new RegExp(`bulk-c-${run}`) })).toContainText("Vai trò không tồn tại");
  await expect(dlg.getByRole("row", { name: new RegExp(`bulk-a-${run}`) })).toContainText("Sẵn sàng");
  if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/members-bulk.png` });
  // Only the people who are ready are invited.
  await dlg.getByRole("button", { name: "Mời 2 người" }).click();
  await expect(dlg.getByRole("status")).toContainText("Đã mời 2");
  if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/members-bulk-result.png` });
  await dlg.getByRole("button", { name: "Xong" }).click();
  await expect(page.getByRole("row", { name: /Nguyễn Thị An/ }).getByText("Đã mời")).toBeVisible();
  await expect(page.getByRole("row", { name: /Trần Bảo/ }).getByText("Quản lý")).toBeVisible();
  // Invited people are not counted as active until they sign in: only the owner is.
  await expect(page.getByText(/^1 thành viên đang hoạt động$/)).toBeVisible();
});

test("HR sees the monthly attendance sheet and exports it for payroll", async ({ browser }) => {
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 1000 } })).newPage();
  const r2 = Date.now().toString(36);
  await setupWorkspace(page, { company: `Cong ${r2}`, name: "Trưởng Nhân Sự", email: `cong-${r2}@example.com` });
  // The employee profile is created from the identity event (asynchronously); check in once it exists.
  await expect
    .poll(async () => (await (await page.request.fetch("/api/proxy/employee/me", { headers: { "x-wos-csrf": "1" } })).json()).profile !== null, { timeout: 30_000 })
    .toBe(true);
  expect((await page.request.post("/api/proxy/employee/attendance/check-in", { headers: { "x-wos-csrf": "1" }, data: {} })).ok()).toBe(true);
  await page.goto("/admin/workspace");
  // Admin nav: "Chấm công & nghỉ" opens the timesheet; leave and holidays are its tabs.
  await page.getByRole("navigation", { name: "Mục quản trị" }).getByRole("link", { name: "Chấm công & nghỉ" }).click();
  await expect(page.getByRole("heading", { name: "Bảng chấm công" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Phép năm" })).toBeVisible();
  const row = page.getByRole("row", { name: /Trưởng Nhân Sự/ });
  await expect(row.getByRole("cell").nth(2)).toHaveText("1");
  if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/admin-attendance.png` });
  // HR fixes a day: add yesterday's missing record with a reason.
  await row.getByRole("link", { name: "Trưởng Nhân Sự" }).click();
  await page.getByRole("button", { name: "Thêm ngày công" }).click();
  const dlg = page.getByRole("dialog", { name: "Sửa chấm công" });
  const first = `${new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 7)}-01`;
  await dlg.getByLabel("Ngày").fill(first);
  await dlg.getByLabel("Lý do").fill("Đi gặp khách cả ngày, quản lý xác nhận");
  await dlg.getByRole("button", { name: "Lưu" }).click();
  await expect(page.getByRole("cell", { name: /Nhân sự đã sửa: Đi gặp khách cả ngày/ })).toBeVisible();
  await page.getByRole("link", { name: "Bảng chấm công" }).first().click();
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("link", { name: "Xuất CSV" }).click()]);
  expect(download.suggestedFilename()).toMatch(/^cham-cong-\d{4}-\d{2}\.csv$/);
  const csv = Buffer.concat(await (await download.createReadStream()).toArray()).toString("utf8");
  expect(csv).toContain('"Mã NV","Họ tên","Phòng ban","Ngày công"');
  expect(csv).toContain('"Trưởng Nhân Sự"');
});
