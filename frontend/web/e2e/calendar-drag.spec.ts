import { expect, test } from "@playwright/test";
import { setupWorkspace } from "./helpers";

/** Calendar: week view by default, drag an event to move it, click empty time to create. */
test("the week view is the default; dragging an event moves it and clicking empty time creates one", async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1440, height: 1000 });
  const run = Date.now().toString(36);
  await setupWorkspace(page, { company: `Lich ${run}`, name: "Lê Minh", email: `lich-${run}@example.com` });
  // Today 10:00–11:00, Vietnam time.
  const day = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
  const startsAt = new Date(`${day}T10:00:00+07:00`).toISOString();
  const ev = await (
    await page.request.post("/api/proxy/work/calendar/events", {
      headers: { "x-wos-csrf": "1" },
      data: { title: "Họp kế hoạch", startsAt, endsAt: new Date(Date.parse(startsAt) + 3600_000).toISOString(), kind: "meeting" },
    })
  ).json();

  await page.goto("/app/work/calendar");
  await expect(page.getByRole("radio", { name: "Tuần", exact: true, checked: true })).toBeVisible();
  // The block in the hour grid (the "Tiếp theo" line above the calendar links to the same event).
  const block = page
    .getByRole("region", { name: "Các giờ trong tuần" })
    .getByRole("button", { name: /Họp kế hoạch/ })
    .first();
  await block.scrollIntoViewIfNeeded();
  const box = (await block.boundingBox())!;
  // Two hours down (48px per hour).
  await page.mouse.move(box.x + box.width / 2, box.y + 10);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + 40, { steps: 4 });
  await page.mouse.move(box.x + box.width / 2, box.y + 106, { steps: 8 });
  await page.mouse.up();
  await expect(page.getByRole("status").filter({ hasText: "Đã dời" })).toBeVisible();
  await expect
    .poll(async () => {
      const r = await (
        await page.request.get(`/api/proxy/work/calendar/events?from=${day}T00:00:00%2B07:00&to=${day}T23:59:00%2B07:00`, { headers: { "x-wos-csrf": "1" } })
      ).json();
      return new Date(r.events.find((e: { id: string }) => e.id === ev.id).startsAt).getTime() - Date.parse(startsAt);
    })
    .toBe(2 * 3600_000);

  // Month view shows it too; a click on empty time opens "Tạo lịch" at that time.
  await page.getByRole("radio", { name: "Tháng" }).click();
  await expect(page.getByRole("button", { name: /Họp kế hoạch/ })).toBeVisible();
  // Any entry opens in the large centred view, like a task; Esc comes back to the calendar.
  await page.getByRole("button", { name: /Họp kế hoạch/ }).click();
  const peek = page.getByRole("dialog", { name: /^Cuộc họp/ });
  await expect(peek.getByRole("heading", { name: "Họp kế hoạch" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(peek).toHaveCount(0);
  await page.getByRole("radio", { name: "Tuần", exact: true }).click();
  const col = page.getByLabel(/^Ngày /).last();
  await col.click({ position: { x: 20, y: 48 * 15 + 5 } });
  const dlg = page.getByRole("dialog", { name: "Tạo lịch" });
  await expect(dlg).toBeVisible();
  await expect(dlg.getByRole("button", { name: /^Từ:/ })).toHaveText("15:00");
});
