import { describe, expect, it } from "vitest";
import { keyItems, type KeyRow } from "./attention.js";

const now = Date.parse("2026-11-13T10:00:00Z");
const days = (n: number) => new Date(now + n * 86_400_000);
const key = (o: Partial<KeyRow>): KeyRow => ({ id: "k1", name: "CRM sync", created_by: "minh", expires_at: days(90), last_used_at: days(-1), ...o });

describe("workspace API keys that need an admin", () => {
  it("a key far from its end, or with no end, is not listed", () => {
    expect(keyItems([key({}), key({ expires_at: null })], now)).toEqual([]);
  });
  it("a key about to expire is a warning with its date", () => {
    expect(keyItems([key({ expires_at: days(5) })], now)).toEqual([
      { id: "identity.key.expiring:k1", kind: "identity.key.expiring", severity: "warning", since: days(5).toISOString(), name: "CRM sync", ownerId: "minh" },
    ]);
  });
  it("an expired key is broken only when something was still using it, and not for ever", () => {
    expect(keyItems([key({ expires_at: days(-2), last_used_at: days(-3) })], now)).toMatchObject([{ kind: "identity.key.expired", severity: "broken" }]);
    expect(keyItems([key({ expires_at: days(-2), last_used_at: null })], now)).toEqual([]);
    expect(keyItems([key({ expires_at: days(-2), last_used_at: days(-200) })], now)).toEqual([]);
    expect(keyItems([key({ expires_at: days(-45), last_used_at: days(-46) })], now)).toEqual([]);
  });
});
