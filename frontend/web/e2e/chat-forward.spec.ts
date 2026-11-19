import { expect, test, type Page } from "@playwright/test";
import { PASSWORD, setupWorkspace } from "./helpers";

/** Forward a message with where it came from, and "Đã xem" in direct messages. */
const run = Date.now().toString(36);
const post = (p: Page, path: string, data: unknown) => p.request.post(`/api/proxy/${path}`, { headers: { "x-wos-csrf": "1" }, data }).then((r) => r.json());

test("forward a message into a DM; the other person reading it shows Đã xem", async ({ browser }) => {
  test.setTimeout(180_000);
  const owner = await (await browser.newContext({ viewport: { width: 1440, height: 1000 } })).newPage();
  await setupWorkspace(owner, { company: `Forward ${run}`, name: "Đặng Khoa", email: `fwd-${run}@example.com` });
  const lanId = (await post(owner, "identity/members/invite", { email: `fwd-lan-${run}@example.com`, displayName: "Phan Lan", roleNames: ["Employee"], password: PASSWORD }))
    .userId as string;
  const ops = await post(owner, "chat/channels", { kind: "public", name: "van-hanh" });
  await post(owner, `chat/channels/${ops.id}/messages`, { body: "Khách đổi lịch giao hàng sang thứ Hai" });
  const dm = await post(owner, "chat/dms", { userId: lanId });

  await owner.goto(`/app/chat/${ops.id}`);
  const convo = owner.getByRole("region", { name: "Cuộc trò chuyện van-hanh" });
  const msg = convo.getByText("Khách đổi lịch giao hàng sang thứ Hai");
  await msg.hover();
  await convo.getByRole("button", { name: "Thêm thao tác với tin nhắn" }).last().click();
  await owner.getByRole("menuitem", { name: "Chuyển tiếp" }).click();
  const dialog = owner.getByRole("dialog", { name: "Chuyển tiếp" });
  await dialog.getByLabel("Tìm kênh hoặc người").fill("Phan");
  await dialog.getByRole("option", { name: /Phan Lan/ }).click();
  await dialog.getByLabel("Thêm lời nhắn (không bắt buộc)").fill("Lan sắp xếp xe giúp anh");
  await dialog.getByRole("button", { name: "Gửi" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(owner.getByText("Đã chuyển tiếp tới Phan Lan")).toBeVisible();

  // Nhắc tôi: a reminder at a chosen time, listed for the person until it fires.
  await msg.hover();
  await convo.getByRole("button", { name: "Nhắc tôi về tin này" }).last().click();
  await owner.getByRole("menuitem", { name: "Sau 20 phút" }).click();
  await expect(owner.getByText(/Sẽ nhắc bạn lúc/)).toBeVisible();
  const rem = await (await owner.request.get("/api/proxy/home/reminders", { headers: { "x-wos-csrf": "1" } })).json();
  expect(rem.reminders[0].title).toContain("Khách đổi lịch giao hàng sang thứ Hai");

  // Gửi sau: write now, post later; the pending message shows above the composer and can be cancelled.
  await convo.getByRole("textbox", { name: "Tin nhắn" }).fill("Nhắc cả nhà: chốt lịch xe trước 10h");
  await convo.getByRole("button", { name: "Gửi sau" }).click();
  await owner.getByRole("menuitem", { name: "Sau 1 giờ" }).click();
  await expect(owner.getByText(/Sẽ gửi lúc/)).toBeVisible();
  const pending = convo.getByRole("list", { name: "Tin hẹn gửi" });
  await expect(pending).toContainText("Nhắc cả nhà: chốt lịch xe trước 10h");
  await expect(convo.getByRole("textbox", { name: "Tin nhắn" })).toHaveValue("");
  await pending.getByRole("button", { name: "Huỷ" }).click();
  await expect(pending).toHaveCount(0);

  // Giao việc: the message becomes a task for Lan that the owner follows in Việc của tôi › Tôi giao.
  await msg.hover();
  await convo.getByRole("button", { name: "Thêm thao tác với tin nhắn" }).last().click();
  await owner.getByRole("menuitem", { name: "Giao việc" }).click();
  const assign = owner.getByRole("dialog", { name: "Giao việc" });
  await expect(assign.getByLabel("Việc cần làm")).toHaveValue("Khách đổi lịch giao hàng sang thứ Hai");
  await assign.getByRole("button", { name: "Người làm" }).click();
  await assign.getByRole("option", { name: "Phan Lan" }).click();
  await assign.getByRole("button", { name: "Tạo việc" }).click();
  await expect(owner.getByText(/Đã tạo việc T-\d+/)).toBeVisible();
  await owner.goto("/app/work/tasks?scope=owned");
  await expect(owner.getByRole("main")).toContainText("Khách đổi lịch giao hàng");

  await owner.goto(`/app/chat/${dm.id}`);
  await expect(owner.getByText("Chuyển tiếp · tin của Đặng Khoa trong #van-hanh")).toBeVisible();
  await expect(owner.getByTestId("receipt")).toHaveText("✓ Đã gửi");

  // Lan opens the DM: the sender sees it change to Đã xem, live.
  const lan = await (await browser.newContext({ viewport: { width: 1440, height: 1000 } })).newPage();
  await lan.goto(`/login?email=${encodeURIComponent(`fwd-lan-${run}@example.com`)}`);
  await lan.getByLabel("Mật khẩu").fill(PASSWORD);
  await lan.getByRole("button", { name: "Đăng nhập" }).click();
  await lan.waitForURL(/\/app\//);
  await lan.goto(`/app/chat/${dm.id}`);
  await expect(lan.getByText("Lan sắp xếp xe giúp anh")).toBeVisible();
  await expect(owner.getByTestId("receipt")).toHaveText("✓✓ Đã xem", { timeout: 15_000 });
  // The task the owner gave her from chat is in Lan's list (progress is reported from the task itself).
  await lan.goto("/app/work/tasks?scope=assigned");
  await expect(lan.getByRole("link", { name: /Khách đổi lịch giao hàng/ }).first()).toBeVisible();
});
