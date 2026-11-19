import { describe, expect, it } from "vitest";
import { temporaryPassword } from "./admin-accounts.js";
import { passwordProblem } from "./accounts.js";

describe("temporaryPassword", () => {
  it("is 12 unambiguous letters and digits and passes the password rule", () => {
    for (let i = 0; i < 200; i++) {
      const p = temporaryPassword();
      expect(p).toMatch(/^[abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789]{12}$/);
      expect(passwordProblem(p)).toBeNull();
    }
  });
  it("differs between calls", () => {
    expect(new Set(Array.from({ length: 50 }, () => temporaryPassword())).size).toBe(50);
  });
});
