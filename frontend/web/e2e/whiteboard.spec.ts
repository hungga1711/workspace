import { expect, test, type Page } from "@playwright/test";
import { api, PASSWORD, setupWorkspace, signIn } from "./helpers";

/**
 * Whiteboards: a board made from a template, a sticky added with the sticky tool, a second person sees it live, the
 * sticky becomes a task (badge on the board, "Tạo từ bảng trắng W-001" on the task), a reload keeps everything, and
 * someone who may only view a project board gets it in view mode.
 *
 * The canvas draws on <canvas>, so what a board shows is read from the attributes the canvas host keeps
 * (`data-stickies`, `data-sticky-text`), not from DOM text.
 */
test("whiteboard: template, sticky, live, task, reload, view only", async ({ browser }) => {
  test.setTimeout(240_000);
  const run = Date.now().toString(36);
  const owner = await (await browser.newContext({ viewport: { width: 1440, height: 1000 } })).newPage();
  await setupWorkspace(owner, { company: `Bảng ${run}`, name: "Lê Minh", email: `wb-${run}@example.com` });
  const lanEmail = `wb-lan-${run}@example.com`;
  await api(owner, "POST", "identity/members/invite", { email: lanEmail, displayName: "Phan Lan", roleNames: ["Employee"], password: PASSWORD });
  const canvas = (p: Page) => p.locator("[data-whiteboard-canvas]");

  // A board from the retro template, through the picker.
  await owner.goto("/app/work/whiteboards");
  await owner.getByRole("button", { name: "Bảng mới" }).click();
  const dialog = owner.getByRole("dialog", { name: "Bảng trắng mới" });
  await dialog.getByLabel("Tên bảng").fill("Nhìn lại sprint 12");
  await dialog.getByRole("radio", { name: /Nhìn lại/ }).click();
  await dialog.getByRole("button", { name: "Tạo bảng" }).click();
  await owner.waitForURL(/\/app\/work\/whiteboards\/W-001$/);
  await expect(owner.locator(".excalidraw canvas").first()).toBeVisible();
  // The template's columns arrived (their titles are text, not stickies).
  await expect.poll(async () => (await api(owner, "GET", "work/whiteboards/W-001")).body.scene.elements.length).toBeGreaterThan(3);

  // A sticky with the sticky tool, written on with Enter.
  await owner.getByRole("button", { name: "Thêm giấy nhớ (S)" }).click();
  await owner.keyboard.press("Enter");
  await owner.keyboard.type("Gọi nhà cung cấp");
  await owner.keyboard.press("Escape");
  await expect(canvas(owner)).toHaveAttribute("data-sticky-text", /Gọi nhà cung cấp/);

  // Lan opens the same board and sees it; her sticky reaches Minh live.
  const lan = await (await browser.newContext({ viewport: { width: 1440, height: 1000 } })).newPage();
  await signIn(lan, lanEmail);
  await lan.goto("/app/work/whiteboards/W-001");
  await expect(canvas(lan)).toHaveAttribute("data-sticky-text", /Gọi nhà cung cấp/);
  await lan.keyboard.press("Escape");
  await lan.getByRole("button", { name: "Thêm giấy nhớ (S)" }).click();
  await lan.keyboard.press("Enter");
  await lan.keyboard.type("Lan bổ sung");
  await lan.keyboard.press("Escape");
  await expect(canvas(owner)).toHaveAttribute("data-sticky-text", /Lan bổ sung/);
  // Minh sees who is here.
  // The board's presence row (inside the page, not the sidebar's DM list).
  await expect(owner.locator("#main [title='Phan Lan']").first()).toBeAttached();

  // Minh turns the stickies into tasks: badges appear under them.
  await owner.keyboard.press("ControlOrMeta+a");
  await owner.getByRole("toolbar", { name: "Công cụ bảng trắng" }).getByRole("button", { name: "Tạo việc" }).click();
  const tasks = owner.getByRole("dialog", { name: "Tạo việc từ giấy nhớ" });
  await tasks.getByRole("button", { name: /^Tạo 2 việc$/ }).click();
  await expect(owner.getByText("Đã tạo 2 việc")).toBeVisible();
  const badge = owner.getByRole("link", { name: /^Mở việc T-\d+: Gọi nhà cung cấp$/ });
  await expect(badge).toBeVisible();

  // Saved: a reload brings the stickies and the badges back. The label must be the save of the task links (it used to
  // stay on while that change waited out its two seconds), and the stored scene must hold both stickies.
  await expect(owner.getByText("Đã lưu")).toBeVisible();
  await expect
    .poll(async () => {
      const text = JSON.stringify((await api(owner, "GET", "work/whiteboards/W-001")).body.scene.elements);
      return text.includes("Gọi nhà cung cấp") && text.includes("Lan bổ sung");
    })
    .toBe(true);
  await owner.reload();
  await expect(canvas(owner)).toHaveAttribute("data-sticky-text", /Gọi nhà cung cấp.*Lan bổ sung|Lan bổ sung.*Gọi nhà cung cấp/);
  await expect(badge).toBeVisible();

  // The task says where it came from.
  await badge.click();
  await expect(owner.getByText(/Tạo từ\s+bảng trắng W-001/)).toBeVisible();

  // A project board: Lan (not on the project) may look but not draw.
  const project = (await api(owner, "POST", "work/projects", { name: `Dự án ${run}` })).body;
  const pb = (await api(owner, "POST", "work/whiteboards", { title: "Kế hoạch dự án", projectId: project.id, visibility: "project", template: "kanban" })).body;
  await lan.goto(`/app/work/whiteboards/${pb.code}`);
  await expect(canvas(lan)).toHaveAttribute("data-view-only", "");
  await expect(lan.getByText("Chỉ xem")).toBeVisible();
  await expect(lan.getByRole("button", { name: "Thêm giấy nhớ (S)" })).toHaveCount(0);
  expect((await api(lan, "PUT", `work/whiteboards/${pb.id}/scene`, { baseVersion: 1, scene: { elements: [], appState: {}, files: {} } })).status).toBe(403);

  // The list shows both boards.
  await owner.goto("/app/work/whiteboards");
  await expect(owner.getByRole("link", { name: /Nhìn lại sprint 12/ })).toBeVisible();
  await expect(owner.getByRole("link", { name: /Kế hoạch dự án/ })).toBeVisible();
});
