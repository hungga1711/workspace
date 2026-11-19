import { expect, test, type Page } from "@playwright/test";
import { PASSWORD, setupWorkspace } from "./helpers";

/** Chat for daily work: formatting, star/mute, threads and mentions views, channel browser, drafts. */
const run = Date.now().toString(36);
const post = (p: Page, path: string, data: unknown) => p.request.post(`/api/proxy/${path}`, { headers: { "x-wos-csrf": "1" }, data }).then((r) => r.json());

test("formatting, star, threads, mentions, browse and drafts", async ({ browser }) => {
  const owner = await (await browser.newContext({ viewport: { width: 1440, height: 1000 } })).newPage();
  await setupWorkspace(owner, { company: `Chat Pro ${run}`, name: "Vũ Minh", email: `chatpro-${run}@example.com` });
  const me = (await (await owner.request.get("/api/proxy/identity/members", { headers: { "x-wos-csrf": "1" } })).json()).members[0].userId as string;
  const lanId = (await post(owner, "identity/members/invite", { email: `chatpro-lan-${run}@example.com`, displayName: "Nguyễn Lan", roleNames: ["Employee"], password: PASSWORD }))
    .userId as string;
  const ops = await post(owner, "chat/channels", { kind: "public", name: "van-hanh", memberIds: [lanId] });
  const other = await post(owner, "chat/channels", { kind: "public", name: "ke-toan" });
  const lan = await (await browser.newContext({ viewport: { width: 1440, height: 1000 } })).newPage();
  await lan.goto(`/login?email=${encodeURIComponent(`chatpro-lan-${run}@example.com`)}`);
  await lan.getByLabel("Mật khẩu").fill(PASSWORD);
  await lan.getByRole("button", { name: "Đăng nhập" }).click();
  await lan.waitForURL(/\/app\//);
  const root = await post(lan, `chat/channels/${ops.id}/messages`, { body: `**Kế hoạch tuần**\n- chốt giá\n- gọi nhà xe\nXem \`bang-gia.xlsx\` nhé <@${me}>` });
  await post(owner, `chat/channels/${ops.id}/messages`, { body: "Đã nhận", threadRootId: root.id });

  // Formatting renders as structure, never as raw markers.
  await owner.goto(`/app/chat/${ops.id}`);
  const convo = owner.getByRole("region", { name: "Cuộc trò chuyện van-hanh" });
  await expect(convo.locator("strong", { hasText: "Kế hoạch tuần" })).toBeVisible();
  await expect(convo.getByRole("listitem").filter({ hasText: "gọi nhà xe" })).toBeVisible();
  await expect(convo.locator("code", { hasText: "bang-gia.xlsx" })).toBeVisible();

  // Star puts the channel in its own sidebar group.
  await convo.getByRole("button", { name: "Gắn sao" }).click();
  const nav = owner.getByRole("complementary", { name: "Điều hướng" });
  await expect(nav.getByRole("button", { name: "Gắn sao" })).toBeVisible();

  // Drafts survive leaving the channel.
  await convo.getByRole("textbox", { name: "Tin nhắn" }).fill("bản nháp chưa gửi");
  await owner.goto("/app/chat/threads");
  await expect(owner.getByRole("navigation", { name: "Tin nhắn", exact: true }).getByRole("link", { name: "Luồng" })).toHaveAttribute("aria-current", "page");
  await expect(owner.getByText("1 trả lời")).toBeVisible();
  await owner.goto("/app/chat/mentions");
  await expect(owner.getByText("Kế hoạch tuần").first()).toBeVisible();
  await owner.goto(`/app/chat/${ops.id}`);
  await expect(owner.getByRole("textbox", { name: "Tin nhắn" })).toHaveValue("bản nháp chưa gửi");

  // Lan finds #ke-toan in the channel browser and joins it.
  await lan.goto("/app/chat/browse");
  await lan.getByPlaceholder("Tìm theo tên hoặc chủ đề kênh").fill("ke-toan");
  await lan.getByRole("button", { name: "Tham gia #ke-toan" }).click();
  await lan.waitForURL(new RegExp(`/app/chat/${other.id}`));
  if (process.env.SHOTS) await owner.screenshot({ path: `${process.env.SHOTS}/chat-pro.png` });
});
