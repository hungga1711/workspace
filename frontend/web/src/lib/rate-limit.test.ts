import { describe, expect, it, vi } from "vitest";
import { rateLimiter } from "./rate-limit";

describe("rateLimiter", () => {
  it("allows `limit` hits per key and window, then refuses until the window ends", () => {
    vi.useFakeTimers();
    const allow = rateLimiter(2, 1000);
    expect([allow("a"), allow("a"), allow("a"), allow("b")]).toEqual([true, true, false, true]);
    vi.advanceTimersByTime(1000);
    expect(allow("a")).toBe(true);
    vi.useRealTimers();
  });
});
