import { describe, expect, it } from "vitest";
import { withNickname } from "./members-summary.controller.js";

const row = (displayName: string, givenName: string | null) => ({ userId: "u1", displayName, status: "active", avatarVersion: 0, givenName });

describe("withNickname", () => {
  it("ignores the default given name (the first or last word of the full name)", () => {
    expect(withNickname(row("Maya Patel", "Maya")).nickname).toBeUndefined();
    expect(withNickname(row("Trần Minh Hưng", "Hưng"))).toEqual({ userId: "u1", displayName: "Trần Minh Hưng", status: "active", avatarVersion: 0 });
  });
  it("keeps a given name the person chose", () => {
    expect(withNickname(row("Nguyễn Thị Lan", "Lan Anh")).nickname).toBe("Lan Anh");
  });
  it("ignores empty, missing or full-name given names", () => {
    expect(withNickname(row("Lan", "")).nickname).toBeUndefined();
    expect(withNickname(row("Lan", null)).nickname).toBeUndefined();
    expect(withNickname(row("Lan Phạm", "Lan Phạm")).nickname).toBeUndefined();
  });
});
