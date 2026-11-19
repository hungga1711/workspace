import { describe, expect, it } from "vitest";
import { bffReadKey, isBffRead } from "./bff-read.js";

describe("bff read key", () => {
  const key = bffReadKey("secret-a");
  it("accepts the server's key on a read", () => {
    expect(isBffRead("GET", key, key)).toBe(true);
  });
  it("never applies to writes", () => {
    expect(isBffRead("POST", key, key)).toBe(false);
  });
  it("rejects a missing, short or foreign key", () => {
    expect(isBffRead("GET", undefined, key)).toBe(false);
    expect(isBffRead("GET", "abc", key)).toBe(false);
    expect(isBffRead("GET", bffReadKey("secret-b"), key)).toBe(false);
  });
});
