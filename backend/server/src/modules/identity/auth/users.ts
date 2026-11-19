import type { Pool } from "pg";
import { newId } from "@workspace/shared";
import { kv, type MemoryKv } from "@workspace/service-kit";
import { checkPassword, hashPassword } from "./passwords.js";
import { revokeUserGrants } from "../oauth-store.js";

export interface UserRow {
  id: string;
  email: string;
  given_name: string;
  family_name: string;
  password_hash: string | null;
  enabled: boolean;
  auth_version: number;
  totp_secret_enc: string | null;
  totp_pending_enc: string | null;
  totp_enabled: boolean;
  totp_last_step: string | null;
  /** Set by invite-with-password or an admin reset; cleared when the person picks their own password. */
  password_must_change: boolean;
}

/** Access tokens live 10 minutes; a revoked session's cache entry must outlive the last token it issued. */
export const ACCESS_TTL_S = 600;
/** Cache of a session's state for the gateway (the server's shared memory store): {active, rv, mfa}. */
export const sessionStateKey = (sid: string) => `authsess:${sid}`;

/**
 * People's accounts: email, names, password, enabled.
 * Workspace membership stays in `members`; an account exists once per person across workspaces.
 */
export class UserDirectory {
  constructor(
    readonly pool: Pool,
    /** The store the gateway reads session state from (same process). */
    readonly cache: MemoryKv = kv(),
  ) {}

  async byEmail(email: string): Promise<UserRow | null> {
    return (await this.pool.query<UserRow>("SELECT * FROM users WHERE lower(email) = lower($1)", [email.trim()])).rows[0] ?? null;
  }

  async byId(userId: string): Promise<UserRow | null> {
    return (await this.pool.query<UserRow>("SELECT * FROM users WHERE id = $1", [userId])).rows[0] ?? null;
  }

  async findUserByEmail(email: string): Promise<string | null> {
    return (await this.byEmail(email))?.id ?? null;
  }

  /**
   * Creates the account if the email is new. Vietnamese names are written family name first ("Trần Minh
   * Hưng"), so the given name the app greets with is the last word.
   */
  async ensureUser(email: string, displayName: string, password?: string, opts: { mustChange?: boolean } = {}): Promise<string> {
    const existing = await this.findUserByEmail(email);
    if (existing) return existing;
    const words = displayName.trim().split(/\s+/);
    const given = words.at(-1) ?? displayName;
    const family = words.slice(0, -1).join(" ");
    const id = newId();
    const hash = password ? await hashPassword(password) : null;
    // A password handed over by someone else (the inviter typed it) is temporary: the person replaces it at first
    // sign-in. The owner's own password from /setup is theirs to keep.
    const mustChange = !!password && (opts.mustChange ?? false);
    const r = await this.pool.query<{ id: string }>(
      `INSERT INTO users (id, email, given_name, family_name, password_hash, password_changed_at, password_must_change)
       VALUES ($1,$2,$3,$4,$5, CASE WHEN $5::text IS NULL THEN NULL ELSE now() END, $6)
       ON CONFLICT ((lower(email))) DO NOTHING RETURNING id`,
      [id, email.trim(), given, family, hash, mustChange],
    );
    // Two invites of the same new email at once: the other one won.
    return r.rows[0]?.id ?? (await this.findUserByEmail(email))!;
  }

  async userById(userId: string): Promise<{ id: string; email: string; firstName: string; lastName: string; enabled: boolean } | null> {
    const u = await this.byId(userId);
    return u ? { id: u.id, email: u.email, firstName: u.given_name, lastName: u.family_name, enabled: u.enabled } : null;
  }

  /** Checks a password without signing in (change-password form). Same timing for unknown accounts. */
  async verifyPassword(email: string, password: string): Promise<boolean> {
    const u = await this.byEmail(email);
    return (await checkPassword(password, u?.password_hash)) && !!u;
  }

  /**
   * Sets a new password. Every other session ends (a stolen session does not survive a password change);
   * `keepSession` keeps the one the change was made from.
   */
  async setPassword(userId: string, password: string, keepSession?: string, opts: { mustChange?: boolean } = {}): Promise<void> {
    await this.pool.query("UPDATE users SET password_hash = $2, password_changed_at = now(), password_must_change = $3, updated_at = now() WHERE id = $1", [
      userId,
      await hashPassword(password),
      opts.mustChange ?? false,
    ]);
    await this.revokeSessions(userId, "password_changed", keepSession);
    // A reset (no session kept: forgotten password, an admin's reset) may follow a takeover; a change made by the
    // signed-in person, who knew the old password, keeps their integrations working.
    if (!keepSession) await this.revokePersonalKeys(userId);
    await this.bumpVersion(userId);
  }

  /** Whether the person still has to replace a password someone else set. */
  async mustChangePassword(userId: string): Promise<boolean> {
    return (await this.pool.query<{ m: boolean }>("SELECT password_must_change AS m FROM users WHERE id = $1", [userId])).rows[0]?.m ?? false;
  }

  async setGivenName(userId: string, givenName: string): Promise<void> {
    await this.pool.query("UPDATE users SET given_name = $2, updated_at = now() WHERE id = $1", [userId, givenName]);
  }

  /** Signs the person out everywhere: every session and every access token already issued. */
  /** Every session and every personal API key (keys act as the person). */
  async logoutAll(userId: string, reason = "logout_all"): Promise<void> {
    await this.revokeSessions(userId, reason);
    await this.revokePersonalKeys(userId);
    await this.bumpVersion(userId);
  }

  private async revokePersonalKeys(userId: string): Promise<void> {
    await this.pool.query("SELECT revoke_personal_api_keys($1)", [userId]);
    // Apps connected over OAuth (MCP clients) act as the person too.
    await revokeUserGrants(this.pool, userId);
  }

  /** Ends sessions (all, or all but one) and tells the gateway at once through the session-state cache. */
  async revokeSessions(userId: string, reason: string, except?: string): Promise<number> {
    const r = await this.pool.query<{ id: string }>(
      "UPDATE auth_sessions SET revoked_at = now(), revoke_reason = $2 WHERE user_id = $1 AND revoked_at IS NULL AND ($3::text IS NULL OR id <> $3) RETURNING id",
      [userId, reason, except ?? null],
    );
    await this.markRevoked(r.rows.map((x) => x.id));
    return r.rowCount ?? 0;
  }

  async markRevoked(sids: string[]): Promise<void> {
    for (const sid of sids) this.cache.set(sessionStateKey(sid), JSON.stringify({ active: false }), { ttlMs: (ACCESS_TTL_S + 60) * 1000 });
  }

  /**
   * Tokens issued before now carry an older `rv` and are refused; live sessions get a fresh token on refresh.
   * The new state is written (not just dropped) so a gateway read racing with this change cannot put the
   * old version back (the gateway only fills the cache when the key is absent).
   */
  async bumpVersion(userId: string): Promise<void> {
    const v = (
      await this.pool.query<{ auth_version: number; password_must_change: boolean }>(
        "UPDATE users SET auth_version = auth_version + 1, updated_at = now() WHERE id = $1 RETURNING auth_version, password_must_change",
        [userId],
      )
    ).rows[0];
    if (!v) return;
    const live = (await this.pool.query<{ id: string; mfa: boolean }>("SELECT id, mfa FROM auth_sessions WHERE user_id = $1 AND revoked_at IS NULL", [userId])).rows;
    for (const s of live)
      this.cache.set(sessionStateKey(s.id), JSON.stringify({ active: true, userId, rv: v.auth_version, mfa: s.mfa, pwc: v.password_must_change }), { ttlMs: 60_000 });
  }
}
