import { expect, test, type Browser, type Page } from "@playwright/test";
import { PASSWORD, setupWorkspace } from "./helpers";

/**
 * Privacy of AI oversight: a manager sees only their reporting line, never a peer's team; someone with
 * no reports gets the explanation, not data; nobody, admins included, reads another person's prompts.
 */
const run = Date.now().toString(36);
const api = (p: Page, path: string, method = "GET", data?: unknown) =>
  p.request.fetch(`/api/proxy/${path}`, { method, headers: { "x-wos-csrf": "1" }, ...(data === undefined ? {} : { data }) });
const login = async (browser: Browser, email: string) => {
  const p = await (await browser.newContext({ viewport: { width: 1440, height: 1000 } })).newPage();
  await p.goto("/login");
  await p.getByLabel("Email").fill(email);
  await p.getByLabel("Mật khẩu").fill(PASSWORD);
  await p
    .getByRole("button", { name: /Đăng nhập/ })
    .first()
    .click();
  await p.waitForURL(/\/app\//);
  return p;
};

test("a manager sees only their own team's AI use", async ({ browser }) => {
  test.setTimeout(240_000);
  const owner = await (await browser.newContext()).newPage();
  await setupWorkspace(owner, { company: `Scope ${run}`, name: "Trần Minh Hưng", email: `scope-${run}@example.com` });
  const invite = async (name: string, key: string) =>
    (await (await api(owner, "identity/members/invite", "POST", { email: `${key}-${run}@example.com`, displayName: name, roleNames: ["Employee"], password: PASSWORD })).json())
      .userId as string;
  const lan = await invite("Phan Lan", "lan");
  const minh = await invite("Võ Minh", "minh");
  const hoa = await invite("Đặng Hoa", "hoa");
  const profile = (userId: string, displayName: string, managerId: string | null) =>
    api(owner, `employee/employees/${userId}`, "PUT", { displayName, title: "", departmentId: null, managerId, location: "", hireDate: null });
  await expect.poll(async () => (await profile(minh, "Võ Minh", lan)).status(), { timeout: 30_000 }).toBe(200);
  await expect.poll(async () => (await profile(hoa, "Đặng Hoa", null)).status(), { timeout: 30_000 }).toBe(200);

  // Minh and Hoa each use the company assistant once.
  for (const [email, text] of [
    [`minh-${run}@example.com`, "Viết email báo giá cho khách"],
    [`hoa-${run}@example.com`, "Lập kế hoạch tuyển dụng quý 4"],
  ] as const) {
    const p = await login(browser, email);
    expect((await api(p, "ai/assistant/messages", "POST", { content: text })).status()).toBe(201);
  }

  // Lan (Minh's manager): Minh only.
  const lanPage = await login(browser, `lan-${run}@example.com`);
  const seen = await (await api(lanPage, "ai/oversight?days=7")).json();
  expect(seen.people.map((p: { displayName: string }) => p.displayName)).toEqual(["Võ Minh"]);
  expect(seen.recent.every((c: { userId: string }) => c.userId === minh)).toBe(true);
  expect(seen.canEditPolicy).toBe(false);
  expect((await api(lanPage, `ai/oversight/people/${hoa}`)).status()).toBe(404);
  // A manager's rows carry the topic (and the AI's summary), never the title cut from the person's prompt.
  expect(seen.recent.every((c: { title?: string }) => c.title === undefined)).toBe(true);
  expect((await api(lanPage, `ai/oversight/conversations/${seen.recent[0].id}`)).status()).toBe(404);
  expect((await api(lanPage, "ai/policy", "PUT", { detail: "topic", captureResponses: true, retentionDays: 30 })).status()).toBe(403);
  await lanPage.goto("/app/ai/adoption/usage");
  await expect(lanPage.locator("main").getByText("Võ Minh").first()).toBeVisible();
  await expect(lanPage.locator("main").getByText("Đặng Hoa")).toHaveCount(0);

  // Hoa (no reports): the explanation, no data.
  const hoaPage = await login(browser, `hoa-${run}@example.com`);
  expect((await api(hoaPage, "ai/oversight")).status()).toBe(403);
  await hoaPage.goto("/app/ai/adoption/usage");
  // Not a manager: the tab shows their own AI data (what a manager would see about them), never others'.
  await expect(hoaPage.getByText(/AI của tôi: dùng vào gì.*Chỉ bạn thấy đầy đủ trang này\./)).toBeVisible();
  await expect(hoaPage.locator("main").getByText("Võ Minh")).toHaveCount(0);

  // The owner (admin) sees everyone, and under "summary" cannot read text either.
  const all = await (await api(owner, "ai/oversight?days=7")).json();
  expect(all.people.map((p: { displayName: string }) => p.displayName).sort()).toEqual(["Phan Lan", "Trần Minh Hưng", "Võ Minh", "Đặng Hoa"].sort());
  // Nobody reads the text, and no policy allows it.
  expect((await api(owner, `ai/oversight/conversations/${all.recent[0].id}`)).status()).toBe(404);
  expect(all.recent.every((c: { title?: string }) => c.title === undefined)).toBe(true);
  expect((await api(owner, "ai/policy", "PUT", { detail: "full", captureResponses: false, retentionDays: 180 })).status()).toBe(400);

  // Nobody has the extension: the owner reminds them all from the AI tab; Minh is told how.
  await owner.goto("/app/ai/adoption/usage");
  await owner.getByRole("button", { name: "Nhắc cài" }).click();
  await expect(owner.getByText("Đã nhắc 3 người")).toBeVisible();
  const minhPage = await login(browser, `minh-${run}@example.com`);
  await expect
    .poll(async () => JSON.stringify(await (await api(minhPage, "home/notifications")).json()), { timeout: 60_000 })
    .toContain("Công ty đề nghị bạn cài tiện ích workspace AI");
});
