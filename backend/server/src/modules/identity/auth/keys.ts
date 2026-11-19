import { createPrivateKey, generateKeyPairSync, type KeyObject } from "node:crypto";
import { exportJWK, type JWK } from "jose";
import type { Pool } from "pg";
import { decrypt, encrypt, randomToken } from "./crypto.js";

/**
 * Ed25519 keys that sign access tokens. The newest key signs; a key is replaced after ROTATE_DAYS and the
 * old one keeps verifying for one more day (far longer than an access token lives), then leaves the JWKS.
 * Private keys are stored encrypted; processes agree on the current key through the database (an advisory
 * lock makes only one of them create the next key, e.g. when a restart overlaps the old process).
 */
const ROTATE_DAYS = Number(process.env.AUTH_KEY_ROTATE_DAYS ?? 30);
const OVERLAP_MS = 24 * 3600_000;
const CACHE_MS = 60_000;

interface Row {
  kid: string;
  private_enc: string;
  public_jwk: JWK;
  created_at: Date;
  retires_at: Date | null;
}

export class SigningKeys {
  private current: { kid: string; key: KeyObject; at: number; created: number } | null = null;

  constructor(private readonly pool: Pool) {}

  /** The key to sign with now (rotating it when due). */
  async signer(): Promise<{ kid: string; key: KeyObject }> {
    const now = Date.now();
    if (this.current && now - this.current.at < CACHE_MS && now - this.current.created < ROTATE_DAYS * 86400_000) return this.current;
    let row = await this.newest();
    if (!row || now - row.created_at.getTime() >= ROTATE_DAYS * 86400_000) row = await this.rotate();
    let key: KeyObject;
    try {
      key = createPrivateKey(decrypt(row.private_enc));
    } catch {
      // AUTH_SECRET changed: the stored key is unreadable. A new one takes over (everyone signs in again).
      row = await this.rotate(true);
      key = createPrivateKey(decrypt(row.private_enc));
    }
    this.current = { kid: row.kid, key, at: now, created: row.created_at.getTime() };
    return this.current;
  }

  /** Public keys that may still verify a token (the JWKS). */
  async jwks(): Promise<{ keys: JWK[] }> {
    await this.signer(); // a fresh install has no key until the first one is made
    const r = await this.pool.query<Row>("SELECT kid, public_jwk FROM auth_keys WHERE retires_at IS NULL OR retires_at > now() ORDER BY created_at DESC");
    return { keys: r.rows.map((k) => ({ ...k.public_jwk, kid: k.kid, alg: "EdDSA", use: "sig" })) };
  }

  /** Makes a new signing key and schedules the previous ones to retire after the overlap. */
  async rotate(force = false): Promise<Row> {
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN");
      await c.query("SELECT pg_advisory_xact_lock(hashtext('workspace:auth-key-rotate'))");
      const latest = (await c.query<Row>("SELECT * FROM auth_keys WHERE retires_at IS NULL ORDER BY created_at DESC LIMIT 1")).rows[0];
      // Another process rotated while we waited for the lock.
      if (latest && !force && Date.now() - latest.created_at.getTime() < ROTATE_DAYS * 86400_000) {
        await c.query("COMMIT");
        return latest;
      }
      const { privateKey, publicKey } = generateKeyPairSync("ed25519");
      const kid = randomToken(12);
      const pub = await exportJWK(publicKey);
      await c.query("UPDATE auth_keys SET retires_at = now() + $1 * interval '1 millisecond' WHERE retires_at IS NULL", [OVERLAP_MS]);
      const row = (
        await c.query<Row>("INSERT INTO auth_keys (kid, private_enc, public_jwk) VALUES ($1,$2,$3) RETURNING *", [
          kid,
          encrypt(privateKey.export({ type: "pkcs8", format: "pem" }).toString()),
          JSON.stringify(pub),
        ])
      ).rows[0]!;
      await c.query("COMMIT");
      this.current = null;
      return row;
    } catch (e) {
      await c.query("ROLLBACK").catch(() => undefined);
      throw e;
    } finally {
      c.release();
    }
  }

  private async newest(): Promise<Row | undefined> {
    return (await this.pool.query<Row>("SELECT * FROM auth_keys WHERE retires_at IS NULL ORDER BY created_at DESC LIMIT 1")).rows[0];
  }
}
