import { expect, test } from "@playwright/test";
import { PASSWORD, api, setupWorkspace, signIn } from "./helpers";

/** Chat attachments: direct upload, image preview, download by a colleague, channel file list. */
const run = Date.now().toString(36);
const OWNER = { company: `Files ${run}`, email: `files-owner-${run}@example.com`, name: "Kiều Trang" };
const MATE = { email: `files-mate-${run}@example.com`, name: "Tạ Long" };
// 1×1 PNG
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

test("send files in a channel; a colleague previews and downloads them", async ({ browser }) => {
  const owner = await (await browser.newContext({ viewport: { width: 1440, height: 1000 } })).newPage();
  await setupWorkspace(owner, OWNER);
  await api(owner, "POST", "identity/members/invite", { email: MATE.email, displayName: MATE.name, roleNames: ["Employee"], password: PASSWORD });
  await expect.poll(async () => (await api(owner, "GET", "chat/channels")).body.channels.some((c: { name: string }) => c.name === "general")).toBe(true);
  const general = (await api(owner, "GET", "chat/channels")).body.channels.find((c: { name: string }) => c.name === "general").id;

  await owner.goto(`/app/chat/${general}`);
  await owner.getByLabel("Đính kèm tệp").setInputFiles([
    { name: "Báo giá tháng 11.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4 test") },
    { name: "so-do.png", mimeType: "image/png", buffer: PNG },
  ]);
  const pending = owner.getByRole("list", { name: "Tệp sắp gửi" });
  await expect(pending.getByText("đang tải…")).toHaveCount(0);
  await owner.getByLabel("Tin nhắn", { exact: true }).fill("Gửi mọi người báo giá và sơ đồ");
  await owner.getByRole("button", { name: "Gửi" }).click();
  const files = owner.getByRole("list", { name: "Tệp đính kèm" }).last();
  await expect(files.getByText("Báo giá tháng 11.pdf")).toBeVisible();
  await expect(files.getByRole("img", { name: "so-do.png" })).toBeVisible();
  if (process.env.SHOTS) await owner.screenshot({ path: `${process.env.SHOTS}/chat-files.png` });

  const mate = await (await browser.newContext()).newPage();
  await signIn(mate, MATE.email);
  await expect.poll(async () => (await api(mate, "GET", "chat/channels")).body.channels.some((c: { id: string }) => c.id === general)).toBe(true);
  await mate.goto(`/app/chat/${general}`);
  const download = mate.waitForEvent("download");
  await mate
    .getByRole("article")
    .getByRole("button", { name: /Báo giá tháng 11\.pdf/ })
    .click();
  expect((await download).suggestedFilename()).toBe("Báo giá tháng 11.pdf");
  // "Chi tiết" (header button) opens the details drawer over the conversation; it lists the channel's files.
  await mate.getByRole("button", { name: "Chi tiết", exact: true }).click();
  const details = mate.getByRole("dialog", { name: /^Chi tiết/ });
  await expect(details.getByText("Báo giá tháng 11.pdf")).toBeVisible();
  // Its "Tệp" tab is the channel's whole file list.
  await details
    .getByRole("radio", { name: "Tệp" })
    .or(details.getByRole("tab", { name: "Tệp" }))
    .click();
  await expect(details.getByText("Báo giá tháng 11.pdf").first()).toBeVisible();
});
