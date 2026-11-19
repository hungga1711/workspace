import { expect, test, type Page } from "@playwright/test";
import { PASSWORD, setupWorkspace } from "./helpers";

/**
 * Two people on one page: the second sees who is editing and joins the same live draft: each sees the
 * other's typing, cursor and title change before anything is published; publishing never conflicts; an
 * unpublished draft left by closing the tab is picked up again.
 */
test("doc live editing: two people edit one draft together", async ({ browser }) => {
  test.setTimeout(240_000);
  const run = Date.now().toString(36);
  const owner = await (await browser.newContext({ viewport: { width: 1440, height: 1000 } })).newPage();
  await setupWorkspace(owner, { company: `Presence ${run}`, name: "Lê Minh", email: `presence-${run}@example.com` });
  const h = { headers: { "x-wos-csrf": "1" } };
  await owner.request.post("/api/proxy/identity/members/invite", {
    ...h,
    data: { email: `presence-lan-${run}@example.com`, displayName: "Phan Lan", roleNames: ["Admin"], password: PASSWORD },
  });
  const d = await (
    await owner.request.post("/api/proxy/work/docs", { ...h, data: { title: "Quy trình release", content: "<p>Bước 1</p>", format: "html", visibility: "workspace" } })
  ).json();
  const body = (p: Page) => p.locator("[data-doc-body] .ProseMirror");
  // The page's words, without other people's carets (their name labels sit inside the text).
  const words = (p: Page) =>
    // The editor while editing, the page as read otherwise: both live under [data-doc-body].
    p.locator("[data-doc-body]").evaluate((el) => {
      const c = el.cloneNode(true) as HTMLElement;
      c.querySelectorAll(".collaboration-cursor__caret").forEach((n) => n.remove());
      return c.textContent ?? "";
    });
  const typeAt = async (p: Page, where: "start" | "end", text: string) => {
    const paras = body(p).locator("p");
    await (where === "start" ? paras.first() : paras.last()).click();
    // Start or end of the page (macOS has no Home/End for that in an editor).
    const mac = process.platform === "darwin";
    await p.keyboard.press(where === "start" ? (mac ? "Meta+ArrowUp" : "Control+Home") : mac ? "Meta+ArrowDown" : "Control+End");
    await p.keyboard.type(text, { delay: 15 });
  };

  await owner.goto(`/app/work/docs/${d.id}`);
  await owner.getByRole("button", { name: "Sửa", exact: true }).click();
  await expect(body(owner)).toHaveAttribute("contenteditable", "true");
  await typeAt(owner, "start", "Minh viết. ");

  const lan = await (await browser.newContext({ viewport: { width: 1440, height: 1000 } })).newPage();
  await lan.goto("/login");
  await lan.getByLabel("Email").fill(`presence-lan-${run}@example.com`);
  await lan.getByLabel("Mật khẩu").fill(PASSWORD);
  await lan
    .getByRole("button", { name: /Đăng nhập/ })
    .first()
    .click();
  await lan.waitForURL(/\/app\//);
  await lan.goto(`/app/work/docs/${d.id}`);
  await expect(lan.getByText("Lê Minh đang sửa trang này. Bấm Sửa để cùng sửa trực tiếp.")).toBeVisible();
  // Lan joins the same draft without being asked, with Minh's unpublished words in it.
  lan.on("dialog", (dlg) => void dlg.dismiss().then(() => expect(dlg.message(), "no dialog expected").toBe("")));
  await lan.getByRole("button", { name: "Sửa", exact: true }).click();
  await expect.poll(() => words(lan)).toContain("Minh viết. Bước 1");
  await expect(lan.getByTestId("doc-live")).toContainText("Đang cùng sửa với Lê Minh");
  await expect(owner.getByTestId("doc-live")).toContainText("Đang cùng sửa với Phan Lan");

  // Each sees the other's typing and caret, live.
  await typeAt(lan, "end", " Lan bổ sung.");
  await expect.poll(() => words(owner)).toContain("Minh viết. Bước 1 Lan bổ sung.");
  await expect(owner.locator(".collaboration-cursor__label", { hasText: "Phan Lan" })).toBeVisible();
  await owner.getByLabel("Tiêu đề").fill("Quy trình release v2");
  await expect(lan.getByLabel("Tiêu đề")).toHaveValue("Quy trình release v2");

  // Minh publishes; Lan is told and keeps editing on top; her publish does not conflict.
  await owner.getByRole("button", { name: "Xuất bản" }).click();
  await expect(owner.getByText("Đã xuất bản phiên bản 2")).toBeVisible();
  await expect(lan.getByText("Lê Minh vừa xuất bản phiên bản 2")).toBeVisible();
  await typeAt(lan, "end", " Xong.");
  await lan.getByRole("button", { name: "Xuất bản" }).click();
  await expect(lan.getByText("Đã xuất bản phiên bản 3")).toBeVisible();
  await owner.reload();
  await expect.poll(() => words(owner)).toContain("Minh viết. Bước 1 Lan bổ sung. Xong.");
  await expect(owner.getByRole("heading", { level: 1 })).toHaveText("Quy trình release v2");

  // Minh starts again and closes the tab without publishing: the draft waits for the next editor.
  await owner.getByRole("button", { name: "Sửa", exact: true }).click();
  await typeAt(owner, "end", " Nháp dở.");
  await expect.poll(() => words(owner)).toContain("Xong. Nháp dở.");
  await owner.waitForTimeout(500);
  await owner.context().close();
  await lan.reload();
  await lan.getByRole("button", { name: "Sửa", exact: true }).click();
  await expect(lan.getByText("Đang tiếp tục bản nháp chưa xuất bản")).toBeVisible();
  await expect.poll(() => words(lan)).toContain("Xong. Nháp dở.");
  // Cancelling as the last one in drops it.
  lan.removeAllListeners("dialog");
  lan.once("dialog", (dlg) => void dlg.accept());
  await lan.getByRole("button", { name: "Huỷ" }).click();
  await lan.reload();
  await lan.getByRole("button", { name: "Sửa", exact: true }).click();
  await expect.poll(() => words(lan)).toContain("Xong.");
  await expect.poll(() => words(lan)).not.toContain("Nháp dở.");
});
