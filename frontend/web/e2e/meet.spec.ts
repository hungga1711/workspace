import { expect, test, type Page } from "@playwright/test";
import { axe, setupWorkspace } from "./helpers";

/**
 * Video meetings (LiveKit). Needs the SFU from infra (docker compose up livekit). Chromium's fake
 * camera and microphone stand in for real devices.
 */
test.use({
  permissions: ["camera", "microphone"],
  launchOptions: { args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] },
});

/**
 * Headless Chromium on macOS hangs on the fake microphone; give pages a WebAudio tone instead
 * (the fake camera works). Real browsers are unaffected.
 */
const FAKE_MIC = () => {
  const real = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia = async (c?: MediaStreamConstraints) => {
    const stream = c?.video ? await real({ video: c.video }) : new MediaStream();
    if (c?.audio) {
      const ac = new AudioContext();
      const osc = ac.createOscillator();
      const dest = ac.createMediaStreamDestination();
      osc.connect(dest);
      osc.start();
      dest.stream.getAudioTracks().forEach((t) => stream.addTrack(t));
    }
    return stream;
  };
};

async function signUp(page: Page, run: string) {
  await page.addInitScript(FAKE_MIC);
  await setupWorkspace(page, { company: `Meet ${run}`, name: "Minh Host", email: `meet-${run}@example.com` });
}

test("start a meeting, a guest asks to join from the link and is admitted", async ({ page, browser }) => {
  test.setTimeout(120_000);
  const run = Date.now().toString(36);
  await signUp(page, run);

  // Work › Meetings › "Họp ngay" creates a room and opens it.
  await page.goto("/app/work/calendar?view=meetings");
  await page.getByRole("button", { name: "Họp ngay" }).click();
  await page.waitForURL(/\/meet\/[a-z]{3}-[a-z]{4}-[a-z]{3}$/);
  const link = page.url();
  // The name field has a label, not just a placeholder.
  await expect(page.getByLabel("Tên hiển thị trong cuộc họp")).toHaveValue(/Minh/);
  await expect(page.getByText("Chưa có ai trong phòng")).toBeVisible();
  await axe(page, "prejoin");
  await page.getByRole("button", { name: "Tham gia", exact: true }).click();
  await expect(page.getByRole("button", { name: "Rời cuộc họp" })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("Chỉ có bạn trong cuộc họp")).toBeVisible();
  await axe(page, "call");
  // The host names the meeting; it is saved for the room.
  await page.getByRole("button", { name: /^Họp nhanh lúc/ }).click();
  await page.getByLabel("Tên cuộc họp").fill("Họp sprint 42");
  await page.getByLabel("Tên cuộc họp").press("Enter");
  await expect(page.getByRole("button", { name: "Họp sprint 42" })).toBeVisible();
  const code = link.split("/meet/")[1]!;
  await expect.poll(async () => (await (await page.request.get(`/api/proxy/work/meet/rooms/${code}`, { headers: { "x-wos-csrf": "1" } })).json()).room.title).toBe("Họp sprint 42");

  // A guest: another browser, no account.
  const guestCtx = await browser.newContext({ permissions: ["camera", "microphone"] });
  await guestCtx.addInitScript(FAKE_MIC);
  const guest = await guestCtx.newPage();
  await guest.goto(link);
  await guest.getByPlaceholder("Tên của bạn").fill("Khách Lan");
  await guest.getByRole("button", { name: "Tham gia với tư cách khách" }).click();
  await expect(guest.getByText("Đang chờ người tổ chức cho bạn vào")).toBeVisible();

  // The host sees the request and admits the guest.
  await expect(page.getByText("Khách Lan muốn tham gia")).toBeVisible({ timeout: 10_000 });
  await page.getByRole("button", { name: "Cho vào" }).first().click();
  await expect(guest.getByRole("button", { name: "Rời cuộc họp" })).toBeVisible({ timeout: 20_000 });

  // Both are in the room: the people list shows two, the guest marked as such.
  await page.getByRole("button", { name: "Người tham gia" }).click();
  await expect(page.getByRole("heading", { name: "Người tham gia (2)" })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("complementary").getByText("Khách Lan · Khách")).toBeVisible();
  // The guest's tile carries their name and the guest mark too.
  await expect(page.getByRole("region", { name: /Họp nhanh/ }).getByText("Khách Lan · Khách")).toBeVisible();

  // Meeting chat reaches the other side.
  await page.getByRole("button", { name: "Trò chuyện" }).click();
  await page.getByLabel("Nhắn cho mọi người…").fill("Chào bạn");
  await page.getByRole("button", { name: "Gửi" }).click();
  await guest.getByRole("button", { name: "Trò chuyện" }).click();
  await expect(guest.getByText("Chào bạn")).toBeVisible();

  // The guest raises a hand (everyone sees it on the tile); the host sends a reaction.
  await guest.getByRole("button", { name: "Giơ tay" }).click();
  await expect(page.getByRole("img", { name: "Khách Lan đang giơ tay" }).first()).toBeVisible({ timeout: 10_000 });
  await guest.getByRole("button", { name: "Hạ tay" }).click();
  await expect(page.getByRole("img", { name: "Khách Lan đang giơ tay" })).toHaveCount(0, { timeout: 10_000 });
  await page.getByRole("button", { name: "Cảm xúc" }).click();
  await page.getByRole("menuitem", { name: "👏" }).click();
  await expect(guest.getByText("👏")).toBeVisible({ timeout: 10_000 });

  // Speaker view: one large tile and a strip; back to the grid.
  await page.getByRole("button", { name: "Người nói" }).click();
  await expect(page.getByRole("button", { name: "Người nói" })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Lưới" }).click();

  // The host asks the guest to leave; the guest is told why and cannot just rejoin from that screen.
  await page.getByRole("button", { name: "Người tham gia" }).click();
  await page.getByRole("button", { name: "Tuỳ chọn cho Khách Lan" }).click();
  await page.getByRole("menuitem", { name: "Mời rời cuộc họp" }).click();
  await expect(guest.getByText("Người tổ chức đã mời bạn ra khỏi cuộc họp.")).toBeVisible({ timeout: 15_000 });
  await expect(guest.getByRole("button", { name: "Tham gia lại" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Người tham gia (1)" })).toBeVisible({ timeout: 15_000 });
  await guestCtx.close();
});

test("a video call starts from a chat channel and its link is posted there", async ({ page, context }) => {
  test.setTimeout(120_000);
  await context.addInitScript(FAKE_MIC);
  await signUp(page, `${Date.now().toString(36)}ch`);
  await page.goto("/app/chat/general");
  await expect(page.getByRole("heading", { level: 1, name: "general" })).toBeVisible();
  const opened = context.waitForEvent("page");
  await page.getByRole("button", { name: "Gọi video" }).click();
  const call = await opened;
  await call.waitForURL(/\/meet\/[a-z]{3}-[a-z]{4}-[a-z]{3}$/);
  const code = call.url().split("/meet/")[1]!;
  await expect(page.getByRole("log").getByText(`/meet/${code}`)).toBeVisible();
  await expect(call.getByRole("heading", { name: "Gọi video #general" })).toBeVisible();

  // Once someone is in the call, the conversation shows it with a join button.
  await call.getByRole("button", { name: "Tham gia", exact: true }).click();
  await expect(call.getByRole("button", { name: "Rời cuộc họp" })).toBeVisible({ timeout: 20_000 });
  await page.reload();
  const banner = page.getByRole("status").filter({ hasText: "Đang có cuộc gọi video" });
  await expect(banner).toContainText("1 người", { timeout: 20_000 });
  await expect(banner.getByRole("link", { name: "Vào" })).toHaveAttribute("href", `/meet/${code}`);
});

test("a meeting closed to guests says so; an unknown link is a 404", async ({ page, browser }) => {
  const run = Date.now().toString(36);
  await signUp(page, `${run}c`);
  await page.goto("/app/work/calendar?view=meetings");
  await page.getByRole("button", { name: "Họp ngay" }).click();
  await page.waitForURL(/\/meet\//);
  const code = page.url().split("/meet/")[1]!;
  const r = await page.request.patch(`/api/proxy/work/meet/rooms/${code}`, { data: { guestAccess: "off" }, headers: { "x-wos-csrf": "1" } });
  expect(r.ok()).toBe(true);

  const guestCtx = await browser.newContext();
  const guest = await guestCtx.newPage();
  await guest.goto(`/meet/${code}`);
  await expect(guest.getByText("Cuộc họp này chỉ dành cho thành viên công ty.")).toBeVisible();
  const missing = await guest.goto("/meet/zzz-zzzz-zzz");
  expect(missing?.status()).toBe(404);
  await guestCtx.close();
});

test("recording goes from the SFU straight to object storage and plays back from there", async ({ page }) => {
  test.skip(!process.env.E2E_RECORDING, "needs the Egress worker (docker compose --profile recording) and MEET_RECORDING=on");
  test.setTimeout(180_000);
  await signUp(page, `${Date.now().toString(36)}r`);
  await page.goto("/app/work/calendar?view=meetings");
  await page.getByRole("button", { name: "Họp ngay" }).click();
  await page.waitForURL(/\/meet\//);
  const code = page.url().split("/meet/")[1]!;
  await page.getByRole("button", { name: "Tham gia", exact: true }).click();
  await page.getByRole("button", { name: "Ghi hình" }).click();
  await expect(page.getByText("Đang ghi hình")).toBeVisible({ timeout: 60_000 });
  await page.waitForTimeout(15_000);
  await page.getByRole("button", { name: "Dừng ghi" }).click();
  await expect(page.getByText("Đang ghi hình")).toBeHidden({ timeout: 30_000 });

  let url: string | null = null;
  await expect
    .poll(
      async () => {
        const r = await page.request.get(`/api/proxy/work/meet/rooms/${code}/recordings`);
        const rec = (await r.json()).recordings[0];
        url = rec?.url ?? null;
        return rec?.status;
      },
      { timeout: 60_000 },
    )
    .toBe("ready");
  const file = await page.request.get(url!);
  expect(file.ok()).toBe(true);
  expect((await file.body()).length).toBeGreaterThan(10_000);
});
