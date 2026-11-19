import { BadRequestException, ConflictException, Controller, Delete, ForbiddenException, Get, HttpCode, Inject, NotFoundException, Param, Post, Query, Req } from "@nestjs/common";
import type { Request } from "express";
import type { Pool } from "pg";
import { withTransaction } from "@workspace/shared";
import { assertAllowed, requirePrincipal } from "@workspace/service-kit";
import { POOL } from "./identity.controller.js";
import { audit, MemberStateError } from "./repo.js";
import { setMembershipEnabled } from "./members.js";
import { AUTH, type AuthDeps } from "./auth/auth.controller.js";

const SIGN_IN_TYPES = ["LOGIN", "LOGIN_ERROR", "LOGOUT", "UPDATE_PASSWORD", "RESET_PASSWORD"];

interface EventRow {
  at: Date;
  type: string;
  user_id: string | null;
  email: string | null;
  ip: string | null;
  error: string | null;
}

/**
 * Security: a person's own sessions and sign-in history, and for admins the workspace's sign-in log and "sign this
 * member out everywhere" (auth_sessions, auth_events).
 */
@Controller()
export class SecurityController {
  constructor(
    @Inject(POOL) private readonly pool: Pool,
    @Inject(AUTH) private readonly a: AuthDeps,
  ) {}

  @Get("me/sessions")
  async mySessions(@Req() req: Request) {
    const p = requirePrincipal(req);
    if (p.type !== "user") throw new ForbiddenException();
    const sessions = await this.a.auth.listSessions(p.id);
    const events = (
      await this.pool.query<EventRow>("SELECT at, type, ip, error FROM auth_events WHERE user_id = $1 AND type = ANY($2) ORDER BY at DESC LIMIT 30", [p.id, SIGN_IN_TYPES])
    ).rows;
    return {
      sessions: sessions.map((s) => ({
        id: s.id,
        ip: s.ip,
        startedAt: s.created_at.toISOString(),
        lastSeenAt: s.last_seen_at.toISOString(),
        current: s.id === req.sessionId,
        method: s.method,
        userAgent: s.user_agent,
      })),
      history: events.map((e) => ({ at: e.at.toISOString(), type: e.type, ip: e.ip, error: e.error })),
    };
  }

  @Delete("me/sessions/:id")
  @HttpCode(204)
  async endMine(@Req() req: Request, @Param("id") id: string) {
    const p = requirePrincipal(req);
    if (p.type !== "user" || !(await this.a.auth.endSession(p.id, id))) throw new NotFoundException("session not found");
    await withTransaction(this.pool, (c) => audit(c, "account.session_ended", "member", p.id, {}));
  }

  @Post("me/sessions/logout-all")
  @HttpCode(204)
  async logoutAllMine(@Req() req: Request) {
    const p = requirePrincipal(req);
    if (p.type !== "user") throw new ForbiddenException();
    await this.a.auth.users.logoutAll(p.id);
    await withTransaction(this.pool, (c) => audit(c, "account.logout_all", "member", p.id, {}));
  }

  /** Admin: sign-ins of this workspace's members (successes, failures, sign-outs), newest first. */
  @Get("security/sign-ins")
  async signIns(@Req() req: Request, @Query("failed") failed?: string) {
    const p = requirePrincipal(req);
    assertAllowed(p, "audit.read");
    const members = await withTransaction(this.pool, async (c) => (await c.query<{ user_id: string; email: string }>("SELECT user_id, email FROM members")).rows);
    const byId = new Map(members.map((m) => [m.user_id, m.email]));
    const byEmail = new Map(members.map((m) => [m.email.toLowerCase(), m.user_id]));
    // Only the workspace's members: an account outlives a cancelled invite and keeps its sign-in history.
    const events = (
      await this.pool.query<EventRow>(
        `SELECT at, type, user_id, email, ip, error FROM auth_events
          WHERE type = ANY($1) AND (user_id = ANY($2) OR email = ANY($3)) ORDER BY at DESC LIMIT 1000`,
        [failed === "1" ? ["LOGIN_ERROR"] : SIGN_IN_TYPES, [...byId.keys()], [...byEmail.keys()]],
      )
    ).rows;
    const rows = events.flatMap((e) => {
      const userId = e.user_id && byId.has(e.user_id) ? e.user_id : e.email ? byEmail.get(e.email.toLowerCase()) : undefined;
      if (!userId) return [];
      return [{ at: e.at.toISOString(), type: e.type, userId, email: byId.get(userId)!, ip: e.ip, error: e.error }];
    });
    const day = Date.now() - 86400_000;
    return {
      signIns: rows.slice(0, 200),
      summary: {
        logins24h: rows.filter((r) => r.type === "LOGIN" && Date.parse(r.at) > day).length,
        failures24h: rows.filter((r) => r.type === "LOGIN_ERROR" && Date.parse(r.at) > day).length,
        activeUsers7d: (
          await withTransaction(this.pool, (c) =>
            c.query<{ n: number }>("SELECT count(*)::int AS n FROM members WHERE status = 'active' AND last_seen_at > now() - interval '7 days'"),
          )
        ).rows[0]!.n,
      },
    };
  }

  /**
   * Access review (SOC 2 style): every member with roles, admin rights and last activity, plus API keys, so an admin
   * can confirm who still needs access and disable the rest.
   */
  @Get("security/access-review")
  async accessReview(@Req() req: Request) {
    const p = requirePrincipal(req);
    assertAllowed(p, "audit.read");
    return withTransaction(this.pool, async (c) => ({
      members: (
        await c.query(
          `SELECT m.user_id AS "userId", m.email, m.display_name AS "displayName", m.status, m.is_owner AS "isOwner", m.created_at AS "createdAt", m.last_seen_at AS "lastSeenAt",
                coalesce(array_agg(DISTINCT r.name) FILTER (WHERE r.name IS NOT NULL), '{}') AS roles,
                bool_or(g.permission IN ('member.manage', 'role.manage', 'workspace.configure')) AS admin
           FROM members m
           LEFT JOIN member_roles mr ON mr.user_id = m.user_id
           LEFT JOIN roles r ON r.id = mr.role_id
           LEFT JOIN role_grants g ON g.role_id = r.id
          GROUP BY m.user_id ORDER BY m.last_seen_at NULLS FIRST, m.display_name LIMIT 5000`,
        )
      ).rows.map((r) => ({ ...r, admin: !!r.admin })),
      apiKeys: (
        await c.query(
          `SELECT id, name, permissions, created_by AS "createdBy", created_at AS "createdAt", last_used_at AS "lastUsedAt", expires_at AS "expiresAt"
           FROM api_keys WHERE revoked_at IS NULL ORDER BY last_used_at NULLS FIRST LIMIT 500`,
        )
      ).rows,
    }));
  }

  /**
   * Admin › Members › one person: account facts the member list does not show (two-step sign-in, last seen), their
   * live sessions, recent sign-ins and the latest audit entries by or about them. Job, leave and attendance come from
   * the employee module.
   */
  @Get("members/:userId/overview")
  async memberOverview(@Req() req: Request, @Param("userId") userId: string) {
    const p = requirePrincipal(req);
    assertAllowed(p, "member.manage");
    const m = (
      await this.pool.query<{ email: string; displayName: string; status: string; isOwner: boolean; createdAt: Date; lastSeenAt: Date | null; roles: string[] }>(
        `SELECT m.email, m.display_name AS "displayName", m.status, m.is_owner AS "isOwner", m.created_at AS "createdAt", m.last_seen_at AS "lastSeenAt",
                coalesce(array_agg(r.name ORDER BY r.name) FILTER (WHERE r.name IS NOT NULL), '{}') AS roles
           FROM members m LEFT JOIN member_roles mr ON mr.user_id = m.user_id LEFT JOIN roles r ON r.id = mr.role_id
          WHERE m.user_id = $1 GROUP BY m.user_id`,
        [userId],
      )
    ).rows[0];
    if (!m) throw new NotFoundException("member not found");
    const [mfa, sessions, signIns, activity] = await Promise.all([
      this.pool.query<{ on: boolean }>("SELECT coalesce(totp_enabled, false) AS on FROM users WHERE id = $1", [userId]),
      this.a.auth.listSessions(userId),
      this.pool.query<EventRow>("SELECT at, type, ip, error FROM auth_events WHERE user_id = $1 AND type = ANY($2) ORDER BY at DESC LIMIT 8", [userId, SIGN_IN_TYPES]),
      this.pool.query<{ id: string; actor: string; action: string; at: Date }>(
        "SELECT id, actor, action, at FROM audit_log WHERE resource_id = $1 OR actor = $1 ORDER BY at DESC LIMIT 15",
        [userId],
      ),
    ]);
    return {
      member: { ...m, twoStep: mfa.rows[0]?.on ?? false },
      sessions: sessions.map((s) => ({
        id: s.id,
        ip: s.ip,
        startedAt: s.created_at.toISOString(),
        lastSeenAt: s.last_seen_at.toISOString(),
        method: s.method,
        userAgent: s.user_agent,
      })),
      signIns: signIns.rows.map((e) => ({ at: e.at.toISOString(), type: e.type, ip: e.ip, error: e.error })),
      activity: activity.rows.map((a) => ({ id: a.id, actor: a.actor, action: a.action, at: a.at.toISOString() })),
    };
  }

  /** Admin: ends every session of a member (lost laptop, departure). */
  @Post("members/:userId/sessions/logout")
  @HttpCode(204)
  async logoutMember(@Req() req: Request, @Param("userId") userId: string) {
    const p = requirePrincipal(req);
    assertAllowed(p, "member.manage");
    await withTransaction(this.pool, async (c) => {
      const target = (await c.query<{ is_owner: boolean }>("SELECT is_owner FROM members WHERE user_id = $1", [userId])).rows[0];
      if (!target) throw new NotFoundException("member not found");
      // Like the owner's password and two-step resets: only the owner may end the owner's sessions.
      if (target.is_owner && userId !== p.id) throw new ForbiddenException({ error: "owner_only", message: "only the owner can sign the owner out" });
      await this.a.auth.users.logoutAll(userId, "admin_logout");
      await audit(c, "member.logout_all", "member", userId, {});
    });
  }

  /** Admin: offboarding. Disables the membership and signs the person out everywhere. */
  @Post("members/:userId/disable")
  @HttpCode(204)
  async disableMember(@Req() req: Request, @Param("userId") userId: string) {
    const p = requirePrincipal(req);
    assertAllowed(p, "member.manage");
    if (userId === p.id) throw new BadRequestException({ error: "cannot_disable_self", message: "you cannot deactivate your own account" });
    await this.setEnabled(userId, false);
  }

  /** Admin: brings a disabled member back. */
  @Post("members/:userId/enable")
  @HttpCode(204)
  async enableMember(@Req() req: Request, @Param("userId") userId: string) {
    const p = requirePrincipal(req);
    assertAllowed(p, "member.manage");
    await this.setEnabled(userId, true);
  }

  private async setEnabled(userId: string, enabled: boolean): Promise<boolean> {
    try {
      return await setMembershipEnabled({ pool: this.pool, users: this.a.auth.users }, userId, enabled);
    } catch (e) {
      if (e instanceof MemberStateError) {
        if (e.code === "not_found") throw new NotFoundException("member not found");
        if (e.code === "owner") throw new ConflictException({ error: "owner_cannot_be_disabled", message: "the workspace owner cannot be deactivated" });
        throw new ConflictException({ error: "member_invited", message: "this person has not accepted the invitation yet: cancel the invitation instead" });
      }
      throw e;
    }
  }
}
