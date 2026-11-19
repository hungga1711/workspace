import { createHmac, randomBytes } from "node:crypto";
import { safeEqual } from "./crypto.js";

/**
 * TOTP (RFC 6238: HMAC-SHA1, 6 digits, 30-second steps), the scheme every authenticator app speaks
 * (Google Authenticator, Microsoft Authenticator, 1Password…). A code is accepted one step either side
 * of now (clock drift) and each step only once (the caller stores the last step used).
 */
const STEP = 30;
const DIGITS = 6;
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.replace(/=+$/, "").replace(/\s+/g, "").toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error("invalid base32");
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A new 160-bit secret, base32 (what authenticator apps take). */
export const newTotpSecret = () => base32Encode(randomBytes(20));

export function hotp(secret: string, counter: number): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = createHmac("sha1", base32Decode(secret)).update(msg).digest();
  const offset = h[h.length - 1]! & 0xf;
  const code = ((h[offset]! & 0x7f) << 24) | (h[offset + 1]! << 16) | (h[offset + 2]! << 8) | h[offset + 3]!;
  return String(code % 10 ** DIGITS).padStart(DIGITS, "0");
}

export const currentStep = (now = Date.now()) => Math.floor(now / 1000 / STEP);

/**
 * The time step the code belongs to, or null. Steps at or before lastStep are refused (a code seen once
 * cannot be replayed, even inside its 90-second window).
 */
export function verifyTotp(secret: string, code: string, lastStep: number | null, now = Date.now()): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const t = currentStep(now);
  for (const step of [t - 1, t, t + 1]) {
    if (lastStep !== null && step <= lastStep) continue;
    if (safeEqual(hotp(secret, step), code)) return step;
  }
  return null;
}

/**
 * Whether `code` is a valid code that was already accepted (its step is at or before the last one used): the person
 * typed the same code twice within its 30 seconds. The sign-in screen says to wait for the next one instead of
 * "wrong code".
 */
export function totpAlreadyUsed(secret: string, code: string, lastStep: number | null, now = Date.now()): boolean {
  if (lastStep === null || !/^\d{6}$/.test(code)) return false;
  const t = currentStep(now);
  return [t - 1, t, t + 1].some((step) => step <= lastStep && safeEqual(hotp(secret, step), code));
}

export const otpauthUrl = (secret: string, account: string, issuer = "workspace") =>
  `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${DIGITS}&period=${STEP}`;
