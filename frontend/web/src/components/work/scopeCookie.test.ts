import { describe, expect, it } from "vitest";
import { parseScopeCookie, scopeCookieValue } from "./scopeCookie";

describe("scope cookie", () => {
  it("round-trips every scope", () => {
    for (const s of ["mine", "owned", "projects", { project: "01M4ZMHCCE64N0N427H6C3CSBZ" }] as const)
      expect(parseScopeCookie(scopeCookieValue("u-1", s))).toEqual({ userId: "u-1", scope: s });
  });
  it("ignores anything it did not write", () => {
    for (const raw of [undefined, "", "mine", ".mine", "u.board", "u.p:", "u.p:a b", "u;x.mine"]) expect(parseScopeCookie(raw)).toBeNull();
  });
});
