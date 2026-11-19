import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { currentStep, hotp } from "../../../backend/server/src/modules/identity/auth/totp";
import { PASSWORD, setupWorkspace } from "./helpers";

/** Own sign-in UI: success, wrong password, two-step codes, sign-out, protected routes. */
const run = Date.now().toString(36);
const EMAIL = `auth-${run}@example.com`;

test.describe.serial("sign-in through our own screen", () => {
  test("first-run setup signs the owner in directly, without leaving the app", async ({ page }) => {
    const hosts = new Set<string>();
    page.on("framenavigated", (f) => {
      if (f === page.mainFrame()) hosts.add(new URL(f.url()).host);
    });
    await setupWorkspace(page, { company: `Auth ${run}`, name: "Đỗ Hoa", email: EMAIL });
    expect([...hosts]).toEqual([new URL(page.url()).host]);
  });

  test("a wrong password explains itself and keeps the email", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel("Email công việc").fill(EMAIL);
    await page.getByLabel("Mật khẩu").fill("wrong-password");
    await page.getByRole("button", { name: "Đăng nhập" }).click();
    await expect(page.getByText("Email hoặc mật khẩu chưa đúng.")).toBeVisible();
    await expect(page.getByLabel("Email công việc")).toHaveValue(EMAIL);
  });

  test("signs in, lands on the requested page, then signs out to /login", async ({ page }) => {
    await page.goto("/login?next=/app/work");
    await page.getByLabel("Email công việc").fill(EMAIL);
    await page.getByLabel("Mật khẩu").fill(PASSWORD);
    await page.getByRole("button", { name: "Đăng nhập" }).click();
    await page.waitForURL(/\/app\/work/);
    await page.getByRole("button", { name: /Tài khoản/ }).click();
    await page.getByRole("menuitem", { name: "Đăng xuất" }).click();
    await page.waitForURL(/\/login\?notice=signed_out/);
    await expect(page.getByText("Bạn đã đăng xuất.")).toBeVisible();
    // The session is really gone.
    await page.goto("/app/home");
    await page.waitForURL(/\/login/);
  });

  test("never redirects to arbitrary hosts after sign-in", async ({ page }) => {
    await page.goto("/login?next=https://evil.example.com");
    await page.getByLabel("Email công việc").fill(EMAIL);
    await page.getByLabel("Mật khẩu").fill(PASSWORD);
    await page.getByRole("button", { name: "Đăng nhập" }).click();
    await page.waitForURL(/\/app\/home/);
  });
});

/**
 * The emails the server wrote: the end-to-end server runs with MAIL_OUTBOX_DIR (one JSON file per email) and so does
 * this runner. Real delivery is checked by hand with SMTP_URL and a yopmail.com address.
 */
const OUTBOX = process.env.MAIL_OUTBOX_DIR;
async function lastMail(to: string, subject: RegExp): Promise<{ subject: string; text: string }> {
  for (let i = 0; i < 60; i++) {
    const names = (await readdir(OUTBOX!).catch(() => [] as string[]))
      .filter((n) => n.endsWith(".json"))
      .sort()
      .reverse();
    for (const n of names) {
      const m = JSON.parse(await readFile(join(OUTBOX!, n), "utf8")) as { to: string; subject: string; text: string };
      if (m.to.toLowerCase() === to.toLowerCase() && subject.test(m.subject)) return { subject: m.subject, text: m.text };
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`no email for ${to}`);
}
const linkIn = (text: string) => text.match(/https?:\/\/[^\s]+(?:reset-password|activate)\?token=[A-Za-z0-9_-]+/)![0];

async function signIn(page: import("@playwright/test").Page, email: string, password: string) {
  await page.goto(`/login?email=${encodeURIComponent(email)}`);
  await page.getByLabel("Mật khẩu").fill(password);
  await page.getByRole("button", { name: "Đăng nhập" }).click();
}

test.describe.serial("account recovery and activation by email", () => {
  test.skip(!OUTBOX, "needs MAIL_OUTBOX_DIR, set on both the server and this runner");
  const NEW_PW = "Moi12345mk";
  const INVITEE = `invitee-${run}@example.com`;

  test("forgot password emails a one-time link; the new password works, the old one does not", async ({ page }) => {
    await page.goto("/login");
    await page.getByRole("link", { name: "Quên mật khẩu?" }).click();
    // The login page has the same "Email công việc" field: wait until the new page is in place.
    await page.waitForURL(/\/forgot-password/);
    await expect(page.getByRole("heading", { name: "Quên mật khẩu" })).toBeVisible();
    await page.getByLabel("Email công việc").fill(EMAIL);
    await page.getByRole("button", { name: "Gửi liên kết đặt mật khẩu" }).click();
    await expect(page.getByRole("status")).toContainText(EMAIL);
    const mail = await lastMail(EMAIL, /Đặt lại mật khẩu/);
    const link = linkIn(mail.text);
    await page.goto(link.replace(/^https?:\/\/[^/]+/, ""));
    await expect(page.getByText(EMAIL)).toBeVisible();
    await page.getByLabel("Mật khẩu mới").fill(NEW_PW);
    await page.getByLabel("Nhập lại mật khẩu").fill(NEW_PW);
    await page.getByRole("button", { name: "Đặt mật khẩu mới" }).click();
    await page.waitForURL(/\/login\?notice=reset/);
    // The link is single-use.
    await page.goto(link.replace(/^https?:\/\/[^/]+/, ""));
    await expect(page.getByText("Liên kết đã hết hạn hoặc đã được dùng.")).toBeVisible();
    await signIn(page, EMAIL, PASSWORD);
    await expect(page.getByText("Email hoặc mật khẩu chưa đúng.")).toBeVisible();
    await signIn(page, EMAIL, NEW_PW);
    await page.waitForURL(/\/app\/home/);
  });

  test("an unknown email gets the same neutral answer (no account enumeration)", async ({ page }) => {
    await page.goto("/forgot-password");
    await page.getByLabel("Email công việc").fill(`nobody-${run}@example.com`);
    await page.getByRole("button", { name: "Gửi liên kết đặt mật khẩu" }).click();
    await expect(page.getByRole("status")).toContainText("Nếu");
  });

  test("an invited colleague activates from the email and lands in the workspace", async ({ page, browser }) => {
    await signIn(page, EMAIL, NEW_PW);
    await page.waitForURL(/\/app\/home/);
    await page.goto("/admin/workspace/members");
    await page.getByRole("button", { name: "Mời thành viên" }).click();
    const dlg = page.getByRole("dialog");
    await dlg.getByLabel("Email").fill(INVITEE);
    await dlg.getByLabel("Họ tên").fill("Phan Thảo");
    await dlg.getByRole("button", { name: "Gửi lời mời" }).click();
    await expect(page.getByRole("status")).toContainText("Email kích hoạt đã gửi");
    // Resend from the member menu issues a fresh link and voids the first one.
    const first = linkIn((await lastMail(INVITEE, /Lời mời tham gia/)).text);
    await page.getByRole("button", { name: "Thao tác cho Phan Thảo" }).click();
    await page.getByRole("menuitem", { name: "Gửi lại email kích hoạt" }).click();
    await expect(page.getByRole("status")).toContainText("Đã gửi lại");
    let second = first;
    for (let i = 0; i < 40 && second === first; i++) {
      second = linkIn((await lastMail(INVITEE, /Lời mời tham gia/)).text);
      if (second === first) await page.waitForTimeout(250);
    }
    expect(second).not.toBe(first);

    const invitee = await (await browser.newContext()).newPage();
    await invitee.goto(first.replace(/^https?:\/\/[^/]+/, ""));
    await expect(invitee.getByText("Lời mời đã hết hạn hoặc đã được dùng.")).toBeVisible();
    await invitee.goto(second.replace(/^https?:\/\/[^/]+/, ""));
    await expect(invitee.getByText(INVITEE)).toBeVisible();
    await invitee.getByLabel("Mật khẩu mới").fill(NEW_PW);
    await invitee.getByLabel("Nhập lại mật khẩu").fill(NEW_PW);
    await invitee.getByRole("button", { name: "Kích hoạt tài khoản" }).click();
    await invitee.waitForURL(/\/app\/(home|welcome)/);
  });

  test("changing the password from Me requires the current one", async ({ page }) => {
    await signIn(page, INVITEE, NEW_PW);
    await page.waitForURL(/\/app\/(home|welcome)/);
    await page.goto("/app/me?tab=security");
    await page.getByRole("button", { name: "Đổi mật khẩu" }).click();
    const dlg = page.getByRole("dialog");
    await dlg.getByLabel("Mật khẩu hiện tại").fill("sai-mat-khau1");
    await dlg.getByLabel("Mật khẩu mới", { exact: true }).fill("Doi12345mk");
    await dlg.getByLabel("Nhập lại mật khẩu mới").fill("Doi12345mk");
    await dlg.getByRole("button", { name: "Đổi mật khẩu" }).click();
    await expect(dlg.getByRole("alert")).toContainText("Mật khẩu hiện tại không đúng.");
    await dlg.getByLabel("Mật khẩu hiện tại").fill(NEW_PW);
    await dlg.getByRole("button", { name: "Đổi mật khẩu" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Đã đổi mật khẩu" })).toBeVisible();
  });
});

test.describe.serial("two-step sign-in", () => {
  const OWNER = `mfa-owner-${run}@example.com`;
  const STAFF = `mfa-staff-${run}@example.com`;
  let secret = "";
  let lastStep = 0;

  test("turned on from Me with an authenticator code; the next sign-in asks for a code", async ({ browser }) => {
    const page = await (await browser.newContext()).newPage();
    await setupWorkspace(page, { company: `MFA ${run}`, name: "Lý Hai Bước", email: OWNER });
    await page.goto("/app/me?tab=security");
    await page.getByRole("button", { name: "Bật xác minh hai bước" }).click();
    secret = (
      (await page
        .locator("code")
        .filter({ hasText: /^[A-Z2-7 ]{20,}$/ })
        .textContent()) ?? ""
    ).replace(/\s+/g, "");
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    await page.getByLabel("Mã 6 số").fill(hotp(secret, currentStep()));
    await page.getByRole("button", { name: "Xác nhận và bật" }).click();
    await expect(page.getByText("Lưu các mã khôi phục này")).toBeVisible();
    await page.getByRole("button", { name: "Đã lưu, tiếp tục" }).click();
    await expect(page.getByText("Đang bật.", { exact: false })).toBeVisible();

    const fresh = await (await browser.newContext()).newPage();
    await signIn(fresh, OWNER, PASSWORD);
    await expect(fresh.getByRole("heading", { name: "Xác minh hai bước" })).toBeVisible();
    await fresh.getByLabel("Mã xác minh").fill("000000" === hotp(secret, currentStep() + 1) ? "111111" : "000000");
    await fresh.getByRole("button", { name: "Xác nhận" }).click();
    await expect(fresh.getByText("Mã chưa đúng.")).toBeVisible();
    // The code that switched it on (this step) cannot be replayed; the next one works.
    lastStep = currentStep() + 1;
    await fresh.getByLabel("Mã xác minh").fill(hotp(secret, lastStep));
    await fresh.getByRole("button", { name: "Xác nhận" }).click();
    await fresh.waitForURL(/\/app\/(home|welcome)/);
  });

  test("a workspace that requires it sends people without it to set it up first", async ({ browser }) => {
    test.setTimeout(120_000);
    const admin = await (await browser.newContext()).newPage();
    await signIn(admin, OWNER, PASSWORD);
    // Each 30-second code works once: wait for a step after the one already used.
    while (currentStep() < lastStep) await admin.waitForTimeout(1000);
    await admin.getByLabel("Mã xác minh").fill(hotp(secret, currentStep() + 1));
    await admin.getByRole("button", { name: "Xác nhận" }).click();
    await admin.waitForURL(/\/app\//);
    const invited = await admin.request.post("/api/proxy/identity/members/invite", {
      headers: { "x-wos-csrf": "1" },
      data: { email: STAFF, displayName: "Nhân Viên Mới", password: PASSWORD },
    });
    expect(invited.status()).toBe(201);
    await admin.goto("/admin/workspace/security");
    const policy = admin.getByRole("region", { name: "Bắt buộc xác minh hai bước" });
    await policy.getByRole("switch").click();
    await expect(policy.getByText("Đang bắt buộc")).toBeVisible();

    const staff = await (await browser.newContext()).newPage();
    await signIn(staff, STAFF, PASSWORD);
    await staff.waitForURL(/\/setup-2fa/);
    await expect(staff.getByRole("heading", { name: "Bật xác minh hai bước để tiếp tục" })).toBeVisible();
    await staff.getByRole("button", { name: "Bật xác minh hai bước" }).click();
    const s2 = (
      (await staff
        .locator("code")
        .filter({ hasText: /^[A-Z2-7 ]{20,}$/ })
        .textContent()) ?? ""
    ).replace(/\s+/g, "");
    await staff.getByLabel("Mã 6 số").fill(hotp(s2, currentStep()));
    await staff.getByRole("button", { name: "Xác nhận và bật" }).click();
    await staff.getByRole("button", { name: "Đã lưu, tiếp tục" }).click();
    await staff.waitForURL(/\/app\/home/);
    await expect(staff.getByRole("heading", { level: 1 })).toBeVisible();
  });
});
