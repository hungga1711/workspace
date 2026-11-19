import { expect, test } from "@playwright/test";
import { setupWorkspace } from "./helpers";

/** Documentation: spaces, a page tree, a rich editor with "/" commands, comments, labels, stars. */
test("create a space, write a page with the rich editor, comment, label and star it", async ({ page }) => {
  test.setTimeout(180_000);
  const run = Date.now().toString(36);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await setupWorkspace(page, { company: `Docs ${run}`, name: "Lê Minh", email: `docs-${run}@example.com` });

  await page.goto("/app/work/docs");
  await page.getByRole("button", { name: "Tạo không gian" }).first().click();
  const dlg = page.getByRole("dialog", { name: "Tạo không gian" });
  await dlg.getByLabel("Tên không gian").fill("Kỹ thuật");
  await expect(dlg.getByLabel("Mã")).toHaveValue("KYTHUAT");
  await dlg.getByRole("button", { name: "Tạo không gian" }).click();
  await page.waitForURL(/\/app\/work\/docs\//);
  await expect(page.getByRole("heading", { level: 1, name: "Kỹ thuật" })).toBeVisible();
  const tree = page.getByRole("navigation", { name: "Các trang trong Kỹ thuật" });
  await expect(tree).toBeVisible();

  // A new page from the tree opens in the editor.
  await tree.getByRole("button", { name: "Thêm trang" }).click();
  await page.waitForURL(/edit=1/);
  await page.getByLabel("Tiêu đề", { exact: true }).fill("Kiến trúc hệ thống");
  const editor = page.locator(".ProseMirror");
  await editor.click();
  await page.keyboard.type("Tổng quan các dịch vụ ");
  await page.keyboard.press("Enter");
  await page.keyboard.type("/bang");
  await expect(page.getByRole("listbox", { name: "Chèn khối" })).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(editor.locator("table")).toBeVisible();
  await page.getByRole("button", { name: "Xuất bản" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Đã xuất bản phiên bản 2" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 1, name: "Kiến trúc hệ thống" })).toBeVisible();
  await expect(page.getByRole("article", { name: "Kiến trúc hệ thống" }).locator("table")).toBeVisible();
  await expect(tree.getByRole("link", { name: "Kiến trúc hệ thống" })).toBeVisible();

  await page.getByRole("button", { name: "Nhãn", exact: true }).click();
  await page.getByLabel("+ Nhãn").fill("backend");
  await page.getByLabel("+ Nhãn").press("Enter");
  await expect(page.getByRole("link", { name: "backend" })).toBeVisible();
  await page.getByRole("button", { name: "Gắn sao" }).click();
  await expect(page.getByRole("button", { name: "Bỏ gắn sao" })).toHaveAttribute("aria-pressed", "true");
  // Whoever writes a page watches it; the button stops the notices.
  await expect(page.getByRole("button", { name: "Đang theo dõi" })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Đang theo dõi" }).click();
  await expect(page.getByRole("button", { name: "Theo dõi", exact: true })).toHaveAttribute("aria-pressed", "false");
  await page.getByLabel("Thêm bình luận").fill("Thiếu sơ đồ luồng dữ liệu");
  await page.getByRole("button", { name: "Gửi" }).click();
  await expect(page.getByRole("heading", { name: "Bình luận (1)" })).toBeVisible();
  await page.getByRole("button", { name: "Đánh dấu đã xử lý" }).click();
  await expect(page.getByRole("heading", { name: "Bình luận (0)" })).toBeVisible();

  await page.goto("/app/work/docs");
  await page.getByRole("radio", { name: /Đã gắn sao/ }).click();
  await expect(page.getByRole("region", { name: "Trang" }).getByRole("link", { name: /Kiến trúc hệ thống/ })).toBeVisible();
  await expect(page.getByRole("link", { name: /Kỹ thuật/ }).first()).toBeVisible();
});
