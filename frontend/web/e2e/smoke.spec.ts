import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { setupWorkspace } from "./helpers";

const PAGES = [
  ...[
    "home",
    "work",
    "work?tab=approvals",
    "work?tab=docs",
    "work?tab=files",
    "work?tab=meetings",
    "work?tab=ops",
    "work?tab=docs&view=files",
    "chat",
    "chat/browse",
    "chat/mentions",
    "chat/saved",
    "chat/threads",
    "me",
    "me/people",
    "search?q=test",
  ].map((p) => `/app/${p}`),
  ...[
    "",
    "/agents",
    "/announcements",
    "/attendance",
    "/audit",
    "/holidays",
    "/integrations",
    "/leave",
    "/members",
    "/roles",
    "/security",
    "/settings",
    "/teams",
    "/custom-fields",
  ].map((p) => `/admin/workspace${p}`),
];

/** Every app and admin page loads with no console errors, failed requests or serious a11y issues. */
test("every app and admin page loads cleanly", async ({ page }) => {
  test.setTimeout(240_000);
  const problems: string[] = [];
  page.on("console", (m) => {
    // A navigation started while a prefetch is in flight logs this; it is not a page error.
    if (m.type() === "error" && !m.text().includes("Failed to fetch RSC payload")) problems.push(`${page.url()} console: ${m.text().slice(0, 200)}`);
  });
  page.on("pageerror", (e) => problems.push(`${page.url()} pageerror: ${e.message.slice(0, 200)}`));
  page.on("response", (r) => {
    if (r.status() >= 400 && !r.url().includes("/_next/")) problems.push(`${page.url()} ${r.status()} ${r.url()}`);
  });

  const run = Date.now().toString(36);
  await setupWorkspace(page, { company: `Smoke ${run}`, name: "Smoke User", email: `smoke-${run}@example.com` });

  for (const path of PAGES) {
    await page.goto(path);
    await page.waitForLoadState("networkidle").catch(() => undefined);
    await expect(page, path).not.toHaveTitle(/^workspace$/); // every page names itself in the tab
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
    const a11y = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
    for (const v of a11y.violations) if (v.impact === "serious" || v.impact === "critical") problems.push(`${path} a11y ${v.id}: ${v.nodes[0]?.target.join(" ")}`);
  }
  expect(problems).toEqual([]);
});
