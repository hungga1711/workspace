import { randomBytes } from "node:crypto";
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  HttpException,
  Inject,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  UnauthorizedException,
} from "@nestjs/common";
import type { Request } from "express";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { authorize, newId, recordAudit, withTransaction, type Principal } from "@workspace/shared";
import { assertAllowed, requirePrincipal } from "@workspace/service-kit";
import { dropCached } from "./oauth-store.js";
import { POOL } from "./identity.controller.js";
import { audit, resolvePrincipal } from "./repo.js";
import { KEY_PERMISSIONS, NOT_FOR_KEYS } from "./apikeys.js";
import {
  authorizeBody,
  MCP_READ,
  MCP_WRITE,
  pkceOk,
  presetPermissions,
  redirectLabel,
  redirectMatches,
  redirectWith,
  registerBody,
  scopeOf,
  sha256,
  validRedirectUri,
} from "./oauth-rules.js";

/**
 * OAuth 2.1 for remote MCP clients (docs/integrations/mcp.md). The gateway serves the protocol endpoints
 * (/.well-known/*, /oauth/register, /oauth/token, /oauth/revoke) and calls the internal routes here; the web app's
 * consent page calls `oauth/clients/:id` and `oauth/authorize` as the signed-in person. A grant acts as that person
 * with the permissions they approved, narrowed at every call to what they still hold (like a personal API key), and
 * only on /api/mcp. Codes and tokens are random and stored as hashes.
 */

const ACCESS_TTL_S = 3600;
const REFRESH_TTL_S = 30 * 86400;
const CODE_TTL_S = 600;

const token = (prefix: string) => `${prefix}${randomBytes(32).toString("base64url")}`;

/** An OAuth error answer (RFC 6749 §5.2): `{ error, error_description }` with its status. */
const oauthError = (status: number, error: string, description: string) => new HttpException({ error, error_description: description }, status);

const tokenBody = z.object({
  grant_type: z.string().max(100),
  code: z.string().max(200).optional(),
  code_verifier: z.string().max(200).optional(),
  redirect_uri: z.string().max(2000).optional(),
  refresh_token: z.string().max(200).optional(),
  client_id: z.string().max(100).optional(),
  client_secret: z.string().max(200).optional(),
  resource: z.string().max(500).optional(),
});

interface ClientRow {
  id: string;
  name: string;
  redirect_uris: string[];
  client_uri: string | null;
  auth_method: string;
  secret_hash: string | null;
}

/** What a person may hand a client: what they could put on a personal key. */
const grantableFor = (p: Principal) => KEY_PERMISSIONS.filter((perm) => p.grants.some((g) => g.permission === perm));

/** The calls the gateway makes; each one checks it really is the gateway. */
function assertGateway(req: Request): void {
  const caller = requirePrincipal(req);
  if (caller.type !== "service" || !authorize(caller, "principal.resolve").allowed) throw new ForbiddenException("platform service required");
}

const daysParam = z.coerce
  .number()
  .int()
  .refine((d) => [1, 7, 30, 90].includes(d))
  .default(7);

@Controller()
export class OAuthController {
  constructor(@Inject(POOL) private readonly pool: Pool) {}

  // ---------- the consent page (signed-in person) ----------

  /** Who is asking and where they will send the person back; 404 for an unknown client or redirect URI. */
  @Get("oauth/clients/:id")
  async client(@Req() req: Request, @Param("id") id: string, @Query("redirect_uri") redirectUri?: string) {
    const p = requirePrincipal(req);
    if (p.type !== "user") throw new ForbiddenException("only people approve apps");
    const c = (await this.pool.query<ClientRow>("SELECT * FROM oauth_clients WHERE id = $1", [id])).rows[0];
    if (!c) throw new NotFoundException("unknown_client");
    if (!redirectUri || !redirectMatches(c.redirect_uris, redirectUri)) throw new NotFoundException("unknown_redirect_uri");
    const grantable = grantableFor(p);
    const existing = (
      await this.pool.query<{ permissions: string[] }>("SELECT permissions FROM oauth_grants WHERE client_id = $1 AND user_id = $2 AND revoked_at IS NULL", [id, p.id])
    ).rows[0];
    return {
      client: { id: c.id, name: c.name, clientUri: c.client_uri, redirectHost: redirectLabel(redirectUri) },
      grantable,
      presets: { read: presetPermissions("read", grantable), write: presetPermissions("write", grantable) },
      mcp: { read: MCP_READ, write: MCP_WRITE },
      connectedBefore: existing?.permissions ?? null,
    };
  }

  /**
   * The person's answer. Approve: a grant with the permissions they ticked (only ones they hold), a one-time code
   * bound to the redirect URI and the PKCE challenge. Deny: `access_denied`. Either way the page sends the browser to
   * the returned address, which is always one the client registered.
   */
  @Post("oauth/authorize")
  @HttpCode(200)
  async authorize(@Req() req: Request, @Body() body: unknown) {
    const p = requirePrincipal(req);
    if (p.type !== "user") throw new ForbiddenException("only people approve apps");
    const r = authorizeBody.safeParse(body);
    if (!r.success) throw new BadRequestException(r.error.issues.map((i) => i.message).join("; "));
    const b = r.data;
    const c = (await this.pool.query<ClientRow>("SELECT * FROM oauth_clients WHERE id = $1", [b.clientId])).rows[0];
    if (!c || !redirectMatches(c.redirect_uris, b.redirectUri)) throw new BadRequestException("unknown client or redirect URI");
    if (!b.approve) return { redirectTo: redirectWith(b.redirectUri, { error: "access_denied", error_description: "The person declined.", state: b.state }) };
    const grantable = grantableFor(p);
    const permissions = [...new Set(b.permissions)].filter((x) => grantable.includes(x as (typeof grantable)[number]));
    if (!permissions.length) throw new BadRequestException("choose at least one permission");
    const code = randomBytes(32).toString("base64url");
    await withTransaction(this.pool, async (tx) => {
      // One live connection per person and app: approving again replaces the earlier one and its tokens.
      const old = await tx.query<{ id: string }>("UPDATE oauth_grants SET revoked_at = now() WHERE client_id = $1 AND user_id = $2 AND revoked_at IS NULL RETURNING id", [
        c.id,
        p.id,
      ]);
      if (old.rowCount) await tx.query("DELETE FROM oauth_tokens WHERE grant_id = ANY($1)", [old.rows.map((x) => x.id)]);
      const grantId = newId();
      await tx.query("INSERT INTO oauth_grants (id, client_id, user_id, permissions, resource) VALUES ($1,$2,$3,$4,$5)", [grantId, c.id, p.id, permissions, b.resource ?? null]);
      await tx.query(`INSERT INTO oauth_codes (code_hash, grant_id, redirect_uri, code_challenge, expires_at) VALUES ($1,$2,$3,$4, now() + interval '${CODE_TTL_S} seconds')`, [
        sha256(code),
        grantId,
        b.redirectUri,
        b.codeChallenge,
      ]);
      await audit(tx, "oauth.grant", "oauth_grant", grantId, { client: c.name, clientId: c.id, permissions });
    });
    dropCached();
    return { redirectTo: redirectWith(b.redirectUri, { code, state: b.state }) };
  }

  // ---------- connected apps ----------

  /** My connected AI apps (OAuth) with when they were last used. Personal keys are listed by me/api-keys. */
  @Get("me/oauth/grants")
  async myGrants(@Req() req: Request) {
    const p = requirePrincipal(req);
    if (p.type !== "user") throw new ForbiddenException();
    return { grants: await this.grants(this.pool, p.id) };
  }

  @Delete("me/oauth/grants/:id")
  @HttpCode(204)
  async revokeMine(@Req() req: Request, @Param("id") id: string) {
    const p = requirePrincipal(req);
    await this.revokeGrant(id, p.id);
  }

  /** What agents did as me: my last 100 MCP tool calls (no arguments or answers are kept). */
  @Get("me/mcp/activity")
  async myActivity(@Req() req: Request) {
    const p = requirePrincipal(req);
    if (p.type !== "user") throw new ForbiddenException();
    return { calls: (await this.pool.query(`${CALLS_SELECT} WHERE c.user_id = $1 ORDER BY c.at DESC LIMIT 100`, [p.id])).rows };
  }

  /** Admin › AI agents: every live connection in the company, OAuth apps and personal keys, with their owner. */
  @Get("oauth/grants")
  async allGrants(@Req() req: Request) {
    const p = requirePrincipal(req);
    assertAllowed(p, "audit.read");
    const keys = (
      await this.pool.query(
        `SELECT k.id, k.name, k.prefix, k.permissions, k.created_by AS "userId", m.display_name AS "userName", k.created_at AS "createdAt", k.last_used_at AS "lastUsedAt", k.expires_at AS "expiresAt"
           FROM api_keys k LEFT JOIN members m ON m.user_id = k.created_by
          WHERE k.personal AND k.revoked_at IS NULL AND (k.expires_at IS NULL OR k.expires_at > now()) ORDER BY k.last_used_at DESC NULLS LAST, k.created_at DESC LIMIT 500`,
      )
    ).rows;
    return { grants: await this.grants(this.pool, null), keys, canRevoke: authorize(p, "workspace.configure").allowed };
  }

  @Delete("oauth/grants/:id")
  @HttpCode(204)
  async revokeAny(@Req() req: Request, @Param("id") id: string) {
    const p = requirePrincipal(req);
    assertAllowed(p, "workspace.configure");
    await this.revokeGrant(id, null);
  }

  /**
   * Admin › AI agents › activity: MCP tool calls over 1, 7, 30 or 90 days (who, which app, which tool, when, ok or
   * not), with totals per tool, person and app. Never arguments or answers. `before` pages back through the list.
   */
  @Get("mcp/activity")
  async activity(@Req() req: Request, @Query() query: unknown) {
    const p = requirePrincipal(req);
    assertAllowed(p, "audit.read");
    const q = z
      .object({ days: daysParam, userId: z.string().max(40).optional(), tool: z.string().max(60).optional(), before: z.string().datetime({ offset: true }).optional() })
      .safeParse(query);
    if (!q.success) throw new BadRequestException("invalid query");
    const { days, userId, tool, before } = q.data;
    const where = `c.at > now() - $1 * interval '1 day' AND ($2::text IS NULL OR c.user_id = $2) AND ($3::text IS NULL OR c.tool = $3)`;
    const args = [days, userId ?? null, tool ?? null];
    const [calls, totals, byTool, byPerson, byClient] = await Promise.all([
      this.pool.query(`${CALLS_SELECT} WHERE ${where} AND ($4::timestamptz IS NULL OR c.at < $4) ORDER BY c.at DESC LIMIT 100`, [...args, before ?? null]),
      this.pool.query<{ calls: number; failed: number; people: number; apps: number }>(
        `SELECT count(*)::int AS calls, count(*) FILTER (WHERE NOT ok)::int AS failed, count(DISTINCT user_id)::int AS people, count(DISTINCT coalesce(credential_id, via))::int AS apps FROM mcp_calls c WHERE ${where}`,
        args,
      ),
      this.pool.query(
        `SELECT tool, count(*)::int AS calls, count(*) FILTER (WHERE NOT ok)::int AS failed FROM mcp_calls c WHERE ${where} GROUP BY tool ORDER BY calls DESC LIMIT 30`,
        args,
      ),
      this.pool.query(
        `SELECT c.user_id AS "userId", m.display_name AS "userName", count(*)::int AS calls, max(c.at) AS "lastAt"
           FROM mcp_calls c LEFT JOIN members m ON m.user_id = c.user_id WHERE ${where} GROUP BY c.user_id, m.display_name ORDER BY calls DESC LIMIT 30`,
        args,
      ),
      this.pool.query(
        `SELECT coalesce(c.client_name, c.via) AS client, c.via, count(*)::int AS calls FROM mcp_calls c WHERE ${where} GROUP BY 1, 2 ORDER BY calls DESC LIMIT 30`,
        args,
      ),
    ]);
    const rows = calls.rows as { at: Date }[];
    return {
      days,
      totals: totals.rows[0],
      byTool: byTool.rows,
      byPerson: byPerson.rows,
      byClient: byClient.rows,
      calls: rows,
      nextBefore: rows.length === 100 ? rows.at(-1)!.at : null,
    };
  }

  // ---------- protocol endpoints (gateway only) ----------

  /** Dynamic client registration (RFC 7591). Unauthenticated by design; the gateway limits it per address. */
  @Post("internal/oauth/register")
  @HttpCode(201)
  async register(@Req() req: Request, @Body() body: unknown) {
    assertGateway(req);
    const r = registerBody.safeParse(body);
    if (!r.success) throw oauthError(400, "invalid_client_metadata", r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
    const b = r.data;
    const bad = b.redirect_uris.find((u) => !validRedirectUri(u));
    if (bad) throw oauthError(400, "invalid_redirect_uri", `redirect URI not allowed: ${bad.slice(0, 200)}`);
    if (b.grant_types?.some((g) => !["authorization_code", "refresh_token"].includes(g)))
      throw oauthError(400, "invalid_client_metadata", "only authorization_code and refresh_token are supported");
    if (b.response_types?.some((t) => t !== "code")) throw oauthError(400, "invalid_client_metadata", "only the code response type is supported");
    const id = `woc_${randomBytes(12).toString("base64url")}`;
    const secret = b.token_endpoint_auth_method === "none" ? null : token("wcs_");
    const name = b.client_name || redirectLabel(b.redirect_uris[0]!);
    await this.pool.query(
      "INSERT INTO oauth_clients (id, name, redirect_uris, client_uri, auth_method, secret_hash, software_id, software_version) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
      [id, name, b.redirect_uris, b.client_uri ?? null, b.token_endpoint_auth_method, secret ? sha256(secret) : null, b.software_id ?? null, b.software_version ?? null],
    );
    return {
      client_id: id,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
      client_name: name,
      redirect_uris: b.redirect_uris,
      ...(b.client_uri ? { client_uri: b.client_uri } : {}),
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: b.token_endpoint_auth_method,
    };
  }

  /** The token endpoint: authorization_code (with PKCE) and refresh_token (rotated; a replayed one ends the grant). */
  @Post("internal/oauth/token")
  @HttpCode(200)
  async token(@Req() req: Request, @Body() body: unknown) {
    assertGateway(req);
    const r = tokenBody.safeParse(body);
    if (!r.success) throw oauthError(400, "invalid_request", "malformed token request");
    const b = r.data;
    if (!b.client_id) throw oauthError(401, "invalid_client", "client_id is required");
    const client = (await this.pool.query<ClientRow>("SELECT * FROM oauth_clients WHERE id = $1", [b.client_id])).rows[0];
    if (!client) throw oauthError(401, "invalid_client", "unknown client");
    if (client.secret_hash && (!b.client_secret || sha256(b.client_secret) !== client.secret_hash)) throw oauthError(401, "invalid_client", "client authentication failed");
    if (b.grant_type === "authorization_code") return this.exchangeCode(client, b);
    if (b.grant_type === "refresh_token") return this.refresh(client, b);
    throw oauthError(400, "unsupported_grant_type", "use authorization_code or refresh_token");
  }

  /** RFC 7009: always 200, whether or not the token existed. Revoking either token ends the whole connection. */
  @Post("internal/oauth/revoke")
  @HttpCode(200)
  async revoke(@Req() req: Request, @Body() body: unknown) {
    assertGateway(req);
    const b = z.object({ token: z.string().max(200), client_id: z.string().max(100).optional() }).safeParse(body);
    if (!b.success) return {};
    const t = (
      await this.pool.query<{ grant_id: string; client_id: string }>(
        "SELECT t.grant_id, g.client_id FROM oauth_tokens t JOIN oauth_grants g ON g.id = t.grant_id WHERE t.token_hash = $1",
        [sha256(b.data.token)],
      )
    ).rows[0];
    if (t && (!b.data.client_id || b.data.client_id === t.client_id)) await this.revokeGrant(t.grant_id, null);
    return {};
  }

  /**
   * Gateway: an access token → the person it acts as, narrowed to the grant's permissions (like a personal key),
   * plus the grant and app for the activity log. 401 when expired, revoked, or the person no longer qualifies.
   */
  @Post("internal/oauth/resolve")
  @HttpCode(200)
  async resolve(@Req() req: Request, @Body() body: unknown) {
    assertGateway(req);
    const b = z.object({ token: z.string().regex(/^woa_[A-Za-z0-9_-]{43}$/) }).safeParse(body);
    if (!b.success) throw new UnauthorizedException("invalid_token");
    const g = (
      await this.pool.query<{ grant_id: string; user_id: string; permissions: string[]; client_name: string; expires_at: Date; require_mfa: boolean; totp: boolean | null }>(
        `SELECT g.id AS grant_id, g.user_id, g.permissions, c.name AS client_name, t.expires_at,
                coalesce((SELECT require_mfa FROM workspace_settings), false) AS require_mfa, (SELECT totp_enabled FROM users WHERE id = g.user_id) AS totp
           FROM oauth_tokens t JOIN oauth_grants g ON g.id = t.grant_id JOIN oauth_clients c ON c.id = g.client_id
          WHERE t.token_hash = $1 AND t.kind = 'access' AND t.expires_at > now() AND g.revoked_at IS NULL`,
        [sha256(b.data.token)],
      )
    ).rows[0];
    if (!g) throw new UnauthorizedException("invalid_token");
    // Same rule as a personal key: a workspace that requires two-step sign-in only lets people who use it connect apps.
    if (g.require_mfa && !g.totp) throw new UnauthorizedException("two-step sign-in required");
    const user = await resolvePrincipal(this.pool, g.user_id).catch(() => null);
    if (!user) throw new UnauthorizedException("invalid_token");
    await this.pool.query("UPDATE oauth_grants SET last_used_at = now() WHERE id = $1 AND (last_used_at IS NULL OR last_used_at < now() - interval '1 minute')", [g.grant_id]);
    const principal: Principal = { ...user, grants: user.grants.filter((x) => g.permissions.includes(x.permission) && !NOT_FOR_KEYS.has(x.permission)) };
    return { principal, grantId: g.grant_id, clientName: g.client_name, expiresAt: g.expires_at };
  }

  /**
   * Gateway: MCP tool calls to log (Admin › AI agents). Keys are named by the hash the gateway already has, so the
   * secret never travels; the key's id and name are looked up here.
   */
  @Post("internal/mcp/calls")
  @HttpCode(204)
  async logCalls(@Req() req: Request, @Body() body: unknown) {
    assertGateway(req);
    const b = z
      .object({
        calls: z
          .array(
            z.object({
              userId: z.string().max(80).nullable(),
              via: z.enum(["oauth", "personal_key", "workspace_key", "session"]),
              credential: z.string().max(80).nullable(),
              tool: z.string().max(80),
              ok: z.boolean(),
              error: z.string().max(200).nullable(),
              durationMs: z.number().int().min(0).max(3_600_000),
            }),
          )
          .max(200),
      })
      .safeParse(body);
    if (!b.success) throw new BadRequestException("invalid calls");
    for (const c of b.data.calls) {
      await withTransaction(this.pool, async (tx) => {
        const row = (
          await tx.query<{ credential_id: string | null; client_name: string | null }>(
            `INSERT INTO mcp_calls (id, user_id, via, credential_id, client_name, tool, ok, error, duration_ms)
             SELECT $1, $2, $3, x.id, x.name, $5, $6, $7, $8
               FROM (SELECT k.id, k.name FROM api_keys k WHERE $3 IN ('personal_key', 'workspace_key') AND k.key_hash = $4
                     UNION ALL SELECT g.id, cl.name FROM oauth_grants g JOIN oauth_clients cl ON cl.id = g.client_id WHERE $3 = 'oauth' AND g.id = $4
                     UNION ALL SELECT NULL, NULL WHERE $3 = 'session') x LIMIT 1
             RETURNING credential_id, client_name`,
            [newId(), c.userId, c.via, c.credential, c.tool, c.ok, c.error, c.durationMs],
          )
        ).rows[0];
        // Each MCP tool call is on the audit trail too (ADR 0025): which tool, through which client or key, never its arguments.
        await recordAudit(tx, {
          action: "identity.mcp.tool_called",
          outcome: c.ok ? "success" : "failure",
          actorId: c.userId ? `user:${c.userId}` : row?.credential_id ? `service:apikey:${row.credential_id}` : "system",
          targetType: "mcp_tool",
          targetId: c.tool,
          targetLabel: row?.client_name ?? null,
          meta: { durationMs: c.durationMs, ...(c.error ? { error: c.error.slice(0, 80) } : {}) },
          origin: { via: c.via },
        });
      });
    }
  }

  // ---------- internals ----------

  private async exchangeCode(client: ClientRow, b: z.infer<typeof tokenBody>) {
    if (!b.code || !b.code_verifier || !b.redirect_uri) throw oauthError(400, "invalid_request", "code, code_verifier and redirect_uri are required");
    const out = await withTransaction(this.pool, async (tx) => {
      const row = (
        await tx.query<{ grant_id: string; redirect_uri: string; code_challenge: string; expired: boolean; used_at: Date | null; client_id: string; permissions: string[] }>(
          `SELECT k.grant_id, k.redirect_uri, k.code_challenge, k.expires_at < now() AS expired, k.used_at, g.client_id, g.permissions
             FROM oauth_codes k JOIN oauth_grants g ON g.id = k.grant_id WHERE k.code_hash = $1 AND g.revoked_at IS NULL FOR UPDATE OF k`,
          [sha256(b.code!)],
        )
      ).rows[0];
      if (!row || row.client_id !== client.id) throw oauthError(400, "invalid_grant", "unknown code");
      if (row.used_at) {
        // A code presented twice was intercepted, or replayed: end what it started (RFC 6749 §4.1.2). The revocation
        // must commit, so the error is raised after the transaction.
        await this.endGrant(tx, row.grant_id);
        return { replayed: true } as const;
      }
      if (row.expired) throw oauthError(400, "invalid_grant", "code expired");
      if (row.redirect_uri !== b.redirect_uri) throw oauthError(400, "invalid_grant", "redirect_uri does not match");
      if (!pkceOk(b.code_verifier!, row.code_challenge)) throw oauthError(400, "invalid_grant", "PKCE verification failed");
      await tx.query("UPDATE oauth_codes SET used_at = now() WHERE code_hash = $1", [sha256(b.code!)]);
      await tx.query("UPDATE oauth_clients SET last_used_at = now() WHERE id = $1", [client.id]);
      return { tokens: await this.issue(tx, row.grant_id, row.permissions) } as const;
    });
    if ("replayed" in out) {
      dropCached();
      throw oauthError(400, "invalid_grant", "code already used");
    }
    return out.tokens;
  }

  private async refresh(client: ClientRow, b: z.infer<typeof tokenBody>) {
    if (!b.refresh_token) throw oauthError(400, "invalid_request", "refresh_token is required");
    const out = await withTransaction(this.pool, async (tx) => {
      const row = (
        await tx.query<{ grant_id: string; used_at: Date | null; expired: boolean; client_id: string; permissions: string[]; revoked: boolean }>(
          `SELECT t.grant_id, t.used_at, t.expires_at < now() AS expired, g.client_id, g.permissions, g.revoked_at IS NOT NULL AS revoked
             FROM oauth_tokens t JOIN oauth_grants g ON g.id = t.grant_id WHERE t.token_hash = $1 AND t.kind = 'refresh' FOR UPDATE OF t`,
          [sha256(b.refresh_token!)],
        )
      ).rows[0];
      if (!row || row.client_id !== client.id || row.revoked || row.expired) return { error: "invalid refresh token" } as const;
      if (row.used_at) {
        // Rotation: each refresh token works once. A second use means two holders; end the connection for both.
        await this.endGrant(tx, row.grant_id);
        return { error: "refresh token already used" } as const;
      }
      await tx.query("UPDATE oauth_tokens SET used_at = now() WHERE token_hash = $1", [sha256(b.refresh_token!)]);
      return { tokens: await this.issue(tx, row.grant_id, row.permissions) } as const;
    });
    // The reuse revocation above must commit, so the error is raised after the transaction.
    if ("error" in out) {
      dropCached();
      throw oauthError(400, "invalid_grant", out.error);
    }
    return out.tokens;
  }

  private async issue(tx: PoolClient, grantId: string, permissions: string[]) {
    const access = token("woa_");
    const refresh = token("wor_");
    await tx.query(
      `INSERT INTO oauth_tokens (token_hash, grant_id, kind, expires_at) VALUES ($1,$3,'access', now() + interval '${ACCESS_TTL_S} seconds'), ($2,$3,'refresh', now() + interval '${REFRESH_TTL_S} seconds')`,
      [sha256(access), sha256(refresh), grantId],
    );
    return { access_token: access, token_type: "Bearer", expires_in: ACCESS_TTL_S, refresh_token: refresh, scope: scopeOf(permissions) };
  }

  private async endGrant(tx: PoolClient, grantId: string) {
    await tx.query("UPDATE oauth_grants SET revoked_at = coalesce(revoked_at, now()) WHERE id = $1", [grantId]);
    await tx.query("DELETE FROM oauth_tokens WHERE grant_id = $1", [grantId]);
  }

  /** Ends a connection (the owner's, or any for an admin when `owner` is null) and forgets its cached tokens. */
  private async revokeGrant(id: string, owner: string | null) {
    await withTransaction(this.pool, async (tx) => {
      const r = await tx.query<{ client: string }>(
        `UPDATE oauth_grants g SET revoked_at = now() FROM oauth_clients c
          WHERE g.id = $1 AND c.id = g.client_id AND g.revoked_at IS NULL AND ($2::text IS NULL OR g.user_id = $2) RETURNING c.name AS client`,
        [id, owner],
      );
      if (!r.rowCount) throw new NotFoundException("connection not found");
      await tx.query("DELETE FROM oauth_tokens WHERE grant_id = $1", [id]);
      await audit(tx, "oauth.revoke", "oauth_grant", id, { client: r.rows[0]!.client, byOwner: owner !== null });
    });
    dropCached();
  }

  private async grants(c: Pool | PoolClient, userId: string | null) {
    return (
      await c.query(
        `SELECT g.id, g.client_id AS "clientId", c.name AS "clientName", c.client_uri AS "clientUri", c.redirect_uris[1] AS "redirectUri", g.permissions,
                g.user_id AS "userId", m.display_name AS "userName", g.created_at AS "createdAt", g.last_used_at AS "lastUsedAt"
           FROM oauth_grants g JOIN oauth_clients c ON c.id = g.client_id LEFT JOIN members m ON m.user_id = g.user_id
          WHERE g.revoked_at IS NULL AND ($1::text IS NULL OR g.user_id = $1) ORDER BY g.last_used_at DESC NULLS LAST, g.created_at DESC LIMIT 500`,
        [userId],
      )
    ).rows.map((r: { redirectUri: string | null }) => ({ ...r, redirectUri: undefined, redirectHost: r.redirectUri ? redirectLabel(r.redirectUri) : null }));
  }
}

const CALLS_SELECT = `SELECT c.id, c.at, c.user_id AS "userId", m.display_name AS "userName", c.via, c.client_name AS "clientName", c.tool, c.ok, c.error, c.duration_ms AS "durationMs"
  FROM mcp_calls c LEFT JOIN members m ON m.user_id = c.user_id`;
