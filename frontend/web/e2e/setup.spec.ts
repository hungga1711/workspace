import { expect, test } from "@playwright/test";
import { setupWorkspace } from "./helpers";

/**
 * First-run setup and the root redirect of a self-hosted installation: once the one workspace exists, /setup and
 * `/` send visitors to sign-in.
 */
const run = Date.now().toString(36);
const OWNER = { company: `Setup ${run}`, email: `setup-${run}@example.com`, name: "Phan Thu" };

test.describe.serial("first-run setup", () => {
  test("setup creates the workspace and the owner lands on welcome with the company in the sidebar", async ({ browser }) => {
    const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
    await setupWorkspace(page, OWNER);
    await expect(page.getByRole("complementary", { name: "Điều hướng" }).getByText(OWNER.company, { exact: true })).toBeVisible();

    // `/` for a signed-in person opens the app.
    await page.goto("/");
    await expect(page).toHaveURL(/\/app\/home$/);
    await page.context().close();
  });

  test("`/` and /setup for an anonymous visitor go to sign-in once the workspace exists", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveURL(/\/login$/);
    await page.goto("/setup");
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByRole("button", { name: "Đăng nhập" })).toBeVisible();
  });
});
