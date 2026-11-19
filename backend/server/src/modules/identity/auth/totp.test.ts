import { describe, expect, it } from "vitest";
import { base32Decode, base32Encode, hotp, newTotpSecret, otpauthUrl, totpAlreadyUsed, verifyTotp } from "./totp.js";
import { decrypt, encrypt, safeEqual } from "./crypto.js";
import { randomBytes } from "node:crypto";

// RFC 6238 appendix B (SHA-1 seed "12345678901234567890"), last six digits.
const SEED = base32Encode(Buffer.from("12345678901234567890"));

describe("TOTP", () => {
  it("matches the RFC 6238 test vectors", () => {
    expect(SEED).toBe("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
    expect(hotp(SEED, Math.floor(59 / 30))).toBe("287082");
    expect(hotp(SEED, Math.floor(1111111109 / 30))).toBe("081804");
    expect(hotp(SEED, Math.floor(1234567890 / 30))).toBe("005924");
    expect(hotp(SEED, Math.floor(2000000000 / 30))).toBe("279037");
  });

  it("accepts one step of drift either way, never further, and never a step at or before the last used", () => {
    const now = 1111111109_000;
    const step = Math.floor(now / 30_000);
    expect(verifyTotp(SEED, hotp(SEED, step), null, now)).toBe(step);
    expect(verifyTotp(SEED, hotp(SEED, step - 1), null, now)).toBe(step - 1);
    expect(verifyTotp(SEED, hotp(SEED, step + 1), null, now)).toBe(step + 1);
    expect(verifyTotp(SEED, hotp(SEED, step + 2), null, now)).toBeNull();
    expect(verifyTotp(SEED, hotp(SEED, step - 2), null, now)).toBeNull();
    // replay: the same step, or an older one, after it was used
    expect(verifyTotp(SEED, hotp(SEED, step), step, now)).toBeNull();
    expect(verifyTotp(SEED, hotp(SEED, step - 1), step, now)).toBeNull();
    expect(verifyTotp(SEED, hotp(SEED, step + 1), step, now)).toBe(step + 1);
    expect(verifyTotp(SEED, "12345", null, now)).toBeNull();
    expect(verifyTotp(SEED, "abcdef", null, now)).toBeNull();
  });

  it("makes 160-bit secrets that round-trip through base32, and an otpauth URL apps read", () => {
    const s = newTotpSecret();
    expect(s).toMatch(/^[A-Z2-7]{32}$/);
    expect(base32Decode(s)).toHaveLength(20);
    const raw = randomBytes(37);
    expect(base32Decode(base32Encode(raw)).equals(raw)).toBe(true);
    expect(otpauthUrl(s, "an@example.com")).toBe(`otpauth://totp/workspace:an%40example.com?secret=${s}&issuer=workspace&algorithm=SHA1&digits=6&period=30`);
  });
});

describe("secrets at rest", () => {
  it("encrypts with AES-256-GCM: random IV, tamper-evident, wrong key refused", () => {
    const a = encrypt("JBSWY3DPEHPK3PXP");
    const b = encrypt("JBSWY3DPEHPK3PXP");
    expect(a).not.toBe(b);
    expect(a).not.toContain("JBSWY3DPEHPK3PXP");
    expect(decrypt(a)).toBe("JBSWY3DPEHPK3PXP");
    const parts = a.split(".");
    const flipped = [...parts.slice(0, 3), Buffer.from(Buffer.from(parts[3]!, "base64url").map((x, i) => (i === 0 ? x ^ 1 : x))).toString("base64url")].join(".");
    expect(() => decrypt(flipped)).toThrow();
    expect(() => decrypt(a, randomBytes(32))).toThrow();
  });

  it("compares in constant time and handles different lengths", () => {
    expect(safeEqual("123456", "123456")).toBe(true);
    expect(safeEqual("123456", "123457")).toBe(false);
    expect(safeEqual("123456", "1234567")).toBe(false);
  });
});

describe("totpAlreadyUsed", () => {
  it("tells a code typed twice in its 30 seconds apart from a wrong one", () => {
    const secret = "JBSWY3DPEHPK3PXP";
    const now = 1_700_000_000_000;
    const step = Math.floor(now / 30_000);
    const code = hotp(secret, step);
    expect(totpAlreadyUsed(secret, code, step, now)).toBe(true);
    expect(totpAlreadyUsed(secret, code, step - 1, now)).toBe(false);
    expect(totpAlreadyUsed(secret, code, null, now)).toBe(false);
    expect(totpAlreadyUsed(secret, code === "000000" ? "111111" : "000000", step, now)).toBe(false);
  });
});
