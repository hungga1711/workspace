import { expect, test } from "@playwright/test";
import { messageAction, setupWorkspace } from "./helpers";

/** Chat: pin and save show their state and undo; notifications per conversation (level, timed mute). */
test("pin and save toggle visibly; a conversation mutes for an hour and comes back", async ({ page }) => {
  test.setTimeout(120_000);
  const run = Date.now().toString(36);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await setupWorkspace(page, { company: `Noti ${run}`, name: "Lê Minh", email: `noti-${run}@example.com` });
  const channels = async () => (await (await page.request.get("/api/proxy/chat/channels", { headers: { "x-wos-csrf": "1" } })).json()).channels as { id: string; name: string }[];
  await expect.poll(async () => (await channels()).some((c) => c.name === "general"), { timeout: 30_000 }).toBe(true);
  const general = (await channels()).find((c) => c.name === "general")!.id;
  await page.goto(`/app/chat/${general}`);
  const box = page.getByLabel("Tin nhắn", { exact: true });
  await box.fill("Chốt lịch ra mắt ngày 20/11");
  await box.press("Enter");
  const msg = page.getByRole("article").filter({ hasText: "Chốt lịch ra mắt ngày 20/11" });
  await messageAction(msg, "Thêm thao tác với tin nhắn");
  await page.getByRole("menuitem", { name: "Ghim vào kênh" }).click();
  await expect(msg.getByText("Đã ghim")).toBeVisible();
  await messageAction(msg, "Lưu tin nhắn");
  await expect(msg.getByRole("button", { name: "Bỏ lưu" })).toHaveAttribute("aria-pressed", "true");
  await messageAction(msg, "Thêm thao tác với tin nhắn");
  await page.getByRole("menuitem", { name: "Bỏ ghim" }).click();
  await expect(msg.getByText("Đã ghim")).toHaveCount(0);

  await page.getByRole("button", { name: /^Thông báo:/ }).click();
  await page.getByRole("menuitem", { name: "Trong 1 giờ" }).click();
  await expect(page.getByRole("button", { name: /^Thông báo: Đã tắt đến/ })).toBeVisible();
  await page.getByRole("button", { name: /^Thông báo:/ }).click();
  await page.getByRole("menuitemradio", { name: /Bật lại thông báo/ }).click();
  await page.getByRole("button", { name: /^Thông báo:/ }).click();
  await page.getByRole("menuitemradio", { name: /Mọi tin nhắn/ }).click();
  await expect(page.getByRole("button", { name: "Thông báo: Mọi tin nhắn" })).toBeVisible();
  const mine = (await channels()).find((c) => c.id === general) as unknown as { notify: string; muted: boolean };
  expect(mine).toMatchObject({ notify: "all", muted: false });
});
