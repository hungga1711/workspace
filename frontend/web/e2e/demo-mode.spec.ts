import { expect, test } from "@playwright/test";

/**
 * The public demo (infra/demo): only against a server started with DEMO_MODE=1 and the demo seed, e.g.
 *   E2E_DEMO=1 E2E_BASE_URL=https://demo.workspace.dev npx playwright test demo-mode
 * Outside the demo the quick sign-in must not exist at all.
 */
const demo = process.env.E2E_DEMO === "1";

test("without demo mode there is no banner and no quick sign-in", async ({ page }) => {
  test.skip(demo, "runs against a normal install");
  await page.goto("/login");
  await expect(page.getByTestId("demo-signin")).toHaveCount(0);
  const r = await page.request.post("/api/auth/demo", { data: { as: "owner" } });
  expect(r.status()).not.toBe(200);
});

test("demo: quick sign-in per role, the banner on every page, locked admin actions", async ({ page }) => {
  test.skip(!demo, "needs a DEMO_MODE=1 server (E2E_DEMO=1)");
  test.setTimeout(90_000);
  await page.goto("/login");
  await expect(page.getByTestId("demo-signin")).toBeVisible();

  await page.getByTestId("demo-as-owner").click();
  await page.waitForURL(/\/app\/ai\/adoption\/usage/);
  await expect(page.getByTestId("demo-banner")).toBeVisible();
  await page.goto("/admin/workspace");
  await expect(page.getByTestId("demo-banner")).toBeVisible();

  // An API key is a credential handed out to strangers: refused server-side, with the demo's message.
  const locked = await page.evaluate(async () => {
    const r = await fetch("/api/proxy/identity/api-keys", {
      method: "POST",
      headers: { "content-type": "application/json", "x-wos-csrf": "1" },
      body: JSON.stringify({ name: "demo", permissions: ["task.read"] }),
    });
    return { status: r.status, body: await r.json() };
  });
  expect(locked.status).toBe(403);
  expect(locked.body.error).toBe("demo_locked");

  await page.context().clearCookies();
  await page.goto("/login");
  await page.getByTestId("demo-as-staff").click();
  await page.waitForURL(/\/app\/me\?tab=ai/);
  await expect(page.getByTestId("demo-banner")).toBeVisible();
});
