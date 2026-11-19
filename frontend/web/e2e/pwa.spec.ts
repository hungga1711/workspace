import { expect, test } from "@playwright/test";

/** Installable web app: manifest, icons in the brand mark, light theme colour. */
test("the app is installable: manifest, icons and theme colour", async ({ page, request }) => {
  await page.goto("/login");
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute("href", "/manifest.webmanifest");
  await expect(page.locator('link[rel="icon"]').first()).toHaveAttribute("href", /\/icon/);
  await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveCount(1);
  // One theme colour per colour scheme (the top bar's surface in light and dark).
  await expect(page.locator('meta[name="theme-color"][media="(prefers-color-scheme: light)"]')).toHaveAttribute("content", "#ffffff");
  await expect(page.locator('meta[name="theme-color"][media="(prefers-color-scheme: dark)"]')).toHaveAttribute("content", "#171717");
  const m = await (await request.get("/manifest.webmanifest")).json();
  expect(m).toMatchObject({ name: "workspace", start_url: "/app/home", display: "standalone", lang: "vi", theme_color: "#ffffff" });
  for (const icon of m.icons as { src: string; sizes: string }[]) {
    const r = await request.get(icon.src);
    expect(r.status(), icon.src).toBe(200);
    expect(r.headers()["content-type"]).toBe("image/png");
  }
  expect((await request.get("/pwa-icon/64")).status()).toBe(404);
});

// Playwright's setOffline does not reach requests a service worker makes, so a real offline
// navigation cannot be simulated here; check what the worker guarantees instead.
test("offline: the worker controls pages and has the offline page cached (production build only)", async ({ page, request }) => {
  await page.goto("/login");
  const hasSw = await page.evaluate(async () => {
    if (!("serviceWorker" in navigator)) return false;
    for (let i = 0; i < 20 && !(await navigator.serviceWorker.getRegistrations()).length; i++) await new Promise((r) => setTimeout(r, 250));
    return (await navigator.serviceWorker.getRegistrations()).length > 0;
  });
  test.skip(!hasSw, "the service worker registers in production builds only");
  await page.reload();
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
  await expect.poll(() => page.evaluate(async () => !!(await caches.match("/offline.html")))).toBe(true);
  const offline = await request.get("/offline.html");
  expect(offline.ok()).toBe(true);
  expect(await offline.text()).toContain("Bạn đang ngoại tuyến");
});
