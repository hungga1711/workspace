import { expect, test } from "@playwright/test";
import { PASSWORD, setupWorkspace, signIn } from "./helpers";

/** Offboarding: an admin disables a leaver; they lose access at once; re-enabling restores it. */
const run = Date.now().toString(36);
const OWNER = `off-${run}@example.com`;
const LEAVER = `off-leaver-${run}@example.com`;

test("disable a member: access ends immediately, they leave the active count, and they can be brought back", async ({ browser }) => {
  const owner = await (await browser.newContext({ viewport: { width: 1440, height: 1000 } })).newPage();
  await setupWorkspace(owner, { company: `Off ${run}`, name: "Chủ Công Ty", email: OWNER });
  const invite = await owner.request.post("/api/proxy/identity/members/invite", {
    headers: { "x-wos-csrf": "1" },
    data: { email: LEAVER, displayName: "Trần Văn Nghỉ", password: PASSWORD },
  });
  expect(invite.ok()).toBe(true);
  const leaverId = (await invite.json()).userId as string;
  const task = await (await owner.request.post("/api/proxy/work/tasks", { headers: { "x-wos-csrf": "1" }, data: { title: "Báo cáo quý dở dang", assigneeId: leaverId } })).json();
  // The leaver also manages someone.
  const reportId = (
    await (
      await owner.request.post("/api/proxy/identity/members/invite", {
        headers: { "x-wos-csrf": "1" },
        data: { email: `off-report-${run}@example.com`, displayName: "Lê Báo Cáo", password: PASSWORD },
      })
    ).json()
  ).userId as string;
  await expect
    .poll(
      async () =>
        (
          await owner.request.put(`/api/proxy/employee/employees/${reportId}`, { headers: { "x-wos-csrf": "1" }, data: { displayName: "Lê Báo Cáo", managerId: leaverId } })
        ).status(),
      { timeout: 30_000 },
    )
    .toBe(200);

  const leaver = await (await browser.newContext()).newPage();
  await leaver.goto(`/login?email=${encodeURIComponent(LEAVER)}`);
  await leaver.getByLabel("Mật khẩu").fill(PASSWORD);
  await leaver.getByRole("button", { name: "Đăng nhập" }).click();
  await leaver.waitForURL(/\/app\//);

  await owner.goto("/admin/workspace/members");
  // Self-hosted: no seat limit, only how many people are active.
  // The owner and the leaver (signed in); the report never signed in, so is still only invited.
  await expect(owner.getByText(/^2 thành viên đang hoạt động$/)).toBeVisible();
  await owner.getByRole("button", { name: "Thao tác cho Trần Văn Nghỉ" }).click();
  await owner.getByRole("menuitem", { name: "Vô hiệu hoá (nghỉ việc)" }).click();
  const dlg = owner.getByRole("dialog", { name: "Vô hiệu hoá Trần Văn Nghỉ?" });
  await expect(dlg).toContainText("1 việc đang mở");
  await expect(dlg).toContainText("1 nhân viên báo cáo trực tiếp");
  await dlg.getByRole("button", { name: "Bàn giao cho" }).click();
  await dlg.getByRole("option", { name: /Chủ Công Ty/ }).click();
  if (process.env.SHOTS) await owner.screenshot({ path: `${process.env.SHOTS}/members-disable-dialog.png` });
  await dlg.getByRole("button", { name: "Vô hiệu hoá" }).click();
  await expect(owner.getByRole("status")).toContainText("Đã vô hiệu hoá Trần Văn Nghỉ, đã bàn giao cho Chủ Công Ty");
  const handed = await (await owner.request.fetch(`/api/proxy/work/tasks/${task.id}`, { headers: { "x-wos-csrf": "1" } })).json();
  expect(handed.task.assigneeId).not.toBe(leaverId);
  const report = await (await owner.request.fetch(`/api/proxy/employee/employees/${reportId}`, { headers: { "x-wos-csrf": "1" } })).json();
  expect(report.managerId).toBe(handed.task.assigneeId); // reports to the successor
  const row = owner.getByRole("row", { name: /Trần Văn Nghỉ/ });
  await expect(row.getByText("Đã vô hiệu hoá")).toBeVisible();
  await expect(owner.getByText(/^1 thành viên đang hoạt động$/)).toBeVisible();
  if (process.env.SHOTS) await owner.screenshot({ path: `${process.env.SHOTS}/members-disabled.png` });

  // The leaver's open tab is signed out (or told they have no access) on the next page load.
  await leaver.goto("/app/home");
  await expect(leaver.getByRole("heading", { name: "Bạn không còn quyền vào workspace này" }).or(leaver.getByRole("button", { name: "Đăng nhập" }))).toBeVisible();
  // Disabled people are not offered when assigning work.
  const listed = async () =>
    ((await (await owner.request.fetch("/api/proxy/employee/employees", { headers: { "x-wos-csrf": "1" } })).json()).employees as { userId: string }[]).some(
      (e) => e.userId === leaverId,
    );
  await expect.poll(listed, { timeout: 30_000 }).toBe(false);

  await owner.getByRole("button", { name: "Thao tác cho Trần Văn Nghỉ" }).click();
  await owner.getByRole("menuitem", { name: "Kích hoạt lại" }).click();
  await expect(owner.getByRole("status")).toContainText("Đã kích hoạt lại Trần Văn Nghỉ");
  await expect(row.getByText("Đang hoạt động")).toBeVisible();
  await expect.poll(listed, { timeout: 30_000 }).toBe(true); // back in the directory

  const back = await (await browser.newContext()).newPage();
  await signIn(back, LEAVER);
  await expect(back.getByRole("heading", { level: 1 })).toBeVisible();

  // Both changes are in the audit log, filterable and exportable.
  await owner.goto("/admin/workspace/audit");
  // The log is a timeline now (a line per action); "Hành động" narrows it to one kind of action.
  await owner.getByRole("button", { name: "Hành động" }).click();
  await owner.getByRole("option", { name: "Thành viên", exact: true }).click();
  await owner.waitForURL(/member/);
  const log = owner.getByRole("listitem");
  await expect(log.filter({ hasText: "vô hiệu hoá thành viên" }).first()).toBeVisible();
  await expect(log.filter({ hasText: "kích hoạt lại thành viên" }).first()).toBeVisible();
  await expect(log.filter({ hasText: "đổi cấu hình công ty" })).toHaveCount(0);
  if (process.env.SHOTS) await owner.screenshot({ path: `${process.env.SHOTS}/audit.png` });
  const [download] = await Promise.all([owner.waitForEvent("download"), owner.getByRole("link", { name: "Xuất CSV" }).click()]);
  expect(download.suggestedFilename()).toMatch(/^nhat-ky-hoat-dong-\d{4}-\d{2}-\d{2}\.csv$/);
  const csv = await (await download.createReadStream()).toArray().then((chunks) => Buffer.concat(chunks).toString("utf8"));
  expect(csv.startsWith('\uFEFF"Thời gian (UTC)"')).toBe(true);
  expect(csv).toContain("member.disabled");
  expect(csv).toContain(LEAVER);
  expect(csv).not.toContain("workspace.config_update");
});
