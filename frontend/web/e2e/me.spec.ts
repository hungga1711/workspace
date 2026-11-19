import { expect, test, type Page } from "@playwright/test";
import { PASSWORD, api, setupWorkspace, signIn } from "./helpers";

/** Hồ sơ của tôi and Chấm công with real data: the employee's side, and the manager's view of their team. */
const run = Date.now().toString(36);
const OWNER = { company: `Me ${run}`, email: `me-owner-${run}@example.com`, name: "Vũ Hà" };
const EMP = { email: `me-emp-${run}@example.com`, name: "Lý Nam" };
const SHOTS = process.env.SHOTS;

test.describe.serial("Me tabs", () => {
  let owner: Page;
  let emp: Page;
  let ownerId: string;
  let empId: string;

  test("setup: a manager and a report", async ({ browser }) => {
    owner = await (await browser.newContext({ viewport: { width: 1440, height: 1000 } })).newPage();
    await setupWorkspace(owner, OWNER);
    empId = (await api(owner, "POST", "identity/members/invite", { email: EMP.email, displayName: EMP.name, roleNames: ["Employee"], password: PASSWORD })).body.userId;
    ownerId = (await api(owner, "GET", "identity/members")).body.members.find((m: { email: string }) => m.email === OWNER.email).userId;
    const dep = (await api(owner, "POST", "employee/departments", { name: "Kinh doanh" })).body;
    await expect
      .poll(
        async () =>
          (await api(owner, "PUT", `employee/employees/${empId}`, { displayName: EMP.name, title: "Nhân viên kinh doanh", departmentId: dep.id, managerId: ownerId })).status,
      )
      .toBeLessThan(300);
    await api(owner, "PUT", `employee/employees/${ownerId}`, { displayName: OWNER.name, title: "Trưởng phòng", departmentId: dep.id });
    await api(owner, "PUT", `employee/leave/balances/${empId}`, { type: "annual", year: new Date().getFullYear(), entitledDays: 12 });
    emp = await (await browser.newContext({ viewport: { width: 1440, height: 1000 } })).newPage();
    await signIn(emp, EMP.email);
  });

  test("employee: profile, manager, attendance history", async () => {
    await emp.goto("/app/me");
    // Hồ sơ của tôi: account settings with a section menu; the person's facts and manager in "Công việc".
    const sections = emp.getByRole("navigation", { name: "Mục cài đặt" });
    await expect(sections.getByRole("link", { name: "Hồ sơ" })).toHaveAttribute("aria-current", "page");
    await expect(emp.getByText(EMP.email)).toBeVisible();
    await expect(emp.getByRole("main")).toContainText(OWNER.name);
    // Chấm công is its own page.
    await emp.goto("/app/time");
    await emp.getByRole("button", { name: "Chấm công vào" }).first().click();
    await expect(emp.getByRole("status")).toContainText("Đã chấm công vào");
    // A year as a grid of days; today's check-in is on the selected (today's) cell.
    const grid = emp.getByRole("group", { name: /Lịch chấm công theo ngày/ });
    await expect(grid.locator('button[aria-pressed="true"]')).toHaveAttribute("aria-label", /chưa chấm ra|giờ/);
    if (SHOTS) await emp.screenshot({ path: `${SHOTS}/me-attendance.png` });
  });

  test("employee requests leave; manager approves from Team; it shows in who's off", async () => {
    const d = new Date(Date.now() + 7 * 86400_000);
    while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; // local date: toISOString is UTC and slips to Sunday after midnight in Asia
    await emp.goto("/app/time?tab=leave");
    await emp.getByRole("button", { name: "Xin nghỉ", exact: true }).click();
    const dlg = emp.getByRole("dialog");
    // Date fields are the kit DateField: open the month grid and step to the day.
    for (const label of ["Từ ngày", "Đến ngày"]) {
      await dlg.getByRole("button", { name: new RegExp(`^${label}`) }).click();
      const cell = dlg.locator(`[data-day="${day}"]`);
      for (let i = 0; i < 3 && !(await cell.isVisible()); i++) await dlg.getByRole("button", { name: "Tháng sau" }).click();
      await cell.click();
    }
    await dlg.getByRole("button", { name: "Gửi đơn" }).click();
    await expect(emp.getByRole("status")).toContainText("Đã gửi đơn");
    // Leave requests waiting for the manager sit on Chấm công (the old /app/me?tab=team lands there).
    await owner.goto("/app/me?tab=team");
    await owner.waitForURL(/\/app\/time/);
    await expect(owner.getByRole("region", { name: /Đơn nghỉ chờ bạn duyệt/ })).toContainText(EMP.name);
    if (SHOTS) await owner.screenshot({ path: `${SHOTS}/me-team.png` });
    await owner.getByRole("button", { name: "Duyệt" }).click();
    await expect(owner.getByRole("status")).toContainText("Đã duyệt");
    // Approved leave counts as "out" for the people who may know (the manager here); the employee sees it approved.
    const out = await api(owner, "GET", `employee/leave/out?from=${day}&to=${day}`);
    expect(out.body.out.some((x: { userId: string }) => x.userId === empId)).toBe(true);
    await emp.goto("/app/time?tab=leave");
    await expect(emp.getByRole("region", { name: "Đơn của bạn" })).toContainText("Đã duyệt");
  });

  test("notification settings save per person", async () => {
    // Hồ sơ của tôi › Thông báo.
    await emp.goto("/app/me?tab=notify");
    const box = emp.getByRole("main");
    await box.getByLabel("Việc được giao, bình luận, sắp đến hạn và hoàn thành").uncheck();
    await expect(box.getByRole("status")).toContainText("Đã lưu");
    // Until the person picks one, their zone follows the workspace's.
    const zone = box.getByRole("button", { name: "Múi giờ", exact: true });
    // Chromium may report the zone by its older alias.
    await expect(zone).toContainText(/Theo công ty \(Asia\/(Ho_Chi_Minh|Saigon)\)/);
    await zone.click();
    await box.getByRole("option", { name: "Asia/Bangkok" }).click();
    await expect(box.getByRole("status")).toContainText("Đã lưu");
    const prefs = await (await emp.request.fetch("/api/proxy/home/prefs", { headers: { "x-wos-csrf": "1" } })).json();
    expect(prefs).toMatchObject({ muted: ["task"], timezone: "Asia/Bangkok" });
    await box.getByLabel("Giờ yên lặng", { exact: true }).check();
    await expect(box.getByRole("button", { name: "Giờ yên lặng bắt đầu" })).toContainText("22:00");
    await box.getByRole("button", { name: "Giờ yên lặng kết thúc" }).click();
    await box.getByRole("option", { name: "06:00" }).click();
    await expect(box.getByRole("status")).toContainText("Đã lưu");
    await expect(box.getByText("Trong giờ yên lặng (Asia/Bangkok)")).toBeVisible();
    const quiet = await (await emp.request.fetch("/api/proxy/home/prefs", { headers: { "x-wos-csrf": "1" } })).json();
    expect(quiet).toMatchObject({ quietStart: 22, quietEnd: 6 });
    if (SHOTS) await emp.screenshot({ path: `${SHOTS}/me-profile.png`, fullPage: true });
  });

  test("Tên gọi and full name: the greeting and the name everyone sees follow", async () => {
    // Edited in place on Hồ sơ and saved together.
    await emp.goto("/app/me");
    const main = emp.getByRole("main");
    await main.getByLabel("Tên gọi").fill("Bé Na");
    await main.getByLabel("Họ và tên").fill(`${EMP.name} Na`);
    await main.getByRole("button", { name: "Lưu thay đổi" }).click();
    await expect(emp.getByRole("status").filter({ hasText: "Đã lưu hồ sơ" })).toBeVisible();
    // The employee profile's copy follows through identity.member.renamed (in-process, a moment later).
    await expect.poll(async () => (await emp.reload(), await emp.getByRole("main").getByLabel("Họ và tên").inputValue()), { timeout: 15_000 }).toBe(`${EMP.name} Na`);
    await emp.goto("/app/home");
    await expect(emp.getByRole("heading", { level: 1 })).toContainText("Bé Na");
    // Later tests look the person up by name.
    expect((await api(emp, "PUT", "identity/me/display-name", { displayName: EMP.name })).status).toBe(200);
  });

  test("profile photo: crop in the browser, shown everywhere, removable", async () => {
    await emp.goto("/app/me");
    const card = emp.getByRole("main");
    await card.getByRole("button", { name: "Thêm ảnh" }).last().click();
    const dlg = emp.getByRole("dialog", { name: "Ảnh đại diện" });
    // A real 1×1 PNG: the browser decodes it, the cropper re-encodes it at 256 px.
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
    await dlg.locator('input[type="file"]').setInputFiles({ name: "me.png", mimeType: "image/png", buffer: png });
    await dlg.getByRole("button", { name: "Lưu" }).click();
    await expect(emp.getByRole("status").filter({ hasText: "Đã cập nhật ảnh đại diện" })).toBeVisible();
    await expect(card.locator("img")).toHaveCount(1);
    await card.getByRole("button", { name: "Đổi ảnh" }).last().click();
    await emp.getByRole("dialog", { name: "Ảnh đại diện" }).getByRole("button", { name: "Gỡ ảnh" }).click();
    await expect(emp.getByRole("status").filter({ hasText: "Đã gỡ ảnh đại diện" })).toBeVisible();
    await expect(card.locator("img")).toHaveCount(0);
  });

  test("out-of-office: approvals go to the chosen colleague until the end date", async () => {
    await emp.goto("/app/me?tab=away");
    const away = emp.getByRole("main");
    await away.getByRole("button", { name: "Người duyệt thay", exact: true }).click();
    const first = away.getByRole("option").first();
    const delegateName = (await first.locator("span.flex-1").textContent())?.trim();
    await first.click();
    await away.getByRole("button", { name: "Uỷ quyền", exact: true }).click();
    await expect(away.getByRole("status")).toContainText(`Đã uỷ quyền cho ${delegateName}`);
    await expect(away).toContainText("đang chuyển cho");
    if (SHOTS) await emp.screenshot({ path: `${SHOTS}/me-delegation.png` });
    await away.getByRole("button", { name: "Tắt uỷ quyền" }).click();
    await expect(away.getByRole("status")).toContainText("Đã tắt uỷ quyền");
  });
});
