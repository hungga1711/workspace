import { expect, test } from "@playwright/test";
import { axe, setupWorkspace } from "./helpers";
/** Work › Lịch › Đồng bộ lịch: a private .ics link that Google Calendar, Outlook and Apple can subscribe to. */
test("a private calendar link serves my meetings as iCalendar and can be revoked", async ({ page }) => {
  const run = Date.now().toString(36);
  await setupWorkspace(page, { company: `Cal ${run}`, name: "Đỗ Minh", email: `cal-${run}@example.com` });
  const start = new Date(Date.now() + 86400_000);
  const me = (await (await page.request.get("/api/proxy/identity/members", { headers: { "x-wos-csrf": "1" } })).json()).members[0].userId;
  await page.request.post("/api/proxy/work/calendar/events", {
    headers: { "x-wos-csrf": "1" },
    data: { title: "Họp giao ban", startsAt: start.toISOString(), endsAt: new Date(start.getTime() + 3600_000).toISOString(), attendeeIds: [me] },
  });

  await page.goto("/app/work/calendar");
  await page.getByRole("button", { name: "Đồng bộ lịch" }).click();
  const dialog = page.getByRole("dialog", { name: "Đồng bộ sang Google Calendar, Outlook hoặc Apple" });
  await dialog.getByRole("button", { name: "Tạo link riêng" }).click();
  const link = await dialog.getByLabel("Link lịch riêng").inputValue();
  expect(link).toMatch(/\/cal\/[A-Za-z0-9_-]+\.ics$/);
  await expect(dialog.getByRole("link", { name: "Thêm vào Google Calendar" })).toHaveAttribute("href", /calendar\.google\.com\/calendar\/r\?cid=webcal/);

  await axe(page, "calendar sync");
  const ics = await page.request.get(link);
  expect(ics.headers()["content-type"]).toContain("text/calendar");
  const body = await ics.text();
  expect(body).toContain("BEGIN:VCALENDAR");
  expect(body).toContain("SUMMARY:Họp giao ban");

  await dialog.getByRole("button", { name: "Tắt đồng bộ" }).click();
  await expect(dialog.getByRole("button", { name: "Tạo link riêng" })).toBeVisible();
  expect((await page.request.get(link)).status()).toBe(404);
});
