import { expect, test, type Page } from "@playwright/test";
import { PASSWORD, setupWorkspace } from "./helpers";

/**
 * AI Insights, the positive side: a person shares a prompt from their own conversation (redacted before anyone
 * sees it), colleagues find it in the prompt library; the owner imports a provider export, adds a company topic
 * and opens the one-page weekly report.
 */
const run = Date.now().toString(36);
const post = (p: Page, path: string, data: unknown, method = "POST") =>
  p.request.fetch(`/api/proxy/${path}`, { method, headers: { "x-wos-csrf": "1" }, data }).then((r) => r.json());

test("AI Insights: prompt library, provider import, topics and the weekly report", async ({ browser }) => {
  test.setTimeout(180_000);
  const owner = await (await browser.newContext({ viewport: { width: 1440, height: 1000 } })).newPage();
  await setupWorkspace(owner, { company: `Library ${run}`, name: "Trần Minh Hưng", email: `lib-owner-${run}@example.com` });
  const maiEmail = `lib-mai-${run}@example.com`;
  await post(owner, "identity/members/invite", { email: maiEmail, displayName: "Đỗ Mai", roleNames: ["Employee"], password: PASSWORD });

  const mai = await (await browser.newContext({ viewport: { width: 1440, height: 1000 } })).newPage();
  await mai.goto("/login");
  await mai.getByLabel("Email").fill(maiEmail);
  await mai.getByLabel("Mật khẩu").fill(PASSWORD);
  await mai
    .getByRole("button", { name: /Đăng nhập/ })
    .first()
    .click();
  await mai.waitForURL(/\/app\//);
  // Mai adds a prompt of her own for the whole company to use (the library is where prompts are written now; a
  // conversation is no longer shared from Của tôi › AI). Colleagues read a copy with the email replaced.
  await mai.goto("/app/ai/adoption/library?tab=mine");
  await mai.getByTestId("prompt-new").click();
  await mai.getByTestId("prompt-title").fill(`Viết thư chào hàng ${run}`);
  await mai.getByTestId("prompt-body").fill(`Viết thư chào hàng ${run}, liên hệ an@acme.vn`);
  await mai.locator("label").filter({ hasText: "Cả công ty" }).click();
  await expect(mai.getByRole("radio", { name: /Cả công ty/ })).toBeChecked();
  await mai.getByTestId("prompt-save").click();
  await expect(mai.getByTestId("prompt-library")).toContainText(`Viết thư chào hàng ${run}`);

  await owner.goto("/app/ai/adoption/library?tab=team");
  const lib = owner.getByTestId("prompt-library");
  await expect(lib).toContainText(`Viết thư chào hàng ${run}`);
  await owner.getByLabel("Tìm prompt").fill("chào hàng");
  await expect(lib).toContainText(`Viết thư chào hàng ${run}`);
  // What a colleague can open never has the address in it.
  const shared = (await (await owner.request.get("/api/proxy/ai/insights/library?tab=team", { headers: { "x-wos-csrf": "1" } })).json()) as {
    prompts: { title: string; body: string }[];
  };
  const copy = shared.prompts.find((x) => x.title === `Viết thư chào hàng ${run}`)!;
  expect(copy.body).not.toContain("an@acme.vn");
  expect(copy.body).toContain("[EMAIL]");

  // The owner sets up a company prompt; Mai finds it under Công ty.
  await owner.goto("/app/ai/adoption/library?tab=company");
  await owner.getByTestId("prompt-new").click();
  await owner.getByTestId("prompt-title").fill(`Báo giá chuẩn ${run}`);
  await owner.getByTestId("prompt-body").fill("Soạn báo giá cho [tên khách hàng] theo mẫu của công ty");
  await owner.getByTestId("prompt-save").click();
  await expect(owner.getByTestId("prompt-library")).toContainText(`Báo giá chuẩn ${run}`);
  await mai.goto("/app/ai/adoption/library?tab=company");
  await expect(mai.getByTestId("prompt-library")).toContainText(`Báo giá chuẩn ${run}`);
  // Company prompts are the library managers' to write: Mai is not offered one here.
  await expect(mai.getByTestId("prompt-new")).toHaveCount(0);

  // Admin › AI: a company topic, and a provider export matched by email.
  await owner.goto("/admin/workspace/ai/insights");
  const topics = owner.getByTestId("ai-topics-admin");
  await topics.getByRole("button", { name: "Thêm chủ đề" }).click();
  await topics.getByLabel("Tên (tiếng Việt)").fill(`Đấu thầu ${run}`);
  await topics.getByTestId("topic-keywords").fill("hồ sơ thầu, tender");
  await topics.getByRole("button", { name: "Lưu" }).click();
  await expect(topics.getByText("Đã lưu chủ đề.")).toBeVisible();

  const imp = owner.getByTestId("ai-import-admin");
  const at = new Date(Date.now() - 86400_000).toISOString();
  await imp.getByTestId("ai-import-file").setInputFiles({
    name: "usage.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(`User Email,Timestamp,Product,Message count\n${maiEmail},${at},Desktop app,5\nnobody@example.com,${at},Desktop app,1\n`),
  });
  await imp.getByTestId("ai-import-start").click();
  await expect(imp.getByText(/Đã nhập 1, trùng 0, không khớp người 1/).first()).toBeVisible();

  // The weekly report: one page, three things to do.
  await owner.goto("/app/ai/adoption/report");
  await expect(owner.getByRole("heading", { name: "Báo cáo AI tuần" })).toBeVisible();
  await expect(owner.getByTestId("report-recommendations").locator("li")).toHaveCount(3);
});
