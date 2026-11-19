import { expect, test } from "@playwright/test";
import { strToU8, zipSync } from "fflate";
import { axe, setupWorkspace } from "./helpers";

/** Admin › Tích hợp › Chuyển từ Slack: channels and threads from a Slack export, people matched by email. */
test("a Slack export becomes channels with their history", async ({ page }) => {
  const run = Date.now().toString(36);
  const email = `slack-${run}@example.com`;
  await setupWorkspace(page, { company: `Slack ${run}`, name: "Trịnh Hà", email: email });
  const zip = zipSync({
    "users.json": strToU8(
      JSON.stringify([
        { id: "U1", name: "ha", profile: { email, real_name: "Trịnh Hà" } },
        { id: "U2", name: "khoa", profile: { real_name: "Khoa Freelancer" } },
      ]),
    ),
    "channels.json": strToU8(JSON.stringify([{ name: `san-pham-${run}`, purpose: { value: "Bàn về sản phẩm" } }])),
    [`san-pham-${run}/2025-06-01.json`]: strToU8(
      JSON.stringify([
        { type: "message", user: "U1", text: "Chốt roadmap Q3 nhé <@U2>", ts: "1748743200.000100" },
        { type: "message", user: "U2", text: "Đã gửi bản nháp", ts: "1748743300.000200", thread_ts: "1748743200.000100" },
      ]),
    ),
  });
  await page.goto("/admin/workspace/integrations");
  await page.getByRole("button", { name: "Chuyển từ Slack" }).click();
  const dialog = page.getByRole("dialog", { name: "Chuyển kênh và lịch sử từ Slack" });
  await dialog.getByLabel("Tệp xuất từ Slack (.zip)").setInputFiles({ name: "slack.zip", mimeType: "application/zip", buffer: Buffer.from(zip) });
  await expect(dialog.getByText("1/2 người trong Slack đã khớp")).toBeVisible();
  await axe(page, "slack import");
  await dialog.getByRole("button", { name: "Nhập 1 kênh" }).click();
  await expect(dialog.getByText("Đã nhập 1 kênh (2 tin nhắn).")).toBeVisible();
  await dialog.getByRole("link", { name: "Mở" }).click();
  await expect(page.getByRole("log").getByText("Chốt roadmap Q3 nhé @Khoa Freelancer")).toBeVisible();
  await expect(page.getByRole("log").getByText("1 trả lời")).toBeVisible();
});
