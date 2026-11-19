import { Body, Controller, ForbiddenException, Get, HttpCode, HttpException, Inject, NotFoundException, Post, Put, Req } from "@nestjs/common";
import type { Request } from "express";
import type { Pool } from "pg";
import { z } from "zod";
import { randomInt } from "node:crypto";
import { authorize, withTransaction, type Principal } from "@workspace/shared";
import { assertAllowed, parse, requirePrincipal } from "@workspace/service-kit";
import { audit } from "../repo.js";
import { encrypt, sha256 } from "./crypto.js";
import type { SigningKeys } from "./keys.js";
import type { AuthService } from "./sessions.js";
import { newTotpSecret, otpauthUrl } from "./totp.js";
import { sessionStateKey } from "./users.js";

export const AUTH = Symbol("AUTH");
export interface AuthDeps {
  pool: Pool;
  auth: AuthService;
  keys: SigningKeys;
}

/** Sign-in endpoints answer only the gateway (it adds per-IP limits and the visitor's address). */
function requireGateway(req: Request, permission = "auth.session"): Principal {
  const p = requirePrincipal(req);
  if (p.type !== "service" || !authorize(p, permission).allowed) throw new ForbiddenException("gateway only");
  return p;
}

const client = z.object({ ip: z.string().max(100).nullish(), userAgent: z.string().max(500).nullish() });
const token = z.string().min(1).max(200);
const RECOVERY_CODES = 10;

const fail = (status: number, error: string, extra: Record<string, unknown> = {}) => new HttpException({ error, ...extra }, status);

/**
 * Authentication: password sign-in with lockout and optional TOTP, token refresh with rotation, sign-out, the public keys the gateway verifies access tokens with, and the session state it checks them against. Account screens: two-step sign-in set-up and the workspace policy.
 */
@Controller()
export class AuthController {
  constructor(@Inject(AUTH) private readonly d: AuthDeps) {}

  /** Public keys for access tokens (no secret in here; the gateway caches it). */
  @Get("internal/auth/jwks")
  jwks() {
    return this.d.keys.jwks();
  }

  @Post("internal/auth/login")
  @HttpCode(200)
  async login(@Req() req: Request, @Body() body: unknown) {
    requireGateway(req);
    const b = parse(client.extend({ email: z.string().trim().max(254), password: z.string().max(1024) }), body);
    if (!z.string().email().safeParse(b.email).success || !b.password) throw fail(401, "invalid");
    const r = await this.d.auth.login(b.email, b.password, b);
    if (r.ok) return r.tokens;
    if ("mfa" in r) return { mfa: true, challenge: r.challenge };
    throw fail(r.error === "locked" ? 423 : r.error === "invalid" ? 401 : 403, r.error, r.retryAfter ? { retryAfter: r.retryAfter } : {});
  }

  @Post("internal/auth/mfa")
  @HttpCode(200)
  async mfa(@Req() req: Request, @Body() body: unknown) {
    requireGateway(req);
    const b = parse(client.extend({ challenge: token, code: z.string().trim().max(20) }), body);
    const r = await this.d.auth.verifyMfa(b.challenge, b.code, b);
    if (!r.ok) throw fail(401, r.error);
    return r.tokens;
  }

  @Post("internal/auth/refresh")
  @HttpCode(200)
  async refresh(@Req() req: Request, @Body() body: unknown) {
    requireGateway(req);
    const b = parse(client.extend({ refreshToken: token }), body);
    const t = await this.d.auth.refresh(b.refreshToken, b);
    if (!t) throw fail(401, "invalid_refresh_token");
    return t;
  }

  @Post("internal/auth/logout")
  @HttpCode(204)
  async logout(@Req() req: Request, @Body() body: unknown) {
    requireGateway(req);
    const b = parse(client.extend({ refreshToken: token }), body);
    await this.d.auth.logout(b.refreshToken, b);
  }

  /** The gateway's cache miss: is this session alive, and which account version must tokens carry. */
  @Post("internal/auth/session-state")
  @HttpCode(200)
  async state(@Req() req: Request, @Body() body: unknown) {
    requireGateway(req);
    const b = parse(z.object({ sid: z.string().min(1).max(64) }), body);
    return this.d.auth.state(b.sid);
  }

  /** Whether the workspace requires two-step sign-in (the gateway caches it). */
  @Get("internal/mfa-policy")
  async policyFor(@Req() req: Request) {
    requireGateway(req, "principal.resolve");
    return { required: await this.required() };
  }

  // ---- my two-step sign-in ----

  @Get("me/mfa")
  async myMfa(@Req() req: Request) {
    const p = this.user(req);
    const u = await this.d.auth.users.byId(p.id);
    if (!u) throw new NotFoundException();
    const left = (await this.d.pool.query<{ n: number }>("SELECT count(*)::int AS n FROM auth_recovery_codes WHERE user_id = $1 AND used_at IS NULL", [p.id])).rows[0]!.n;
    return {
      enabled: u.totp_enabled,
      recoveryCodesLeft: left,
      required: await this.required(),
      thisSession: req.sessionId ? (await this.d.auth.state(req.sessionId)).mfa === true : null,
    };
  }

  /** Step 1: a new secret for the authenticator app (kept pending until a code proves it was saved). */
  @Post("me/mfa/setup")
  @HttpCode(200)
  async setup(@Req() req: Request) {
    const p = this.user(req);
    const u = await this.d.auth.users.byId(p.id);
    if (!u) throw new NotFoundException();
    if (u.totp_enabled) throw fail(409, "already_enabled");
    const secret = newTotpSecret();
    await this.d.pool.query("UPDATE users SET totp_pending_enc = $2, updated_at = now() WHERE id = $1", [p.id, encrypt(secret)]);
    return { secret, otpauthUrl: otpauthUrl(secret, u.email) };
  }

  /** Step 2: the first code turns it on, marks this session as two-step and returns the recovery codes. */
  @Post("me/mfa/enable")
  @HttpCode(200)
  async enable(@Req() req: Request, @Body() body: unknown) {
    const p = this.user(req);
    const b = parse(
      z.object({
        code: z
          .string()
          .trim()
          .regex(/^\d{6}$/),
      }),
      body,
    );
    const u = await this.d.auth.users.byId(p.id);
    if (!u?.totp_pending_enc) throw fail(400, "no_setup");
    if (!(await this.d.auth.consumeTotp(u, b.code, u.totp_pending_enc))) throw fail(400, "invalid_code");
    await this.d.pool.query("UPDATE users SET totp_secret_enc = totp_pending_enc, totp_pending_enc = NULL, totp_enabled = true, updated_at = now() WHERE id = $1", [p.id]);
    const codes = await this.newRecoveryCodes(p.id);
    if (req.sessionId) await this.markSessionMfa(p.id, req.sessionId);
    await this.d.auth.event("MFA_ENABLED", { userId: p.id, email: u.email });
    await withTransaction(this.d.pool, (c) => audit(c, "account.mfa_enabled", "member", p.id, {}));
    return { recoveryCodes: codes };
  }

  @Post("me/mfa/disable")
  @HttpCode(204)
  async disable(@Req() req: Request, @Body() body: unknown) {
    const p = this.user(req);
    const b = parse(z.object({ code: z.string().trim().max(20) }), body);
    if (await this.required()) throw fail(403, "required_by_workspace");
    const u = await this.d.auth.users.byId(p.id);
    if (!u?.totp_enabled) return;
    if (!(await this.d.auth.consumeTotp(u, b.code))) throw fail(400, "invalid_code");
    await this.d.pool.query("UPDATE users SET totp_enabled = false, totp_secret_enc = NULL, totp_last_step = NULL, updated_at = now() WHERE id = $1", [p.id]);
    await this.d.pool.query("DELETE FROM auth_recovery_codes WHERE user_id = $1", [p.id]);
    await this.d.auth.event("MFA_DISABLED", { userId: p.id, email: u.email });
    await withTransaction(this.d.pool, (c) => audit(c, "account.mfa_disabled", "member", p.id, {}));
  }

  @Post("me/mfa/recovery-codes")
  @HttpCode(200)
  async regenerate(@Req() req: Request, @Body() body: unknown) {
    const p = this.user(req);
    const b = parse(
      z.object({
        code: z
          .string()
          .trim()
          .regex(/^\d{6}$/),
      }),
      body,
    );
    const u = await this.d.auth.users.byId(p.id);
    if (!u?.totp_enabled) throw fail(400, "not_enabled");
    if (!(await this.d.auth.consumeTotp(u, b.code))) throw fail(400, "invalid_code");
    return { recoveryCodes: await this.newRecoveryCodes(p.id) };
  }

  // ---- workspace policy ----

  @Get("security/mfa-policy")
  async policy(@Req() req: Request) {
    const p = requirePrincipal(req);
    assertAllowed(p, "audit.read");
    return { required: await this.required() };
  }

  /** Everyone must use two-step sign-in. The admin turning it on must already use it (no lock-out). */
  @Put("security/mfa-policy")
  async setPolicy(@Req() req: Request, @Body() body: unknown) {
    const p = requirePrincipal(req);
    assertAllowed(p, "workspace.configure");
    const b = parse(z.object({ required: z.boolean() }), body);
    if (b.required && !(await this.d.auth.users.byId(p.id))?.totp_enabled) throw fail(400, "enable_mfa_first");
    await withTransaction(this.d.pool, async (c) => {
      await c.query("UPDATE workspace_settings SET require_mfa = $1", [b.required]);
      await audit(c, b.required ? "security.mfa_required" : "security.mfa_optional", "workspace", "mfa-policy", {});
    });
    return { required: b.required };
  }

  private user(req: Request): Principal {
    const p = requirePrincipal(req);
    if (p.type !== "user") throw new ForbiddenException();
    return p;
  }

  private async required(): Promise<boolean> {
    return withTransaction(this.d.pool, async (c) => (await c.query<{ r: boolean }>("SELECT require_mfa AS r FROM workspace_settings")).rows[0]?.r ?? false);
  }

  /** Ten single-use codes (xxxx-xxxx), shown once; only hashes are kept. Replaces the previous set. */
  private async newRecoveryCodes(userId: string): Promise<string[]> {
    const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
    const codes = Array.from({ length: RECOVERY_CODES }, () => {
      const s = Array.from({ length: 8 }, () => alphabet[randomInt(alphabet.length)]).join("");
      return `${s.slice(0, 4)}-${s.slice(4)}`;
    });
    const c = await this.d.pool.connect();
    try {
      await c.query("BEGIN");
      await c.query("DELETE FROM auth_recovery_codes WHERE user_id = $1", [userId]);
      for (const code of codes) await c.query("INSERT INTO auth_recovery_codes (user_id, code_hash) VALUES ($1,$2)", [userId, sha256(code.replace("-", ""))]);
      await c.query("COMMIT");
    } catch (e) {
      await c.query("ROLLBACK").catch(() => undefined);
      throw e;
    } finally {
      c.release();
    }
    return codes;
  }

  private async markSessionMfa(userId: string, sid: string) {
    await this.d.pool.query("UPDATE auth_sessions SET mfa = true WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL", [sid, userId]);
    const s = await this.d.auth.state(sid);
    if (s.active) this.d.auth.users.cache.set(sessionStateKey(sid), JSON.stringify(s), { ttlMs: 60_000 });
  }
}
