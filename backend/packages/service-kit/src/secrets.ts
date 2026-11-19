import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from "node:crypto";
import { DEV_INTERNAL_SECRET } from "./production-guard.js";

/**
 * AES-256-GCM for third-party credentials kept in the database (AI connection keys, notification bot tokens).
 * Each use has its own key: `override` (an env var name) when that variable is set, any string hashed to 32 bytes;
 * otherwise derived from INTERNAL_TOKEN_SECRET, which every installation already has, with `info` as the HKDF label
 * so one leaked derived key does not open the others. Changing the base secret makes stored values unreadable:
 * admins then enter them again.
 */
export interface SecretBox {
  encrypt(plain: string, env?: NodeJS.ProcessEnv): string;
  decrypt(enc: string, env?: NodeJS.ProcessEnv): string;
}

export function secretBox(info: string, override?: string): SecretBox {
  const key = (env: NodeJS.ProcessEnv = process.env): Buffer => {
    if (override && env[override]) return createHash("sha256").update(env[override]!).digest();
    const base = env.INTERNAL_TOKEN_SECRET ?? DEV_INTERNAL_SECRET;
    if (base === DEV_INTERNAL_SECRET && env.NODE_ENV === "production") throw new Error(`set ${override ? `${override} or ` : ""}INTERNAL_TOKEN_SECRET before saving secrets`);
    return Buffer.from(hkdfSync("sha256", base, "workspace", info, 32));
  };
  return {
    encrypt(plain, env) {
      const iv = randomBytes(12);
      const c = createCipheriv("aes-256-gcm", key(env), iv);
      const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
      return `v1:${Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64")}`;
    },
    decrypt(enc, env) {
      if (!enc.startsWith("v1:")) throw new Error("unknown secret format");
      const raw = Buffer.from(enc.slice(3), "base64");
      const d = createDecipheriv("aes-256-gcm", key(env), raw.subarray(0, 12));
      d.setAuthTag(raw.subarray(12, 28));
      return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString("utf8");
    },
  };
}
