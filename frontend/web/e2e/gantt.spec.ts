import { expect, test } from "@playwright/test";
import { setupWorkspace } from "./helpers";

/** Gantt: bars from start to due, drag to reschedule, links with broken-link warning and the one-click fix. */
test("the Gantt shows scheduled work, moves a bar by dragging and fixes a broken link", async ({ page }) => {
  test.setTimeout(180_000);
  const run = Date.now().toString(36);
  await page.setViewportSize({ width: 1600, height: 1000 });
  await setupWorkspace(page, { company: `Gantt ${run}`, name: "Lê Minh", email: `gantt-${run}@example.com` });
  const h = { headers: { "x-wos-csrf": "1" } };
  const project = await (await page.request.post("/api/proxy/work/projects", { ...h, data: { name: "Ra mắt" } })).json();
  const day = (n: number, hour: number) => {
    const d = new Date();
    d.setUTCHours(hour - 7, 0, 0, 0);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString();
  };
  const mk = async (title: string, s: number, e: number) => {
    const t = await (await page.request.post("/api/proxy/work/tasks", { ...h, data: { title, projectId: project.id } })).json();
    return (await page.request.patch(`/api/proxy/work/tasks/${t.id}`, { ...h, data: { expectedVersion: t.version, startAt: day(s, 9), dueAt: day(e, 17) } })).json();
  };
  const api = await mk("Viết API", 0, 3);
  const ui = await mk("Làm giao diện", 2, 5);
  await page.request.post("/api/proxy/work/tasks", { ...h, data: { title: "Chưa xếp lịch", projectId: project.id } });
  await page.request.post(`/api/proxy/work/tasks/${ui.id}/dependencies`, { ...h, data: { predecessorId: api.id } });

  await page.goto(`/app/work/tasks?project=${project.id}&view=gantt`);
  const bar = page.locator(`[data-gantt-task="${api.id}"] button`).first();
  await expect(bar).toBeVisible();
  await expect(page.getByText("1 việc chưa có lịch")).toBeVisible();
  // UI starts before API ends: one broken link.
  await expect(page.getByText("1 phụ thuộc bị lệch lịch")).toBeVisible();

  // Drag the API bar one day to the left (36 px per day at day zoom).
  const box = (await bar.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 - 36, box.y + box.height / 2, { steps: 6 });
  await page.mouse.up();
  await expect.poll(async () => (await (await page.request.get(`/api/proxy/work/tasks/${api.id}`, h)).json()).task.startAt).toBe(day(-1, 9).replace(".000Z", ".000Z"));

  // The fix pushes "Làm giao diện" after "Viết API".
  await page.getByRole("button", { name: "Dời các việc phụ thuộc" }).click();
  await expect(page.getByText("phụ thuộc bị lệch lịch")).toHaveCount(0);
  const moved = (await (await page.request.get(`/api/proxy/work/tasks/${ui.id}`, h)).json()).task;
  expect(Date.parse(moved.startAt)).toBeGreaterThan(Date.parse(day(2, 17)));

  // Keyboard: → moves the focused bar a day.
  await bar.focus();
  await page.keyboard.press("ArrowRight");
  await expect.poll(async () => (await (await page.request.get(`/api/proxy/work/tasks/${api.id}`, h)).json()).task.startAt).toBe(day(0, 9));
});
