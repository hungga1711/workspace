import { expect, test } from "@playwright/test";
import { setupWorkspace } from "./helpers";

/**
 * The seven-destination navigation: every old Work link still lands on the right place, and
 * the sidebar lights the destination it belongs to. Conversations are listed under it, not a destination.
 */
test("old Work links land on the new destinations, and the sidebar lights the right one", async ({ page }) => {
  test.setTimeout(150_000);
  const run = Date.now().toString(36);
  await page.setViewportSize({ width: 1440, height: 900 });
  await setupWorkspace(page, { company: `Nav ${run}`, name: "Lê Minh", email: `nav-${run}@example.com` });

  const main = page.getByRole("navigation", { name: "Điều hướng chính" });
  await page.goto("/app/home");
  await expect(main.getByRole("link")).toHaveText(["Trang chủ", "Việc", "AI", "Tài liệu", "Bảng trắng", "Lịch", "Yêu cầu", "Chấm công"]);

  // [old link, sidebar destination, page title, Việc tab (if any)]
  const cases: [string, string, string, string | null][] = [
    ["/app/work", "Việc", "Việc", null],
    ["/app/work?tab=kanban", "Việc", "Việc", null],
    ["/app/work?tab=projects", "Việc", "Việc", null],
    ["/app/work?tab=tasks&scope=owned", "Việc", "Việc", "Việc của tôi"],
    ["/app/work?tab=goals", "Việc", "Việc", "Mục tiêu"],
    ["/app/work?tab=docs", "Tài liệu", "Tài liệu", null],
    ["/app/work?tab=files", "Tài liệu", "Tài liệu", null],
    ["/app/work?tab=calendar", "Lịch", "Lịch", null],
    ["/app/work?tab=meetings", "Lịch", "Lịch", null],
    ["/app/work?tab=ops", "Yêu cầu", "Yêu cầu", null],
    ["/app/work?tab=approvals", "Yêu cầu", "Yêu cầu", null],
  ];
  for (const [url, dest, title, tab] of cases) {
    await page.goto(url);
    // Each tab has its own address now (/app/work/calendar…); an old ?tab= link moves there.
    await expect(page, url).toHaveURL(/\/app\/work\/(tasks|goals|docs|calendar|ops)(\?|$)/);
    await expect(main.getByRole("link", { name: dest, exact: true }), url).toHaveAttribute("aria-current", "page");
    // One title per screen: the top bar names the destination; the page's h1 repeats it for screen readers only.
    await expect(page.locator("[data-screen-title]").locator("visible=true"), url).toHaveText(title);
    await expect(page.getByRole("heading", { level: 1 }), url).toHaveText(title);
    if (tab) await expect(page.getByRole("navigation", { name: "Các mục của Việc" }).getByRole("link", { name: tab, exact: true }), url).toHaveAttribute("aria-current", "page");
  }

  // Work's retired progress tabs land on AI › Tiến độ.
  for (const url of ["/app/work?tab=overview", "/app/work?tab=team", "/app/work?tab=theo-doi"]) {
    await page.goto(url);
    await expect(page, url).toHaveURL(/\/app\/ai\/progress/);
  }

  // No "Hộp thư" in the sidebar any more; the chat views name themselves in the top bar ("Tin nhắn").
  await expect(main.getByRole("link", { name: "Hộp thư" })).toHaveCount(0);
  await page.goto("/app/chat/unreads");
  await expect(page.getByRole("banner").getByText("Tin nhắn", { exact: true }).locator("visible=true")).toBeVisible();

  // Hồ sơ của tôi is in the account menu (the avatar in the top bar).
  await page.getByRole("button", { name: /^Tài khoản: / }).click();
  await page.getByRole("menuitem", { name: "Hồ sơ của tôi" }).click();
  await page.waitForURL(/\/app\/me/);
});
