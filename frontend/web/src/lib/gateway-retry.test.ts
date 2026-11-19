import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { bffReadHeaders, retryDelayMs } from "./gateway-retry";

describe("gateway retry", () => {
  it("backs off without Retry-After", () => {
    expect(retryDelayMs(0, null)).toBe(600);
    expect(retryDelayMs(1, undefined)).toBe(1200);
  });
  it("honours Retry-After but never waits past 1.5s", () => {
    expect(retryDelayMs(0, "1")).toBe(1000);
    expect(retryDelayMs(0, "30")).toBe(1500);
    expect(retryDelayMs(0, "0")).toBe(200);
    expect(retryDelayMs(1, "soon")).toBe(1200);
  });
  it("signs page reads with the key the gateway derives", () => {
    const want = createHmac("sha256", process.env.INTERNAL_TOKEN_SECRET ?? "dev-internal-secret-change-me-32bytes!")
      .update("workspace:bff-read:v1")
      .digest("hex");
    expect(bffReadHeaders()["x-bff-read"]).toBe(want);
  });
});
