import { expect, test, type Page } from "@playwright/test";
import { axe, setupWorkspace } from "./helpers";

async function proxy(page: Page, method: string, path: string, body?: unknown) {
  const r = await page.request.fetch(`/api/proxy/${path}`, { method, headers: { "content-type": "application/json", "x-wos-csrf": "1" }, ...(body ? { data: body } : {}) });
  expect(r.ok(), `${method} ${path} → ${r.status()}`).toBe(true);
  return r.json();
}

/**
 * Following up without Tiến độ: Home's week card leads to AI › Tiến độ, what the manager handed out is Việc › Việc
 * tôi giao.
 */
test("a manager follows what they assigned", async ({ page }) => {
  test.setTimeout(120_000);
  const run = Date.now().toString(36);
  await setupWorkspace(page, { company: `Follow ${run}`, name: "Trần CEO", email: `follow-${run}@example.com` });

  const lan = await proxy(page, "POST", "identity/members/invite", { email: `lan-${run}@example.com`, displayName: "Nguyễn Lan", password: "Passw0rd!dev" });
  // The member reaches the employee directory through an event; wait for it.
  await expect
    .poll(async () => (await proxy(page, "GET", "employee/employees")).employees.some((e: { userId: string }) => e.userId === lan.userId), { timeout: 30_000 })
    .toBe(true);
  const project = await proxy(page, "POST", "work/projects", { name: "Ra mắt" });
  await proxy(page, "POST", "work/tasks", { title: "Landing page ra mắt", projectId: project.id, assigneeId: lan.userId, dueAt: "2024-01-02T09:00:00+07:00" });
  await proxy(page, "POST", "work/tasks", { title: "Bảng giá mới", projectId: project.id, assigneeId: lan.userId });

  // Home's team tile counts the late work (its big figure) and links to AI › Tiến độ.
  await page.goto("/app/home");
  const team = page.getByRole("region", { name: /^(Đội của bạn|Công ty)$/ });
  await expect(team.getByRole("link", { name: "1", exact: true })).toHaveAttribute("href", "/app/ai/progress");

  // What I handed out: Việc của tôi › Tôi giao.
  await page.goto("/app/work/tasks?scope=owned");
  await expect(page.getByRole("link", { name: /Landing page ra mắt/ }).first()).toBeVisible();
  await expect(page.getByRole("link", { name: /Bảng giá mới/ }).first()).toBeVisible();
  await axe(page, "owned tasks");

  // The old Tiến độ › Đội ngũ link lands on AI › Tiến độ.
  await page.goto("/app/work?tab=team");
  await expect(page).toHaveURL(/\/app\/ai\/progress/);
});
