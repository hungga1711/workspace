import {
  BadGatewayException,
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Post,
  Put,
  Req,
  UnauthorizedException,
} from "@nestjs/common";
import type { Request } from "express";
import type { Pool } from "pg";
import { z } from "zod";
import { assertAllowed, emailLayout, logger, mailFrom, requirePrincipal, sendWithSettings, type Mailer } from "@workspace/service-kit";
import { clearMailSettings, getMailSettings, MAIL_PROVIDERS, saveMailSettings, savedPassword, toMailSettings } from "./mail-settings.js";
import { authorize, withTransaction } from "@workspace/shared";
import type { UserDirectory } from "./auth/users.js";
import { consumeToken, issueToken, mailLocale, mailText, passwordProblem, peekToken, sendInviteEmail, sendAddedEmail, sendResetEmail, type MailLocale } from "./accounts.js";
import { audit, inContext } from "./repo.js";

const MailBody = z.object({
  provider: z.enum(MAIL_PROVIDERS),
  host: z.string().trim().min(1).max(253),
  port: z.coerce.number().int().min(1).max(65535),
  security: z.enum(["tls", "starttls", "none"]),
  username: z
    .string()
    .trim()
    .max(320)
    .nullable()
    .transform((v) => v || null),
  password: z.string().max(1000).nullable().optional(),
  fromAddress: z.string().trim().email().max(320),
  fromName: z
    .string()
    .trim()
    .max(120)
    .nullable()
    .transform((v) => v || null),
});

export const ACCOUNTS = Symbol("ACCOUNTS");
export interface AccountsDeps {
  pool: Pool;
  users: UserDirectory;
  mailer: Mailer;
  appUrl: string;
}

function parse<S extends z.ZodTypeAny>(schema: S, body: unknown): z.output<S> {
  const r = schema.safeParse(body);
  if (!r.success) throw new BadRequestException(r.error.issues.map((i) => i.message).join("; "));
  return r.data;
}

function requireGateway(req: Request) {
  const p = requirePrincipal(req);
  if (p.type !== "service" || !authorize(p, "account.recover").allowed) throw new ForbiddenException("gateway only");
}

/**
 * Account self-service behind our own sign-in screens: forgot/reset password, invite activation, change password,
 * resend invite.
 */
@Controller()
export class AccountsController {
  constructor(@Inject(ACCOUNTS) private readonly d: AccountsDeps) {}

  /**
   * Always 202, whether or not the email exists (no account enumeration). The lookup and the email run
   * after the answer, so response time does not reveal whether an account exists either.
   */
  @Post("internal/accounts/password-reset")
  @HttpCode(202)
  async requestReset(@Req() req: Request, @Body() body: unknown) {
    requireGateway(req);
    const b = parse(z.object({ email: z.string().email(), locale: z.string().max(10).optional() }), body);
    void (async () => {
      const userId = await this.d.users.findUserByEmail(b.email);
      if (!userId) return;
      const token = await issueToken(this.d.pool, { userId, email: b.email, purpose: "reset" });
      await sendResetEmail(this.d.mailer, this.d.appUrl, b.email, token, mailLocale(b.locale));
    })().catch((err) => logger.error({ err }, "password reset failed"));
    // Whether this server can email at all is not about the account: without SMTP the screen says to ask an admin
    // (who can make a reset link) instead of promising an email that never comes.
    return { ok: true, mailConfigured: this.d.mailer.configured !== false };
  }

  @Post("internal/accounts/token")
  @HttpCode(200)
  async inspect(@Req() req: Request, @Body() body: unknown) {
    requireGateway(req);
    const b = parse(z.object({ token: z.string() }), body);
    const t = await peekToken(this.d.pool, b.token);
    if (!t) throw new NotFoundException({ error: "invalid_token", message: "link expired or already used" });
    return { email: t.email, purpose: t.purpose };
  }

  /** Sets the password from a reset or activation link, then signs the account out everywhere. */
  @Post("internal/accounts/password-set")
  @HttpCode(200)
  async setFromToken(@Req() req: Request, @Body() body: unknown) {
    requireGateway(req);
    const b = parse(z.object({ token: z.string(), password: z.string() }), body);
    const problem = passwordProblem(b.password);
    if (problem) throw new BadRequestException({ error: "weak_password", ...problem });
    const t = await peekToken(this.d.pool, b.token);
    if (!t) throw new NotFoundException({ error: "invalid_token", message: "link expired or already used" });
    // Spend the link first: two requests racing with the same link cannot both set a password.
    if (!(await consumeToken(this.d.pool, b.token))) throw new NotFoundException({ error: "invalid_token", message: "link expired or already used" });
    // Every session ends: whoever had the old password is signed out.
    await this.d.users.setPassword(t.userId, b.password);
    await this.d.pool.query("INSERT INTO auth_events (type, user_id, email) VALUES ($1,$2,$3)", [
      t.purpose === "reset" ? "RESET_PASSWORD" : "UPDATE_PASSWORD",
      t.userId,
      t.email.toLowerCase(),
    ]);
    await inContext(this.d.pool, (c) => audit(c, t.purpose === "activate" ? "account.activated" : "account.password_reset", "member", t.userId, {}));
    return { email: t.email, purpose: t.purpose };
  }

  /** Change password while signed in: the current password is checked first. */
  @Post("me/password")
  @HttpCode(204)
  async change(@Req() req: Request, @Body() body: unknown) {
    const p = requirePrincipal(req);
    if (p.type !== "user") throw new ForbiddenException();
    const b = parse(z.object({ current: z.string().min(1), next: z.string() }), body);
    const problem = passwordProblem(b.next);
    if (problem) throw new BadRequestException({ error: "weak_password", ...problem });
    const user = await this.d.users.userById(p.id);
    if (!user) throw new NotFoundException();
    if (!(await this.d.users.verifyPassword(user.email, b.current))) throw new UnauthorizedException({ error: "wrong_password", message: "current password is wrong" });
    // Other devices are signed out; this one carries on (its next token carries the new account version).
    await this.d.users.setPassword(p.id, b.next, req.sessionId);
    await this.d.pool.query("INSERT INTO auth_events (type, user_id, email) VALUES ('UPDATE_PASSWORD',$1,$2)", [p.id, user.email.toLowerCase()]);
    await withTransaction(this.d.pool, (c) => audit(c, "account.password_changed", "member", p.id, {}));
  }

  /** "Tên gọi": what the app calls me in greetings. Vietnamese names default to the last word; anyone can change it. */
  @Get("me/name")
  async myName(@Req() req: Request) {
    const p = requirePrincipal(req);
    if (p.type !== "user") throw new ForbiddenException();
    const user = await this.d.users.userById(p.id);
    if (!user) throw new NotFoundException();
    return { givenName: user.firstName };
  }

  @Put("me/name")
  @HttpCode(204)
  async setMyName(@Req() req: Request, @Body() body: unknown) {
    const p = requirePrincipal(req);
    if (p.type !== "user") throw new ForbiddenException();
    const b = parse(
      z.object({
        givenName: z
          .string()
          .trim()
          .min(1)
          .max(40)
          .regex(/^[\p{L}\p{M}' .-]+$/u, "letters only"),
      }),
      body,
    );
    await this.d.users.setGivenName(p.id, b.givenName);
    await withTransaction(this.d.pool, (c) => audit(c, "account.given_name_set", "member", p.id, { givenName: b.givenName }));
  }

  /** Whether this server can send email at all, and where the settings come from (saved in the app, or .env). */
  @Get("mail/status")
  async mailStatus(@Req() req: Request) {
    requirePrincipal(req);
    const configured = this.d.mailer.configured !== false;
    const saved = await getMailSettings(this.d.pool).catch(() => null);
    return { configured, from: configured ? mailFrom() : null, source: saved ? "app" : configured ? "env" : null };
  }

  /** Admin › Settings › Email: the saved SMTP settings (never the password). */
  @Get("mail/settings")
  async mailSettings(@Req() req: Request) {
    const p = requirePrincipal(req);
    assertAllowed(p, "workspace.configure");
    return { settings: await getMailSettings(this.d.pool), envConfigured: !!process.env.SMTP_URL };
  }

  /** Saves SMTP settings; they apply to every email at once, no restart. An empty password field keeps the stored one. */
  @Put("mail/settings")
  async saveMail(@Req() req: Request, @Body() body: unknown) {
    const p = requirePrincipal(req);
    assertAllowed(p, "workspace.configure");
    const b = parse(MailBody, body);
    await saveMailSettings(this.d.pool, { ...b, password: b.password === "" ? undefined : b.password }, p.id);
    await withTransaction(this.d.pool, (c) => audit(c, "workspace.mail_configured", "workspace", "mail", { provider: b.provider, host: b.host, port: b.port }));
    return { settings: await getMailSettings(this.d.pool) };
  }

  /** Forgets the saved settings: email falls back to SMTP_URL, or off. */
  @Delete("mail/settings")
  @HttpCode(204)
  async clearMail(@Req() req: Request) {
    const p = requirePrincipal(req);
    assertAllowed(p, "workspace.configure");
    await clearMailSettings(this.d.pool);
    await withTransaction(this.d.pool, (c) => audit(c, "workspace.mail_cleared", "workspace", "mail", {}));
  }

  /**
   * Admin › Settings › Email: sends a short test message to the admin who asked, with the settings in the form when
   * given (so they can be checked before saving), else the ones in use. The answer carries the mail server's own error
   * text when it refuses (wrong password, blocked port), which is what the admin needs to fix it.
   */
  @Post("mail/test")
  @HttpCode(200)
  async mailTest(@Req() req: Request, @Body() body: unknown) {
    const p = requirePrincipal(req);
    assertAllowed(p, "workspace.configure");
    if (p.type !== "user") throw new ForbiddenException();
    const u = await this.d.users.byId(p.id);
    if (!u) throw new NotFoundException();
    const draft = body && typeof body === "object" && Object.keys(body).length ? parse(MailBody, body) : null;
    if (!draft && this.d.mailer.configured === false) return { ok: false, to: u.email, error: "mail_not_configured" };
    const locale = mailLocale(req.headers["x-locale"]);
    const title = locale === "vi" ? "Email thử từ workspace" : "Test email from workspace";
    const text0 =
      locale === "vi"
        ? "Máy chủ email của công ty đã gửi được thư. Lời mời và đặt lại mật khẩu sẽ đến hộp thư."
        : "Your company's mail server sent this message. Invitations and password resets will arrive by email.";
    try {
      const { html, text } = emailLayout(title, text0, undefined, locale);
      if (draft) {
        const password = draft.password ? draft.password : await savedPassword(this.d.pool);
        const s = toMailSettings(
          { host: draft.host, port: draft.port, security: draft.security, username: draft.username, from_address: draft.fromAddress, from_name: draft.fromName },
          password,
        );
        await sendWithSettings(s, { to: u.email, subject: title, html, text });
      } else await this.d.mailer.send({ to: u.email, subject: title, html, text });
      return { ok: true, to: u.email, error: null };
    } catch (e) {
      logger.warn({ err: e }, "test email failed");
      return { ok: false, to: u.email, error: e instanceof Error ? e.message.slice(0, 300) : "send_failed" };
    }
  }

  /**
   * (Re)sends the activation email for a pending invite. When the email cannot go out (no SMTP, relay down) the
   * answer is 502 `email_not_sent` carrying the activation link, so the admin can hand it over another way.
   */
  @Post("members/:userId/invite/resend")
  @HttpCode(200)
  async resend(@Req() req: Request, @Param("userId") userId: string) {
    const p = requirePrincipal(req);
    assertAllowed(p, "member.invite");
    try {
      return await sendActivation(this.d, userId, p.id, { locale: mailLocale(req.headers["x-locale"]) });
    } catch (e) {
      if (e instanceof ActivationMailError) throw new BadGatewayException({ error: "email_not_sent", message: "the invitation email could not be sent", url: e.url, kind: e.kind });
      throw e;
    }
  }
}

/** The email failed after the link was made: callers show the link instead (`url`), and say the email did not go out. */
export class ActivationMailError extends Error {
  constructor(
    readonly url: string,
    readonly kind: "activate" | "login",
    override readonly cause: unknown,
  ) {
    super("activation email not sent");
    this.name = "ActivationMailError";
  }
}

/** The link an invited person needs: a fresh activation link (new accounts) or the sign-in page (existing ones). */
export async function activationLink(d: AccountsDeps, userId: string): Promise<{ url: string; kind: "activate" | "login" }> {
  const member = await withTransaction(
    d.pool,
    async (c) => (await c.query<{ email: string; status: string }>("SELECT email, status FROM members WHERE user_id = $1", [userId])).rows[0],
  );
  if (!member) throw new NotFoundException("member not found");
  if (member.status !== "invited") throw new BadRequestException({ error: "already_active", message: "member already active" });
  const u = await d.users.byId(userId);
  // Someone who already has a password (set by the inviter, or before a disable and re-invite) just signs in.
  if (u?.password_hash) return { url: `${d.appUrl}/login?email=${encodeURIComponent(member.email)}`, kind: "login" };
  // A new link replaces the one in the email (one live activation link per person).
  const token = await issueToken(d.pool, { userId, email: member.email, purpose: "activate" });
  return { url: `${d.appUrl}/activate?token=${token}`, kind: "activate" };
}

/** Emails an activation link to an invited member (invite → set password → sign in on our own screen). */
export async function sendActivation(
  d: AccountsDeps,
  userId: string,
  inviterId: string,
  opts: { existingAccount?: boolean; locale?: MailLocale } = {},
): Promise<{ url: string; kind: "activate" | "login" }> {
  const locale = opts.locale ?? "vi";
  const mt = mailText(locale);
  const info = await withTransaction(d.pool, async (c) => {
    const m = await c.query<{ email: string; status: string }>("SELECT email, status FROM members WHERE user_id = $1", [userId]);
    const inviter = await c.query<{ display_name: string }>("SELECT display_name FROM members WHERE user_id = $1", [inviterId]);
    const ws = await c.query<{ workspace_name: string | null }>("SELECT workspace_name FROM workspace_settings");
    return { member: m.rows[0], inviter: inviter.rows[0]?.display_name ?? mt.colleague, workspace: ws.rows[0]?.workspace_name ?? mt.yourWorkspace };
  });
  if (!info.member) throw new NotFoundException("member not found");
  if (info.member.status !== "invited") throw new BadRequestException({ error: "already_active", message: "member already active" });
  if (opts.existingAccount) {
    const url = `${d.appUrl}/login?email=${encodeURIComponent(info.member.email)}`;
    try {
      await sendAddedEmail(d.mailer, d.appUrl, { to: info.member.email, inviter: info.inviter, workspace: info.workspace }, locale);
    } catch (e) {
      throw new ActivationMailError(url, "login", e);
    }
    return { url, kind: "login" };
  }
  const token = await issueToken(d.pool, { userId, email: info.member.email, purpose: "activate" });
  const url = `${d.appUrl}/activate?token=${token}`;
  try {
    await sendInviteEmail(d.mailer, d.appUrl, { to: info.member.email, inviter: info.inviter, workspace: info.workspace, token }, locale);
  } catch (e) {
    throw new ActivationMailError(url, "activate", e);
  }
  return { url, kind: "activate" };
}
