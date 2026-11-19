import { createHash, randomBytes } from "node:crypto";
import type { Pool } from "pg";
import { emailLayout, type Mailer } from "@workspace/service-kit";

export type TokenPurpose = "reset" | "activate";
const TTL: Record<TokenPurpose, number> = { reset: 60 * 60_000, activate: 7 * 24 * 3600_000 };

const hash = (t: string) => createHash("sha256").update(t).digest("hex");

/** One-time token; only its hash is stored. Issuing a new one revokes older unused ones of the same purpose. */
export async function issueToken(pool: Pool, input: { userId: string; email: string; purpose: TokenPurpose }): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await pool.query("UPDATE account_tokens SET used_at = now() WHERE user_id = $1 AND purpose = $2 AND used_at IS NULL", [input.userId, input.purpose]);
  await pool.query("INSERT INTO account_tokens (token_hash, user_id, email, purpose, expires_at) VALUES ($1,$2,$3,$4, now() + $5 * interval '1 millisecond')", [
    hash(token),
    input.userId,
    input.email,
    input.purpose,
    TTL[input.purpose],
  ]);
  return token;
}

/** Returns the token's account if it is valid; does not consume it (the caller does after success). */
export async function peekToken(pool: Pool, token: string): Promise<{ userId: string; email: string; purpose: TokenPurpose } | null> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const r = await pool.query<{ user_id: string; email: string; purpose: TokenPurpose }>(
    "SELECT user_id, email, purpose FROM account_tokens WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()",
    [hash(token)],
  );
  const row = r.rows[0];
  return row ? { userId: row.user_id, email: row.email, purpose: row.purpose } : null;
}

/** Spends the token; false when it was already spent or expired (a second request with the same link). */
export async function consumeToken(pool: Pool, token: string): Promise<boolean> {
  const r = await pool.query("UPDATE account_tokens SET used_at = now() WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()", [hash(token)]);
  return (r.rowCount ?? 0) > 0;
}

/** Email language: the UI language of whoever triggered the email (x-locale); English unless that is Vietnamese. */
export type MailLocale = "vi" | "en";
export const mailLocale = (v: unknown): MailLocale => (v === "vi" ? "vi" : "en");

const MAIL = {
  vi: {
    resetTitle: "Đặt lại mật khẩu",
    resetBody:
      "Chúng tôi vừa nhận được yêu cầu đặt lại mật khẩu cho tài khoản workspace của bạn.\nLiên kết chỉ dùng được một lần và hết hạn sau 60 phút. Nếu bạn không yêu cầu, hãy bỏ qua email này; mật khẩu hiện tại vẫn giữ nguyên.",
    resetButton: "Đặt mật khẩu mới",
    resetSubject: "Đặt lại mật khẩu workspace",
    inviteTitle: (inviter: string, ws: string) => `${inviter} mời bạn vào ${ws}`,
    inviteBody: (ws: string) =>
      `${ws} dùng workspace để trao đổi, quản lý công việc và nhận bản tóm tắt mỗi sáng.\nBấm nút bên dưới để đặt mật khẩu và kích hoạt tài khoản. Liên kết có hiệu lực trong 7 ngày.`,
    inviteButton: "Kích hoạt tài khoản",
    inviteSubject: (ws: string) => `Lời mời tham gia ${ws} trên workspace`,
    addedTitle: (inviter: string, ws: string) => `${inviter} đã thêm bạn vào ${ws}`,
    addedBody: (to: string, ws: string) => `Bạn đã có tài khoản workspace nên không cần đăng ký lại.\nĐăng nhập bằng email ${to} và chọn workspace ${ws} ở góc trên bên trái.`,
    addedButton: "Đăng nhập",
    addedSubject: (ws: string) => `Bạn đã được thêm vào ${ws} trên workspace`,
    colleague: "Đồng nghiệp",
    yourWorkspace: "workspace của bạn",
  },
  en: {
    resetTitle: "Reset your password",
    resetBody:
      "We received a request to reset the password for your workspace account.\nThe link works once and expires in 60 minutes. If you did not ask for this, ignore this email; your current password stays the same.",
    resetButton: "Set a new password",
    resetSubject: "Reset your workspace password",
    inviteTitle: (inviter: string, ws: string) => `${inviter} invited you to ${ws}`,
    inviteBody: (ws: string) =>
      `${ws} uses workspace for chat, task management and a daily morning summary.\nClick the button below to set your password and activate your account. The link is valid for 7 days.`,
    inviteButton: "Activate account",
    inviteSubject: (ws: string) => `Invitation to join ${ws} on workspace`,
    addedTitle: (inviter: string, ws: string) => `${inviter} added you to ${ws}`,
    addedBody: (to: string, ws: string) =>
      `You already have a workspace account, so you don't need to sign up again.\nSign in with ${to} and pick the ${ws} workspace at the top left.`,
    addedButton: "Sign in",
    addedSubject: (ws: string) => `You were added to ${ws} on workspace`,
    colleague: "A colleague",
    yourWorkspace: "your workspace",
  },
};
export const mailText = (l: MailLocale) => MAIL[l];

export async function sendResetEmail(mailer: Mailer, appUrl: string, to: string, token: string, locale: MailLocale = "en") {
  const m = MAIL[locale];
  const { html, text } = emailLayout(m.resetTitle, m.resetBody, { label: m.resetButton, url: `${appUrl}/reset-password?token=${token}` }, locale);
  await mailer.send({ to, subject: m.resetSubject, html, text });
}

export async function sendInviteEmail(mailer: Mailer, appUrl: string, input: { to: string; inviter: string; workspace: string; token: string }, locale: MailLocale = "en") {
  const m = MAIL[locale];
  const { html, text } = emailLayout(
    m.inviteTitle(input.inviter, input.workspace),
    m.inviteBody(input.workspace),
    {
      label: m.inviteButton,
      url: `${appUrl}/activate?token=${input.token}`,
    },
    locale,
  );
  await mailer.send({ to: input.to, subject: m.inviteSubject(input.workspace), html, text });
}

export async function sendAddedEmail(mailer: Mailer, appUrl: string, input: { to: string; inviter: string; workspace: string }, locale: MailLocale = "en") {
  const m = MAIL[locale];
  const { html, text } = emailLayout(
    m.addedTitle(input.inviter, input.workspace),
    m.addedBody(input.to, input.workspace),
    {
      label: m.addedButton,
      url: `${appUrl}/login?email=${encodeURIComponent(input.to)}`,
    },
    locale,
  );
  await mailer.send({ to: input.to, subject: m.addedSubject(input.workspace), html, text });
}

/** The password rule lives in @workspace/shared: platform checks it too, when `/setup` creates the first account. */
export { passwordProblem } from "@workspace/shared";
