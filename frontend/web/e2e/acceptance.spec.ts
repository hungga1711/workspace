import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { PASSWORD, api, messageAction, setupWorkspace } from "./helpers";

/**
 * End-to-end acceptance scenario through the real browser: the sign-in page, gateway, server modules, Postgres
 * (search included), the event relays and object storage.
 */
const run = Date.now().toString(36);
const A = { company: `Alpha ${run}`, email: `owner-a-${run}@example.com`, name: "Lê Minh" };
const LAN = { email: `lan-${run}@example.com`, name: "Lan Nguyen" };

/** Our own sign-in screen: the BFF talks to the identity module, the browser never leaves the app. */
async function login(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("Email công việc").fill(email);
  await page.getByLabel("Mật khẩu").fill(PASSWORD);
  await page.getByRole("button", { name: "Đăng nhập" }).click();
  await page.waitForURL(/\/app\/(home|welcome)/);
}

let ownerA: Page;
let ctxA: BrowserContext;
let lanId: string;
let channelUrl: string;
let taskUrl: string;

test.describe.serial("Company A end-to-end", () => {
  test("signs up, skips invites, and turns the #general welcome thread into a task", async ({ browser }) => {
    ctxA = await browser.newContext();
    ownerA = await ctxA.newPage();
    await setupWorkspace(ownerA, A);
    await expect(ownerA).toHaveURL(/\/app\/welcome/);
    await expect(ownerA.getByText("Bước 3 / 4")).toBeVisible();
    await ownerA.getByRole("link", { name: "Bỏ qua", exact: true }).click();
    await ownerA.waitForURL(/\/app\/chat\/[0-9A-Z]{26}/);
    await expect(ownerA.getByRole("heading", { level: 1, name: "general" })).toBeVisible();
    await ownerA.getByRole("button", { name: "Thử: @AI tạo việc từ luồng này" }).click();
    const thread = ownerA.getByLabel("Luồng thảo luận", { exact: true });
    await expect(thread.getByText("Tóm tắt", { exact: true })).toBeVisible();
    await thread.getByRole("button", { name: "Tạo việc", exact: true }).first().click();
    await expect(thread.getByText(/Đã tạo T-/)).toBeVisible();
    await ownerA.goto("/app/home");
    await expect(ownerA.getByRole("heading", { level: 1 })).toContainText("Minh");
    // Desktop: eight destinations (conversations are listed below them); Trợ lý AI is the top bar's "Hỏi AI".
    await expect(ownerA.getByRole("navigation", { name: "Điều hướng chính" }).getByRole("link")).toHaveText([
      "Trang chủ",
      "Việc",
      "AI",
      "Tài liệu",
      "Bảng trắng",
      "Lịch",
      "Yêu cầu",
      "Chấm công",
    ]);
    const res = await ownerA.request.get("/app/home");
    expect(res.headers()["x-robots-tag"]).toContain("noindex");
  });

  test("configures features as admin; Home and Me change accordingly", async () => {
    // A self-hosted workspace has every module on by default; an admin can switch one off and back on.
    await ownerA.goto("/admin/workspace/settings");
    const att = ownerA.getByRole("switch", { name: "Chấm công" }).first();
    await expect(att).toHaveAttribute("aria-checked", "true");
    await att.click();
    await ownerA.getByRole("button", { name: "Lưu thay đổi" }).click();
    await expect(ownerA.getByText(/^Đã lưu\./)).toBeVisible();
    await ownerA.goto("/app/time");
    await expect(ownerA.getByLabel("Chấm công hôm nay")).toHaveCount(0);
    await ownerA.goto("/admin/workspace/settings");
    await ownerA.getByRole("switch", { name: "Chấm công" }).first().click();
    await ownerA.getByRole("button", { name: "Lưu thay đổi" }).click();
    await expect(ownerA.getByText(/^Đã lưu\./)).toBeVisible();
    await ownerA.goto("/app/time");
    await expect(ownerA.getByLabel("Chấm công hôm nay")).toBeVisible();
  });

  test("invites an employee who signs in with Employee permissions", async ({ browser }) => {
    const inv = await api(ownerA, "POST", "identity/members/invite", { email: LAN.email, displayName: LAN.name, password: PASSWORD });
    expect(inv.status).toBe(201);
    lanId = inv.body.userId;
    const ctx = await browser.newContext();
    const lan = await ctx.newPage();
    await login(lan, LAN.email);
    const admin = await api(lan, "PUT", "platform/workspace/config", { config: {} });
    expect(admin.status).toBe(403);
    await ctx.close();
  });

  test("chats in a channel, replies in a thread, AI summarizes and turns the discussion into a task", async () => {
    // Tin nhắn's overview; the new channel opens from the sidebar's "Tạo kênh".
    await ownerA.goto("/app/chat");
    const before = ownerA.url();
    await ownerA.getByRole("complementary", { name: "Điều hướng" }).getByRole("button", { name: "Tạo kênh" }).click();
    const dialog = ownerA.getByRole("dialog", { name: "Tạo kênh" });
    await dialog.getByLabel("Tên kênh").fill(`launch-${run}`);
    await dialog.getByRole("button", { name: "Tạo kênh" }).click();
    await ownerA.waitForURL((u) => /\/app\/chat\/[0-9A-Z]{26}$/.test(u.pathname) && u.href !== before);
    await expect(ownerA.getByRole("heading", { level: 1, name: `launch-${run}` })).toBeVisible();
    channelUrl = ownerA.url();
    const channelId = channelUrl.split("/").at(-1)!;
    await api(ownerA, "POST", `chat/channels/${channelId}/members`, { userIds: [lanId] });
    const composer = ownerA.getByLabel("Tin nhắn", { exact: true });
    await composer.fill("We should move the campaign deadline to October 18");
    await composer.press("Enter");
    await expect(ownerA.getByRole("log").getByText("We should move the campaign deadline to October 18")).toBeVisible();
    // Message actions appear on hover/focus (no permanent buttons under every message).
    await messageAction(ownerA.getByRole("log").getByRole("article").filter({ hasText: "We should move the campaign deadline to October 18" }), "Trả lời trong luồng");
    const reply = ownerA.getByLabel("Trả lời", { exact: true });
    await reply.fill(`<@${lanId}> please update the launch plan by 15/10`);
    await reply.press("Enter");
    await expect(ownerA.getByLabel("Luồng thảo luận", { exact: true }).getByText("please update the launch plan")).toBeVisible();
    await ownerA.getByRole("button", { name: "Tóm tắt luồng" }).click();
    await expect(ownerA.getByText("Tóm tắt", { exact: true })).toBeVisible();
    await ownerA.getByRole("button", { name: "Tạo việc", exact: true }).first().click();
    await expect(ownerA.getByText(/Đã tạo T-/)).toBeVisible();
  });

  test("the task appears in Work and on the assignee's Home; completing it updates Home", async ({ browser }) => {
    const ctx = await browser.newContext();
    const lan = await ctx.newPage();
    await login(lan, LAN.email);
    // Home lists the person's open tasks in "Việc của tôi" (it opens on the first tab with work); mentions have their own card.
    const taskRow = lan
      .getByRole("region", { name: "Việc của tôi" })
      .locator("li", { hasText: "please update the launch plan" })
      .filter({ has: lan.getByRole("button") });
    await expect
      .poll(
        async () => {
          await lan.reload();
          return taskRow.count();
        },
        { timeout: 60_000 },
      )
      .toBe(1);
    // The mention is shown with the author's name, not a raw id.
    await expect(lan.locator("li", { hasText: "@Lan Nguyen please update the launch plan" }).first()).toBeVisible();
    await taskRow.getByRole("button", { name: /^Đánh dấu xong/ }).click();
    await expect(taskRow).toHaveCount(0); // optimistic (E10)
    await expect
      .poll(
        async () => (await api(lan, "GET", "home/home")).body.needsYou.filter((i: { kind: string; title: string }) => i.kind === "task" && /launch plan/.test(i.title)).length,
        { timeout: 60_000 },
      )
      .toBe(0);
    await ctx.close();
  });

  test("Kanban: create a project and a task, move it across columns", async () => {
    await ownerA.goto("/app/work/tasks?view=projects");
    await ownerA.getByRole("button", { name: "Dự án mới" }).click();
    await ownerA.getByRole("dialog").getByLabel("Tên dự án").fill("Alpha launch");
    await ownerA.getByRole("dialog").getByRole("button", { name: "Tạo dự án" }).click();
    await ownerA.waitForURL(/\/app\/work\/projects\//);
    // The address carries the project's code (P-001); writes take its id.
    const projectId = (await api(ownerA, "GET", `work/projects/${ownerA.url().split("/").at(-1)!}`)).body.id;
    const t = await api(ownerA, "POST", "work/tasks", { title: "Prepare press kit", projectId });
    taskUrl = `/app/work/tasks/${t.body.id}`;
    await ownerA.reload();
    const card = ownerA.locator("[data-card]", { hasText: "Prepare press kit" });
    await expect(card).toBeVisible();
    // Real pointer gesture: dnd-kit activates after a 6px move, then follows the pointer.
    const from = (await card.boundingBox())!;
    const to = (await ownerA.getByRole("region", { name: "Đang làm" }).boundingBox())!;
    await ownerA.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await ownerA.mouse.down();
    await ownerA.mouse.move(from.x + from.width / 2 + 10, from.y + from.height / 2, { steps: 5 });
    await ownerA.mouse.move(to.x + to.width / 2, to.y + 60, { steps: 20 });
    await ownerA.mouse.up();
    // The card changes column, and its status with it: a column stands for a status.
    const lane = (await api(ownerA, "GET", `work/projects/${projectId}/board`)).body.columns[1].id;
    await expect.poll(async () => (await api(ownerA, "GET", `work/tasks/${t.body.id}`)).body.task.columnId).toBe(lane);
    expect((await api(ownerA, "GET", `work/tasks/${t.body.id}`)).body.task.status).toBe("in_progress");
  });

  test("uploads a file directly to storage through a presigned URL", async () => {
    await ownerA.goto(taskUrl);
    // The task's own attachments, not the task chat composer's "Đính kèm tệp".
    await ownerA.getByLabel("Đính kèm", { exact: true }).setInputFiles({ name: "brief.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4 e2e") });
    await expect(ownerA.getByText("brief.pdf")).toBeVisible();
  });

  test("finds the message through ⌘K search (Postgres full-text, permission-filtered)", async () => {
    await ownerA.goto("/app/home");
    await ownerA.keyboard.press(process.platform === "darwin" ? "Meta+k" : "Control+k");
    await ownerA.getByLabel("Tìm kiếm").fill("campaign deadline");
    await expect(ownerA.getByRole("option", { name: /campaign deadline/ }).filter({ hasNotText: /Hỏi AI|Xem tất cả/ })).toBeVisible({ timeout: 60_000 });
  });

  test("audit log records the important actions", async () => {
    await ownerA.goto("/admin/workspace/audit");
    // The log is a timeline (a line per action).
    const audit = ownerA.locator("#main");
    await expect(audit).toContainText("mời thành viên");
    await expect(audit).toContainText("tạo công ty");
    await expect(audit).toContainText("đổi cấu hình công ty");
  });
});
