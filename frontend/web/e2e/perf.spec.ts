import { expect, test, type Page } from "@playwright/test";
import { resetTestDatabase, setupWorkspace } from "./helpers";

/** Lab measurement of Core Web Vitals on the production build (RUM covers real users). */
// A dev server compiles on demand and ships unminified JS, so its numbers mean nothing here:
// run with E2E_BASE_URL pointing at `next start`.
test.skip(!process.env.E2E_BASE_URL, "Core Web Vitals budgets apply to a production build (set E2E_BASE_URL)");

async function vitals(page: Page) {
  return page.evaluate(
    () =>
      new Promise<{ ttfb: number; fcp: number; lcp: number; cls: number; jsKb: number }>((resolve) => {
        let lcp = 0;
        let cls = 0;
        new PerformanceObserver((l) => {
          for (const e of l.getEntries()) lcp = e.startTime;
        }).observe({ type: "largest-contentful-paint", buffered: true });
        new PerformanceObserver((l) => {
          for (const e of l.getEntries() as (PerformanceEntry & { value: number; hadRecentInput: boolean })[]) if (!e.hadRecentInput) cls += e.value;
        }).observe({ type: "layout-shift", buffered: true });
        setTimeout(() => {
          const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming;
          const fcp = performance.getEntriesByName("first-contentful-paint")[0]?.startTime ?? 0;
          const js = performance
            .getEntriesByType("resource")
            .filter((r) => r.name.endsWith(".js"))
            .reduce((n, r) => n + (r as PerformanceResourceTiming).transferSize, 0);
          resolve({ ttfb: Math.round(nav.responseStart), fcp: Math.round(fcp), lcp: Math.round(lcp), cls: Math.round(cls * 1000) / 1000, jsKb: Math.round(js / 1024) });
        }, 1500);
      }),
  );
}

for (const path of ["/login", "/setup", "/forgot-password"]) {
  test(`sign-in page ${path} meets Core Web Vitals budgets`, async ({ page }) => {
    // /setup only renders while the installation has no workspace.
    if (path === "/setup") await resetTestDatabase();
    await page.goto(path);
    const v = await vitals(page);
    console.log(`PERF ${path} ${JSON.stringify(v)}`);
    expect(v.lcp).toBeLessThan(2500);
    expect(v.cls).toBeLessThan(0.1);
    expect(v.ttfb).toBeLessThan(800);
  });
}

test("authenticated Home meets budgets", async ({ page }) => {
  const run = Date.now().toString(36);
  await setupWorkspace(page, { company: `Perf ${run}`, name: "Perf User", email: `perf-${run}@example.com` });
  // Each screen at its own address: /app/work only sends the browser on to /app/work/tasks, and a page that
  // navigates away cannot be measured.
  for (const path of ["/app/home", "/app/work/tasks", "/app/chat"]) {
    await page.goto(path);
    const v = await vitals(page);
    console.log(`PERF ${path} ${JSON.stringify(v)}`);
    expect(v.lcp).toBeLessThan(2500);
    expect(v.cls).toBeLessThan(0.1);
  }
});
