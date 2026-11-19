import { expect, test } from "@playwright/test";
import { api, setupWorkspace } from "./helpers";

/** Contextual AI in chat: a deadline in a message becomes a task; "done" closes one. */
const run = Date.now().toString(36);

test("a deadline chip creates a linked task; finishing work closes it", async ({ browser }) => {
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 1000 } })).newPage();
  await setupWorkspace(page, { company: `Sig ${run}`, name: "Hà Vy", email: `sig-${run}@example.com` });
  await expect.poll(async () => (await api(page, "GET", "chat/channels")).body.channels.some((c: { name: string }) => c.name === "general")).toBe(true);
  const general = (await api(page, "GET", "chat/channels")).body.channels.find((c: { name: string }) => c.name === "general").id;
  await page.goto(`/app/chat/${general}`);
  const box = page.getByLabel("Tin nhắn", { exact: true });
  await box.fill("Gửi báo giá cho khách Hà Nội trước 20/11 nhé");
  await box.press("Enter");
  await box.fill("Chốt dùng màu xanh lá cho nút đặt lịch");
  await box.press("Enter");
  await page.getByRole("button", { name: "Tạo việc hạn 20/11" }).click();
  await expect(page.getByRole("link", { name: "Đã tạo việc" })).toBeVisible();
  // Decisions are not logged separately: the message stays as it is, with no extra chip.
  await expect(page.getByRole("button", { name: "Ghi quyết định" })).toHaveCount(0);
  const task = (await api(page, "GET", "work/tasks?scope=owned")).body.tasks.find((t: { title: string }) => t.title.startsWith("Gửi báo giá"));
  expect(task.source).toMatchObject({ type: "chat.message", channelId: general });
  expect(new Date(task.dueAt).getDate()).toBe(20);

  // "I'm done with X" closes the matching task from the chat (the writer's own tasks only).
  const me = (await api(page, "GET", "identity/members")).body.members[0].userId as string;
  await api(page, "POST", "work/tasks", { title: "Viết tài liệu onboarding", assigneeId: me });
  const vnpay = (await api(page, "POST", "work/tasks", { title: "Tích hợp API thanh toán VNPay", assigneeId: me })).body;
  await box.fill("Xong phần API thanh toán rồi nhé");
  await box.press("Enter");
  await page.getByRole("button", { name: "Đánh dấu xong một việc" }).click();
  const pick = page.getByRole("dialog", { name: "Bạn vừa xong việc nào?" });
  await expect(pick.getByRole("button").filter({ hasText: /^T-/ }).first()).toContainText("Tích hợp API thanh toán VNPay");
  await pick.getByRole("button", { name: /Tích hợp API thanh toán VNPay/ }).click();
  await expect(page.getByRole("link", { name: "Đã đánh dấu xong" })).toBeVisible();
  expect((await api(page, "GET", `work/tasks/${vnpay.id}`)).body.task?.status ?? (await api(page, "GET", `work/tasks/${vnpay.id}`)).body.status).toBe("done");
});
