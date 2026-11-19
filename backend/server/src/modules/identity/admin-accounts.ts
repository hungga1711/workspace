import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, HttpCode, Inject, NotFoundException, Param, Post, Req } from "@nestjs/common";
import type { Request } from "express";
import { randomInt } from "node:crypto";
import { z } from "zod";
import { withTransaction } from "@workspace/shared";
import { assertAllowed, requirePrincipal } from "@workspace/service-kit";
import { ACCOUNTS, activationLink, type AccountsDeps } from "./accounts.controller.js";
import { issueToken, passwordProblem } from "./accounts.js";
import { audit, emit } from "./repo.js";

function parse<S extends z.ZodTypeAny>(schema: S, body: unknown): z.output<S> {
  const r = schema.safeParse(body);
  if (!r.success) throw new BadRequestException(r.error.issues.map((i) => i.message).join("; "));
  return r.data;
}

/** Letters and digits only, no look-alikes (0/O, 1/l/I): a password read out loud or typed from a note. */
export function temporaryPassword(length = 12): string {
  const alphabet = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < length; i++) out += alphabet[randomInt(alphabet.length)];
  // The password rule needs a letter and a digit; the alphabet mix makes that overwhelmingly likely, this guarantees it.
  return /[A-Za-z]/.test(out) && /\d/.test(out) ? out : temporaryPassword(length);
}

/**
 * What an admin does for a locked-out colleague when there is no email, or no phone: a temporary password
 * (replaced at first sign-in), a two-step reset (lost authenticator and recovery codes), the activation link of a
 * pending invite, and handing the workspace to another owner. Every action is audited.
 */
@Controller()
export class AdminAccountsController {
  constructor(@Inject(ACCOUNTS) private readonly d: AccountsDeps) {}

  /** Admin: a temporary password for a member (given, or generated and shown once); every session of theirs ends. */
  @Post("members/:userId/password/reset")
  @HttpCode(200)
  async resetPassword(@Req() req: Request, @Param("userId") userId: string, @Body() body: unknown) {
    const p = requirePrincipal(req);
    assertAllowed(p, "member.manage");
    if (userId === p.id) throw new BadRequestException({ error: "use_change_password", message: "change your own password from your profile" });
    const b = parse(z.object({ password: z.string().max(128).optional() }), body);
    const member = await this.member(userId);
    if (member.is_owner && !(await this.isOwner(p.id))) throw new ForbiddenException({ error: "owner_only", message: "only the owner can reset the owner's password" });
    const u = await this.d.users.byId(userId);
    if (!u) throw new NotFoundException("account not found");
    const password = b.password ?? temporaryPassword();
    const problem = passwordProblem(password);
    if (problem) throw new BadRequestException({ error: "weak_password", ...problem });
    await this.d.users.setPassword(userId, password, undefined, { mustChange: true });
    await this.d.pool.query("INSERT INTO auth_events (type, user_id, email) VALUES ('RESET_PASSWORD',$1,$2)", [userId, u.email.toLowerCase()]);
    await withTransaction(this.d.pool, (c) => audit(c, "member.password_reset", "member", userId, { generated: !b.password }));
    // Shown once to the admin, who hands it over; the person replaces it at first sign-in.
    return { password, email: u.email };
  }

  /** Admin: clears two-step sign-in (lost phone and recovery codes); the person sets it up again, or the policy makes them. */
  @Post("members/:userId/mfa/reset")
  @HttpCode(204)
  async resetMfa(@Req() req: Request, @Param("userId") userId: string) {
    const p = requirePrincipal(req);
    assertAllowed(p, "member.manage");
    const member = await this.member(userId);
    if (member.is_owner && !(await this.isOwner(p.id))) throw new ForbiddenException({ error: "owner_only", message: "only the owner can reset the owner's two-step sign-in" });
    const u = await this.d.users.byId(userId);
    if (!u) throw new NotFoundException("account not found");
    await this.d.pool.query("UPDATE users SET totp_enabled = false, totp_secret_enc = NULL, totp_pending_enc = NULL, totp_last_step = NULL, updated_at = now() WHERE id = $1", [
      userId,
    ]);
    await this.d.pool.query("DELETE FROM auth_recovery_codes WHERE user_id = $1", [userId]);
    // Sessions that passed the old second step end too: the next sign-in is password only (plus setup if required).
    await this.d.users.logoutAll(userId, "mfa_reset");
    await this.d.pool.query("INSERT INTO auth_events (type, user_id, email) VALUES ('MFA_DISABLED',$1,$2)", [userId, u.email.toLowerCase()]);
    await withTransaction(this.d.pool, (c) => audit(c, "member.mfa_reset", "member", userId, {}));
  }

  /**
   * Admin: a one-time password-reset link for a member who forgot their password on a server without email (or whose
   * email did not arrive). Same token as the emailed reset; the admin hands it over in person or by chat.
   */
  @Post("members/:userId/password/reset-link")
  @HttpCode(200)
  async resetLink(@Req() req: Request, @Param("userId") userId: string) {
    const p = requirePrincipal(req);
    assertAllowed(p, "member.manage");
    const member = await this.member(userId);
    if (member.is_owner && !(await this.isOwner(p.id))) throw new ForbiddenException({ error: "owner_only", message: "only the owner can reset the owner's password" });
    const u = await this.d.users.byId(userId);
    if (!u) throw new NotFoundException("account not found");
    const token = await issueToken(this.d.pool, { userId, email: u.email, purpose: "reset" });
    await withTransaction(this.d.pool, (c) => audit(c, "member.password_reset_link", "member", userId, {}));
    return { url: `${this.d.appUrl}/reset-password?token=${token}`, email: u.email };
  }

  /** Admin: the link a pending invite needs, to hand over in person or by chat when email is not an option. */
  @Get("members/:userId/activation-link")
  async activation(@Req() req: Request, @Param("userId") userId: string) {
    const p = requirePrincipal(req);
    assertAllowed(p, "member.invite");
    const link = await activationLink(this.d, userId);
    await withTransaction(this.d.pool, (c) => audit(c, "member.activation_link", "member", userId, { kind: link.kind }));
    return link;
  }

  /**
   * The owner hands the workspace to another active member: they become the owner (and get the Owner role), the
   * previous owner keeps working as an Admin. Only the owner can do this; it cannot be undone except by the new owner.
   */
  @Post("workspace/owner")
  @HttpCode(200)
  async transferOwnership(@Req() req: Request, @Body() body: unknown) {
    const p = requirePrincipal(req);
    if (p.type !== "user") throw new ForbiddenException();
    const b = parse(z.object({ userId: z.string().min(1) }), body);
    if (!(await this.isOwner(p.id))) throw new ForbiddenException({ error: "owner_only", message: "only the owner can transfer ownership" });
    if (b.userId === p.id) throw new BadRequestException({ error: "already_owner", message: "you already own this workspace" });
    const target = await this.member(b.userId);
    if (target.status !== "active") throw new ConflictException({ error: "member_not_active", message: "the new owner must be an active member" });
    await withTransaction(this.d.pool, async (c) => {
      const roles = (await c.query<{ id: string; name: string }>("SELECT id, name FROM roles WHERE name IN ('Owner','Admin') AND system")).rows;
      const ownerRole = roles.find((r) => r.name === "Owner")?.id;
      const adminRole = roles.find((r) => r.name === "Admin")?.id;
      if (!ownerRole) throw new ConflictException({ error: "no_owner_role", message: "the Owner role is missing" });
      await c.query("UPDATE members SET is_owner = false, updated_at = now() WHERE user_id = $1", [p.id]);
      await c.query("UPDATE members SET is_owner = true, updated_at = now() WHERE user_id = $1", [b.userId]);
      await c.query("INSERT INTO member_roles (user_id, role_id) VALUES ($1,$2) ON CONFLICT DO NOTHING", [b.userId, ownerRole]);
      await c.query("DELETE FROM member_roles WHERE user_id = $1 AND role_id = $2", [p.id, ownerRole]);
      // The previous owner is not locked out of administration: Admin unless they already hold it.
      if (adminRole) await c.query("INSERT INTO member_roles (user_id, role_id) VALUES ($1,$2) ON CONFLICT DO NOTHING", [p.id, adminRole]);
      await audit(c, "workspace.owner_transferred", "member", b.userId, { from: p.id, to: b.userId });
      for (const userId of [p.id, b.userId]) {
        const roleIds = (await c.query<{ role_id: string }>("SELECT role_id FROM member_roles WHERE user_id = $1", [userId])).rows.map((r) => r.role_id);
        await emit(c, "identity.member.roles_changed.v1", "identity.member", userId, { userId, roleIds });
      }
    });
    return { ownerUserId: b.userId };
  }

  private async member(userId: string): Promise<{ status: string; is_owner: boolean; email: string }> {
    const m = await withTransaction(
      this.d.pool,
      async (c) => (await c.query<{ status: string; is_owner: boolean; email: string }>("SELECT status, is_owner, email FROM members WHERE user_id = $1", [userId])).rows[0],
    );
    if (!m) throw new NotFoundException("member not found");
    return m;
  }

  private async isOwner(userId: string): Promise<boolean> {
    return (await this.member(userId)).is_owner;
  }
}
