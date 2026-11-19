import { expect, test, type Page } from "@playwright/test";
import { PASSWORD, api, setupWorkspace, signIn } from "./helpers";

/**
 * Home with real data end to end: Làm ngay (approvals decided inline), my tasks, the announcement, and the team tile
 * only for people who follow a team.
 */
const run = Date.now().toString(36);
const OWNER = { company: `Home ${run}`, email: `home-owner-${run}@example.com`, name: "Trần Minh" };
const LAN = { email: `home-lan-${run}@example.com`, name: "Nguyễn Lan" };
const SHOTS = process.env.SHOTS;

test.describe.serial("Home sections", () => {
  let owner: Page;
  let lan: Page;
  let lanId: string;
  let pinnedId: string;

  test("seeds a workspace with real work", async ({ browser }) => {
    owner = await (await browser.newContext({ viewport: { width: 1440, height: 1000 } })).newPage();
    await setupWorkspace(owner, OWNER);
    lanId = (await api(owner, "POST", "identity/members/invite", { email: LAN.email, displayName: LAN.name, roleNames: ["Employee"], password: PASSWORD })).body.userId;
    expect(lanId).toBeTruthy();
    lan = await (await browser.newContext({ viewport: { width: 1440, height: 1000 } })).newPage();
    await signIn(lan, LAN.email);

    // Lan asks the owner to approve, to settle a decision, and is blocked on a task the owner assigned.
    const soon = new Date(Date.now() + 3 * 3600_000).toISOString();
    const me = (await api(owner, "GET", "identity/members")).body.members.find((m: { email: string }) => m.email === OWNER.email).userId as string;
    await api(lan, "POST", "work/approvals", { title: "Mua màn hình cho đội thiết kế", approverId: me });
    await api(lan, "POST", "work/decisions", { title: "Đổi màu nút đặt lịch sang xanh lá", details: "Khách hàng yêu cầu trong buổi demo.", deciderId: me });
    const t = (await api(owner, "POST", "work/tasks", { title: "Tích hợp cổng thanh toán VNPay", assigneeId: lanId, priority: "high", dueAt: soon })).body;
    await api(lan, "PATCH", `work/tasks/${t.id}`, { expectedVersion: t.version, blockedReason: "Chờ API key từ đối tác" });
    await api(owner, "POST", "work/tasks", { title: "Chốt bản thiết kế trang đặt lịch", assigneeId: me, priority: "urgent", dueAt: soon });
    await api(owner, "POST", "work/calendar/events", {
      title: "Họp giao ban",
      startsAt: new Date(Date.now() + 3600_000).toISOString(),
      endsAt: new Date(Date.now() + 5400_000).toISOString(),
      attendeeIds: [lanId],
    });
    // Lan shares a document and edits it twice; the owner records a decision.
    const doc = (await api(lan, "POST", "work/docs", { title: "Kế hoạch ra mắt Q4", content: "# Mục tiêu", visibility: "private" })).body;
    await api(lan, "PUT", `work/docs/${doc.id}/sharing`, { userIds: [me] });
    let v = (await api(lan, "GET", `work/docs/${doc.id}`)).body.document.version as number;
    for (const c of ["# Mục tiêu\n- 100 khách hàng", "# Mục tiêu\n- 120 khách hàng"])
      v = (await api(lan, "PUT", `work/docs/${doc.id}`, { content: c, baseVersion: v })).body.current_version;
    await api(lan, "POST", "work/tasks", {
      title: "Gửi báo giá cho khách Hà Nội",
      assigneeId: me,
      source: { type: "chat.message", messageId: "01JAAAAAAAAAAAAAAAAAAAAAAA", channelId: "01JBBBBBBBBBBBBBBBBBBBBBBB" },
    });
  });

  test("the owner publishes a pinned announcement and an event", async () => {
    const pinned = await api(owner, "POST", "employee/announcements", { title: "Lịch nghỉ lễ 20/11", body: "Công ty nghỉ **cả ngày** 20/11 để tri ân thầy cô.", pinned: true });
    expect(pinned.status).toBeLessThan(300);
    pinnedId = pinned.body.id;
    await api(owner, "POST", "employee/announcements", {
      title: "Tiệc cuối năm",
      category: "event",
      eventAt: new Date(Date.now() + 10 * 86400_000).toISOString(),
      body: "Tại nhà hàng Sen.",
    });
  });

  test("Lan gets the staff Home: her day, no team numbers", async () => {
    await lan.goto("/app/home");
    await expect(lan.getByRole("region", { name: /^(Đội của bạn|Công ty)$/ })).toHaveCount(0);
    await expect(lan.getByRole("region", { name: "Tuần của tôi" })).toBeVisible();
    await expect(lan.getByRole("region", { name: "Việc của tôi" }).getByText("Tích hợp cổng thanh toán VNPay")).toBeVisible();
    // Announcements reach people through their notifications (Home does not list them): Lan's
    // notice opens the announcement, which records that she read it.
    await expect
      .poll(
        async () => {
          const inbox = (await api(lan, "GET", "home/notifications")).body as Record<string, unknown>;
          return Object.values(inbox)
            .flatMap((v) => (Array.isArray(v) ? (v as { kind?: string }[]) : []))
            .some((n) => n.kind === "announcement");
        },
        { timeout: 30_000 },
      )
      .toBe(true);
    await lan.goto(`/app/announcements?open=${pinnedId}`);
    await expect(lan.getByRole("dialog").getByText("Lịch nghỉ lễ 20/11").first()).toBeVisible();
    await expect
      .poll(async () => (await api(lan, "GET", "employee/announcements")).body.announcements?.find((a: { id: string }) => a.id === pinnedId)?.readAt ?? null)
      .not.toBeNull();
  });

  test("the owner's Home: Hôm nay leads with what waits for a decision; the team tile links to Tiến độ", async () => {
    // "Hôm nay" says how much waits and of what kind, with the way there; the deciding is done in Yêu cầu.
    const day = owner.getByRole("region", { name: "Hôm nay" });
    await expect
      .poll(
        async () => {
          await owner.goto("/app/home");
          return day.getByText("1 việc chờ bạn quyết").count();
        },
        { timeout: 30_000 },
      )
      .toBe(1);
    await expect(owner.getByRole("heading", { level: 1 })).toContainText("Chào");
    await expect(day.getByText("1 yêu cầu")).toBeVisible();
    await expect(owner.getByRole("region", { name: /^(Đội của bạn|Công ty)$/ }).getByRole("link", { name: /1\s*bị chặn/ })).toHaveAttribute("href", "/app/ai/progress");
    await expect(owner.getByRole("region", { name: "Việc của tôi" }).getByText("Chốt bản thiết kế trang đặt lịch")).toBeVisible();
    if (SHOTS) await owner.screenshot({ path: `${SHOTS}/home-full.png`, fullPage: true });
    await day.getByRole("link", { name: /Xem duyệt/ }).click();
    await owner.waitForURL(/\/app\/work\/ops/);
    await owner.getByRole("list", { name: "Chờ tôi xử lý" }).getByRole("link", { name: "Mua màn hình cho đội thiết kế" }).click();
    // The request opens over the list; the decision is made on it.
    const request = owner.getByRole("dialog");
    await request.getByRole("button", { name: "Duyệt", exact: true }).click();
    await expect(request.getByText("Đã duyệt").first()).toBeVisible();
    // Decided: Home no longer says anything waits (it follows the decision's event, so within a moment).
    await expect
      .poll(
        async () => {
          await owner.goto("/app/home");
          await expect(owner.getByRole("heading", { level: 1 })).toContainText("Chào");
          return owner.getByText("1 việc chờ bạn quyết").count();
        },
        { timeout: 30_000 },
      )
      .toBe(0);
  });

  test("admins see every announcement with its reach, and can pin or remove it", async () => {
    await owner.goto("/admin/workspace/announcements");
    const row = owner.getByRole("row", { name: /Lịch nghỉ lễ 20\/11/ });
    await expect(row).toContainText("Đang hiển thị");
    await expect(row).toContainText("Toàn công ty");
    await expect(row.getByRole("cell").nth(4)).toContainText("1");
    if (SHOTS) await owner.screenshot({ path: `${SHOTS}/admin-announcements.png` });
    await owner.getByRole("button", { name: "Thao tác cho Tiệc cuối năm" }).click();
    await owner.getByRole("menuitem", { name: "Gỡ thông báo" }).click();
    // The app's own confirmation, not the browser's.
    await owner.getByRole("button", { name: "Xác nhận" }).click();
    await expect(owner.getByRole("status")).toContainText("Đã gỡ thông báo");
    await expect(owner.getByRole("row", { name: /Tiệc cuối năm/ })).toHaveCount(0);
  });
});
