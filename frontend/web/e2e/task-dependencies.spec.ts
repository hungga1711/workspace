import { expect, test } from "@playwright/test";
import { setupWorkspace } from "./helpers";

/** Task page: start date and Gantt links (what must finish first, what waits on this task). */
test("the task page sets a start date and adds and removes a dependency", async ({ page }) => {
  test.setTimeout(120_000);
  const run = Date.now().toString(36);
  await setupWorkspace(page, { company: `Deps ${run}`, name: "Lê Minh", email: `deps-${run}@example.com` });
  const h = { headers: { "x-wos-csrf": "1" } };
  const project = await (await page.request.post("/api/proxy/work/projects", { ...h, data: { name: "Ra mắt" } })).json();
  const mk = async (title: string) => (await page.request.post("/api/proxy/work/tasks", { ...h, data: { title, projectId: project.id } })).json();
  const api = await mk("Viết API");
  const ui = await mk("Làm giao diện");
  const qa = await mk("Kiểm thử");
  await page.request.post(`/api/proxy/work/tasks/${qa.id}/dependencies`, { ...h, data: { predecessorId: ui.id } });

  await page.goto(`/app/work/tasks/${ui.id}`);
  const deps = page.getByRole("region", { name: "Phụ thuộc" });
  // QA waits on this task.
  await expect(deps.getByText("Đang chờ việc này")).toBeVisible();
  await expect(deps.getByRole("link", { name: "Kiểm thử" })).toBeVisible();

  // Add: the API must finish first.
  const add = async (label: string) => {
    await deps.getByRole("button", { name: "+ Thêm việc phải xong trước…" }).click();
    await deps.getByRole("option", { name: label }).click();
  };
  await add(`${api.code} · Viết API`);
  await expect(deps.getByRole("link", { name: "Viết API" })).toBeVisible();

  // A loop is refused: QA cannot be a predecessor of its own predecessor.
  await add(`${qa.code} · Kiểm thử`);
  await expect(deps.getByRole("alert")).toBeVisible();

  // Start date saves.
  await page.getByRole("button", { name: /^Bắt đầu/ }).click();
  const day = page.locator('[data-day="2026-11-02"]');
  for (let i = 0; i < 24 && !(await day.isVisible()); i++) {
    const shown = await page.locator("[data-day]").first().getAttribute("data-day");
    await page.getByRole("button", { name: shown! < "2026-11-02" ? "Tháng sau" : "Tháng trước" }).click();
  }
  await day.click();
  await expect.poll(async () => (await (await page.request.get(`/api/proxy/work/tasks/${ui.id}`)).json()).task.startAt as string | null).toBe("2026-11-02T02:00:00.000Z");

  // Survives a reload, then remove the link.
  await page.reload();
  await expect(deps.getByRole("link", { name: "Viết API" })).toBeVisible();
  await deps.getByRole("button", { name: `Bỏ liên kết với ${api.code}` }).click();
  await expect(deps.getByRole("link", { name: "Viết API" })).toHaveCount(0);
  await page.reload();
  await expect(deps.getByRole("link", { name: "Viết API" })).toHaveCount(0);
});
