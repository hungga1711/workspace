import { expect, test } from "@playwright/test";
import { setupWorkspace } from "./helpers";

/** Security: sign-in log with failures, my sessions, sign out everywhere. */
const run = Date.now().toString(36);
const EMAIL = `sec-${run}@example.com`;

test("admins see sign-ins and failures; a user signs out everywhere", async ({ browser }) => {
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 1000 } })).newPage();
  await setupWorkspace(page, { company: `Sec ${run}`, name: "An Bảo", email: EMAIL });
  // Someone mistypes the password on another device.
  const other = await (await browser.newContext()).newPage();
  await other.waitForTimeout(5500);
  await other.goto(`/login?email=${encodeURIComponent(EMAIL)}`);
  await other.getByLabel("Mật khẩu").fill("sai-mat-khau-9");
  await other.getByRole("button", { name: "Đăng nhập" }).click();
  await expect(other.getByText("Email hoặc mật khẩu chưa đúng.")).toBeVisible();

  await page.goto("/admin/workspace/security");
  const log = page.getByRole("region", { name: "Nhật ký đăng nhập" });
  await expect(log.getByRole("cell", { name: "Đăng nhập", exact: true }).first()).toBeVisible();
  await expect(log.getByText("Sai mật khẩu")).toBeVisible();
  if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/security.png` });
  // Access review: everyone is active this month; admins are listed with their rights.
  const review = page.getByRole("region", { name: "Rà soát quyền truy cập" });
  await expect(review).toContainText("Mọi người đều hoạt động trong 30 ngày qua.");
  await review.getByRole("radio", { name: /Có quyền quản trị/ }).click();
  await expect(review.getByRole("row", { name: /An Bảo/ })).toContainText("quyền quản trị");
  await expect(review.getByRole("row", { name: /An Bảo/ })).toContainText("vừa xong");

  await page.goto("/app/me?tab=security");
  await expect(page.getByText(/Đang đăng nhập ở [1-9]/)).toBeVisible();
  await expect(page.getByRole("note")).toContainText("đăng nhập sai mật khẩu");
  page.once("dialog", (d) => void d.accept());
  await page.getByRole("button", { name: "Đăng xuất mọi nơi" }).click();
  await page.waitForURL(/\/login/);
  await page.goto("/app/home");
  await page.waitForURL(/\/login/);
});
