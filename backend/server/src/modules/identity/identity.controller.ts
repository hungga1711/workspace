import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
} from "@nestjs/common";
import type { Request } from "express";
import type { Pool } from "pg";
import { z } from "zod";
import { withTransaction, authorize, newId, SCOPES, type Principal } from "@workspace/shared";
import { assertAllowed, logger, parse, requirePrincipal } from "@workspace/service-kit";
import {
  bootstrapWorkspace,
  cancelInvite,
  createRole,
  deleteRole,
  deleteTeam,
  RoleStateError,
  TeamNotFoundError,
  updateRole,
  updateTeam,
  NotMemberError,
  resolveAgent,
  resolvePrincipal,
  setMemberRoles,
  UnknownPermissionError,
  validateGrants,
  audit,
} from "./repo.js";
import type { UserDirectory } from "./auth/users.js";
import { ACCOUNTS, type AccountsDeps } from "./accounts.controller.js";
import { mailLocale } from "./accounts.js";
import { inviteOne } from "./members.js";
import { PERMISSIONS } from "./catalog.js";

export const POOL = Symbol("POOL");
export const USERS = Symbol("USERS");

/** Role edits that the rules refuse: a missing role, a built-in one, one still assigned, or a taken name. */
function roleError(e: RoleStateError) {
  if (e.code === "not_found") return new NotFoundException("role not found");
  if (e.code === "system") return new ForbiddenException({ error: "system_role" });
  if (e.code === "assigned") return new ConflictException({ error: "role_assigned" });
  if (e.code === "owner_role") return new ForbiddenException({ error: "role_not_allowed" });
  return new ConflictException({ error: "name_taken" });
}

const grantSchema = z.object({ permission: z.string(), scope: z.enum(SCOPES) });

/** Tools an agent may be allowed; kept in step with the ai module's AGENT_TOOLS (modules do not share code). */
const AGENT_TOOL_NAMES = ["search_messages", "get_thread", "list_my_tasks", "create_task", "search_documents", "get_document", "project_status", "who_is_out"] as const;

/** Internal endpoints accept only service principals holding the PLATFORM-scoped permission. */
function requirePlatformService(req: Request, permission: string): Principal {
  const p = requirePrincipal(req);
  if (p.type !== "service" || !authorize(p, permission).allowed) {
    throw new ForbiddenException("platform service required");
  }
  return p;
}

@Controller()
export class IdentityController {
  constructor(
    @Inject(POOL) private readonly pool: Pool,
    @Inject(USERS) private readonly users: UserDirectory,
    @Inject(ACCOUNTS) private readonly accounts: AccountsDeps,
  ) {}

  @Get("health")
  health() {
    return { ok: true };
  }

  // ---- internal (the gateway and other modules) ----

  /** First-run setup refuses an email that already has an account. */
  @Post("internal/accounts/lookup")
  @HttpCode(200)
  async lookupAccount(@Req() req: Request, @Body() body: unknown) {
    requirePlatformService(req, "workspace.provision");
    const b = parse(z.object({ email: z.string().email() }), body);
    return { exists: (await this.users.findUserByEmail(b.email)) !== null };
  }

  /** First-run setup: the workspace's roles, its owner and default agents. */
  @Post("internal/workspace/bootstrap")
  @HttpCode(200)
  async bootstrap(@Req() req: Request, @Body() body: unknown) {
    requirePlatformService(req, "workspace.provision");
    const b = parse(
      z.object({
        name: z.string().min(1).max(100),
        owner: z.object({ email: z.string().email(), displayName: z.string().min(1).max(100), password: z.string().min(8).optional() }),
      }),
      body,
    );
    const userId = await this.users.ensureUser(b.owner.email, b.owner.displayName, b.owner.password);
    await bootstrapWorkspace(this.pool, { name: b.name, owner: { userId, email: b.owner.email, displayName: b.owner.displayName } });
    return { ownerUserId: userId };
  }

  @Post("internal/resolve")
  async resolve(@Req() req: Request, @Body() body: unknown) {
    requirePlatformService(req, "principal.resolve");
    const b = parse(z.object({ userId: z.string().min(1) }), body);
    try {
      return await resolvePrincipal(this.pool, b.userId);
    } catch (e) {
      if (e instanceof NotMemberError) throw new ForbiddenException("not a member");
      throw e;
    }
  }

  /** Members whose roles grant a permission for the whole workspace (e.g. the owner and AI policy admins). */
  @Get("internal/holders/:permission")
  async holders(@Req() req: Request, @Param("permission") permission: string) {
    requirePlatformService(req, "principal.resolve");
    return withTransaction(this.pool, async (c) => ({
      userIds: (
        await c.query<{ user_id: string }>(
          `SELECT DISTINCT m.user_id FROM members m
           JOIN member_roles mr ON mr.user_id = m.user_id
           JOIN role_grants g ON g.role_id = mr.role_id
          WHERE m.status = 'active' AND g.permission = $1 AND g.scope = 'WORKSPACE' ORDER BY m.user_id`,
          [permission],
        )
      ).rows.map((r) => r.user_id),
    }));
  }

  /** Emails of the members holding a permission (e.g. notices for whoever manages a setting). */
  @Get("internal/holders/:permission/emails")
  async holderEmails(@Req() req: Request, @Param("permission") permission: string) {
    requirePlatformService(req, "principal.resolve");
    return withTransaction(this.pool, async (c) => ({
      emails: (
        await c.query<{ email: string }>(
          `SELECT DISTINCT m.email FROM members m
           JOIN member_roles mr ON mr.user_id = m.user_id
           JOIN role_grants g ON g.role_id = mr.role_id
          WHERE m.status = 'active' AND g.permission = $1 AND g.scope = 'WORKSPACE' ORDER BY m.email`,
          [permission],
        )
      ).rows.map((r) => r.email),
    }));
  }

  /** Active members by email, for task sync (work) to match a source tool's assignees to people here. */
  @Post("internal/members/by-email")
  @HttpCode(200)
  async membersByEmail(@Req() req: Request, @Body() body: unknown) {
    requirePlatformService(req, "principal.resolve");
    const b = parse(z.object({ emails: z.array(z.string().max(320)).max(1000) }), body);
    const emails = [...new Set(b.emails.map((e) => e.trim().toLowerCase()).filter(Boolean))];
    if (!emails.length) return { members: [] };
    return withTransaction(this.pool, async (c) => ({
      members: (
        await c.query<{ email: string; user_id: string }>("SELECT lower(email) AS email, user_id FROM members WHERE status = 'active' AND lower(email) = ANY($1::text[])", [emails])
      ).rows.map((r) => ({ email: r.email, userId: r.user_id })),
    }));
  }

  @Post("internal/agents/resolve")
  async resolveAgent(@Req() req: Request, @Body() body: unknown) {
    requirePlatformService(req, "principal.resolve");
    const b = parse(z.object({ agentId: z.string().min(1) }), body);
    try {
      return await resolveAgent(this.pool, b.agentId);
    } catch (e) {
      if (e instanceof NotMemberError) throw new NotFoundException("agent not found or disabled");
      throw e;
    }
  }

  // ---- workspace (user principals via gateway) ----

  @Get("members")
  async members(@Req() req: Request) {
    const p = requirePrincipal(req);
    assertAllowed(p, "member.read");
    return withTransaction(this.pool, async (c) => {
      const r = await c.query(
        `SELECT m.user_id AS "userId", m.email, m.display_name AS "displayName", m.status, m.department_id AS "departmentId", m.is_owner AS "isOwner",
                coalesce(array_agg(r.name ORDER BY r.name) FILTER (WHERE r.name IS NOT NULL), '{}') AS roles
           FROM members m
           LEFT JOIN member_roles mr ON mr.user_id = m.user_id
           LEFT JOIN roles r ON r.id = mr.role_id
          GROUP BY m.user_id ORDER BY m.display_name`,
      );
      // "Active" means signed up and not deactivated: people who have not accepted their invitation are counted apart.
      return { members: r.rows, counts: { active: r.rows.filter((m) => m.status === "active").length } };
    });
  }

  @Post("members/invite")
  async invite(@Req() req: Request, @Body() body: unknown) {
    const p = requirePrincipal(req);
    assertAllowed(p, "member.invite");
    const b = parse(
      z.object({
        email: z.string().email(),
        displayName: z.string().min(1).max(100),
        roleNames: z.array(z.string()).default(["Employee"]),
        password: z.string().min(8).optional(),
        temporary: z.boolean().optional(),
      }),
      body,
    );
    return inviteOne({ pool: this.pool, users: this.users, accounts: this.accounts }, p, b, mailLocale(req.headers["x-locale"]));
  }

  /**
   * Bulk invite: up to 200 people pasted or imported from CSV. Rows are checked first
   * (email, duplicates, role names, already a member) and then invited one by one; each row gets its
   * own result.
   */
  @Post("members/invite/bulk")
  async inviteBulk(@Req() req: Request, @Body() body: unknown) {
    const p = requirePrincipal(req);
    assertAllowed(p, "member.invite");
    const b = parse(
      z.object({
        rows: z
          .array(z.object({ email: z.string().trim().max(200), displayName: z.string().trim().max(100), roleName: z.string().trim().max(60).optional() }))
          .min(1)
          .max(200),
      }),
      body,
    );
    const { roles, members } = await withTransaction(this.pool, async (c) => ({
      roles: (await c.query<{ name: string }>("SELECT name FROM roles")).rows.map((r) => r.name),
      members: new Set((await c.query<{ email: string }>("SELECT lower(email) AS email FROM members")).rows.map((r) => r.email)),
    }));
    const seen = new Set<string>();
    const results: { email: string; userId?: string; status: "invited" | "added" | "error"; error?: string; emailed?: boolean; activationUrl?: string | null }[] = [];
    for (const row of b.rows) {
      const email = row.email.toLowerCase();
      const role = row.roleName ? roles.find((r) => r.toLowerCase() === row.roleName!.toLowerCase()) : "Employee";
      const fail = (error: string) => results.push({ email: row.email, status: "error", error });
      if (!z.string().email().safeParse(email).success) {
        fail("invalid_email");
        continue;
      }
      if (!row.displayName) {
        fail("missing_name");
        continue;
      }
      if (seen.has(email)) {
        fail("duplicate_row");
        continue;
      }
      seen.add(email);
      if (!role) {
        fail("unknown_role");
        continue;
      }
      if (members.has(email)) {
        fail("already_member");
        continue;
      }
      try {
        const r = await inviteOne(
          { pool: this.pool, users: this.users, accounts: this.accounts },
          p,
          { email, displayName: row.displayName, roleNames: [role] },
          mailLocale(req.headers["x-locale"]),
        );
        results.push({ email: row.email, userId: r.userId, status: r.existingAccount ? "added" : "invited", emailed: r.emailed, activationUrl: r.activationUrl });
      } catch (e) {
        if (e instanceof ForbiddenException) {
          fail("role_not_allowed");
          continue;
        }
        logger.error({ err: e, email }, "bulk invite row failed");
        fail((e as { code?: string }).code === "23505" ? "already_member" : "failed");
      }
    }
    return { results, invited: results.filter((r) => r.status !== "error").length };
  }

  @Delete("members/:userId/invite")
  @HttpCode(204)
  async cancel(@Req() req: Request, @Param("userId") userId: string) {
    const p = requirePrincipal(req);
    assertAllowed(p, "member.invite");
    const ok = await withTransaction(this.pool, (c) => cancelInvite(c, userId));
    if (!ok) throw new NotFoundException("no pending invite");
  }

  @Get("roles")
  async roles(@Req() req: Request) {
    const p = requirePrincipal(req);
    assertAllowed(p, "member.read");
    return withTransaction(this.pool, async (c) => {
      const r = await c.query(
        `SELECT r.id, r.name, r.system, coalesce(json_agg(json_build_object('permission', g.permission, 'scope', g.scope) ORDER BY g.permission)
                FILTER (WHERE g.permission IS NOT NULL), '[]') AS grants
           FROM roles r LEFT JOIN role_grants g ON g.role_id = r.id
          GROUP BY r.id ORDER BY r.name`,
      );
      return { roles: r.rows };
    });
  }

  @Post("roles")
  async createRole(@Req() req: Request, @Body() body: unknown) {
    const p = requirePrincipal(req);
    assertAllowed(p, "role.manage");
    const b = parse(z.object({ name: z.string().min(1).max(60), grants: z.array(grantSchema).min(1) }), body);
    try {
      return { id: await withTransaction(this.pool, (c) => createRole(c, b.name, b.grants)) };
    } catch (e) {
      if (e instanceof UnknownPermissionError) throw new BadRequestException(e.message);
      throw e;
    }
  }

  @Put("roles/:id")
  @HttpCode(204)
  async updateRole(@Req() req: Request, @Param("id") id: string, @Body() body: unknown) {
    const p = requirePrincipal(req);
    assertAllowed(p, "role.manage");
    const b = parse(z.object({ name: z.string().min(1).max(60).optional(), grants: z.array(grantSchema).min(1).optional() }), body);
    try {
      await withTransaction(this.pool, (c) => updateRole(c, id, b));
    } catch (e) {
      if (e instanceof UnknownPermissionError) throw new BadRequestException(e.message);
      if (e instanceof RoleStateError) throw roleError(e);
      throw e;
    }
  }

  /** `?force=1` removes the role from members still holding it (they keep Employee and their other roles). */
  @Delete("roles/:id")
  async deleteRole(@Req() req: Request, @Param("id") id: string, @Query("force") force?: string) {
    const p = requirePrincipal(req);
    assertAllowed(p, "role.manage");
    try {
      return await withTransaction(this.pool, (c) => deleteRole(c, id, force === "1"));
    } catch (e) {
      if (e instanceof RoleStateError) throw roleError(e);
      throw e;
    }
  }

  @Put("members/:userId/roles")
  @HttpCode(204)
  async setRoles(@Req() req: Request, @Param("userId") userId: string, @Body() body: unknown) {
    const p = requirePrincipal(req);
    assertAllowed(p, "role.manage");
    const b = parse(z.object({ roleIds: z.array(z.string()).min(1) }), body);
    try {
      await withTransaction(this.pool, (c) => setMemberRoles(c, userId, b.roleIds));
    } catch (e) {
      if (e instanceof NotMemberError) throw new NotFoundException("member not found");
      if (e instanceof RoleStateError) throw roleError(e);
      throw e;
    }
  }

  @Get("teams")
  async teams(@Req() req: Request) {
    const p = requirePrincipal(req);
    assertAllowed(p, "member.read");
    return withTransaction(this.pool, async (c) => ({
      teams: (
        await c.query(`SELECT t.id, t.name, coalesce(array_agg(tm.user_id) FILTER (WHERE tm.user_id IS NOT NULL), '{}') AS "memberIds"
          FROM teams t LEFT JOIN team_members tm ON tm.team_id = t.id GROUP BY t.id ORDER BY t.name`)
      ).rows,
    }));
  }

  /** Permission catalog for the role editor: names are fixed by the platform. */
  @Get("permissions")
  permissions(@Req() req: Request) {
    requirePrincipal(req);
    return { permissions: PERMISSIONS, scopes: SCOPES };
  }

  @Post("teams")
  async createTeam(@Req() req: Request, @Body() body: unknown) {
    const p = requirePrincipal(req);
    assertAllowed(p, "member.manage");
    const b = parse(z.object({ name: z.string().min(1).max(80), memberIds: z.array(z.string()).default([]) }), body);
    return withTransaction(this.pool, async (c) => {
      const id = newId();
      await c.query("INSERT INTO teams (id, name) VALUES ($1,$2)", [id, b.name]);
      for (const u of b.memberIds) await c.query("INSERT INTO team_members (team_id, user_id) VALUES ($1,$2)", [id, u]);
      await audit(c, "team.create", "team", id, { name: b.name, members: b.memberIds.length });
      return { id };
    });
  }

  @Patch("teams/:id")
  @HttpCode(204)
  async updateTeam(@Req() req: Request, @Param("id") id: string, @Body() body: unknown) {
    const p = requirePrincipal(req);
    assertAllowed(p, "member.manage");
    const b = parse(z.object({ name: z.string().min(1).max(80).optional(), memberIds: z.array(z.string()).optional() }), body);
    try {
      await withTransaction(this.pool, (c) => updateTeam(c, id, b));
    } catch (e) {
      if (e instanceof TeamNotFoundError) throw new NotFoundException("team not found");
      throw e;
    }
  }

  @Delete("teams/:id")
  @HttpCode(204)
  async deleteTeam(@Req() req: Request, @Param("id") id: string) {
    const p = requirePrincipal(req);
    assertAllowed(p, "member.manage");
    try {
      await withTransaction(this.pool, (c) => deleteTeam(c, id));
    } catch (e) {
      if (e instanceof TeamNotFoundError) throw new NotFoundException("team not found");
      throw e;
    }
  }

  /**
   * The caller's own permissions (names only), so the admin screens can show "no access" up front instead of forms
   * whose every save is refused. Each endpoint still checks its permission; this only shapes the UI.
   */
  @Get("me/permissions")
  myPermissions(@Req() req: Request) {
    const p = requirePrincipal(req);
    // `workspaceWide`: held for the whole company, which sections such as the company timesheet or all leave requests need.
    const wide = p.grants.filter((g) => g.scope === "WORKSPACE" || g.scope === "PLATFORM");
    return {
      permissions: [...new Set(p.grants.map((g) => g.permission))].sort(),
      workspaceWide: [...new Set(wide.map((g) => g.permission))].sort(),
    };
  }

  @Get("agents")
  async agents(@Req() req: Request) {
    const p = requirePrincipal(req);
    assertAllowed(p, "agent.invoke");
    return withTransaction(this.pool, async (c) => {
      const r = await c.query(
        `SELECT a.id, a.name, a.status, a.monthly_budget_tokens::bigint AS "budget", a.allowed_tools AS "allowedTools", a.description,
                coalesce(json_agg(json_build_object('permission', g.permission, 'scope', g.scope)) FILTER (WHERE g.permission IS NOT NULL), '[]') AS grants
           FROM agents a LEFT JOIN agent_grants g ON g.agent_id = a.id
          GROUP BY a.id ORDER BY a.name`,
      );
      return { agents: r.rows };
    });
  }

  /** Creates an agent principal: starts with no grants and a monthly token budget. */
  @Post("agents")
  async createAgent(@Req() req: Request, @Body() body: unknown) {
    const p = requirePrincipal(req);
    assertAllowed(p, "ai.agent.manage");
    const b = parse(
      z.object({
        name: z
          .string()
          .trim()
          .min(2)
          .max(40)
          .regex(/^[\p{L}\p{N} _-]+$/u, "letters, digits, spaces, - and _ only"),
        budget: z.number().int().min(0).max(1_000_000_000).default(200_000),
      }),
      body,
    );
    const id = newId();
    return withTransaction(this.pool, async (c) => {
      const dup = await c.query("SELECT 1 FROM agents WHERE lower(name) = lower($1)", [b.name]);
      if (dup.rowCount) throw new ConflictException({ error: "name_taken" });
      await c.query("INSERT INTO agents (id, name, owner_user_id, status, monthly_budget_tokens) VALUES ($1,$2,$3,'active',$4)", [id, b.name, p.id, b.budget]);
      await audit(c, "agent.create", "agent", id, { name: b.name, budget: b.budget });
      return { id };
    });
  }

  /** Turns an agent on/off or changes its budget. A disabled agent cannot be invoked at all. */
  @Patch("agents/:agentId")
  async updateAgent(@Req() req: Request, @Param("agentId") agentId: string, @Body() body: unknown) {
    const p = requirePrincipal(req);
    assertAllowed(p, "ai.agent.manage");
    const b = parse(
      z.object({
        status: z.enum(["active", "disabled"]).optional(),
        budget: z.number().int().min(0).max(1_000_000_000).optional(),
        allowedTools: z.array(z.enum(AGENT_TOOL_NAMES)).max(20).optional(),
        description: z.string().max(300).optional(),
      }),
      body,
    );
    return withTransaction(this.pool, async (c) => {
      const r = await c.query(
        `UPDATE agents SET status = coalesce($2, status), monthly_budget_tokens = coalesce($3, monthly_budget_tokens),
          allowed_tools = coalesce($4, allowed_tools), description = coalesce($5, description) WHERE id = $1 RETURNING id, status, monthly_budget_tokens::bigint AS budget, allowed_tools AS "allowedTools"`,
        [agentId, b.status ?? null, b.budget ?? null, b.allowedTools ?? null, b.description ?? null],
      );
      if (!r.rowCount) throw new NotFoundException("agent not found");
      await audit(c, b.status ? `agent.${b.status === "active" ? "enable" : "disable"}` : b.allowedTools ? "agent.tools_set" : "agent.budget_set", "agent", agentId, b);
      return r.rows[0];
    });
  }

  /**
   * Deletes an agent for good: its grants go with it (FK cascade), so it can no longer be resolved as a principal and
   * every invocation fails at once. Its past messages and AI usage rows keep the id (history, cost reports).
   */
  @Delete("agents/:agentId")
  @HttpCode(204)
  async deleteAgent(@Req() req: Request, @Param("agentId") agentId: string) {
    const p = requirePrincipal(req);
    assertAllowed(p, "ai.agent.manage");
    await withTransaction(this.pool, async (c) => {
      const r = await c.query<{ name: string }>("DELETE FROM agents WHERE id = $1 RETURNING name", [agentId]);
      if (!r.rowCount) throw new NotFoundException("agent not found");
      await audit(c, "agent.delete", "agent", agentId, { name: r.rows[0]!.name });
    });
  }

  @Put("agents/:agentId/grants")
  @HttpCode(204)
  async setAgentGrants(@Req() req: Request, @Param("agentId") agentId: string, @Body() body: unknown) {
    const p = requirePrincipal(req);
    assertAllowed(p, "ai.agent.manage");
    const b = parse(z.object({ grants: z.array(grantSchema) }), body);
    try {
      validateGrants(b.grants);
    } catch (e) {
      throw new BadRequestException((e as Error).message);
    }
    await withTransaction(this.pool, async (c) => {
      const exists = await c.query("SELECT 1 FROM agents WHERE id = $1", [agentId]);
      if (!exists.rowCount) throw new NotFoundException("agent not found");
      await c.query("DELETE FROM agent_grants WHERE agent_id = $1", [agentId]);
      for (const g of b.grants) await c.query("INSERT INTO agent_grants (agent_id, permission, scope) VALUES ($1,$2,$3)", [agentId, g.permission, g.scope]);
      await audit(c, "agent.grants_set", "agent", agentId, { grants: b.grants });
    });
  }

  /** Audit: newest first; `before` pages back, `from`/`to` bound the period, `action` filters by prefix (e.g. "member."). */
  @Get("audit")
  async audit(@Req() req: Request, @Query() query: Record<string, string>) {
    const p = requirePrincipal(req);
    assertAllowed(p, "audit.read");
    const q = parse(auditQuery, query);
    return withTransaction(this.pool, async (c) => {
      const r = await c.query(
        `SELECT id, actor, action, resource, resource_id AS "resourceId", source, metadata, at FROM audit_log
          WHERE ($1::timestamptz IS NULL OR at < $1) AND ($2::timestamptz IS NULL OR at >= $2) AND ($3::timestamptz IS NULL OR at < $3)
            AND ($4::text IS NULL OR action LIKE $4 || '%')
          ORDER BY at DESC LIMIT $5`,
        [q.before ?? null, q.from ?? null, q.to ?? null, q.action ?? null, q.limit],
      );
      return { entries: r.rows };
    });
  }
}

const auditQuery = z.object({
  before: z.string().datetime({ offset: true }).optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  action: z
    .string()
    .regex(/^[a-z_.]{1,40}$/)
    .optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(200),
});
