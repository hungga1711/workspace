import { expect, test } from "@playwright/test";
import { setupWorkspace } from "./helpers";

/** Chat extras: a poll with live counts, and a personal status with Do not disturb. */
test("a poll in a channel and a personal status", async ({ page }) => {
  test.setTimeout(150_000);
  const run = Date.now().toString(36);
  await page.setViewportSize({ width: 1440, height: 900 });
  await setupWorkspace(page, { company: `Poll ${run}`, name: "Lê Minh", email: `poll-${run}@example.com` });
  await page.goto("/app/chat/general");
  await page.waitForURL(/\/app\/chat\//);

  await page.getByRole("button", { name: "Tạo bình chọn" }).click();
  const dlg = page.getByRole("dialog", { name: "Tạo bình chọn" });
  await dlg.getByLabel("Câu hỏi").fill("Trưa nay ăn gì?");
  await dlg.getByLabel("Lựa chọn 1").fill("Phở");
  await dlg.getByLabel("Lựa chọn 2").fill("Cơm tấm");
  await dlg.getByRole("button", { name: "Gửi bình chọn" }).click();
  const poll = page.getByRole("group", { name: "Bình chọn: Trưa nay ăn gì?" });
  await expect(poll).toBeVisible();
  await poll.getByRole("button", { name: /Cơm tấm/ }).click();
  await expect(poll.getByRole("button", { name: /Cơm tấm/ })).toHaveAttribute("aria-pressed", "true");
  await expect(poll.getByText("1 người đã chọn")).toBeVisible();
  await page.reload();
  await expect(page.getByRole("group", { name: "Bình chọn: Trưa nay ăn gì?" }).getByRole("button", { name: /Cơm tấm/ })).toHaveAttribute("aria-pressed", "true");

  // Status from the account menu: a preset with Do not disturb.
  await page.getByRole("button", { name: "Tài khoản: Lê Minh" }).click();
  await page.getByRole("menuitem", { name: "Đặt trạng thái" }).click();
  const st = page.getByRole("dialog", { name: "Đặt trạng thái" });
  await st.getByRole("button", { name: /Tập trung, đừng làm phiền/ }).click();
  await expect(st.getByLabel("Không làm phiền")).toBeChecked();
  await st.getByRole("button", { name: "Lưu" }).click();
  await expect(st).toBeHidden();
  const mine = async () => {
    const body = await (await page.request.get("/api/proxy/chat/statuses", { headers: { "x-wos-csrf": "1" } })).json();
    return body.statuses.find((s: { userId: string }) => s.userId === body.me) as { text: string; dndUntil: string | null } | undefined;
  };
  await expect.poll(async () => (await mine())?.text).toBe("Tập trung, đừng làm phiền");
  expect((await mine())?.dndUntil).toBeTruthy();
});
