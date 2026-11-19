import { expect, test, type Browser, type Page } from "@playwright/test";
import { PASSWORD, setupWorkspace } from "./helpers";

/**
 * AI, its own destination: Tiến độ shows a manager who needs attention (late work) and lets them nudge with their own
 * words; Áp dụng AI suggests where AI could help from the work's titles; staff see only their own work in both.
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

test("AI › Tiến độ and Áp dụng AI work from the team's tasks", async ({ browser }) => {
  test.setTimeout(240_000);
  const owner = await (await browser.newContext()).newPage();
  await setupWorkspace(owner, { company: `Hub ${run}`, name: "Trần Minh Hưng", email: `hub-${run}@example.com` });
  const invite = async (name: string, key: string) =>
    (await (await api(owner, "identity/members/invite", "POST", { email: `${key}-${run}@example.com`, displayName: name, roleNames: ["Employee"], password: PASSWORD })).json())
      .userId as string;
  const lan = await invite("Phan Lan", "lan");
  const minh = await invite("Võ Minh", "minh");
  await expect
    .poll(
      async () =>
        (await api(owner, `employee/employees/${minh}`, "PUT", { displayName: "Võ Minh", title: "", departmentId: null, managerId: lan, location: "", hireDate: null })).status(),
      {
        timeout: 30_000,
      },
    )
    .toBe(200);
  const project = (await (await api(owner, "work/projects", "POST", { name: `Bán hàng ${run}` })).json()).id as string;
  const yesterday = new Date(Date.now() - 2 * 86400_000).toISOString();
  for (const title of ["Soạn email cảm ơn đối tác", "Soạn thông báo nghỉ lễ", "Viết nội dung bài đăng tháng 11"])
    expect((await api(owner, "work/tasks", "POST", { title, projectId: project, assigneeId: minh, dueAt: yesterday })).status()).toBeLessThan(300);

  const lanPage = await login(browser, `lan-${run}@example.com`);
  await lanPage.goto("/app/ai");
  await expect(lanPage).toHaveURL(/\/app\/ai\/progress/);
  const row = lanPage.getByTestId("ai-attention").getByRole("listitem").filter({ hasText: "Võ Minh" });
  await expect(row.getByText("3 việc trễ")).toBeVisible();
  await row.getByRole("button", { name: "Nhắc" }).click();
  await row.getByRole("textbox").fill("Minh ơi, mấy việc này cần mình hỗ trợ gì không?");
  await row.getByRole("button", { name: "Gửi lời nhắc" }).click();
  await expect(row.getByText("Đã nhắc")).toBeVisible();

  await lanPage.getByRole("link", { name: "Áp dụng AI" }).click();
  await expect(lanPage).toHaveURL(/\/app\/ai\/adoption/);
  // The project's tasks show per project; Minh's open writing tasks are suggested under "Của đội", with how AI helps.
  await expect(lanPage.getByTestId("ai-projects")).toContainText(`Bán hàng ${run}`);
  await lanPage.getByRole("radio", { name: /Của đội/ }).click();
  const suggested = lanPage.getByTestId("ai-now");
  await expect(suggested).toContainText("Soạn thông báo nghỉ lễ");
  // Whose task it is: the row carries the person's avatar (their name is its tooltip).
  await expect(suggested.getByTitle("Võ Minh").first()).toBeVisible();

  // Staff: their own work only, no nudges.
  const minhPage = await login(browser, `minh-${run}@example.com`);
  const own = await (await api(minhPage, "ai/progress/brief")).json();
  expect(own.scope).toBe("self");
  expect(own.attention[0].reasons[0]).toMatchObject({ kind: "overdue", count: 3 });
  await minhPage.goto("/app/ai/progress");
  await expect(minhPage.getByRole("button", { name: "Nhắc" })).toHaveCount(0);
});
