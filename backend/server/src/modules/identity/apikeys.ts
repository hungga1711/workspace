import { createHash, randomBytes } from "node:crypto";
import {
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
  Req,
  UnauthorizedException,
} from "@nestjs/common";
import type { Request } from "express";
import type { Pool } from "pg";
import { z } from "zod";
import { authorize, newId, withTransaction, type Principal } from "@workspace/shared";
import { assertAllowed, requirePrincipal } from "@workspace/service-kit";
import { POOL } from "./identity.controller.js";
import { audit, resolvePrincipal } from "./repo.js";
import { PERMISSIONS } from "./catalog.js";

/** Never grantable to a key: account, role, AI policy and audit administration stay with humans. */
export const NOT_FOR_KEYS: ReadonlySet<string> = new Set(["role.manage", "member.manage", "audit.read", "ai.policy.manage", "workspace.configure", "employee.salary.read"]);
export const KEY_PERMISSIONS = PERMISSIONS.filter((p) => !NOT_FOR_KEYS.has(p));

const hash = (key: string) => createHash("sha256").update(key).digest("hex");

const createSchema = z.object({
  name: z.string().trim().min(1).max(80),
  permissions: z.array(z.string()).min(1).max(40),
  expiresInDays: z.number().int().min(1).max(730).nullable().default(365),
});

function parseCreate(body: unknown) {
  const r = createSchema.safeParse(body);
  if (!r.success) throw new BadRequestException(r.error.issues.map((i) => i.message).join("; "));
  const permissions = [...new Set(r.data.permissions)];
  for (const perm of permissions)
    if (!KEY_PERMISSIONS.includes(perm as (typeof KEY_PERMISSIONS)[number])) throw new BadRequestException(`permission not allowed for API keys: ${perm}`);
  return { ...r.data, permissions };
}

/**
 * API keys, two kinds. A workspace key (Admin › Integrations) acts as a service principal limited to the permissions
 * chosen at creation, each of which the creator must hold at WORKSPACE scope. A personal key (any member, for MCP
 * clients and scripts) acts as its creator, with the creator's current scopes, limited to the permissions chosen for
 * it; it stops working with the creator's membership. The secret is shown once; only its hash is stored.
 */
@Controller()
export class ApiKeysController {
  constructor(@Inject(POOL) private readonly pool: Pool) {}

  @Get("api-keys")
  async list(@Req() req: Request) {
    const p = requirePrincipal(req);
    assertAllowed(p, "workspace.configure");
    return withTransaction(this.pool, async (c) => ({
      keys: (
        await c.query(`SELECT id, name, prefix, permissions, personal, created_by AS "createdBy", created_at AS "createdAt", expires_at AS "expiresAt", last_used_at AS "lastUsedAt", revoked_at AS "revokedAt"
          FROM api_keys ORDER BY created_at DESC`)
      ).rows,
      grantable: KEY_PERMISSIONS.filter((perm) => authorize(p, perm).allowed),
    }));
  }

  @Post("api-keys")
  async create(@Req() req: Request, @Body() body: unknown) {
    const p = requirePrincipal(req);
    if (p.type !== "user") throw new ForbiddenException("only people create API keys");
    assertAllowed(p, "workspace.configure");
    const b = parseCreate(body);
    for (const perm of b.permissions) {
      // A key can never do more than the person who made it.
      if (!authorize(p, perm).allowed) throw new ForbiddenException(`you do not hold ${perm} for the whole workspace`);
    }
    return this.insert(p, b, false);
  }

  @Delete("api-keys/:id")
  @HttpCode(204)
  async revoke(@Req() req: Request, @Param("id") id: string) {
    const p = requirePrincipal(req);
    assertAllowed(p, "workspace.configure");
    await withTransaction(this.pool, async (c) => {
      const r = await c.query("UPDATE api_keys SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL", [id]);
      if (!r.rowCount) throw new NotFoundException("key not found");
      await audit(c, "apikey.revoke", "api_key", id, {});
    });
  }

  /** The caller's own personal keys, and the permissions they may give one. */
  @Get("me/api-keys")
  async mine(@Req() req: Request) {
    const p = requirePrincipal(req);
    if (p.type !== "user") throw new ForbiddenException("only people have personal keys");
    return withTransaction(this.pool, async (c) => ({
      keys: (
        await c.query(
          `SELECT id, name, prefix, permissions, created_at AS "createdAt", expires_at AS "expiresAt", last_used_at AS "lastUsedAt", revoked_at AS "revokedAt"
             FROM api_keys WHERE personal AND created_by = $1 ORDER BY created_at DESC`,
          [p.id],
        )
      ).rows,
      // Whatever the person holds at any scope: the key then acts within that same scope.
      grantable: KEY_PERMISSIONS.filter((perm) => p.grants.some((g) => g.permission === perm)),
    }));
  }

  @Post("me/api-keys")
  async createMine(@Req() req: Request, @Body() body: unknown) {
    const p = requirePrincipal(req);
    if (p.type !== "user") throw new ForbiddenException("only people create personal keys");
    const b = parseCreate(body);
    for (const perm of b.permissions) if (!p.grants.some((g) => g.permission === perm)) throw new ForbiddenException(`you do not hold ${perm}`);
    return this.insert(p, b, true);
  }

  @Delete("me/api-keys/:id")
  @HttpCode(204)
  async revokeMine(@Req() req: Request, @Param("id") id: string) {
    const p = requirePrincipal(req);
    await withTransaction(this.pool, async (c) => {
      const r = await c.query("UPDATE api_keys SET revoked_at = now() WHERE id = $1 AND personal AND created_by = $2 AND revoked_at IS NULL", [id, p.id]);
      if (!r.rowCount) throw new NotFoundException("key not found");
      await audit(c, "apikey.revoke", "api_key", id, { personal: true });
    });
  }

  private async insert(p: Principal, b: ReturnType<typeof parseCreate>, personal: boolean) {
    const id = newId();
    const prefix = randomBytes(4).toString("hex");
    const key = `wos_${prefix}_${randomBytes(24).toString("base64url")}`;
    const expiresAt = b.expiresInDays ? new Date(Date.now() + b.expiresInDays * 86400_000) : null;
    await withTransaction(this.pool, async (c) => {
      await c.query("INSERT INTO api_keys (id, name, prefix, key_hash, permissions, created_by, expires_at, personal) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)", [
        id,
        b.name,
        prefix,
        hash(key),
        b.permissions,
        p.id,
        expiresAt,
        personal,
      ]);
      await audit(c, "apikey.create", "api_key", id, { name: b.name, permissions: b.permissions, personal });
    });
    return { id, key, prefix, expiresAt, personal };
  }

  /** Gateway only: turns a presented key into the principal it acts as. */
  @Post("internal/api-keys/resolve")
  @HttpCode(200)
  async resolve(@Req() req: Request, @Body() body: unknown): Promise<Principal> {
    const caller = requirePrincipal(req);
    if (caller.type !== "service" || !authorize(caller, "principal.resolve").allowed) throw new ForbiddenException("platform service required");
    const b = z.object({ key: z.string().regex(/^wos_[0-9a-f]{8}_[A-Za-z0-9_-]{32}$/) }).safeParse(body);
    if (!b.success) throw new UnauthorizedException("invalid key");
    const k = (
      await this.pool.query<{ id: string; permissions: string[]; personal: boolean; created_by: string; require_mfa: boolean }>(
        `UPDATE api_keys SET last_used_at = now()
          WHERE key_hash = $1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())
          RETURNING id, permissions, personal, created_by, coalesce((SELECT require_mfa FROM workspace_settings), false) AS require_mfa`,
        [hash(b.data.key)],
      )
    ).rows[0];
    if (!k) throw new UnauthorizedException("invalid key");
    if (k.personal) {
      // A workspace that requires two-step sign-in takes a person's key only while that person uses it, so a key
      // made before the policy (or by someone who later removed it) is no way around it.
      if (k.require_mfa && !(await this.pool.query<{ on: boolean }>("SELECT totp_enabled AS on FROM users WHERE id = $1", [k.created_by])).rows[0]?.on)
        throw new UnauthorizedException("two-step sign-in required");
      // The person's own principal (scopes, teams, department as of now), narrowed to the key's permissions.
      const user = await resolvePrincipal(this.pool, k.created_by).catch(() => null);
      if (!user) throw new UnauthorizedException("invalid key");
      return { ...user, grants: user.grants.filter((g) => k.permissions.includes(g.permission) && !NOT_FOR_KEYS.has(g.permission)) };
    }
    return {
      type: "service" as const,
      id: `apikey:${k.id}`,
      teamIds: [],
      departmentId: null,
      grants: k.permissions.map((permission) => ({ permission, scope: "WORKSPACE" as const })),
    };
  }
}
