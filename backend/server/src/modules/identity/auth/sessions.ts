import { SignJWT } from "jose";
import type { Pool, PoolClient } from "pg";
import { recordAudit, withTransaction } from "@workspace/shared";
import { checkPassword } from "./passwords.js";
import { decrypt, randomToken, sha256 } from "./crypto.js";
import type { SigningKeys } from "./keys.js";
import { totpAlreadyUsed, verifyTotp } from "./totp.js";
import { ACCESS_TTL_S, sessionStateKey, type UserDirectory, type UserRow } from "./users.js";

/**
 * Sessions and tokens.
 *
 * - Access token: JWT, EdDSA (Ed25519), 10 minutes; claims sub, sid, rv (account version), mfa. Verified
 *   by the gateway with the public keys alone; a revoked session or a bumped version is caught through a
 *   small in-memory cache of the session's state (filled from here on a miss, overwritten here on change).
 * - Refresh token: 256 random bits, stored as SHA-256, 30 days, replaced on every use. Presenting a spent
 *   one means it was copied: the whole session ends.
 * - Lockout: failures per email (known or not, so the answer never tells whether an account exists; wrong
 *   passwords and wrong two-step codes alike) lock sign-in for 30 s after 5 failures, doubling up to 15 minutes;
 *   a completed sign-in resets it.
 */
export const ISSUER = "workspace";
export const AUDIENCE = "workspace";
const REFRESH_TTL_MS = Number(process.env.AUTH_REFRESH_DAYS ?? 30) * 86400_000;
const SESSION_MAX_MS = Number(process.env.AUTH_SESSION_MAX_DAYS ?? 90) * 86400_000;
const CHALLENGE_TTL_MS = 5 * 60_000;
const CHALLENGE_ATTEMPTS = 5;
const LOCK_AFTER = Number(process.env.LOGIN_LOCK_AFTER ?? 5);
const LOCK_BASE_S = 30;
const LOCK_MAX_S = 15 * 60;

export interface ClientInfo {
  ip?: string | null | undefined;
  userAgent?: string | null | undefined;
}

export interface Tokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  sessionId: string;
  user: { id: string; email: string; givenName: string; familyName: string; name: string; mustChangePassword: boolean };
}

export type LoginResult = { ok: true; tokens: Tokens } | { ok: false; mfa: true; challenge: string } | { ok: false; error: "invalid" | "locked" | "disabled"; retryAfter?: number };

export interface SessionState {
  active: boolean;
  userId?: string;
  rv?: number;
  /** The person must replace a password someone else set before using the app (gateway: password_change_required). */
  pwc?: boolean;
  mfa?: boolean;
}

const nameOf = (u: Pick<UserRow, "given_name" | "family_name" | "email">) => [u.family_name, u.given_name].filter(Boolean).join(" ") || u.email;
const lockKey = (email: string) => `authlock:${sha256(email.trim().toLowerCase())}`;

export class AuthService {
  constructor(
    private readonly pool: Pool,
    private readonly keys: SigningKeys,
    readonly users: UserDirectory,
  ) {}

  // ---- password sign-in ----

  async login(email: string, password: string, client: ClientInfo): Promise<LoginResult> {
    const locked = this.lockedFor(email);
    if (locked > 0) {
      await this.event("LOGIN_ERROR", { email, error: "user_temporarily_disabled", ...client });
      return { ok: false, error: "locked", retryAfter: locked };
    }
    // Counted as a failure before the slow check (a success clears it), with no await since the lock check:
    // guesses sent in parallel all passed that check otherwise, and each got its password tried.
    const lockedNow = this.recordFailure(email);
    const u = await this.users.byEmail(email);
    const ok = (await checkPassword(password, u?.password_hash)) && !!u;
    if (!ok || !u) {
      await this.event("LOGIN_ERROR", { userId: u?.id, email, error: "invalid_user_credentials", ...client });
      return lockedNow > 0 ? { ok: false, error: "locked", retryAfter: lockedNow } : { ok: false, error: "invalid" };
    }
    // With two-step sign-in the password alone clears nothing: code guesses count against the same lock, and a
    // right password between rounds of them must not reset it. This attempt's own count is taken back.
    if (u.totp_enabled) this.refund(email, lockedNow > 0);
    else this.users.cache.del(`${lockKey(email)}:fails`, `${lockKey(email)}:until`);
    if (!u.enabled) {
      await this.event("LOGIN_ERROR", { userId: u.id, email, error: "user_disabled", ...client });
      return { ok: false, error: "disabled" };
    }
    if (u.totp_enabled) {
      const challenge = randomToken();
      await this.pool.query("INSERT INTO auth_challenges (token_hash, user_id, ip, user_agent, expires_at) VALUES ($1,$2,$3,$4, now() + $5 * interval '1 millisecond')", [
        sha256(challenge),
        u.id,
        client.ip ?? null,
        client.userAgent?.slice(0, 300) ?? null,
        CHALLENGE_TTL_MS,
      ]);
      return { ok: false, mfa: true, challenge };
    }
    const tokens = await this.startSession(u, { method: "password", mfa: false }, client);
    await this.event("LOGIN", { userId: u.id, email: u.email, ...client });
    return { ok: true, tokens };
  }

  /** Second step: a TOTP code, or a one-time recovery code (xxxx-xxxx). */
  async verifyMfa(challenge: string, code: string, client: ClientInfo): Promise<{ ok: true; tokens: Tokens } | { ok: false; error: "invalid_code" | "code_used" | "expired" }> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(challenge)) return { ok: false, error: "expired" };
    const c = (
      await this.pool.query<{ user_id: string }>(
        `UPDATE auth_challenges SET attempts = attempts + 1 WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now() AND attempts < $2 RETURNING user_id`,
        [sha256(challenge), CHALLENGE_ATTEMPTS],
      )
    ).rows[0];
    if (!c) return { ok: false, error: "expired" };
    const u = await this.users.byId(c.user_id);
    if (!u || !u.enabled || !u.totp_enabled || !u.totp_secret_enc) return { ok: false, error: "expired" };
    // Like passwords: the lock applies, and a guess counts before the check, so parallel guesses over several
    // challenges cannot outrun it.
    if (this.lockedFor(u.email) > 0) {
      await this.pool.query("UPDATE auth_challenges SET used_at = now() WHERE token_hash = $1", [sha256(challenge)]);
      return { ok: false, error: "invalid_code" };
    }
    const lockedNow = this.recordFailure(u.email);
    const clean = code.replace(/\s+/g, "");
    let ok = false;
    if (/^\d{6}$/.test(clean)) ok = await this.consumeTotp(u, clean);
    else if (/^[a-z0-9]{4}-?[a-z0-9]{4}$/i.test(clean)) ok = await this.consumeRecoveryCode(u.id, clean);
    if (!ok) {
      await this.event("LOGIN_ERROR", { userId: u.id, email: u.email, error: "invalid_totp", ...client });
      if (lockedNow > 0) await this.pool.query("UPDATE auth_challenges SET used_at = now() WHERE token_hash = $1", [sha256(challenge)]);
      return { ok: false, error: /^\d{6}$/.test(clean) && this.totpReused(u, clean) ? "code_used" : "invalid_code" };
    }
    const spent = await this.pool.query("UPDATE auth_challenges SET used_at = now() WHERE token_hash = $1 AND used_at IS NULL", [sha256(challenge)]);
    if (!spent.rowCount) return { ok: false, error: "expired" };
    this.users.cache.del(`${lockKey(u.email)}:fails`, `${lockKey(u.email)}:until`);
    const tokens = await this.startSession(u, { method: "password", mfa: true }, client);
    await this.event("LOGIN", { userId: u.id, email: u.email, ...client });
    return { ok: true, tokens };
  }

  /** Accepts a TOTP code once: the step is recorded atomically, so a replay (even in parallel) fails. */
  async consumeTotp(u: Pick<UserRow, "id" | "totp_secret_enc" | "totp_last_step">, code: string, secretEnc = u.totp_secret_enc): Promise<boolean> {
    if (!secretEnc) return false;
    let secret: string;
    try {
      secret = decrypt(secretEnc);
    } catch {
      return false; // AUTH_SECRET changed: the seed is unreadable; recovery codes (hashed) still work
    }
    const step = verifyTotp(secret, code, u.totp_last_step === null ? null : Number(u.totp_last_step));
    if (step === null) return false;
    const r = await this.pool.query("UPDATE users SET totp_last_step = $2 WHERE id = $1 AND (totp_last_step IS NULL OR totp_last_step < $2)", [u.id, step]);
    return (r.rowCount ?? 0) > 0;
  }

  /** A correct code that was already used (typed twice within its 30 seconds), told apart from a wrong one. */
  private totpReused(u: Pick<UserRow, "totp_secret_enc" | "totp_last_step">, code: string): boolean {
    if (!u.totp_secret_enc) return false;
    try {
      return totpAlreadyUsed(decrypt(u.totp_secret_enc), code, u.totp_last_step === null ? null : Number(u.totp_last_step));
    } catch {
      return false;
    }
  }

  private async consumeRecoveryCode(userId: string, code: string): Promise<boolean> {
    const norm = code.toLowerCase().replace("-", "");
    const r = await this.pool.query("UPDATE auth_recovery_codes SET used_at = now() WHERE user_id = $1 AND code_hash = $2 AND used_at IS NULL", [userId, sha256(norm)]);
    return (r.rowCount ?? 0) > 0;
  }

  // ---- sessions ----

  /** A new session (new id: no fixation) with its first refresh token. */
  async startSession(u: UserRow, how: { method: "password"; mfa: boolean }, client: ClientInfo): Promise<Tokens> {
    const sid = randomToken(18);
    const refresh = randomToken();
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN");
      await c.query("INSERT INTO auth_sessions (id, user_id, method, mfa, ip, user_agent, expires_at) VALUES ($1,$2,$3,$4,$5,$6, now() + $7 * interval '1 millisecond')", [
        sid,
        u.id,
        how.method,
        how.mfa,
        client.ip ?? null,
        client.userAgent?.slice(0, 300) ?? null,
        SESSION_MAX_MS,
      ]);
      await this.insertRefresh(c, sid, refresh);
      await c.query("COMMIT");
    } catch (e) {
      await c.query("ROLLBACK").catch(() => undefined);
      throw e;
    } finally {
      c.release();
    }
    return this.tokens(u, sid, how.mfa, refresh);
  }

  /** Exchanges a refresh token for a new pair. A spent token revokes its whole session (it was copied). */
  async refresh(refreshToken: string, client: ClientInfo): Promise<Tokens | null> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(refreshToken)) return null;
    const c = await this.pool.connect();
    let out: { u: UserRow; sid: string; mfa: boolean; next: string } | null = null;
    let reused: { sid: string; userId: string } | null = null;
    try {
      await c.query("BEGIN");
      const row = (
        await c.query<{ session_id: string; used_at: Date | null; expires_at: Date; user_id: string; revoked_at: Date | null; s_expires: Date; mfa: boolean }>(
          `SELECT t.session_id, t.used_at, t.expires_at, s.user_id, s.revoked_at, s.expires_at AS s_expires, s.mfa
             FROM auth_refresh_tokens t JOIN auth_sessions s ON s.id = t.session_id WHERE t.token_hash = $1 FOR UPDATE OF t, s`,
          [sha256(refreshToken)],
        )
      ).rows[0];
      if (!row) {
        await c.query("ROLLBACK");
        return null;
      }
      if (row.used_at) {
        reused = { sid: row.session_id, userId: row.user_id };
        await c.query("UPDATE auth_sessions SET revoked_at = coalesce(revoked_at, now()), revoke_reason = coalesce(revoke_reason, 'refresh_reuse') WHERE id = $1", [
          row.session_id,
        ]);
        await c.query("COMMIT");
      } else if (row.revoked_at || row.expires_at < new Date() || row.s_expires < new Date()) {
        await c.query("ROLLBACK");
        return null;
      } else {
        const u = (await c.query<UserRow>("SELECT * FROM users WHERE id = $1", [row.user_id])).rows[0];
        if (!u || !u.enabled) {
          await c.query("ROLLBACK");
          return null;
        }
        const next = randomToken();
        await c.query("UPDATE auth_refresh_tokens SET used_at = now() WHERE token_hash = $1", [sha256(refreshToken)]);
        await this.insertRefresh(c, row.session_id, next);
        await c.query("UPDATE auth_sessions SET last_seen_at = now(), ip = coalesce($2, ip) WHERE id = $1", [row.session_id, client.ip ?? null]);
        await c.query("COMMIT");
        out = { u, sid: row.session_id, mfa: row.mfa, next };
      }
    } catch (e) {
      await c.query("ROLLBACK").catch(() => undefined);
      throw e;
    } finally {
      c.release();
    }
    if (reused) {
      await this.users.markRevoked([reused.sid]);
      await this.event("REFRESH_TOKEN_REUSED", { userId: reused.userId, error: "refresh_token_reused", ...client });
      return null;
    }
    return out ? this.tokens(out.u, out.sid, out.mfa, out.next) : null;
  }

  /** Signs out the session a refresh token belongs to. */
  async logout(refreshToken: string, client: ClientInfo): Promise<void> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(refreshToken)) return;
    const r = (
      await this.pool.query<{ id: string; user_id: string }>(
        `UPDATE auth_sessions s SET revoked_at = coalesce(s.revoked_at, now()), revoke_reason = coalesce(s.revoke_reason, 'logout')
           FROM auth_refresh_tokens t WHERE t.token_hash = $1 AND t.session_id = s.id RETURNING s.id, s.user_id`,
        [sha256(refreshToken)],
      )
    ).rows[0];
    if (!r) return;
    await this.users.markRevoked([r.id]);
    await this.event("LOGOUT", { userId: r.user_id, ...client });
  }

  /** What the gateway needs to accept a token: is the session alive, and the account's current version. */
  async state(sid: string): Promise<SessionState> {
    const r = (
      await this.pool.query<{ user_id: string; mfa: boolean; auth_version: number; enabled: boolean; pwc: boolean }>(
        `SELECT s.user_id, s.mfa, u.auth_version, u.enabled, u.password_must_change AS pwc FROM auth_sessions s JOIN users u ON u.id = s.user_id
          WHERE s.id = $1 AND s.revoked_at IS NULL AND s.expires_at > now()`,
        [sid],
      )
    ).rows[0];
    return r && r.enabled ? { active: true, userId: r.user_id, rv: r.auth_version, mfa: r.mfa, pwc: r.pwc } : { active: false };
  }

  async listSessions(userId: string) {
    return (
      await this.pool.query<{ id: string; ip: string | null; created_at: Date; last_seen_at: Date; method: string; user_agent: string | null }>(
        "SELECT id, ip, created_at, last_seen_at, method, user_agent FROM auth_sessions WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now() ORDER BY last_seen_at DESC LIMIT 50",
        [userId],
      )
    ).rows;
  }

  /** Ends one of a person's own sessions (never someone else's). */
  async endSession(userId: string, sid: string): Promise<boolean> {
    const r = await this.pool.query("UPDATE auth_sessions SET revoked_at = now(), revoke_reason = 'ended' WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL", [sid, userId]);
    if (!r.rowCount) return false;
    await this.users.markRevoked([sid]);
    return true;
  }

  // ---- sign-in history ----

  async event(
    type: string,
    e: { userId?: string | null | undefined; email?: string | null | undefined; error?: string; ip?: string | null | undefined; userAgent?: string | null | undefined },
  ) {
    await this.pool
      .query("INSERT INTO auth_events (type, user_id, email, ip, user_agent, error) VALUES ($1,$2,$3,$4,$5,$6)", [
        type,
        e.userId ?? null,
        e.email?.toLowerCase() ?? null,
        e.ip ?? null,
        e.userAgent?.slice(0, 300) ?? null,
        e.error ?? null,
      ])
      .catch(() => undefined);
    // Sign-ins, failed sign-ins, sign-outs and stolen refresh tokens also go to the audit trail (ADR 0025); 2FA and
    // password changes are recorded there by their own endpoints.
    const action = TRAIL_ACTIONS[type];
    if (!action) return;
    const email = e.email?.toLowerCase() ?? null;
    await withTransaction(this.pool, (c) =>
      recordAudit(c, {
        action: action.action,
        outcome: action.outcome,
        // A failed sign-in names the account tried as the target, never as the actor: anyone can type an email.
        actorId: e.userId && action.outcome === "success" ? `user:${e.userId}` : "anonymous",
        targetType: "member",
        targetId: e.userId ?? email ?? "unknown",
        targetLabel: email,
        ...(e.error ? { meta: { error: e.error.slice(0, 80) } } : {}),
        origin: { ip: e.ip ?? undefined, userAgent: e.userAgent?.slice(0, 300) ?? undefined, via: "session" },
      }),
    ).catch(() => undefined);
  }

  /** Ninety days of history; old sessions and spent tokens go too. */
  async prune(): Promise<void> {
    await this.pool.query("DELETE FROM auth_events WHERE at < now() - interval '90 days'");
    await this.pool.query("DELETE FROM auth_challenges WHERE expires_at < now() - interval '1 day'");
    await this.pool.query("DELETE FROM auth_sessions WHERE (revoked_at IS NOT NULL AND revoked_at < now() - interval '30 days') OR expires_at < now() - interval '30 days'");
    await this.pool.query("DELETE FROM auth_refresh_tokens WHERE expires_at < now() - interval '1 day' OR (used_at IS NOT NULL AND used_at < now() - interval '35 days')");
  }

  // ---- internals ----

  private async insertRefresh(c: PoolClient, sid: string, token: string) {
    await c.query("INSERT INTO auth_refresh_tokens (token_hash, session_id, expires_at) VALUES ($1,$2, now() + $3 * interval '1 millisecond')", [
      sha256(token),
      sid,
      REFRESH_TTL_MS,
    ]);
  }

  private async tokens(u: UserRow, sid: string, mfa: boolean, refreshToken: string): Promise<Tokens> {
    const { kid, key } = await this.keys.signer();
    const accessToken = await new SignJWT({ sid, rv: u.auth_version, mfa })
      .setProtectedHeader({ alg: "EdDSA", kid, typ: "at+jwt" })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setSubject(u.id)
      .setJti(randomToken(12))
      .setIssuedAt()
      .setExpirationTime(`${ACCESS_TTL_S}s`)
      .sign(key);
    // The gateway's view of this session starts right (no database read on the first request).
    this.users.cache.set(sessionStateKey(sid), JSON.stringify({ active: true, userId: u.id, rv: u.auth_version, mfa, pwc: u.password_must_change }), { ttlMs: 60_000, nx: true });
    return {
      accessToken,
      refreshToken,
      expiresIn: ACCESS_TTL_S,
      sessionId: sid,
      user: { id: u.id, email: u.email, givenName: u.given_name, familyName: u.family_name, name: nameOf(u), mustChangePassword: u.password_must_change },
    };
  }

  /**
   * Seconds the email is still locked for (0 = not locked). Failures are counted in the server's memory: a restart
   * forgets them, which only ever shortens a lock; one process means one count, with nothing to share it with.
   */
  private lockedFor(email: string): number {
    const until = Number(this.users.cache.get(`${lockKey(email)}:until`) ?? 0);
    return Math.max(0, Math.ceil((until - Date.now()) / 1000));
  }

  /** Takes back one counted attempt that turned out right, and the lock it started, if it did. */
  private refund(email: string, startedLock: boolean): void {
    const k = lockKey(email);
    const n = Number(this.users.cache.get(`${k}:fails`) ?? 0);
    if (n > 0) this.users.cache.set(`${k}:fails`, String(n - 1), { keepTtl: true });
    if (startedLock) this.users.cache.del(`${k}:until`);
  }

  /** Counts a failure; returns the lock in seconds when this failure starts one. */
  private recordFailure(email: string): number {
    const k = lockKey(email);
    const n = this.users.cache.incr(`${k}:fails`);
    this.users.cache.expire(`${k}:fails`, 24 * 3600_000);
    if (n < LOCK_AFTER) return 0;
    const secs = Math.min(LOCK_MAX_S, LOCK_BASE_S * 2 ** (n - LOCK_AFTER));
    this.users.cache.set(`${k}:until`, String(Date.now() + secs * 1000), { ttlMs: 24 * 3600_000 });
    return secs;
  }
}

/** Sign-in history types that also go to the audit trail. */
const TRAIL_ACTIONS: Record<string, { action: string; outcome: "success" | "failure" | "denied" }> = {
  LOGIN: { action: "identity.auth.signed_in", outcome: "success" },
  LOGIN_ERROR: { action: "identity.auth.sign_in_failed", outcome: "failure" },
  LOGOUT: { action: "identity.auth.signed_out", outcome: "success" },
  REFRESH_TOKEN_REUSED: { action: "identity.auth.token_reused", outcome: "denied" },
};
