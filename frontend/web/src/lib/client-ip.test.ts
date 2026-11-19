import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const { clientIpFrom } = await import("./client-ip");

const h = (xff?: string, real?: string) => new Headers({ ...(xff ? { "x-forwarded-for": xff } : {}), ...(real ? { "x-real-ip": real } : {}) });

describe("clientIpFrom", () => {
  it("takes the address the trusted proxy appended, not what the browser sent", () => {
    expect(clientIpFrom(h("6.6.6.6, 203.0.113.9"))).toBe("203.0.113.9");
    expect(clientIpFrom(h("6.6.6.6, 203.0.113.9, 10.0.0.2"), 2)).toBe("203.0.113.9");
  });
  it("uses the only address there is, then x-real-ip", () => {
    expect(clientIpFrom(h("203.0.113.9"))).toBe("203.0.113.9");
    expect(clientIpFrom(h("203.0.113.9"), 3)).toBe("203.0.113.9");
    expect(clientIpFrom(h(undefined, "198.51.100.4"))).toBe("198.51.100.4");
    expect(clientIpFrom(h())).toBe("");
  });
});
