import { expect, test, type Page } from "@playwright/test";
import { PASSWORD, setupWorkspace } from "./helpers";

/**
 * AI Insights, the person's side: a ChatGPT conversation recorded by the extension counts in Của tôi › AI, it is
 * tied to the task it served (the full-text suggestion offers that task), the person exports their data and asks
 * for it to be deleted; the owner deletes it from Admin › AI. The page does not list conversations one by one:
 * the figures and the person's rights are on screen, the tie to a task is made where the AI is used.
 */
const run = Date.now().toString(36);
const post = (p: Page, path: string, data: unknown, method = "POST") =>
  p.request.fetch(`/api/proxy/${path}`, { method, headers: { "x-wos-csrf": "1" }, data }).then((r) => r.json());

test("AI Insights: my conversation, task link, export and erasure", async ({ browser }) => {
  test.setTimeout(180_000);
  const owner = await (await browser.newContext({ viewport: { width: 1440, height: 1000 } })).newPage();
  await setupWorkspace(owner, { company: `Insights ${run}`, name: "Trần Minh Hưng", email: `ins-owner-${run}@example.com` });
  const maiEmail = `ins-mai-${run}@example.com`;
  const maiId = (await post(owner, "identity/members/invite", { email: maiEmail, displayName: "Đỗ Mai", roleNames: ["Employee"], password: PASSWORD })).userId as string;
  const task = await post(owner, "work/tasks", { title: `Báo giá khách hàng Minh Long ${run}`, assigneeId: maiId });

  const mai = await (await browser.newContext({ viewport: { width: 1440, height: 1000 } })).newPage();
  await mai.goto("/login");
  await mai.getByLabel("Email").fill(maiEmail);
  await mai.getByLabel("Mật khẩu").fill(PASSWORD);
  await mai
    .getByRole("button", { name: /Đăng nhập/ })
    .first()
    .click();
  await mai.waitForURL(/\/app\//);
  await mai.goto("/app/me?tab=ai");
  await mai.getByRole("button", { name: "Tạo mã kết nối" }).click();
  const token = (await mai.getByTestId("ai-code").textContent())!.trim().split("#")[1]!;
  const sent = await mai.request.post("/api/ai-monitor/events", {
    headers: { authorization: `Bearer ${token}` },
    data: { events: [{ url: "https://chatgpt.com/c/ins1", conversation: "/c/ins1", prompt: `Soạn email báo giá cho khách hàng Minh Long ${run}`, response: null }] },
  });
  expect(sent.status()).toBe(200);

  await mai.reload();
  await expect(mai.getByRole("heading", { name: /AI Insights · 7 ngày qua/ })).toBeVisible();
  // One conversation, on ChatGPT, this week.
  await expect(mai.getByText("ChatGPT", { exact: true }).first()).toBeVisible();
  await expect(mai.getByText("1 hội thoại").first()).toBeVisible();

  // The conversation is the person's own; its full-text suggestion is the task it served, and it is tied to it.
  const own = async () =>
    ((await (await mai.request.get("/api/proxy/ai/oversight/me/export", { headers: { "x-wos-csrf": "1" } })).json()) as { conversations: { id: string; taskId?: string | null }[] })
      .conversations;
  const [conv] = await own();
  expect(conv).toBeTruthy();
  const suggested = (await (await mai.request.get(`/api/proxy/ai/oversight/me/conversations/${conv!.id}/suggestions`, { headers: { "x-wos-csrf": "1" } })).json()) as {
    tasks: { id: string }[];
  };
  expect(suggested.tasks.map((t) => t.id)).toContain(task.id);
  await post(mai, `ai/oversight/me/conversations/${conv!.id}/task`, { taskId: task.id, via: "suggested" }, "PUT");
  expect((await own())[0]!.taskId).toBe(task.id);

  // My data: a JSON export, then a deletion request.
  const download = mai.waitForEvent("download");
  await mai.getByRole("button", { name: "Xuất dữ liệu của tôi (JSON)" }).click();
  expect((await download).suggestedFilename()).toMatch(/^ai-insights-.*\.json$/);
  await mai.getByRole("button", { name: "Yêu cầu xoá" }).click();
  await mai.getByRole("button", { name: "Gửi yêu cầu" }).click();
  await expect(mai.getByTestId("ai-erasure-status")).toContainText("đang chờ xử lý");

  // The owner deletes it from Admin › AI.
  await owner.goto("/admin/workspace/ai/privacy");
  const admin = owner.getByTestId("ai-erasure-admin");
  await expect(admin.getByText("Đỗ Mai")).toBeVisible();
  await admin.getByRole("button", { name: "Xoá dữ liệu" }).click();
  // The app's own confirmation, not the browser's.
  await owner.getByRole("button", { name: "Xác nhận" }).click();
  await expect(admin.getByText("Đã xoá")).toBeVisible();

  await mai.reload();
  await expect(mai.getByTestId("ai-erasure-status")).toContainText("Đã xoá dữ liệu");
  expect(await own()).toEqual([]);
});
