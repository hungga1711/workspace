import { expect, test } from "@playwright/test";
import { setupWorkspace } from "./helpers";

/** Channel settings: rename, topic, archive to read-only, restore; #general cannot be archived. */
const run = Date.now().toString(36);

test("a channel admin renames, archives and restores a channel", async ({ browser }) => {
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 1000 } })).newPage();
  await setupWorkspace(page, { company: `Kenh ${run}`, name: "Chủ Kênh", email: `kenh-${run}@example.com` });
  const ch = await (await page.request.post("/api/proxy/chat/channels", { headers: { "x-wos-csrf": "1" }, data: { kind: "public", name: "du-an-cu" } })).json();
  await page.request.post(`/api/proxy/chat/channels/${ch.id}/messages`, { headers: { "x-wos-csrf": "1" }, data: { body: "Biên bản tuần trước ở đây" } });

  // Channel settings open from the details drawer ("Chi tiết" in the header), beside its close button.
  const openSettings = async () => {
    const details = page.getByRole("dialog", { name: /^Chi tiết/ });
    if (!(await details.isVisible())) await page.getByRole("button", { name: "Chi tiết", exact: true }).click();
    await details.getByRole("button", { name: "Cài đặt kênh" }).click();
  };
  await page.goto(`/app/chat/${ch.id}`);
  await openSettings();
  const dlg = page.getByRole("dialog", { name: "Cài đặt kênh" });
  // A workspace admin decides which public channels every newcomer joins.
  await expect(dlg.getByLabel(/Thành viên mới tự vào kênh này/)).not.toBeChecked();
  await dlg.getByLabel(/Thành viên mới tự vào kênh này/).check();
  await dlg.getByLabel("Mã kênh").fill("du an moi");
  await expect(dlg.getByLabel("Mã kênh")).toHaveValue("du-an-moi"); // spaces become dashes as you type
  await dlg.getByLabel("Chủ đề").fill("Ra mắt sản phẩm Q4");
  await dlg.getByRole("button", { name: "Lưu", exact: true }).click();
  const convo = page.getByRole("region", { name: "Cuộc trò chuyện du-an-moi" });
  await expect(convo.getByRole("heading", { name: "du-an-moi" })).toBeVisible();
  expect((await (await page.request.get(`/api/proxy/chat/channels/${ch.id}`, { headers: { "x-wos-csrf": "1" } })).json()).autoJoin).toBe(true);
  await expect(convo.getByText("Ra mắt sản phẩm Q4").first()).toBeVisible();
  await expect(page.getByRole("complementary", { name: "Điều hướng" }).getByRole("link", { name: /du-an-moi/ })).toBeVisible();

  await openSettings();
  await page.getByRole("dialog", { name: "Cài đặt kênh" }).getByRole("button", { name: "Lưu trữ kênh" }).click();
  await expect(convo.getByRole("note")).toContainText("Kênh đã được lưu trữ");
  await expect(convo.getByText("Biên bản tuần trước ở đây")).toBeVisible(); // history stays
  await expect(convo.getByRole("textbox")).toHaveCount(0);
  await expect(page.getByRole("complementary", { name: "Điều hướng" }).getByRole("link", { name: /du-an-moi/ })).toHaveCount(0);
  if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/chat-archived.png` });

  // It can be found again from Browse channels, under "Archived".
  await page.goto("/app/chat/browse");
  await page.getByRole("button", { name: /^Đã lưu trữ/ }).click();
  await page
    .getByRole("link", { name: /du-an-moi/ })
    .first()
    .click();
  await expect(convo.getByRole("note")).toContainText("Kênh đã được lưu trữ");
  await convo.getByRole("button", { name: "Khôi phục kênh" }).click();
  await expect(convo.getByRole("note")).toHaveCount(0);
  await expect(convo.getByPlaceholder(/^Nhắn #du-an-moi/)).toBeVisible();
  await expect(page.getByRole("complementary", { name: "Điều hướng" }).getByRole("link", { name: /du-an-moi/ })).toBeVisible();

  // #general is the workspace's default channel: it can be renamed but not archived.
  const general = await (await page.request.fetch("/api/proxy/chat/channels", { headers: { "x-wos-csrf": "1" } })).json();
  await page.goto(`/app/chat/${general.channels.find((c: { name: string }) => c.name === "general").id}`);
  await openSettings();
  await expect(page.getByRole("dialog", { name: "Cài đặt kênh" })).toContainText("Kênh mặc định của công ty không lưu trữ được.");
});
