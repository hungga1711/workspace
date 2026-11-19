import AxeBuilder from "@axe-core/playwright";
import { expect, type Locator, type Page } from "@playwright/test";
import { resetTestDatabase as reset } from "../../../tooling/scripts/test-db.mjs";

/** Empties the test installation's database (tooling/scripts/test-db.mjs). */
export const resetTestDatabase = reset as () => Promise<void>;

/** The password accounts in the suite are created with. */
export const PASSWORD = "Passw0rd!dev";

export interface Owner {
  company: string;
  name: string;
  email: string;
}

/**
 * First-run setup: empties the test installation (one workspace per installation, ADR 0005), then creates the
 * workspace and its owner, who lands signed in on /app/welcome.
 */
export async function setupWorkspace(page: Page, owner: Owner, password = PASSWORD) {
  await resetTestDatabase();
  await page.goto("/setup");
  await page.getByLabel("Tên công ty").fill(owner.company);
  await page.getByLabel("Họ tên của bạn").fill(owner.name);
  await page.getByLabel("Email công việc").fill(owner.email);
  await page.getByLabel("Mật khẩu").fill(password);
  await page.getByRole("button", { name: "Tạo không gian làm việc" }).click();
  await page.waitForURL(/\/app\/welcome/);
}

/** Signs in through the login form and waits for the app. */
export async function signIn(page: Page, email: string, password = PASSWORD) {
  await page.goto(`/login?email=${encodeURIComponent(email)}`);
  await page.getByLabel("Mật khẩu").fill(password);
  await page.getByRole("button", { name: "Đăng nhập" }).click();
  await page.waitForURL(/\/app\/(home|welcome)/);
}

/** Calls the BFF through its same-origin proxy with the page's session cookie. */
export async function api(page: Page, method: string, path: string, body?: unknown) {
  const r = await page.request.fetch(`/api/proxy/${path}`, { method, headers: { "content-type": "application/json", "x-wos-csrf": "1" }, ...(body ? { data: body } : {}) });
  return { status: r.status(), body: await r.json().catch(() => null) };
}

/** WCAG 2.2 AA check of what is on screen: serious and critical violations fail, the rest are logged. */
export async function axe(page: Page, label: string) {
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
  const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).exclude("video").analyze();
  for (const v of r.violations) console.log(`A11Y ${label} ${v.id} (${v.impact}): ${v.nodes.length} nodes · ${v.nodes[0]?.target.join(" ")}`);
  expect(r.violations.filter((v) => v.impact === "serious" || v.impact === "critical")).toEqual([]);
}

/**
 * Presses one of a chat message's hover actions. The bar shows while the pointer is over the message, and the
 * message can move under a still pointer (a "Tin mới" divider, a suggestion chip, the sent copy replacing the
 * pending one), so hover and press are tried together until the press lands.
 */
export async function messageAction(message: Locator, name: string) {
  const button = message.getByRole("button", { name });
  await expect(async () => {
    await message.hover();
    await button.click({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
}
