import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { resetTestDatabase, setupWorkspace } from "./helpers";

/** WCAG 2.2 AA automated checks. Manual screen-reader passes are still required. */
async function audit(page: Page, path: string) {
  await page.goto(path);
  await page.waitForLoadState("networkidle");
  // Measure the settled screen, not a modal halfway through its fade-in.
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        // A pulse that never ends (the clock-in dot, a step at work) never finishes: only what settles is waited for.
        .filter((a) => a.effect?.getComputedTiming().iterations !== Infinity)
        .map((a) => a.finished.catch(() => undefined)),
    ),
  );
  const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  for (const v of r.violations) console.log(`A11Y ${path} ${v.id} (${v.impact}): ${v.nodes.length} nodes · ${v.nodes[0]?.target.join(" ")}`);
  expect(r.violations.filter((v) => v.impact === "serious" || v.impact === "critical")).toEqual([]);
}

for (const path of [
  // "/" only redirects (to /login here); /setup is audited on an emptied installation below.
  "/login",
  "/setup",
  "/forgot-password",
  "/reset-password?token=x",
])
  test(`a11y ${path}`, async ({ page }) => {
    // /setup only renders while the installation has no workspace.
    if (path === "/setup") await resetTestDatabase();
    await audit(page, path);
  });

test("a11y authenticated app", async ({ page }) => {
  // About 25 pages, each compiled on first visit in dev: give it room when the whole suite runs.
  test.setTimeout(300_000);
  const run = Date.now().toString(36);
  await setupWorkspace(page, { company: `A11y ${run}`, name: "A11y User", email: `a11y-${run}@example.com` });
  for (const path of [
    "/app/welcome",
    "/app/home",
    "/app/work",
    "/app/work/tasks?view=projects",
    "/app/work/docs",
    "/app/work/docs?view=files",
    "/app/work/calendar",
    "/app/work/ops",
    "/app/me",
    "/app/me/people",
    "/app/chat",
    "/app/chat/general",
    "/app/chat/saved",
    "/app/chat/unreads",
    "/app/ai/progress",
    "/app/ai/ask",
    "/app/ai/adoption",
    "/app/ai/adoption/usage",
    "/app/work/goals",
    "/app/work/tasks?view=projects",
    "/app/me?tab=ai",
    "/admin/workspace",
    "/admin/workspace/members",
    "/admin/workspace/roles",
    "/admin/workspace/teams",
    "/admin/workspace/settings",
    "/admin/workspace/agents",
    "/admin/workspace/custom-fields",
    "/admin/workspace/audit",
    "/admin/workspace/attendance",
    "/admin/workspace/leave",
    "/admin/workspace/holidays",
    "/app/work/tasks?view=projects",
    "/app/work/calendar?view=meetings",
    "/app/search?q=test",
    "/app/me?tab=security",
    "/app/me?tab=notify",
    "/app/time",
    "/app/time?tab=attendance",
    "/app/time?tab=leave",
    "/admin/workspace/announcements",
    "/admin/workspace/integrations",
    "/admin/workspace/security",
  ])
    await audit(page, path);
});
