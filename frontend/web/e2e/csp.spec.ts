import { expect, test } from "@playwright/test";
import { setupWorkspace } from "./helpers";

/** Security headers (enterprise hardening): CSP is sent and no page we ship violates it. */
const run = Date.now().toString(36);

test("CSP and security headers are present and nothing violates the policy", async ({ page }) => {
  const violations: string[] = [];
  page.on("console", (m) => {
    if (/Content Security Policy|Refused to/.test(m.text())) violations.push(m.text());
  });
  const res = await page.goto("/");
  const h = res!.headers();
  expect(h["content-security-policy"]).toContain("frame-ancestors 'none'");
  expect(h["x-content-type-options"]).toBe("nosniff");
  await setupWorkspace(page, { company: `Csp ${run}`, name: "Kim Oanh", email: `csp-${run}@example.com` });
  for (const path of ["/app/home", "/app/chat", "/app/work", "/app/work/tasks", "/app/me", "/app/time", "/admin/workspace", "/app/search?q=test"]) {
    await page.goto(path);
    await page.waitForLoadState("networkidle");
  }
  expect(violations).toEqual([]);
});
