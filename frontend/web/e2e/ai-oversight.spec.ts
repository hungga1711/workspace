import { expect, test, type Page } from "@playwright/test";
import { PASSWORD, setupWorkspace } from "./helpers";

/**
 * The boss's view of AI at work: an employee uses the company's AI assistant and ChatGPT (through the
 * browser extension's endpoint); the owner sees both per person and per department, with the topic and
 * a sensitive-data alert, and never the text of a prompt; the employee is told when the policy changes.
 * Theo dõi shows the department card and the person page joins their work and AI use.
 */
const run = Date.now().toString(36);
const post = (p: Page, path: string, data: unknown, method = "POST") =>
  p.request.fetch(`/api/proxy/${path}`, { method, headers: { "x-wos-csrf": "1" }, data }).then((r) => r.json());

test("AI oversight: company assistant + ChatGPT per person and department, policy, transparency", async ({ browser }) => {
  test.setTimeout(240_000);
  const owner = await (await browser.newContext({ viewport: { width: 1440, height: 1000 } })).newPage();
  await setupWorkspace(owner, { company: `AI ${run}`, name: "Trần Minh Hưng", email: `ai-owner-${run}@example.com` });
  const dept = await post(owner, "employee/departments", { name: "Kỹ thuật" });
  const lanEmail = `ai-lan-${run}@example.com`;
  const lanId = (await post(owner, "identity/members/invite", { email: lanEmail, displayName: "Phan Lan", roleNames: ["Employee"], password: PASSWORD })).userId as string;
  await post(
    owner,
    `employee/employees/${lanId}`,
    { displayName: "Phan Lan", title: "Lập trình viên", departmentId: dept.id, managerId: null, location: "", hireDate: null },
    "PUT",
  );
  const task = await post(owner, "work/tasks", { title: "Hoàn thiện API hoá đơn", assigneeId: lanId, dueAt: new Date(Date.now() + 3 * 86400_000).toISOString() });

  // The employee: the company assistant, then a connection code for the extension.
  const lan = await (await browser.newContext({ viewport: { width: 1440, height: 1000 } })).newPage();
  await lan.goto("/login");
  await lan.getByLabel("Email").fill(lanEmail);
  await lan.getByLabel("Mật khẩu").fill(PASSWORD);
  await lan
    .getByRole("button", { name: /Đăng nhập/ })
    .first()
    .click();
  await lan.waitForURL(/\/app\//);
  // Lan reports progress with a note; the boss reads the note on her page, not only the %.
  expect(
    (
      await lan.request.post(`/api/proxy/work/tasks/${task.id}/checkin`, {
        headers: { "x-wos-csrf": "1" },
        data: { progress: 60, etaAt: null, note: "Còn phần xuất hoá đơn điện tử" },
      })
    ).status(),
  ).toBeLessThan(300);
  await lan.goto("/app/ai/ask");
  await expect(lan.getByText("Công ty thấy chủ đề và một câu tóm tắt do AI viết về cuộc trò chuyện này, không thấy nội dung.")).toBeVisible();
  // A secret in the draft is caught before it leaves.
  await lan.getByLabel("Nhắn cho Trợ lý AI").fill("Kiểm tra cấu hình này: password: Hunter2024!");
  await lan.getByRole("button", { name: "Gửi", exact: true }).click();
  await expect(lan.getByRole("alert").filter({ hasText: /mật khẩu\/khoá API/i })).toBeVisible();
  await lan.getByRole("button", { name: "Sửa lại" }).click();
  await expect(lan.getByRole("alert").filter({ hasText: /mật khẩu\/khoá API/i })).toHaveCount(0);
  await lan.getByLabel("Nhắn cho Trợ lý AI").fill("Soạn email báo giá cho khách hàng Nhật Minh");
  await lan.getByRole("button", { name: "Gửi", exact: true }).click();
  await expect(lan.locator("[data-role=assistant]").first()).not.toHaveAttribute("aria-busy", "true", { timeout: 60_000 });
  await expect(lan).toHaveURL(/\/app\/ai\/ask\?c=/);
  // One conversation: no history rail yet; the conversation's title heads the thread.
  await expect(lan.getByRole("heading", { name: /Soạn email báo giá/ })).toBeVisible();

  await lan.goto("/app/me?tab=ai");
  await lan.getByRole("button", { name: "Tạo mã kết nối" }).click();
  const code = (await lan.getByTestId("ai-code").textContent())!.trim();
  const token = code.split("#")[1]!;
  // What the extension sends after a prompt on chatgpt.com (a password inside: an alert for the boss).
  const sent = await lan.request.post("/api/ai-monitor/events", {
    headers: { authorization: `Bearer ${token}` },
    data: { events: [{ url: "https://chatgpt.com/c/abc123", conversation: "/c/abc123", prompt: "Sửa lỗi TypeScript khi kết nối DB, password: Hunter2024!", response: null }] },
  });
  expect(sent.status()).toBe(200);
  expect((await sent.json()).accepted).toBe(1);
  expect(
    (await lan.request.post("/api/ai-monitor/events", { headers: { authorization: "Bearer aim_wrongwrongwrongwrongwrong" }, data: { events: [] } })).status(),
  ).toBeGreaterThanOrEqual(400);

  // The owner (AI admin) is told at once, without the text.
  await expect
    .poll(async () => JSON.stringify(await (await owner.request.get("/api/proxy/home/notifications", { headers: { "x-wos-csrf": "1" } })).json()), { timeout: 60_000 })
    .toContain("Dữ liệu nhạy cảm (mật khẩu/khoá API) vừa được gửi vào ChatGPT");
  expect(JSON.stringify(await (await owner.request.get("/api/proxy/home/notifications", { headers: { "x-wos-csrf": "1" } })).json())).not.toContain("Hunter2024");

  // The boss.
  await owner.goto("/app/ai/adoption/usage");
  // Departments and people are folded sections under the answer and the numbers.
  const openDetails = async () => {
    await owner.getByRole("button", { name: /^Phòng ban/ }).click();
    await owner.getByRole("button", { name: /^Người/ }).click();
  };
  await openDetails();
  const people = owner.locator("#ai-people");
  await expect(people.getByText("Phan Lan").first()).toBeVisible();
  await expect(owner.getByRole("button", { name: /^Kỹ thuật/ }).first()).toBeVisible();
  await expect(owner.getByText("Mật khẩu/khoá API").first()).toBeVisible();
  await expect(owner.getByText("Lập trình").first()).toBeVisible();
  await people.getByRole("button", { name: /Phan Lan/ }).click();
  const drawer = owner.getByRole("dialog");
  await expect(drawer.getByText("ChatGPT").first()).toBeVisible();
  await expect(drawer.getByText("Trợ lý AI công ty").first()).toBeVisible();
  await owner.keyboard.press("Escape");
  // Excel for the boss: one row per person, with work done next to AI use.
  const [file] = await Promise.all([owner.waitForEvent("download"), owner.getByRole("button", { name: "Xuất CSV" }).click()]);
  const csv = await (await import("node:fs/promises")).readFile((await file.path())!, "utf8");
  expect(csv).toContain("Phan Lan");
  expect(csv).toContain("Kỹ thuật");

  // Nobody reads Lan's prompts: no "Xem nội dung", no endpoint for the text, and "full" is not a policy any more.
  await expect(owner.getByRole("button", { name: "Xem nội dung" })).toHaveCount(0);
  const h = { headers: { "x-wos-csrf": "1" } };
  const seen = await (await owner.request.get("/api/proxy/ai/oversight?days=7", h)).json();
  expect(seen.recent.length).toBeGreaterThan(0);
  expect(seen.recent.every((c: { title?: string }) => c.title === undefined)).toBe(true);
  expect(JSON.stringify(seen.recent)).not.toContain("Hunter2024");
  expect((await owner.request.get(`/api/proxy/ai/oversight/conversations/${seen.recent[0].id}`, h)).status()).toBe(404);
  expect((await owner.request.put("/api/proxy/ai/policy", { ...h, data: { detail: "full", captureResponses: false, retentionDays: 180 } })).status()).toBe(400);
  // The owner narrows the policy to topics only.
  expect((await owner.request.put("/api/proxy/ai/policy", { ...h, data: { detail: "topic", captureResponses: false, retentionDays: 180 } })).status()).toBe(200);
  await lan.goto("/app/me?tab=ai");
  await expect(lan.getByText("Quản lý thấy gì")).toBeVisible();
  await expect(lan.getByText("Ai đã mở nội dung của bạn")).toHaveCount(0);
  // Lan was told that the policy changed (notice before processing changes).
  await expect
    .poll(async () => JSON.stringify(await (await lan.request.get("/api/proxy/home/notifications", { headers: { "x-wos-csrf": "1" } })).json()), { timeout: 60_000 })
    .toContain("Công ty vừa đổi chính sách ghi nhận việc dùng AI");

  // The weekly report the boss reads on Monday has the departments and the week's AI use.
  const report = await (await owner.request.post("/api/proxy/work/followup/report", { headers: { "x-wos-csrf": "1" }, data: { locale: "vi" } })).json();
  const doc = await (await owner.request.get(`/api/proxy/work/docs/${report.id}`, { headers: { "x-wos-csrf": "1" } })).json();
  const html = JSON.stringify(doc);
  expect(html).toContain("Theo phòng ban");
  expect(html).toContain("Kỹ thuật");
  expect(html).toContain("AI trong tuần");
  expect(html).toContain("1 cảnh báo dữ liệu nhạy cảm");
  expect(html).not.toContain("Hunter2024");

  // From an alert straight to a conversation with the person.
  await owner.goto("/app/ai/adoption/usage");
  await openDetails();
  await people.getByRole("button", { name: /Phan Lan/ }).click();
  await owner.getByRole("dialog").getByRole("button", { name: "Nhắn riêng" }).click();
  await owner.waitForURL(/\/app\/chat\/[0-9A-Z]{26}/);

  // "Hỏi AI về đội" answers about AI use too, from the same data and scope.
  const ask = await (await owner.request.post("/api/proxy/ai/ask", { headers: { "x-wos-csrf": "1" }, data: { question: "Đội tôi dùng ChatGPT làm gì?" } })).json();
  expect(ask.toolCalls).toContain("team_ai_usage");
  expect(ask.answer).toContain("Phan Lan");

  // The person page joins work and AI (an old Đội ngũ link to a person lands there).
  await owner.goto(`/app/work?tab=team&u=${lanId}`);
  await expect(owner.getByRole("heading", { level: 1, name: "Phan Lan" })).toBeVisible();
  await expect(owner.getByText("Hoàn thiện API hoá đơn")).toBeVisible();
  await expect(owner.getByText("“Còn phần xuất hoá đơn điện tử”")).toBeVisible();
  // The row shows her note and the task's status; the percentage she reported is not printed beside it.
  await expect(
    owner
      .getByRole("region", { name: /Việc đang mở/ })
      .or(owner.locator("section").filter({ hasText: "Việc đang mở" }))
      .first(),
  ).toContainText("Đang làm");
  await expect(owner.getByRole("heading", { name: "Dùng AI (30 ngày)" })).toBeVisible();
});
