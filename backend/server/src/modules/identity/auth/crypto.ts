import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Small crypto helpers for authentication. Only node:crypto: random tokens, SHA-256 for high-entropy
 * secrets (refresh tokens, links, recovery codes: a slow hash adds nothing when the input is 256 random
 * bits), and AES-256-GCM for secrets we must read back (TOTP seeds, signing keys, IdP client secrets).
 */

const DEV_SECRET = "dev-internal-secret-change-me-32bytes!";

/** 32 random bytes, base64url (43 characters). */
export const randomToken = (bytes = 32) => randomBytes(bytes).toString("base64url");
export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * The key that encrypts auth secrets at rest: AUTH_SECRET when set, else derived from the internal token
 * secret (HKDF, its own label, so the two never share key material). Production refuses the dev default.
 */
let cached: Buffer | null = null;
export function secretKey(): Buffer {
  if (cached) return cached;
  const own = process.env.AUTH_SECRET;
  const base = own ?? process.env.INTERNAL_TOKEN_SECRET ?? DEV_SECRET;
  if (process.env.NODE_ENV === "production" && (base === DEV_SECRET || base.length < 32)) {
    throw new Error("AUTH_SECRET (or INTERNAL_TOKEN_SECRET) must be set to 32+ random characters in production");
  }
  cached = Buffer.from(hkdfSync("sha256", base, "workspace", "workspace-auth-secrets-v1", 32));
  return cached;
}

/** v1.<iv>.<tag>.<ciphertext>, all base64url. */
export function encrypt(plain: string, key = secretKey()): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return ["v1", iv.toString("base64url"), c.getAuthTag().toString("base64url"), data.toString("base64url")].join(".");
}

export function decrypt(sealed: string, key = secretKey()): string {
  const [v, iv, tag, data] = sealed.split(".");
  if (v !== "v1" || !iv || !tag || data === undefined) throw new Error("malformed secret");
  const d = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
  d.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([d.update(Buffer.from(data, "base64url")), d.final()]).toString("utf8");
}
