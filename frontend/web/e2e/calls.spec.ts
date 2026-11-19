import { expect, test, type Browser } from "@playwright/test";
import { PASSWORD, setupWorkspace } from "./helpers";

/**
 * Calling one person: it rings wherever they are in the app; they answer and both are in the call;
 * either hanging up ends it for both and the DM keeps how long it was; a declined call says so.
 * LiveKit from infra; Chromium's fake camera, and a WebAudio tone for the microphone (see meet.spec).
 */
const MEDIA = {
  permissions: ["camera", "microphone"],
};
test.use({ launchOptions: { args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] } });
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
const h = { headers: { "x-wos-csrf": "1" } };

async function person(browser: Browser) {
  const ctx = await browser.newContext({ ...MEDIA, viewport: { width: 1280, height: 860 } });
  await ctx.addInitScript(FAKE_MIC);
  return ctx.newPage();
}

test("call someone: it rings in their app, they answer, hanging up ends it for both; a declined call says so", async ({ browser }) => {
  test.setTimeout(240_000);
  const run = Date.now().toString(36);
  const minh = await person(browser);
  await setupWorkspace(minh, { company: `Calls ${run}`, name: "Lê Minh", email: `calls-${run}@example.com` });
  const lanId = (
    await (
      await minh.request.post("/api/proxy/identity/members/invite", {
        ...h,
        data: { email: `calls-lan-${run}@example.com`, displayName: "Phan Lan", roleNames: ["Employee"], password: PASSWORD },
      })
    ).json()
  ).userId as string;
  // Chat learns about new members from an event: wait until the DM can be opened.
  let dm = "";
  await expect
    .poll(
      async () => {
        const r = await minh.request.post("/api/proxy/chat/dms", { ...h, data: { userId: lanId } });
        if (r.ok()) dm = (await r.json()).id;
        return r.ok();
      },
      { timeout: 60_000 },
    )
    .toBe(true);

  const lan = await person(browser);
  await lan.goto("/login");
  await lan.getByLabel("Email").fill(`calls-lan-${run}@example.com`);
  await lan.getByLabel("Mật khẩu").fill(PASSWORD);
  await lan
    .getByRole("button", { name: /Đăng nhập/ })
    .first()
    .click();
  await lan.waitForURL(/\/app\//);
  await lan.goto("/app/work");
  await lan.waitForTimeout(3500); // the call listener joins once the page is idle

  // Minh calls from their DM: his call tab says it is ringing; Lan's app rings, on whatever page.
  await minh.goto(`/app/chat/${dm}`);
  const [minhCall] = await Promise.all([minh.context().waitForEvent("page"), minh.getByRole("button", { name: "Gọi thoại cho Phan Lan" }).click()]);
  await expect(minhCall.getByText("Đang gọi Phan Lan…")).toBeVisible();
  const ringing = lan.getByRole("alertdialog", { name: "Lê Minh" });
  await expect(ringing).toContainText("Đang gọi thoại cho bạn…");

  // Lan answers: her call tab opens, both are in it, the ringing stops on both sides.
  const [lanCall] = await Promise.all([lan.context().waitForEvent("page"), ringing.getByRole("button", { name: "Trả lời" }).click()]);
  await expect(ringing).toHaveCount(0);
  await expect(lanCall).toHaveURL(/\/meet\/[a-z-]+\?call=/);
  await expect(minhCall.getByText("Đang gọi Phan Lan…")).toHaveCount(0);
  await expect(lanCall.getByRole("button", { name: "Kết thúc" }).first()).toBeVisible();
  await expect(minhCall.getByText("2 người")).toBeVisible();
  await expect(lanCall.getByText("2 người")).toBeVisible();

  // Lan hangs up: Minh's side ends too, and the DM keeps the call.
  await lanCall.getByRole("button", { name: "Kết thúc" }).first().click();
  await expect(minhCall.getByText("Cuộc gọi đã kết thúc.")).toBeVisible();
  await expect
    .poll(async () => (await (await minh.request.get(`/api/proxy/chat/channels/${dm}/messages?limit=1`)).json()).messages[0]?.body, { timeout: 15_000 })
    .toMatch(/^📞 Cuộc gọi thoại · /);

  // Minh calls again from the end screen; Lan declines; Minh is told and can write instead.
  await minhCall.getByRole("button", { name: "Gọi lại" }).click();
  await expect(minhCall.getByText("Đang gọi Phan Lan…")).toBeVisible();
  await lan.getByRole("alertdialog", { name: "Lê Minh" }).getByRole("button", { name: "Từ chối" }).click();
  await expect(minhCall.getByText("Phan Lan đã từ chối cuộc gọi.")).toBeVisible();
  await expect(minhCall.getByRole("link", { name: "Nhắn tin" })).toHaveAttribute("href", `/app/chat/${dm}`);
});
