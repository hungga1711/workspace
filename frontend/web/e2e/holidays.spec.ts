import { expect, test } from "@playwright/test";
import { setupWorkspace } from "./helpers";

/** Company holidays (Vietnam): HR adds them; they are not counted as leave or working days; employees see them. */
const run = Date.now().toString(36);

test("HR adds holidays; the attendance sheet and Me › Nghỉ phép take them into account", async ({ browser }) => {
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 1000 } })).newPage();
  await setupWorkspace(page, { company: `Le ${run}`, name: "Nhân Sự Trưởng", email: `le-${run}@example.com` });
  const year = new Date(Date.now() + 7 * 3600_000).getUTCFullYear() + 1; // next year: every fixed holiday is still ahead
  await page.goto(`/admin/workspace/holidays?year=${year}`);
  await expect(page.getByRole("heading", { name: "Ngày nghỉ lễ" })).toBeVisible();
  // A workspace set up in Vietnam starts with the country's public holidays (setup takes the country from the time
  // zone), so nothing is missing; the page says so instead of offering to add them.
  await expect(page.getByText("Đã có đủ ngày lễ cố định của Việt Nam.")).toBeVisible();
  await expect(page.getByRole("cell", { name: /^Quốc khánh/ }).first()).toBeVisible();
  await page.getByLabel("Ngày", { exact: true }).fill(`${year}-09-01`);
  await page.getByLabel("Tên ngày nghỉ").fill("Nghỉ lễ Quốc khánh (ngày liền kề)");
  await page.getByRole("button", { name: "Thêm", exact: true }).click();
  await expect(page.getByRole("cell", { name: /^Nghỉ lễ Quốc khánh \(ngày liền kề\)/ })).toBeVisible();
  if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/admin-holidays.png` });
  await page.getByRole("button", { name: "Xoá Nghỉ lễ Quốc khánh (ngày liền kề)" }).click();
  await expect(page.getByRole("cell", { name: /^Nghỉ lễ Quốc khánh \(ngày liền kề\)/ })).toHaveCount(0);

  // September of next year: the attendance sheet leaves out Quốc khánh (2/9 and the day off that goes with it), and
  // the day added and removed above is not among them.
  const rep = await (await page.request.fetch(`/api/proxy/employee/attendance/report?month=${year}-09`, { headers: { "x-wos-csrf": "1" } })).json();
  expect(rep.holidays).toContain(`${year}-09-02`);
  expect(rep.holidays.every((d: string) => d.startsWith(`${year}-09-`))).toBe(true);
  expect(rep.holidays.length).toBeLessThanOrEqual(2);
});

test("HR grants this year's leave to everyone at once and adjusts one person", async ({ browser }) => {
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 1000 } })).newPage();
  const r2 = `${run}b`;
  await setupWorkspace(page, { company: `Phep ${r2}`, name: "Chị Nhân Sự", email: `phep-${r2}@example.com` });
  await expect
    .poll(async () => (await (await page.request.fetch("/api/proxy/employee/me", { headers: { "x-wos-csrf": "1" } })).json()).profile !== null, { timeout: 30_000 })
    .toBe(true);
  await page.goto("/admin/workspace/leave");
  const row = page.getByRole("row", { name: /Chị Nhân Sự/ });
  await expect(row).toContainText("chưa cấp");
  await page.getByRole("button", { name: "Cấp phép" }).click();
  await expect(page.getByRole("status")).toContainText("cho 1 người");
  await expect(row.getByRole("cell").nth(2)).toHaveText("12");
  await row.getByRole("button", { name: "Sửa phép của Chị Nhân Sự" }).click();
  await row.getByLabel("Số ngày cấp cho Chị Nhân Sự").fill("14");
  await row.getByRole("button", { name: "Lưu" }).click();
  await expect(row.getByRole("cell").nth(2)).toHaveText("14");
  if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/admin-leave.png` });
  await page.goto("/app/time?tab=leave");
  await expect(page.getByText(/14 ngày còn lại/)).toBeVisible();
});
