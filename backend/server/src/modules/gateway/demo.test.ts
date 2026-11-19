import { describe, expect, it } from "vitest";
import { demoConfigFromEnv, demoLocked } from "./demo.js";

describe("demoLocked", () => {
  it("locks what would spoil the demo or reach outside", () => {
    expect(demoLocked("POST", "identity", "/members/u1/disable")).toBe(true);
    expect(demoLocked("POST", "identity", "/members/invite")).toBe(true);
    expect(demoLocked("POST", "identity", "/workspace/owner")).toBe(true);
    expect(demoLocked("POST", "identity", "/me/password")).toBe(true);
    expect(demoLocked("POST", "identity", "/me/mfa/setup")).toBe(true);
    expect(demoLocked("POST", "identity", "/api-keys")).toBe(true);
    expect(demoLocked("DELETE", "identity", "/api-keys/k1")).toBe(true);
    expect(demoLocked("POST", "identity", "/me/api-keys")).toBe(true);
    expect(demoLocked("POST", "platform", "/workspace/webhooks")).toBe(true);
    expect(demoLocked("POST", "ai", "/connections")).toBe(true);
    expect(demoLocked("POST", "ai", "/connections/c1/test")).toBe(true);
    expect(demoLocked("DELETE", "ai", "/monitor/data")).toBe(true);
    expect(demoLocked("POST", "ai", "/oversight/erasure-requests/r1")).toBe(true);
    expect(demoLocked("POST", "work", "/projects/p1/import?dry=1")).toBe(true);
    expect(demoLocked("DELETE", "ai", "/policy/keywords/k1")).toBe(true);
    expect(demoLocked("DELETE", "ai", "/insights/topics/c_quotes")).toBe(true);
    expect(demoLocked("DELETE", "ai", "/insights/library/p1")).toBe(true);
    expect(demoLocked("POST", "ai", "/insights/imports")).toBe(true);
    expect(demoLocked("DELETE", "ai", "/insights/imports/i1")).toBe(true);
    expect(demoLocked("PUT", "ai", "/insights/report/settings")).toBe(true);
  });

  it("leaves reads and ordinary work open", () => {
    expect(demoLocked("GET", "identity", "/api-keys")).toBe(false);
    expect(demoLocked("GET", "ai", "/connections")).toBe(false);
    expect(demoLocked("POST", "work", "/tasks")).toBe(false);
    expect(demoLocked("PATCH", "work", "/tasks/t1")).toBe(false);
    expect(demoLocked("POST", "ai", "/oversight/me/erasure")).toBe(false);
    expect(demoLocked("PUT", "identity", "/me/name")).toBe(false);
    expect(demoLocked("POST", "ai", "/policy/keywords")).toBe(false);
    expect(demoLocked("PUT", "ai", "/policy")).toBe(false);
    expect(demoLocked("POST", "ai", "/insights/library")).toBe(false);
    expect(demoLocked("POST", "ai", "/insights/library/p1/use")).toBe(false);
    expect(demoLocked("POST", "chat", "/channels/c1/messages")).toBe(false);
  });
});

describe("demoConfigFromEnv", () => {
  it("is off unless DEMO_MODE=1", () => {
    expect(demoConfigFromEnv({})).toBeNull();
    expect(demoConfigFromEnv({ DEMO_MODE: "0", DEMO_PASSWORD: "x", DEMO_OWNER_PASSWORD: "y" })).toBeNull();
  });

  it("needs every password rather than running half on", () => {
    expect(() => demoConfigFromEnv({ DEMO_MODE: "1", DEMO_PASSWORD: "x" })).toThrow(/DEMO_OWNER_PASSWORD/);
    const c = demoConfigFromEnv({ DEMO_MODE: "1", DEMO_PASSWORD: "member", DEMO_OWNER_PASSWORD: "owner" });
    expect(c?.accounts.owner).toEqual({ email: "admin@example.com", password: "owner" });
    expect(c?.accounts.staff.password).toBe("member");
    expect(c?.perIpPerMinute).toBe(120);
  });
});
