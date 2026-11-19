import { expect, test } from "@playwright/test";

/** Error handling: branded 404, and browser errors reach the error-tracking sink (validated, capped). */
test("unknown pages and records show a 404 in product language", async ({ page }) => {
  const r = await page.goto("/khong-ton-tai");
  expect(r?.status()).toBe(404);
  await expect(page.getByRole("heading", { name: "Không tìm thấy trang này" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Trang chủ workspace" })).toBeVisible();
});

test("the client error sink accepts well-formed reports and rejects junk", async ({ request }) => {
  expect((await request.post("/api/client-errors", { data: { message: "TypeError: x is undefined", stack: "at a.js:1", kind: "uncaught" } })).status()).toBe(204);
  expect((await request.post("/api/client-errors", { data: "not json", headers: { "content-type": "text/plain" } })).status()).toBe(400);
  expect((await request.post("/api/client-errors", { data: { message: "x".repeat(9000) } })).status()).toBe(413);
});
