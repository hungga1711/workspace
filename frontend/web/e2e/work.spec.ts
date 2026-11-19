import { expect, test, type Page } from "@playwright/test";
import { PASSWORD, api, setupWorkspace, signIn } from "./helpers";

/** Work: tasks and project boards in one tab, meetings with minutes and action items. */
const run = Date.now().toString(36);
const OWNER = { company: `Work ${run}`, email: `work-owner-${run}@example.com`, name: "Phạm Huy" };
const NEW = { email: `work-new-${run}@example.com`, name: "Đỗ Thảo" };
const SHOTS = process.env.SHOTS;

test.describe.serial("Work tabs", () => {
  let owner: Page;
  let hire: Page;
  let hireId: string;

  test("setup", async ({ browser }) => {
    owner = await (await browser.newContext({ viewport: { width: 1440, height: 1000 } })).newPage();
    await setupWorkspace(owner, OWNER);
    hireId = (await api(owner, "POST", "identity/members/invite", { email: NEW.email, displayName: NEW.name, roleNames: ["Employee"], password: PASSWORD })).body.userId;
    hire = await (await browser.newContext({ viewport: { width: 1440, height: 1000 } })).newPage();
    await signIn(hire, NEW.email);
  });

  test("tasks, projects and boards are one tab; choosing a project shows its board", async () => {
    await owner.goto("/app/work");
    // Wide screens: the sidebar lists the seven destinations (Work's five areas among them); the tab bar is for phones.
    const main = owner.getByRole("navigation", { name: "Điều hướng chính" });
    await expect(main.getByRole("link")).toHaveText(["Trang chủ", "Việc", "AI", "Tài liệu", "Bảng trắng", "Lịch", "Yêu cầu", "Chấm công"]);
    await expect(main.getByRole("link", { name: "Việc" })).toHaveAttribute("aria-current", "page");
    // One title per screen: the top bar names Việc; the page's h1 says the same for screen readers only,
    // and the sections are tabs (Việc của tôi · Dự án · Mục tiêu).
    await expect(owner.getByRole("heading", { level: 1 })).toHaveText("Việc");
    await expect(owner.locator("[data-screen-title]").locator("visible=true")).toHaveText("Việc");
    const sections = owner.getByRole("navigation", { name: "Các mục của Việc" });
    await expect(sections.getByRole("link")).toHaveText(["Việc của tôi", "Dự án", "Mục tiêu"]);
    await expect(owner.getByRole("navigation", { name: "Phân mục" })).toBeHidden();
    const p = (await api(owner, "POST", "work/projects", { name: "Ra mắt app đặt lịch" })).body;
    await api(owner, "POST", "work/tasks", { title: "Thiết kế màn hình đặt lịch", projectId: p.id });
    // Dự án lists the projects; a project's board shows its crumb (Dự án › name ▾) to switch or go back.
    await owner.goto("/app/work/tasks");
    await sections.getByRole("link", { name: "Dự án" }).click();
    // Exact: until Dự án has loaded, the task list's rows also name the project ("Thiết kế … Ra mắt app đặt lịch").
    await owner.getByRole("link", { name: "Ra mắt app đặt lịch", exact: true }).first().click();
    await expect(owner.getByRole("button", { name: /^Dự án: Ra mắt app đặt lịch/ })).toBeVisible();
    await expect(sections.getByRole("link", { name: "Dự án" })).toHaveAttribute("aria-current", "page");
    await expect(owner.locator("[data-card]", { hasText: "Thiết kế màn hình đặt lịch" })).toBeVisible();
    await owner.getByRole("link", { name: "Danh sách" }).click();
    await expect(owner.getByRole("link", { name: /Thiết kế màn hình đặt lịch/ })).toBeVisible();
    // Old Kanban links still land on a board.
    await owner.goto(`/app/work/tasks?project=${p.id}`);
    await expect(owner.locator("[data-card]", { hasText: "Thiết kế màn hình đặt lịch" })).toBeVisible();
  });

  test("a meeting: agenda, minutes, AI-proposed action items become tasks", async () => {
    const start = new Date(Date.now() + 2 * 3600_000);
    const ev = (
      await api(owner, "POST", "work/calendar/events", {
        title: "Họp kick-off",
        startsAt: start.toISOString(),
        endsAt: new Date(start.getTime() + 3600_000).toISOString(),
        attendeeIds: [hireId],
        location: "Phòng 3",
      })
    ).body;
    await owner.goto("/app/work/calendar?view=meetings");
    // The next meeting leads the tab, with a way to write its agenda.
    await expect(owner.getByRole("region", { name: "Cuộc họp tiếp theo" }).getByRole("link", { name: "Soạn chương trình" })).toBeVisible();
    await owner.getByRole("link", { name: "Họp kick-off" }).click();
    // Meetings link by their code (H-001 in a new workspace).
    await owner.waitForURL(/\/app\/work\/meetings\/H-\d{3}$/);
    await owner.getByRole("region", { name: "Chương trình" }).getByRole("button", { name: "Viết" }).click();
    await owner.getByLabel("Nội dung chương trình").fill("1. Mục tiêu\n2. Phân công");
    await owner.getByRole("button", { name: "Lưu" }).click();
    await expect(owner.getByRole("status")).toContainText("Đã lưu chương trình");
    // The new hire co-writes the minutes.
    await hire.goto(`/app/work/meetings/${ev.code ?? ev.id}`);
    await hire.getByRole("button", { name: "Tham gia" }).first().click();
    await hire.getByRole("region", { name: "Biên bản" }).getByRole("button", { name: "Viết" }).click();
    await hire.getByLabel("Nội dung biên bản").fill(`Chốt ra mắt bản beta vào 20/11\n${NEW.name} cần chuẩn bị tài liệu hướng dẫn trước 15/11`);
    await hire.getByRole("button", { name: "Lưu" }).click();
    await expect(hire.getByRole("status")).toContainText("Đã lưu biên bản");
    await owner.reload();
    await owner.getByRole("button", { name: "AI trích việc từ biên bản" }).click();
    const prop = owner.getByLabel("Đề xuất từ AI");
    await expect(prop).toContainText(/chuẩn bị tài liệu hướng dẫn/i);
    await prop.getByRole("button", { name: "Tạo việc" }).first().click();
    const item = owner
      .getByRole("region", { name: /Việc sau họp/ })
      .getByRole("listitem")
      .filter({ hasText: "Chuẩn bị tài liệu hướng dẫn" });
    await expect(item.getByTitle(NEW.name)).toBeVisible(); // assigned to the new hire by name (avatar title)
    await owner.getByLabel("Việc mới sau họp").fill("Đặt phòng cho buổi ra mắt");
    await owner.getByRole("button", { name: "Thêm", exact: true }).click();
    await expect(owner.getByRole("link", { name: "Đặt phòng cho buổi ra mắt" })).toBeVisible();
    if (SHOTS) await owner.screenshot({ path: `${SHOTS}/meeting.png`, fullPage: true });
    await expect(
      owner
        .getByRole("region", { name: /Người tham gia/ })
        .getByRole("listitem")
        .filter({ hasText: NEW.name }),
    ).toContainText("Tham gia");
  });

  test("a thread links to its project and moves the project deadline; projects can be edited and archived", async () => {
    const p = (await api(owner, "POST", "work/projects", { name: "Chiến dịch quý 4" })).body;
    // #general is provisioned asynchronously when the workspace is created.
    const general = async () => (await api(owner, "GET", "chat/channels")).body.channels.find((c: { name: string }) => c.name === "general")?.id as string | undefined;
    await expect.poll(general, { timeout: 30_000 }).toBeTruthy();
    const ch = (await general())!;
    const root = (await api(owner, "POST", `chat/channels/${ch}/messages`, { body: "Mình dời hạn chiến dịch sang 18/10 nhé" })).body;
    await owner.goto(`/app/chat/${ch}?m=${root.id}`);
    const thread = owner.getByLabel("Luồng thảo luận", { exact: true });
    await thread.getByRole("button", { name: "Gắn dự án/tài liệu" }).click();
    await thread.getByRole("button", { name: /^Chọn dự án hoặc tài liệu/ }).click();
    await thread.getByRole("option", { name: "Chiến dịch quý 4" }).click();
    await thread.getByRole("button", { name: "Gắn", exact: true }).click();
    await thread.getByRole("button", { name: /Dời hạn dự án Chiến dịch quý 4 sang 18\/10/ }).click();
    await expect(thread.getByRole("status")).toContainText("Đã dời hạn");
    await owner.goto(`/app/work/projects/${p.id}`);
    await expect(owner.getByText(/Hạn .*18/)).toBeVisible();
    await expect(owner.getByText(/thống nhất trong (thread|luồng) chat/i)).toBeVisible();
    await owner.getByRole("button", { name: "Sửa dự án" }).click();
    await owner.getByRole("dialog").getByLabel("Tên dự án").fill("Chiến dịch quý 4 (mở rộng)");
    await owner.getByRole("dialog").getByRole("button", { name: "Lưu" }).click();
    await expect(owner.getByRole("heading", { level: 1 })).toContainText("mở rộng");
    owner.once("dialog", (d) => void d.accept());
    await owner.getByRole("button", { name: "Thao tác khác với dự án" }).click();
    await owner.getByRole("menuitem", { name: "Lưu trữ" }).click();
    // The project's code line says it is archived (the name itself stays as it was).
    await expect(owner.getByText("(đã lưu trữ)")).toBeVisible();
    await owner.goto("/app/work/tasks?view=projects&archived=1");
    await expect(owner.getByText("Chiến dịch quý 4 (mở rộng)")).toBeVisible();
  });

  test("a weekly meeting series: one invitation, every week on the calendar, cancel the rest", async () => {
    await owner.goto("/app/work/calendar");
    await owner.getByRole("button", { name: "Tạo lịch" }).click();
    const dlg = owner.getByRole("dialog", { name: "Tạo lịch" });
    await dlg.getByLabel("Tiêu đề").fill("Giao ban thứ Hai");
    const pad = (n: number) => String(n).padStart(2, "0");
    const first = new Date(Date.now() + 86400_000);
    first.setHours(9, 0, 0, 0);
    const local = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const pick = async (label: string, ymd: string) => {
      await dlg.getByRole("button", { name: new RegExp(`^${label}`) }).click();
      const cell = dlg.locator(`[data-day="${ymd}"]`);
      for (let i = 0; i < 24 && !(await cell.isVisible()); i++) {
        const shown = await dlg.locator("[data-day]").first().getAttribute("data-day");
        await dlg.getByRole("button", { name: shown! < ymd ? "Tháng sau" : "Tháng trước" }).click();
      }
      await cell.click();
    };
    await pick("Ngày", local(first));
    for (const [label, time] of [
      ["Từ", "09:00"],
      ["Đến", "09:30"],
    ]) {
      await dlg.getByRole("button", { name: label, exact: true }).click();
      await dlg.getByRole("option", { name: time, exact: true }).click();
    }
    await dlg.getByRole("button", { name: "Lặp lại" }).click();
    await dlg.getByRole("option", { name: "Hằng tuần" }).click();
    await pick("Đến ngày", local(new Date(first.getTime() + 8 * 86400_000)));
    await dlg.getByLabel("Tìm người").fill(NEW.name);
    await dlg.getByRole("option", { name: new RegExp(NEW.name) }).click();
    if (SHOTS) await owner.screenshot({ path: `${SHOTS}/calendar-recurring.png` });
    await dlg.getByRole("button", { name: "Tạo và gửi lời mời" }).click();
    await expect(dlg).toHaveCount(0);
    // The calendar opens on the week; the agenda lists both meetings of the next 14 days.
    await owner.getByRole("radio", { name: "Danh sách", exact: true }).click();
    const rows = owner.getByRole("listitem").filter({ hasText: "Giao ban thứ Hai" });
    await expect(rows).toHaveCount(2); // this week and next, both within the 14-day agenda
    await expect(rows.first()).toContainText("hằng tuần");

    // The invitee gets one invitation for the whole series, not one per week.
    await expect
      .poll(async () => (await api(hire, "GET", "home/notifications")).body.updates.filter((n: { title: string }) => n.title.includes("Giao ban thứ Hai")).length, {
        timeout: 30_000,
      })
      .toBe(1);
    expect((await api(hire, "GET", "home/notifications")).body.updates.find((n: { title: string }) => n.title.includes("Giao ban thứ Hai")).title).toBe(
      "Lời mời họp hằng tuần: Giao ban thứ Hai",
    );

    // Each meeting of the series links to the previous and next one.
    await rows.first().getByRole("button", { name: "Giao ban thứ Hai" }).click();
    const series = owner.getByRole("navigation", { name: "Các buổi trong chuỗi" });
    await expect(series).toContainText("Hằng tuần");
    await expect(series).toContainText("Buổi đầu tiên");
    await series.getByRole("link", { name: /Buổi sau/ }).click();
    await expect(owner.getByRole("navigation", { name: "Các buổi trong chuỗi" }).getByRole("link", { name: /Buổi trước/ })).toBeVisible();
    await owner.goto("/app/work/calendar");
    await rows.first().getByRole("button", { name: "Huỷ lịch" }).click();
    const cancel = owner.getByRole("dialog", { name: /Huỷ "Giao ban thứ Hai"/ });
    await expect(cancel).toContainText("lịch lặp lại");
    await cancel.getByRole("button", { name: "Buổi này và các buổi sau" }).click();
    await expect(rows).toHaveCount(0);
    await owner.reload();
    await expect(owner.getByRole("listitem").filter({ hasText: "Giao ban thứ Hai" })).toHaveCount(0);
  });

  test("a task comment @mentions a colleague, who is notified; the owner reads names, not ids", async () => {
    const t = (await api(owner, "POST", "work/tasks", { title: "Duyệt hợp đồng thuê văn phòng" })).body;
    await owner.goto(`/app/work/tasks/${t.id}`);
    const box = owner.getByLabel("Bình luận", { exact: true });
    await box.fill(`<@${hireId}> xem giúp điều khoản 4 nhé`);
    // Comments are longer text: Enter adds a line, Ctrl/⌘+Enter posts.
    await box.press("Control+Enter");
    await expect(owner.getByText(`@${NEW.name} xem giúp điều khoản 4 nhé`)).toBeVisible();
    await expect
      .poll(
        async () =>
          (await api(hire, "GET", "home/notifications")).body.action.some((n: { kind: string; url: string }) => n.kind === "task.mention" && n.url === `/app/work/tasks/${t.id}`),
        { timeout: 30_000 },
      )
      .toBe(true);
    // The author edits it in place (the mention stays a mention), then deletes it; the history keeps only a line.
    await owner.getByRole("button", { name: "Thao tác với bình luận" }).click();
    await owner.getByRole("menuitem", { name: "Sửa" }).click();
    const edit = owner.getByLabel("Sửa bình luận");
    await expect(edit).toHaveValue(`@${NEW.name} xem giúp điều khoản 4 nhé`);
    await edit.fill(`@${NEW.name} xem giúp điều khoản 4 và 5 nhé`);
    await edit.press("Control+Enter");
    await expect(owner.getByText(`@${NEW.name} xem giúp điều khoản 4 và 5 nhé`)).toBeVisible();
    await expect(owner.getByText("(đã sửa)")).toBeVisible();
    await owner.reload();
    await expect(owner.getByText(`@${NEW.name} xem giúp điều khoản 4 và 5 nhé`)).toBeVisible();
    owner.once("dialog", (d) => void d.accept());
    await owner.getByRole("button", { name: "Thao tác với bình luận" }).click();
    await owner.getByRole("menuitem", { name: "Xoá" }).click();
    await expect(owner.getByText("xem giúp điều khoản 4 và 5")).toHaveCount(0);
    // The task's history (its own tab beside the comments) keeps a line of it.
    await owner.reload();
    await owner.getByRole("tab", { name: /^Lịch sử/ }).click();
    await expect(owner.getByText("đã xoá một bình luận")).toBeVisible();
  });

  test("document history: compare an old version with the current text and restore it", async () => {
    const d = (await api(owner, "POST", "work/docs", { title: "Quy chế làm việc", content: "# Quy chế\nGiờ làm: 8h–17h", visibility: "workspace" })).body;
    await api(owner, "PUT", `work/docs/${d.id}`, { content: "# Quy chế\nGiờ làm: 9h–18h", baseVersion: 1 });
    await owner.goto(`/app/work/docs/${d.id}`);
    await owner.getByRole("button", { name: "Thêm thao tác" }).click();
    await owner.getByRole("menuitem", { name: "Lịch sử phiên bản" }).click();
    const drawer = owner.getByRole("dialog", { name: "Lịch sử phiên bản" });
    await expect(drawer.getByRole("button", { name: /Phiên bản 2 · hiện tại/ })).toBeVisible();
    await drawer.getByRole("button", { name: /Phiên bản 1/ }).click();
    const diff = drawer.getByLabel("So sánh");
    await expect(diff).toContainText("− Giờ làm: 8h–17h");
    await expect(diff).toContainText("+ Giờ làm: 9h–18h");
    if (SHOTS) await owner.screenshot({ path: `${SHOTS}/doc-history.png` });
    await drawer.getByRole("button", { name: "Khôi phục phiên bản này" }).click();
    await expect(owner.getByRole("status").filter({ hasText: "Đã khôi phục" })).toContainText(/Đã khôi phục,? thành phiên bản 3/);
    await expect(owner.getByRole("article", { name: "Quy chế làm việc" })).toContainText("Giờ làm: 8h–17h");
    await owner.reload();
    await expect(owner.getByRole("article", { name: "Quy chế làm việc" })).toContainText("Giờ làm: 8h–17h");
  });

  test("a project's tasks export to CSV for reporting", async () => {
    const pr = (await api(owner, "POST", "work/projects", { name: "Báo cáo CSV" })).body;
    await api(owner, "POST", "work/tasks", { title: "=SUM(A1) không phải công thức", projectId: pr.id, assigneeId: hireId, priority: "high" });
    await owner.goto(`/app/work/projects/${pr.id}`);
    await owner.getByRole("button", { name: "Thao tác khác với dự án" }).click();
    const [download] = await Promise.all([owner.waitForEvent("download"), owner.getByRole("menuitem", { name: "Xuất CSV" }).click()]);
    expect(download.suggestedFilename()).toMatch(new RegExp(`^${pr.code}-viec-\\d{4}-\\d{2}-\\d{2}\\.csv$`));
    const csv = Buffer.concat(await (await download.createReadStream()).toArray()).toString("utf8");
    expect(csv).toContain('"Mã","Tiêu đề","Cột","Trạng thái"');
    expect(csv).toContain('"\'=SUM(A1) không phải công thức"');
    expect(csv).toContain(NEW.name);
    expect(csv).toContain('"Cao"');
  });
});
