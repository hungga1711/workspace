import { expect, test } from "@playwright/test";
import { api, setupWorkspace } from "./helpers";

/** AI on documents: answers about a page; tasks created from a document link back. */
const run = Date.now().toString(36);

test("AI answers about a document and turns it into tasks", async ({ browser }) => {
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 1000 } })).newPage();
  await setupWorkspace(page, { company: `AIW ${run}`, name: "Lâm Phong", email: `aiw-${run}@example.com` });
  const d = (
    await api(page, "POST", "work/docs", {
      title: "Kế hoạch ra mắt",
      content: "# Kế hoạch\n\n- Cần chuẩn bị video giới thiệu trước 15/11\n- Phải gửi email cho khách hàng thân thiết\n\nNgân sách quảng cáo là 50 triệu.",
      visibility: "workspace",
    })
  ).body;
  await page.goto(`/app/work/docs/${d.id}`);
  await page.getByRole("button", { name: "Thêm thao tác" }).click();
  await page.getByRole("menuitem", { name: "Hỏi AI về trang này" }).click();
  const docAi = page.getByRole("region", { name: "AI cho tài liệu này" });
  await docAi.getByLabel("Hỏi về tài liệu").fill("Ngân sách quảng cáo bao nhiêu?");
  await docAi.getByRole("button", { name: "Hỏi" }).click();
  await expect(docAi.getByLabel("Kết quả AI")).toContainText("50 triệu");
  await docAi.getByRole("button", { name: "Trích việc cần làm" }).click();
  await docAi.getByRole("button", { name: "Tạo việc" }).first().click();
  await expect(docAi.getByText("Đã tạo việc")).toBeVisible();
  const mine = (await api(page, "GET", "work/tasks?scope=owned")).body.tasks as { id: string; title: string; source: { type: string } | null }[];
  const fromDoc = mine.find((x) => x.source?.type === "document");
  expect(fromDoc?.title).toMatch(/video giới thiệu/);
  await page.goto(`/app/work/tasks/${fromDoc!.id}`);
  await expect(page.getByRole("link", { name: "một tài liệu" })).toHaveAttribute("href", `/app/work/docs/${d.id}`);
});
