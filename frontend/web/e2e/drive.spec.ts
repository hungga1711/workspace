import { expect, test } from "@playwright/test";
import { setupWorkspace } from "./helpers";

/** Files: folders, upload, star, share, trash and restore; the sidebar shows what is used. */
test("folders and files: upload into a folder, star, share with everyone, trash and restore", async ({ page }) => {
  test.setTimeout(180_000);
  const run = Date.now().toString(36);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await setupWorkspace(page, { company: `Drive ${run}`, name: "Lê Minh", email: `drive-${run}@example.com` });

  await page.goto("/app/work/docs?view=files");
  // Self-hosted: no storage quota, only what is used.
  await expect(page.getByText(/^Đã dùng \d/)).toBeVisible();
  await page.getByRole("button", { name: "Mới", exact: true }).click();
  await page.getByRole("menuitem", { name: "Thư mục mới" }).click();
  await page.getByRole("dialog", { name: "Thư mục mới" }).getByLabel("Tên").fill("Hợp đồng");
  await page.getByRole("dialog", { name: "Thư mục mới" }).getByRole("button", { name: "Lưu" }).click();
  await page.getByRole("button", { name: "Hợp đồng", exact: true }).click();
  await expect(page.getByRole("navigation", { name: "Đường dẫn" })).toContainText("Hợp đồng");
  await page.getByLabel("Tải tệp lên").setInputFiles({ name: "bao-gia.txt", mimeType: "text/plain", buffer: Buffer.from("Báo giá tháng 11") });
  const row = page.getByRole("row").filter({ hasText: "bao-gia.txt" });
  await expect(row).toBeVisible();

  await row.getByRole("button", { name: "Thao tác với bao-gia.txt" }).click();
  await page.getByRole("menuitem", { name: "Gắn sao" }).click();
  await expect(row.getByLabel("Đã gắn sao")).toBeVisible();
  await row.getByRole("button", { name: "Thao tác với bao-gia.txt" }).click();
  await page.getByRole("menuitem", { name: "Chia sẻ" }).click();
  await page.getByLabel("Mọi người trong công ty xem được").check();
  await page.getByRole("dialog").getByRole("button", { name: "Lưu" }).click();
  await expect(row.getByLabel("Đã chia sẻ")).toBeVisible();

  await row.getByRole("button", { name: "Thao tác với bao-gia.txt" }).click();
  await page.getByRole("menuitem", { name: "Chuyển vào thùng rác" }).click();
  await expect(row).toHaveCount(0);
  await page.getByRole("link", { name: "Thùng rác" }).click();
  const trashed = page.getByRole("row").filter({ hasText: "bao-gia.txt" });
  await trashed.getByRole("button", { name: "Thao tác với bao-gia.txt" }).click();
  await page.getByRole("menuitem", { name: "Khôi phục" }).click();
  await expect(trashed).toHaveCount(0);
  await page.getByRole("link", { name: "Đã gắn sao" }).click();
  await expect(page.getByRole("row").filter({ hasText: "bao-gia.txt" })).toBeVisible();
});
